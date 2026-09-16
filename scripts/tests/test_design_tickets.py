#!/usr/bin/env python3
"""Tests du point d'écriture des tickets d'audit design — `scripts/design_tickets.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt

Ce qui est surveillé ici tient en une phrase : **un constat d'audit doit arriver
jusqu'au run de reprise sans se perdre en route, et un goût personnel ne doit
jamais y arriver du tout.**

Quatre régressions redoutées, toutes silencieuses :

  * **Un label qui manque.** `milestone_plan.py` écarte du plan toute issue sans
    `ws:*`, `mod:*` ou `nature:*`. Un ticket ouvert sans eux existe sur GitHub et
    n'est jamais déroulé. `ClassementComplet` fige la liste.
  * **Une référence inventée.** C'est la garde propre à ce dispositif : sans
    elle, l'audit ouvre des tickets d'opinion que personne ne sait clore.
    `Reference` vérifie que le refus tombe **avant** tout appel réseau, et qu'un
    chemin qui n'existe pas dans le dépôt est refusé comme tel.
  * **Une grille qui diverge de sa skill.** Un agent qui invoque un critère que
    le script refuse perd son constat au moment de l'ouvrir. `Grille` compare
    les deux listes, et vérifie qu'aucun critère ne recoupe celle de la QA — les
    deux dispositifs doivent rester distinguables.
  * **Un `P0` sorti d'un audit.** Un audit de conception ne bloque personne ; ce
    qui bloque est un bug, et c'est `/qa` qui l'ouvre. `Impact` fige la borne.

Aucune dépendance : `unittest` de la bibliothèque standard, comme le reste de
`scripts/tests`.
"""
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import qa_bugs  # noqa: E402
import design_tickets as dt  # noqa: E402

RACINE = Path(__file__).resolve().parents[2]

CONSTAT = {
    "titre": "Le tunnel de réservation perd l'étape choisie au rafraîchissement",
    "critere": "ds:parcours", "module": "appointments",
    "workstream": "Frontend", "impact": "fort",
    "url": "/le-spa/reservation",
    "reference": ".claude/skills/web-frontend/SKILL.md §3",
    "attendu": "L'état de l'étape en cours survit à un rafraîchissement.",
    "constate": "Le rafraîchissement ramène à l'étape 1, saisies perdues.",
    "recommandation": "Porter l'étape et le créneau retenu dans l'URL.",
    "preuve": "F5 à l'étape « créneau » ; retour à « service »",
}


def argv_open(**surcharges):
    """Les arguments d'un `open` valide, que chaque test gauchit à sa guise."""
    champs = {**CONSTAT, **surcharges}
    argv = ["open"]
    for cle in ("titre", "critere", "module", "workstream", "impact", "url",
                "reference", "attendu", "constate", "recommandation", "preuve"):
        if champs.get(cle) is not None:
            argv += [f"--{cle}", champs[cle]]
    for cle in ("cle", "campagne"):
        if champs.get(cle):
            argv += [f"--{cle}", champs[cle]]
    for portee in champs.get("portees", ()):
        argv += ["--portee", portee]
    if champs.get("sans_capture"):
        argv += ["--sans-capture", champs["sans_capture"]]
    for capture in champs.get("captures", ()):
        argv += ["--capture", capture]
    if champs.get("dry_run"):
        argv += ["--dry-run"]
    return argv


class Hub:
    """Double des appels sortants — `gh`, `gh_json`, `git` et `run`.

    Il enregistre tout ce qui a été tenté : c'est ce qui permet d'affirmer qu'un
    refus est tombé **avant** le premier appel réseau, et non après.
    """

    def __init__(self, issues=(), qa_issues=(), jalons=(("Design & UX", 12),),
                 labels=("type:design",)):
        self.issues = list(issues)
        self.qa_issues = list(qa_issues)
        self.jalons = [{"number": n, "title": t, "state": "open"}
                       for t, n in jalons]
        self.labels = list(labels)
        self.appels = []
        self.creees = []
        self.commentaires = []
        self.labels_crees = []

    def gh(self, args, **kw):
        self.appels.append(("gh", list(args)))
        if args[:2] == ["issue", "create"]:
            self.creees.append(list(args))
            return "https://github.com/TMap-Works/spa-booking/issues/800\n"
        if args[:2] == ["issue", "comment"]:
            self.commentaires.append(list(args))
            return ""
        if args[:2] == ["label", "create"]:
            self.labels_crees.append(list(args))
            self.labels.append(args[2])
            return ""
        return ""

    def gh_json(self, args, **kw):
        self.appels.append(("gh_json", list(args)))
        if args[:1] == ["api"] and "milestones" in args[1]:
            if "--method" in args:
                cree = {"number": 77, "title": dt.JALON}
                self.jalons.append({**cree, "state": "open"})
                return cree
            return self.jalons
        if args[:2] == ["label", "list"]:
            return [{"name": n} for n in self.labels]
        if args[:2] == ["issue", "list"]:
            jalon = args[args.index("--milestone") + 1]
            return self.qa_issues if jalon == qa_bugs.JALON else self.issues
        return None

    def git(self, args, **kw):
        self.appels.append(("git", list(args)))
        return {"hash-object": "b10b" * 10, "write-tree": "77ee" * 10,
                "commit-tree": "c0m1" * 10, "rev-parse": "9a9e" * 10}.get(
                    args[0], "") + "\n"

    def run(self, args, **kw):
        self.appels.append(("run", list(args)))
        return mock.Mock(returncode=1, stdout="", stderr="")

    @property
    def reseau(self):
        """Les appels qui touchent GitHub — ceux qu'un refus doit précéder."""
        return [a for a in self.appels if a[0] in ("gh", "gh_json")]


def lancer(argv, hub):
    """Exécute `main()` avec les appels sortants doublés, rend (code, sortie)."""
    sortie, erreur = io.StringIO(), io.StringIO()
    with mock.patch.object(qa_bugs, "gh", hub.gh), \
            mock.patch.object(qa_bugs, "gh_json", hub.gh_json), \
            mock.patch.object(qa_bugs, "git", hub.git), \
            mock.patch.object(qa_bugs, "run", hub.run):
        with redirect_stdout(sortie), redirect_stderr(erreur):
            code = dt.main(argv)
    return code, sortie.getvalue(), erreur.getvalue()


def issue_avec_empreinte(numero, marque, etat="open", titre="Un écart",
                         url_ecran="/le-spa/reservation", labels=("P2",)):
    return {
        "number": numero, "title": titre, "state": etat,
        "url": f"https://github.com/TMap-Works/spa-booking/issues/{numero}",
        "labels": [{"name": n} for n in labels],
        "body": (f"Audit `d20260916-1` · relevé le 16/09/2026 · "
                 f"écran `{url_ecran}`\n\n"
                 f"{qa_bugs.MARQUE_EMPREINTE}{marque} -->"),
    }


class Grille(unittest.TestCase):
    """La grille est un contrat partagé avec la skill — et distincte de la QA."""

    def test_chaque_critere_est_prefixe_ds(self):
        for critere in dt.CRITERES:
            with self.subTest(critere=critere):
                self.assertRegex(critere, r"^ds:[a-z0-9]+$")

    def test_aucun_critere_ne_recoupe_la_grille_de_qa(self):
        # Les deux dispositifs doivent rester distinguables : un critère commun
        # ferait ouvrir le même symptôme des deux côtés, dans deux jalons.
        self.assertEqual(set(dt.CRITERES) & set(qa_bugs.CRITERES), set())

    def test_la_skill_documente_exactement_la_grille(self):
        skill = RACINE / ".claude" / "skills" / "design-audit" / "SKILL.md"
        if not skill.is_file():                     # pragma: no cover
            self.skipTest("la skill design-audit n'est pas dans ce worktree")
        texte = skill.read_text(encoding="utf-8")
        for critere in dt.CRITERES:
            with self.subTest(critere=critere):
                self.assertIn(f"`{critere}`", texte)

    def test_la_grille_s_affiche_sans_reseau(self):
        # Un agent doit pouvoir lire la grille appliquée sans rien appeler.
        hub = Hub()
        code, sortie, _ = lancer(["grille", "--json"], hub)
        self.assertEqual(code, 0)
        self.assertEqual(hub.reseau, [])
        self.assertEqual(set(json.loads(sortie)["criteres"]), set(dt.CRITERES))


class Reference(unittest.TestCase):
    """La garde propre à l'audit : un constat s'appuie sur un document écrit."""

    def test_les_formes_recevables_passent(self):
        for reference in ("CDC §1.4",
                          "cahier des charges, CDC §2.3",
                          "ADR 0006 — fuseaux horaires du tenant",
                          "WCAG 2.2 AA, critère 1.4.3",
                          "apps/web/styles/tokens.css",
                          ".claude/skills/web-frontend/SKILL.md §6",
                          "docs/design/appointments/states.md"):
            with self.subTest(reference=reference):
                self.assertEqual(dt.valider_reference(reference), reference)

    def test_un_chemin_qui_n_existe_pas_est_refuse(self):
        # La forme la plus commode est aussi la plus facile à inventer.
        with self.assertRaises(dt.DesignError) as refus:
            dt.valider_reference("apps/web/styles/design-system.css")
        self.assertEqual(refus.exception.code, dt.USAGE)
        self.assertIn("aucun trouvé", str(refus.exception))

    def test_une_opinion_est_refusee(self):
        for reference in ("", "   ", "je trouve que ce serait plus joli",
                          "les bonnes pratiques du web"):
            with self.subTest(reference=reference):
                with self.assertRaises(dt.DesignError):
                    dt.valider_reference(reference)

    def test_le_refus_tombe_avant_le_reseau(self):
        hub = Hub()
        code, _, erreur = lancer(argv_open(reference="parce que c'est mieux",
                                           sans_capture="essai"), hub)
        self.assertEqual(code, dt.USAGE)
        self.assertEqual(hub.reseau, [])
        self.assertIn("référence irrecevable", erreur)

    def test_la_reference_est_ecrite_dans_le_corps(self):
        hub = Hub()
        code, sortie, _ = lancer(argv_open(sans_capture="essai", dry_run=True),
                                 hub)
        self.assertEqual(code, 0)
        corps = json.loads(sortie)["corps"]
        self.assertIn("## La référence", corps)
        self.assertIn(CONSTAT["reference"], corps)


class ClassementComplet(unittest.TestCase):
    """Les labels sans lesquels le run de reprise ne verrait pas le ticket."""

    def test_les_cinq_labels_sont_toujours_la(self):
        self.assertEqual(dt.labels_for("moyen", "catalog", "Frontend"),
                         ["type:design", "nature:projet", "ws:frontend",
                          "mod:catalog", "P2"])

    def test_le_workstream_par_defaut_est_frontend(self):
        # La correction d'un écart de conception vit dans `apps/web` : c'est
        # `ws:frontend` qui donne au plan la bonne empreinte de fichiers.
        # `ws:design` retomberait sur `design/<module>`, une ressource qui ne
        # heurte aucun ticket frontend — deux agents écriraient les mêmes
        # fichiers dans la même vague.
        hub = Hub()
        code, sortie, _ = lancer(argv_open(workstream=None,
                                           sans_capture="essai", dry_run=True),
                                 hub)
        self.assertEqual(code, 0)
        self.assertIn("ws:frontend", json.loads(sortie)["labels"])

    def test_le_label_type_design_est_cree_s_il_manque(self):
        # Sans lui, `gh issue create` échoue et l'audit s'arrête sur son
        # premier ticket.
        hub = Hub(labels=[])
        code, _, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, 0)
        self.assertEqual(len(hub.labels_crees), 1)
        self.assertEqual(hub.labels_crees[0][2], "type:design")

    def test_un_label_deja_present_n_est_pas_recree(self):
        hub = Hub(labels=["type:design"])
        lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(hub.labels_crees, [])


class Impact(unittest.TestCase):
    """Un audit de conception ne rend pas de `P0`."""

    def test_l_impact_fixe_la_priorite(self):
        for impact, attendue in (("fort", "P1"), ("moyen", "P2"),
                                 ("faible", "P2")):
            with self.subTest(impact=impact):
                self.assertIn(attendue,
                              dt.labels_for(impact, "catalog", "Frontend"))

    def test_aucun_impact_ne_vaut_p0(self):
        # `P0` veut dire « empêche d'accomplir la tâche ». Ce qui empêche est un
        # bug : c'est `/qa` qui l'ouvre, dans son propre jalon.
        self.assertNotIn("P0", {p for p, _ in dt.IMPACTS.values()})

    def test_un_impact_hors_echelle_est_refuse(self):
        hub = Hub()
        with self.assertRaises(SystemExit):
            lancer(argv_open(impact="bloquant", sans_capture="essai"), hub)
        self.assertEqual(hub.reseau, [])


class ChampsObligatoires(unittest.TestCase):
    """Ce qu'un ticket d'amélioration doit porter pour être corrigible."""

    def test_la_recommandation_est_exigee(self):
        # Un ticket qui dit ce qui ne va pas sans dire vers quoi aller renvoie
        # la conception à l'agent de correction.
        hub = Hub()
        with self.assertRaises(SystemExit):
            lancer(argv_open(recommandation=None, sans_capture="essai"), hub)
        self.assertEqual(hub.reseau, [])

    def test_la_reference_est_exigee(self):
        hub = Hub()
        with self.assertRaises(SystemExit):
            lancer(argv_open(reference=None, sans_capture="essai"), hub)
        self.assertEqual(hub.reseau, [])

    def test_sans_capture_ni_raison_le_ticket_n_est_pas_ouvert(self):
        hub = Hub()
        code, _, erreur = lancer(argv_open(), hub)
        self.assertEqual(code, dt.USAGE)
        self.assertEqual(hub.reseau, [])
        self.assertIn("aucune capture", erreur)

    def test_la_raison_de_l_absence_est_ecrite_dans_le_corps(self):
        hub = Hub()
        _, sortie, _ = lancer(argv_open(sans_capture="l'écart est structurel",
                                        dry_run=True), hub)
        self.assertIn("l'écart est structurel", json.loads(sortie)["corps"])

    def test_la_portee_liste_les_autres_ecrans(self):
        hub = Hub()
        _, sortie, _ = lancer(argv_open(sans_capture="essai", dry_run=True,
                                        portees=["/le-spa/admin/clients",
                                                 "/le-spa/admin/personnel"]),
                              hub)
        corps = json.loads(sortie)["corps"]
        self.assertIn("## Portée", corps)
        self.assertIn("`/le-spa/admin/clients`", corps)


class Captures(unittest.TestCase):
    """Les images de l'audit ne se mélangent pas à celles de la QA."""

    def test_elles_vont_dans_le_dossier_design(self):
        chemin = qa_bugs.chemin_capture("d20260916-1", "abc123", 1,
                                        "page.png", dt.FAMILLE)
        self.assertEqual(chemin, "docs/design/captures/d20260916-1/abc123-1.png")

    def test_la_qa_garde_le_sien(self):
        # Le défaut de `famille` est `qa` : la campagne de QA ne bouge pas.
        self.assertTrue(qa_bugs.chemin_capture("20260916-1", "abc123", 1,
                                               "page.png").startswith("docs/qa/"))

    def test_l_identifiant_d_audit_se_distingue_de_celui_d_une_campagne(self):
        # Même jour, deux dispositifs : un `report --campagne` ne doit pas
        # ramasser les tickets de l'autre.
        self.assertTrue(dt.campagne_du_jour().startswith("d"))
        self.assertNotEqual(dt.campagne_du_jour(), qa_bugs.campagne_du_jour())


class Deduplication(unittest.TestCase):
    """Un audit se rejoue ; le même écart ne doit pas ouvrir deux tickets."""

    def test_une_empreinte_ouverte_est_commentee_pas_doublee(self):
        marque = qa_bugs.empreinte(CONSTAT["critere"], CONSTAT["module"],
                                   CONSTAT["url"])
        hub = Hub(issues=[issue_avec_empreinte(801, marque)])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, 0)
        self.assertEqual(hub.creees, [])
        self.assertEqual(len(hub.commentaires), 1)
        self.assertTrue(json.loads(sortie)["doublon"])

    def test_une_empreinte_fermee_rouvre_en_citant_l_ancien(self):
        marque = qa_bugs.empreinte(CONSTAT["critere"], CONSTAT["module"],
                                   CONSTAT["url"])
        hub = Hub(issues=[issue_avec_empreinte(802, marque, etat="closed")])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, 0)
        self.assertEqual(len(hub.creees), 1)
        self.assertEqual(json.loads(sortie)["revu_de"], 802)

    def test_la_deduplication_ne_regarde_que_le_jalon_de_l_audit(self):
        # Un bug de QA qui porterait la même empreinte ne doit pas empêcher
        # l'audit d'ouvrir : les deux jalons sont indépendants.
        marque = qa_bugs.empreinte(CONSTAT["critere"], CONSTAT["module"],
                                   CONSTAT["url"])
        hub = Hub(issues=[], qa_issues=[issue_avec_empreinte(803, marque)])
        code, _, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, 0)
        self.assertEqual(len(hub.creees), 1)


class Jalon(unittest.TestCase):
    """« Design & UX » est créé sans échéance, et jamais confondu avec la QA."""

    def test_un_jalon_absent_est_cree_sans_echeance(self):
        hub = Hub(jalons=[("Bug & correction", 9)])
        code, _, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, 0)
        creation = next(a for t, a in hub.appels
                        if t == "gh_json" and "--method" in a)
        self.assertIn(f"title={dt.JALON}", creation)
        self.assertFalse(any(arg.startswith("due_on") for arg in creation))

    def test_le_ticket_part_dans_le_jalon_de_l_audit(self):
        hub = Hub()
        lancer(argv_open(sans_capture="essai"), hub)
        creation = hub.creees[0]
        self.assertEqual(creation[creation.index("--milestone") + 1], dt.JALON)

    def test_le_jalon_de_la_qa_n_est_pas_touche(self):
        hub = Hub(jalons=[("Bug & correction", 9), ("Design & UX", 12)])
        lancer(argv_open(sans_capture="essai"), hub)
        for genre, args in hub.appels:
            if genre == "gh_json" and "--method" in args:
                self.fail("un jalon a été créé alors que les deux existaient")


class Voisins(unittest.TestCase):
    """La garde qui empêche les deux dispositifs de se doubler."""

    def test_les_deux_jalons_sont_interroges(self):
        hub = Hub(
            issues=[issue_avec_empreinte(810, "aaa", url_ecran="/le-spa/reservation")],
            qa_issues=[issue_avec_empreinte(811, "bbb", url_ecran="/le-spa/reservation",
                                            titre="Débordement à 360 px")])
        code, sortie, _ = lancer(["voisins", "--url", "/le-spa/reservation",
                                  "--json"], hub)
        self.assertEqual(code, 0)
        trouves = json.loads(sortie)
        self.assertEqual({t["issue"] for t in trouves}, {810, 811})
        self.assertEqual({t["jalon"] for t in trouves},
                         {dt.JALON, qa_bugs.JALON})

    def test_un_autre_ecran_n_est_pas_ramasse(self):
        hub = Hub(issues=[issue_avec_empreinte(812, "ccc",
                                               url_ecran="/le-spa/admin/clients")])
        _, sortie, _ = lancer(["voisins", "--url", "/le-spa/reservation",
                               "--json"], hub)
        self.assertEqual(json.loads(sortie), [])


class UrlDeGitBash(unittest.TestCase):
    """Sous Windows, MSYS convertit `/reservation` en chemin d'installation."""

    def test_le_prefixe_msys_est_retire(self):
        with mock.patch.dict(os.environ, {"MSYSTEM": "MINGW64",
                                          "EXEPATH": r"C:\Program Files\Git\bin"}):
            self.assertEqual(
                qa_bugs.nettoyer_url("C:/Program Files/Git/le-spa/reservation"),
                "/le-spa/reservation")

    def test_une_url_normale_n_est_pas_touchee(self):
        with mock.patch.dict(os.environ, {"MSYSTEM": "MINGW64",
                                          "EXEPATH": r"C:\Program Files\Git\bin"}):
            self.assertEqual(qa_bugs.nettoyer_url("/le-spa/reservation"),
                             "/le-spa/reservation")

    def test_l_empreinte_est_la_meme_des_deux_cotes(self):
        # C'est la vraie conséquence : sans ce rattrapage, un même écart relevé
        # depuis Git Bash et depuis PowerShell ouvre deux tickets.
        with mock.patch.dict(os.environ, {"MSYSTEM": "MINGW64",
                                          "EXEPATH": r"C:\Program Files\Git\bin"}):
            converti = qa_bugs.empreinte(
                "ds:parcours", "appointments",
                "C:/Program Files/Git/le-spa/reservation")
        self.assertEqual(converti, qa_bugs.empreinte("ds:parcours",
                                                     "appointments",
                                                     "/le-spa/reservation"))


class Rapport(unittest.TestCase):
    """Le tableau de fin d'audit ne mélange pas les campagnes."""

    def test_il_ne_retient_que_l_audit_demande(self):
        hub = Hub(issues=[
            issue_avec_empreinte(820, "ddd", labels=("P1",)),
            {**issue_avec_empreinte(821, "eee"),
             "body": "Audit `d20260901-1` · écran `/x`"},
        ])
        code, sortie, _ = lancer(["report", "--campagne", "d20260916-1"], hub)
        self.assertEqual(code, 0)
        self.assertIn("#820", sortie)
        self.assertNotIn("#821", sortie)

    def test_il_renvoie_vers_le_run_de_reprise(self):
        hub = Hub(issues=[issue_avec_empreinte(822, "fff")])
        _, sortie, _ = lancer(["report"], hub)
        self.assertIn(f'/milestone "{dt.JALON}"', sortie)


if __name__ == "__main__":
    unittest.main()
