#!/usr/bin/env python3
"""Tests de la revue de permissions — `scripts/permissions_review.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce harnais existe pour un bug précis, #117 : `--apply` avait proposé — et fait
ajouter — `Bash(head:*)`, `Bash(tail:*)`, `Bash(sed:*)`, `Bash(grep:*)` et
`Bash(echo:*)`. Ces cinq motifs ouvrent sans invite exactement ce que le bloc
`deny` de `.claude/settings.json` protège :

    head -50 .env.production                        # deny Read(./**/.env.production)
    sed -n '1,200p' infra/terraform/prod/*.tfstate  # deny Read(./**/*.tfstate)
    grep -r AWS_SECRET .                            # les deux, par ratissage
    echo "" > .claude/settings.json                 # l'allowlist s'élargit seule

La cause n'est pas un oubli de règle mais une confusion de périmètre : **une
permission est indexée par outil, jamais par chemin**. `Read(./**/.env)`
n'interdit qu'à l'outil `Read` d'ouvrir ce fichier et ne dit rien de ce que
`Bash` en fait. Le garde-fou du script confrontait les motifs aux seuls `deny`
Bash — les seuls incapables de couvrir ce cas.

Ce qui se vérifie ici, donc :

1. le motif tiré d'un utilitaire à portée arbitraire n'est **pas proposé par
   défaut**, allowlist vide, et **pas davantage quand le bloc `deny` est vide** —
   le garde-fou ne se déduit pas des règles, il tient tout seul ;
2. les cinq motifs retirés par #115 ne reviennent pas, ni à l'affichage ni par
   `--apply` ;
3. un drapeau `--include-file-tools` ne suffit pas seul : le motif se nomme ;
4. le rang de risque annoncé ne descend jamais sous ce que l'outil permet, même
   si l'observation prétend le contraire — `sed` et `echo` ont été observés
   comme des lectures pendant tout le temps qu'a duré le bug ;
5. et, symétriquement, qu'un motif ordinaire reste proposé : un garde-fou qui
   refuse tout ne protège de rien, il fait seulement abandonner l'outil.

S'y ajoute #137, d'une autre nature : la revue proposait des fragments qui ne
sont **même pas des commandes**. Le hook d'observation découpe une invocation
ligne par ligne et prend le premier mot de chaque ligne pour un nom de
programme ; or un heredoc embarque un document entier, une commande à rallonge
se poursuit derrière un `\\`, une boucle occupe trois lignes. D'où `Bash(##:*)`,
`Bash(le:*)`, `Bash(for:*)`, `Bash(import:*)` — et `Bash(":*)`, qui couvre toute
commande commençant par un guillemet. `NonCommandFragments` vérifie qu'aucun de
ces fragments n'est plus proposé, et `RealCommandsSurvive` qu'on n'a pas jeté
les vraies commandes avec.

Aucune dépendance : `unittest` de la bibliothèque standard, comme les autres
harnais de `scripts/tests`.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import permissions_review as review  # noqa: E402 — l'insertion de chemin la précède

# Les cinq motifs que #115 a dû retirer à la main de l'allowlist.
REGRESSION_115 = ("head", "tail", "sed", "grep", "echo")

# Les `deny` de lecture du dépôt, réduits à ce qui compte pour le test.
READ_DENIES = ["Read(./**/.env)", "Read(./**/.env.production)",
               "Read(./**/*.tfstate)", "Read(./**/*.pem)"]


class ReviewTestCase(unittest.TestCase):
    """Un dépôt jetable : un fichier de réglages, un journal d'observations."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.settings = self.root / ".claude" / "settings.json"
        self.settings.parent.mkdir(parents=True)
        self.observed = self.root / ".claude" / ".permissions" / "observed.ndjson"
        self.observed.parent.mkdir(parents=True)
        self.write_settings(allow=[], deny=list(READ_DENIES))

    def write_settings(self, allow, deny):
        self.settings.write_text(
            json.dumps({"permissions": {"allow": allow, "deny": deny}},
                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def allowlist(self):
        data = json.loads(self.settings.read_text(encoding="utf-8"))
        return (data.get("permissions") or {}).get("allow") or []

    def observe(self, pattern, example, risk="read", times=2, denied=False):
        """Consigne une observation comme le ferait le hook `permission_watch`."""
        with open(self.observed, "a", encoding="utf-8") as handle:
            for index in range(times):
                handle.write(json.dumps({
                    "ts": f"2026-08-26T10:0{index}:00+00:00",
                    "pattern": pattern, "example": example, "risk": risk,
                    "denied": denied, "session": "s1", "run": None,
                }, ensure_ascii=False) + "\n")

    def run_review(self, *argv):
        """Lance `main()` sur le dépôt jetable — rend (code de sortie, sortie)."""
        buffer = io.StringIO()
        with mock.patch.object(review, "ROOT", self.root), \
                mock.patch.object(review, "SETTINGS", self.settings), \
                mock.patch.object(review, "OBSERVED", self.observed), \
                mock.patch.object(sys, "argv", ["permissions_review.py", *argv]), \
                redirect_stdout(buffer):
            code = review.main()
        return code, buffer.getvalue()

    def report(self, *argv):
        """La sortie `--json` de l'affichage, indexée par motif."""
        code, out = self.run_review("--json", *argv)
        self.assertEqual(code, 0, out)
        return {row["pattern"]: row for row in json.loads(out)}


class HeadEnvNotProposed(ReviewTestCase):
    """Le cas de régression exact de #117 : allowlist vide, `head .env` observé."""

    def setUp(self):
        super().setUp()
        self.observe("head", "head -50 .env.production")

    def test_not_eligible_by_default(self):
        row = self.report()["head"]
        self.assertFalse(row["eligible"])
        self.assertIn("--include-file-tools", row["reason"])

    def test_apply_adds_nothing(self):
        code, out = self.run_review("--apply", "--yes")
        self.assertEqual(code, 1)
        self.assertIn("rien à ajouter", out)
        self.assertEqual(self.allowlist(), [])

    def test_reason_names_the_read_denies(self):
        """Le refus dit ce qu'il protège, pas seulement qu'il refuse."""
        row = self.report()["head"]
        self.assertIn("deny Read", row["reason"])

    def test_guard_holds_without_any_deny_rule(self):
        """Le garde-fou ne se déduit pas du bloc `deny` : il tient même vide.

        C'est le cœur de #117. Un garde-fou construit à partir des `deny`
        présents laisserait passer le motif sur tout dépôt qui n'en pose pas —
        et laisserait le trou se rouvrir au premier `deny` supprimé.
        """
        self.write_settings(allow=[], deny=[])
        row = self.report()["head"]
        self.assertFalse(row["eligible"])
        self.assertIn("--include-file-tools", row["reason"])

    def test_named_pattern_alone_is_not_enough(self):
        """`--pattern` sans le drapeau ne lève rien — et le refus est motivé."""
        code, out = self.run_review("--apply", "--yes", "--pattern", "head")
        self.assertEqual(code, 1)
        self.assertIn("refusé · Bash(head:*)", out)
        self.assertEqual(self.allowlist(), [])

    def test_flag_alone_is_not_enough(self):
        """`--include-file-tools` sans `--pattern` ne lâche pas le motif d'un coup."""
        code, out = self.run_review("--apply", "--yes", "--include-file-tools")
        self.assertEqual(code, 1)
        self.assertIn("à nommer explicitement avec --pattern", out)
        self.assertEqual(self.allowlist(), [])

    def test_flag_and_pattern_together_apply(self):
        """La sortie de secours existe : elle est explicite, nommée, et tracée."""
        code, out = self.run_review("--apply", "--yes", "--include-file-tools",
                                    "--pattern", "head")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.allowlist(), ["Bash(head:*)"])


class Regression115(ReviewTestCase):
    """Les cinq motifs retirés à la main par #115 ne doivent pas revenir."""

    def setUp(self):
        super().setUp()
        for pattern, example in (
                ("head", "head -50 .env.production"),
                ("tail", "cat cle.pem | tail -20"),
                ("sed", "sed -n '1,200p' infra/terraform/prod/tf.tfstate"),
                ("grep", "grep -r AWS_SECRET ."),
                ("echo", "echo '{}' > .claude/settings.json")):
            self.observe(pattern, example, times=12)

    def test_none_is_eligible(self):
        rows = self.report()
        for pattern in REGRESSION_115:
            with self.subTest(pattern=pattern):
                self.assertIn(pattern, rows)
                self.assertFalse(rows[pattern]["eligible"])

    def test_apply_reproposes_none_of_them(self):
        code, out = self.run_review("--apply", "--yes")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.allowlist(), [])

    def test_repetition_never_wears_the_guard_down(self):
        """Douze passages ne valent pas un accord : le seuil ne lève pas le garde-fou."""
        rows = self.report("--threshold", "1")
        for pattern in REGRESSION_115:
            with self.subTest(pattern=pattern):
                self.assertGreaterEqual(rows[pattern]["count"], 12)
                self.assertFalse(rows[pattern]["eligible"])


class RiskFloor(ReviewTestCase):
    """Ce qui peut écrire n'est jamais annoncé comme une lecture."""

    def test_writer_observed_as_read_is_reported_as_write(self):
        """`sed` et `echo` ont été classés « lecture » par le hook (#117).

        La revue ne s'y fie pas : le rang affiché est relevé à ce que l'outil
        rend possible. Un `echo` présenté comme une lecture invite à
        l'autoriser sans y regarder.
        """
        self.observe("echo", "echo '{}' > .claude/settings.json", risk="read")
        self.observe("sed", "sed -i 's/a/b/' .claude/settings.json", risk="read")
        rows = self.report()
        self.assertEqual(rows["echo"]["risk"], "write")
        self.assertEqual(rows["sed"]["risk"], "write")

    def test_reader_stays_a_read(self):
        """Le plancher ne relève que ce qui écrit — `head` reste une lecture."""
        self.observe("head", "head -50 .env", risk="read")
        self.assertEqual(self.report()["head"]["risk"], "read")

    def test_floor_never_lowers_an_observed_risk(self):
        """Un `sed` vu comme destructif le reste : le plancher ne descend pas."""
        self.observe("sed", "sed -i 's/a/b/' fichier", risk="destructive")
        self.assertEqual(self.report()["sed"]["risk"], "destructive")


class OtherGuardsStillApply(ReviewTestCase):
    """Le garde-fou de #117 s'ajoute aux autres, il ne les remplace pas."""

    def test_destructive_objection_comes_first(self):
        """`dd` est dans les deux listes : c'est le destructif qu'on lui oppose.

        L'ordre compte pour le message : dire « portée bornée par ses
        arguments » d'un `dd` ferait croire qu'un `--include-file-tools`
        suffirait à l'autoriser.
        """
        self.observe("dd", "dd if=/dev/zero of=disque.img", risk="destructive")
        row = self.report()["dd"]
        self.assertFalse(row["eligible"])
        self.assertIn("--include-destructive", row["reason"])

    def test_bash_deny_still_refuses(self):
        """Un motif que le hook a vu couvert par un `deny` Bash reste refusé."""
        self.observe("git reset", "git reset --hard HEAD~1",
                     risk="destructive", denied=True)
        row = self.report()["git reset"]
        self.assertFalse(row["eligible"])
        self.assertIn("deny", row["reason"])

    def test_below_threshold_is_refused(self):
        self.observe("npm run verify", "npm run verify", risk="read", times=1)
        row = self.report()["npm run verify"]
        self.assertFalse(row["eligible"])
        self.assertIn("seuil", row["reason"])

    def test_already_allowed_is_not_proposed_again(self):
        self.write_settings(allow=["Bash(npm run verify:*)"], deny=list(READ_DENIES))
        self.observe("npm run verify", "npm run verify", risk="read")
        row = self.report()["npm run verify"]
        self.assertFalse(row["eligible"])
        self.assertIn("déjà autorisé", row["reason"])


class OrdinaryPatternsStillPass(ReviewTestCase):
    """Un garde-fou qui refuse tout ne protège de rien : on abandonne l'outil."""

    def test_bounded_command_is_proposed_and_applied(self):
        self.observe("npm run verify", "npm run verify", risk="read")
        self.assertTrue(self.report()["npm run verify"]["eligible"])

        code, out = self.run_review("--apply", "--yes")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.allowlist(), ["Bash(npm run verify:*)"])

    def test_applied_pattern_is_forgotten(self):
        """Une fois la règle posée, l'observation ne resurgit pas à la revue suivante."""
        self.observe("npm run verify", "npm run verify", risk="read")
        self.run_review("--apply", "--yes")
        code, out = self.run_review()
        self.assertEqual(code, 0)
        self.assertIn("aucune commande", out)


class NonCommandFragments(ReviewTestCase):
    """#137 — ce qui n'est pas une commande n'entre pas dans une allowlist.

    Chaque cas rejoue ce que le hook consigne réellement : une observation par
    ligne, la première portant la vraie commande et les suivantes le corps du
    document, la continuation ou le mot réservé.
    """

    def listed(self, *argv):
        """Les motifs que la revue retient — ceux qu'un opérateur verra."""
        return set(self.report(*argv))

    def test_heredoc_body_yields_a_single_pattern(self):
        """Un heredoc ne produit qu'un motif : celui de sa première ligne.

        `python scripts/gen.py <<'EOF' … EOF` : tout ce qui suit la première
        ligne est le document, pas une suite de commandes.
        """
        self.observe("python scripts/gen.py", "python scripts/gen.py <<'EOF'",
                     risk="write")
        for pattern, example in (("##", "## Index"),
                                 ("-", "- **Le rafraîchissement ne coûte rien.**"),
                                 ("le", "Le créneau pris entre la sélection"),
                                 ("```", "```"),
                                 ("eof", "EOF")):
            self.observe(pattern, example, risk="write")

        self.assertEqual(self.listed(), {"python scripts/gen.py"})
        self.assertTrue(self.report()["python scripts/gen.py"]["eligible"])

    def test_backslash_continuation_yields_a_single_pattern(self):
        """Une commande continuée par `\\` ne produit qu'un motif.

        Les lignes suivantes commencent par un drapeau : `--title`,
        `--body-file`. Un nom de programme ne commence jamais par un tiret.
        """
        self.observe("gh issue create", "gh issue create --repo TMap-Works/x \\",
                     risk="write")
        for pattern, example in (("--title", '--title "La veille planifiée" \\'),
                                 ("--label", "--label bug \\"),
                                 ("--body-file", "--body-file -")):
            self.observe(pattern, example, risk="write")

        self.assertEqual(self.listed(), {"gh issue create"})

    def test_shell_keywords_are_never_proposed(self):
        """`for … do … done` occupe trois lignes, dont deux mots réservés."""
        self.observe("for", "for n in 18 10 28", risk="write")
        self.observe("do", 'do echo "=== #$n ==="', risk="write")
        self.observe("done", "done", risk="write")
        self.observe("if", "if t['number'] in (18,10):", risk="write")
        self.observe("then", 'then echo "$b"', risk="write")
        self.observe("fi", "fi", risk="write")

        self.assertEqual(self.listed(), set())
        rows = self.report("--show-rejected")
        for keyword in ("for", "do", "done", "if", "then", "fi"):
            with self.subTest(keyword=keyword):
                self.assertFalse(rows[keyword]["eligible"])
                self.assertIn("mot réservé du shell", rows[keyword]["reason"])

    def test_command_name_charset_is_enforced(self):
        """Le filet de sécurité : hors de `^[A-Za-z0-9_.\\-/]+$`, rien ne passe.

        `Bash(":*)` couvrirait toute commande commençant par un guillemet —
        une classe entière d'invocations sous une étiquette qui ne dit rien.
        """
        for pattern, example in (('"', '"'),
                                 ("`", "`"),
                                 ("```", "```"),
                                 ("##", "## Index"),
                                 ("---", "---"),
                                 ("(.number)", '"#\\(.number) \\(.headRefName)"'),
                                 ("co-authored-by:",
                                  "Co-Authored-By: Claude Opus 5 <x@y.z>"),
                                 ("try:", "try:")):
            self.observe(pattern, example, risk="write")

        self.assertEqual(self.listed(), set())

    def test_french_prose_is_not_a_command(self):
        """La prose d'un corps de PR ou d'un livrable Markdown n'est pas exécutée."""
        for pattern, example in (("le", "Le créneau pris entre la sélection"),
                                 ("les", "Les six étapes, écran par écran"),
                                 ("une", "Une session interactive orchestre"),
                                 ("périmètre", "Périmètre retenu : conception"),
                                 ("prisma sert", "Prisma sert tout le reste."),
                                 ("npm exécute ses",
                                  "npm exécute ses scripts par cmd.exe")):
            self.observe(pattern, example, risk="write")

        self.assertEqual(self.listed(), set())

    def test_source_lines_are_not_commands(self):
        """Python, TypeScript ou Prisma tombés dans un heredoc restent des données."""
        for pattern, example in (("import", "import io, pathlib"),
                                 ("def", "def reconcile(args):"),
                                 ("return", "return bool(project.get('x'))"),
                                 ("const", "const net = require('net')"),
                                 ("assert", "assert old in s, 'introuvable'"),
                                 ("source", 'source  = "hashicorp/aws"'),
                                 ("id", "id String @id @default(uuid())"),
                                 ("terraform {", "terraform {"),
                                 ("python \"", 'python -c "'),
                                 ("python <<PY", "python - <<'PY'")):
            self.observe(pattern, example, risk="write")

        self.assertEqual(self.listed(), set())

    def test_a_named_fragment_cannot_be_forced_into_the_allowlist(self):
        """`--pattern` ne rachète pas un fragment : le refus tient, et il est motivé."""
        self.observe("##", "## Index", risk="write")
        code, out = self.run_review("--apply", "--yes", "--pattern", "##")
        self.assertEqual(code, 1, out)
        self.assertIn("refusé · Bash(##:*)", out)
        self.assertEqual(self.allowlist(), [])

    def test_apply_without_pattern_adds_nothing(self):
        self.observe("import", "import io, pathlib", risk="write", times=40)
        code, out = self.run_review("--apply", "--yes")
        self.assertEqual(code, 1, out)
        self.assertEqual(self.allowlist(), [])

    def test_rejected_fragments_are_counted_not_hidden(self):
        """Écarter n'est pas escamoter : la sortie dit combien, et pourquoi les voir."""
        self.observe("npm run verify", "npm run verify")
        self.observe("##", "## Index", risk="write")
        code, out = self.run_review()
        self.assertEqual(code, 0, out)
        self.assertIn("1 fragment(s) écarté(s)", out)
        self.assertIn("--show-rejected", out)
        self.assertNotIn("Bash(##:*)", out)

    def test_show_rejected_brings_them_back_with_their_reason(self):
        self.observe("##", "## Index", risk="write")
        row = self.report("--show-rejected")["##"]
        self.assertFalse(row["eligible"])
        self.assertIn("^[A-Za-z0-9_.\\-/]+$", row["reason"])


class RealCommandsSurvive(ReviewTestCase):
    """Le garde-fou de #137 ne doit pas emporter les vraies commandes avec lui."""

    ORDINARY = (
        ("npm run verify", "npm run verify"),
        ("git rev-parse", "git rev-parse --abbrev-ref HEAD"),
        ("npx jest", "npx jest --config jest.unit.config.js 2>&1"),
        ("docker compose up", "docker compose up -d"),
        ("terraform init", "terraform init -backend=false"),
        ("python scripts/pr_gate.py", "python scripts/pr_gate.py 145"),
        ("gh pr review", "gh pr review 145 --repo TMap-Works/x --comment"),
        ("npx prisma",
         'DATABASE_URL="postgresql://spa@localhost/spa" npx prisma generate'),
        ("mkdir", "mkdir -p docs/design/booking-funnel"),
        ("test", "test -d node_modules"),
    )

    def test_ordinary_patterns_stay_eligible(self):
        for pattern, example in self.ORDINARY:
            self.observe(pattern, example, risk="write")
        rows = self.report()
        for pattern, _ in self.ORDINARY:
            with self.subTest(pattern=pattern):
                self.assertIn(pattern, rows)
                self.assertTrue(rows[pattern]["eligible"], rows[pattern]["reason"])

    def test_an_env_prefixed_invocation_is_still_an_invocation(self):
        """`DATABASE_URL=… npx prisma` : l'affectation n'est pas le programme.

        Son premier mot est capitalisé — comme la prose. Ce qui les sépare est
        le `=`, que le hook écarte déjà pour nommer la commande.
        """
        self.observe("npx prisma",
                     'DATABASE_URL="postgresql://spa@localhost/spa" npx prisma db push',
                     risk="write")
        self.assertTrue(self.report()["npx prisma"]["eligible"])

    def test_an_observation_without_example_is_still_judged_on_its_name(self):
        """Sans exemple, seul le nom parle — et il suffit à trancher."""
        self.observe("npm run verify", "", risk="write")
        self.observe("done", "", risk="write")
        rows = self.report("--show-rejected")
        self.assertTrue(rows["npm run verify"]["eligible"])
        self.assertFalse(rows["done"]["eligible"])

    DOT_ARGUMENT = (
        ("git add", "git add ."),
        ("ruff", "ruff check ."),
        ("terraform fmt", "terraform fmt ."),
        ("docker build", "docker build ."),
    )

    def test_a_trailing_dot_argument_is_not_a_full_stop(self):
        """`git add .` finit par un point sans être une phrase.

        Le repérage de la prose demande plusieurs mots, un point final et aucun
        drapeau ni chemin — ce que remplit exactement `git add .`. Confondre
        l'argument « le répertoire courant » avec une ponctuation faisait sortir
        de la revue les commandes les plus banales du dépôt, et sans bruit :
        écartées, elles n'apparaissaient même plus dans la sortie.
        """
        for pattern, example in self.DOT_ARGUMENT:
            self.observe(pattern, example, risk="write")
        rows = self.report()
        for pattern, _ in self.DOT_ARGUMENT:
            with self.subTest(pattern=pattern):
                self.assertIn(pattern, rows)
                self.assertTrue(rows[pattern]["eligible"], rows[pattern]["reason"])

    def test_a_real_sentence_is_still_prose(self):
        """La correction ne rouvre pas la porte : un point qui clôt un mot reste un point."""
        self.observe("prisma sert", "Prisma sert tout le reste.", risk="write")
        self.observe("npm fait le reste", "npm fait tout le reste.", risk="write")
        self.assertEqual(set(self.report()), set())

    def test_windows_where_is_a_command_not_an_sql_keyword(self):
        """`where` est le `which` de Windows — la plateforme de ce dépôt.

        Le mot est aussi celui de SQL. Le classer parmi les mots-clés de langage
        le refusait d'office, y compris sur l'observation bien réelle
        `where pythonw`, qu'aucun `--pattern` n'aurait pu rattraper.
        """
        self.observe("where", "where pythonw 2>/dev/null", risk="read")
        self.assertTrue(self.report()["where"]["eligible"])


class PathLookup(unittest.TestCase):
    """#264 — trouver un nom sur le `PATH` sans le parcourir en entier.

    `not_a_command` est importé par `.claude/hooks/permission_watch.py`, qui
    s'exécute dans un processus neuf **à chaque commande Bash**. Le parcours
    complet du `PATH` y était refait à chaque fois, sans qu'aucun cache lui
    survive : 23 ms mesurées sur 81 ms de hook.

    Deux choses se vérifient ici, et la première prime : **la réponse ne change
    pas**. `on_path` doit rendre exactement ce que rend l'appartenance à
    `path_executables()`, faute de quoi c'est la liste des motifs proposés à
    l'allowlist qui bougerait — le seul effet que l'issue interdit. La seconde
    est le gain : un nom à juger ne doit plus déclencher le moindre parcours.
    """

    # Des noms qui couvrent chaque branche : présent tel quel, présent par son
    # extension, extension hors PATHEXT, répertoire homonyme, absent, un chemin
    # déguisé en nom, et un nom que Windows réécrirait avant de répondre.
    CORPUS = ("plain", "node", "node.exe", "tool", "tool.bat", "helper",
              "helper.cmd", "with.dots", "with.dots.exe", "script", "script.py",
              "notafile", "zzzabsent", "sub/tool", "node.com", "plain.",
              "plain..", "node.exe.")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.opt = Path(self.tmp.name) / "opt"
        for folder in (self.bin, self.opt):
            folder.mkdir(parents=True)
        self.put(self.bin, "plain", "node.exe", "tool.bat", "with.dots.exe",
                 "script.py")
        self.put(self.opt, "helper.cmd")
        (self.bin / "notafile").mkdir()     # un répertoire n'est pas un exécutable
        # Une entrée vide et une entrée inexistante : le PATH réel en a toujours.
        self.path = os.pathsep.join(
            [str(self.bin), str(Path(self.tmp.name) / "absent"), str(self.opt), ""])
        self.addCleanup(review.reset_path_cache)
        review.reset_path_cache()

    def put(self, folder, *names):
        for name in names:
            (folder / name).write_text("", encoding="utf-8")

    def env(self, pathext=(".COM", ".EXE", ".BAT", ".CMD")):
        return mock.patch.dict(os.environ, {"PATH": self.path,
                                            "PATHEXT": os.pathsep.join(pathext)})

    def by_index(self, names):
        """La réponse de référence : l'appartenance au parcours complet."""
        review.reset_path_cache()
        index = review.path_executables()
        return {name: name in index for name in names}

    def by_lookup(self, names):
        """La réponse de `on_path`, caches remis à zéro."""
        review.reset_path_cache()
        return {name: review.on_path(name) for name in names}

    def test_the_probe_answers_exactly_like_the_full_walk(self):
        """L'invariant de l'issue : même verdict, quel que soit le chemin pris.

        Les deux réglages de casse sont éprouvés, et non celui de la machine qui
        passe le test : c'est sous Windows que la sonde tranche seule, sous POSIX
        qu'elle se déclare non concluante et repasse la main au parcours.
        """
        with self.env():
            reference = self.by_index(self.CORPUS)
            self.assertTrue(any(reference.values()), reference)
            for insensitive in (True, False):
                with self.subTest(casse_insensible=insensitive), \
                        mock.patch.object(review, "CASE_INSENSITIVE_FS", insensitive):
                    self.assertEqual(self.by_lookup(self.CORPUS), reference)

    def test_a_directory_is_not_an_executable(self):
        """`notafile` est un répertoire du `PATH` — ni l'index ni la sonde n'en veulent."""
        with self.env():
            self.assertFalse(self.by_index(["notafile"])["notafile"])
            self.assertFalse(self.by_lookup(["notafile"])["notafile"])

    def test_an_extension_outside_pathext_gives_no_stem(self):
        """`script.py` est bien là, mais `.py` n'est pas dans `PATHEXT` : pas de `script`."""
        with self.env():
            self.assertEqual(self.by_lookup(["script", "script.py"]),
                             self.by_index(["script", "script.py"]))
            self.assertFalse(self.by_lookup(["script"])["script"])

    def test_a_mixed_case_executable_is_found_all_the_same(self):
        """Un `Tool.EXE` du `PATH` répond au nom `tool`, comme avant #264.

        C'est le seul point où la sonde ne peut pas trancher seule : sur un
        système de fichiers sensible à la casse, elle se déclare non concluante
        plutôt que de répondre non — et le parcours, qui replie les noms en
        minuscules, rend la réponse d'avant.
        """
        self.put(self.opt, "Tool.EXE")
        with self.env():
            self.assertTrue(self.by_index(["tool"])["tool"])
            self.assertTrue(self.by_lookup(["tool"])["tool"])

    def test_a_name_the_filesystem_would_rewrite_is_left_to_the_walk(self):
        """`plain.` n'est pas `plain` — même là où le système confond les deux.

        Windows rogne les points et les espaces de fin de chaque segment : un
        `os.path.isfile` sur `bin\\plain.` y ouvre le fichier `plain`, que
        l'index ne connaît pourtant que sous ce nom-là. La sonde répondait donc
        oui là où le parcours répond non, et `not_a_command` acceptait
        `plain. suite` — un fragment de prose — comme une commande à proposer à
        l'allowlist. Elle ne conclut plus sur ces noms.
        """
        with self.env(), mock.patch.object(review, "CASE_INSENSITIVE_FS", True):
            self.assertIsNone(review.probe_path("plain."))
            review.reset_path_cache()
            self.assertFalse(review.on_path("plain."))
            self.assertEqual(review.path_executables.cache_info().currsize, 1)
            review.reset_path_cache()
            self.assertIsNotNone(review.not_a_command("plain. suite"))

    def test_not_a_command_gives_the_same_verdicts_as_the_full_walk(self):
        """Le même invariant, là où il se voit : le verdict rendu à la revue.

        `PROBE_BUDGET = 0` reproduit exactement le code d'avant #264 — toute
        question de `PATH` part au parcours complet. Les deux colonnes doivent
        être identiques, motif par motif et raison par raison.
        """
        patterns = ("git status", "npm run verify", "plain --flag", "tool build",
                    "helper", "node script.js", "script", "zzzabsent thing",
                    "for", "import", "##", "where pythonw")

        def verdicts():
            review.reset_path_cache()
            return {pattern: review.not_a_command(pattern) for pattern in patterns}

        with self.env():
            for insensitive in (True, False):
                with self.subTest(casse_insensible=insensitive), \
                        mock.patch.object(review, "CASE_INSENSITIVE_FS", insensitive):
                    with mock.patch.object(review, "PROBE_BUDGET", 0):
                        reference = verdicts()
                    self.assertEqual(verdicts(), reference)
            # Et le corpus dit bien quelque chose : sans cela l'égalité serait vide.
            self.assertIsNone(reference["git status"])
            self.assertIsNone(reference["plain --flag"])
            self.assertIsNotNone(reference["zzzabsent thing"])

    def test_a_name_that_exists_never_walks_the_path(self):
        """Le gain, sur la branche qui vaut partout : un `stat` au lieu du parcours."""
        with self.env(), mock.patch("os.scandir") as scandir:
            self.assertTrue(self.by_lookup(["plain"])["plain"])
        scandir.assert_not_called()
        self.assertEqual(review.path_executables.cache_info().currsize, 0)

    def test_an_absent_name_never_walks_the_path_on_windows(self):
        """Le cas de l'issue : un nom inconnu, sur le poste Windows du dépôt.

        C'est celui qui coûtait, puisque c'est le seul que `plausible_command_name`
        pousse jusqu'au `PATH` — et le seul où la sonde doit tout regarder avant
        de conclure. Elle conclut quand même, sans construire l'index.
        """
        with self.env(), mock.patch.object(review, "CASE_INSENSITIVE_FS", True), \
                mock.patch("os.scandir") as scandir:
            self.assertFalse(self.by_lookup(["zzzabsent"])["zzzabsent"])
        scandir.assert_not_called()
        self.assertEqual(review.path_executables.cache_info().currsize, 0)

    def test_the_walk_takes_over_once_the_probe_stops_paying(self):
        """Au-delà de `PROBE_BUDGET` noms, le parcours redevient le moins cher.

        C'est ce qui protège la revue, qui instruit des milliers de motifs dans
        un seul processus : elle ne paie pas des centaines de sondes là où un
        parcours suffit.
        """
        with self.env(), mock.patch.object(review, "CASE_INSENSITIVE_FS", True):
            review.reset_path_cache()
            for index in range(review.PROBE_BUDGET):
                review.on_path(f"zzzabsent{index}")
            self.assertEqual(review.path_executables.cache_info().currsize, 0)
            review.on_path("zzzabsentdetrop")
            self.assertEqual(review.path_executables.cache_info().currsize, 1)

    def test_a_repeated_name_costs_nothing_and_spends_no_budget(self):
        """Le même nom deux fois ne sonde qu'une fois — sans quoi le budget fondrait."""
        with self.env(), mock.patch.object(review, "CASE_INSENSITIVE_FS", True):
            review.reset_path_cache()
            for _ in range(review.PROBE_BUDGET * 3):
                self.assertFalse(review.on_path("zzzabsent"))
            self.assertEqual(review.path_executables.cache_info().currsize, 0)

    def test_reset_forgets_a_path_that_has_changed(self):
        """Le cache ne voit pas `PATH` bouger : `reset_path_cache` est là pour ça."""
        with self.env():
            self.assertFalse(review.on_path("late"))
            self.put(self.bin, "late")
            self.assertFalse(review.on_path("late"))    # toujours la réponse retenue
            review.reset_path_cache()
            self.assertTrue(review.on_path("late"))


if __name__ == "__main__":
    unittest.main()
