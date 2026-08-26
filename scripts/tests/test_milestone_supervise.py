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
import argparse
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


if __name__ == "__main__":
    unittest.main()
