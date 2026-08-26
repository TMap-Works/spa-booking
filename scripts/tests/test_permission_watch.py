#!/usr/bin/env python3
"""Tests du hook d'observation — `.claude/hooks/permission_watch.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce harnais existe pour #215. Le hook découpait la commande Bash sur ses
séparateurs, **saut de ligne compris**, et prenait le premier mot de chaque
morceau pour un nom de programme. Or une invocation de ce dépôt est très souvent
multi-lignes sans être multi-commandes : un heredoc y porte les corps de PR et
d'issue, une commande `gh` à rallonge se poursuit derrière un `\\`, une boucle
occupe trois lignes. Sur le run `s1-fondations-20260825-093729`, 4 409 des 4 672
motifs consignés — 94 % — étaient de la donnée prise pour du code.

#137 avait appris à la revue à les écarter **à la lecture** ; le journal, lui,
continuait de les garder, et chaque revue payait leur tri. Ce qui se vérifie ici
est l'autre moitié : le hook cesse de les **écrire**.

1. `UneInvocationUneObservation` — heredoc, continuation, boucle : une
   invocation ne produit jamais plus d'une ligne dans `observed.ndjson` ;
2. `CorpsInlineNestPasUneCible` — `python -c "import io"` donne `python -c`,
   jamais `python import io`. C'est le seul résidu que le garde-fou de #137 ne
   savait pas voir, son nom de commande étant parfaitement légitime ;
3. `NomsDeCommandeBienFormes` — aucune observation dont le nom de commande sort
   de `^[A-Za-z0-9_.\\-/]+$` ;
4. `PartDeFragmentsEcartes` — sur une campagne d'observation neuve, la part de
   motifs que `permissions_review.py` écarterait tombe sous 5 % ;
5. `LesVraiesCommandesSurvivent` — un garde-fou qui refuse tout ne protège de
   rien : `git status && git log`, `npm run verify` et les autres restent
   observés, chacun sous son motif le plus étroit.

Aucune dépendance : `unittest` de la bibliothèque standard, comme les autres
harnais de `scripts/tests`.
"""
import importlib.util
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py`.
sys.path.insert(0, str(ROOT / "scripts"))

import permissions_review as review  # noqa: E402 — l'insertion de chemin la précède


def load_hook():
    """Le hook, importé par son chemin : `.claude/hooks/` n'est pas importable."""
    path = ROOT / ".claude" / "hooks" / "permission_watch.py"
    spec = importlib.util.spec_from_file_location("permission_watch", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


watch = load_hook()

COMMAND_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")

# Le corps de PR tel que `/ticket` l'écrit : un document Markdown entier, avec
# ses titres, ses listes, ses tuyaux de tableau et ses `&&` de prose.
HEREDOC_PR = """gh pr create --repo TMap-Works/spa-booking --base develop --body-file - <<'BODY'
## Contexte

Closes #215.

- le hook consignait une observation par ligne
- `npm run verify` && `npm run lint` passaient quand meme

| Cible | Verdict |
|---|---|
| lint | ok |

Co-authored-by: Claude <noreply@anthropic.com>
BODY"""

# La commande a rallonge, coupee par des antislashs — chaque `--drapeau` etait
# promu au rang d'executable.
CONTINUATION_GH = """gh issue edit 215 --repo TMap-Works/spa-booking \\
    --add-label "type:bug" \\
    --add-label "mod:infra" \\
    --milestone "S1 — Fondations\""""

BOUCLE = """for fichier in a b c
do
  echo "$fichier"
done"""

# Ce qu'une campagne d'observation voit reellement passer en une heure de jalon.
CAMPAGNE = [
    HEREDOC_PR,
    CONTINUATION_GH,
    BOUCLE,
    "npm run verify",
    "git status --short && git log --oneline -1",
    "python scripts/milestone_run.py event --ticket 215 --phase validation",
    'python -c "import io; print(io)"',
    'python -c "\nimport json\nprint(json.dumps({}))\n"',
    "docker compose up -d",
    "gh pr checks 215 --repo TMap-Works/spa-booking",
    'git commit -m "fix(infra): tokeniseur | une invocation && une observation"',
    "terraform fmt -check && terraform validate",
    "cat > note.md <<EOT\nUne ligne de prose francaise.\nEOT",
    "npx prisma migrate dev --name ajout_tenant_id",
    "echo 'ok' | tee build.log",
]


class HookTestCase(unittest.TestCase):
    """Un dépôt jetable : un fichier de réglages, un journal d'observations."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.settings = root / "settings.json"
        self.observed = root / "observed.ndjson"
        self.write_settings(allow=[])
        patches = [
            mock.patch.object(watch, "SETTINGS", [self.settings]),
            mock.patch.object(watch, "OBSERVED", self.observed),
            mock.patch.object(watch, "CURRENT_RUN", root / "absent"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def write_settings(self, allow, deny=(), ask=()):
        self.settings.write_text(
            json.dumps({"permissions": {"allow": list(allow), "deny": list(deny),
                                        "ask": list(ask)}}, ensure_ascii=False),
            encoding="utf-8")

    def observe(self, command):
        """Ce que le hook écrit pour cette commande — le vrai `main()`, vrai stdin."""
        if self.observed.exists():
            self.observed.unlink()
        payload = json.dumps({"tool_name": "Bash", "session_id": "session-test",
                              "tool_input": {"command": command}}).encode("utf-8")
        stdin = mock.Mock(buffer=io.BytesIO(payload))
        with mock.patch.object(sys, "stdin", stdin):
            with self.assertRaises(SystemExit) as exit_code:
                watch.main()
        self.assertEqual(exit_code.exception.code, 0,
                         "le hook doit toujours sortir en 0 : il observe, il ne bloque pas")
        if not self.observed.exists():
            return []
        return [json.loads(line)
                for line in self.observed.read_text(encoding="utf-8").splitlines()
                if line.strip()]

    def patterns(self, command):
        return [record["pattern"] for record in self.observe(command)]


class UneInvocationUneObservation(HookTestCase):
    """Le cœur de #215 : une invocation, une ligne — quelle que soit sa hauteur."""

    def test_heredoc_ne_donne_quune_observation(self):
        patterns = self.patterns(HEREDOC_PR)
        self.assertEqual(patterns, ["gh pr create"],
                         "le corps du heredoc est de la donnée, pas des commandes")

    def test_continuation_ne_donne_quune_observation(self):
        patterns = self.patterns(CONTINUATION_GH)
        self.assertEqual(patterns, ["gh issue edit"],
                         "les lignes continuées par « \\ » se recollent avant tout découpage")

    def test_boucle_necrit_aucun_mot_reserve(self):
        patterns = self.patterns(BOUCLE)
        for reserve in ("do", "done", "for"):
            self.assertNotIn(reserve, patterns,
                             "un mot réservé du shell ne nomme jamais un exécutable")

    def test_les_quotes_ne_sont_pas_des_tuyaux(self):
        patterns = self.patterns(
            'git commit -m "fix(infra): une invocation | une observation && rien de plus"')
        self.assertEqual(patterns, ["git commit"],
                         "un « | » dans un message de commit n'est pas un tuyau")

    def test_le_corps_du_heredoc_ne_reste_pas_dans_la_commande(self):
        stripped = watch.strip_heredocs("cat > f <<'EOF'\n## Titre\nEOF\ngit status")
        self.assertNotIn("## Titre", stripped)
        self.assertIn("git status", stripped,
                      "ce qui suit le marqueur de fin appartient de nouveau au script")

    def test_un_marqueur_cite_nouvre_aucun_corps(self):
        stripped = watch.strip_heredocs('echo "voir <<EOF plus bas"\ngit status')
        self.assertIn("git status", stripped,
                      "avaler la suite du script serait pire que le bruit qu'on supprime")

    def test_le_herestring_nest_pas_un_heredoc(self):
        stripped = watch.strip_heredocs('grep -q motif <<< "$texte"\ngit status')
        self.assertIn("git status", stripped, "« <<< » n'ouvre aucun document")


class CorpsInlineNestPasUneCible(HookTestCase):
    """`python -c "import io"` ne lance pas un programme nommé « import »."""

    def test_python_dash_c_sur_une_ligne(self):
        patterns = self.patterns('python -c "import io; print(io)"')
        self.assertEqual(patterns, ["python -c"])

    def test_python_dash_c_sur_plusieurs_lignes(self):
        patterns = self.patterns('python -c "\nimport io\nprint(io)\n"')
        self.assertEqual(patterns, ["python -c"])

    def test_aucun_mot_du_corps_ne_devient_une_cible(self):
        for command in ('python -c "import io"', "node -e 'require(\"fs\")'",
                        "perl -e 'print 1'", "bash -c 'npm run lint'"):
            with self.subTest(command=command):
                for pattern in self.patterns(command):
                    self.assertLessEqual(len(pattern.split()), 2)
                    self.assertNotIn("import", pattern)
                    self.assertNotIn("require", pattern)
                    self.assertNotIn("print", pattern)

    def test_un_vrai_script_reste_la_cible(self):
        patterns = self.patterns("python -u scripts/milestone_run.py watch")
        self.assertEqual(patterns, ["python scripts/milestone_run.py"],
                         "seul le corps de « -c » / « -e » est écarté, pas un fichier")


class NomsDeCommandeBienFormes(HookTestCase):
    """Aucune observation dont le nom de commande sort de la forme attendue."""

    def test_toute_la_campagne(self):
        for command in CAMPAGNE:
            with self.subTest(command=command.splitlines()[0][:60]):
                for record in self.observe(command):
                    head = record["pattern"].split()[0]
                    self.assertRegex(head, COMMAND_NAME_RE)

    def test_la_prose_nest_jamais_consignee(self):
        patterns = self.patterns(
            "cat > note.md <<'EOF'\n"
            "## Périmètre retenu\n"
            "- le hook consigne une observation par ligne\n"
            "```\n"
            "EOF")
        self.assertEqual(patterns, ["cat"])


class PartDeFragmentsEcartes(HookTestCase):
    """Sur une campagne neuve, la revue n'a plus rien à écarter (< 5 %)."""

    def test_sous_cinq_pour_cent(self):
        ecartes, total = [], 0
        for command in CAMPAGNE:
            for record in self.observe(command):
                total += 1
                if review.not_a_command(record["pattern"], (record["example"],)):
                    ecartes.append(record["pattern"])
        self.assertGreater(total, 0, "une campagne muette ne prouverait rien")
        part = len(ecartes) / total
        self.assertLess(part, 0.05, f"{part:.0%} de fragments écartés : {ecartes}")


class LesVraiesCommandesSurvivent(HookTestCase):
    """Un garde-fou qui refuse tout ne protège de rien."""

    def test_chaque_commande_sous_son_motif_le_plus_etroit(self):
        attendus = {
            "npm run verify": ["npm run verify"],
            "git status --short": ["git status"],
            "docker compose up -d": ["docker compose up"],
            "terraform validate": ["terraform validate"],
            "gh pr checks 215": ["gh pr checks"],
            "python scripts/pr_gate.py 215": ["python scripts/pr_gate.py"],
        }
        for command, patterns in attendus.items():
            with self.subTest(command=command):
                self.assertEqual(self.patterns(command), patterns)

    def test_une_commande_composee_reste_observee_morceau_par_morceau(self):
        self.assertEqual(self.patterns("git status --short && git log --oneline -1"),
                         ["git status", "git log"])

    def test_un_motif_deja_autorise_nest_pas_consigne(self):
        self.write_settings(allow=["Bash(npm run verify:*)"])
        self.assertEqual(self.patterns("npm run verify"), [])

    def test_le_risque_reste_annonce(self):
        records = self.observe("rm -rf build")
        self.assertEqual([record["risk"] for record in records], ["destructive"])


class LeHookNempecheJamaisDagir(HookTestCase):
    """Observer ne doit jamais coûter une commande."""

    def test_journal_inaccessible(self):
        with mock.patch.object(watch, "OBSERVED", Path(self.tmp.name) / ("n" * 300)):
            self.assertEqual(self.patterns("npm run verify"), [])

    def test_garde_fou_indisponible(self):
        """Sans la revue, le filet minimal tient encore le critère de forme."""
        with mock.patch.object(watch, "reviewer_guard", lambda: None):
            self.assertTrue(watch.is_noise("## Titre", "## Titre"))
            self.assertFalse(watch.is_noise("npm run verify", "npm run verify"))


if __name__ == "__main__":
    unittest.main()
