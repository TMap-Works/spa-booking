#!/usr/bin/env python3
"""Tests du journal de run — `scripts/milestone_run.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce qui est couvert ici tient à un défaut précis, #130 : `reconcile` ne regardait
que le dépôt **distant**. Un ticket dont le travail existait en local mais
n'avait pas encore été poussé s'y lisait « ni branche ni PR — jamais démarré »,
était remis en file, et un second agent était lancé sur la même empreinte — dont
le premier réflexe fut de « nettoyer » le worktree du premier. Trois worktrees
ont ainsi été supprimés avec leur contenu.

Le worktree est la seule trace d'un agent au travail pendant la fenêtre qui
sépare le rebase de la phase 1 du premier push. La lire correctement est donc ce
qui empêche un run de se détruire lui-même.

Aucune dépendance : `unittest` de la bibliothèque standard.
"""
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import milestone_run as run_mod  # noqa: E402 — l'insertion de chemin la précède


PORCELAIN = """\
worktree D:/spyle/Spa & Booking
HEAD df4ae3f00000000000000000000000000000000
branch refs/heads/develop

worktree D:/spyle/Spa & Booking/.claude/worktrees/agent-aaa
HEAD 841a02400000000000000000000000000000000
branch refs/heads/feature/18-squelette-nestjs
locked

worktree D:/spyle/Spa & Booking/.claude/worktrees/agent-bbb
HEAD df4ae3f00000000000000000000000000000000
branch refs/heads/chore/10-backend-terraform

worktree D:/spyle/Spa & Booking/.claude/worktrees/agent-ccc
HEAD df4ae3f00000000000000000000000000000000
detached
"""


def completed(returncode=0, stdout=""):
    return subprocess.CompletedProcess([], returncode, stdout, "")


class LiveWorktrees(unittest.TestCase):
    """Ce que `reconcile` doit voir en local, et qu'il ne voyait pas."""

    def parse(self, porcelain, returncode=0):
        with mock.patch.object(run_mod.subprocess, "run",
                               return_value=completed(returncode, porcelain)):
            return run_mod.live_worktrees()

    def test_les_worktrees_de_tickets_sont_indexes_par_numero(self):
        found = self.parse(PORCELAIN)
        self.assertEqual(set(found), {18, 10})

    def test_le_verrou_est_rapporte(self):
        """Un worktree verrouillé est un worktree occupé — c'est le signal que
        l'orchestrateur de #130 a ignoré avant de supprimer."""
        found = self.parse(PORCELAIN)
        self.assertTrue(found[18]["locked"])
        self.assertFalse(found[10]["locked"])

    def test_la_branche_et_le_chemin_sont_conserves(self):
        found = self.parse(PORCELAIN)
        self.assertEqual(found[18]["branch"], "feature/18-squelette-nestjs")
        self.assertTrue(found[18]["path"].endswith("agent-aaa"))

    def test_le_depot_principal_et_les_detaches_sont_ignores(self):
        """`develop` n'est pas un ticket, et une HEAD détachée ne dit à quel
        ticket elle appartient."""
        found = self.parse(PORCELAIN)
        self.assertNotIn(0, found)
        self.assertEqual(len(found), 2)

    def test_git_en_echec_rend_un_dictionnaire_vide(self):
        """Ne pas savoir doit se lire « aucun worktree », jamais lever : une
        exception ici ferait échouer toute reprise de run."""
        self.assertEqual(self.parse("", returncode=128), {})

    def test_git_absent_rend_un_dictionnaire_vide(self):
        with mock.patch.object(run_mod.subprocess, "run", side_effect=OSError):
            self.assertEqual(run_mod.live_worktrees(), {})

    def test_expiration_rend_un_dictionnaire_vide(self):
        with mock.patch.object(run_mod.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("git", 60)):
            self.assertEqual(run_mod.live_worktrees(), {})

    def test_sortie_vide(self):
        self.assertEqual(self.parse(""), {})

    def test_derniere_entree_sans_ligne_vide_finale(self):
        """`git worktree list --porcelain` termine par une ligne vide, mais s'y
        fier sans filet perdrait la dernière entrée."""
        porcelain = ("worktree /tmp/agent-zzz\n"
                     "HEAD 000\n"
                     "branch refs/heads/bugfix/42-quelque-chose")
        self.assertEqual(set(self.parse(porcelain)), {42})


if __name__ == "__main__":
    unittest.main()
