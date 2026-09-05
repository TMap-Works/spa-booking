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

import milestone_rules as rules_mod  # noqa: E402 — idem
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

    def parse(self, porcelain, returncode=0, claims=None):
        with mock.patch.object(run_mod.subprocess, "run",
                               return_value=completed(returncode, porcelain)):
            return run_mod.live_worktrees(claims)

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


ANONYME = """\
worktree /w/agent-4f21ab
HEAD df4ae3f00000000000000000000000000000000
branch refs/heads/worktree-agent-4f21ab
"""


class WorktreeAnonyme(unittest.TestCase):
    """#175 — le worktree qu'un agent de jalon reçoit ne se nomme pas.

    L'outil `Agent` l'appelle `agent-<aléa>` et pose dessus une branche
    `worktree-agent-<aléa>` : ni l'un ni l'autre ne porte de numéro d'issue,
    contrairement à ce que `EnterWorktree` produisait. Aucune règle de nom ne
    peut donc le rattacher à son ticket — seul le journal le peut, l'agent y
    ayant écrit d'où il parle dès sa première ligne.
    """

    def parse(self, porcelain, claims=None):
        return LiveWorktrees.parse(self, porcelain, claims=claims)

    def test_sans_revendication_il_reste_invisible(self):
        """L'état d'avant : c'est exactement le trou que le ticket décrit."""
        self.assertEqual(self.parse(ANONYME), {})

    def test_le_journal_le_rattache_a_son_ticket(self):
        found = self.parse(ANONYME, {run_mod.path_key("/w/agent-4f21ab"): 19})
        self.assertEqual(found[19]["branch"], "worktree-agent-4f21ab")
        self.assertEqual(found[19]["path"], "/w/agent-4f21ab")

    def test_le_nom_de_branche_prime_sur_la_revendication(self):
        """Une revendication vit dans un journal en ajout seul, et peut donc
        survivre au worktree qui l'a posée. Le nom de branche, lui, est ce que
        git montre à l'instant : il tranche."""
        found = self.parse(PORCELAIN,
                           {run_mod.path_key("D:/spyle/Spa & Booking/.claude/"
                                             "worktrees/agent-bbb"): 99})
        self.assertEqual(set(found), {18, 10})

    def test_une_head_detachee_revendiquee_reste_ignoree(self):
        """Ce qu'on rend sert à renvoyer un agent sur une branche : une HEAD
        détachée ne lui donnerait rien à reprendre."""
        detachee = ("worktree /w/agent-orphelin\n"
                    "HEAD 000\n"
                    "detached\n")
        self.assertEqual(
            self.parse(detachee, {run_mod.path_key("/w/agent-orphelin"): 19}), {})

    def test_les_separateurs_ne_font_pas_deux_worktrees(self):
        """`git worktree list` rend des « / » là où `Path` rend des « \\ » sous
        Windows : comparer les chaînes brutes ne rapprocherait jamais rien."""
        natif = os.path.join("w", "agent-4f21ab")
        self.assertEqual(run_mod.path_key(natif),
                         run_mod.path_key(natif.replace(os.sep, "/")))

    def test_un_chemin_illisible_ne_leve_pas(self):
        self.assertEqual(run_mod.path_key(None), "")


class RevendicationDeWorktree(unittest.TestCase):
    """Ce que le journal porte, et ce qu'on en relit — les deux moitiés de #175."""

    def claims(self, *events):
        return run_mod.worktree_claims(list(events))

    def ligne(self, ticket, ts, worktree=None):
        event = {"ts": ts, "kind": "ticket", "ticket": ticket,
                 "phase": "recevabilite", "message": "recevable"}
        if worktree:
            event["worktree"] = worktree
        return event

    def test_une_ligne_d_agent_revendique_son_worktree(self):
        found = self.claims(self.ligne(19, "2026-08-25T20:05:00+00:00",
                                       "/w/agent-4f21ab"))
        self.assertEqual(found, {run_mod.path_key("/w/agent-4f21ab"): 19})

    def test_une_ligne_sans_worktree_ne_revendique_rien(self):
        self.assertEqual(self.claims(self.ligne(19, "2026-08-25T20:05:00+00:00")), {})

    def test_une_ligne_de_run_ne_revendique_rien(self):
        """Seul un ticket possède un worktree ; l'orchestrateur, lui, travaille
        dans le dépôt principal."""
        self.assertEqual(self.claims({"ts": "2026-08-25T20:05:00+00:00",
                                      "kind": "run", "status": "leg_started",
                                      "worktree": "/w/agent-4f21ab"}), {})

    def test_la_revendication_la_plus_tardive_l_emporte(self):
        """Le journal est en ajout seul et plusieurs processus y écrivent à la
        fois : l'ordre des lignes n'est pas celui du temps — même lecture que
        `ticket_heartbeats`."""
        found = self.claims(
            self.ligne(20, "2026-08-25T21:00:00+00:00", "/w/agent-4f21ab"),
            self.ligne(19, "2026-08-25T20:05:00+00:00", "/w/agent-4f21ab"))
        self.assertEqual(found, {run_mod.path_key("/w/agent-4f21ab"): 20})

    def test_un_ticket_ne_garde_que_son_dernier_worktree(self):
        """Un ticket repris en reçoit un neuf sans que l'ancien disparaisse — il
        porte des modifications, donc l'outil `Agent` ne le récupère pas. Garder
        les deux ferait rendre à `live_worktrees` celui que `git` énumère en
        premier, c'est-à-dire l'abandonné, et `resume_context` renverrait l'agent
        suivant sur le travail mort."""
        found = self.claims(
            self.ligne(19, "2026-08-25T20:05:00+00:00", "/w/agent-mort"),
            self.ligne(19, "2026-08-25T21:30:00+00:00", "/w/agent-vivant"))
        self.assertEqual(found, {run_mod.path_key("/w/agent-vivant"): 19})

    def test_le_worktree_abandonne_ne_prend_pas_la_place_du_vivant(self):
        """Le même, vu de bout en bout : `git` liste l'ancien en premier."""
        porcelain = ("worktree /w/agent-mort\nHEAD 000\n"
                     "branch refs/heads/worktree-agent-mort\n\n"
                     "worktree /w/agent-vivant\nHEAD 111\n"
                     "branch refs/heads/worktree-agent-vivant\n")
        claims = self.claims(
            self.ligne(19, "2026-08-25T20:05:00+00:00", "/w/agent-mort"),
            self.ligne(19, "2026-08-25T21:30:00+00:00", "/w/agent-vivant"))
        with mock.patch.object(run_mod.subprocess, "run",
                               return_value=completed(0, porcelain)):
            found = run_mod.live_worktrees(claims)
        self.assertEqual(found[19]["branch"], "worktree-agent-vivant")

    def test_un_agent_dans_un_worktree_lie_se_nomme(self):
        with mock.patch.object(run_mod, "ROOT", Path("/w/agent-4f21ab")), \
             mock.patch.object(run_mod, "STATE_ROOT", Path("/depot")):
            self.assertEqual(run_mod.agent_worktree(), str(Path("/w/agent-4f21ab")))

    def test_le_depot_principal_ne_revendique_rien(self):
        """`--no-worktree` travaille dans l'arbre commun, qui n'appartient à
        aucun ticket : l'y attacher ferait passer le dépôt pour un worktree."""
        with mock.patch.object(run_mod, "ROOT", Path("/depot")), \
             mock.patch.object(run_mod, "STATE_ROOT", Path("/depot")):
            self.assertIsNone(run_mod.agent_worktree())

    def event(self, ticket, root, state_root):
        """La ligne que `cmd_event` écrit réellement, telle qu'elle atterrit."""
        base = dict(run=None, ticket=ticket, wave=None, phase="recevabilite",
                    status=None, message="recevable", pr=None, branch=None,
                    level=None, actor="agent", quiet=True, reset=False, beat=False)
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "ROOT", Path(root)), \
                 mock.patch.object(run_mod, "STATE_ROOT", Path(state_root)), \
                 mock.patch.object(run_mod, "resolve", return_value="r1"):
                (Path(tmp) / "r1").mkdir()
                run_mod.cmd_event(argparse.Namespace(**base))
                line = (Path(tmp) / "r1" / "journal.ndjson").read_text(
                    encoding="utf-8").strip()
        return json.loads(line)

    def test_event_inscrit_le_worktree_de_l_agent(self):
        """Sans cela, rien à croiser : c'est l'unique écriture qui alimente
        `worktree_claims`, et elle doit avoir lieu dès la première phase."""
        found = self.event(19, "/w/agent-4f21ab", "/depot")
        self.assertEqual(found["worktree"], str(Path("/w/agent-4f21ab")))

    def test_event_n_inscrit_rien_depuis_le_depot_principal(self):
        self.assertNotIn("worktree", self.event(19, "/depot", "/depot"))

    def test_une_ligne_de_run_n_est_pas_marquee(self):
        self.assertNotIn("worktree", self.event(None, "/w/agent-4f21ab", "/depot"))


def digest(name, milestone, finished=False, signal="run", active=False,
           nature="projet"):
    return {"id": name, "milestone": milestone, "created": "", "width": 3,
            "nature": nature, "done": 0, "total": 5, "wave": 1, "waves": 3,
            "signal": signal, "finished": finished, "active": active}


def row(title, due, open_issues=0, closed=0, state="open", run=None, todo=None,
        interactive=None):
    """Une ligne de `survey`. `todo` — les issues produit — vaut `open` par
    défaut : c'est ce que fait `survey` quand GitHub ne répond pas sur les
    labels, et cela laisse les cas historiques dire exactement ce qu'ils
    disaient."""
    return {"title": title, "state": state, "due": due, "open": open_issues,
            "todo": open_issues if todo is None else todo,
            "closed": closed, "interactive": list(interactive or []),
            "run": run}


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
               interactive=None, nature="projet"):
        dirs = [Path(str(index)) for index in range(len(digests))]
        with mock.patch.object(run_mod, "gh_json", return_value=(milestones, error)), \
             mock.patch.object(run_mod, "nature_census",
                               return_value=(backlog, interactive or {})), \
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

    def test_la_rubrique_interactive_suit_son_jalon(self):
        """Ce qu'aucun run ne prendra reste attaché au jalon où il se trouve :
        c'est le jalon qu'un humain ouvre, pas une liste globale."""
        rows, _ = self.survey(
            [self.milestone("S1", "2026-08-28", opened=12)], backlog={"S1": 2},
            interactive={"S1": [{"number": 226, "title": "aligner les commandes"}]})
        self.assertEqual([n["number"] for n in rows[0]["interactive"]], [226])

    def test_un_jalon_sans_rubrique_en_a_une_vide(self):
        rows, _ = self.survey([self.milestone("S1", "2026-08-28")],
                              backlog={"S1": 3}, interactive={"S2": [{"number": 1}]})
        self.assertEqual(rows[0]["interactive"], [])

    def test_un_run_dont_le_jalon_est_inconnu_a_une_rubrique_vide(self):
        """GitHub muet : on ne sait rien des empreintes, et la ligne se construit
        sans lui. Elle doit malgré tout porter la clé — `print_survey` la lit."""
        rows, _ = self.survey(None, [digest("s9-x", "S9")], error="gh indisponible")
        self.assertEqual(rows[0]["interactive"], [])


class DecompteParNature(unittest.TestCase):
    """`nature_census` — combien d'issues d'une nature restent, par jalon."""

    def backlog(self, payload, error=None, nature="projet", frozen=()):
        # Les empreintes figées sont neutralisées ici : ce décompte-là ne parle
        # que des labels, et lire le vrai fichier de règles ferait dépendre ces
        # tests du contenu du dépôt.
        with mock.patch.object(run_mod, "gh_json", return_value=(payload, error)), \
             mock.patch.object(run_mod, "frozen_interactive",
                               return_value=set(frozen)):
            return run_mod.nature_census(nature)[0]

    def query(self, nature):
        """La requête `gh` réellement émise — c'est le label qui fait le filtre."""
        seen = []

        def spy(args):
            seen.append(args)
            return [], None

        with mock.patch.object(run_mod, "gh_json", side_effect=spy), \
             mock.patch.object(run_mod, "frozen_interactive", return_value=set()):
            run_mod.nature_census(nature)
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

    def test_une_empreinte_entierement_sous_claude_ne_compte_plus(self):
        """Le plan la sort déjà (#360) : la compter ferait recommander un jalon
        dont `start` sortirait sur « rien de traitable »."""
        counts = self.backlog([
            {"number": 226, "milestone": {"title": "S1"},
             "labels": [{"name": "nature:outillage"}]},
            {"number": 371, "milestone": {"title": "S1"},
             "labels": [{"name": "nature:outillage"}]},
        ], frozen={226})
        self.assertEqual(counts, {"S1": 1})


class EmpreinteFigeeNonLivrable(unittest.TestCase):
    """`frozen_interactive` — les issues dont l'empreinte figée est entièrement
    sous `.claude/**`, qu'aucune vague ne peut donc écrire (#208, #360)."""

    def frozen(self, payload):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "milestone-rules.json"
            path.write_text(payload, encoding="utf-8")
            with mock.patch.object(rules_mod, "RULES_FILE", path):
                return run_mod.frozen_interactive()

    def test_une_empreinte_entierement_sous_claude_est_retenue(self):
        found = self.frozen(json.dumps({"resources": {
            "179": [".claude/settings"],
            "226": [".claude/commands", ".claude/skills/project-flow"]}}))
        self.assertEqual(found, {179, 226})

    def test_une_empreinte_mixte_ne_l_est_pas(self):
        """Le volet hors `.claude/` reste livrable : le ticket se scinde, il ne
        sort ni du plan ni du décompte."""
        self.assertEqual(self.frozen(json.dumps({"resources": {
            "186": [".claude/commands", "scripts/milestone-run"]}})), set())

    def test_une_empreinte_vide_ne_dit_rien(self):
        self.assertEqual(self.frozen(json.dumps({"resources": {"9": []}})), set())

    def test_un_fichier_illisible_surestime_plutot_que_de_cacher(self):
        """Un jalon proposé à tort se voit au premier plan vide ; un jalon caché
        à tort ne se voit jamais."""
        self.assertEqual(self.frozen("{ ceci n'est pas du json"), set())

    def test_une_cle_qui_n_est_pas_un_numero_est_ignoree(self):
        self.assertEqual(self.frozen(json.dumps({"resources": {
            "$doc": [".claude/commands"]}})), set())

    def test_une_valeur_qui_n_est_pas_une_liste_est_ignoree(self):
        self.assertEqual(self.frozen(json.dumps({"resources": {
            "179": ".claude/settings"}})), set())

    def test_un_fichier_sans_section_resources_ne_retient_personne(self):
        self.assertEqual(self.frozen(json.dumps({"depends": {}})), set())

    def test_des_regles_absentes_ne_retiennent_personne(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(rules_mod, "RULES_FILE",
                                   Path(tmp) / "absent.json"):
                self.assertEqual(run_mod.frozen_interactive(), set())


class RecensementParNature(unittest.TestCase):
    """`nature_census` — d'un même passage, ce qui reste à dérouler et ce qui
    attend une session interactive."""

    def census(self, payload, error=None, nature="projet", frozen=()):
        with mock.patch.object(run_mod, "gh_json", return_value=(payload, error)), \
             mock.patch.object(run_mod, "frozen_interactive",
                               return_value=set(frozen)):
            return run_mod.nature_census(nature)

    def issue(self, number, milestone="S1", labels=("nature:outillage",),
              title=None):
        return {"number": number, "title": title or f"issue {number}",
                "milestone": {"title": milestone} if milestone else None,
                "labels": [{"name": name} for name in labels]}

    def test_l_issue_sort_du_decompte_et_entre_dans_la_rubrique(self):
        counts, interactive = self.census(
            [self.issue(226), self.issue(371)], frozen={226})
        self.assertEqual(counts, {"S1": 1})
        self.assertEqual([n["number"] for n in interactive["S1"]], [226])

    def test_elle_est_rendue_avec_son_titre(self):
        """Un numéro seul n'apprend rien : c'est le titre qui décide un humain à
        y consacrer une session."""
        _, interactive = self.census(
            [self.issue(226, title="transmettre readonly au gabarit")],
            frozen={226})
        self.assertEqual(interactive["S1"][0]["title"],
                         "transmettre readonly au gabarit")

    def test_la_rubrique_se_range_par_jalon(self):
        _, interactive = self.census(
            [self.issue(226), self.issue(179, milestone="S2")],
            frozen={226, 179})
        self.assertEqual(sorted(interactive), ["S1", "S2"])

    def test_sans_jalon_elle_n_apparait_nulle_part(self):
        self.assertEqual(self.census([self.issue(226, milestone=None)],
                                     frozen={226}), ({}, {}))

    def test_ce_que_le_plan_ecarte_d_office_n_y_entre_pas_non_plus(self):
        """`post-mvp` prime : l'issue ne sera pas faite, ni par un run ni à la
        main, et l'annoncer chaque fois qu'on tape `next` serait du bruit."""
        self.assertEqual(
            self.census([self.issue(226, labels=("nature:outillage", "post-mvp"))],
                        frozen={226}), ({}, {}))

    def test_github_muet_ne_rend_aucune_rubrique(self):
        self.assertEqual(self.census(None, error="gh indisponible"), (None, {}))

    def test_une_page_pleine_ne_rend_aucune_rubrique(self):
        page = [self.issue(n) for n in range(run_mod.BACKLOG_LIMIT)]
        self.assertEqual(self.census(page), (None, {}))

    def test_le_titre_est_demande_a_github(self):
        seen = []

        def spy(args):
            seen.append(args)
            return [], None

        with mock.patch.object(run_mod, "gh_json", side_effect=spy), \
             mock.patch.object(run_mod, "frozen_interactive", return_value=set()):
            run_mod.nature_census("projet")
        self.assertIn("number,title,milestone,labels", seen[0])


class RubriqueInteractiveDuTableau(unittest.TestCase):
    """Ce que `next` doit dire **avant** qu'un run ne s'ouvre — plutôt que de le
    laisser découvrir dans le journal d'un run déjà lancé."""

    def render(self, rows):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            run_mod.print_survey(rows)
        return output.getvalue()

    def test_la_rubrique_nomme_l_issue_et_son_jalon(self):
        text = self.render([row(
            "S1 — Fondations", "2026-08-28", open_issues=12, todo=0,
            interactive=[{"number": 226, "title": "aligner les commandes"}])])
        self.assertIn("session interactive", text)
        self.assertIn("#226", text)
        self.assertIn("aligner les commandes", text)
        self.assertIn("S1 — Fondations", text)

    def test_le_motif_est_dit(self):
        text = self.render([row("S1", "2026-08-28",
                                interactive=[{"number": 226, "title": "t"}])])
        self.assertIn(".claude/**", text)

    def test_un_noeud_sans_titre_ne_fait_pas_tomber_le_tableau(self):
        """Même tolérance que `plan_interactive` : une ligne construite ailleurs
        que par `survey` peut n'avoir que le numéro, et le tableau reste dû."""
        text = self.render([row("S1", "2026-08-28",
                                interactive=[{"number": 226}])])
        self.assertIn("#226", text)

    def test_sans_issue_concernee_rien_n_est_imprime(self):
        self.assertNotIn("session interactive",
                         self.render([row("S1", "2026-08-28", open_issues=3)]))

    def test_une_ligne_d_avant_la_rubrique_ne_fait_pas_tomber_le_tableau(self):
        """La clé est neuve : une ligne construite ailleurs ne l'a pas, et le
        tableau doit rester imprimable."""
        legacy = {"title": "S1", "state": "open", "due": "2026-08-28",
                  "open": 3, "todo": 3, "closed": 1, "run": None}
        text = self.render([legacy])
        self.assertIn("S1", text)
        self.assertNotIn("session interactive", text)


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


def write_run(tmp, journal=(), control=None, interactive=None):
    """Un run complet sur disque — deux vagues, trois tickets.

    `interactive` laissé à `None` reproduit un run ouvert avant #360 : la
    rubrique n'est pas dans son plan, et rien ne doit s'en émouvoir.
    """
    directory = Path(tmp) / "r1"
    directory.mkdir()
    plan = {"waves": [{"index": 1, "issues": [plan_issue(19), plan_issue(20)]},
                      {"index": 2, "issues": [plan_issue(21)]}]}
    if interactive is not None:
        plan["interactive"] = interactive
    run = {"id": "r1", "milestone": "S1", "created": "2026-08-01T00:00:00+00:00",
           "width": 2, "plan": plan}
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


class RestitutionInteractiveAuGate(unittest.TestCase):
    """#371 — la rubrique que le plan produit doit se relire au `gate`.

    `start` recopie le plan entier dans `run.json`, la rubrique y survit — mais
    plus personne n'ouvre le plan une fois le run lancé. Sans cette restitution,
    ces issues-là n'existent nulle part où quelqu'un regarde.
    """

    MOTIF = ("empreinte entièrement sous .claude/** — à reprendre en session "
             "interactive")
    NODES = [{"number": 226, "title": "aligner les commandes",
              "url": "https://example.invalid/226",
              "resources": [".claude/commands"], "reason": MOTIF}]

    def gate(self, interactive=None, control=None):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control=control or {"signal": "run"},
                      interactive=interactive)
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                code = run_mod.cmd_gate(argparse.Namespace(run="r1"))
            return code, output.getvalue()

    def test_chaque_issue_est_nommee_avec_son_motif(self):
        code, output = self.gate(self.NODES)
        self.assertEqual(code, run_mod.GO)
        self.assertIn("session interactive #226", output)
        self.assertIn("aligner les commandes", output)
        self.assertIn(".claude/**", output)

    def test_la_ligne_est_distincte_d_un_ticket_ecarte(self):
        """Un ticket écarté est tombé ; celui-ci n'a jamais pu être pris. Les
        confondre ferait chercher une panne là où il n'y en a pas."""
        _, output = self.gate(self.NODES, control={
            "signal": "run", "skip": {"20": "hors sujet"}})
        self.assertIn("écarter #20", output)
        self.assertIn("session interactive #226", output)
        self.assertNotIn("écarter #226", output)

    def test_une_issue_deja_ecartee_nommement_ne_se_dit_pas_deux_fois(self):
        """L'arbitre écarte lui aussi des empreintes non livrables, avec une
        raison plus précise que le motif générique. Sur ce run, quatre des cinq
        lignes faisaient doublon."""
        _, output = self.gate(self.NODES, control={
            "signal": "run",
            "skip": {"226": "écriture .claude/** refusée à l'arbitre"}})
        self.assertIn("écarter #226", output)
        self.assertNotIn("session interactive #226", output)

    def test_une_issue_ecartee_n_emporte_pas_les_autres(self):
        nodes = self.NODES + [{"number": 179, "title": "symlinkDirectories",
                               "reason": self.MOTIF}]
        _, output = self.gate(nodes, control={"signal": "run",
                                              "skip": {"226": "déjà dit"}})
        self.assertNotIn("session interactive #226", output)
        self.assertIn("session interactive #179", output)

    def test_un_run_d_avant_la_rubrique_ne_dit_rien(self):
        _, output = self.gate(None)
        self.assertNotIn("session interactive", output)

    def test_une_rubrique_vide_ne_dit_rien(self):
        _, output = self.gate([])
        self.assertNotIn("session interactive", output)

    def test_un_noeud_sans_numero_est_ignore_sans_faire_tomber_la_barriere(self):
        code, output = self.gate([{"title": "nœud abîmé"}])
        self.assertEqual(code, run_mod.GO)
        self.assertNotIn("session interactive", output)

    def test_un_noeud_sans_motif_en_recoit_un(self):
        _, output = self.gate([{"number": 226}])
        self.assertIn("session interactive #226", output)
        self.assertIn(".claude/**", output)

    def test_un_plan_abime_ne_fait_pas_tomber_la_barriere(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "r1"
            directory.mkdir()
            (directory / "run.json").write_text(
                json.dumps({"id": "r1", "milestone": "S1", "width": 2,
                            "plan": {"waves": [], "interactive": "n'importe quoi"}}),
                encoding="utf-8")
            (directory / "control.json").write_text(json.dumps({"signal": "run"}),
                                                    encoding="utf-8")
            (directory / "journal.ndjson").write_text("", encoding="utf-8")
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertNotIn("session interactive", output.getvalue())


class GateApresUnArbitrage(unittest.TestCase):
    """#422 — le gate lit le plan **stocké**, et l'arbitrage écrit après lui.

    La séquence de la nuit du 4 au 5 septembre, rejouée bout à bout. Le replan de
    21:17 avait rendu « 0 tickets restants », et il avait raison : la PR de #60
    était ouverte sur un périmètre sensible non pré-autorisé, le ticket sortait du
    plan et ses dépendants restaient gelés. L'arbitrage de `fin_de_run` a ensuite
    mergé cette PR et fermé #60 — mais `gate`, à 21:33, relisait toujours le plan
    de 21:17 : `NO_RUN`, la veille s'est désarmée, et vingt issues plannables sont
    restées au matin.

    Ce test ne juge pas le superviseur (c'est `VeilleDevantUnPlanPerime`, dans
    `test_milestone_supervise.py`) : il fixe ce dont le superviseur dépend — que
    le gate change d'avis quand, et seulement quand, le plan a été recalculé.
    """

    VAGUE = {"waves": [{"index": 1, "issues": [plan_issue(62), plan_issue(317),
                                               plan_issue(316)]}]}

    def test_le_plan_vide_rend_no_run_le_plan_recalcule_nomme_la_vague(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "r1"
            directory.mkdir()
            (directory / "run.json").write_text(json.dumps(
                {"id": "r1", "milestone": "S3", "width": 3,
                 "created": "2026-09-04T10:18:49+00:00",
                 "plan": {"waves": []}}), encoding="utf-8")
            (directory / "control.json").write_text(
                json.dumps({"signal": "run"}), encoding="utf-8")
            # Le journal tel que l'arbitrage l'a laissé : #60 mergé, donc clos.
            (directory / "journal.ndjson").write_text(
                json.dumps({"ts": "2026-09-04T21:26:27+00:00", "kind": "ticket",
                            "ticket": 60, "status": "merged", "actor": "arbitre",
                            "message": "PR #419 lue, revue publiée, mergée"})
                + "\n", encoding="utf-8")

            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "live_worktrees", return_value={}), \
                 mock.patch.object(run_mod, "remote_branches", return_value={}), \
                 contextlib.redirect_stdout(output):
                avant = run_mod.cmd_gate(argparse.Namespace(run="r1"))
                with mock.patch.object(run_mod, "plan_json",
                                       return_value=self.VAGUE):
                    run_mod.cmd_replan(argparse.Namespace(run="r1", width=None))
                apres = run_mod.cmd_gate(argparse.Namespace(run="r1"))
            texte = output.getvalue()

        self.assertEqual(avant, run_mod.NO_RUN)         # « toutes les vagues… »
        self.assertEqual(apres, run_mod.GO)             # …alors qu'il en reste 7
        self.assertIn("vague 1 · 3 ticket(s) à lancer", texte)
        for number in (62, 317, 316):
            self.assertIn(f"#{number}", texte)

    def test_le_replan_laisse_dans_le_journal_de_quoi_relire_la_sequence(self):
        """Critère 4 de #422 : sans cette ligne, la séquence « plan vide →
        arbitrage → plan rouvert » ne se relit nulle part."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "r1"
            directory.mkdir()
            (directory / "run.json").write_text(json.dumps(
                {"id": "r1", "milestone": "S3", "width": 3,
                 "plan": {"waves": []}}), encoding="utf-8")
            (directory / "journal.ndjson").write_text("", encoding="utf-8")
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "plan_json", return_value=self.VAGUE), \
                 contextlib.redirect_stdout(io.StringIO()):
                run_mod.cmd_replan(argparse.Namespace(run="r1", width=None))
            events = [json.loads(line) for line
                      in (directory / "journal.ndjson").read_text(
                          encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual([e["status"] for e in events], ["replanned"])
        self.assertIn("3 tickets restants", events[0]["message"])


class ActeurDuSignal(unittest.TestCase):
    """#262 — qui a posé la pause, et comment on le sait.

    `--actor` vaut `humain` **par défaut** sur `pause`, `stop` et `go` : le
    recopier tel quel dans `control.json` aurait construit la distinction
    « pause humaine / pause machine » sur l'ambiguïté même qu'elle doit lever.
    Ce qui est couvert ici est donc l'établissement de l'acteur, pas sa
    recopie — et le fait que l'absence de preuve n'en soit jamais une.
    """

    @staticmethod
    def etabli(actor=None, env=None):
        with mock.patch.dict(run_mod.os.environ, env or {}, clear=True):
            return run_mod.real_actor(argparse.Namespace(actor=actor))

    def test_un_acteur_nomme_est_retenu_tel_quel(self):
        self.assertEqual(self.etabli("superviseur"), "superviseur")

    def test_personne_ne_s_etant_nomme_hors_etape_c_est_un_humain(self):
        """Le repli est délibérément le cas humain : se tromper dans ce sens ne
        coûte qu'un arbitrage de moins."""
        self.assertEqual(self.etabli(), "humain")

    def test_sous_une_etape_de_jalon_personne_ne_tape_la_commande(self):
        """C'est le point qui empêche de prendre un automate pour un humain —
        l'erreur qui, elle, musellerait l'arbitre pour de bon."""
        for name in ("SPA_LEG_START", "SPA_UNATTENDED"):
            with self.subTest(variable=name):
                self.assertEqual(self.etabli(env={name: "1"}),
                                 run_mod.MACHINE_ACTOR)
                self.assertNotIn(self.etabli(env={name: "1"}),
                                 run_mod.HUMAN_ACTORS)

    def test_un_acteur_nomme_prime_sur_l_environnement(self):
        """Un humain qui tape `pause --actor humain` depuis un shell hérité
        d'une étape reste un humain."""
        self.assertEqual(self.etabli("humain", {"SPA_LEG_START": "1"}), "humain")

    def test_une_variable_desarmee_ne_fait_pas_un_automate(self):
        self.assertEqual(self.etabli(env={"SPA_LEG_START": "0"}), "humain")

    def signal(self, verbe, actor=None, env=None):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.dict(run_mod.os.environ, env or {}, clear=True), \
                 contextlib.redirect_stdout(io.StringIO()):
                run_mod.cmd_signal(argparse.Namespace(run="r1", actor=actor),
                                   verbe)
            control = json.loads((Path(tmp) / "r1" / "control.json").read_text(
                encoding="utf-8"))
            events = [json.loads(line) for line in
                      (Path(tmp) / "r1" / "journal.ndjson").read_text(
                          encoding="utf-8").splitlines() if line.strip()]
        return control, events

    def test_la_pause_emporte_son_acteur_dans_le_controle(self):
        """C'est `control.json` que lit le gate — laisser l'acteur au seul
        journal obligerait à le relire à l'envers, sans garantie de tomber sur
        la pause en vigueur."""
        control, events = self.signal("pause")
        self.assertEqual(control["signal"], "pause")
        self.assertEqual(control["signal_actor"], "humain")
        self.assertEqual(events[-1]["actor"], "humain")

    def test_une_pause_posee_sous_une_etape_n_est_pas_humaine(self):
        control, events = self.signal("pause", env={"SPA_UNATTENDED": "1"})
        self.assertEqual(control["signal_actor"], run_mod.MACHINE_ACTOR)
        self.assertEqual(events[-1]["actor"], run_mod.MACHINE_ACTOR)
        self.assertFalse(run_mod.human_pause(control))

    def test_l_arbitre_qui_pose_un_arret_se_nomme(self):
        control, _ = self.signal("stop", actor="arbitre")
        self.assertEqual(control["signal_actor"], "arbitre")

    def test_lever_la_pause_reprend_l_acteur_du_moment(self):
        """`go` ne laisse pas derrière lui un « posée par humain » sur un
        `control.json` qui ne porte plus de pause."""
        control, _ = self.signal("run", env={"SPA_LEG_START": "1"})
        self.assertEqual(control["signal"], "run")
        self.assertEqual(control["signal_actor"], run_mod.MACHINE_ACTOR)

    def test_une_pause_humaine_se_reconnait(self):
        self.assertTrue(run_mod.human_pause(
            {"signal": "pause", "signal_actor": "humain"}))

    def test_l_acteur_humain_se_reconnait_quelle_qu_en_soit_la_casse(self):
        """`--actor` est du texte libre : lire `Humain` comme une pièce du
        dispositif rendrait l'arbitre libre de lever la pause."""
        for value in ("Humain", "HUMAIN", " humain ", "Human"):
            with self.subTest(actor=value):
                self.assertTrue(run_mod.human_pause(
                    {"signal": "pause", "signal_actor": value}))

    def test_un_run_anterieur_au_correctif_ne_prouve_rien(self):
        """Pas de `signal_actor`, pas de preuve : le motif se lève comme avant,
        et c'est le filet de `milestone_arbiter.should` qui borne la casse à un
        arbitrage au lieu de douze."""
        self.assertFalse(run_mod.human_pause({"signal": "pause"}))

    def test_sans_pause_il_n_y_a_pas_de_pause_humaine(self):
        for control in ({"signal": "run", "signal_actor": "humain"},
                        {"signal": "stop", "signal_actor": "humain"},
                        {}, None):
            with self.subTest(control=control):
                self.assertFalse(run_mod.human_pause(control))

    def test_le_gate_dit_par_qui_la_pause_a_ete_posee(self):
        """Le code de sortie est le même pour une pause posée et une pause sur
        erreur : cette ligne est ce qui les sépare à l'œil."""
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "pause", "signal_actor": "humain"})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 contextlib.redirect_stdout(output):
                code = run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertEqual(code, run_mod.PAUSE)
        self.assertIn("par humain", output.getvalue())


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
        def muette(claims=None):
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


class AgentAnonymeDeJalon(unittest.TestCase):
    """#175, de bout en bout : le journal, la sonde locale, puis le verdict.

    `live_worktrees` n'est pas doublé ici, contrairement aux classes voisines —
    c'est précisément le chemin journal → revendication → `git worktree list`
    qu'on veut voir jouer. Seul `git` l'est, par sa sortie.

    Les deux critères du ticket sont les deux moitiés de la même règle : la
    revendication rend le worktree **visible**, elle ne dit jamais que son agent
    est vivant. C'est `orphaned()` qui en juge, sur la frontière d'étape, comme
    pour n'importe quel worktree nommé.
    """

    PORCELAIN = ("worktree /depot\nHEAD 000\nbranch refs/heads/develop\n\n"
                 + ANONYME)

    def ligne(self, ts, **fields):
        event = {"ts": ts, "kind": "ticket", "ticket": 19,
                 "phase": "prise-en-charge", "status": "running",
                 "message": "carte en In progress",
                 "worktree": "/w/agent-4f21ab"}
        event.update(fields)
        if event.get("worktree") is None:      # `worktree=None` : l'agent muet
            event.pop("worktree", None)
        return event

    def etape(self, ts):
        return {"ts": ts, "kind": "run", "status": "leg_started",
                "message": "étape ouverte"}

    def reconcile(self, journal, porcelain=None):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal)
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "gh_json",
                                   side_effect=[([], None), ([], None)]), \
                 mock.patch.object(run_mod, "remote_branches", return_value={}), \
                 mock.patch.object(run_mod.subprocess, "run",
                                   return_value=completed(
                                       0, self.PORCELAIN if porcelain is None
                                       else porcelain)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_reconcile(argparse.Namespace(run="r1", leg_start=False))
                tickets = run_mod.replay(run_mod.load_run("r1"),
                                         run_mod.read_journal("r1"),
                                         run_mod.load_control("r1"))
            return tickets, output.getvalue()

    def test_un_agent_vivant_dans_un_worktree_anonyme_n_est_pas_requeue(self):
        """Critère 1. L'agent a journalisé après l'ouverture de l'étape : il
        tient son ticket, et sa branche ne le dit toujours pas. Le requeuer
        lancerait un second agent sur son empreinte — c'est #130."""
        tickets, output = self.reconcile(
            [self.etape("2026-08-25T20:00:00+00:00"),
             self.ligne("2026-08-25T20:05:00+00:00")])
        self.assertEqual(tickets[19]["status"], "running")
        self.assertIn("journal conforme au dépôt", output)

    def test_sans_la_revendication_le_meme_agent_serait_double(self):
        """Le contre-essai, qui dit ce que la revendication porte : même
        journal, même sortie de `git`, mais l'agent n'a rien inscrit — et le
        ticket repart alors qu'un vivant le tient. C'est l'état d'avant #175."""
        tickets, output = self.reconcile(
            [self.etape("2026-08-25T20:00:00+00:00"),
             self.ligne("2026-08-25T20:05:00+00:00", worktree=None)])
        self.assertEqual(tickets[19]["status"], "pending")
        self.assertIn("jamais démarré", output)

    def test_un_worktree_anonyme_abandonne_ne_retient_pas_son_ticket(self):
        """Critère 2. L'étape qui portait l'agent est morte après son dernier
        battement : le ticket repart, sur sa branche et dans son worktree."""
        tickets, output = self.reconcile(
            [self.ligne("2026-08-25T20:05:00+00:00"),
             self.etape("2026-08-25T21:00:00+00:00")])
        self.assertEqual(tickets[19]["status"], "pending")
        self.assertIn("agent mort avec son étape", output)
        self.assertIn("worktree-agent-4f21ab", output)
        self.assertIn("/w/agent-4f21ab", output)

    def test_un_worktree_anonyme_disparu_rend_le_ticket_a_la_file(self):
        """La revendication survit au worktree — le journal est en ajout seul.
        Elle ne vaut donc que confrontée à `git worktree list` : sans entrée en
        face, le ticket n'a plus rien où reprendre."""
        tickets, output = self.reconcile(
            [self.etape("2026-08-25T20:00:00+00:00"),
             self.ligne("2026-08-25T20:05:00+00:00")],
            porcelain="worktree /depot\nHEAD 000\nbranch refs/heads/develop\n")
        self.assertEqual(tickets[19]["status"], "pending")
        self.assertIn("jamais démarré", output)

    def test_le_ticket_tombe_garde_son_worktree_anonyme(self):
        """Un ticket jugé n'est pas un ticket abandonné : la pause sur erreur
        doit continuer de le retenir, worktree anonyme ou non."""
        tickets, output = self.reconcile(
            [self.ligne("2026-08-25T20:05:00+00:00"),
             self.ligne("2026-08-25T20:40:00+00:00", status="blocked",
                        phase="validation", message="verify rouge"),
             self.etape("2026-08-25T21:00:00+00:00")])
        self.assertEqual(tickets[19]["status"], "blocked")
        self.assertNotIn("agent mort", output)


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

    def test_sans_worktree_une_branche_poussee_repart_sur_le_distant(self):
        """#249 — le ticket restait `running` faute d'endroit où reprendre, et
        `gate` ne lançant que des `pending`, il était figé jusqu'à un `retry`
        humain. La branche poussée **est** l'endroit où reprendre : le verdict
        bascule, et il ne bascule qu'une fois."""
        self.assertEqual(
            self.rejoue([self.LEG, self.AVANT], [{}, {}],
                        branches={19: "feature/19-truc"}),
            ["pending", "pending"])


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
    worktree vierge sur un ticket qui en a déjà un — et n'efface pas l'ancien.

    Le cas couvert ici est « worktree existant + agent épinglé » (#245). Un
    sous-agent lancé avec `isolation: "worktree"` ne peut pas rejoindre le
    worktree annoncé : `EnterWorktree` déplace le répertoire courant sans
    déplacer l'épinglage, et passé cet appel plus aucune commande `Bash` ne
    s'exécute — `ExitWorktree` étant lui aussi refusé, l'agent reste coincé. Le
    `gate` ne doit donc plus prescrire ce geste, mais la reprise de la
    **branche** depuis le worktree où l'agent se trouve déjà.
    """

    def gate(self, worktrees, git_lines, branches=None):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees",
                                   return_value=worktrees), \
                 mock.patch.object(run_mod, "remote_branches",
                                   return_value=branches or {}), \
                 mock.patch.object(run_mod, "git_lines",
                                   side_effect=git_lines), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        return output.getvalue()

    def test_le_gate_annonce_la_branche_a_reprendre(self):
        rendu = self.gate(
            {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                  "locked": True}},
            [["4ae5aed wip(19)"], [" M apps/api/src/x.ts"]])
        self.assertIn("À REPRENDRE", rendu)
        self.assertIn("feature/19-truc", rendu)
        self.assertIn("1 commit(s)", rendu)

    def test_le_gate_ne_prescrit_plus_EnterWorktree(self):
        """Le geste qui coince un agent épinglé ne doit plus être imprimé —
        c'est lui que les trois agents de la vague ont tenté d'appliquer."""
        rendu = self.gate(
            {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                  "locked": True}},
            [["4ae5aed wip(19)"], []])
        self.assertNotIn("EnterWorktree(path", rendu)
        self.assertIn("ne pas appeler EnterWorktree", rendu)

    def test_la_reprise_passe_par_un_checkout_qui_ne_renomme_pas(self):
        """« La branche est déjà prise par un autre checkout », sans changer son
        nom. `--ignore-other-worktrees` lève le refus de `git` ; c'est ce refus,
        contourné par un renommage, qui a produit
        `feature/25-affectation-services-aux-praticiens` là où le journal du run
        portait `feature/25-affectation-services-praticiens`."""
        branche = "feature/25-affectation-services-praticiens"
        lignes = run_mod.resume_instruction(
            25, {"path": "/w/agent-a40c", "branch": branche,
                 "detail": "3 fichier(s) non commités", "commits": 0,
                 "dirty": 3})
        rendu = "\n".join(lignes)
        self.assertIn(f"git checkout --ignore-other-worktrees {branche}", rendu)
        self.assertIn("ne pas renommer la branche", rendu)
        self.assertNotIn("aux-praticiens", rendu)

    def test_les_fichiers_non_commites_sont_annonces_avec_leur_chemin(self):
        """Le checkout n'emporte que le commité. Les fichiers laissés en
        souffrance dans l'ancien worktree ne suivent pas — et `Read`, qui
        accepte un chemin absolu là où `Bash` est refusé à un agent épinglé,
        est le seul moyen de les récupérer (c'est ce qu'a fait #25)."""
        rendu = self.gate(
            {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                  "locked": False}},
            [["4ae5aed wip(19)"], [" M a.ts", " M b.ts", "?? c.ts"]])
        self.assertIn("3 fichier(s) non commités", rendu)
        self.assertIn("/w/agent-a9e8", rendu)
        self.assertIn("Read", rendu)

    def test_les_fichiers_en_souffrance_sont_nommes_un_par_un(self):
        """Un décompte ne se relit pas. L'agent épinglé n'a aucun moyen
        d'énumérer le contenu de l'ancien worktree — `Bash` y est refusé —, si
        bien que dire « 3 fichiers » sans les nommer rend l'instruction
        inapplicable et perd le travail qu'elle prétend sauver."""
        rendu = self.gate(
            {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                  "locked": False}},
            [[], [" M apps/api/src/a.ts", "?? apps/web/b.tsx",
                  "R  vieux.ts -> apps/api/src/c.ts"]])
        self.assertIn("Read /w/agent-a9e8/apps/api/src/a.ts", rendu)
        self.assertIn("Read /w/agent-a9e8/apps/web/b.tsx", rendu)
        # Un renommage : c'est le nouveau nom qui existe sur le disque.
        self.assertIn("Read /w/agent-a9e8/apps/api/src/c.ts", rendu)
        self.assertNotIn("vieux.ts", rendu)

    def test_une_branche_d_avant_le_renommage_est_a_renommer(self):
        """`live_worktrees` reconnaît aussi la branche que `EnterWorktree` pose
        avant la phase 1 (`worktree-feature+19-…`). Elle ne satisfait pas
        `BRANCH_RE` : la garder casserait le rapprochement branche ↔ ticket que
        l'instruction cherche justement à protéger."""
        lignes = run_mod.resume_instruction(
            19, {"path": "/w/agent-a9e8", "branch": "worktree-feature+19-truc",
                 "detail": "1 commit(s)", "commits": 1, "dirty": 0})
        rendu = "\n".join(lignes)
        self.assertIn("git checkout --ignore-other-worktrees "
                      "worktree-feature+19-truc", rendu)
        self.assertIn("git branch -m", rendu)
        self.assertNotIn("ne pas renommer la branche", rendu)

    def test_sans_fichier_en_souffrance_le_chemin_ne_s_annonce_pas(self):
        """Tout le travail est commité : le checkout suffit, et nommer un
        chemin où l'agent ne peut de toute façon pas se rendre ne ferait que
        l'inviter à essayer."""
        rendu = self.gate(
            {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                  "locked": False}},
            [["4ae5aed wip(19)"], []])
        self.assertNotIn("/w/agent-a9e8", rendu)

    def test_un_ticket_sans_worktree_ni_branche_n_a_rien_a_reprendre(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees", return_value={}), \
                 mock.patch.object(run_mod, "remote_branches", return_value={}), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertNotIn("À REPRENDRE", output.getvalue())

    def test_le_contexte_compte_le_commite_et_le_non_commite(self):
        """`resume_instruction` décide sur ces deux nombres : les rendre est ce
        qui distingue « tout est commité » de « il reste à récupérer »."""
        with mock.patch.object(run_mod, "git_lines",
                               side_effect=[["a wip", "b wip"], [" M x.ts"]]):
            context = run_mod.resume_context(
                19, {19: {"path": "/w/agent-a9e8", "branch": "feature/19-truc",
                          "locked": False}})
        self.assertEqual(context["commits"], 2)
        self.assertEqual(context["dirty"], 1)
        self.assertEqual(context["branch"], "feature/19-truc")


class ReprisSurLaBrancheDistante(unittest.TestCase):
    """#249 — l'agent qui a poussé puis est mort sans ouvrir de PR, et dont le
    worktree a disparu, laissait un ticket `running` que rien ne rattrapait.

    `gate` ne lance que des `pending` : ce ticket-là attendait un `retry`
    humain, c'est-à-dire le mode de panne de #180 réduit à la fenêtre étroite
    qui sépare le `git push` du `gh pr create`.

    #248 s'était arrêté là, et pour une raison juste : requeuer sans rien dire
    faisait repartir l'agent relancé d'une branche neuve, en abandonnant ce qui
    était déjà sur le distant. Entre figer un ticket et perdre du travail
    poussé, figer était le moindre mal. La sortie est de **désigner la branche
    poussée**, exactement comme le `gate` désigne déjà un worktree : le travail
    est alors récupéré, et la vague repart.
    """

    LEG = {"ts": "2026-08-26T13:01:30+00:00", "kind": "run",
           "status": "leg_started", "actor": "superviseur",
           "message": "étape 3 — une vague, largeur 3"}
    # Le dernier battement de l'agent : il a poussé, puis est mort avec son
    # `claude -p` sans avoir ouvert de PR.
    AVANT = {"ts": "2026-08-26T11:30:35+00:00", "kind": "ticket", "ticket": 19,
             "phase": "commits", "status": "running", "actor": "agent",
             "message": "3 commits poussés sur feature/19-truc"}
    # Le battement d'après la frontière : un agent tient encore le ticket.
    APRES = {"ts": "2026-08-26T13:09:05+00:00", "kind": "ticket", "ticket": 19,
             "phase": "pr", "status": "running", "actor": "agent",
             "message": "corps de PR en cours de rédaction"}
    BRANCHES = {19: "feature/19-truc"}

    def reconcile(self, journal, branches=None, worktrees=None, prs=(),
                  tours=1):
        """(statuts du ticket 19 tour par tour, sortie cumulée).

        Les tours se rejouent sur le **même** dossier de run : chacun relit ce
        que le précédent a écrit, seule façon de voir une oscillation ou un
        statut blanchi de proche en proche.
        """
        verdicts = []
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, journal=journal)
            output = io.StringIO()
            reponses = [([], None), (list(prs), None)] * tours
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"), \
                 mock.patch.object(run_mod, "gh_json", side_effect=reponses), \
                 mock.patch.object(run_mod, "remote_branches",
                                   return_value=branches or {}), \
                 mock.patch.object(run_mod, "live_worktrees",
                                   return_value=worktrees or {}), \
                 contextlib.redirect_stdout(output):
                for _ in range(tours):
                    run_mod.cmd_reconcile(argparse.Namespace(run="r1",
                                                             leg_start=False))
                    tickets = run_mod.replay(run_mod.load_run("r1"),
                                             run_mod.read_journal("r1"),
                                             run_mod.load_control("r1"))
                    verdicts.append(tickets[19]["status"])
            return verdicts, output.getvalue()

    def gate(self, worktrees=None, branches=None, git_lines=()):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            output = io.StringIO()
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "live_worktrees",
                                   return_value=worktrees or {}), \
                 mock.patch.object(run_mod, "remote_branches",
                                   return_value=branches or {}) as sonde, \
                 mock.patch.object(run_mod, "git_lines",
                                   side_effect=list(git_lines)), \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
            return output.getvalue(), sonde

    def test_le_ticket_fige_redevient_pending(self):
        """Critère 1 — `running`, sans PR ni worktree, branche poussée, dernier
        battement avant la frontière d'étape."""
        verdicts, output = self.reconcile([self.LEG, self.AVANT],
                                          branches=self.BRANCHES)
        self.assertEqual(verdicts, ["pending"])
        self.assertIn("agent mort avec son étape", output)
        self.assertIn("origin/feature/19-truc", output)

    def test_un_agent_qui_journalise_apres_l_etape_n_est_pas_touche(self):
        """Critère 3 — la protection de #130 tient : un vivant est en train
        d'ouvrir la PR, et le requeuer lancerait un second agent sur son
        empreinte."""
        verdicts, output = self.reconcile([self.AVANT, self.LEG, self.APRES],
                                          branches=self.BRANCHES)
        self.assertEqual(verdicts, ["running"])
        self.assertNotIn("agent mort", output)

    def test_le_verdict_ne_bascule_pas_a_chaque_relecture(self):
        """#233 — `reconcile` ne doit pas relire sa propre écriture comme un
        battement, sans quoi le ticket oscillerait `pending` → `running`."""
        verdicts, _ = self.reconcile([self.LEG, self.AVANT],
                                     branches=self.BRANCHES, tours=3)
        self.assertEqual(verdicts, ["pending", "pending", "pending"])

    def test_un_ticket_tombe_n_est_pas_blanchi_par_sa_branche(self):
        """Un ticket jugé n'est pas un ticket abandonné : la pause sur erreur
        doit continuer de le retenir, branche poussée ou non — c'est `retry N`
        qui le remet en file, et lui seul.

        Deux relectures, parce que c'est en deux temps que le blanchiment
        opérait : la branche faisait passer le ticket `running`, puis le
        requeue du cas précédent le prenait pour un `running` abandonné. La
        vague aurait relancé un ticket que l'humain n'avait pas revu."""
        journal = [self.AVANT,
                   {"ts": "2026-08-26T11:40:00+00:00", "kind": "ticket",
                    "ticket": 19, "phase": "validation", "status": "blocked",
                    "actor": "agent", "message": "verify rouge"},
                   self.LEG]
        verdicts, output = self.reconcile(journal, branches=self.BRANCHES,
                                          tours=2)
        self.assertEqual(verdicts, ["blocked", "blocked"])
        self.assertNotIn("agent mort", output)

    def test_une_pr_ouverte_prime_sur_la_branche(self):
        """L'agent a eu le temps d'ouvrir sa PR : il n'y a plus rien à
        reprendre, le ticket est en vol."""
        verdicts, _ = self.reconcile(
            [self.LEG, self.AVANT], branches=self.BRANCHES,
            prs=[{"number": 77, "state": "OPEN", "body": "Closes #19",
                  "headRefName": "feature/19-truc"}])
        self.assertEqual(verdicts, ["pr_open"])

    def test_le_gate_annonce_la_branche_distante_et_sa_commande(self):
        """Critère 2 — sans la commande, l'agent relancé repartirait d'une
        branche neuve et abandonnerait les commits déjà sur `origin`."""
        rendu, _ = self.gate(branches=self.BRANCHES,
                             git_lines=[["a wip", "b wip", "c wip"]])
        self.assertIn("#19 À REPRENDRE sur origin/feature/19-truc", rendu)
        self.assertIn("3 commit(s) poussé(s), aucune PR", rendu)
        self.assertIn("git fetch origin feature/19-truc", rendu)
        self.assertIn("git checkout --ignore-other-worktrees -B feature/19-truc "
                      "origin/feature/19-truc", rendu)
        self.assertIn("ne pas ouvrir de branche neuve", rendu)

    def test_la_commande_tient_sans_reference_de_suivi_locale(self):
        """Le décompte se lit sur `origin/<branche>`, que le dépôt local ne
        connaît que s'il a fetché depuis. Muet, il ne doit pas emporter
        l'instruction — c'est elle qui porte le `git fetch`."""
        rendu, _ = self.gate(branches=self.BRANCHES, git_lines=[[]])
        self.assertIn("branche poussée, aucune PR", rendu)
        self.assertIn("git fetch origin feature/19-truc", rendu)

    def test_le_worktree_prime_sur_la_branche_distante(self):
        """Un worktree vivant porte aussi le non commité : c'est là qu'on
        renvoie l'agent, pas sur le distant qui n'en sait rien."""
        rendu, _ = self.gate(
            worktrees={19: {"path": "/w/agent-a9e8",
                            "branch": "feature/19-truc", "locked": False},
                       20: {"path": "/w/agent-b1c2",
                            "branch": "feature/20-truc", "locked": False}},
            branches=self.BRANCHES,
            git_lines=[["a wip"], [" M x.ts"], ["b wip"], []])
        self.assertIn("git checkout --ignore-other-worktrees feature/19-truc",
                      rendu)
        self.assertNotIn("git fetch origin", rendu)

    def test_une_sonde_locale_muette_n_ouvre_pas_le_repli_distant(self):
        """`live_worktrees` muette rend le même dictionnaire vide qu'un ticket
        sans worktree — et chaque ticket à lancer s'entendrait alors dire « le
        worktree a disparu, tout le travail est sur le distant ». Or un worktree
        vivant porte aussi du non commité, que le distant ne connaît pas :
        l'agent se recalerait sur `origin` en le perdant, quand il ne se
        heurterait pas au refus de `checkout` sur une branche déjà sortie.

        Même prudence que `reconcile` : une absence non constatée ne vaut pas
        une absence."""
        self.addCleanup(run_mod.PROBE_FAILURES.clear)
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, control={"signal": "run"})
            output = io.StringIO()
            with mock.patch.object(
                    run_mod, "live_worktrees",
                    side_effect=lambda *a, **k: run_mod.note_probe_failure(
                        "git worktree list : en erreur")), \
                 mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "remote_branches",
                                   return_value=self.BRANCHES) as sonde, \
                 contextlib.redirect_stdout(output):
                run_mod.cmd_gate(argparse.Namespace(run="r1"))
        self.assertNotIn("À REPRENDRE", output.getvalue())
        sonde.assert_not_called()

    def test_la_sonde_distante_ne_se_paie_pas_pour_rien(self):
        """`git ls-remote` est un appel réseau, et le `gate` tourne à chaque
        étape : tous les tickets à lancer ayant leur worktree, il n'y a aucune
        branche à chercher."""
        _, sonde = self.gate(
            worktrees={19: {"path": "/w/a", "branch": "feature/19-truc",
                            "locked": False},
                       20: {"path": "/w/b", "branch": "feature/20-truc",
                            "locked": False}},
            git_lines=[[], [], [], []])
        sonde.assert_not_called()


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
