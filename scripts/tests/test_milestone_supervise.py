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

Ce qui est vérifié ici est donc le nouveau signal et lui seul : le travail rendu
durable. Une régression sur `sterile_streak`, `work_commits`, `merged_tickets` ou
`leg_production` ne casserait rien de visible — elle laisserait simplement le
dispositif tourner à vide, ce qui est exactement le mode de défaillance que #138
décrit.

Le signal a deux moitiés depuis #278, et il les faut toutes les deux : le commit
sur une branche de ticket, et le merge que le run s'impute. Une étape qui mène un
ticket jusqu'au merge ne laisse aucune branche derrière elle — la mesurer sur le
seul `refs/heads` faisait passer la plus productive des étapes pour la plus
stérile, et deux de suite arrêtaient le dispositif.

Aucune dépendance : `unittest` de la bibliothèque standard, comme
`test_pr_gate.py`.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import milestone_supervise as sup  # noqa: E402 — l'insertion de chemin la précède


# `say()` écrit dans `.claude/.milestone/supervisor.log`, le journal
# **opérationnel** d'un run. Des tests qui exercent des chemins d'erreur y
# injectaient donc de fausses lignes — « dossier d'arbitrage indisponible :
# python introuvable » y a été lu le 26/08 comme une panne réelle, alors qu'un
# test venait de la fabriquer. Et comme `npm run verify` lance `test:scripts`,
# chaque agent polluait le journal à chaque ticket.
#
# On redirige le journal pour tout le module : aucun test, présent ou futur, ne
# peut plus écrire dans le vrai fichier, sans qu'on ait à compter sur la
# vigilance de chacun.
_LOG_TMP = None
_LOG_REEL = None


def setUpModule():
    global _LOG_TMP, _LOG_REEL
    _LOG_REEL = sup.SUPERVISOR_LOG
    _LOG_TMP = tempfile.TemporaryDirectory()
    sup.SUPERVISOR_LOG = Path(_LOG_TMP.name) / "supervisor.log"


def tearDownModule():
    # Restituer AVANT de supprimer le répertoire : sans cela la constante
    # pointerait vers un chemin effacé, et tout `say()` d'un module chargé
    # ensuite par `unittest discover` échouerait — en silence, puisque `say`
    # avale l'OSError par conception. On remplacerait une pollution du journal
    # par une perte, ce qui ne vaut pas mieux.
    if _LOG_REEL is not None:
        sup.SUPERVISOR_LOG = _LOG_REEL
    if _LOG_TMP is not None:
        _LOG_TMP.cleanup()



class SterileStreak(unittest.TestCase):
    """La règle d'arrêt de #138 : deux legs de suite sans rien rendre durable.

    « Rien » veut dire ni commit ni merge depuis #278 : la fonction ne juge que
    la production qu'on lui passe, quelle qu'en soit la nature.
    """

    def test_un_commit_remet_le_compteur_a_zero(self):
        self.assertEqual(sup.sterile_streak(1, {"abc123"}, None), 0)

    def test_un_merge_seul_remet_le_compteur_a_zero(self):
        """Aucun commit sur une branche, mais un ticket mergé : c'est produit."""
        self.assertEqual(sup.sterile_streak(1, set() or {17}, None), 0)

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


class RunJournalFixture(unittest.TestCase):
    """De quoi fabriquer un dossier de run jetable et son journal NDJSON."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)

    def journal(self, *events):
        """Écrit le journal du run et fait pointer `current_run_dir()` dessus."""
        (self.directory / "journal.ndjson").write_text(
            "".join(json.dumps(event, ensure_ascii=False) + "\n"
                    for event in events), encoding="utf-8")
        return mock.patch.object(sup, "current_run_dir",
                                 return_value=self.directory)

    @staticmethod
    def merged(ticket, message="mergée en squash"):
        return {"ts": "2026-08-26T22:54:00+00:00", "ticket": ticket,
                "status": "merged", "actor": "orchestrateur", "message": message}


class JournalEvents(RunJournalFixture):
    """La lecture tolérante du journal, partagée par les deux mesures qui le lisent.

    Le fichier s'écrit en ajout, à plusieurs, sans verrou : une ligne tronquée
    par une écriture concurrente doit se sauter, jamais faire mourir le
    superviseur — la veille relancerait toutes les cinq minutes un superviseur
    qui remourrait de la même façon.
    """

    def test_les_evenements_reviennent_dans_l_ordre(self):
        with self.journal({"ts": "1", "status": "running"},
                          {"ts": "2", "status": "merged", "ticket": 17}):
            events = sup.journal_events(self.directory)
        self.assertEqual([event["ts"] for event in events], ["1", "2"])

    def test_ligne_tronquee_et_ligne_vide_se_sautent(self):
        (self.directory / "journal.ndjson").write_text(
            '{"ts": "1"}\n\n{"ts": "2", "sta\n{"ts": "3"}\n', encoding="utf-8")
        self.assertEqual([e["ts"] for e in sup.journal_events(self.directory)],
                         ["1", "3"])

    def test_une_ligne_qui_n_est_pas_un_objet_est_ecartee(self):
        """`json.loads("42")` réussit et rend un entier : sans ce filtre, le
        `event.get(...)` de l'appelant lèverait sur une ligne malformée."""
        (self.directory / "journal.ndjson").write_text(
            '42\n"texte"\n{"ts": "1"}\n', encoding="utf-8")
        self.assertEqual([e["ts"] for e in sup.journal_events(self.directory)],
                         ["1"])

    def test_journal_absent_rend_une_liste_vide(self):
        self.assertEqual(sup.journal_events(self.directory), [])


class MergedTickets(RunJournalFixture):
    """Ce que le run s'impute comme mergé — l'autre moitié de la production (#278).

    Rien de tout cela n'existe sur `refs/heads` au moment de la mesure : la
    barrière squashe la PR, puis l'orchestrateur supprime la branche. Le journal
    du run est la seule trace qui reste, et c'est la seule qui impute le merge à
    un ticket plutôt qu'à une poussée venue de l'extérieur.
    """

    def test_seuls_les_statuts_merged_comptent(self):
        with self.journal({"ticket": 17, "status": "running"},
                          {"ticket": 17, "status": "pr_open", "pr": 275},
                          {"ticket": 17, "status": "ci_green"},
                          self.merged(17)):
            self.assertEqual(sup.merged_tickets(), {17})

    def test_deux_etapes_deux_tickets(self):
        """Les étapes 3 et 4 du run `s1-fondations-20260826-221632`, celles que
        le superviseur avait comptées stériles toutes les deux."""
        with self.journal(self.merged(17), self.merged(213)):
            self.assertEqual(sup.merged_tickets(), {17, 213})

    def test_un_merge_reinscrit_ne_compte_qu_une_fois(self):
        """`reconcile` peut réinscrire un merge déjà vu au début de la vague
        suivante. Un ensemble de numéros l'absorbe ; un décompte, non."""
        with self.journal(self.merged(213), self.merged(213, "issue close sur GitHub")):
            self.assertEqual(sup.merged_tickets(), {213})

    def test_un_evenement_de_run_sans_ticket_est_ignore(self):
        with self.journal({"status": "merged", "message": "sans ticket"},
                          self.merged(280)):
            self.assertEqual(sup.merged_tickets(), {280})

    def test_une_ligne_tronquee_n_emporte_pas_la_mesure(self):
        """Le journal s'écrit sans verrou, à plusieurs : une ligne coupée par une
        écriture concurrente se saute, elle ne fait pas mourir le superviseur."""
        path = self.directory / "journal.ndjson"
        path.write_text(json.dumps(self.merged(17)) + "\n{\"ticket\": 213, \"sta\n"
                        + json.dumps(self.merged(220)) + "\n", encoding="utf-8")
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            self.assertEqual(sup.merged_tickets(), {17, 220})

    def test_aucun_run_ouvert(self):
        with mock.patch.object(sup, "current_run_dir", return_value=None):
            self.assertEqual(sup.merged_tickets(), set())

    def test_journal_absent(self):
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            self.assertEqual(sup.merged_tickets(), set())


class LegProduction(RunJournalFixture):
    """Ce qu'une étape a rendu durable, commits **et** merges réunis (#278)."""

    def test_merge_en_squash_branche_supprimee_n_est_pas_sterile(self):
        """La régression de #278, de bout en bout.

        L'étape mène #17 jusqu'au merge : la barrière squashe, l'orchestrateur
        supprime la branche et le worktree. Au moment de la mesure, `refs/heads`
        ne porte plus que les branches d'intégration — `work_commits()` rend donc
        l'ensemble vide, et c'est normal. C'est le journal du run qui témoigne.

        Avant le correctif, l'étape la plus productive du run était comptée
        stérile ; deux de suite ouvraient un arbitrage `leg_sterile` pour un
        enlisement qui n'existait pas.
        """
        with mock.patch.object(sup, "git_lines",
                               return_value=["develop", "staging", "main"]), \
                self.journal(self.merged(17)):
            commits, merges = sup.leg_production(set(), set())

        self.assertEqual(commits, set())          # la branche a disparu
        self.assertEqual(merges, {17})            # le merge, lui, reste imputable
        self.assertEqual(sup.sterile_streak(1, commits or merges, None), 0)

    def test_deux_etapes_qui_mergent_ne_declenchent_pas_l_arret(self):
        """Les étapes 3 et 4 du run, rejouées : le compteur ne doit jamais
        atteindre `DRY_LEGS_LIMIT`."""
        streak, seen_commits, seen_merges = 0, set(), set()
        for ticket in (17, 213):
            with mock.patch.object(sup, "git_lines", return_value=["develop"]), \
                    self.journal(*[self.merged(n) for n in (17, 213)
                                   if n <= ticket]):
                commits, merges = sup.leg_production(seen_commits, seen_merges)
            seen_commits |= commits
            seen_merges |= merges
            streak = sup.sterile_streak(streak, commits or merges, None)
            self.assertEqual(streak, 0)
        self.assertLess(streak, sup.DRY_LEGS_LIMIT)

    def test_un_merge_deja_vu_ne_rend_pas_l_etape_productive(self):
        """Un merge inscrit avant l'étape n'est l'œuvre d'aucun leg : le
        recompter ferait passer une étape vide pour une étape productive."""
        with mock.patch.object(sup, "git_lines", return_value=["develop"]), \
                self.journal(self.merged(17)):
            commits, merges = sup.leg_production(set(), {17})

        self.assertEqual((commits, merges), (set(), set()))
        self.assertEqual(sup.sterile_streak(0, commits or merges, None), 1)

    def test_ni_commit_ni_merge_reste_sterile(self):
        """Le garde-fou de #138 tient : c'est bien l'absence des deux qui compte."""
        with mock.patch.object(sup, "git_lines", return_value=["develop"]), \
                self.journal({"ticket": 42, "status": "running"}):
            commits, merges = sup.leg_production(set(), set())

        self.assertEqual((commits, merges), (set(), set()))
        streak = 0
        for _ in range(2):
            streak = sup.sterile_streak(streak, commits or merges, None)
        self.assertGreaterEqual(streak, sup.DRY_LEGS_LIMIT)

    def test_les_commits_neufs_restent_comptes(self):
        """Une étape qui commite sans merger reste productive, comme avant."""
        def fake(*argv):
            if argv[0] == "for-each-ref":
                return ["develop", "bugfix/278-mesure"]
            return ["aaa111"]

        with mock.patch.object(sup, "git_lines", side_effect=fake), \
                self.journal({"ticket": 278, "status": "pr_open", "pr": 999}):
            commits, merges = sup.leg_production(set(), set())

        self.assertEqual((commits, merges), ({"aaa111"}, set()))
        self.assertEqual(sup.sterile_streak(1, commits or merges, None), 0)


class ProductionNote(unittest.TestCase):
    """Ce que la ligne de fin d'étape donne à lire (#278).

    « 32 tours · 5.87 $ · 0 commit(s) » sur une étape qui venait de merger #213
    est ce qu'un humain avait sous les yeux en cherchant pourquoi le dispositif
    s'était arrêté. La ligne doit dire les deux.
    """

    def test_les_deux_moities_sont_dites(self):
        self.assertEqual(sup.production_note({"aaa111"}, {17}),
                         "1 commit(s), 1 merge(s)")

    def test_une_etape_qui_merge_sans_commiter_ne_dit_plus_zero_seul(self):
        note = sup.production_note(set(), {17})
        self.assertEqual(note, "0 commit(s), 1 merge(s)")
        self.assertIn("merge", note)

    def test_une_etape_vide_le_dit_aussi(self):
        self.assertEqual(sup.production_note(set(), set()),
                         "0 commit(s), 0 merge(s)")


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


class ParseScopes(unittest.TestCase):
    """`--merge-sensitive` — l'autorisation donnée à l'avance, validée à l'armement.

    C'est ici, et seulement ici, qu'un humain est encore devant le terminal :
    une faute de frappe qui passerait serait ensuite muette et inerte dans
    `pr_gate.py` — elle n'ouvrirait rien, et personne ne saurait pourquoi la PR
    est restée ouverte.
    """

    def test_valeur_absente_n_autorise_rien(self):
        self.assertEqual(sup.parse_scopes(""), (set(), []))
        self.assertEqual(sup.parse_scopes(None), (set(), []))

    def test_cles_connues(self):
        scopes, unknown = sup.parse_scopes("infra/terraform,prisma")
        self.assertEqual(scopes, {"infra/terraform", "prisma"})
        self.assertEqual(unknown, [])

    def test_espaces_et_casse_tolerees(self):
        scopes, unknown = sup.parse_scopes(" INFRA/Terraform ,  PRISMA ")
        self.assertEqual(scopes, {"infra/terraform", "prisma"})
        self.assertEqual(unknown, [])

    def test_all_prend_tout(self):
        scopes, unknown = sup.parse_scopes(sup.ALL_SCOPES)
        self.assertEqual(scopes, set(sup.SCOPE_KEYS))
        self.assertEqual(unknown, [])

    def test_cle_inconnue_est_rendue_et_n_ouvre_rien(self):
        scopes, unknown = sup.parse_scopes("terraform")
        self.assertEqual(scopes, set())
        self.assertEqual(unknown, ["terraform"])

    def test_le_bon_grain_passe_et_l_ivraie_est_nommee(self):
        scopes, unknown = sup.parse_scopes("infra/terraform,paiements")
        self.assertEqual(scopes, {"infra/terraform"})
        self.assertEqual(unknown, ["paiements"])

    def test_les_cles_sont_celles_de_la_barriere(self):
        """Recopier la liste ferait diverger l'armement de ce que refuse la
        barrière — et c'est le message que l'opérateur ne peut pas vérifier."""
        for key in ("mod:payments", "security", "infra/terraform",
                    "apps/api/src/modules/payments", "prisma"):
            with self.subTest(cle=key):
                self.assertIn(key, sup.SCOPE_KEYS)


class IntentPersistence(unittest.TestCase):
    """Le réglage survit à la reprise — sinon il ne sert qu'au premier leg.

    Un superviseur ressuscité par la tâche planifiée n'a personne à qui
    redemander l'autorisation : sans rejeu, un run armé cesserait de merger au
    premier redémarrage, silencieusement.
    """

    def intent(self, **fields):
        base = {"milestone": "S1 — Fondations", "width": 3, "waves_per_leg": 1,
                "no_merge": False, "merge_sensitive": [], "claude": "claude"}
        base.update(fields)
        return base

    def test_les_perimetres_sont_rejoues_dans_la_ligne_de_commande(self):
        argv = sup.intent_argv(
            self.intent(merge_sensitive=["infra/terraform", "prisma"]))
        self.assertIn("--merge-sensitive", argv)
        self.assertEqual(argv[argv.index("--merge-sensitive") + 1],
                         "infra/terraform,prisma")

    def test_sans_perimetre_aucun_drapeau(self):
        self.assertNotIn("--merge-sensitive", sup.intent_argv(self.intent()))

    def test_intention_ancienne_sans_le_champ(self):
        """Un `supervisor.json` écrit avant #156 n'a pas le champ : il ne doit
        ni lever, ni se mettre à autoriser quoi que ce soit."""
        old = self.intent()
        del old["merge_sensitive"]
        self.assertNotIn("--merge-sensitive", sup.intent_argv(old))

    def test_l_aller_retour_par_le_disque_conserve_le_reglage(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        args = argparse.Namespace(
            milestone="S1 — Fondations", width=3, waves_per_leg=1,
            no_merge=False, merge_sensitive={"prisma", "infra/terraform"},
            permission_mode="acceptEdits", model=None, margin=90, patience=2,
            max_legs=40, leg_timeout=120, claude="claude")
        with mock.patch.object(sup, "INTENT", Path(tmp.name) / "supervisor.json"):
            sup.save_intent(args)
            reloaded = sup.load_intent()
        self.assertEqual(reloaded["merge_sensitive"],
                         ["infra/terraform", "prisma"])
        # La coupure au temps se rejoue comme le reste : un superviseur
        # ressuscité par la veille doit borner ses étapes comme le premier.
        self.assertEqual(reloaded["leg_timeout"], 120)
        argv = sup.intent_argv(reloaded)
        self.assertEqual(argv[argv.index("--leg-timeout") + 1], "120")
        self.assertEqual(argv[argv.index("--merge-sensitive") + 1],
                         "infra/terraform,prisma")



class NatureRejouee(unittest.TestCase):
    """La nature se rejoue comme la largeur — sinon la reprise change de file.

    Un superviseur ressuscité par la veille sur un run d'outillage repartirait
    sur le produit : non pas un run dégradé, mais un tout autre plan, avec des
    agents lancés sur des tickets que personne n'a demandés.
    """

    def args(self, **fields):
        base = dict(milestone="S1 — Fondations", width=1, waves_per_leg=1,
                    no_merge=False, merge_sensitive=set(),
                    permission_mode="acceptEdits", model=None, margin=90,
                    patience=2, max_legs=40, leg_timeout=120, claude="claude",
                    nature="outillage", yes=True)
        base.update(fields)
        return argparse.Namespace(**base)

    def test_la_nature_traverse_le_disque_et_revient_en_ligne_de_commande(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with mock.patch.object(sup, "INTENT", Path(tmp.name) / "supervisor.json"):
            sup.save_intent(self.args())
            reloaded = sup.load_intent()
        self.assertEqual(reloaded["nature"], "outillage")
        argv = sup.intent_argv(reloaded)
        self.assertEqual(argv[argv.index("--nature") + 1], "outillage")

    def test_une_intention_ancienne_sans_le_champ_vaut_produit(self):
        """Un `supervisor.json` écrit avant ce ticket n'a pas le champ : il ne
        doit ni lever, ni se mettre à dérouler l'outillage tout seul."""
        argv = sup.intent_argv({"milestone": "S1", "width": 3})
        self.assertEqual(argv[argv.index("--nature") + 1], "projet")

    def test_la_vague_relancee_deroule_la_meme_nature(self):
        """Sans cela, la vague relancée par le superviseur repartirait sur le
        produit et ouvrirait un second run à côté du sien."""
        self.assertIn("--nature outillage", sup.leg_prompt(self.args()))

    def test_un_run_produit_ne_porte_pas_le_drapeau(self):
        self.assertNotIn("--nature", sup.leg_prompt(self.args(nature="projet")))


class ArmementQuiChangeDeNature(unittest.TestCase):
    """Il n'y a qu'une intention, donc qu'une nature armée à la fois.

    Ouvrir un run d'outillage remplace l'armement du run produit : c'est
    tenable — les deux files ne se déroulent pas ensemble — mais le taire ferait
    croire à un run produit qui repart tout seul alors que plus rien ne le
    relance.
    """

    def test_changer_de_nature_previent_et_nomme_les_deux(self):
        message = sup.nature_relayed(
            {"nature": "projet", "milestone": "S2 — Réservation"}, "outillage")
        self.assertIsNotNone(message)
        self.assertIn("projet", message)
        self.assertIn("outillage", message)
        self.assertIn("S2 — Réservation", message)

    def test_rearmer_la_meme_nature_ne_dit_rien(self):
        self.assertIsNone(
            sup.nature_relayed({"nature": "outillage"}, "outillage"))

    def test_une_intention_ancienne_compte_pour_du_produit(self):
        """Sans le champ, l'armement venait d'un dispositif qui ne savait
        dérouler que le produit : passer à l'outillage relaie bien une file."""
        self.assertIsNone(sup.nature_relayed({"milestone": "S1"}, "projet"))
        self.assertIsNotNone(sup.nature_relayed({"milestone": "S1"}, "outillage"))

    def test_un_premier_armement_ne_relaie_personne(self):
        self.assertIsNone(sup.nature_relayed(None, "outillage"))
        self.assertIsNone(sup.nature_relayed({}, "outillage"))


class DescribeScopes(unittest.TestCase):
    """Ce que `--state` doit dire : les périmètres, nommés — jamais un décompte.

    « Qui a autorisé quoi, et quand » ne se répond pas avec « 2 périmètres ».
    """

    def test_aucun_perimetre(self):
        self.assertIn("aucun", sup.describe_scopes({"merge_sensitive": []}))

    def test_les_perimetres_sont_nommes(self):
        described = sup.describe_scopes(
            {"merge_sensitive": ["infra/terraform", "prisma"]})
        self.assertIn("infra/terraform", described)
        self.assertIn("prisma", described)

    def test_no_merge_rend_la_question_sans_objet(self):
        self.assertIn("sans objet", sup.describe_scopes(
            {"no_merge": True, "merge_sensitive": ["prisma"]}))

    def test_aucune_intention(self):
        self.assertIn("aucun", sup.describe_scopes(None))


class AnnounceMergePolicy(unittest.TestCase):
    """La bannière d'armement — la seule trace qu'un humain ait dit oui.

    Elle est lue à l'instant où l'opérateur cesse de regarder : c'est le message
    qu'il ne peut plus vérifier, et celui auquel on demandera plus tard « qui a
    autorisé quoi, et quand ».
    """

    def banner(self, **fields):
        args = argparse.Namespace(no_merge=False, merge_sensitive=set())
        for key, value in fields.items():
            setattr(args, key, value)
        lines = []
        with mock.patch.object(sup, "say",
                               lambda message, level="INFO": lines.append(
                                   (level, message))):
            sup.announce_merge_policy(args)
        return lines

    def warnings(self, **fields):
        return [message for level, message in self.banner(**fields)
                if level == "WARN"]

    def test_les_perimetres_autorises_sont_nommes_en_warn(self):
        warned = " | ".join(self.warnings(
            merge_sensitive={"infra/terraform", "prisma"}))
        self.assertIn("infra/terraform", warned)
        self.assertIn("prisma", warned)

    def test_ce_qui_reste_sous_relecture_est_nomme_aussi(self):
        """Dire ce qui est ouvert sans dire ce qui reste fermé laisse
        l'opérateur deviner la moitié de la réponse."""
        warned = " | ".join(self.warnings(merge_sensitive={"infra/terraform"}))
        self.assertIn("mod:payments", warned)

    def test_sans_pre_autorisation_rien_n_est_annonce_comme_ouvert(self):
        warned = " | ".join(self.warnings())
        self.assertNotIn("SERONT mergés", warned)
        for key in sup.SCOPE_KEYS:
            with self.subTest(cle=key):
                self.assertIn(key, warned)

    def test_no_merge_n_annonce_aucune_autorisation(self):
        self.assertEqual(self.warnings(no_merge=True), [])


class MergeSensitiveCommandLine(unittest.TestCase):
    """Le parcours complet, par la ligne de commande — ce que tape l'opérateur."""

    def supervise(self, *argv):
        return subprocess.run(
            [sys.executable, str(sup.ROOT / "scripts" / "milestone_supervise.py")]
            + list(argv), capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=60)

    def test_cle_inconnue_refusee_a_l_armement(self):
        proc = self.supervise("--merge-sensitive", "terraform", "--state")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("périmètre inconnu", proc.stderr)

    def test_contradiction_avec_no_merge_refusee(self):
        """Deux consignes qui s'opposent : en appliquer une en silence, c'est
        choisir à la place de l'opérateur sur le seul réglage qu'il ait posé."""
        proc = self.supervise("--merge-sensitive", "prisma", "--no-merge",
                              "--state")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("contredisent", proc.stderr)

    def test_cle_connue_acceptee(self):
        proc = self.supervise("--merge-sensitive", "infra/terraform", "--state")
        self.assertEqual(proc.returncode, 0)


class EnvironnementDAppel(unittest.TestCase):
    """Ce que l'appel hérite, et pourquoi ce n'est pas le même pour une étape et
    pour un arbitrage.

    `SPA_LEG_START` fait requeuer par `reconcile` les tickets restés `running` :
    c'est juste au début d'une vague, dont les agents précédents sont morts. Le
    poser sur un arbitrage lui retirerait sous les pieds ce qu'il vient examiner.
    """

    def env(self, leg_start, no_merge=False, scopes=()):
        """L'environnement composé, à partir d'un environnement **vide**.

        `call_env` part de `os.environ` : lu tel quel, ce test dirait « posée »
        d'une variable simplement héritée du terminal — et resterait vert le jour
        où le code cesserait de la poser. Un superviseur lancé depuis un autre
        superviseur hérite précisément de `SPA_UNATTENDED` et `SPA_LEG_START`.
        """
        args = argparse.Namespace(no_merge=no_merge, merge_sensitive=set(scopes))
        with mock.patch.dict(os.environ, {}, clear=True):
            return sup.call_env(args, leg_start=leg_start)

    def test_une_etape_annonce_son_demarrage(self):
        self.assertEqual(self.env(leg_start=True)["SPA_LEG_START"], "1")

    def test_un_arbitrage_ne_l_annonce_pas(self):
        self.assertNotIn("SPA_LEG_START", self.env(leg_start=False))

    def test_sans_surveillance_est_pose_des_qu_on_merge(self):
        self.assertEqual(self.env(leg_start=True)["SPA_UNATTENDED"], "1")

    def test_no_merge_ne_pose_pas_sans_surveillance(self):
        self.assertNotIn("SPA_UNATTENDED",
                         self.env(leg_start=True, no_merge=True))

    def test_la_pre_autorisation_est_toujours_posee(self):
        """Même vide : ne la poser que sur une branche laisserait passer telle
        quelle une variable héritée de l'environnement de l'appelant."""
        self.assertEqual(self.env(leg_start=False, no_merge=True)[sup.AUTHORISED_ENV],
                         "")

    def test_les_perimetres_sont_transmis_tries(self):
        env = self.env(leg_start=True, scopes=["prisma", "infra/terraform"])
        self.assertEqual(env[sup.AUTHORISED_ENV], "infra/terraform,prisma")


class SilenceDUneEtape(unittest.TestCase):
    """La coupure au temps borne l'attente à deux heures. Le journal muet dit
    bien avant qu'une étape est morte debout : une phase de ticket dure quelques
    minutes, jamais vingt-cinq."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name) / "r1"
        self.directory.mkdir()
        self.journal = self.directory / "journal.ndjson"

    def quiet(self, age=None, since=None):
        if age is not None:
            self.journal.write_text("{}\n", encoding="utf-8")
            os.utime(self.journal, (time.time() - age, time.time() - age))
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            return sup.journal_quiet(since)

    def test_un_journal_frais_ne_dit_aucun_silence(self):
        self.assertLess(self.quiet(age=5), 60)

    def test_un_journal_vieux_donne_son_age(self):
        self.assertGreater(self.quiet(age=3000), 2900)

    def test_le_silence_est_borne_au_demarrage_de_l_appel(self):
        """Sans cela, une étape qui n'a encore rien écrit hériterait du silence
        de la précédente et serait coupée dans la minute."""
        self.assertLess(self.quiet(age=3000, since=time.time() - 10), 60)

    def test_aucun_run_ouvert(self):
        with mock.patch.object(sup, "current_run_dir", return_value=None):
            self.assertIsNone(sup.journal_quiet())

    def test_journal_absent(self):
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            self.assertIsNone(sup.journal_quiet())

    def test_le_guetteur_coupe_au_dela_du_seuil(self):
        args = argparse.Namespace(stall_minutes=1)
        with mock.patch.object(sup, "journal_quiet", return_value=120):
            self.assertIn("muet", sup.stall_watch(args)())

    def test_le_guetteur_laisse_travailler_en_deca(self):
        args = argparse.Namespace(stall_minutes=25)
        with mock.patch.object(sup, "journal_quiet", return_value=120):
            self.assertIsNone(sup.stall_watch(args)())

    def test_le_guetteur_se_debranche_a_zero(self):
        self.assertIsNone(sup.stall_watch(argparse.Namespace(stall_minutes=0)))


class ArbitrageRejoue(unittest.TestCase):
    """Un superviseur ressuscité par la veille doit trancher comme celui qu'il
    remplace : l'arbitrage se rejoue comme le reste, sinon un run armé perd sa
    capacité de décision au premier redémarrage — le moment où elle sert."""

    def intent(self, **fields):
        base = {"milestone": "S1", "width": 3, "waves_per_leg": 1,
                "no_merge": False, "merge_sensitive": [], "claude": "claude"}
        base.update(fields)
        return base

    def test_le_modele_de_l_arbitre_est_rejoue(self):
        argv = sup.intent_argv(self.intent(arbiter_model="claude-opus-5"))
        self.assertEqual(argv[argv.index("--arbiter-model") + 1], "claude-opus-5")

    def test_une_intention_sans_le_champ_retombe_sur_le_defaut(self):
        """Un `supervisor.json` écrit avant l'arbitre n'a pas le champ : il ne
        doit ni faire échouer la relance, ni la laisser sans arbitrage."""
        argv = sup.intent_argv(self.intent())
        self.assertEqual(argv[argv.index("--arbiter-model") + 1], sup.ARBITER_MODEL)
        self.assertNotIn("--no-arbiter", argv)

    def test_l_arbitrage_debranche_le_reste(self):
        self.assertIn("--no-arbiter", sup.intent_argv(self.intent(no_arbiter=True)))

    def test_le_budget_et_le_silence_sont_rejoues(self):
        argv = sup.intent_argv(self.intent(arbiter_budget=4, stall_minutes=10))
        self.assertEqual(argv[argv.index("--arbiter-budget") + 1], "4")
        self.assertEqual(argv[argv.index("--stall-minutes") + 1], "10")


class DemandeDArbitrage(unittest.TestCase):
    """`should` est ce qu'on lit avant de dépenser un tour d'Opus 5. Débranché,
    le superviseur doit retrouver exactement son comportement d'avant."""

    def args(self, no_arbiter=False):
        return argparse.Namespace(no_arbiter=no_arbiter, arbiter_budget=12)

    def test_debranche_on_ne_demande_rien(self):
        with mock.patch.object(sup.subprocess, "run") as called:
            self.assertIsNone(sup.arbiter_should(self.args(no_arbiter=True), []))
        called.assert_not_called()

    def test_rien_a_arbitrer_rend_none(self):
        done = mock.Mock(returncode=1, stdout="rien à arbitrer\n")
        with mock.patch.object(sup.subprocess, "run", return_value=done):
            self.assertIsNone(sup.arbiter_should(self.args(), []))

    def test_un_motif_est_rendu_tel_quel(self):
        done = mock.Mock(returncode=0, stdout="tickets_tombes — #21 en échec\n")
        with mock.patch.object(sup.subprocess, "run", return_value=done):
            self.assertIn("tickets_tombes", sup.arbiter_should(self.args(), []))

    def test_un_dossier_indisponible_ne_bloque_pas_le_run(self):
        """Un dossier qu'on ne sait pas constituer fait retomber le superviseur
        sur son comportement d'avant — il ne fait pas mourir le run."""
        with mock.patch.object(sup.subprocess, "run",
                               side_effect=OSError("python introuvable")):
            self.assertIsNone(sup.arbiter_should(self.args(), []))

    def test_les_motifs_sont_transmis_au_dossier(self):
        done = mock.Mock(returncode=0, stdout="leg_delai — coupée\n")
        with mock.patch.object(sup.subprocess, "run", return_value=done) as called:
            sup.arbiter_should(self.args(), ["leg_delai", "patience"])
        argv = called.call_args[0][0]
        self.assertEqual(argv.count("--reason"), 2)
        self.assertIn("patience", argv)


class BattementDansLeJournalDuRun(unittest.TestCase):
    """Le second volet de #186 : couvrir le silence sans le combler.

    Entre deux vagues, plus personne n'écrit dans le journal du run pendant
    quinze à vingt-cinq minutes — un run mort s'y lit comme un run au travail.
    Le superviseur y pose donc une ligne toutes les cinq minutes, et deux
    exigences se tiennent en tension :

    - elle doit **paraître** — sinon le silence reste illisible ;
    - elle ne doit pas **compter** — sinon `journal_quiet()` la lirait comme une
      activité, le guetteur des vingt-cinq minutes ne couperait plus jamais une
      étape morte debout, et l'on aurait échangé un silence illisible contre un
      silence invisible.

    C'est la marque `beat` qui tient les deux, et c'est elle qu'on vérifie ici.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.journal = self.directory / "journal.ndjson"

    def write(self, *events):
        stamp = None
        with open(self.journal, "w", encoding="utf-8") as handle:
            for age, beat in events:
                stamp = time.time() - age
                event = {"ts": datetime.fromtimestamp(stamp, timezone.utc)
                         .isoformat(timespec="seconds"), "kind": "run",
                         "message": "…"}
                if beat:
                    event["beat"] = True
                handle.write(json.dumps(event) + "\n")
        # Le mtime suit forcément la dernière écriture, comme sur un vrai run :
        # c'est justement lui qui trompait la mesure avant la marque.
        os.utime(self.journal, (stamp, stamp))

    def quiet(self):
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            return sup.journal_quiet()

    def test_le_silence_se_mesure_sur_le_dernier_evenement_reel(self):
        """Trois battements posés depuis, et pourtant le journal est muet depuis
        vingt minutes : c'est ce que le guetteur doit lire."""
        self.write((1200, False), (900, True), (600, True), (300, True))
        self.assertGreater(self.quiet(), 1100)

    def test_un_evenement_ordinaire_rompt_bien_le_silence(self):
        self.write((1200, False), (30, False))
        self.assertLess(self.quiet(), 120)

    def test_un_journal_sans_horodatage_retombe_sur_le_mtime(self):
        """Le repli garde sa valeur : mieux vaut une mesure grossière qu'aucune."""
        self.journal.write_text("{}\n", encoding="utf-8")
        stamp = time.time() - 900
        os.utime(self.journal, (stamp, stamp))
        self.assertGreater(self.quiet(), 800)

    def test_le_guetteur_coupe_malgre_les_battements(self):
        """La régression qu'on ne verrait pas autrement : une étape morte debout
        que le battement du superviseur ferait passer pour vivante."""
        self.write((1800, False), (300, True))
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            # Le guetteur borne sa mesure au démarrage de l'appel : on le fait
            # naître il y a une demi-heure, comme l'étape qu'il surveille.
            with mock.patch.object(sup.time, "time",
                                   return_value=time.time() - 1800):
                look = sup.stall_watch(argparse.Namespace(stall_minutes=25))
            self.assertIn("muet", look())

    def test_un_battement_ne_fait_pas_croire_que_quelqu_un_orchestre(self):
        """`supervisor_alive()` dit déjà la présence du superviseur. Compter son
        battement ici retarderait de dix minutes la relance d'un superviseur tué
        juste après avoir battu."""
        self.write((sup.ORCHESTRATOR_QUIET + 300, False), (10, True))
        with mock.patch.object(sup, "current_run_dir", return_value=self.directory):
            self.assertFalse(sup.orchestrator_active())


class CeQueLeBattementEcrit(unittest.TestCase):
    """Quand il parle, et ce qu'il dit."""

    def tick(self, quiet, age=0.0, stall_minutes=25):
        posted = []
        with mock.patch.object(sup, "journal_quiet", return_value=quiet), \
             mock.patch.object(sup, "journal",
                               side_effect=lambda *a, **k: posted.append((a, k))):
            beat = sup.beat_watch("étape", time.time() - age, stall_minutes)
            beat()
            beat()          # deux tours de minute d'affilée
        return posted

    def test_un_journal_vivant_ne_declenche_aucun_battement(self):
        """On ne double personne : tant que les agents journalisent leurs
        phases, le battement se tait."""
        self.assertEqual(self.tick(quiet=60), [])

    def test_un_journal_muet_declenche_un_battement_et_un_seul(self):
        posted = self.tick(quiet=sup.JOURNAL_BEAT + 60, age=900)
        self.assertEqual(len(posted), 1)

    def test_la_ligne_dit_l_age_du_silence_et_l_echeance(self):
        (args, fields), = self.tick(quiet=900, age=900)
        message = args[1]
        self.assertIn("en vol depuis", message)
        self.assertIn("muet depuis", message)
        self.assertIn("coupure à 25 min", message)
        self.assertIsNone(args[0])          # aucun statut : ce n'est pas un état
        self.assertTrue(fields["beat"])
        self.assertEqual(fields["level"], "DEBUG")

    def test_sans_guetteur_aucune_echeance_n_est_annoncee(self):
        """L'arbitrage n'a pas de coupure au silence : annoncer la sienne serait
        annoncer celle d'une autre étape."""
        (args, _), = self.tick(quiet=900, age=900, stall_minutes=None)
        self.assertNotIn("coupure", args[1])

    def test_un_journal_illisible_ne_fait_pas_battre(self):
        self.assertEqual(self.tick(quiet=None), [])


if __name__ == "__main__":
    unittest.main()
