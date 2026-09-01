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
import argparse
import contextlib
import io
import json
import os
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


# Ces tests interrogent des fonctions qui lisent l'environnement — `leg_start()`
# et `ask_milestone()`. Sous un run de jalon, le superviseur pose
# `SPA_UNATTENDED` et `SPA_LEG_START` dans l'environnement de l'étape, dont
# **hérite chaque `npm run verify` lancé par un agent** : quatre tests y
# rougissaient alors que le dépôt était sain. Un agent perdait donc du temps à
# instruire une panne qui n'existait pas, à chaque ticket.
#
# On neutralise les deux variables pour tout le module. Les tests qui les
# étudient vraiment posent leur propre environnement avec `clear=True`, et ne
# dépendent donc pas de celui-ci.
_ENV = None
ENV_DU_RUN = ("SPA_UNATTENDED", "SPA_LEG_START")


def setUpModule():
    global _ENV
    _ENV = mock.patch.dict(os.environ, {})
    _ENV.start()
    for nom in ENV_DU_RUN:
        os.environ.pop(nom, None)


def tearDownModule():
    if _ENV is not None:
        _ENV.stop()


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

    def test_la_branche_d_avant_renommage_compte_aussi(self):
        """`EnterWorktree` crée `worktree-bugfix+134-…` ; la phase 1 de /ticket
        la renomme aussitôt. Entre les deux, c'est la seule trace de l'agent —
        et depuis #134 un `running` sans trace est requeué, donc ne pas la lire
        relancerait un second agent sur l'empreinte du premier (#130)."""
        found = self.parse(PORCELAIN + """
worktree D:/spyle/Spa & Booking/.claude/worktrees/bugfix+134-reconcile
HEAD df4ae3f00000000000000000000000000000000
branch refs/heads/worktree-bugfix+134-reconcile-running-abandonne
""")
        self.assertIn(134, found)
        self.assertEqual(found[134]["branch"],
                         "worktree-bugfix+134-reconcile-running-abandonne")

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


def digest(name, milestone, finished=False, signal="run", active=False,
           nature="projet"):
    return {"id": name, "milestone": milestone, "created": "", "width": 3,
            "nature": nature, "done": 0, "total": 5, "wave": 1, "waves": 3,
            "signal": signal, "finished": finished, "active": active}


def row(title, due, open_issues=0, closed=0, state="open", run=None, todo=None):
    """Une ligne de `survey`. `todo` — les issues produit — vaut `open` par
    défaut : c'est ce que fait `survey` quand GitHub ne répond pas sur les
    labels, et cela laisse les cas historiques dire exactement ce qu'ils
    disaient."""
    return {"title": title, "state": state, "due": due, "open": open_issues,
            "todo": open_issues if todo is None else todo,
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

    def test_un_jalon_qui_n_a_plus_que_de_l_outillage_n_est_pas_propose(self):
        """Le run ne dispatche que `nature:projet` : proposer un jalon qui n'a
        plus que des chantiers d'outillage l'enverrait ouvrir un run sur un plan
        vide, et masquerait le jalon suivant, qui a du vrai travail."""
        rows = [row("S1", "2026-08-28", open_issues=12, todo=0),
                row("S2", "2026-09-04", open_issues=9, todo=9)]
        pick, why = run_mod.recommend(rows)
        self.assertEqual(pick["title"], "S2")
        self.assertIn("échéance", why)

    def test_plus_que_de_l_outillage_partout_ne_propose_rien(self):
        rows = [row("S1", "2026-08-28", open_issues=12, todo=0)]
        pick, why = run_mod.recommend(rows)
        self.assertIsNone(pick)
        self.assertIn("nature", why)

    def test_un_run_inacheve_se_reprend_meme_sans_ticket_produit(self):
        """La reprise passe avant tout décompte : le run a des worktrees vivants
        et des PR ouvertes qu'un abandon laisserait derrière lui."""
        rows = [row("S1", "2026-08-28", open_issues=3, todo=0,
                    run=digest("s1-x", "S1"))]
        self.assertTrue(run_mod.workable(rows[0]))
        self.assertEqual(run_mod.recommend(rows)[0]["title"], "S1")


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

    def survey(self, milestones, digests=(), error=None, backlog=None,
               nature="projet"):
        dirs = [Path(str(index)) for index in range(len(digests))]
        with mock.patch.object(run_mod, "gh_json", return_value=(milestones, error)), \
             mock.patch.object(run_mod, "nature_backlog", return_value=backlog), \
             mock.patch.object(run_mod, "run_dirs", return_value=dirs), \
             mock.patch.object(run_mod, "run_digest", side_effect=list(digests)):
            return run_mod.survey(nature)

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

    def test_un_run_d_une_autre_nature_n_est_pas_rattache(self):
        """Un run produit inachevé n'a rien à dire à `start --nature outillage` :
        le lui montrer ferait recommander une reprise qui n'est pas la sienne."""
        rows, _ = self.survey([self.milestone("S1", "2026-08-28")],
                              [digest("s1-produit", "S1")], nature="outillage")
        self.assertIsNone(rows[0]["run"])

    def test_le_run_de_la_nature_demandee_est_rattache(self):
        rows, _ = self.survey(
            [self.milestone("S1", "2026-08-28")],
            [digest("s1-outillage", "S1", nature="outillage"),
             digest("s1-produit", "S1")], nature="outillage")
        self.assertEqual(rows[0]["run"]["id"], "s1-outillage")

    def test_le_decompte_a_derouler_ne_compte_que_le_produit(self):
        rows, _ = self.survey([self.milestone("S1", "2026-08-28", opened=12)],
                              backlog={"S1 — Fondations": 3, "S1": 3})
        self.assertEqual(rows[0]["open"], 12)
        self.assertEqual(rows[0]["todo"], 3)

    def test_un_jalon_absent_du_decompte_n_a_plus_rien_a_derouler(self):
        """Aucune issue produit ouverte : le jalon n'apparaît pas dans le
        décompte, et son `todo` vaut zéro — pas son nombre d'issues ouvertes."""
        rows, _ = self.survey([self.milestone("S1", "2026-08-28", opened=12)],
                              backlog={"S2 — Réservation": 4})
        self.assertEqual(rows[0]["todo"], 0)

    def test_github_muet_sur_les_labels_retombe_sur_le_decompte_du_jalon(self):
        """Surestimer est le seul sens acceptable : un jalon proposé à tort se
        voit au premier plan vide, un jalon caché à tort ne se voit jamais."""
        rows, _ = self.survey([self.milestone("S1", "2026-08-28", opened=12)],
                              backlog=None)
        self.assertEqual(rows[0]["todo"], 12)


class DecompteParNature(unittest.TestCase):
    """`nature_backlog` — combien d'issues d'une nature restent, par jalon."""

    def backlog(self, payload, error=None, nature="projet"):
        with mock.patch.object(run_mod, "gh_json", return_value=(payload, error)):
            return run_mod.nature_backlog(nature)

    def query(self, nature):
        """La requête `gh` réellement émise — c'est le label qui fait le filtre."""
        seen = []

        def spy(args):
            seen.append(args)
            return [], None

        with mock.patch.object(run_mod, "gh_json", side_effect=spy):
            run_mod.nature_backlog(nature)
        return seen[0]

    def test_la_nature_demandee_devient_le_label_interroge(self):
        self.assertIn("nature:outillage", self.query("outillage"))
        self.assertIn("nature:projet", self.query("projet"))

    def test_toutes_n_interroge_aucun_label(self):
        self.assertNotIn("--label", self.query("toutes"))

    def test_toutes_ne_compte_pas_une_issue_sans_nature(self):
        """Sans label `nature:*`, le plan la sort en « classement incomplet » :
        la compter ferait proposer un jalon dont le plan sort vide."""
        counts = self.backlog([
            {"number": 1, "milestone": {"title": "S1"},
             "labels": [{"name": "type:chore"}]},
            {"number": 2, "milestone": {"title": "S1"},
             "labels": [{"name": "nature:outillage"}]},
        ], nature="toutes")
        self.assertEqual(counts, {"S1": 1})

    def test_les_issues_se_comptent_par_jalon(self):
        counts = self.backlog([
            {"number": 1, "milestone": {"title": "S1 — Fondations"}},
            {"number": 2, "milestone": {"title": "S1 — Fondations"}},
            {"number": 3, "milestone": {"title": "S2 — Réservation"}},
        ])
        self.assertEqual(counts, {"S1 — Fondations": 2, "S2 — Réservation": 1})

    def test_ce_que_le_plan_ecarte_d_office_ne_compte_pas(self):
        """`qualify()` écarte tracking, post-mvp et épiques avant même de
        regarder la nature : les compter ferait proposer un jalon dont le plan
        sort vide — exactement ce que ce décompte existe pour éviter."""
        counts = self.backlog([
            {"number": 1, "milestone": {"title": "S1"},
             "labels": [{"name": "tracking"}]},
            {"number": 2, "milestone": {"title": "S1"},
             "labels": [{"name": "type:epic"}]},
            {"number": 3, "milestone": {"title": "S1"},
             "labels": [{"name": "post-mvp"}]},
            {"number": 4, "milestone": {"title": "S1"},
             "labels": [{"name": "type:feature"}]},
        ])
        self.assertEqual(counts, {"S1": 1})

    def test_une_page_pleine_rend_none_plutot_qu_un_decompte_tronque(self):
        """Tronquer sous-estimerait, et un jalon caché à tort ne se voit jamais.
        `None` renvoie l'appelant sur le décompte du jalon, qui surestime."""
        page = [{"number": n, "milestone": {"title": "S1"}, "labels": []}
                for n in range(run_mod.BACKLOG_LIMIT)]
        self.assertIsNone(self.backlog(page))

    def test_une_issue_sans_jalon_ne_compte_pour_aucun(self):
        self.assertEqual(self.backlog([{"number": 1, "milestone": None}]), {})

    def test_github_muet_rend_none_plutot_que_zero(self):
        """Zéro voudrait dire « rien à dérouler » et arrêterait le jalon ;
        `None` dit « je ne sais pas », et l'appelant retombe sur GitHub."""
        self.assertIsNone(self.backlog(None, error="gh indisponible"))


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


class PreAutorisationFautive(unittest.TestCase):
    """Une coquille dans `--merge-sensitive` ne doit pas coûter la veille.

    `start` ouvre le run **puis** arme la reprise automatique. Une clé mal tapée
    découverte à l'armement fait échouer tout le sous-processus, et le run se
    retrouve ouvert sans aucune reprise — le dispositif que #156 répare se
    débrancherait sur un mot mal orthographié. D'où le contrôle avant ouverture.
    """

    def test_cle_inconnue_refusee(self):
        message = run_mod.check_merge_sensitive("terraform")
        self.assertIsNotNone(message)
        self.assertIn("terraform", message)

    def test_cle_connue_acceptee(self):
        self.assertIsNone(run_mod.check_merge_sensitive("infra/terraform,prisma"))

    def test_valeur_absente_ne_dit_rien(self):
        for value in ("", "   ", None):
            with self.subTest(valeur=repr(value)):
                self.assertIsNone(run_mod.check_merge_sensitive(value))

    def test_all_accepte(self):
        self.assertIsNone(run_mod.check_merge_sensitive("all"))

    def test_registre_illisible_n_empeche_pas_d_ouvrir_le_run(self):
        """Le superviseur le dira lui-même à l'armement : un run vaut mieux
        ouvert sans veille que pas ouvert du tout."""
        with mock.patch.dict(sys.modules, {"milestone_supervise": None}):
            self.assertIsNone(run_mod.check_merge_sensitive("nimportequoi"))


def plan_issue(number, resources=("scripts/x",)):
    return {"number": number, "title": f"issue {number}", "priority": "P1",
            "workstream": "devops", "module": "infra",
            "resources": list(resources)}


def write_run(tmp, journal=(), control=None):
    """Un run complet sur disque — deux vagues, trois tickets."""
    directory = Path(tmp) / "r1"
    directory.mkdir()
    run = {"id": "r1", "milestone": "S1", "created": "2026-08-01T00:00:00+00:00",
           "width": 2, "plan": {"waves": [
               {"index": 1, "issues": [plan_issue(19), plan_issue(20)]},
               {"index": 2, "issues": [plan_issue(21)]}]}}
    (directory / "run.json").write_text(json.dumps(run), encoding="utf-8")
    if control is not None:
        (directory / "control.json").write_text(json.dumps(control),
                                                encoding="utf-8")
    with open(directory / "journal.ndjson", "w", encoding="utf-8") as handle:
        for event in journal:
            handle.write(json.dumps(event) + "\n")
    return directory


class LogParTicket(unittest.TestCase):
    """Chaque traitement a son propre fichier — `tail -f tickets/19.log` suit un
    seul agent sans le bruit des voisins. Avant, tout se mêlait dans run.log."""

    def append(self, event):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"):
                (Path(tmp) / "r1").mkdir()
                run_mod.append_journal("r1", event)
                per_ticket = Path(tmp) / "r1" / "tickets"
                return {p.name: p.read_text(encoding="utf-8")
                        for p in per_ticket.glob("*.log")} if per_ticket.exists() else {}

    def test_un_evenement_de_ticket_alimente_son_propre_log(self):
        found = self.append({"ts": "2026-08-25T10:00:00+00:00", "kind": "ticket",
                             "ticket": 19, "phase": "ci", "status": "ci_green",
                             "message": "pr_gate vert"})
        self.assertIn("19.log", found)
        self.assertIn("pr_gate vert", found["19.log"])

    def test_un_evenement_de_run_n_ecrit_aucun_log_de_ticket(self):
        self.assertEqual(self.append({"ts": "2026-08-25T10:00:00+00:00",
                                      "kind": "run", "status": "resumed",
                                      "message": "reprise"}), {})


class PauseSurErreur(unittest.TestCase):
    """`onerror pause` armée, un ticket tombé retient le run entier au gate —
    c'est ce qui fait traiter l'erreur avant la vague suivante au lieu de
    l'empiler dessus."""

    FAILED = {"ts": "2026-08-25T10:00:00+00:00", "kind": "ticket", "ticket": 19,
              "phase": "validation", "status": "failed", "message": "verify rouge"}
    # Ce que le shell journalise quand on tape `retry 19` — c'est l'événement,
    # pas la liste `control["retry"]`, qui remet le ticket en file.
    RETRIED = {"ts": "2026-08-25T11:00:00+00:00", "kind": "ticket", "ticket": 19,
               "status": "pending", "reset": True, "actor": "humain",
               "message": "remis en file à la main"}

    def gate(self, journal, control):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal, control=control)
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                code = run_mod.cmd_gate(argparse.Namespace(run="r1"))
            return code, output.getvalue()

    def test_armee_un_echec_retient_le_run(self):
        code, output = self.gate([self.FAILED],
                                 {"signal": "run", "pause_on_error": True})
        self.assertEqual(code, run_mod.PAUSE)
        self.assertIn("#19", output)
        self.assertIn("pause sur erreur", output)

    def test_desarmee_un_echec_laisse_passer(self):
        code, _ = self.gate([self.FAILED], {"signal": "run"})
        self.assertEqual(code, run_mod.GO)

    def test_armee_sans_echec_laisse_passer(self):
        code, _ = self.gate([], {"signal": "run", "pause_on_error": True})
        self.assertEqual(code, run_mod.GO)

    def test_retry_relache_la_retenue(self):
        """La retenue existe pour qu'un humain tranche : `retry` est ce
        tranchement, le gate doit alors rendre la main."""
        code, _ = self.gate([self.FAILED, self.RETRIED],
                            {"signal": "run", "pause_on_error": True,
                             "retry": [19]})
        self.assertEqual(code, run_mod.GO)

    def test_un_second_echec_apres_retry_retient_de_nouveau(self):
        """`control["retry"]` ne se rejoue pas par-dessus le journal : un
        ticket relancé qui retombe doit se relire `failed`, pas `pending` —
        sinon la boucle de relance est infinie et l'échec invisible."""
        again = dict(self.FAILED, ts="2026-08-25T11:30:00+00:00",
                     message="verify rouge, seconde fois")
        code, output = self.gate([self.FAILED, self.RETRIED, again],
                                 {"signal": "run", "pause_on_error": True,
                                  "retry": [19]})
        self.assertEqual(code, run_mod.PAUSE)
        self.assertIn("#19", output)

    def test_apres_la_derniere_vague_l_echec_ne_retient_plus(self):
        """Jalon déroulé, un ticket laissé en échec : le gate doit dire
        « toutes les vagues sont achevées » (NO_RUN), pas retenir pour
        toujours un run qui n'a plus rien à lancer."""
        done = [{"ts": f"2026-08-25T12:0{i}:00+00:00", "kind": "ticket",
                 "ticket": n, "phase": "merge", "status": "merged",
                 "message": "mergée"} for i, n in enumerate((20, 21))]
        code, output = self.gate([self.FAILED] + done,
                                 {"signal": "run", "pause_on_error": True})
        self.assertEqual(code, run_mod.NO_RUN)
        self.assertIn("achevées", output)


class SegmentsDePhases(unittest.TestCase):
    """La vue `ticket N` rejoue les phases dans l'ordre vécu, retours compris."""

    def test_un_retour_de_phase_ouvre_un_segment_distinct(self):
        events = [
            {"ts": "2026-08-25T10:00:00+00:00", "phase": "validation"},
            {"ts": "2026-08-25T10:05:00+00:00", "phase": "revue"},
            {"ts": "2026-08-25T10:09:00+00:00", "phase": "validation"},
        ]
        segments = run_mod.phase_segments(events)
        self.assertEqual([s["phase"] for s in segments],
                         ["validation", "revue", "validation"])

    def test_le_statut_du_segment_est_le_dernier_journalise(self):
        events = [
            {"ts": "2026-08-25T10:00:00+00:00", "phase": "implementation",
             "status": "running"},
            {"ts": "2026-08-25T10:07:00+00:00", "phase": "implementation",
             "status": "blocked"},
        ]
        self.assertEqual(run_mod.phase_segments(events)[0]["status"], "blocked")

    def test_un_retour_apres_echec_rouvre_la_meme_phase(self):
        """Un retry rejoue la phase où le ticket est tombé : l'échec du premier
        passage doit rester un segment visible, pas être avalé par le second."""
        events = [
            {"ts": "2026-08-25T10:00:00+00:00", "phase": "implementation",
             "status": "running"},
            {"ts": "2026-08-25T10:20:00+00:00", "phase": "implementation",
             "status": "failed"},
            {"ts": "2026-08-25T11:30:00+00:00", "phase": "implementation",
             "status": "running"},
        ]
        segments = run_mod.phase_segments(events)
        self.assertEqual([s["status"] for s in segments], ["failed", "running"])

    def test_un_statut_sans_phase_marque_le_segment_courant(self):
        """`event --status failed` sans `--phase` est accepté : l'échec doit
        marquer la phase en cours, pas disparaître de la table."""
        events = [
            {"ts": "2026-08-25T10:00:00+00:00", "phase": "validation",
             "status": "running"},
            {"ts": "2026-08-25T10:10:00+00:00", "status": "failed"},
        ]
        self.assertEqual(run_mod.phase_segments(events)[0]["status"], "failed")

    def test_un_ticket_hors_plan_est_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp)
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                with self.assertRaises(SystemExit):
                    run_mod.ticket_frame("r1", 999, 15)

    def test_la_phase_en_cours_se_mesure_a_maintenant(self):
        """Un agent muet depuis 40 minutes doit afficher 40 minutes, pas la
        durée figée au dernier événement — c'est le signal que la vue existe
        pour montrer."""
        journal = [{"ts": "2026-08-25T10:00:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "implementation",
                    "status": "running", "message": "démarré"}]
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal)
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees", return_value={}):
                frame = run_mod.ticket_frame("r1", 19, 15)
        self.assertIn("en cours", frame)
        self.assertNotIn("    0s  ", frame)

    def test_la_vue_montre_phases_et_echec(self):
        journal = [
            {"ts": "2026-08-25T10:00:00+00:00", "kind": "ticket", "ticket": 19,
             "phase": "implementation", "status": "running", "message": "démarré"},
            {"ts": "2026-08-25T10:20:00+00:00", "kind": "ticket", "ticket": 19,
             "phase": "validation", "status": "failed", "message": "verify rouge"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal)
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees", return_value={}):
                frame = run_mod.ticket_frame("r1", 19, 15)
        self.assertIn("implementation", frame)
        self.assertIn("failed", frame)
        self.assertIn("verify rouge", frame)
        self.assertIn("tickets", frame)          # le chemin du log par ticket


class ReconcileRunningAbandonne(unittest.TestCase):
    """#134 — l'agent tué **avant** son premier push laissait un `running` que
    rien n'attestait et que rien ne rattrapait : `reconcile` le protégeait comme
    un état avancé, le `gate` ne lance que des `pending`, et la vague ne pouvait
    plus ni avancer ni se clore. Le run s'y était figé trois heures.

    Le garde-fou qu'on assouplit protégeait `ci_green` et `reviewed`, que GitHub
    ne sait pas exprimer : ces cas-là doivent continuer de tenir.
    """

    def reconcile(self, journal, issues=(), prs=(), branches=None, worktrees=None,
                  leg_start=False):
        """(état des tickets après réconciliation, sortie).

        `branches` et `worktrees` acceptent un dictionnaire — ce que la sonde a
        trouvé — ou une fonction, pour jouer une sonde muette. `leg_start` joue
        le démarrage d'une étape de reprise automatique.
        """
        def sonde(valeur):
            return ({"side_effect": valeur} if callable(valeur)
                    else {"return_value": valeur or {}})

        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal)
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "gh_json",
                                   side_effect=[(list(issues), None),
                                                (list(prs), None)]), \
                 mock.patch.object(run_mod, "remote_branches", **sonde(branches)), \
                 mock.patch.object(run_mod, "live_worktrees", **sonde(worktrees)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_reconcile(argparse.Namespace(run="r1",
                                                         leg_start=leg_start))
                run = run_mod.load_run("r1")
                tickets = run_mod.replay(run, run_mod.read_journal("r1"),
                                         run_mod.load_control("r1"))
            return tickets, output.getvalue()

    RUNNING = {"ts": "2026-08-25T07:26:00+00:00", "kind": "ticket", "ticket": 19,
               "phase": "implementation", "status": "running",
               "message": "plan pose, implementation en cours"}

    def test_un_running_sans_aucune_trace_revient_pending(self):
        """Critère 1 — c'est le déblocage que le ticket demande."""
        tickets, output = self.reconcile([self.RUNNING])
        self.assertEqual(tickets[19]["status"], "pending")
        self.assertIn("jamais démarré", output)

    def test_un_running_avec_branche_poussee_ne_recule_pas(self):
        """Le travail est là, poussé : le requeuer le referait de zéro."""
        tickets, _ = self.reconcile(
            [self.RUNNING], branches={19: "feature/19-truc"})
        self.assertEqual(tickets[19]["status"], "running")

    def test_un_running_avec_worktree_vivant_ne_recule_pas(self):
        """#130 — le worktree dit qu'un agent tient le ticket, avant tout push."""
        tickets, _ = self.reconcile(
            [self.RUNNING],
            worktrees={19: {"path": "/w/agent-aaa", "branch": "feature/19-truc",
                            "locked": True}})
        self.assertEqual(tickets[19]["status"], "running")

    def test_ci_green_avec_pr_ouverte_ne_recule_pas(self):
        """Critère 2 — GitHub ne connaît pas `ci_green` : le ramener à `pr_open`
        referait la CI et la revue à chaque reprise."""
        journal = [self.RUNNING,
                   {"ts": "2026-08-25T08:00:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "ci", "status": "ci_green",
                    "pr": 77, "message": "12 checks au vert"}]
        tickets, _ = self.reconcile(
            journal, prs=[{"number": 77, "state": "OPEN", "body": "Closes #19",
                           "headRefName": "feature/19-truc"}])
        self.assertEqual(tickets[19]["status"], "ci_green")

    def test_reviewed_avec_pr_ouverte_ne_recule_pas(self):
        journal = [{"ts": "2026-08-25T08:10:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "revue", "status": "reviewed",
                    "pr": 77, "message": "revue publiee"}]
        tickets, _ = self.reconcile(
            journal, prs=[{"number": 77, "state": "OPEN", "body": "Closes #19",
                           "headRefName": "feature/19-truc"}])
        self.assertEqual(tickets[19]["status"], "reviewed")

    def test_une_sonde_muette_ne_vaut_pas_une_absence_de_trace(self):
        """`git ls-remote` hors réseau rend le même dictionnaire vide qu'un
        ticket jamais démarré. Requeuer là-dessus relancerait un agent sur un
        ticket déjà poussé : tant qu'une sonde n'a pas répondu, le garde-fou
        d'avant #134 tient."""
        def muette():
            run_mod.PROBE_FAILURES.append("git ls-remote : Could not resolve host")
            return {}

        tickets, output = self.reconcile([self.RUNNING], branches=muette)
        self.assertEqual(tickets[19]["status"], "running")

    def test_une_pr_mergee_emporte_le_running(self):
        """Le sens inverse continue de jouer : le dépôt fait foi."""
        tickets, _ = self.reconcile(
            [self.RUNNING],
            prs=[{"number": 77, "state": "MERGED", "body": "Closes #19",
                  "headRefName": "feature/19-truc"}])
        self.assertEqual(tickets[19]["status"], "merged")


class RetryDebloqueUnRunning(unittest.TestCase):
    """Critère 3 — `retry N` doit mordre sur un ticket figé, pas seulement sur
    un ticket tombé. C'est le rattrapage humain quand le dépôt ne tranche pas."""

    def replay_apres_retry(self, statut_initial):
        journal = [
            {"ts": "2026-08-25T07:26:00+00:00", "kind": "ticket", "ticket": 19,
             "phase": "implementation", "status": statut_initial,
             "message": "agent parti"},
            # Ce que le shell écrit sur `retry 19` : seul `reset` fait reculer
            # un statut, et il ne regarde pas lequel.
            {"ts": "2026-08-25T09:00:00+00:00", "kind": "ticket", "ticket": 19,
             "status": "pending", "reset": True, "actor": "humain",
             "message": "remis en file à la main"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal, control={"signal": "run",
                                                     "retry": [19]})
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                run = run_mod.load_run("r1")
                return run_mod.replay(run, run_mod.read_journal("r1"),
                                      run_mod.load_control("r1"))

    def test_retry_deloge_un_running(self):
        self.assertEqual(self.replay_apres_retry("running")[19]["status"], "pending")

    def test_retry_deloge_aussi_un_blocked(self):
        self.assertEqual(self.replay_apres_retry("blocked")[19]["status"], "pending")

    def test_le_gate_n_annonce_plus_un_retry_honore(self):
        """La demande est consommée dès que le ticket est reparti : continuer de
        l'annoncer ferait relancer un ticket déjà traité à chaque vague."""
        journal = [{"ts": "2026-08-25T09:00:00+00:00", "kind": "ticket",
                    "ticket": 19, "status": "pending", "reset": True,
                    "actor": "humain", "message": "remis en file"},
                   {"ts": "2026-08-25T10:00:00+00:00", "kind": "ticket",
                    "ticket": 20, "phase": "merge", "status": "merged",
                    "message": "mergée"}]
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal,
                      control={"signal": "run", "retry": [19, 20]})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertNotIn("reprendre #19", output.getvalue())
        self.assertNotIn("reprendre #20", output.getvalue())

    def test_le_gate_n_annonce_plus_un_retry_deja_relance(self):
        """Le pire cas : la demande a été honorée, un agent tient le ticket. La
        réannoncer ferait lancer un second agent sur la même empreinte (#130) —
        `control["retry"]` n'étant jamais purgé, elle vaudrait pour tout le run."""
        journal = [{"ts": "2026-08-25T09:00:00+00:00", "kind": "ticket",
                    "ticket": 19, "status": "pending", "reset": True,
                    "actor": "humain", "message": "remis en file"},
                   {"ts": "2026-08-25T09:05:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "implementation", "status": "running",
                    "message": "second agent au travail"}]
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal,
                      control={"signal": "run", "retry": [19]})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertNotIn("reprendre #19", output.getvalue())

    def test_le_gate_annonce_un_retry_en_attente(self):
        journal = [{"ts": "2026-08-25T07:26:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "validation", "status": "failed",
                    "message": "verify rouge"}]
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal,
                      control={"signal": "run", "retry": [19]})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertIn("reprendre #19", output.getvalue())


class AgentMortAvecSonEtape(unittest.TestCase):
    """#180 — la nuit du 25 août : 3 étapes, 20,80 $, 0 ticket abouti.

    L'orchestrateur lançait ses agents en arrière-plan puis terminait son tour ;
    `claude -p` sortait et les tuait en phase `prise-en-charge`. Les tickets
    restaient `running` avec leur worktree, `reconcile` y voyait un agent au
    travail — c'était la protection de #130 — et le `gate` annonçait « 0 ticket
    à lancer ». Deux étapes entières n'ont donc eu personne à lancer.

    La distinction qui manquait : **au démarrage d'une étape, aucun agent de
    l'étape précédente n'a survécu**. Un `running` y est un abandon, et le
    worktree n'est pas une revendication mais un travail à reprendre.
    """

    RUNNING = {"ts": "2026-08-25T20:14:00+00:00", "kind": "ticket", "ticket": 19,
               "phase": "prise-en-charge", "status": "running",
               "message": "carte en In progress, empreinte annoncee"}
    WORKTREE = {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                     "locked": True}}

    def reconcile(self, **kwargs):
        return ReconcileRunningAbandonne.reconcile(self, **kwargs)

    def test_au_demarrage_d_etape_un_running_abandonne_repart(self):
        tickets, output = self.reconcile(journal=[self.RUNNING],
                                         worktrees=self.WORKTREE, leg_start=True)
        self.assertEqual(tickets[19]["status"], "pending")
        self.assertIn("/w/agent-a9e8", output)

    def test_hors_demarrage_d_etape_le_worktree_reste_une_revendication(self):
        """La protection de #130 doit continuer de tenir : hors étape, un
        worktree vivant veut dire qu'un agent travaille."""
        tickets, _ = self.reconcile(journal=[self.RUNNING],
                                    worktrees=self.WORKTREE, leg_start=False)
        self.assertEqual(tickets[19]["status"], "running")

    def test_une_sonde_muette_suspend_le_requeue_meme_au_demarrage(self):
        """Sans certitude sur l'état local, on ne fait reculer personne — sinon
        un `git worktree list` en erreur relancerait toute la vague."""
        def muette():
            return run_mod.note_probe_failure("git worktree list : en erreur")

        tickets, _ = self.reconcile(journal=[self.RUNNING], worktrees=muette,
                                    leg_start=True)
        self.assertEqual(tickets[19]["status"], "running")

    def test_une_pr_ouverte_prime_sur_le_requeue(self):
        """Un ticket arrivé en PR n'est pas à relancer : il attend la CI."""
        journal = [self.RUNNING,
                   {"ts": "2026-08-25T20:20:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "pr", "status": "pr_open", "pr": 88,
                    "message": "PR ouverte"}]
        tickets, _ = self.reconcile(
            journal=journal, worktrees=self.WORKTREE, leg_start=True,
            prs=[{"number": 88, "state": "OPEN", "body": "Closes #19",
                  "headRefName": "feature/19-truc"}])
        self.assertEqual(tickets[19]["status"], "pr_open")

    def test_un_ticket_tombe_n_est_pas_relance_d_office(self):
        """Seul un `running` est un abandon. Un ticket `failed` a été jugé : le
        requeuer viderait la pause sur erreur de son objet — le `gate` ne retient
        que ce qui est tombé, et un ticket qui échoue à chaque étape repartirait
        indéfiniment sans que personne soit consulté."""
        journal = [self.RUNNING,
                   {"ts": "2026-08-25T20:40:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "validation", "status": "failed",
                    "message": "tests rouges"}]
        tickets, _ = self.reconcile(journal=journal, worktrees=self.WORKTREE,
                                    leg_start=True)
        self.assertEqual(tickets[19]["status"], "failed")


class DemarrageEtape(unittest.TestCase):
    """`leg_start()` lit le signal du superviseur — « 0 », « false », « no »
    désarment, comme partout ailleurs dans le dépôt."""

    def lit(self, value, name="SPA_LEG_START"):
        env = {} if value is None else {name: value}
        with mock.patch.dict(run_mod.os.environ, env, clear=True):
            return run_mod.leg_start()

    def test_le_repli_sur_spa_unattended(self):
        """Une étape armée sans `SPA_LEG_START` reste reconnue."""
        self.assertTrue(self.lit("1", name="SPA_UNATTENDED"))

    def test_spa_unattended_absente_ne_desarme_pas_le_signal_propre(self):
        """`--no-merge` ne pose pas `SPA_UNATTENDED` : le requeue doit tenir
        quand même, sans quoi le mode recommandé pour un jalon sensible
        retrouverait la vague figée de #180."""
        self.assertTrue(self.lit("1"))

    def test_posee_a_1_c_est_un_demarrage_d_etape(self):
        self.assertTrue(self.lit("1"))

    def test_absente_c_est_une_session_humaine(self):
        self.assertFalse(self.lit(None))

    def test_desarmee_explicitement(self):
        for value in ("0", "false", "no", ""):
            with self.subTest(valeur=value):
                self.assertFalse(self.lit(value))


class FrontiereEtapeLueDansLeJournal(unittest.TestCase):
    """#233 — le verdict qui gèle une vague ne se tire plus au sort.

    Le 26 août, trois `reconcile` en 65 secondes ont rendu trois verdicts
    contraires sur les mêmes tickets (#25, #29, #168), sans que rien ne change
    sur le disque : `pending`, puis `running`, puis `pending`. La bascule venait
    de `SPA_LEG_START`, que seuls certains appels portaient. Et le dernier
    verdict avant le `gate` décide de tout, puisque `gate` ne compose sa liste
    `ready` que de tickets `pending` : sur « running », l'étape lancée à
    13:01:30 UTC a annoncé « 0 ticket(s) à lancer : aucun » et n'a lancé
    personne.

    La frontière d'étape se lit désormais dans le journal — le dernier
    `leg_started`, que le superviseur écrit avant chaque `claude -p` — et se
    compare au battement de chaque ticket, c'est-à-dire à son dernier événement
    hors de ceux que `reconcile` écrit lui-même. Deux nombres sur disque, que
    tout appel lit pareil.
    """

    LEG = {"ts": "2026-08-26T13:01:30+00:00", "kind": "run",
           "status": "leg_started", "actor": "superviseur",
           "message": "étape 3 — une vague, largeur 3"}
    # Le battement d'avant la frontière : l'agent qui l'a écrit est mort avec le
    # `claude -p` de son étape.
    AVANT = {"ts": "2026-08-26T11:30:35+00:00", "kind": "ticket", "ticket": 19,
             "phase": "implementation", "status": "running",
             "message": "plan pose, implementation en cours"}
    # Celui d'après : un agent vivant tient le ticket.
    APRES = {"ts": "2026-08-26T13:09:05+00:00", "kind": "ticket", "ticket": 19,
             "phase": "implementation", "status": "running",
             "message": "reprise apres coupure de quota"}
    WORKTREE = {19: {"path": "/w/agent-a40c", "branch": "feature/19-truc",
                     "locked": True}}

    def rejoue(self, journal, envs, worktrees=None, branches=None):
        """Les verdicts successifs de N `reconcile` sur le **même** run.

        Rejouer sur le même dossier est la seule façon de voir une oscillation :
        chaque tour relit ce que le précédent a écrit. `envs` donne
        l'environnement de chaque appel — c'est là que se jouait le tirage au
        sort.
        """
        verdicts = []
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal)
            reponses = [([], None)] * (2 * len(envs))   # issues puis PR, par tour
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "gh_json", side_effect=reponses), \
                 mock.patch.object(run_mod, "remote_branches",
                                   return_value=branches or {}), \
                 mock.patch.object(run_mod, "live_worktrees",
                                   return_value=worktrees or {}), \
                 contextlib.redirect_stdout(io.StringIO()):
                for env in envs:
                    with mock.patch.dict(run_mod.os.environ, env, clear=True):
                        run_mod.cmd_reconcile(argparse.Namespace(run="r1"))
                    tickets = run_mod.replay(run_mod.load_run("r1"),
                                             run_mod.read_journal("r1"),
                                             run_mod.load_control("r1"))
                    verdicts.append(tickets[19]["status"])
        return verdicts

    def test_deux_reconcile_de_suite_rendent_le_meme_verdict(self):
        """Critère 1 — sans rien changer au dépôt entre les deux."""
        self.assertEqual(
            self.rejoue([self.LEG, self.AVANT], [{}, {}],
                        worktrees=self.WORKTREE),
            ["pending", "pending"])

    def test_le_requeue_n_est_pas_son_propre_battement(self):
        """Le cœur de l'oscillation : `reconcile` requeue le ticket, puis relit
        sa propre écriture comme la preuve qu'un agent travaillait, et le
        rebascule. Trois tours suffisent à le voir."""
        self.assertEqual(
            self.rejoue([self.LEG, self.AVANT], [{}, {}, {}],
                        worktrees=self.WORKTREE),
            ["pending", "pending", "pending"])

    def test_le_verdict_ne_depend_pas_de_l_environnement_de_l_appel(self):
        """Critère 2 — la séquence exacte du 26 août : superviseur, puis appel
        sans la variable, puis superviseur. Elle rendait pending/running/pending
        et gelait la vague ; elle rend maintenant trois fois le même verdict."""
        self.assertEqual(
            self.rejoue([self.LEG, self.AVANT],
                        [{"SPA_LEG_START": "1"}, {}, {"SPA_LEG_START": "1"}],
                        worktrees=self.WORKTREE),
            ["pending", "pending", "pending"])

    def test_un_agent_qui_journalise_apres_l_etape_garde_son_worktree(self):
        """Critère 3 — la protection de #130 tient, et elle tient même quand
        l'appelant se dit en démarrage d'étape : c'est le journal qui tranche,
        et il montre un agent au travail depuis l'ouverture de l'étape."""
        self.assertEqual(
            self.rejoue([self.AVANT, self.LEG, self.APRES],
                        [{}, {"SPA_LEG_START": "1"}], worktrees=self.WORKTREE),
            ["running", "running"])

    def test_une_branche_poussee_ne_couvre_pas_un_agent_mort(self):
        """Un agent mort après son push laissait un `running` que rien ne
        rattrapait : la branche primait sur le worktree, et le `gate` ne lançait
        toujours personne. Le worktree porte la branche, l'agent relancé la
        retrouve."""
        verdicts = self.rejoue([self.LEG, self.AVANT], [{}, {}],
                               worktrees=self.WORKTREE,
                               branches={19: "feature/19-truc"})
        self.assertEqual(verdicts, ["pending", "pending"])

    def test_sans_worktree_une_branche_poussee_reste_intouchee(self):
        """Sans worktree où reprendre, requeuer ferait repartir un agent d'une
        branche neuve et abandonnerait ce qui est déjà sur le distant."""
        self.assertEqual(
            self.rejoue([self.LEG, self.AVANT], [{}, {}],
                        branches={19: "feature/19-truc"}),
            ["running", "running"])


class FrontiereEtEmpreinteDuJournal(unittest.TestCase):
    """Les trois lectures qui remplacent `SPA_LEG_START`, prises isolément."""

    def test_la_frontiere_est_le_dernier_leg_started(self):
        events = [{"ts": "2026-08-26T09:00:00+00:00", "kind": "run",
                   "status": "leg_started"},
                  {"ts": "2026-08-26T10:00:00+00:00", "kind": "run",
                   "status": "leg_ended"},
                  {"ts": "2026-08-26T13:01:30+00:00", "kind": "run",
                   "status": "leg_started"}]
        self.assertEqual(run_mod.leg_frontier(events),
                         "2026-08-26T13:01:30+00:00")

    def test_un_journal_sans_etape_n_a_pas_de_frontiere(self):
        self.assertIsNone(run_mod.leg_frontier(
            [{"ts": "2026-08-26T09:00:00+00:00", "kind": "ticket", "ticket": 19,
              "status": "running"}]))

    def test_un_evenement_de_ticket_ne_deplace_pas_la_frontiere(self):
        """`leg_started` est un statut de run. Un événement de ticket qui le
        porterait — journal repris à la main, ligne recopiée — ne doit pas
        déplacer la borne de tout le monde."""
        self.assertIsNone(run_mod.leg_frontier(
            [{"ts": "2026-08-26T09:00:00+00:00", "kind": "ticket", "ticket": 19,
              "status": "leg_started"}]))

    def test_reconcile_n_ecrit_pas_de_battement(self):
        events = [{"ts": "2026-08-26T11:30:00+00:00", "kind": "ticket",
                   "ticket": 19, "status": "running", "actor": "agent"},
                  {"ts": "2026-08-26T13:02:38+00:00", "kind": "ticket",
                   "ticket": 19, "status": "pending", "reset": True,
                   "actor": "reconcile", "message": "agent mort avec son étape"}]
        self.assertEqual(run_mod.ticket_heartbeats(events),
                         {19: "2026-08-26T11:30:00+00:00"})

    def test_deux_lignes_a_l_envers_gardent_le_battement_le_plus_tardif(self):
        """Le journal est en ajout seul et une dizaine de processus y écrivent à
        la fois : chacun date sa ligne avant d'obtenir le fichier, si bien que
        deux événements d'un même ticket peuvent atterrir à l'envers. Retenir la
        dernière ligne écrite rendrait un battement périmé — et un agent vivant
        passerait pour mort, ce qui lancerait un second agent sur son worktree."""
        events = [{"ts": "2026-08-26T13:09:05+00:00", "kind": "ticket",
                   "ticket": 19, "status": "running", "actor": "agent"},
                  {"ts": "2026-08-26T13:01:31+00:00", "kind": "ticket",
                   "ticket": 19, "status": "running", "actor": "orchestrateur"}]
        self.assertEqual(run_mod.ticket_heartbeats(events),
                         {19: "2026-08-26T13:09:05+00:00"})
        self.assertFalse(run_mod.orphaned(
            19, "2026-08-26T13:01:30+00:00", run_mod.ticket_heartbeats(events)))

    def test_la_frontiere_est_l_etape_la_plus_tardive(self):
        """Même désordre d'écriture, même règle : la borne est le `leg_started`
        le plus tardif, pas le dernier posé dans le fichier."""
        events = [{"ts": "2026-08-26T13:01:30+00:00", "kind": "run",
                   "status": "leg_started"},
                  {"ts": "2026-08-26T09:00:00+00:00", "kind": "run",
                   "status": "leg_started"}]
        self.assertEqual(run_mod.leg_frontier(events),
                         "2026-08-26T13:01:30+00:00")

    def test_l_orchestrateur_et_l_arbitre_battent_comme_un_agent(self):
        """Eux non plus ne journalisent qu'en agissant : leur écriture atteste
        que quelque chose s'est passé sur ce ticket dans l'étape en cours."""
        for actor in ("agent", "orchestrateur", "arbitre", "humain", None):
            with self.subTest(acteur=actor):
                event = {"ts": "2026-08-26T13:05:00+00:00", "kind": "ticket",
                         "ticket": 19, "message": "…"}
                if actor:
                    event["actor"] = actor
                self.assertIn(19, run_mod.ticket_heartbeats([event]))

    def test_un_ticket_muet_depuis_l_ouverture_est_abandonne(self):
        beats = {19: "2026-08-26T11:30:00+00:00"}
        self.assertTrue(run_mod.orphaned(19, "2026-08-26T13:01:30+00:00", beats))

    def test_un_ticket_sans_le_moindre_battement_est_abandonne(self):
        self.assertTrue(run_mod.orphaned(19, "2026-08-26T13:01:30+00:00", {}))

    def test_un_ticket_qui_bat_depuis_l_ouverture_ne_l_est_pas(self):
        beats = {19: "2026-08-26T13:09:05+00:00"}
        self.assertFalse(run_mod.orphaned(19, "2026-08-26T13:01:30+00:00", beats))

    def test_sans_frontiere_on_retombe_sur_le_repli(self):
        """Un run mené à la main n'a pas de `leg_started` : le journal ne dit
        rien, et l'environnement redevient le seul indice — c'est le seul cas où
        il est encore consulté."""
        self.assertTrue(run_mod.orphaned(19, None, {}, fallback=True))
        self.assertFalse(run_mod.orphaned(19, None, {}, fallback=False))

    def test_deux_decalages_horaires_se_comparent_sur_l_instant(self):
        """Comparer les chaînes classerait « 14:00+02:00 » (midi UTC) après
        « 13:00+00:00 », et un ticket vivant passerait pour abandonné."""
        self.assertTrue(run_mod.iso_before("2026-08-26T14:00:00+02:00",
                                           "2026-08-26T13:00:00+00:00"))
        self.assertFalse(run_mod.iso_before("2026-08-26T13:00:00+00:00",
                                            "2026-08-26T14:00:00+02:00"))

    def test_un_horodatage_illisible_ne_fait_pas_planter(self):
        """Le journal est en ajout seul et peut porter une ligne abîmée : elle
        ne doit pas emporter la réconciliation de tout le run."""
        self.assertFalse(run_mod.iso_before("pas une date",
                                            "2026-08-26T13:00:00+00:00"))


class ContexteDeReprise(unittest.TestCase):
    """Ce que le `gate` doit dire à l'orchestrateur pour qu'il n'ouvre pas un
    worktree vierge sur un ticket qui en a déjà un — et n'efface pas l'ancien."""

    def test_le_gate_annonce_ou_reprendre(self):
        worktrees = {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                          "locked": True}}
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees",
                                   return_value=worktrees), \
                 mock.patch.object(run_mod, "git_lines",
                                   side_effect=[["4ae5aed wip(19)"],
                                                [" M apps/api/src/x.ts"]]), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        rendu = output.getvalue()
        self.assertIn("À REPRENDRE", rendu)
        self.assertIn("/w/agent-a9e8", rendu)
        self.assertIn("1 commit(s)", rendu)
        self.assertIn("EnterWorktree", rendu)

    def test_un_ticket_sans_worktree_n_a_rien_a_reprendre(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees", return_value={}), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertNotIn("À REPRENDRE", output.getvalue())


class DecisionsSansClavier(unittest.TestCase):
    """`skip`, `retry` et `note` ne vivaient que dans le `shell` interactif.

    C'était tenable tant que seul un humain écartait un ticket. L'arbitre, lui,
    tourne dans un `claude -p` où il n'y a aucune invite à qui parler : une
    décision qu'on ne peut poser qu'au clavier est une décision que la reprise
    automatique ne peut pas prendre — c'est-à-dire le run qui s'arrête, la panne
    même que l'arbitrage existe pour lever.
    """

    def run_command(self, command, tmp, **fields):
        write_run(tmp, control={"signal": "run"})
        output = io.StringIO()
        namespace = argparse.Namespace(run="r1", actor="arbitre", **fields)
        with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
             mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
             contextlib.redirect_stdout(output):
            command(namespace)
        control = json.loads((Path(tmp) / "r1" / "control.json").read_text(
            encoding="utf-8"))
        events = [json.loads(line) for line in
                  (Path(tmp) / "r1" / "journal.ndjson").read_text(
                      encoding="utf-8").splitlines() if line.strip()]
        return control, events, output.getvalue()

    def test_ecarter_un_ticket_l_inscrit_dans_le_controle(self):
        with tempfile.TemporaryDirectory() as tmp:
            control, events, _ = self.run_command(
                run_mod.cmd_skip, tmp, ticket="21", reason="dépendance non tenue")
        self.assertEqual(control["skip"]["21"], "dépendance non tenue")
        self.assertEqual(events[-1]["status"], "skipped")
        self.assertEqual(events[-1]["actor"], "arbitre")

    def test_relancer_un_ticket_le_remet_en_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            control, events, _ = self.run_command(
                run_mod.cmd_retry, tmp, ticket="21", message="quota, worktree intact")
        self.assertEqual(control["retry"], [21])
        self.assertEqual(events[-1]["status"], "pending")
        self.assertTrue(events[-1]["reset"])

    def test_relancer_leve_un_ecartement_precedent(self):
        """Sans cela, un ticket écarté puis relancé resterait `skipped` au
        prochain `replay`, et la relance serait sans effet."""
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run", "skip": {"21": "à revoir"}})
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 contextlib.redirect_stdout(io.StringIO()):
                run_mod.cmd_retry(argparse.Namespace(
                    run="r1", ticket="21", message=None, actor="arbitre"))
            control = json.loads((Path(tmp) / "r1" / "control.json").read_text(
                encoding="utf-8"))
        self.assertNotIn("21", control["skip"])

    def test_annoter_ne_touche_pas_a_l_etat(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, events, _ = self.run_command(
                run_mod.cmd_note, tmp, ticket="21", message="empreinte élargie")
        self.assertIsNone(events[-1].get("status"))
        self.assertEqual(events[-1]["message"], "empreinte élargie")

    def test_un_numero_abime_ne_touche_a_rien(self):
        """`control.json` est relu par `replay` à chaque appel : un jeton non
        numérique y ferait planter status, gate, watch et resume."""
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    run_mod.cmd_skip(argparse.Namespace(
                        run="r1", ticket="vingt-et-un", reason="", actor="arbitre"))
            control = json.loads((Path(tmp) / "r1" / "control.json").read_text(
                encoding="utf-8"))
        self.assertEqual(control.get("skip", {}), {})


class LigneDArbitrage(unittest.TestCase):
    """Une décision prise à la place de quelqu'un doit se lire là où il regarde.
    La laisser dans un fichier qu'il faut savoir ouvrir revient à la cacher."""

    def line(self, entries):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "r1").mkdir()
            if entries is not None:
                (Path(tmp) / "r1" / "arbitrations.ndjson").write_text(
                    "".join(json.dumps(entry) + "\n" for entry in entries),
                    encoding="utf-8")
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                return run_mod.arbitration_line("r1")

    def test_aucun_arbitrage_n_affiche_rien(self):
        self.assertIsNone(self.line(None))

    def test_le_compte_et_la_derniere_decision(self):
        found = self.line([{"ticket": 19, "motif": "gate_pause", "rung": "retry"},
                           {"ticket": 21, "motif": "tickets_tombes", "rung": "skip"}])
        self.assertIn("2 arbitrage(s)", found)
        self.assertIn("#21", found)
        self.assertIn("skip", found)

    def test_une_decision_de_run_n_a_pas_de_ticket(self):
        found = self.line([{"motif": "fin_de_run", "message": "3 issues ouvertes"}])
        self.assertIn("run", found)

    def test_un_fichier_abime_ne_fait_pas_planter_le_tableau_de_bord(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "r1").mkdir()
            (Path(tmp) / "r1" / "arbitrations.ndjson").write_text(
                "pas du json\n", encoding="utf-8")
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                self.assertIsNone(run_mod.arbitration_line("r1"))


class DeuxRunsUnJalon(unittest.TestCase):
    """Produit et outillage cohabitent sur un même jalon sans se confondre.

    Le risque tient en une phrase : `start --nature outillage` qui « reprend »
    le run produit inachevé du même jalon enchaînerait sur un plan qui n'est pas
    le sien — quinze tickets d'outillage remplacés par les tickets produit en
    vol, agents compris. La nature filtre donc autant que le jalon.
    """

    def run_dir(self, tmp, name, milestone, nature=None):
        directory = Path(tmp) / name
        directory.mkdir()
        payload = {"id": name, "milestone": milestone, "width": 1,
                   "plan": {"waves": [{"index": 1, "issues": []}]}}
        if nature is not None:
            payload["nature"] = nature
        (directory / "run.json").write_text(json.dumps(payload), encoding="utf-8")
        return directory

    def unfinished(self, runs, milestone, nature="projet"):
        """`unfinished_run` sur un disque fabriqué — tous les runs inachevés."""
        with tempfile.TemporaryDirectory() as tmp:
            dirs = [self.run_dir(tmp, *entry) for entry in runs]
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "run_dirs", return_value=dirs), \
                 mock.patch.object(run_mod, "read_journal", return_value=[]), \
                 mock.patch.object(run_mod, "load_control", return_value={}), \
                 mock.patch.object(run_mod, "replay", return_value={}), \
                 mock.patch.object(run_mod, "wave_state",
                                   return_value=({"index": 1}, [{"index": 1}])):
                return run_mod.unfinished_run(milestone, nature)

    def test_un_run_produit_n_est_pas_repris_par_un_run_d_outillage(self):
        found = self.unfinished([("s1-produit", "S1 — Fondations", "projet")],
                                "S1", "outillage")
        self.assertIsNone(found)

    def test_un_run_d_outillage_se_reprend_de_lui_meme(self):
        found = self.unfinished(
            [("s1-outillage", "S1 — Fondations", "outillage")], "S1", "outillage")
        self.assertEqual(found, "s1-outillage")

    def test_le_run_produit_du_meme_jalon_reste_reprenable(self):
        """Les deux files avancent en parallèle : ouvrir l'outillage ne doit pas
        rendre le run produit irrattrapable."""
        runs = [("s1-outillage", "S1 — Fondations", "outillage"),
                ("s1-produit", "S1 — Fondations", "projet")]
        self.assertEqual(self.unfinished(runs, "S1", "projet"), "s1-produit")
        self.assertEqual(self.unfinished(runs, "S1", "outillage"), "s1-outillage")

    def test_un_run_ouvert_avant_la_nature_compte_pour_du_produit(self):
        """Rétrocompatibilité : un `run.json` sans champ `nature` vient d'un
        dispositif qui ne savait dérouler que le produit. Le tenir pour tel est
        la seule lecture qui ne perd pas un run en cours à la mise à jour."""
        self.assertEqual(run_mod.run_nature({"id": "vieux"}), "projet")
        found = self.unfinished([("s1-vieux", "S1 — Fondations", None)], "S1")
        self.assertEqual(found, "s1-vieux")


class LargeurParNature(unittest.TestCase):
    """Le séquentiel de l'outillage est un défaut partagé, pas deux constantes.

    `milestone_run` emprunte le registre au plan plutôt que d'en tenir une copie :
    une seconde table finirait par diverger de ce que le plan filtre vraiment, et
    le run ouvrirait des vagues d'une largeur que le plan ne calcule pas.
    """

    def test_le_registre_est_bien_celui_du_plan(self):
        import milestone_plan
        self.assertIs(run_mod.DEFAULT_WIDTH, milestone_plan.DEFAULT_WIDTH)
        self.assertIs(run_mod.NATURES, milestone_plan.NATURES)

    def test_l_outillage_est_sequentiel_et_le_produit_ne_l_est_pas(self):
        self.assertEqual(run_mod.DEFAULT_WIDTH["outillage"], 1)
        self.assertEqual(run_mod.DEFAULT_WIDTH["toutes"], 1)
        self.assertEqual(run_mod.DEFAULT_WIDTH["projet"], 3)

    def test_chaque_nature_a_une_largeur(self):
        self.assertEqual(set(run_mod.NATURES), set(run_mod.DEFAULT_WIDTH))


class EtapeDOrchestration(unittest.TestCase):
    """`step` — les huit à vingt-cinq minutes que le journal ne portait pas.

    Entre deux vagues, seul l'orchestrateur travaille, et lui ne journalisait
    rien : `npm run verify` sur `develop`, puis la lecture des issues et la revue
    du plan. Un run mort s'y lisait comme un run au travail (#186).

    Ce qui est vérifié ici est ce sur quoi tout le reste repose : que la ligne de
    **fin** existe toujours, quelle que soit la façon dont la commande encadrée
    se termine, et que le code de sortie de cette commande traverse `step` sans
    être avalé — sans quoi une barrière encadrée cesserait d'être une barrière.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "r1").mkdir()

    def step(self, label, command=(), ouvert=True, **fields):
        args = argparse.Namespace(label=label, eta=None, run=None, ticket=None,
                                  wave=None, phase="orchestration",
                                  actor="orchestrateur", exec=list(command))
        for name, value in fields.items():
            setattr(args, name, value)
        with mock.patch.object(run_mod, "RUNS_DIR", self.root), \
             mock.patch.object(run_mod, "LATEST_LOG", self.root / "latest.log"), \
             mock.patch.object(run_mod, "resolve",
                               return_value="r1" if ouvert else None), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            code = run_mod.cmd_step(args)
        path = self.root / "r1" / "journal.ndjson"
        events = [json.loads(line) for line
                  in path.read_text(encoding="utf-8").splitlines() if line.strip()] \
            if path.exists() else []
        return code, events

    def test_une_etape_sans_commande_pose_une_seule_ligne(self):
        code, events = self.step("lecture des issues des vagues 1 a 3", eta=10)
        self.assertEqual(code, run_mod.GO)
        self.assertEqual(len(events), 1)
        self.assertIn("lecture des issues", events[0]["message"])
        self.assertIn("~10 min attendues", events[0]["message"])
        self.assertEqual(events[0]["kind"], "run")
        self.assertEqual(events[0]["actor"], "orchestrateur")
        self.assertEqual(events[0]["phase"], "orchestration")

    def test_une_commande_encadree_pose_l_ouverture_et_la_fermeture(self):
        code, events = self.step("verify de develop",
                                 [sys.executable, "-c", "pass"])
        self.assertEqual(code, 0)
        self.assertEqual(len(events), 2)
        self.assertIn("en cours", events[0]["message"])
        self.assertIn("terminé en", events[1]["message"])

    def test_un_echec_est_journalise_en_erreur_et_son_code_traverse(self):
        """La ligne de fin existe aussi quand la commande tombe — et le code de
        sortie n'est pas avalé : `step` encadre une barrière sans la relâcher."""
        code, events = self.step("verify de develop",
                                 [sys.executable, "-c", "raise SystemExit(2)"])
        self.assertEqual(code, 2)
        self.assertEqual(events[1]["level"], "ERROR")
        self.assertIn("(code 2)", events[1]["message"])

    def test_une_interruption_ferme_quand_meme_la_ligne(self):
        """Sans reprise du Ctrl-C, `main()` l'attrape et sort en `GO` : la ligne
        d'ouverture resterait seule — le silence même que #186 corrige — et une
        barrière abandonnée se lirait comme une barrière franchie."""
        with mock.patch.object(run_mod.subprocess, "run",
                               side_effect=KeyboardInterrupt):
            code, events = self.step("verify de develop", ["npm", "run", "verify"])
        self.assertEqual(code, 130)
        self.assertEqual(events[1]["level"], "ERROR")
        self.assertIn("interrompu", events[1]["message"])

    def test_une_commande_introuvable_ne_leve_pas(self):
        code, events = self.step("étape impossible", ["binaire-qui-nexiste-pas"])
        self.assertEqual(code, 127)
        self.assertEqual(events[1]["level"], "ERROR")
        self.assertIn("non lançable", events[1]["message"])

    def test_hors_run_la_commande_est_lancee_quand_meme(self):
        """`/milestone` déroulé à la main n'a pas de journal où écrire. Ce n'est
        pas une raison pour ne pas lancer la commande : `step` reste transparent."""
        code, events = self.step("verify de develop",
                                 [sys.executable, "-c", "raise SystemExit(3)"],
                                 ouvert=False)
        self.assertEqual(code, 3)
        self.assertEqual(events, [])


class CoupureDeLaCommandeEncadree(unittest.TestCase):
    """`step "…" --eta 8 -- npm run verify --silent` : ce qui est à `step` et ce
    qui est à la commande.

    `argparse.REMAINDER` avalerait `--eta` avec le reste — c'est pourquoi la
    coupe se fait sur le premier « -- » avant que le parseur ne travaille, et
    seulement pour ce sous-programme.
    """

    def coupe(self, argv):
        with mock.patch.object(sys, "argv", ["milestone_run.py", *argv]), \
             mock.patch.object(run_mod, "cmd_step") as step, \
             mock.patch.object(run_mod.Path, "mkdir"):
            run_mod.main()
        return step.call_args[0][0]

    def test_les_options_de_step_restent_a_step(self):
        args = self.coupe(["step", "verify", "--eta", "8", "--",
                           "npm", "run", "verify", "--silent"])
        self.assertEqual(args.label, "verify")
        self.assertEqual(args.eta, 8)
        self.assertEqual(args.exec, ["npm", "run", "verify", "--silent"])

    def test_sans_double_tiret_il_n_y_a_pas_de_commande(self):
        args = self.coupe(["step", "revue du plan", "--eta", "10"])
        self.assertEqual(args.exec, [])
        self.assertEqual(args.eta, 10)


class BattementMarque(unittest.TestCase):
    """`--beat` distingue une preuve de présence d'un travail journalisé.

    Le superviseur pose une ligne toutes les cinq minutes tant qu'une étape est
    en vol (#186). Sans marque, son propre battement rendrait le journal
    éternellement frais et son guetteur de silence ne couperait plus jamais une
    étape morte debout — on aurait remplacé un silence illisible par un silence
    invisible.
    """

    def event(self, **fields):
        base = dict(run=None, ticket=None, wave=None, phase=None, status=None,
                    message="battement", pr=None, branch=None, level=None,
                    actor="superviseur", quiet=True, reset=False, beat=False)
        base.update(fields)
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "resolve", return_value="r1"):
                (Path(tmp) / "r1").mkdir()
                run_mod.cmd_event(argparse.Namespace(**base))
                line = (Path(tmp) / "r1" / "journal.ndjson").read_text(
                    encoding="utf-8").strip()
        return json.loads(line)

    def test_un_battement_porte_sa_marque(self):
        self.assertTrue(self.event(beat=True).get("beat"))

    def test_un_evenement_ordinaire_ne_la_porte_pas(self):
        self.assertNotIn("beat", self.event())


if __name__ == "__main__":
    unittest.main()
