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

S'y ajoute depuis #369 la dérive de la source : le superviseur est le seul
processus long du dispositif, et un correctif que le run merge lui-même reste
inerte jusqu'au redémarrage. Le signal est faux tant que le processus vivant
mesure avec l'ancien code — et c'est ce qui a consommé sept des douze arbitrages
du run du 1er septembre, alors que neuf tickets y avaient abouti.

#373 y ajoute l'acte : le superviseur se **recharge** par `os.execv()` au lieu
de se contenter de le dire. Ce qui est vérifié ici est autant le rechargement
que ses refus — un `execv` fait au mauvais moment tue le `claude -p` dont le
superviseur est le parent, et un `execv` qui perd `--max-legs` rend au run un
budget d'étapes entier à chaque correctif. `reload_source` n'est jamais appelée
telle quelle par ces tests : c'est `why_not_reload`, sa moitié qui décide, qui
porte les cas — un banc d'essai qui se remplace par un superviseur ne rend
jamais son verdict.

Aucune dépendance : `unittest` de la bibliothèque standard, comme
`test_pr_gate.py`.
"""
import argparse
import contextlib
import inspect
import io
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


class SourceDrift(unittest.TestCase):
    """Le superviseur voit-il que son propre code a changé sous lui ? (#369)

    Il est le seul processus long du dispositif : la boucle des étapes vit en
    mémoire, et un correctif que le run merge lui-même sur `develop` reste
    inerte jusqu'au redémarrage. C'est ainsi que l'étape 8 du run
    `s1-fondations-outillage-20260901-221219`, qui venait de mener #278 — le
    ticket qui corrige « une étape qui merge est comptée stérile » — jusqu'au
    merge, s'est déclarée stérile neuf minutes plus tard, en écrivant
    « 0 commit(s) », le format d'avant le correctif qu'elle venait de merger.

    Rien ici ne recharge quoi que ce soit : ce qui est vérifié est le détecteur
    et son annonce. L'acte — le re-`execv()` de #373 — est couvert par
    `RechargementDeLaSource`, plus bas. L'annonce lui survit et n'est pas
    redondante : elle reste le seul recours quand le rechargement est refusé,
    et elle dit alors quoi faire à la main.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / "milestone_supervise.py"
        self.source.write_text("# version 1\n", encoding="utf-8")

    # -- l'empreinte -------------------------------------------------------- #

    def test_une_source_inchangee_rend_deux_fois_la_meme_empreinte(self):
        self.assertEqual(sup.source_fingerprint(self.source),
                         sup.source_fingerprint(self.source))

    def test_un_contenu_modifie_change_l_empreinte(self):
        avant = sup.source_fingerprint(self.source)
        self.source.write_text("# version 2\n", encoding="utf-8")
        self.assertNotEqual(sup.source_fingerprint(self.source), avant)

    def test_un_contenu_reecrit_a_l_identique_ne_change_rien(self):
        """`git pull` et `git checkout` réécrivent les fichiers qu'ils
        traversent, même pour y remettre le même contenu. Une empreinte fondée
        sur la date d'écriture annoncerait là un correctif qui n'existe pas —
        et un `WARN` de trop est celui qui fait cesser de les lire."""
        avant = sup.source_fingerprint(self.source)
        plus_tard = time.time() + 120
        self.source.write_text("# version 1\n", encoding="utf-8")
        os.utime(self.source, (plus_tard, plus_tard))
        self.assertEqual(sup.source_fingerprint(self.source), avant)

    def test_une_source_illisible_rend_none(self):
        self.assertIsNone(
            sup.source_fingerprint(Path(self.tmp.name) / "absent.py"))

    def test_le_superviseur_sait_lire_sa_propre_source(self):
        """Sans argument, c'est bien ce fichier-ci qui est mesuré — pas le
        répertoire courant, qui est celui du worktree d'un agent."""
        self.assertEqual(sup.SOURCE.name, "milestone_supervise.py")
        self.assertIsNotNone(sup.source_fingerprint())

    # -- la comparaison ----------------------------------------------------- #

    def test_deux_empreintes_egales_ne_derivent_pas(self):
        self.assertFalse(sup.source_drifted("aaa", "aaa"))

    def test_deux_empreintes_differentes_derivent(self):
        self.assertTrue(sup.source_drifted("aaa", "bbb"))

    def test_une_empreinte_inconnue_ne_derive_jamais(self):
        """L'inconnu ne prouve aucun changement : un fichier illisible d'un côté
        ou de l'autre ferait chercher un correctif jamais mergé."""
        self.assertFalse(sup.source_drifted(None, "bbb"))
        self.assertFalse(sup.source_drifted("aaa", None))
        self.assertFalse(sup.source_drifted(None, None))

    # -- l'annonce de fin d'étape ------------------------------------------- #

    def announce(self, before, now):
        """L'annonce, ses lignes de journal — et le journal du superviseur muet.

        `say()` est neutralisé pour la même raison que `SUPERVISOR_LOG` l'est
        pour tout le module : une alerte fabriquée par un test n'a rien à faire
        sous les yeux de qui lit le déroulé d'un run.
        """
        posted = []
        with mock.patch.object(sup, "source_fingerprint", return_value=now), \
             mock.patch.object(sup, "say") as dit_tout_haut, \
             mock.patch.object(sup, "journal",
                               side_effect=lambda *a, **k: posted.append((a, k))):
            dit = sup.announce_source_drift(before)
        self.spoken = dit_tout_haut.call_args_list
        return dit, posted

    def test_une_source_stable_ne_journalise_rien(self):
        dit, posted = self.announce("aaa", "aaa")
        self.assertFalse(dit)
        self.assertEqual(posted, [])

    def test_une_source_changee_est_journalisee_en_warn(self):
        dit, posted = self.announce("aaa", "bbb")
        self.assertTrue(dit)
        self.assertEqual(len(posted), 1)
        (args, fields), = posted
        self.assertIsNone(args[0])          # aucun statut : ce n'est pas un état
        self.assertEqual(fields["level"], "WARN")
        # Et dans le journal du superviseur aussi : les deux n'ont pas les mêmes
        # lecteurs, celui qui regarde le dispositif n'ouvre pas celui du jalon.
        self.assertEqual(len(self.spoken), 1)
        self.assertEqual(self.spoken[0].args[1], "WARN")

    def test_le_message_dit_qu_un_redemarrage_est_necessaire(self):
        """C'est le seul contenu qui compte : l'humain venu comprendre pourquoi
        le dispositif s'entêtait doit lire quoi faire, pas seulement qu'il se
        passe quelque chose."""
        _, posted = self.announce("aaa", "bbb")
        message = posted[0][0][1]
        self.assertIn("redémarrer", message.lower())
        self.assertIn("milestone_supervise.py", message)
        self.assertIn("depuis son démarrage", message)

    def test_l_ecart_est_redit_a_chaque_etape(self):
        """La phrase reste vraie jusqu'au redémarrage, et celui qui vient lire
        le journal arrive rarement à l'étape où l'écart est apparu."""
        for _ in range(3):
            dit, posted = self.announce("aaa", "bbb")
            self.assertTrue(dit)
            self.assertEqual(len(posted), 1)

    def test_une_source_devenue_illisible_ne_declenche_pas_d_alerte(self):
        dit, posted = self.announce("aaa", None)
        self.assertFalse(dit)
        self.assertEqual(posted, [])

    # -- le câblage --------------------------------------------------------- #

    def test_la_boucle_retient_l_empreinte_et_la_compare_en_fin_d_etape(self):
        """Un détecteur que personne n'appelle ne détecte rien — c'est la seule
        façon dont ce correctif peut régresser sans qu'aucun autre test ne
        bouge. L'empreinte est prise **avant** la boucle et comparée dedans."""
        code = inspect.getsource(sup.supervise)
        avant, borne, dedans = code.partition("while not stop_flag.is_set():")
        indice = ("ce test lit le texte de supervise() : un renommage de la "
                  "boucle ou de `source_seen` le casse sans que rien ne soit "
                  "cassé — recoller le test au code, ou le remplacer")
        self.assertTrue(borne, indice)
        self.assertIn("source_seen = source_fingerprint()", avant, indice)
        self.assertIn("announce_source_drift(source_seen)", dedans, indice)


class AppelsEnVol(unittest.TestCase):
    """Le registre des `claude -p` vivants — la condition du rechargement (#373).

    Le superviseur est le parent de l'appel qu'il lance : se remplacer par
    `execv` pendant qu'un enfant écrit dans son tube le tue, avec l'étape et les
    tickets qu'il portait. Le placement statique du rechargement suffit
    aujourd'hui à ce qu'il n'y en ait aucun ; ce registre en fait une condition
    vérifiée plutôt qu'une propriété du texte.
    """

    def setUp(self):
        sup._IN_FLIGHT.clear()
        self.addCleanup(sup._IN_FLIGHT.clear)

    def process(self, code=None):
        """Un faux processus : `poll()` est la seule chose qu'on lui demande."""
        return mock.Mock(poll=mock.Mock(return_value=code))

    def test_aucun_appel_lance_aucun_en_vol(self):
        self.assertFalse(sup.calls_in_flight())

    def test_un_appel_vivant_est_en_vol(self):
        sup.track_call(self.process(None))
        self.assertTrue(sup.calls_in_flight())

    def test_un_appel_termine_n_est_plus_en_vol(self):
        sup.track_call(self.process(0))
        self.assertFalse(sup.calls_in_flight())

    def test_un_appel_retire_n_est_plus_en_vol(self):
        vivant = self.process(None)
        sup.track_call(vivant)
        sup.untrack_call(vivant)
        self.assertFalse(sup.calls_in_flight())

    def test_une_inscription_oubliee_se_resorbe_a_la_mort_du_processus(self):
        """C'est `poll()` qui fait foi, pas l'appartenance au registre : une
        exception entre le `Popen` et la fin de la lecture du flux laisserait
        sinon le superviseur refuser de se recharger jusqu'à la fin du run."""
        fantome = self.process(1)
        sup.track_call(fantome)
        self.assertFalse(sup.calls_in_flight())
        self.assertNotIn(fantome, sup._IN_FLIGHT)

    def test_un_vivant_parmi_des_morts_suffit(self):
        for mort in (0, 1, 143):
            sup.track_call(self.process(mort))
        sup.track_call(self.process(None))
        self.assertTrue(sup.calls_in_flight())

    def test_l_appel_est_inscrit_et_retire_par_stream_call(self):
        """Un registre que personne n'alimente ne protège de rien. Lu dans le
        texte : le câbler pour de vrai demanderait de lancer un `claude -p`."""
        code = inspect.getsource(sup.stream_call)
        self.assertIn("track_call(process)", code)
        self.assertIn("untrack_call(process)", code)


class RechargementDeLaSource(unittest.TestCase):
    """Le superviseur se recharge quand sa source a changé (#373).

    #369 avait livré la moitié qui **voit**. Elle n'a servi à personne : aucun
    run ne lit ce `WARN`, et son seul lecteur possible est l'arbitre, qui
    n'arrive que sur le faux signal que la source périmée produit. Sept
    arbitrages sur douze consommés sur le run du 1er septembre, alors que neuf
    tickets y avaient abouti — et le budget épuisé appelle `retire()`.

    L'acte est un `os.execv()`. Il n'est jamais exécuté ici : un banc d'essai
    qui se remplace par un superviseur ne rend jamais son verdict. Ce qui est
    couvert est donc la décision (`why_not_reload`), le report de budget
    (`reload_intent`) et tout ce que `reload_source` fait **avant** de partir.
    """

    def args(self, **fields):
        base = dict(milestone="S1 — Fondations", width=1, nature="outillage",
                    waves_per_leg=1, no_merge=True, merge_sensitive=set(),
                    permission_mode="acceptEdits", model=None, margin=90,
                    patience=2, max_legs=40, leg_timeout=120, claude="claude",
                    no_arbiter=False, arbiter_model=sup.ARBITER_MODEL,
                    arbiter_budget=12, arbiter_timeout=45, stall_minutes=25,
                    dry_run=False, no_reload=False, no_watchdog=False,
                    echo=False, max_hours=None, force=False)
        base.update(fields)
        return argparse.Namespace(**base)

    def setUp(self):
        sup._IN_FLIGHT.clear()
        self.addCleanup(sup._IN_FLIGHT.clear)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.intent_path = Path(self.tmp.name) / "supervisor.json"
        patch = mock.patch.object(sup, "INTENT", self.intent_path)
        patch.start()
        self.addCleanup(patch.stop)

    def en_vol(self):
        sup.track_call(mock.Mock(poll=mock.Mock(return_value=None)))

    # -- la décision -------------------------------------------------------- #

    def test_une_source_changee_se_recharge(self):
        self.assertIsNone(
            sup.why_not_reload(self.args(), "aaa", "bbb", legs=3))

    def test_une_source_stable_ne_recharge_rien(self):
        """Le cas ordinaire de chaque étape : il ne coûte que la relecture de
        l'empreinte, et ne doit rien écrire nulle part."""
        self.assertEqual(sup.why_not_reload(self.args(), "aaa", "aaa", legs=3),
                         "source inchangée")

    def test_une_empreinte_inconnue_ne_recharge_rien(self):
        """Une source illisible d'un côté ou de l'autre ne prouve aucun
        changement — se recharger là-dessus relancerait le processus sur rien."""
        self.assertIsNotNone(sup.why_not_reload(self.args(), None, "bbb", legs=1))
        self.assertIsNotNone(sup.why_not_reload(self.args(), "aaa", None, legs=1))

    def test_un_appel_en_vol_interdit_le_rechargement(self):
        """La condition qui compte : le superviseur est le parent du
        `claude -p`, et se remplacer pendant qu'il écrit dans son tube le tue."""
        self.en_vol()
        why = sup.why_not_reload(self.args(), "aaa", "bbb", legs=3)
        self.assertIsNotNone(why)
        self.assertIn("claude -p", why)

    def test_le_drapeau_debranche_le_rechargement(self):
        why = sup.why_not_reload(self.args(no_reload=True), "aaa", "bbb", legs=3)
        self.assertIn("--no-reload", why)

    def test_dry_run_ne_se_remplace_pas(self):
        """`--dry-run` montre l'appel qui serait fait ; se remplacer par un autre
        processus n'est pas montrer."""
        self.assertIsNotNone(
            sup.why_not_reload(self.args(dry_run=True), "aaa", "bbb", legs=1))

    def test_un_arret_demande_ne_ressuscite_personne(self):
        """Un Ctrl-C ne survit pas à `execv` : recharger ici relancerait un
        superviseur dont on vient de demander l'arrêt."""
        self.assertIsNotNone(
            sup.why_not_reload(self.args(), "aaa", "bbb", legs=1, halting=True))

    def test_sans_etape_restante_on_ne_recharge_pas(self):
        """Le processus neuf s'arrêterait au premier tour de boucle : la relance
        ne servirait qu'à écrire un rechargement inutile dans le journal."""
        why = sup.why_not_reload(self.args(max_legs=4), "aaa", "bbb", legs=4)
        self.assertIn("--max-legs", why)

    # -- le report du budget d'étapes --------------------------------------- #

    def test_max_legs_est_decompte_de_ce_qui_a_servi(self):
        """`execv` repart à `legs = 0`. Sans report, `--max-legs 40` ne bornerait
        plus le run mais la vie d'un processus, et un jalon qui se recharge à
        chaque étape tournerait sans borne."""
        intent = sup.reload_intent(self.args(max_legs=40), legs=7)
        self.assertEqual(intent["max_legs"], 33)

    def test_le_budget_reporte_ne_descend_jamais_sous_une_etape(self):
        intent = sup.reload_intent(self.args(max_legs=3), legs=9)
        self.assertEqual(intent["max_legs"], 1)

    def test_le_budget_reporte_revient_en_ligne_de_commande(self):
        argv = sup.intent_argv(sup.reload_intent(self.args(max_legs=40), legs=7))
        self.assertEqual(argv[argv.index("--max-legs") + 1], "33")

    def test_le_reste_de_l_intention_est_celui_du_processus(self):
        """Rejouer la même intention, c'est repartir sur le même plan : une
        nature perdue ferait dérouler le produit à la place de l'outillage."""
        argv = sup.intent_argv(sup.reload_intent(self.args(), legs=1))
        self.assertEqual(argv[argv.index("--nature") + 1], "outillage")
        self.assertIn("--no-merge", argv)
        self.assertEqual(argv[0], "S1 — Fondations")

    def test_seul_le_budget_d_etapes_distingue_l_intention_rechargee(self):
        """Un rechargement est un démarrage : `armed` et `expires` s'y refont
        comme partout ailleurs. La péremption à quinze jours protège d'une
        intention *oubliée*, et celle-ci vient de terminer une étape."""
        args = self.args(max_legs=40)
        attendu = dict(sup.intent_of(args))
        obtenu = dict(sup.reload_intent(args, legs=7))
        self.assertEqual(obtenu.pop("max_legs"), 33)
        self.assertEqual(attendu.pop("max_legs"), 40)
        for champ in ("armed", "expires"):
            attendu.pop(champ), obtenu.pop(champ)
        self.assertEqual(obtenu, attendu)

    # -- l'acte, jusqu'au seuil de `execv` ---------------------------------- #

    def recharge(self, args=None, before="aaa", after="bbb", legs=3, **kw):
        """Appelle `reload_source` avec le remplacement du processus neutralisé.

        Rend (rendu, argv, lignes du journal du superviseur, lignes du run).
        `beat` est neutralisé aussi : il écrirait dans le vrai
        `.claude/.milestone/supervisor.alive`, et une veille qui passerait
        pendant les tests y lirait un superviseur vivant.
        """
        posted, spoken = [], []
        with mock.patch.object(sup, "source_fingerprint", return_value=after), \
             mock.patch.object(sup, "exec_replace") as remplace, \
             mock.patch.object(sup, "beat") as beat, \
             mock.patch.object(sup, "say",
                               side_effect=lambda *a, **k: spoken.append(a)), \
             mock.patch.object(sup, "journal",
                               side_effect=lambda *a, **k: posted.append((a, k))):
            rendu = sup.reload_source(args or self.args(), before, legs, **kw)
        self.remplace = remplace
        self.beat = beat
        argv = list(remplace.call_args.args[0]) if remplace.call_args else []
        return rendu, argv, spoken, posted

    def test_un_refus_ne_touche_a_rien(self):
        """Ni journal du run, ni `execv`, ni intention réécrite : une étape sur
        une source stable doit coûter exactement ce qu'elle coûtait avant."""
        rendu, argv, _, posted = self.recharge(before="aaa", after="aaa")
        self.assertFalse(rendu)
        self.assertEqual(argv, [])
        self.assertEqual(posted, [])
        self.assertFalse(self.intent_path.exists())

    def test_un_refus_sur_ecart_reel_se_dit_en_debug(self):
        """C'est la ligne qui explique pourquoi le dispositif n'a pas fait ce
        qu'il annonce savoir faire — sur une source stable, elle n'apprendrait
        rien et n'est donc pas dite."""
        self.en_vol()
        _, _, spoken, posted = self.recharge()
        self.assertTrue(any("rechargement différé" in ligne[0] and
                            ligne[1] == "DEBUG" for ligne in spoken))
        self.assertEqual(posted, [])

    def test_le_rechargement_remplace_le_processus(self):
        rendu, argv, _, _ = self.recharge()
        self.assertTrue(rendu)
        self.assertEqual(argv[0], sys.executable)
        self.assertEqual(Path(argv[1]).name, "milestone_supervise.py")

    def test_le_rechargement_rejoue_l_intention(self):
        _, argv, _, _ = self.recharge(args=self.args(max_legs=40), legs=7)
        self.assertEqual(argv[argv.index("--max-legs") + 1], "33")
        self.assertEqual(argv[argv.index("--nature") + 1], "outillage")

    def test_le_rechargement_est_journalise_dans_les_deux_journaux(self):
        """Ils n'ont pas les mêmes lecteurs : celui du superviseur pour qui
        regarde le dispositif, celui du run pour qui regarde le jalon."""
        _, _, spoken, posted = self.recharge()
        self.assertEqual(len(posted), 1)
        (args_journal, fields), = posted
        self.assertIsNone(args_journal[0])   # aucun statut : le run n'a pas bougé
        self.assertEqual(fields["level"], "WARN")
        self.assertTrue(any(ligne[1] == "WARN" and "rechargement" in ligne[0]
                            for ligne in spoken))

    def test_le_message_porte_les_deux_empreintes(self):
        """Sans elles, la ligne dit qu'il s'est passé quelque chose sans dire
        quoi — et c'est justement ce qu'on relit des mois plus tard pour savoir
        quelle version tournait à quelle étape."""
        _, _, _, posted = self.recharge(before="a" * 64, after="b" * 64)
        message = posted[0][0][1]
        self.assertIn("a" * 12, message)
        self.assertIn("b" * 12, message)
        self.assertIn("milestone_supervise.py", message)

    def test_le_battement_est_rearme_avant_de_partir(self):
        """`execv` n'exécute aucun `atexit` : le fil qui bat meurt avec l'image,
        et le processus neuf met une seconde ou deux à reprendre. Sans battement
        frais, une veille qui passe pile là lance un second superviseur."""
        self.recharge()
        self.beat.assert_called_once()

    def test_sans_intention_armee_le_rechargement_n_en_arme_pas(self):
        """Un superviseur lancé `--no-watchdog` n'a rien armé : lui poser une
        intention en se rechargeant lui donnerait une reprise automatique que
        personne n'a demandée."""
        self.recharge(args=self.args(no_watchdog=True))
        self.assertFalse(self.intent_path.exists())

    def test_une_intention_armee_est_reecrite_avec_le_budget_restant(self):
        """La veille ne lit que le disque, et elle peut se réveiller dans la
        seconde de flottement de l'`execv` : sans réécriture, elle y trouverait
        les 40 étapes d'avant."""
        sup.write_intent({"milestone": "S1 — Fondations", "max_legs": 40})
        self.recharge(args=self.args(max_legs=40), legs=7)
        self.assertEqual(sup.load_intent()["max_legs"], 33)

    def test_le_processus_neuf_sait_qu_il_en_remplace_un(self):
        """Sans ce drapeau, il trouve le battement qu'on vient de rafraîchir et
        la ligne qu'on vient d'écrire dans le journal du run, se croit en double
        et rend la main : le rechargement tuerait le run à chaque correctif."""
        _, argv, _, _ = self.recharge()
        self.assertIn("--reloaded", argv)

    def test_un_superviseur_recharge_ne_se_croit_pas_en_double(self):
        """Le contrôle qui refuse un second superviseur doit être sauté par
        celui qui prend la place du premier — c'est le même processus."""
        code = inspect.getsource(sup.main)
        avant, borne, apres = code.partition("if not args.reloaded:")
        self.assertTrue(borne, "le garde-fou du double superviseur n'est plus "
                               "conditionné à --reloaded")
        self.assertIn("supervisor_alive()", apres)
        self.assertIn("orchestrator_active()", apres)
        self.assertNotIn("supervisor_alive()", avant)
        self.assertNotIn("orchestrator_active()", avant)

    def test_les_choix_du_processus_ne_se_perdent_pas(self):
        """`--no-watchdog` et `--echo` ne vivent pas dans l'intention : les
        oublier ferait qu'un superviseur lancé sans veille s'en arme une au
        premier rechargement."""
        _, argv, _, _ = self.recharge(
            args=self.args(no_watchdog=True, echo=True, max_hours=6.0))
        self.assertIn("--no-watchdog", argv)
        self.assertIn("--echo", argv)
        self.assertEqual(argv[argv.index("--max-hours") + 1], "6.0")

    def test_le_passage_en_force_ne_se_perd_pas(self):
        """Le processus neuf rejoue le préflight. Sans `--force`, il échoue là
        où le premier avait reçu l'ordre de passer outre — `gh auth status` en
        échec, `claude` hors du PATH d'un service —, pose une retenue de trente
        minutes et rend 2 : le rechargement tuerait le run qu'il devait sauver.
        """
        _, argv, _, _ = self.recharge(args=self.args(force=True))
        self.assertIn("--force", argv)
        _, ordinaire, _, _ = self.recharge()
        self.assertNotIn("--force", ordinaire)

    def test_le_debranchement_du_rechargement_survit_a_la_veille(self):
        """`--no-reload` est une consigne de l'opérateur, pas un détail du
        processus : un superviseur ressuscité par la veille qui la perdrait se
        remettrait à se remplacer tout seul, sans que rien ne le dise."""
        sup.save_intent(self.args(no_reload=True))
        self.assertIn("--no-reload", sup.intent_argv(sup.load_intent()))
        self.assertNotIn("--no-reload",
                         sup.intent_argv(sup.intent_of(self.args())))

    def test_un_execv_qui_echoue_ne_tue_pas_le_superviseur(self):
        """Il laisse le processus intact : on le dit, et on poursuit avec
        l'ancien code — l'état d'avant ce correctif, pas une panne de plus."""
        spoken = []
        with mock.patch.object(sup, "source_fingerprint", return_value="bbb"), \
             mock.patch.object(sup, "exec_replace",
                               side_effect=OSError("Exec format error")), \
             mock.patch.object(sup, "beat"), \
             mock.patch.object(sup, "journal"), \
             mock.patch.object(sup, "say",
                               side_effect=lambda *a, **k: spoken.append(a)):
            rendu = sup.reload_source(self.args(), "aaa", 3)
        self.assertFalse(rendu)
        self.assertTrue(any(ligne[1] == "ERROR" for ligne in spoken))

    # -- la citation des arguments, sans quoi rien de tout cela ne part ------ #

    def exec_argv(self, argv, systeme):
        with mock.patch.object(sup.os, "name", systeme), \
             mock.patch.object(sup.os, "execv") as execv, \
             mock.patch.object(sup.sys.stdout, "flush"), \
             mock.patch.object(sup.sys.stderr, "flush"):
            sup.exec_replace(argv)
        return list(execv.call_args.args[1])

    def test_sous_windows_les_arguments_sont_cites_a_l_avance(self):
        """`os.execv` y passe par `_wexecv`, qui concatène les arguments séparés
        par des espaces **sans les citer**. Le chemin de ce dépôt en contient
        deux : sans citation, le processus neuf meurt sur « can't open file
        'D:\\spyle\\Spa' » et la veille le relance dix minutes plus tard — le
        contournement manuel que ce ticket devait supprimer."""
        argv = [sys.executable,
                r"D:\spyle\Spa & Booking\scripts\milestone_supervise.py",
                "S1 — Fondations", "--width", "3", "--reloaded"]
        cite = self.exec_argv(argv, "nt")
        # La concaténation que fera le CRT doit redonner la ligne canonique,
        # celle que `CommandLineToArgvW` sait redécouper à l'identique.
        self.assertEqual(" ".join(cite), subprocess.list2cmdline(argv))
        self.assertEqual(cite[-1], "--reloaded")   # rien d'inutile n'est cité

    def test_sous_posix_le_tableau_passe_tel_quel(self):
        """`execv` y reçoit un vrai tableau : citer ferait entrer les guillemets
        dans la valeur."""
        argv = [sys.executable, "/opt/spa/scripts/milestone_supervise.py",
                "S1 — Fondations"]
        self.assertEqual(self.exec_argv(argv, "posix"), argv)

    def test_le_rechargement_passe_par_la_citation(self):
        """Un `os.execv` appelé en direct depuis `reload_source` contournerait
        la citation — et ne se verrait pas, le chemin étant sans espace sur la
        machine de celui qui écrirait le raccourci."""
        self.assertNotIn("os.execv", inspect.getsource(sup.reload_source))
        self.assertIn("exec_replace(argv)", inspect.getsource(sup.reload_source))

    # -- le câblage --------------------------------------------------------- #

    def test_la_boucle_recharge_et_retombe_sur_l_annonce(self):
        """Un rechargement que personne n'appelle ne recharge rien, et l'annonce
        de #369 doit rester le repli : elle dit quoi faire à la main quand le
        rechargement a été refusé."""
        code = inspect.getsource(sup.supervise)
        _, borne, dedans = code.partition("while not stop_flag.is_set():")
        indice = ("ce test lit le texte de supervise() : un renommage le casse "
                  "sans que rien ne soit cassé — recoller le test au code")
        self.assertTrue(borne, indice)
        self.assertIn("reload_source(args, source_seen, legs", dedans, indice)
        self.assertIn("announce_source_drift(source_seen)", dedans, indice)

    def test_le_rechargement_est_place_entre_deux_appels(self):
        """« Jamais avec un `claude -p` en vol » tient d'abord au placement :
        après l'étape, avant l'arbitrage. `calls_in_flight()` n'est que la
        vérification de ce que le texte garantit déjà."""
        code = inspect.getsource(sup.supervise)
        _, _, dedans = code.partition("while not stop_flag.is_set():")
        self.assertLess(dedans.index("run_leg(args, legs)"),
                        dedans.index("reload_source(args, source_seen, legs"))
        self.assertLess(dedans.index("reload_source(args, source_seen, legs"),
                        dedans.index("rescue(reasons)"))

    def test_une_etape_coupee_par_le_quota_attend_avant_de_recharger(self):
        """La retenue n'est inscrite que par `wait_for_quota`, et l'`info` qui
        porte `resetsAt` ne survit pas à l'`execv`. Se recharger avant elle ferait
        démarrer le processus neuf sans `quota.json` : ne trouvant aucune retenue
        à respecter, il brûlerait aussitôt une étape de son budget dans une
        fenêtre encore fermée. On attend, puis on se recharge."""
        code = inspect.getsource(sup.supervise)
        _, _, dedans = code.partition("while not stop_flag.is_set():")
        self.assertIn('if issue != "quota":', dedans)
        avant, borne, apres = dedans.partition(
            "wait_for_quota(args, info or {}, stop_flag)")
        self.assertTrue(borne, "l'attente du quota n'est plus reconnaissable — "
                               "recoller le test au code")
        self.assertIn("reload_source(args, source_seen, legs", avant,
                      "l'étape ordinaire ne se recharge plus après son leg")
        self.assertIn("reload_source(args, source_seen, legs", apres,
                      "l'étape coupée par le quota ne se recharge jamais")

    def test_l_arret_demande_est_transmis_a_la_decision(self):
        """Sans cela, un Ctrl-C reçu pendant l'étape serait perdu par `execv` et
        le superviseur repartirait pour un tour."""
        code = inspect.getsource(sup.supervise)
        self.assertIn("halting=stop_flag.is_set()", code)


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


class ReArmementDuMemeRun(unittest.TestCase):
    """#323 — une reprise ne doit rien effacer de ce qu'un humain a armé.

    `milestone_run.py start` sans `--fresh` *reprend* un run inachevé, puis
    ré-arme la veille avec le Namespace de cet appel-là. Une reprise ne retape
    aucun drapeau d'armement : le run `s2-r-servation-20260827-195102`, armé le
    27/08 avec `--merge-sensitive prisma`, s'est ainsi retrouvé avec
    `"merge_sensitive": []` sur le disque pendant que le superviseur vivant
    posait toujours `SPA_MERGE_SENSITIVE=prisma` dans l'environnement de ses
    vagues — et `--state` annonçait « aucun pré-autorisé » à un opérateur dont
    les PR Prisma se mergeaient sans relecture.

    Ce qui est vérifié ici est la borne autant que la reprise : hériter d'une
    intention d'un **autre** run ouvrirait au merge des périmètres que personne
    n'a ouverts pour celui-ci — le même défaut, dans le sens qui coûte cher.
    """

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.runs = Path(tmp.name)
        (self.runs / "run-a").mkdir()
        (self.runs / "run-b").mkdir()
        for patched, value in (("RUNS_DIR", self.runs),
                               ("INTENT", self.runs / "supervisor.json"),
                               ("CURRENT", self.runs / "current")):
            self.enterContext(mock.patch.object(sup, patched, value))
        self.sur_le_run("run-a")

    def sur_le_run(self, name):
        sup.CURRENT.write_text(name, encoding="utf-8")

    def args(self, **fields):
        base = dict(milestone="S2 — Réservation", width=3, nature="projet",
                    waves_per_leg=1, no_merge=False, merge_sensitive=set(),
                    permission_mode="acceptEdits", model=None, margin=90,
                    patience=3, max_legs=40, leg_timeout=120, no_arbiter=False,
                    no_reload=False, arbiter_model=sup.ARBITER_MODEL,
                    arbiter_budget=sup.ARBITER_BUDGET,
                    arbiter_timeout=sup.ARBITER_TIMEOUT,
                    stall_minutes=sup.STALL_MINUTES, claude="claude")
        base.update(fields)
        return argparse.Namespace(**base)

    def arme(self, **fields):
        """L'armement d'origine, écrit comme `--arm` l'écrit."""
        sup.save_intent(self.args(**fields))
        return sup.load_intent()

    # --- l'identité du run, ce qui borne la reprise ------------------------

    def test_l_intention_porte_le_run_qu_elle_sert(self):
        self.assertEqual(self.arme()["run"], "run-a")

    # --- le critère d'acceptation, mot pour mot ----------------------------

    def test_une_reprise_nue_conserve_les_perimetres_pre_autorises(self):
        """Armer avec `--merge-sensitive prisma`, faire un `start` de reprise
        nu : `prisma` doit toujours être là."""
        previous = self.arme(merge_sensitive={"prisma"})
        # La ligne exacte que `arm_supervision()` compose pour une reprise nue.
        argv = ["--arm", "--width", "3", "--nature", "projet", "S2 — Réservation"]
        carried = sup.carried_arming(self.args(), previous, argv)
        self.assertEqual(carried["merge_sensitive"], {"prisma"})

    def test_le_reglage_repris_est_celui_qui_finit_sur_le_disque(self):
        """La reprise ne vaut que si elle est *écrite* : c'est `supervisor.json`
        que relisent `--state` et `pr_gate.py`."""
        previous = self.arme(merge_sensitive={"prisma"})
        args = self.args()
        for dest, value in sup.carried_arming(args, previous, ["--arm"]).items():
            setattr(args, dest, value)
        sup.save_intent(args)
        self.assertEqual(sup.load_intent()["merge_sensitive"], ["prisma"])

    def test_no_merge_survit_aussi_a_la_reprise(self):
        previous = self.arme(no_merge=True)
        self.assertIs(
            sup.carried_arming(self.args(), previous, ["--arm"])["no_merge"],
            True)

    def test_les_autres_reglages_d_armement_survivent(self):
        previous = self.arme(model="opus", patience=5, no_arbiter=True)
        carried = sup.carried_arming(self.args(), previous, ["--arm"])
        self.assertEqual(carried["model"], "opus")
        self.assertEqual(carried["patience"], 5)
        self.assertIs(carried["no_arbiter"], True)

    def test_le_budget_d_etapes_n_est_pas_un_reglage_d_armement(self):
        """`reload_intent()` écrit dans l'intention ce qu'il **reste** du budget,
        borné à 1. Le reprendre ferait qu'à chaque reprise le jalon déroule une
        étape et s'arrête — indéfiniment."""
        previous = self.arme(max_legs=40)
        previous["max_legs"] = 1          # ce qu'un run très rechargé y laisse
        sup.write_intent(previous)
        self.assertNotIn("max_legs",
                         sup.carried_arming(self.args(), previous, ["--arm"]))
        self.assertNotIn("max_legs", sup.ARMING_FLAGS)

    def test_un_registre_illisible_ne_detruit_pas_l_accord_arme(self):
        """`pr_gate.py` à demi écrit — ce qui arrive pendant un run d'outillage
        qui réécrit `scripts/`. Relire la liste armée à travers un registre vide
        la viderait, et `save_intent()` écrirait cet effacement pour de bon."""
        previous = self.arme(merge_sensitive={"prisma"})
        with mock.patch.object(sup, "SCOPES_KNOWN", False), \
             mock.patch.object(sup, "SCOPE_KEYS", frozenset()):
            carried = sup.carried_arming(self.args(), previous, ["--arm"])
        self.assertEqual(carried["merge_sensitive"], {"prisma"})

    # --- ce qui change les réglages, et rien d'autre ------------------------

    def test_un_drapeau_retape_l_emporte(self):
        """Un geste de maintenant contre le souvenir d'un armement passé."""
        previous = self.arme(merge_sensitive={"prisma"})
        argv = ["--arm", "--merge-sensitive", "infra/terraform"]
        carried = sup.carried_arming(
            self.args(merge_sensitive={"infra/terraform"}), previous, argv)
        self.assertNotIn("merge_sensitive", carried)

    def test_un_drapeau_retape_a_zero_l_emporte_aussi(self):
        """`--merge-sensitive ""` est une consigne, pas une absence : c'est la
        seule façon de *fermer* un périmètre sans rouvrir un run."""
        previous = self.arme(merge_sensitive={"prisma"})
        carried = sup.carried_arming(
            self.args(), previous, ["--arm", "--merge-sensitive="])
        self.assertNotIn("merge_sensitive", carried)

    def test_un_run_neuf_ne_reprend_rien(self):
        """`start --fresh` ouvre un run neuf : l'intention d'avant n'est pas la
        sienne, et personne n'a pré-autorisé quoi que ce soit pour lui."""
        previous = self.arme(merge_sensitive={"prisma"})
        self.sur_le_run("run-b")
        self.assertEqual(sup.carried_arming(self.args(), previous, ["--arm"]), {})

    def test_une_intention_d_avant_ce_ticket_n_est_pas_reprise(self):
        """Sans le champ `run`, on ne sait pas quel run elle servait — et le sens
        prudent de l'ignorance est de ne rien hériter."""
        previous = dict(self.arme(merge_sensitive={"prisma"}))
        del previous["run"]
        self.assertEqual(sup.carried_arming(self.args(), previous, ["--arm"]), {})

    def test_sans_run_ouvert_rien_n_est_repris(self):
        previous = self.arme(merge_sensitive={"prisma"})
        sup.CURRENT.unlink()
        self.assertEqual(sup.carried_arming(self.args(), previous, ["--arm"]), {})

    def test_sans_intention_precedente_rien_n_est_repris(self):
        self.assertEqual(sup.carried_arming(self.args(), None, ["--arm"]), {})

    # --- les deux réglages qui ne peuvent pas coexister ---------------------

    def test_un_no_merge_arme_ne_contredit_pas_une_pre_autorisation_tapee(self):
        """`main()` refuse les deux *tapés* ensemble ; ils peuvent en revanche se
        rencontrer ici, l'un venant du disque et l'autre de la ligne. C'est alors
        le geste de maintenant qui tranche."""
        previous = self.arme(no_merge=True)
        carried = sup.carried_arming(
            self.args(merge_sensitive={"prisma"}), previous,
            ["--arm", "--merge-sensitive", "prisma"])
        self.assertNotIn("no_merge", carried)

    def test_une_pre_autorisation_armee_ne_survit_pas_a_un_no_merge_tape(self):
        previous = self.arme(merge_sensitive={"prisma"})
        carried = sup.carried_arming(self.args(no_merge=True), previous,
                                     ["--arm", "--no-merge"])
        self.assertNotIn("merge_sensitive", carried)

    # --- et ce que l'opérateur en lit --------------------------------------

    def test_ce_qui_est_repris_est_nomme_reglage_par_reglage(self):
        """« 3 réglages repris » ne répond pas à « qui a autorisé quoi »."""
        previous = self.arme(merge_sensitive={"prisma"}, no_merge=False)
        said = sup.describe_carried(
            sup.carried_arming(self.args(), previous, ["--arm"]), previous)
        self.assertIn("--merge-sensitive", said)
        self.assertIn("prisma", said)
        self.assertIn(previous["armed"], said)

    def test_rien_de_repris_ne_dit_rien(self):
        self.assertIsNone(sup.describe_carried({}, None))

    # --- ce qu'un lancement ordinaire referme, et doit dire -----------------

    def test_un_lancement_qui_ne_reprend_pas_nomme_ce_qu_il_referme(self):
        """`--arm` reprend ; un lancement ordinaire ne le peut pas — ses
        arguments sont ce que le processus posera dans `SPA_MERGE_SENSITIVE`.
        Il ne rend donc rien, mais il ne se tait pas."""
        previous = self.arme(merge_sensitive={"prisma", "infra/terraform"})
        self.assertEqual(sup.dropped_scopes(self.args(), previous),
                         ["infra/terraform", "prisma"])

    def test_un_lancement_qui_reprend_tout_ne_referme_rien(self):
        """Le superviseur ressuscité par la veille : `intent_argv()` rejoue
        `--merge-sensitive`, il n'y a rien à annoncer."""
        previous = self.arme(merge_sensitive={"prisma"})
        self.assertEqual(
            sup.dropped_scopes(self.args(merge_sensitive={"prisma"}), previous),
            [])

    def test_l_armement_d_un_autre_run_n_est_jamais_dit_referme(self):
        previous = self.arme(merge_sensitive={"prisma"})
        self.sur_le_run("run-b")
        self.assertEqual(sup.dropped_scopes(self.args(), previous), [])


class ReArmementParLaLigneDeCommande(unittest.TestCase):
    """Le même parcours, mais par `main()` — ce que `start` appelle vraiment.

    `carried_arming()` peut être juste et rester inerte : c'est le branchement
    dans `--arm` qui fait la correction, et c'est lui qu'un remaniement peut
    perdre sans qu'un seul test unitaire ne bronche.
    """

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.runs = Path(tmp.name)
        (self.runs / "run-a").mkdir()
        for patched, value in (("RUNS_DIR", self.runs),
                               ("INTENT", self.runs / "supervisor.json"),
                               ("CURRENT", self.runs / "current")):
            self.enterContext(mock.patch.object(sup, patched, value))
        (self.runs / "current").write_text("run-a", encoding="utf-8")
        # Ni préflight (il exige `gh` authentifié), ni tâche planifiée : ce qui
        # est mesuré est l'intention écrite, pas l'environnement de la machine.
        self.enterContext(mock.patch.object(sup, "preflight", return_value=True))
        self.enterContext(mock.patch.object(sup, "arm_watchdog",
                                            return_value=True))
        self.dit = []
        self.enterContext(mock.patch.object(
            sup, "say",
            lambda message, level="INFO": self.dit.append((level, message))))

    def arm(self, *argv):
        with mock.patch.object(sys, "argv",
                               ["milestone_supervise.py", "--arm", *argv]):
            return sup.main()

    def test_une_reprise_nue_garde_le_perimetre_arme(self):
        self.assertEqual(self.arm("S2 — Réservation", "--width", "3",
                                  "--merge-sensitive", "prisma"), 0)
        self.assertEqual(sup.load_intent()["merge_sensitive"], ["prisma"])
        # La reprise : exactement ce que compose `arm_supervision()`, sans
        # `--merge-sensitive` puisque l'opérateur ne l'a pas retapé.
        self.assertEqual(self.arm("S2 — Réservation", "--width", "3",
                                  "--nature", "projet"), 0)
        self.assertEqual(sup.load_intent()["merge_sensitive"], ["prisma"])

    def test_la_reprise_le_dit_en_warn(self):
        self.arm("S2 — Réservation", "--merge-sensitive", "prisma")
        self.dit.clear()
        self.arm("S2 — Réservation")
        warned = " | ".join(message for level, message in self.dit
                            if level == "WARN")
        self.assertIn("réglages repris", warned)
        self.assertIn("prisma", warned)

    def test_la_banniere_annonce_le_perimetre_repris(self):
        """La bannière est lue à l'instant où l'opérateur cesse de regarder :
        elle doit décrire l'armement qui sera écrit, pas celui de la ligne."""
        self.arm("S2 — Réservation", "--merge-sensitive", "prisma")
        self.dit.clear()
        self.arm("S2 — Réservation")
        annonce = " | ".join(message for level, message in self.dit
                             if "SERONT mergés" in message)
        self.assertIn("prisma", annonce)

    def test_un_run_neuf_repart_des_defauts(self):
        self.arm("S2 — Réservation", "--merge-sensitive", "prisma")
        (self.runs / "run-b").mkdir()
        (self.runs / "current").write_text("run-b", encoding="utf-8")
        self.arm("S3 — Back-office")
        self.assertEqual(sup.load_intent()["merge_sensitive"], [])

    def test_un_drapeau_abrege_est_refuse_plutot_qu_ignore(self):
        """L'abréviation de préfixe d'argparse contre `flag_typed()`.

        `flag_typed()` lit la ligne de commande telle quelle : `--merge-sensi ""`
        — qu'argparse accepterait par défaut — y serait invisible, et la reprise
        réarmerait le périmètre que l'opérateur vient précisément de fermer.
        C'est #323 dans le sens qui coûte cher, et par le geste censé le
        corriger. Le parseur refuse donc l'abréviation : échouer bruyamment
        plutôt que trahir la consigne en silence.
        """
        self.assertEqual(self.arm("S2 — Réservation",
                                  "--merge-sensitive", "prisma"), 0)
        with contextlib.redirect_stderr(io.StringIO()), \
             self.assertRaises(SystemExit):
            self.arm("S2 — Réservation", "--merge-sensi", "")
        self.assertEqual(sup.load_intent()["merge_sensitive"], ["prisma"])


class DivergenceAvecLEnvironnement(unittest.TestCase):
    """#323 — `--state` ne peut plus afficher le disque comme s'il faisait foi.

    Deux sources disent ce qui est pré-autorisé : `supervisor.json`, le geste
    humain daté, et `SPA_MERGE_SENSITIVE`, le souvenir qu'en a gardé un
    `claude -p` né plus tôt. Elles ont divergé tout un run sans qu'une ligne le
    dise. `pr_gate.py` tranche déjà pour la plus restrictive (#414) ; ce qui
    manquait était de pouvoir le voir.
    """

    def setUp(self):
        # L'intention n'est confrontée que si elle désigne le run ouvert (#426) :
        # sans run vivant sous la main, `--state` dirait « rien à confronter »
        # de tous ces cas, et la classe ne vérifierait plus rien.
        patch = mock.patch.object(sup, "current_run", return_value="run-a")
        patch.start()
        self.addCleanup(patch.stop)

    def intent(self, scopes):
        return {"merge_sensitive": scopes, "run": "run-a"}

    def test_l_armement_d_un_autre_run_n_est_pas_une_divergence(self):
        """#426 — `pr_gate.py` ne le confronte pas ; l'annoncer comme une
        intersection décrirait une protection qui n'aura pas lieu."""
        message = sup.env_divergence({"merge_sensitive": [], "run": "run-mort"},
                                     "prisma")
        self.assertIn("rien à confronter", message)
        self.assertNotIn("intersection", message)

    def test_une_intention_sans_run_inscrit_n_est_pas_une_divergence(self):
        """La même règle des deux côtés, jusqu'au bout.

        `pr_gate.intent_scopes()` s'arrête sur `not run` avant même de comparer :
        un `run: null` sans run ouvert — les deux valant None — y est muet.
        L'annoncer ici comme une intersection décrirait une barrière qui ne
        tourne pas.
        """
        with mock.patch.object(sup, "current_run", return_value=None):
            message = sup.env_divergence({"merge_sensitive": [], "run": None},
                                         "prisma")
        self.assertIn("rien à confronter", message)
        self.assertNotIn("intersection", message)

    def test_une_intention_illisible_ne_fait_pas_tomber_l_etat(self):
        """`--state` est la commande qu'on tape quand le disque semble faux.

        `supervisor.json` peut porter n'importe quel JSON — un `[]` écrit à la
        main, la troncature d'un autre outil. Y mourir sur une `AttributeError`
        retirerait le diagnostic à l'instant précis où il sert.
        """
        for illisible in ([], False, 0, "prisma", ["prisma"]):
            with self.subTest(intention=illisible):
                self.assertIn("rien à confronter",
                              sup.env_divergence(illisible, "prisma"))

    def test_variable_absente_n_est_pas_une_divergence(self):
        """Le cas courant : elle n'est posée que dans l'environnement des vagues."""
        self.assertIsNone(sup.env_divergence(self.intent(["prisma"]), None))
        self.assertIn("absente", sup.describe_env(self.intent([]), None))

    def test_la_variable_est_nommee_dans_les_trois_branches(self):
        """La ligne est lue hors de son contexte — recopiée dans une issue, citée
        dans un compte rendu."""
        for raw in (None, "prisma", ""):
            with self.subTest(variable=repr(raw)):
                self.assertIn(sup.AUTHORISED_ENV,
                              sup.describe_env(self.intent(["prisma"]), raw))

    def test_sans_intention_lisible_l_intersection_n_est_pas_annoncee(self):
        """`pr_gate.py` ne confronte que deux valeurs lisibles : sans intention,
        il croit la variable telle quelle (#414). Annoncer une intersection
        décrirait une protection qui n'a pas lieu."""
        message = sup.env_divergence(None, "prisma")
        self.assertIn("rien à confronter", message)
        self.assertNotIn("intersection", message)

    def test_concordance_ne_signale_rien(self):
        self.assertIsNone(sup.env_divergence(self.intent(["prisma"]), "prisma"))
        self.assertIn("concorde",
                      sup.describe_env(self.intent(["prisma"]), "prisma"))

    def test_le_cas_du_defaut_est_nomme_des_deux_cotes(self):
        """L'environnement plus large que le disque — le run du 27/08."""
        message = sup.env_divergence(self.intent([]), "prisma")
        self.assertIsNotNone(message)
        self.assertIn("prisma", message)
        self.assertIn("divergent", message)

    def test_l_intersection_retenue_est_dite(self):
        message = sup.env_divergence(self.intent(["prisma"]),
                                     "prisma,infra/terraform")
        self.assertIn("intersection : prisma", message)

    def test_le_disque_plus_large_diverge_aussi(self):
        message = sup.env_divergence(self.intent(["prisma"]), "")
        self.assertIsNotNone(message)
        self.assertIn("intersection : rien", message)

    def test_sans_intention_lisible_la_variable_est_signalee(self):
        for intent in (None, {}, {"merge_sensitive": "prisma"}):
            with self.subTest(intention=intent):
                message = sup.env_divergence(intent, "prisma")
                self.assertIsNotNone(message)
                self.assertIn("prisma", message)

    def test_all_s_entend_pareil_des_deux_cotes(self):
        """Intersecter `["all"]` tel quel révoquerait *tout* au lieu de tout
        ouvrir — le contresens exact du raccourci."""
        self.assertIsNone(sup.env_divergence(
            self.intent(sorted(sup.SCOPE_KEYS)), sup.ALL_SCOPES))

    def test_state_imprime_la_ligne(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        runs = Path(tmp.name)
        (runs / "run-a").mkdir()
        (runs / "current").write_text("run-a", encoding="utf-8")
        (runs / "supervisor.json").write_text(
            json.dumps({"milestone": "S2", "width": 3, "merge_sensitive": [],
                        "run": "run-a", "armed": "2026-08-27T16:51:03+00:00",
                        "expires": time.time() + 3600}),
            encoding="utf-8")
        sortie = io.StringIO()
        with mock.patch.object(sup, "RUNS_DIR", runs), \
             mock.patch.object(sup, "INTENT", runs / "supervisor.json"), \
             mock.patch.object(sup, "CURRENT", runs / "current"), \
             mock.patch.dict(os.environ, {sup.AUTHORISED_ENV: "prisma"}), \
             mock.patch.object(sup, "watchdog_armed", return_value=True), \
             contextlib.redirect_stdout(sortie):
            sup.cmd_state(argparse.Namespace())
        self.assertIn(sup.AUTHORISED_ENV, sortie.getvalue())
        self.assertIn("divergent", sortie.getvalue())


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


class DossierApprouve(unittest.TestCase):
    """`workspace_trusted()` — le verdict dont dépend l'allowlist de tout le run.

    Un faux « non approuvé » n'est pas cosmétique : l'avertissement qu'il déclenche
    pousse l'opérateur vers `--permission-mode bypassPermissions`, c'est-à-dire à
    désarmer toutes les invites de permission d'un run de plusieurs heures pour
    contourner un défaut de lecture. C'est ce qui rend #131 plus lourd que son
    diff.

    Le défaut : `~/.claude.json` porte couramment **plusieurs entrées pour le même
    dossier**, et le parcours retournait sur la première rencontrée — dans l'ordre
    du dictionnaire, donc une fois sur deux sur l'entrée périmée.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.root = Path(self.tmp.name) / "depot"
        self.root.mkdir()

    def trusted(self, projects=None, raw=None):
        """Le verdict, `~/.claude.json` et `ROOT` sous contrôle.

        `raw` écrit le fichier tel quel — c'est ainsi qu'on fabrique un JSON
        illisible ; `projects` passe par la forme normale. Ni l'un ni l'autre :
        le fichier n'existe pas.
        """
        if raw is not None:
            (self.home / ".claude.json").write_text(raw, encoding="utf-8")
        elif projects is not None:
            (self.home / ".claude.json").write_text(
                json.dumps({"projects": projects}), encoding="utf-8")
        with mock.patch.object(sup.Path, "home", return_value=self.home), \
             mock.patch.object(sup, "ROOT", self.root):
            return sup.workspace_trusted()

    def deux_ecritures(self):
        """Deux clés JSON distinctes qui désignent le même dossier.

        Sous Windows, #131 les fabrique avec la casse de la lettre de lecteur,
        que `PurePath.__eq__` ignore. Ailleurs la comparaison de chemins est
        sensible à la casse : deux casses y seraient deux dossiers, et le test
        deviendrait vert sans rien prouver. On prend donc partout une variante
        que `Path()` ramène sur l'autre — le séparateur final — et la casse du
        lecteur est couverte à part, là où elle a un sens.
        """
        native = str(self.root)
        variante = native + os.sep
        # Sans quoi le cas de régression pourrait devenir vide en silence : ce
        # qu'on veut, ce sont bien deux entrées de dictionnaire pour un dossier.
        self.assertNotEqual(native, variante)
        self.assertEqual(Path(variante).resolve(), self.root.resolve())
        return native, variante

    def test_deux_ecritures_dont_une_approuvee_rendent_approuve(self):
        """Le cas de #131, dans l'ordre qui le révèle : la périmée d'abord."""
        perimee, approuvee = self.deux_ecritures()
        self.assertIs(self.trusted({
            perimee: {"hasTrustDialogAccepted": False},
            approuvee: {"hasTrustDialogAccepted": True},
        }), True)

    def test_l_ordre_des_entrees_ne_change_pas_le_verdict(self):
        """L'autre moitié du même défaut : le verdict ne doit plus rien devoir à
        l'ordre d'insertion du dictionnaire."""
        approuvee, perimee = self.deux_ecritures()
        self.assertIs(self.trusted({
            approuvee: {"hasTrustDialogAccepted": True},
            perimee: {"hasTrustDialogAccepted": False},
        }), True)

    @unittest.skipUnless(os.name == "nt",
                         "la casse ne désigne un même dossier que sous Windows")
    def test_la_casse_du_lecteur_ne_masque_pas_l_approbation(self):
        """Le cas tel qu'il a été constaté : `d:\\` et `D:\\` côte à côte."""
        native = str(self.root)
        autre_casse = native[0].swapcase() + native[1:]
        self.assertNotEqual(native, autre_casse)
        self.assertIs(self.trusted({
            autre_casse: {"hasTrustDialogAccepted": False},
            native: {"hasTrustDialogAccepted": True},
        }), True)

    def test_aucune_entree_correspondante_rend_non_approuve(self):
        self.assertIs(self.trusted({
            str(self.root.parent / "ailleurs"): {"hasTrustDialogAccepted": True},
        }), False)

    def test_une_seule_entree_non_approuvee_rend_non_approuve(self):
        self.assertIs(self.trusted({
            str(self.root): {"hasTrustDialogAccepted": False},
        }), False)

    def test_une_entree_sans_le_drapeau_rend_non_approuve(self):
        """Absent vaut refusé : on n'approuve pas un dossier par omission."""
        self.assertIs(self.trusted({str(self.root): {}}), False)

    def test_sans_section_projects_rien_ne_correspond(self):
        self.assertIs(self.trusted(raw=json.dumps({"projects": None})), False)

    def test_une_section_projects_d_une_autre_forme_ne_correspond_pas(self):
        """Un `projects` qui n'est pas un objet n'a pas d'entrées : `.items()`
        y lèverait, et l'exception tuerait le préflight, donc le run."""
        self.assertIs(self.trusted(raw=json.dumps({"projects": []})), False)

    def test_une_entree_d_une_autre_forme_est_ignoree(self):
        """Une entrée corrompue ne doit pas faire lever `project.get` : elle ne
        vaut pas approbation, elle n'empêche pas de lire les suivantes.

        Elle désigne `ROOT` — sinon le filtre de clé l'écarterait avant qu'on la
        lise, et le test resterait vert sans rien éprouver.
        """
        corrompue, approuvee = self.deux_ecritures()
        self.assertIs(self.trusted({
            corrompue: None,
            approuvee: {"hasTrustDialogAccepted": True},
        }), True)

    def test_une_cle_irresolvable_est_ignoree(self):
        """Une entrée sans rapport avec ce dépôt — lecteur réseau tombé, chemin
        invalide — ne désigne pas `ROOT` et ne doit pas faire lever la
        fonction."""
        self.assertIs(self.trusted({
            "\0pas un chemin": {"hasTrustDialogAccepted": True},
            str(self.root): {"hasTrustDialogAccepted": True},
        }), True)

    def test_un_fichier_absent_ne_conclut_rien(self):
        self.assertIsNone(self.trusted())

    def test_un_fichier_illisible_ne_conclut_rien(self):
        self.assertIsNone(self.trusted(raw="{ceci n'est pas du JSON"))

    # -- ce que le préflight en fait, et pourquoi `None` n'est pas `False` --

    def preflight_warnings(self, trusted):
        lines = []
        with mock.patch.object(sup, "workspace_trusted", return_value=trusted), \
             mock.patch.object(sup.shutil, "which", return_value="/bin/x"), \
             mock.patch.object(sup.subprocess, "run",
                               return_value=mock.Mock(returncode=0)), \
             mock.patch.object(sup, "say",
                               lambda message, level="INFO": lines.append(
                                   (level, message))):
            sup.preflight(argparse.Namespace(claude="claude",
                                             permission_mode="default"))
        return [message for level, message in lines if level == "WARN"]

    def test_un_dossier_approuve_n_avertit_de_rien(self):
        self.assertEqual(self.preflight_warnings(True), [])

    def test_un_dossier_non_approuve_avertit(self):
        self.assertIn("n'est pas approuvé",
                      " | ".join(self.preflight_warnings(False)))

    def test_un_verdict_indisponible_n_avertit_pas(self):
        """`None` n'est pas `False` : sans `.claude.json` lisible, on ne sait
        pas — et annoncer un dossier non approuvé serait le faux négatif que
        #131 corrige, remis par une autre porte."""
        self.assertEqual(self.preflight_warnings(None), [])


class PlanPerimeDepuisLeReplan(RunJournalFixture):
    """#422 — ce qui périme le plan stocké, et ce qui ne le périme pas.

    `gate` ne recalcule rien : il relit le plan de `run.json`. La question posée
    ici est donc la seule qui compte avant de se débrancher — « ce plan-là
    a-t-il été écrit avant ou après la dernière action de l'arbitre ? » — et elle
    se répond sur le journal du run, sans réseau : la veille la pose toutes les
    cinq minutes.
    """

    REPLAN = {"ts": "2026-09-04T21:17:41+00:00", "kind": "run",
              "status": "replanned", "actor": "orchestrateur",
              "message": "0 tickets restants, 0 vagues"}

    @staticmethod
    def decision(ticket=60, message="arbitrage [fin_de_run] · fix — PR #419 mergée"):
        """Une décision de l'arbitre telle que `milestone_arbiter.py record`
        l'inscrit : l'acteur la désigne, elle ne porte aucun statut."""
        return {"ts": "2026-09-04T21:26:27+00:00", "kind": "ticket",
                "ticket": ticket, "phase": "orchestration", "actor": "arbitre",
                "level": "WARN", "message": message}

    def reasons(self, *events):
        with self.journal(*events):
            return sup.plan_outdated_since_replan()

    def test_un_run_qui_se_deroule_normalement_n_a_rien_a_recalculer(self):
        """Chaque vague se termine par un `replan` : le plan stocké connaît déjà
        les merges de la vague, et il n'y a rien à repayer."""
        self.assertEqual(self.reasons(self.merged(17), self.REPLAN), [])

    def test_un_merge_posterieur_au_replan_perime_le_plan(self):
        """La nuit du 4 au 5 septembre : l'arbitrage merge la PR de #60 après le
        replan de 21:17, et c'est ce merge qui libère ses dépendants."""
        self.assertEqual(self.reasons(self.REPLAN, self.merged(60)),
                         ["#60 clos"])

    def test_un_ticket_ecarte_perime_le_plan_autant_qu_un_merge(self):
        """`skip` est terminal lui aussi : l'issue quitte le plan, et ce qui
        dépendait d'elle n'y est plus retenu."""
        with self.journal(self.REPLAN,
                          {"ticket": 71, "status": "skipped", "actor": "arbitre"}):
            reasons = sup.plan_outdated_since_replan()
        self.assertIn("#71 clos", reasons)

    def test_une_decision_de_l_arbitre_suffit_sans_aucun_merge(self):
        """Phase 7 de `/milestone-arbitrate` : les anomalies du run deviennent
        des issues, rattachées au jalon. Une issue neuve est un ticket que le
        plan d'avant ne pouvait pas connaître — et il n'y a eu aucun merge."""
        self.assertEqual(self.reasons(self.REPLAN, self.decision()),
                         ["1 décision(s) de l'arbitre"])

    def test_le_merge_et_la_decision_se_disent_tous_les_deux(self):
        self.assertEqual(self.reasons(self.REPLAN, self.merged(60), self.decision()),
                         ["#60 clos", "1 décision(s) de l'arbitre"])

    def test_seul_le_dernier_replan_fait_la_frontiere(self):
        """Un merge repris entre deux replans est déjà dans le plan courant."""
        self.assertEqual(self.reasons(self.REPLAN, self.merged(60), self.REPLAN),
                         [])

    def test_l_ouverture_d_un_arbitrage_par_le_superviseur_ne_compte_pas(self):
        """`journal("arbitrage", …)` est une ligne du superviseur, pas une
        décision : l'arbitre n'a encore rien fait quand elle s'écrit. La compter
        ferait replanifier à chaque fin de run, y compris quand l'arbitre a
        conclu qu'il n'y avait rien à faire."""
        self.assertEqual(self.reasons(
            self.REPLAN,
            {"kind": "run", "status": "arbitrage", "actor": "superviseur",
             "message": "arbitrage 1 ouvert — fin_de_run"}), [])

    def test_un_merge_de_run_sans_ticket_ne_nomme_rien(self):
        with self.journal(self.REPLAN,
                          {"status": "merged", "actor": "orchestrateur",
                           "message": "sans ticket"}):
            self.assertEqual(sup.plan_outdated_since_replan(), [])

    def test_un_journal_sans_replan_prend_tout_ce_qu_il_porte(self):
        """Un run dont aucune vague n'a encore replanifié : le plan stocké est
        celui de `start`, et tout ce qui s'est clos depuis le périme."""
        self.assertEqual(self.reasons(self.merged(60)), ["#60 clos"])

    def test_aucun_run_ouvert(self):
        with mock.patch.object(sup, "current_run_dir", return_value=None):
            self.assertEqual(sup.plan_outdated_since_replan(), [])


class ReplanIntercale(unittest.TestCase):
    """#422 — le replan qui s'intercale entre l'arbitrage et la conclusion."""

    def call(self, reasons, replan_code=0):
        calls = []

        def runner(*args, **kwargs):
            calls.append(list(args))
            if args and args[0] == "replan":
                return mock.Mock(returncode=replan_code,
                                 stdout="plan recalculé : 20 tickets restants, "
                                        "7 vagues")
            return mock.Mock(returncode=0, stdout="")

        with mock.patch.object(sup, "plan_outdated_since_replan",
                               return_value=reasons), \
             mock.patch.object(sup, "runner", side_effect=runner):
            done = sup.replan_before_concluding("la veille")
        return done, calls

    def test_un_plan_a_jour_ne_coute_aucun_appel(self):
        done, calls = self.call([])
        self.assertFalse(done)
        self.assertEqual(calls, [])

    def test_un_plan_perime_est_recalcule(self):
        done, calls = self.call(["#60 clos"])
        self.assertTrue(done)
        self.assertIn(["replan"], calls)

    def test_le_replan_intercale_se_relit_dans_le_journal_du_run(self):
        """Critère 4 de #422 : la séquence doit se relire après coup, dans le
        journal que l'humain ouvre — pas seulement dans `supervisor.log`."""
        _, calls = self.call(["#60 clos"])
        lines = [" ".join(call) for call in calls if call and call[0] == "event"]
        self.assertTrue(any("replan intercalé" in line and "#60 clos" in line
                            for line in lines), lines)

    def test_un_replan_refuse_ne_pretend_pas_avoir_recalcule(self):
        """Le plan qu'on ne sait pas recalculer ne vaut pas mieux que l'ancien :
        l'appelant conclut sur ce qu'il a, comme avant #422 — mais la ligne de
        journal dit sur quoi il a conclu."""
        done, calls = self.call(["#60 clos"], replan_code=1)
        self.assertFalse(done)
        lines = [" ".join(call) for call in calls if call and call[0] == "event"]
        self.assertTrue(any("refusé" in line for line in lines), lines)


class VeilleDevantUnPlanPerime(unittest.TestCase):
    """#422 — la veille ne se désarme jamais sur un plan antérieur à l'arbitrage.

    La séquence de la nuit du 4 au 5 septembre, rejouée telle qu'elle : le plan
    stocké est vide, l'arbitrage de fin de run merge la PR #419 et ferme #60, et
    `cmd_watchdog` se réveille derrière lui. Avant le correctif, il lisait
    `NO_RUN`, supprimait la tâche planifiée et l'intention — vingt issues
    plannables restaient au matin.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.intent = Path(self.tmp.name) / "supervisor.json"
        self.intent.write_text("{}", encoding="utf-8")

    def watchdog(self, verdicts, reasons):
        gates = list(verdicts)
        calls = []

        def runner(*args, **kwargs):
            calls.append(args[0] if args else "")
            if args and args[0] == "gate":
                return mock.Mock(returncode=gates.pop(0), stdout="")
            return mock.Mock(returncode=0, stdout="")

        with mock.patch.object(sup, "INTENT", self.intent), \
             mock.patch.object(sup, "supervisor_alive", return_value=False), \
             mock.patch.object(sup, "orchestrator_active", return_value=False), \
             mock.patch.object(sup, "authorised", return_value=(True, None)), \
             mock.patch.object(sup, "load_intent", return_value={"argv": []}), \
             mock.patch.object(sup, "quota_file_hold", return_value=None), \
             mock.patch.object(sup, "held_off", return_value=False), \
             mock.patch.object(sup, "plan_outdated_since_replan",
                               return_value=reasons), \
             mock.patch.object(sup, "disarm_watchdog") as disarm, \
             mock.patch.object(sup, "spawn_supervisor") as spawn, \
             mock.patch.object(sup, "runner", side_effect=runner):
            sup.cmd_watchdog(argparse.Namespace())
        return [c for c in calls if c in ("gate", "replan")], disarm, spawn

    def test_un_jalon_reellement_deroule_se_desarme_sans_rien_repayer(self):
        seen, disarm, spawn = self.watchdog([sup.NO_RUN], [])
        self.assertEqual(seen, ["gate"])
        disarm.assert_called_once()
        spawn.assert_not_called()
        self.assertFalse(self.intent.exists())

    def test_un_arbitrage_qui_rouvre_le_jalon_relance_au_lieu_de_desarmer(self):
        """Le défaut de #422, de bout en bout : le gate rendait NO_RUN sur le
        plan de 21:17, alors que 20 issues étaient plannables."""
        seen, disarm, spawn = self.watchdog([sup.NO_RUN, sup.GO], ["#60 clos"])
        self.assertEqual(seen, ["gate", "replan", "gate"])
        disarm.assert_not_called()
        spawn.assert_called_once()
        self.assertTrue(self.intent.exists())

    def test_un_replan_qui_ne_rouvre_rien_desarme_quand_meme(self):
        """Le correctif ne peut pas immobiliser la veille : un seul replan, un
        seul verdict relu, et le jalon se conclut."""
        seen, disarm, spawn = self.watchdog([sup.NO_RUN, sup.NO_RUN], ["#60 clos"])
        self.assertEqual(seen, ["gate", "replan", "gate"])
        disarm.assert_called_once()
        spawn.assert_not_called()

    def test_une_pause_decouverte_apres_le_replan_reste_une_pause(self):
        """Le verdict relu retraverse toutes les branches, pas seulement NO_RUN :
        un `pause` posé pendant le replan ne doit pas se lire comme un jalon
        déroulé.

        L'intention part avec la veille depuis #426 : la laisser sur le disque
        la faisait confronter par `pr_gate.py` comme si elle décrivait le run
        suivant.
        """
        seen, disarm, spawn = self.watchdog([sup.NO_RUN, sup.PAUSE], ["#60 clos"])
        self.assertEqual(seen, ["gate", "replan", "gate"])
        disarm.assert_called_once()
        spawn.assert_not_called()
        self.assertFalse(self.intent.exists())

    def test_un_gate_vert_ne_paie_aucun_replan(self):
        seen, _, spawn = self.watchdog([sup.GO], ["#60 clos"])
        self.assertEqual(seen, ["gate"])
        spawn.assert_called_once()


class IntentionDelieeAuDesarmement(unittest.TestCase):
    """#426 — aucun chemin de désarmement ne laisse l'intention sur le disque.

    `pr_gate.py` relit ce fichier à chaque décision de merge depuis #414 et
    suppose qu'il décrit le run en cours. Le chemin `STOP` / `PAUSE` de
    `cmd_watchdog` désarmait la veille sans le délier : le run suivant, armé
    `--merge-sensitive prisma`, se voyait confronté au `"merge_sensitive": []`
    du mort et perdait l'autorisation vivante de son opérateur.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.intent = Path(self.tmp.name) / "supervisor.json"

    def watchdog(self, verdict, intent=None, run="run-vivant"):
        self.intent.write_text(json.dumps(intent if intent is not None else {}),
                               encoding="utf-8")
        with mock.patch.object(sup, "INTENT", self.intent), \
             mock.patch.object(sup, "supervisor_alive", return_value=False), \
             mock.patch.object(sup, "orchestrator_active", return_value=False), \
             mock.patch.object(sup, "current_run", return_value=run), \
             mock.patch.object(sup, "authorised", return_value=(True, None)), \
             mock.patch.object(sup, "load_intent",
                               return_value=intent if intent is not None else {}), \
             mock.patch.object(sup, "quota_file_hold", return_value=None), \
             mock.patch.object(sup, "held_off", return_value=False), \
             mock.patch.object(sup, "watchdog_armed", return_value=True), \
             mock.patch.object(sup, "plan_outdated_since_replan", return_value=[]), \
             mock.patch.object(sup, "disarm_watchdog") as disarm, \
             mock.patch.object(sup, "spawn_supervisor") as spawn, \
             mock.patch.object(sup, "runner",
                               return_value=mock.Mock(returncode=verdict,
                                                      stdout="")):
            sup.cmd_watchdog(argparse.Namespace())
        return disarm, spawn

    def test_un_arret_delie_l_intention(self):
        disarm, spawn = self.watchdog(sup.STOP)
        disarm.assert_called_once()
        spawn.assert_not_called()
        self.assertFalse(self.intent.exists())

    def test_une_pause_delie_l_intention(self):
        """Même traitement que l'arrêt, et pour la même raison qu'ailleurs :
        `supervise()` appelle déjà `retire()` sur ses deux verdicts. Reprendre
        après une pause passe par `milestone_run.py go` puis un `/milestone`
        neuf, qui réarme — et retape ses périmètres."""
        disarm, spawn = self.watchdog(sup.PAUSE)
        disarm.assert_called_once()
        spawn.assert_not_called()
        self.assertFalse(self.intent.exists())

    def test_un_jalon_deroule_delie_l_intention(self):
        """Le chemin qui le faisait déjà — vérifié ici pour qu'un remaniement
        du désarmement ne le perde pas en chemin."""
        disarm, _ = self.watchdog(sup.NO_RUN)
        disarm.assert_called_once()
        self.assertFalse(self.intent.exists())

    def test_un_verdict_qui_laisse_travailler_garde_l_intention(self):
        _, spawn = self.watchdog(sup.GO)
        spawn.assert_called_once()
        self.assertTrue(self.intent.exists())

    # --- l'intention d'un run sans veille n'est pas une consigne de relance ---

    def test_une_intention_sans_veille_retire_la_tache_sans_l_effacer(self):
        """#426 — `--no-watchdog` écrit désormais son intention pour la barrière.

        Une tâche planifiée qui se réveille devant une intention étrangère au
        run ouvert est un vestige d'un armement précédent : elle se retire, mais
        toucher au fichier reviendrait à retirer au run vivant l'armement que
        `pr_gate.py` doit confronter à la variable de ses vagues.
        """
        disarm, spawn = self.watchdog(sup.GO, intent={"watchdog": False,
                                                      "run": "run-mort"})
        disarm.assert_called_once()
        spawn.assert_not_called()
        self.assertTrue(self.intent.exists())

    def test_une_intention_sans_run_inscrit_est_tenue_pour_un_vestige(self):
        """Elle ne peut pas prouver qu'elle décrit le run ouvert : le sens
        prudent est le même que pour un identifiant qui en désigne un autre."""
        disarm, _ = self.watchdog(sup.GO, intent={"watchdog": False})
        disarm.assert_called_once()

    def test_la_veille_du_run_ouvert_survit_a_un_superviseur_sans_veille(self):
        """`--no-watchdog` dit « ce processus n'arme rien », jamais « désarmez
        ce qui l'est ».

        `/milestone` arme la tâche à chaque `start` ; un superviseur de passage
        lancé `--no-watchdog` sur le même run réécrit l'intention en
        `watchdog: false`. Désarmer devant elle emporterait la reprise
        automatique que l'opérateur a demandée pour ce run-là — et le run ne
        repartirait plus après le plantage de ce superviseur-ci. `--disarm`
        reste le geste qui débranche.
        """
        disarm, spawn = self.watchdog(sup.GO, intent={"watchdog": False,
                                                      "run": "run-vivant"})
        disarm.assert_not_called()
        # Sans relancer pour autant : le drapeau vaut toujours pour la relance.
        spawn.assert_not_called()

    def test_une_intention_avec_veille_relance_normalement(self):
        _, spawn = self.watchdog(sup.GO, intent={"watchdog": True})
        spawn.assert_called_once()


class IntentionRattacheeAuRunVivant(unittest.TestCase):
    """#426 — le champ qui distingue un armement vivant d'un vestige.

    C'est lui que `pr_gate.py` compare à `current`. Écrit par `intent_of()`
    depuis #323, il vaut None quand le superviseur s'arme avant que sa première
    étape n'ouvre le run : `stamp_intent_run()` le rattrape, sans jamais
    réécrire un identifiant déjà posé — ce serait s'approprier l'armement d'un
    autre run, précisément ce que ce champ empêche.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.intent = Path(self.tmp.name) / "supervisor.json"
        patch = mock.patch.object(sup, "INTENT", self.intent)
        patch.start()
        self.addCleanup(patch.stop)

    def ecrit(self, **fields):
        self.intent.write_text(json.dumps(fields), encoding="utf-8")

    def stamp(self, run):
        with mock.patch.object(sup, "current_run", return_value=run):
            sup.stamp_intent_run()
        return sup.load_intent()

    def test_une_intention_sans_run_est_rattachee_des_qu_il_existe(self):
        self.ecrit(merge_sensitive=["prisma"], run=None)
        self.assertEqual(self.stamp("run-vivant")["run"], "run-vivant")

    def test_un_run_deja_inscrit_n_est_jamais_reecrit(self):
        """Le rattachement ne doit pas devenir un moyen de s'approprier
        l'armement d'un run mort en le rebaptisant."""
        self.ecrit(merge_sensitive=["prisma"], run="run-mort")
        self.assertEqual(self.stamp("run-vivant")["run"], "run-mort")

    def test_sans_run_ouvert_rien_n_est_ecrit(self):
        self.ecrit(merge_sensitive=[], run=None)
        avant = self.intent.read_text(encoding="utf-8")
        self.stamp(None)
        self.assertEqual(self.intent.read_text(encoding="utf-8"), avant)

    def test_sans_intention_sur_le_disque_rien_ne_leve(self):
        self.stamp("run-vivant")
        self.assertFalse(self.intent.exists())

    def test_le_reste_de_l_armement_survit_au_rattachement(self):
        self.ecrit(merge_sensitive=["prisma"], no_merge=False, width=5)
        rattachee = self.stamp("run-vivant")
        self.assertEqual(rattachee["merge_sensitive"], ["prisma"])
        self.assertEqual(rattachee["width"], 5)

    def test_un_dry_run_ne_rattache_rien(self):
        """Simuler, c'est ne rien poser sur le disque.

        `--dry-run` n'écrit aucune intention à l'armement : celle qu'il trouve
        est celle de quelqu'un d'autre. Lui apposer l'identifiant du run vivant
        la ferait confronter par `pr_gate.py` aux vagues d'aujourd'hui — le
        `"merge_sensitive": []` d'un vestige révoquant l'autorisation de
        l'opérateur, c'est-à-dire #426 recréé par un simulacre.
        """
        source = inspect.getsource(sup.supervise)
        avant = source[:source.index("stamp_intent_run()")]
        self.assertTrue(avant.rstrip().endswith("if not args.dry_run:"),
                        "le seul appel de la boucle doit être gardé par "
                        "`if not args.dry_run:`")
        self.assertEqual(source.count("stamp_intent_run()"), 1)


class VeilleNonArmeeEcritSonIntention(unittest.TestCase):
    """#426 — `--no-watchdog` écrit son intention, et dit qu'il ne relance rien.

    Le sort de ce drapeau est tranché ici : il pose `SPA_MERGE_SENSITIVE` dans
    l'environnement de chacune de ses vagues, donc la barrière doit avoir de quoi
    la confronter. Sans intention, elle croyait la variable telle quelle — ou,
    pire, la confrontait à l'armement d'un run mort resté sur le disque.
    """

    def args(self, **fields):
        base = dict(milestone="S3", width=3, nature="projet", waves_per_leg=1,
                    no_merge=False, merge_sensitive={"prisma"},
                    permission_mode="acceptEdits", model=None, margin=90,
                    patience=2, max_legs=40, leg_timeout=120, claude="claude",
                    no_watchdog=False, dry_run=False, every=5)
        base.update(fields)
        return argparse.Namespace(**base)

    def test_le_champ_dit_si_une_veille_a_ete_demandee(self):
        self.assertIs(sup.intent_of(self.args(no_watchdog=True))["watchdog"],
                      False)
        self.assertIs(sup.intent_of(self.args())["watchdog"], True)

    def test_le_champ_ne_se_rejoue_pas_dans_la_ligne_de_commande(self):
        """`--no-watchdog` reste un choix de chaque processus : `reload_source`
        le relaie lui-même, et un superviseur ressuscité doit pouvoir s'armer."""
        argv = sup.intent_argv(sup.intent_of(self.args(no_watchdog=True)))
        self.assertNotIn("--no-watchdog", argv)
        self.assertNotIn("--watchdog", argv)

    def test_l_intention_est_ecrite_meme_sans_veille(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        intent = Path(tmp.name) / "supervisor.json"
        with mock.patch.object(sup, "INTENT", intent), \
             mock.patch.object(sup, "arm_watchdog") as arme, \
             mock.patch.object(sup, "watchdog_armed", return_value=False), \
             mock.patch.object(sup, "dropped_scopes", return_value=[]):
            sup.save_intent(self.args(no_watchdog=True))
            ecrite = sup.load_intent()
        # Écrite, avec les périmètres que ce lancement a reçus…
        self.assertEqual(ecrite["merge_sensitive"], ["prisma"])
        # …et sans avoir armé quoi que ce soit.
        arme.assert_not_called()
        self.assertIs(ecrite["watchdog"], False)

    def test_supervise_n_arme_pas_mais_ecrit(self):
        """La branche de `supervise()` elle-même : le garde-fou du drapeau y est
        passé de « ne rien écrire » à « écrire sans armer »."""
        source = inspect.getsource(sup.supervise)
        debut = source.index("if not args.dry_run")
        fin = source.index("held = quota_file_hold()", debut)
        branche = source[debut:fin]
        self.assertNotIn("not args.no_watchdog", branche.split("\n")[0])
        self.assertIn("save_intent(args)", branche)
        self.assertIn("arm_watchdog", branche)


class FinDeRunDansLaBoucleCourte(unittest.TestCase):
    """#422 — le même correctif, du côté de la boucle du superviseur.

    `supervise()` ne se pilote pas depuis un banc d'essai : elle lance des
    `claude -p`. On lit donc son texte, comme le fait déjà le câblage de
    l'empreinte de la source — et pour la même raison : un correctif que personne
    n'appelle ne corrige rien, et c'est la seule façon dont celui-ci peut
    régresser sans qu'aucun autre test ne bouge.

    Ce qui compte est l'ordre : l'arbitrage de fin de run, **puis** le replan,
    **puis** seulement le débranchement — et un `continue` entre les deux, qui
    fait relire le gate au lieu de conclure.
    """

    def test_le_replan_s_intercale_entre_l_arbitrage_et_le_debranchement(self):
        code = inspect.getsource(sup.supervise)
        _, borne, apres = code.partition('rescue(["fin_de_run"])')
        indice = ("ce test lit le texte de supervise() : un renommage de "
                  "`rescue`, de `replan_before_concluding` ou de `retire` le "
                  "casse sans que rien ne soit cassé — recoller le test au "
                  "code, ou le remplacer")
        self.assertTrue(borne, indice)
        replan = apres.find("replan_before_concluding")
        debranchement = apres.find('retire("jalon déroulé")')
        self.assertNotEqual(replan, -1, indice)
        self.assertNotEqual(debranchement, -1, indice)
        self.assertLess(replan, debranchement, indice)
        self.assertIn("continue", apres[replan:debranchement], indice)

    def test_le_replan_de_conclusion_ne_se_redonne_pas_sans_etape(self):
        """Le `continue` doit être à un coup : l'arbitrage de fin de run inscrit
        une décision à chaque tour, ce qui périme le plan à chaque tour. Sans
        verrou, le cycle « arbitrage → replan → continue → NO_RUN » se rappelle
        lui-même jusqu'à vider le budget d'arbitrage, et aucun leg ne
        s'incrémente pour le borner."""
        code = inspect.getsource(sup.supervise)
        _, borne, apres = code.partition('rescue(["fin_de_run"])')
        self.assertTrue(borne)
        self.assertIn("not reconclu and replan_before_concluding", apres,
                      "le replan de conclusion doit être gardé par un verrou "
                      "à un coup, retombant dès qu'une étape a tourné")
        self.assertIn("reconclu = False", apres.split('retire("jalon déroulé")')[-1],
                      "le verrou doit retomber quand une étape démarre")


if __name__ == "__main__":
    unittest.main()
