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

Aucune dépendance : `unittest` de la bibliothèque standard, comme les autres
harnais de `scripts/tests`.
"""
import io
import json
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


if __name__ == "__main__":
    unittest.main()
