#!/usr/bin/env python3
"""Tests de l'arbitre — `scripts/milestone_arbiter.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

L'arbitre est la seule pièce du dispositif qui décide à la place de quelqu'un.
Ce qui est couvert ici est donc ce qui empêche cette décision de mal tourner, et
rien d'autre :

**L'escalade.** Un arbitre qui relance indéfiniment le même ticket sur la même
panne consomme le quota d'un jalon entier sans rien produire — c'est #138 avec un
modèle en plus. `next_rung` est ce qui l'interdit, et l'empreinte de la cause est
ce qui lui fait reconnaître « la même panne ».

**Le budget.** Deux compteurs bornent l'arbitrage, et le second existe parce que
le premier peut mentir : un arbitre mort avant d'avoir rien inscrit laisse le
compteur du dossier à zéro.

**Les motifs.** Un arbitrage n'a lieu que s'il y a matière. Le contraire — un
appel d'Opus 5 après chaque étape saine — coûterait plus cher que ce qu'il
sauve, et le dispositif serait débranché au bout d'une nuit.

Aucun réseau, aucun modèle : les appels externes sont bouchonnés. C'est ce qui
rend ces tests exécutables dans la CI, et c'est aussi ce qui a dicté la
séparation entre ce fichier et le jugement, qui vit dans
`.claude/commands/milestone-arbitrate.md`.
"""
import contextlib
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import milestone_arbiter as arb          # noqa: E402 — l'insertion le précède
import milestone_run as run_mod          # noqa: E402


class Empreinte(unittest.TestCase):
    """Deux blocages sont « le même » quand ils ne diffèrent que par un détail
    de position. C'est cette égalité qui fait monter l'escalade d'un cran."""

    def test_le_numero_de_ligne_ne_change_pas_la_cause(self):
        self.assertEqual(
            arb.signature("typecheck : erreur TS2345 dans auth.service.ts:84"),
            arb.signature("typecheck : erreur TS2345 dans auth.service.ts:112"))

    def test_le_chemin_absolu_ne_change_pas_la_cause(self):
        self.assertEqual(
            arb.signature("Cannot find module D:/spyle/x/node_modules/zod"),
            arb.signature("Cannot find module C:/autre/y/node_modules/zod"))

    def test_deux_pannes_differentes_ont_deux_empreintes(self):
        self.assertNotEqual(arb.signature("npm run lint rouge"),
                            arb.signature("rebase en conflit sur schema.prisma"))

    def test_une_cause_absente_reste_stable(self):
        self.assertEqual(arb.signature(None), arb.signature(""))


class Escalade(unittest.TestCase):
    """L'échelle : relancer, corriger, écarter — et jamais « arrêter le jalon »."""

    @staticmethod
    def past(*rungs, ticket=21, sign=None):
        return [{"ticket": ticket, "rung": rung, "signature": sign}
                for rung in rungs]

    def test_jamais_arbitre_on_relance(self):
        self.assertEqual(arb.next_rung([], 21), "retry")

    def test_apres_une_relance_on_corrige(self):
        self.assertEqual(arb.next_rung(self.past("retry"), 21), "fix")

    def test_la_meme_panne_deux_fois_saute_un_cran(self):
        """Réessayer à l'identique une panne déjà rencontrée est le seul
        comportement qu'un arbitre ne doit jamais avoir."""
        history = self.past("retry", sign="abc")
        self.assertEqual(arb.next_rung(history, 21, "abc"), "skip")

    def test_une_panne_nouvelle_monte_d_un_seul_cran(self):
        history = self.past("retry", sign="abc")
        self.assertEqual(arb.next_rung(history, 21, "zzz"), "fix")

    def test_le_budget_du_ticket_force_l_ecartement(self):
        """C'est ce qui garantit qu'un ticket ne retient pas le jalon : au bout
        de son budget, il n'y a plus qu'un cran possible."""
        self.assertEqual(arb.next_rung(self.past("retry", "fix"), 21), "skip")

    def test_l_historique_d_un_autre_ticket_ne_compte_pas(self):
        history = self.past("retry", "fix", ticket=19)
        self.assertEqual(arb.next_rung(history, 21), "retry")

    def test_on_ne_depasse_jamais_le_dernier_cran(self):
        history = self.past("skip", sign="abc")
        self.assertEqual(arb.next_rung(history, 21, "abc"), "skip")

    def test_aucun_cran_ne_s_appelle_arreter(self):
        """L'arrêt du jalon n'est pas une décision d'arbitrage."""
        self.assertEqual(arb.LADDER, ["retry", "fix", "skip"])


class Budget(unittest.TestCase):
    """Ce qui reste à dépenser, et sur qui."""

    def test_le_compte_par_ticket(self):
        history = [{"ticket": 21}, {"ticket": 21}, {"ticket": 19}]
        self.assertEqual(arb.spent(history, 21), 2)
        self.assertEqual(arb.spent(history), 3)

    def test_le_reste_du_run(self):
        counts = arb.summary([{"ticket": 21}] * 4, per_run=12)
        self.assertEqual(counts["total"], 4)
        self.assertEqual(counts["reste_run"], 8)
        self.assertEqual(counts["par_ticket"], {"21": 4})

    def test_un_budget_depasse_ne_devient_pas_negatif(self):
        self.assertEqual(arb.summary([{}] * 20, per_run=12)["reste_run"], 0)


class Motifs(unittest.TestCase):
    """Un arbitrage n'a lieu que s'il y a matière — une étape saine n'en
    déclenche aucun, sans quoi le dispositif coûterait plus qu'il ne sauve."""

    @staticmethod
    def payload(code=run_mod.GO, tombes=(), prs=(), pause_humaine=False):
        return {"gate": {"code": code}, "tombes": list(tombes), "prs": list(prs),
                "pause_humaine": pause_humaine}

    def test_une_etape_saine_ne_declenche_rien(self):
        self.assertEqual(arb.motifs(self.payload()), [])

    def test_le_gate_qui_retient_est_un_motif(self):
        self.assertIn("gate_pause", arb.motifs(self.payload(code=run_mod.PAUSE)))

    def test_un_ticket_tombe_est_un_motif(self):
        self.assertIn("tickets_tombes", arb.motifs(self.payload(tombes=[21])))

    def test_la_fin_du_jalon_ouvre_la_passe_d_anomalies(self):
        self.assertIn("fin_de_run", arb.motifs(self.payload(code=run_mod.NO_RUN)))

    def test_une_pr_verte_non_mergee_est_un_motif(self):
        """C'est exactement ce que le run laissait dormir jusqu'au matin."""
        prs = [{"barriere": {"code": 0}, "maj": "2026-08-25T10:00:00Z"}]
        self.assertIn("pr_en_souffrance", arb.motifs(self.payload(prs=prs)))

    def test_une_pr_de_perimetre_sensible_est_un_motif(self):
        prs = [{"barriere": {"code": 5}, "maj": "2026-08-25T10:00:00Z"}]
        self.assertIn("pr_en_souffrance", arb.motifs(self.payload(prs=prs)))

    def test_une_pr_en_attente_de_ci_n_est_pas_un_motif(self):
        """La CI qui tourne n'attend personne : l'arbitre n'a rien à y faire."""
        prs = [{"barriere": {"code": 1}, "maj": "2026-08-25T10:00:00Z"}]
        self.assertEqual(arb.motifs(self.payload(prs=prs)), [])

    def test_une_pr_endormie_se_voit_sans_interroger_la_barriere(self):
        """`should` ne paie pas la barrière — c'est là qu'il décide de dépenser
        un tour d'Opus 5. Sans repli, le motif ne se lèverait que dans
        `diagnose`, donc une fois l'arbitre déjà appelé pour autre chose, et la
        PR verte laissée ouverte dormirait jusqu'au matin."""
        prs = [{"maj": "2020-01-01T00:00:00Z", "brouillon": False,
                "checks": {"total": 3, "verts": 3, "rouges": []}}]
        self.assertIn("pr_en_souffrance", arb.motifs(self.payload(prs=prs)))

    def test_une_pr_touchee_a_l_instant_n_est_pas_endormie(self):
        """L'horodatage de GitHub est en UTC : le lire comme une heure locale
        ferait passer pour vieille de deux heures une PR poussée il y a une
        minute — et l'arbitre serait appelé après chaque étape."""
        fresh = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        prs = [{"maj": fresh, "brouillon": False,
                "checks": {"total": 3, "verts": 3, "rouges": []}}]
        self.assertEqual(arb.motifs(self.payload(prs=prs)), [])

    def test_un_brouillon_endormi_n_appelle_personne(self):
        prs = [{"maj": "2020-01-01T00:00:00Z", "brouillon": True,
                "checks": {"total": 3, "verts": 3, "rouges": []}}]
        self.assertEqual(arb.motifs(self.payload(prs=prs)), [])

    def test_les_motifs_du_superviseur_sont_repris_tels_quels(self):
        """Lui seul a vu l'étape mourir ; rien dans les fichiers n'en garde
        trace exploitable."""
        found = arb.motifs(self.payload(), ["leg_delai", "patience"])
        self.assertEqual(found, ["leg_delai", "patience"])

    def test_un_motif_inconnu_est_ignore(self):
        self.assertEqual(arb.motifs(self.payload(), ["n_importe_quoi"]), [])

    def test_aucun_motif_n_est_compte_deux_fois(self):
        found = arb.motifs(self.payload(code=run_mod.PAUSE), ["gate_pause"])
        self.assertEqual(found.count("gate_pause"), 1)


class PauseHumaine(unittest.TestCase):
    """#262 — la pause qu'un humain a posée n'est pas un motif d'arbitrage.

    Le gate rend le même code de sortie pour deux situations opposées : la pause
    sur erreur, que l'arbitre **doit** trancher, et la pause posée à la main,
    qu'il n'a pas le droit de lever (« c'est une décision qui n'est pas la
    tienne »). Confondues, elles produisaient un arbitrage qui rendait la main
    sans rien changer, puis se faisait rappeler trente secondes plus tard sur le
    même dossier — douze fois, jusqu'à ce que le budget du run soit vide et
    qu'un incident réel ne trouve plus de quoi être arbitré.
    """

    @staticmethod
    def payload(pause_humaine, tombes=()):
        return {"gate": {"code": run_mod.PAUSE}, "tombes": list(tombes),
                "prs": [], "pause_humaine": pause_humaine}

    def test_une_pause_humaine_n_ouvre_pas_d_arbitrage(self):
        self.assertNotIn("gate_pause", arb.motifs(self.payload(True)))

    def test_une_pause_sur_erreur_en_ouvre_toujours_un(self):
        """Le correctif ne doit pas museler l'arbitre sur le cas qui, lui,
        demande vraiment une décision."""
        self.assertIn("gate_pause", arb.motifs(self.payload(False)))

    def test_le_motif_force_par_le_superviseur_est_retire_aussi(self):
        """`milestone_supervise.py` appelle `rescue(["gate_pause"])` sur le seul
        code de sortie du gate, sans plus de discernement que l'arbitre n'en
        avait. Sans ce retrait, la boucle repartait par ce chemin-là."""
        self.assertNotIn("gate_pause",
                         arb.motifs(self.payload(True), ["gate_pause"]))

    def test_une_pause_humaine_n_etouffe_pas_les_autres_motifs(self):
        """Un ticket tombé pendant qu'un humain tient le run en pause reste un
        motif : c'est le `gate_pause` qui est stérile, pas l'arbitrage."""
        found = arb.motifs(self.payload(True, tombes=[21]))
        self.assertEqual(found, ["tickets_tombes"])

    def test_le_dossier_porte_la_lecture_faite_du_controle(self):
        """La distinction se lit dans `control.json`, pas dans le journal :
        c'est `control.json` que le gate consulte."""
        control = {"signal": "pause", "signal_actor": "humain"}
        self.assertTrue(run_mod.human_pause(control))
        self.assertFalse(run_mod.human_pause(
            {"signal": "pause", "signal_actor": "superviseur"}))

    def test_la_pause_apparait_en_clair_dans_le_dossier_rendu(self):
        payload = {"run": {"id": "r1", "jalon": "S1", "largeur": 2},
                   "gate": {"code": run_mod.PAUSE, "sens": "pause demandée"},
                   "motifs": [], "signal": "pause", "signal_acteur": "humain",
                   "pause_humaine": True, "vague": None, "tickets": [],
                   "prs": [], "arbitrages": arb.summary([])}
        rendered = arb.render(payload)
        self.assertIn("pause posée par humain", rendered)
        self.assertIn("à ne pas lever", rendered)


class DevelopCasse(unittest.TestCase):
    """`develop` rouge après une vague verte — une interaction entre deux tickets
    que le plan croyait indépendants.

    Personne ne peut le déduire d'un fichier : git trouve `develop` parfaitement
    sain. Seul l'orchestrateur le constate, en phase 4 de `/milestone`, et le
    journalise au niveau du run. Ne pas le relire ici laissait le motif
    `verify_rouge` déclaré et jamais levé — un `develop` cassé dormait jusqu'au
    matin.
    """

    @staticmethod
    def blocked(ts, message, ticket=None):
        return {"ts": ts, "ticket": ticket, "status": "blocked",
                "message": message}

    def test_le_constat_de_l_orchestrateur_est_lu(self):
        found = arb.broken_develop(
            [self.blocked("2026-08-26T10:00:00+00:00",
                          "npm run verify rouge sur develop apres la vague 2")],
            [])
        self.assertIsNotNone(found)
        self.assertIn("verify", found["message"])

    def test_un_develop_vert_ne_leve_rien(self):
        """La ligne exacte qui levait le motif sur le run S1 du 25/08.

        `verify` en alternative isolée suffisait : un compte rendu de vague qui
        **annonce** que la barrière est verte contient le mot, et faisait donc
        dépenser un arbitrage Opus 5 pour dire que tout allait bien — à chaque
        étape, puisque rien dans le journal ne cesse d'être vrai.
        """
        self.assertIsNone(arb.broken_develop(
            [self.blocked("2026-08-25T12:26:07+00:00",
                          "vague 1 close : #19 et #14 mergees, develop vert "
                          "(npm run verify exit 0). Arret sur #150.")], []))

    def test_les_formules_de_la_phase_4_sont_toutes_reconnues(self):
        for message in ("npm run verify rouge sur develop apres la vague 2",
                        "develop rouge : test:concurrency en echec",
                        "build rouge apres le merge de #21",
                        "tests rouges sur develop",
                        "barriere rouge sur develop"):
            with self.subTest(message=message):
                self.assertIsNotNone(arb.broken_develop(
                    [self.blocked("2026-08-26T10:00:00+00:00", message)], []))

    def test_l_enlisement_du_superviseur_n_est_pas_un_develop_casse(self):
        """Le superviseur journalise lui aussi des `blocked` de run. Les
        confondre ferait arbitrer une panne pour une autre."""
        self.assertIsNone(arb.broken_develop(
            [self.blocked("2026-08-26T10:00:00+00:00",
                          "2 legs sans commit — superviseur arrêté (#138)")], []))

    def test_un_blocage_de_ticket_n_en_est_pas_un_non_plus(self):
        self.assertIsNone(arb.broken_develop(
            [self.blocked("2026-08-26T10:00:00+00:00",
                          "npm run verify rouge", ticket=21)], []))

    def test_un_constat_deja_arbitre_ne_relance_rien(self):
        """Un journal est en ajout seul : la ligne y reste pour toujours. Sans
        ce rapprochement, le même constat consommerait tout le budget."""
        events = [self.blocked("2026-08-26T10:00:00+00:00", "verify rouge")]
        history = [{"ts": "2026-08-26T10:05:00+00:00", "motif": "verify_rouge"}]
        self.assertIsNone(arb.broken_develop(events, history))

    def test_un_constat_posterieur_au_dernier_arbitrage_compte(self):
        events = [self.blocked("2026-08-26T11:00:00+00:00", "verify rouge")]
        history = [{"ts": "2026-08-26T10:05:00+00:00", "motif": "verify_rouge"}]
        self.assertIsNotNone(arb.broken_develop(events, history))

    def test_le_motif_remonte_dans_le_dossier(self):
        payload = {"gate": {"code": run_mod.GO}, "tombes": [], "prs": [],
                   "develop_rouge": {"ts": "x", "message": "verify rouge"}}
        self.assertIn("verify_rouge", arb.motifs(payload))


class Inscription(unittest.TestCase):
    """Sans inscription, la décision n'existe pas : l'escalade repart de zéro au
    prochain arbitrage, et le même ticket est relancé à l'infini."""

    def test_l_aller_retour_par_le_disque(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"):
                (Path(tmp) / "r1").mkdir()
                arb.record("r1", "tickets_tombes", "relancé après quota",
                           ticket=21, rung="retry", sign="abc", action="retry")
                history = arb.arbitrations("r1")

        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["ticket"], 21)
        self.assertEqual(history[0]["rung"], "retry")
        self.assertEqual(history[0]["signature"], "abc")
        self.assertEqual(history[0]["actor"], "arbitre")

    def test_la_decision_part_aussi_dans_le_journal_du_run(self):
        """Une décision prise à la place de quelqu'un doit se lire là où il
        regarde — `watch`, `log`, `ticket N` — pas dans un fichier à part."""
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)), \
                 mock.patch.object(run_mod, "LATEST_LOG", Path(tmp) / "latest.log"):
                (Path(tmp) / "r1").mkdir()
                arb.record("r1", "gate_pause", "écarté, issue #200 ouverte",
                           ticket=21, rung="skip")
                journal = (Path(tmp) / "r1" / "journal.ndjson").read_text(
                    encoding="utf-8")

        event = json.loads(journal.strip())
        self.assertEqual(event["actor"], "arbitre")
        self.assertEqual(event["level"], "WARN")
        self.assertIn("skip", event["message"])

    def test_un_fichier_absent_rend_un_historique_vide(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                (Path(tmp) / "r1").mkdir()
                self.assertEqual(arb.arbitrations("r1"), [])

    def test_une_ligne_abimee_n_emporte_pas_les_autres(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_mod, "RUNS_DIR", Path(tmp)):
                (Path(tmp) / "r1").mkdir()
                (Path(tmp) / "r1" / arb.ARBITRATIONS).write_text(
                    '{"ticket": 21}\nceci n\'est pas du json\n{"ticket": 19}\n',
                    encoding="utf-8")
                self.assertEqual(len(arb.arbitrations("r1")), 2)


class ResumeDEtape(unittest.TestCase):
    """Le flux d'une étape pèse plusieurs mégaoctets. Ce qu'on en garde est ce
    qui explique une étape ratée, et rien de plus."""

    @staticmethod
    def write(tmp, messages):
        path = Path(tmp) / "leg.ndjson"
        with open(path, "w", encoding="utf-8") as handle:
            for message in messages:
                handle.write(json.dumps(message) + "\n")
        return path

    def test_la_raison_de_fin_et_le_cout(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, [{"type": "result", "subtype": "success",
                                     "num_turns": 42, "total_cost_usd": 3.5}])
            digest = arb.leg_digest(path)
        self.assertEqual(digest["fin"], "success")
        self.assertEqual(digest["tours"], 42)
        self.assertEqual(digest["cout"], 3.5)

    def test_une_meme_erreur_repetee_n_est_gardee_qu_une_fois(self):
        """Une boucle de correction répète trente fois la même sortie ; la
        trentième n'apprend rien et noierait les autres."""
        error = {"type": "user", "message": {"content": [
            {"is_error": True, "content": "npm run lint : 3 erreurs dans auth.ts:12"}]}}
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, [error] * 5)
            digest = arb.leg_digest(path)
        self.assertEqual(len(digest["erreurs"]), 1)

    def test_les_refus_de_permission_sont_ranges_a_part(self):
        """C'est la panne qui fige une étape entière sans que rien n'échoue :
        elle doit se lire d'un coup d'œil, pas se chercher."""
        refusal = {"type": "user", "message": {"content": [
            {"is_error": True, "content": "Permission denied for Bash(gh pr merge)"}]}}
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write(tmp, [refusal])
            digest = arb.leg_digest(path)
        self.assertEqual(digest["erreurs"], [])
        self.assertEqual(len(digest["permissions"]), 1)

    def test_une_ligne_illisible_n_interrompt_pas_la_lecture(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "leg.ndjson"
            path.write_text('pas du json\n{"type": "result", "subtype": "success"}\n',
                            encoding="utf-8")
            self.assertEqual(arb.leg_digest(path)["fin"], "success")

    def test_aucune_etape_rend_none(self):
        self.assertIsNone(arb.leg_digest(None))


class Verdict(unittest.TestCase):
    """`should` : ce que le superviseur lit avant de dépenser un tour d'Opus 5."""

    def payload(self, motifs, reste):
        return {"motifs": motifs,
                "arbitrages": {"total": 12 - reste, "budget_run": 12,
                               "reste_run": reste, "budget_ticket": 2,
                               "par_ticket": {}, "derniers": []}}

    def call(self, motifs, reste):
        args = mock.Mock(run=None, reason=[], per_ticket=2, per_run=12)
        with mock.patch.object(arb.run_mod, "resolve", return_value="r1"), \
             mock.patch.object(arb, "dossier",
                               return_value=self.payload(motifs, reste)):
            return arb.cmd_should(args)

    def test_rien_a_arbitrer_rend_un(self):
        self.assertEqual(self.call([], 12), 1)

    def test_un_motif_avec_du_budget_rend_zero(self):
        self.assertEqual(self.call(["tickets_tombes"], 5), 0)

    def test_le_budget_epuise_rend_un_malgre_le_motif(self):
        """Un budget épuisé ne veut plus dire qu'un ticket résiste : c'est le
        jalon qui ne tient pas, et c'est un humain qu'il faut."""
        self.assertEqual(self.call(["tickets_tombes"], 0), 1)

    def test_sans_run_ouvert_il_n_y_a_rien_a_arbitrer(self):
        args = mock.Mock(run=None, reason=[], per_ticket=2, per_run=12)
        with mock.patch.object(arb.run_mod, "resolve", return_value=None):
            self.assertEqual(arb.cmd_should(args), 1)


class DossierInchange(unittest.TestCase):
    """#262 — on ne rappelle pas l'arbitre sur un dossier qu'il vient de juger.

    Filet indépendant du discernement des motifs, et c'est sa raison d'être : il
    couvre tout motif susceptible de se représenter à l'identique, pas seulement
    celui qu'on a vu boucler. Rappelé sur un dossier inchangé, l'arbitre rendra
    la même décision au prix d'un tour d'Opus 5, et recommencera jusqu'à ce que
    le budget du run soit vide.

    La seule écriture qui ne compte pas pour un mouvement est la trace que
    l'arbitrage laisse lui-même au journal en s'inscrivant : `record` n'appelle
    `now()` qu'une fois pour les deux fichiers, d'où l'horodatage commun.
    """

    LEG = {"ts": "2026-08-25T16:49:58+00:00", "kind": "run",
           "status": "leg_ended", "message": "étape 4 rendue"}
    RENDU = "2026-08-25T16:51:49+00:00"
    # Ce que `record` écrit au journal, au même horodatage que la décision.
    TRACE = {"ts": RENDU, "kind": "run", "actor": "arbitre",
             "message": "arbitrage [gate_pause] — pause HUMAINE, je ne la lève pas"}

    def test_sans_arbitrage_anterieur_rien_ne_bloque(self):
        self.assertFalse(arb.already_arbitrated(["gate_pause"], [], [self.LEG]))

    def test_sans_motif_il_n_y_a_rien_a_comparer(self):
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        self.assertFalse(arb.already_arbitrated([], history, [self.LEG]))

    def test_le_meme_motif_sans_rien_de_neuf_ne_rouvre_pas(self):
        """Le cas exact du run S1 : arbitrage 1 rendu à 16:51:49, arbitrage 2
        ouvert à 16:52:21 sur un dossier identique."""
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        self.assertTrue(arb.already_arbitrated(
            ["gate_pause"], history, [self.LEG, self.TRACE]))

    def test_la_tenue_de_compte_du_superviseur_n_est_pas_un_mouvement(self):
        """`milestone_supervise` journalise « arbitrage N rendu » **après** le
        `record`, et un battement pendant l'appel. Comptées, ces écritures
        prouvaient à chaque tour que le dossier avait bougé — et le filet ne se
        serait jamais déclenché dans la boucle réelle."""
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        rendu = {"ts": "2026-08-25T16:51:52+00:00", "kind": "run",
                 "actor": "superviseur", "status": "arbitrage",
                 "message": "arbitrage 1 rendu — terminé"}
        beat = {"ts": "2026-08-25T16:52:10+00:00", "kind": "run",
                "actor": "superviseur", "beat": True,
                "message": "arbitrage en vol depuis 1 min"}
        self.assertTrue(arb.already_arbitrated(
            ["gate_pause"], history, [self.LEG, self.TRACE, rendu, beat]))

    def test_un_evenement_posterieur_rouvre_le_dossier(self):
        """Le journal du run est ce qui bouge quand quelque chose se passe :
        une étape qui se termine remet l'arbitrage sur la table."""
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        suite = dict(self.LEG, ts="2026-08-25T17:10:00+00:00")
        self.assertFalse(arb.already_arbitrated(
            ["gate_pause"], history, [self.LEG, self.TRACE, suite]))

    def test_un_motif_neuf_rouvre_le_dossier(self):
        """Une PR qui vient de virer au vert, un ticket qui vient de tomber :
        le dossier n'est plus le même, même si le journal n'a pas bougé."""
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        self.assertFalse(arb.already_arbitrated(
            ["gate_pause", "tickets_tombes"], history, [self.LEG, self.TRACE]))

    def test_deux_decisions_de_suite_couvrent_leurs_deux_motifs(self):
        second = "2026-08-25T16:55:00+00:00"
        history = [{"ts": self.RENDU, "motif": "gate_pause"},
                   {"ts": second, "motif": "tickets_tombes"}]
        events = [self.LEG, self.TRACE, dict(self.TRACE, ts=second)]
        self.assertTrue(arb.already_arbitrated(
            ["gate_pause", "tickets_tombes"], history, events))

    def test_un_horodatage_manquant_ne_bloque_jamais(self):
        """Un NDJSON abîmé doit laisser l'arbitrage possible, pas l'interdire :
        se tromper ici coûte un tour, l'inverse coûte un incident non arbitré."""
        self.assertFalse(arb.already_arbitrated(
            ["gate_pause"], [{"motif": "gate_pause"}], [self.LEG]))

    def should(self, motifs, history, events):
        payload = {"motifs": motifs,
                   "arbitrages": {"total": len(history), "budget_run": 12,
                                  "reste_run": 12 - len(history),
                                  "budget_ticket": 2, "par_ticket": {},
                                  "derniers": []}}
        args = mock.Mock(run=None, reason=[], per_ticket=2, per_run=12)
        output = io.StringIO()
        with mock.patch.object(arb.run_mod, "resolve", return_value="r1"), \
             mock.patch.object(arb, "dossier", return_value=payload), \
             mock.patch.object(arb, "arbitrations", return_value=history), \
             mock.patch.object(arb.run_mod, "read_journal", return_value=events), \
             contextlib.redirect_stdout(output):
            return arb.cmd_should(args), output.getvalue()

    def test_should_refuse_de_rappeler_l_arbitre(self):
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        code, output = self.should(["gate_pause"], history,
                                   [self.LEG, self.TRACE])
        self.assertEqual(code, 1)
        self.assertIn("dossier inchangé", output)
        self.assertIn("gate_pause", output)

    def test_should_rappelle_l_arbitre_des_que_le_journal_bouge(self):
        history = [{"ts": self.RENDU, "motif": "gate_pause"}]
        suite = dict(self.LEG, ts="2026-08-25T17:10:00+00:00")
        code, _ = self.should(["gate_pause"], history,
                              [self.LEG, self.TRACE, suite])
        self.assertEqual(code, 0)


class AppelExterne(unittest.TestCase):
    """Le dossier se constitue de ce qui répond. Ce qui ne répond pas laisse un
    trou, jamais une exception : un dossier partiel reste utile à l'arbitre."""

    def test_un_binaire_absent_ne_leve_rien(self):
        with mock.patch.object(arb.subprocess, "run",
                               side_effect=OSError("gh introuvable")):
            code, stdout, stderr = arb.shell(["gh", "pr", "list"])
        self.assertIsNone(code)
        self.assertIn("gh introuvable", stderr)

    def test_un_delai_depasse_ne_leve_rien(self):
        with mock.patch.object(arb.subprocess, "run",
                               side_effect=arb.subprocess.TimeoutExpired("gh", 1)):
            code, _, stderr = arb.shell(["gh", "pr", "list"])
        self.assertIsNone(code)
        self.assertIn("TimeoutExpired", stderr)

    def test_une_liste_de_pr_illisible_rend_une_liste_vide(self):
        with mock.patch.object(arb, "shell", return_value=(0, "pas du json", "")):
            self.assertEqual(arb.milestone_prs([21]), [])

    def test_une_pr_est_rattachee_a_son_ticket_par_le_closes(self):
        rows = [{"number": 200, "title": "feat", "headRefName": "feature/21-auth",
                 "isDraft": False, "mergeable": "MERGEABLE",
                 "body": "Closes #21", "labels": [], "updatedAt": None,
                 "statusCheckRollup": [{"name": "lint", "conclusion": "SUCCESS"}]}]
        with mock.patch.object(arb, "shell", return_value=(0, json.dumps(rows), "")):
            found = arb.milestone_prs([21, 19])
        self.assertEqual(found[0]["tickets"], [21])
        self.assertEqual(found[0]["checks"], {"total": 1, "verts": 1, "rouges": []})

    def test_une_pr_d_un_autre_jalon_est_ecartee(self):
        rows = [{"number": 200, "headRefName": "feature/99-autre",
                 "body": "Closes #99", "labels": [], "statusCheckRollup": []}]
        with mock.patch.object(arb, "shell", return_value=(0, json.dumps(rows), "")):
            self.assertEqual(arb.milestone_prs([21]), [])


if __name__ == "__main__":
    unittest.main()
