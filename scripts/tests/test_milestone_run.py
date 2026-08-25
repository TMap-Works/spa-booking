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

Le second sujet est le choix du jalon quand `start` n'en reçoit aucun. Il tient
à un ordre — reprendre avant ouvrir — et à une abstention : ne rien demander
quand il n'y a pas de clavier, sous peine de bloquer la reprise automatique.

Aucune dépendance : `unittest` de la bibliothèque standard.
"""
import json
import subprocess
import sys
import tempfile
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


def digest(name, milestone, finished=False, signal="run", active=False):
    return {"id": name, "milestone": milestone, "created": "", "width": 3,
            "done": 0, "total": 5, "wave": 1, "waves": 3, "signal": signal,
            "finished": finished, "active": active}


def row(title, due, open_issues=0, closed=0, state="open", run=None):
    return {"title": title, "state": state, "due": due, "open": open_issues,
            "closed": closed, "run": run}


def tty(value):
    stream = mock.MagicMock()
    stream.isatty.return_value = value
    return stream


class QuelJalon(unittest.TestCase):
    """Ce que `start` sans argument doit choisir — et pourquoi.

    L'ordre est tout : proposer un jalon neuf pendant qu'un run est en cours
    laisserait derrière lui des worktrees vivants et des PR ouvertes que plus
    personne ne reprendrait.
    """

    def test_le_run_en_cours_passe_avant_le_jalon_le_plus_urgent(self):
        rows = [row("S1", "2026-08-28", open_issues=5),
                row("S3", "2026-09-11", open_issues=9,
                    run=digest("s3-x", "S3", active=True))]
        pick, why = run_mod.recommend(rows)
        self.assertEqual(pick["title"], "S3")
        self.assertIn("en cours", why)

    def test_un_run_inacheve_passe_avant_un_jalon_jamais_entame(self):
        rows = [row("S1", "2026-08-28", open_issues=5,
                    run=digest("s1-x", "S1")),
                row("S2", "2026-09-04", open_issues=9)]
        pick, why = run_mod.recommend(rows)
        self.assertEqual(pick["title"], "S1")
        self.assertIn("inachevé", why)

    def test_entre_deux_runs_inacheves_l_echeance_tranche(self):
        rows = [row("S1", "2026-08-28", open_issues=5, run=digest("s1-x", "S1")),
                row("S3", "2026-09-11", open_issues=9, run=digest("s3-x", "S3"))]
        self.assertEqual(run_mod.recommend(rows)[0]["title"], "S1")

    def test_un_run_arrete_a_la_main_ne_se_reprend_pas(self):
        """`stop` est une décision humaine : la reproposer la contredirait."""
        rows = [row("S1", "2026-08-28", open_issues=5,
                    run=digest("s1-x", "S1", signal="stop", active=True)),
                row("S2", "2026-09-04", open_issues=9)]
        pick, why = run_mod.recommend(rows)
        self.assertEqual(pick["title"], "S1")     # il reste 5 issues ouvertes
        self.assertIn("échéance", why)            # mais comme jalon neuf

    def test_une_pause_reste_visible_dans_la_proposition(self):
        rows = [row("S1", "2026-08-28", open_issues=5,
                    run=digest("s1-x", "S1", signal="pause", active=True))]
        self.assertIn("pause demandée", run_mod.recommend(rows)[1])

    def test_un_jalon_deroule_est_saute(self):
        """Un jalon ouvert dont toutes les issues sont closes n'a rien à lancer :
        c'est le suivant qu'il faut proposer, pas lui."""
        rows = [row("S1", "2026-08-28", open_issues=0, closed=57,
                    run=digest("s1-x", "S1", finished=True, active=True)),
                row("S2", "2026-09-04", open_issues=9)]
        self.assertEqual(run_mod.recommend(rows)[0]["title"], "S2")

    def test_plus_rien_a_faire_ne_propose_rien(self):
        rows = [row("S1", "2026-08-28", open_issues=0, closed=57)]
        pick, why = run_mod.recommend(rows)
        self.assertIsNone(pick)
        self.assertIn("aucun jalon", why)


class SansClavier(unittest.TestCase):
    """La question ne se pose que devant un terminal.

    Le superviseur, la tâche planifiée et `claude -p` ouvrent des runs sans
    personne derrière eux : une invite bloquerait la reprise automatique, ce que
    la reprise automatique existe précisément pour éviter.
    """

    def ask(self, rows, default, isatty=True, answer="", env=None):
        with mock.patch.dict(run_mod.os.environ, env or {}, clear=False), \
             mock.patch.object(run_mod.sys, "stdin", tty(isatty)), \
             mock.patch.object(run_mod.sys, "stdout", tty(isatty)), \
             mock.patch("builtins.input", return_value=answer) as prompt:
            return run_mod.ask_milestone(rows, default), prompt

    def deux(self):
        return [row("S1", "2026-08-28", open_issues=5),
                row("S2", "2026-09-04", open_issues=9)]

    def test_hors_terminal_rien_n_est_demande(self):
        rows = self.deux()
        chosen, prompt = self.ask(rows, rows[0], isatty=False)
        self.assertIs(chosen, rows[0])
        prompt.assert_not_called()

    def test_sous_supervision_rien_n_est_demande(self):
        rows = self.deux()
        chosen, prompt = self.ask(rows, rows[0], env={"SPA_UNATTENDED": "1"})
        self.assertIs(chosen, rows[0])
        prompt.assert_not_called()

    def test_entree_vide_retient_la_proposition(self):
        rows = self.deux()
        self.assertIs(self.ask(rows, rows[0], answer="")[0], rows[0])

    def test_un_chiffre_choisit(self):
        rows = self.deux()
        self.assertIs(self.ask(rows, rows[0], answer="2")[0], rows[1])

    def test_un_prefixe_de_titre_choisit(self):
        rows = self.deux()
        self.assertIs(self.ask(rows, rows[0], answer="s2")[0], rows[1])

    def test_une_reponse_incomprise_retient_la_proposition(self):
        """Ne rien comprendre ne doit pas ouvrir un run au hasard."""
        rows = self.deux()
        self.assertIs(self.ask(rows, rows[0], answer="S9")[0], rows[0])

    def test_unattended_desarme_rend_le_clavier(self):
        """`SPA_UNATTENDED=0` désarme la variable — comme dans `pr_gate.py`."""
        rows = self.deux()
        chosen, prompt = self.ask(rows, rows[0], answer="2",
                                  env={"SPA_UNATTENDED": "0"})
        self.assertIs(chosen, rows[1])
        prompt.assert_called_once()

    def test_un_seul_candidat_ne_se_demande_pas(self):
        rows = [row("S1", "2026-08-28", open_issues=5)]
        chosen, prompt = self.ask(rows, rows[0])
        self.assertIs(chosen, rows[0])
        prompt.assert_not_called()

    def test_les_jalons_deroules_ne_sont_pas_proposes(self):
        rows = [row("S1", "2026-08-28", open_issues=5),
                row("S2", "2026-09-04", open_issues=0, closed=17)]
        chosen, prompt = self.ask(rows, rows[0])
        self.assertIs(chosen, rows[0])
        prompt.assert_not_called()       # un seul candidat une fois S2 écarté


class Tableau(unittest.TestCase):
    """`survey` — les jalons de GitHub et les runs du disque, sur une même ligne."""

    def survey(self, milestones, digests=(), error=None):
        dirs = [Path(str(index)) for index in range(len(digests))]
        with mock.patch.object(run_mod, "gh_json", return_value=(milestones, error)), \
             mock.patch.object(run_mod, "run_dirs", return_value=dirs), \
             mock.patch.object(run_mod, "run_digest", side_effect=list(digests)):
            return run_mod.survey()

    def milestone(self, title, due, state="open", opened=3, closed=1):
        return {"title": title, "state": state, "due_on": f"{due}T00:00:00Z",
                "open_issues": opened, "closed_issues": closed}

    def test_les_jalons_sortent_par_echeance(self):
        rows, _ = self.survey([self.milestone("S3", "2026-09-11"),
                               self.milestone("S1", "2026-08-28")])
        self.assertEqual([r["title"] for r in rows], ["S1", "S3"])

    def test_le_run_est_rattache_a_son_jalon(self):
        rows, _ = self.survey([self.milestone("S1", "2026-08-28")],
                              [digest("s1-x", "S1")])
        self.assertEqual(rows[0]["run"]["id"], "s1-x")

    def test_le_run_le_plus_recent_gagne(self):
        """`run_dirs` va du plus récent au plus ancien : un run rouvert d'hier ne
        doit pas masquer celui d'aujourd'hui."""
        rows, _ = self.survey([self.milestone("S1", "2026-08-28")],
                              [digest("s1-neuf", "S1"), digest("s1-vieux", "S1")])
        self.assertEqual(rows[0]["run"]["id"], "s1-neuf")

    def test_un_jalon_clos_et_sans_run_disparait(self):
        rows, _ = self.survey([self.milestone("S0", "2026-08-21", state="closed"),
                               self.milestone("S1", "2026-08-28")])
        self.assertEqual([r["title"] for r in rows], ["S1"])

    def test_un_jalon_clos_gardant_un_run_reste_visible(self):
        rows, _ = self.survey([self.milestone("S0", "2026-08-21", state="closed")],
                              [digest("s0-x", "S0")])
        self.assertEqual([r["title"] for r in rows], ["S0"])

    def test_un_run_dont_le_jalon_est_inconnu_reste_listable(self):
        """Dépôt injoignable ou jalon supprimé : le plan est dans le run, il doit
        rester reprenable."""
        rows, warning = self.survey(None, [digest("s9-x", "S9")], error="gh indisponible")
        self.assertEqual([r["title"] for r in rows], ["S9"])
        self.assertIsNone(rows[0]["open"])
        self.assertEqual(warning, "gh indisponible")

    def test_un_run_illisible_est_ignore(self):
        rows, _ = self.survey([self.milestone("S1", "2026-08-28")], [None])
        self.assertIsNone(rows[0]["run"])


class RunAbime(unittest.TestCase):
    """`run_digest` passe sur *tous* les runs du disque à chaque `next` et à
    chaque `start` sans jalon : un seul dossier abîmé ne doit pas les briser."""

    def digest(self, payload):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "s1-abime"
            directory.mkdir()
            (directory / "run.json").write_text(payload, encoding="utf-8")
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                return run_mod.run_digest("s1-abime")

    def test_un_run_sans_plan_est_ignore(self):
        self.assertIsNone(self.digest('{"id": "s1-abime", "milestone": "S1"}'))

    def test_un_run_json_qui_n_est_pas_un_objet_est_ignore(self):
        self.assertIsNone(self.digest("[]"))

    def test_un_run_json_tronque_est_ignore(self):
        self.assertIsNone(self.digest('{"id": "s1-abi'))

    def test_un_run_valide_se_lit(self):
        run = {"id": "s1-abime", "milestone": "S1", "created": "2026-08-01",
               "width": 3, "plan": {"waves": [{"index": 1, "issues": []}]}}
        self.assertEqual(self.digest(json.dumps(run))["milestone"], "S1")


if __name__ == "__main__":
    unittest.main()
