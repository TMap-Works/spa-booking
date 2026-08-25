#!/usr/bin/env python3
"""Tests du superviseur de jalon — `scripts/milestone_supervise.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Pourquoi ces fonctions et pas d'autres : #138 a coûté cinq legs, environ 85
minutes et une trentaine de dollars sans produire **un seul commit**. Chaque leg
se terminait « success », reprenait le ticket à zéro, refaisait le même travail
et mourait au même endroit. Le détecteur d'enlisement d'alors comptait les
*tickets aboutis* — un signal qui n'arrive qu'après le merge, donc bien trop
tard pour interrompre une boucle qui ne commite jamais.

Ce qui est vérifié ici est donc le nouveau signal et lui seul : le commit. Une
régression sur `sterile_streak` ou `work_commits` ne casserait rien de visible —
elle laisserait simplement le dispositif tourner à vide, ce qui est exactement le
mode de défaillance que #138 décrit.

Aucune dépendance : `unittest` de la bibliothèque standard, comme
`test_pr_gate.py`.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import milestone_supervise as sup  # noqa: E402 — l'insertion de chemin la précède


class SterileStreak(unittest.TestCase):
    """La règle d'arrêt de #138 : deux legs de suite sans un commit de plus."""

    def test_un_commit_remet_le_compteur_a_zero(self):
        self.assertEqual(sup.sterile_streak(1, {"abc123"}, None), 0)

    def test_aucun_commit_incremente(self):
        self.assertEqual(sup.sterile_streak(0, set(), None), 1)
        self.assertEqual(sup.sterile_streak(1, set(), None), 2)

    def test_deux_legs_steriles_atteignent_la_limite(self):
        """Le cas de #138 : leg terminé, ticket encore en cours, zéro commit."""
        streak = 0
        for _ in range(2):
            streak = sup.sterile_streak(streak, set(), None)
        self.assertGreaterEqual(streak, sup.DRY_LEGS_LIMIT)

    def test_un_seul_leg_sterile_ne_declenche_pas(self):
        """Un leg peut légitimement ne rien commiter — une vague d'intégration,
        par exemple. C'est la répétition qui fait le diagnostic, pas l'occurrence."""
        self.assertLess(sup.sterile_streak(0, set(), None), sup.DRY_LEGS_LIMIT)

    def test_le_quota_n_est_pas_une_sterilite(self):
        """Un leg coupé par l'API n'a pas démérité : il n'a pas eu le temps.

        Sans cette exception, une fenêtre de quota qui se referme deux fois de
        suite désarmerait le dispositif — précisément le contraire de ce pour
        quoi il existe.
        """
        self.assertEqual(sup.sterile_streak(1, set(), "quota"), 1)
        self.assertEqual(sup.sterile_streak(0, set(), "quota"), 0)

    def test_les_autres_pannes_comptent(self):
        """Un leg qui échoue sans rien commiter laisse le même dépôt qu'un leg
        qui rend la main trop tôt. Rien ne justifie de l'excuser."""
        self.assertEqual(sup.sterile_streak(1, set(), "échec"), 2)
        self.assertEqual(sup.sterile_streak(1, set(), "lancement"), 2)


class WorkCommits(unittest.TestCase):
    """Ce qui est compté comme travail durable, et ce qui ne l'est pas."""

    def test_les_branches_d_integration_sont_exclues(self):
        """`develop` avance à chaque merge sans qu'un agent y soit pour rien.
        La compter ferait passer un leg stérile pour un leg productif."""
        refs = ["develop", "staging", "main", "feature/18-squelette-nestjs"]

        def fake(*argv):
            if argv[0] == "for-each-ref":
                return refs
            self.assertEqual(argv[0], "rev-list")
            self.assertEqual(argv[1], "origin/develop..feature/18-squelette-nestjs")
            return ["aaa111", "bbb222"]

        with mock.patch.object(sup, "git_lines", side_effect=fake):
            self.assertEqual(sup.work_commits(), {"aaa111", "bbb222"})

    def test_plusieurs_branches_sont_reunies(self):
        def fake(*argv):
            if argv[0] == "for-each-ref":
                return ["feature/18-a", "chore/10-b"]
            return {"origin/develop..feature/18-a": ["aaa111"],
                    "origin/develop..chore/10-b": ["bbb222"]}[argv[1]]

        with mock.patch.object(sup, "git_lines", side_effect=fake):
            self.assertEqual(sup.work_commits(), {"aaa111", "bbb222"})

    def test_aucune_branche_de_ticket_rend_un_ensemble_vide(self):
        with mock.patch.object(sup, "git_lines", return_value=["develop"]):
            self.assertEqual(sup.work_commits(), set())


class GitLines(unittest.TestCase):
    """Le superviseur ne doit jamais mourir d'un appel git.

    Un dépôt momentanément verrouillé par un agent doit se lire « rien de neuf »,
    pas « plantage » — sans quoi la veille relancerait toutes les cinq minutes un
    superviseur qui remourrait de la même façon.
    """

    def test_sortie_decoupee_et_nettoyee(self):
        done = subprocess.CompletedProcess([], 0, "aaa111\n  bbb222  \n\n", "")
        with mock.patch.object(sup.subprocess, "run", return_value=done):
            self.assertEqual(sup.git_lines("rev-list", "x"), ["aaa111", "bbb222"])

    def test_code_de_retour_non_nul_rend_une_liste_vide(self):
        done = subprocess.CompletedProcess([], 128, "", "fatal: bad revision")
        with mock.patch.object(sup.subprocess, "run", return_value=done):
            self.assertEqual(sup.git_lines("rev-list", "x"), [])

    def test_git_absent_rend_une_liste_vide(self):
        with mock.patch.object(sup.subprocess, "run", side_effect=OSError):
            self.assertEqual(sup.git_lines("rev-list", "x"), [])

    def test_expiration_rend_une_liste_vide(self):
        with mock.patch.object(sup.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("git", 30)):
            self.assertEqual(sup.git_lines("rev-list", "x"), [])


class EndReasons(unittest.TestCase):
    """« success » n'est pas une raison d'arrêt — c'est ce qui a masqué #138."""

    def test_success_est_traduit_en_clair(self):
        self.assertIn("rendu la main", sup.END_REASONS["success"])
        self.assertNotEqual(sup.END_REASONS["success"], "success")

    def test_les_arrets_anormaux_sont_nommes(self):
        self.assertIn("tours", sup.END_REASONS["error_max_turns"])
        self.assertIn("erreur", sup.END_REASONS["error_during_execution"])


class OrchestratorActive(unittest.TestCase):
    """Le verrou de #130 : la veille ne double pas un orchestrateur vivant.

    `supervisor_alive()` ne voit qu'un superviseur, parce que lui seul écrit un
    battement. Une session Claude Code qui déroule `/milestone` à la main
    orchestre tout autant et n'en écrit aucun — c'est cette cécité qui a fait
    lancer un second orchestrateur sur le run S1, lequel a supprimé les
    worktrees du premier.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def journal(self, age_seconds):
        path = self.run / "journal.ndjson"
        path.write_text("{}\n", encoding="utf-8")
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))

    def test_journal_recent_signifie_quelqu_un_orchestre(self):
        self.journal(30)
        with mock.patch.object(sup, "current_run_dir", return_value=self.run):
            self.assertTrue(sup.orchestrator_active())

    def test_journal_muet_depuis_longtemps_signifie_personne(self):
        self.journal(sup.ORCHESTRATOR_QUIET + 60)
        with mock.patch.object(sup, "current_run_dir", return_value=self.run):
            self.assertFalse(sup.orchestrator_active())

    def test_aucun_run_ouvert(self):
        with mock.patch.object(sup, "current_run_dir", return_value=None):
            self.assertFalse(sup.orchestrator_active())

    def test_journal_absent(self):
        """Un run ouvert dont le journal n'existe pas encore n'orchestre rien —
        et surtout, cela ne doit pas lever."""
        with mock.patch.object(sup, "current_run_dir", return_value=self.run):
            self.assertFalse(sup.orchestrator_active())


class CurrentRunMilestone(unittest.TestCase):
    """Un run ouvert désigne son jalon ; le redeviner en ouvre un autre.

    Lancé sans argument, le superviseur a résolu « le jalon le plus proche » en
    S3 et ouvert un run neuf, abandonnant le run S1 en cours.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_jalon_lu_dans_le_run_ouvert(self):
        (self.run / "run.json").write_text(
            json.dumps({"milestone": "S1 — Fondations"}), encoding="utf-8")
        with mock.patch.object(sup, "current_run_dir", return_value=self.run):
            self.assertEqual(sup.current_run_milestone(), "S1 — Fondations")

    def test_aucun_run_ouvert(self):
        with mock.patch.object(sup, "current_run_dir", return_value=None):
            self.assertIsNone(sup.current_run_milestone())

    def test_run_json_illisible(self):
        (self.run / "run.json").write_text("{ pas du json", encoding="utf-8")
        with mock.patch.object(sup, "current_run_dir", return_value=self.run):
            self.assertIsNone(sup.current_run_milestone())

    def test_run_json_sans_jalon(self):
        (self.run / "run.json").write_text("{}", encoding="utf-8")
        with mock.patch.object(sup, "current_run_dir", return_value=self.run):
            self.assertIsNone(sup.current_run_milestone())


if __name__ == "__main__":
    unittest.main()
