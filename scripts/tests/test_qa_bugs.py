#!/usr/bin/env python3
"""Tests du point d'écriture des tickets de QA — `scripts/qa_bugs.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce qui est surveillé ici tient en une phrase : **un constat de campagne doit
arriver jusqu'au run de correction sans se perdre en route** — ni par un
classement incomplet, ni par un doublon, ni par une preuve évaporée.

Les trois régressions redoutées sont silencieuses, comme souvent dans ce dépôt :

  * **Un label qui manque.** `milestone_plan.py` écarte du plan toute issue sans
    `ws:*`, `mod:*` ou `nature:*`. Un ticket ouvert sans eux existe sur GitHub,
    s'affiche dans le jalon, et n'est **jamais déroulé** — personne ne voit rien.
    `ClassementComplet` fige la liste des labels posés.
  * **Un doublon.** Une campagne se rejoue ; sans empreinte stable, le même
    défaut rouvre un ticket à chaque passage et le jalon devient illisible.
    `Empreinte` et `Deduplication` fixent ce qui fait l'identité d'un défaut —
    et surtout ce qui n'en fait **pas** partie : le titre, que l'agent
    reformule, et la chaîne de requête, qui change à chaque jeu d'essai.
  * **Une preuve absente.** Un ticket « l'espacement est faux » sans image n'est
    pas corrigible six jours plus tard. `PreuveVisuelle` vérifie que le refus
    tombe **avant** tout appel à `gh` — un ticket à moitié créé puis complété
    laisse une notification fausse et une carte de Project au mauvais endroit.

Un quatrième point, moins évident : `Jalon` vérifie que « Bug & correction » est
créé **sans échéance**. `current_milestone()` de `tracking.py` retient le premier
jalon ouvert dont l'échéance n'est pas passée ; une date ici détournerait tous
les `/ticket-new` suivants hors du sprint en cours, sans erreur ni message.

Aucune dépendance : `unittest` de la bibliothèque standard, comme le reste de
`scripts/tests`. Le dépôt n'a pas de gestion de paquets Python.
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import qa_bugs  # noqa: E402 — l'insertion de chemin ci-dessus doit la précéder


CONSTAT = {
    "titre": "Le calendrier déborde de la fenêtre à 360 px",
    "critere": "fe:responsive", "module": "appointments",
    "workstream": "Frontend", "gravite": "majeur",
    "url": "/reserver/creneaux", "attendu": "La grille tient dans la fenêtre.",
    "constate": "La colonne du samedi est coupée.", "preuve": "browser_resize 360x800",
}


def argv_open(**surcharges):
    """Les arguments d'un `open` valide, que chaque test gauchit à sa guise."""
    champs = {**CONSTAT, **surcharges}
    argv = ["open"]
    for cle in ("titre", "critere", "module", "workstream", "gravite", "url",
                "attendu", "constate", "preuve"):
        if champs.get(cle) is not None:
            argv += [f"--{cle}", champs[cle]]
    for cle in ("mesure", "reproduire", "cle", "campagne"):
        if champs.get(cle):
            argv += [f"--{cle}", champs[cle]]
    if champs.get("sans_capture"):
        argv += ["--sans-capture", champs["sans_capture"]]
    for capture in champs.get("captures", ()):
        argv += ["--capture", capture]
    if champs.get("dry_run"):
        argv += ["--dry-run"]
    return argv


class Hub:
    """Double des appels sortants — `gh`, `gh_json` et `git`.

    Il enregistre tout ce qui a été tenté : c'est ce qui permet d'affirmer
    qu'un refus est tombé **avant** le premier appel réseau, et non après.
    """

    def __init__(self, issues=(), jalons=(("Bug & correction", 9),)):
        self.issues = list(issues)
        self.jalons = [{"number": n, "title": t, "state": "open"}
                       for t, n in jalons]
        self.appels = []
        self.creees = []
        self.commentaires = []

    def gh(self, args, **kw):
        self.appels.append(("gh", list(args)))
        if args[:2] == ["issue", "create"]:
            self.creees.append(list(args))
            return "https://github.com/TMap-Works/spa-booking/issues/700\n"
        if args[:2] == ["issue", "comment"]:
            self.commentaires.append(list(args))
            return ""
        return ""

    def gh_json(self, args, **kw):
        self.appels.append(("gh_json", list(args)))
        if args[:1] == ["api"] and "milestones" in args[1]:
            if "--method" in args:
                cree = {"number": 42, "title": qa_bugs.JALON}
                self.jalons.append({**cree, "state": "open"})
                return cree
            return self.jalons
        if args[:2] == ["issue", "list"]:
            return self.issues
        return None

    def git(self, args, **kw):
        self.appels.append(("git", list(args)))
        if args[0] == "hash-object":
            return "b10b" * 10 + "\n"
        if args[0] == "write-tree":
            return "77ee" * 10 + "\n"
        if args[0] == "commit-tree":
            return "c0m1" * 10 + "\n"
        if args[0] == "rev-parse":
            return "9a9e" * 10 + "\n"
        return ""

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
            code = qa_bugs.main(argv)
    return code, sortie.getvalue(), erreur.getvalue()


class Empreinte(unittest.TestCase):
    """Ce qui fait l'identité d'un défaut — et ce qui n'en fait pas partie."""

    def test_le_titre_ne_compte_pas(self):
        # Un agent reformule son titre à chaque campagne. Si l'empreinte en
        # dépendait, le même bug rouvrirait un ticket à chaque passage.
        a = qa_bugs.empreinte("fe:responsive", "appointments", "/reserver")
        self.assertEqual(a, qa_bugs.empreinte("fe:responsive", "appointments",
                                              "/reserver"))

    def test_le_critere_et_le_lieu_comptent(self):
        base = qa_bugs.empreinte("fe:responsive", "appointments", "/reserver")
        self.assertNotEqual(base, qa_bugs.empreinte("fe:espacement",
                                                    "appointments", "/reserver"))
        self.assertNotEqual(base, qa_bugs.empreinte("fe:responsive",
                                                    "appointments", "/comptoir"))
        self.assertNotEqual(base, qa_bugs.empreinte("fe:responsive",
                                                    "catalog", "/reserver"))

    def test_la_cle_discrimine_deux_defauts_au_meme_endroit(self):
        # Sans elle, le second défaut du même critère sur la même page serait
        # pris pour le premier — et perdu.
        sans = qa_bugs.empreinte("fe:ux", "crm", "/clients")
        avec = qa_bugs.empreinte("fe:ux", "crm", "/clients", cle="bouton-export")
        self.assertNotEqual(sans, avec)

    def test_l_url_est_normalisee(self):
        # Le jeu d'essai rend un identifiant neuf à chaque exécution : sans
        # normalisation, chaque campagne inventerait une empreinte.
        reference = qa_bugs.empreinte("be:latence", "crm", "/api/v1/clients/:id")
        for variante in ("/api/v1/clients/42",
                         "/api/v1/clients/42/",
                         "/api/v1/clients/42?inclure=notes",
                         "/API/v1/clients/7#haut",
                         "/api/v1/clients/3f2504e0-4f89-11d3-9a0c-0305e82c3301"):
            with self.subTest(variante=variante):
                self.assertEqual(reference,
                                 qa_bugs.empreinte("be:latence", "crm", variante))

    def test_elle_se_relit_dans_le_corps(self):
        marque = qa_bugs.empreinte("fe:design", "catalog", "/services")
        constat = {**CONSTAT, "critere": "fe:design", "empreinte": marque,
                   "campagne": "20260910-1", "date": "10/09/2026",
                   "mesure": "", "reproduire": "", "sans_capture": ""}
        self.assertEqual(marque,
                         qa_bugs.extraire_empreinte(qa_bugs.corps(constat, [("u", "l")])))

    def test_un_corps_sans_marque_ne_rend_rien(self):
        self.assertIsNone(qa_bugs.extraire_empreinte("un ticket écrit à la main"))
        self.assertIsNone(qa_bugs.extraire_empreinte(None))


class ClassementComplet(unittest.TestCase):
    """Les labels sans lesquels le run de correction ne verrait pas le ticket."""

    def test_les_cinq_labels_sont_toujours_la(self):
        labels = qa_bugs.labels_for("majeur", "payments", "Backend")
        self.assertEqual(labels, ["type:bug", "nature:projet", "ws:backend",
                                  "mod:payments", "P1"])

    def test_la_gravite_fixe_la_priorite(self):
        for gravite, attendue in (("bloquant", "P0"), ("majeur", "P1"),
                                  ("mineur", "P2")):
            with self.subTest(gravite=gravite):
                self.assertIn(attendue,
                              qa_bugs.labels_for(gravite, "crm", "Frontend"))

    def test_nature_projet_sans_exception(self):
        # Un bug du produit se corrige dans un run de jalon. `nature:outillage`
        # le ferait attendre une session humaine dédiée — ce n'est pas ce qu'on
        # veut d'une campagne qui en ouvre trente.
        for workstream in qa_bugs.WORKSTREAMS:
            with self.subTest(workstream=workstream):
                self.assertIn("nature:projet",
                              qa_bugs.labels_for("mineur", "infra", workstream))

    def test_un_critere_fautif_est_refuse_avant_tout_appel(self):
        # `--critere` est le seul des quatre à rester libre en ligne de
        # commande : la grille compte quatorze entrées, et le message d'erreur
        # d'argparse les rendrait illisibles. Le refus se fait donc dans
        # `valider()` — et il doit tomber avant le premier appel réseau.
        hub = Hub()
        code, _, erreur = lancer(
            argv_open(sans_capture="essai", critere="fe:jolitude"), hub)
        self.assertEqual(code, qa_bugs.USAGE)
        self.assertEqual(hub.reseau, [],
                         "le refus doit précéder le premier appel à gh")
        self.assertIn("critère inconnu", erreur)

    def test_argparse_refuse_lui_meme_les_enumerations(self):
        # `--module`, `--workstream` et `--gravite` sont des `choices` :
        # argparse sort en 2 sans que `valider()` ait à se prononcer.
        for argv in (argv_open(module="stock", sans_capture="e"),
                     argv_open(workstream="Marketing", sans_capture="e"),
                     argv_open(gravite="embetant", sans_capture="e")):
            with self.subTest(argv=argv[:6]):
                with self.assertRaises(SystemExit) as sortie:
                    with redirect_stderr(io.StringIO()):
                        qa_bugs.main(argv)
                self.assertEqual(sortie.exception.code, 2)

    def test_valider_reste_le_garde_fou_des_appels_programmatiques(self):
        # Un appelant qui contourne argparse — un autre script, un test —
        # doit se heurter au même refus.
        for kwargs, attendu in (
                ({"critere": "fe:jolitude"}, "critère inconnu"),
                ({"module": "stock"}, "module inconnu"),
                ({"workstream": "Marketing"}, "workstream inconnu"),
                ({"gravite": "embetant"}, "gravité inconnue")):
            with self.subTest(**kwargs):
                appel = {"critere": "fe:ux", "module": "crm",
                         "workstream": "Frontend", "gravite": "mineur", **kwargs}
                with self.assertRaises(qa_bugs.QaError) as leve:
                    qa_bugs.valider(appel["critere"], appel["module"],
                                    appel["workstream"], appel["gravite"])
                self.assertIn(attendu, str(leve.exception))
                self.assertEqual(leve.exception.code, qa_bugs.USAGE)


class PreuveVisuelle(unittest.TestCase):
    """« Pour chaque test, une capture » — et le refus quand il n'y en a pas."""

    def test_sans_capture_ni_raison_le_ticket_n_est_pas_ouvert(self):
        hub = Hub()
        code, _, erreur = lancer(argv_open(), hub)
        self.assertEqual(code, qa_bugs.USAGE)
        self.assertEqual(hub.reseau, [])
        self.assertIn("--capture", erreur)
        self.assertIn("--sans-capture", erreur)

    def test_la_raison_de_l_absence_est_ecrite_dans_le_corps(self):
        # Un `--sans-capture` qui ne laisserait pas de trace serait une
        # dérogation invisible : le relecteur doit voir qu'on a choisi de s'en
        # passer, et pourquoi.
        hub = Hub()
        code, sortie, _ = lancer(
            argv_open(dry_run=True, sans_capture="constat de latence pure, "
                                                 "aucune page ne l'expose"), hub)
        self.assertEqual(code, qa_bugs.OK)
        corps = json.loads(sortie)["corps"]
        self.assertIn("## Preuve visuelle", corps)
        self.assertIn("Aucune capture — constat de latence pure", corps)

    def capture_reelle(self, nom="360.png"):
        """Une capture qui existe pour de bon — l'essai à blanc les vérifie."""
        bac = tempfile.TemporaryDirectory()
        self.addCleanup(bac.cleanup)
        chemin = Path(bac.name) / nom
        chemin.write_bytes(b"\x89PNG\r\n\x1a\n")
        return chemin

    def test_une_capture_rend_une_image_markdown(self):
        hub = Hub()
        capture = self.capture_reelle()
        code, sortie, _ = lancer(
            argv_open(dry_run=True, campagne="20260910-1",
                      captures=[f"{capture}:La colonne du samedi coupée"]), hub)
        self.assertEqual(code, qa_bugs.OK)
        corps = json.loads(sortie)["corps"]
        self.assertIn("![La colonne du samedi coupée](https://raw.githubusercontent.com/",
                      corps)
        self.assertIn("/qa-captures/docs/qa/captures/20260910-1/", corps)

    def test_l_essai_a_blanc_montre_l_url_finale(self):
        # Un essai à blanc qui rendrait un chemin local ne dirait rien de ce que
        # le relecteur verra — or c'est exactement ce qu'on vient vérifier.
        hub = Hub()
        capture = self.capture_reelle()
        _, sortie, _ = lancer(
            argv_open(dry_run=True, campagne="20260910-1",
                      captures=[f"{capture}:légende"]), hub)
        marque = json.loads(sortie)["empreinte"]
        self.assertIn(f"{marque}-1.png", json.loads(sortie)["corps"])

    def test_l_essai_a_blanc_exerce_les_memes_gardes_que_l_appel_reel(self):
        # Un essai à blanc qui accepterait un chemin fautif rendrait un ticket
        # parfait, et l'appel réel échouerait derrière lui sur chaque constat.
        hub = Hub()
        code, _, erreur = lancer(
            argv_open(dry_run=True, captures=["nulle-part/absente.png:légende"]),
            hub)
        self.assertEqual(code, qa_bugs.FAIL)
        self.assertIn("introuvable", erreur)

    def test_un_chemin_relatif_est_resolu_avant_git(self):
        # `Path.is_file()` part du répertoire courant, `git -C ROOT` de la
        # racine du dépôt : sans résolution, la garde passerait ici pour échouer
        # plus bas, sur un message de plomberie git illisible.
        capture = self.capture_reelle()
        [(resolu, _)] = qa_bugs.verifier_captures([(Path(capture), "")])
        self.assertTrue(resolu.is_absolute())

    def test_le_nom_du_fichier_vient_de_l_empreinte_pas_du_titre(self):
        # Sinon, le même défaut accumulerait une capture par reformulation.
        chemin = qa_bugs.chemin_capture("20260910-1", "abc123", 2, "x.PNG")
        self.assertEqual(chemin, "docs/qa/captures/20260910-1/abc123-2.png")

    def test_une_capture_illisible_est_refusee(self):
        with self.assertRaises(qa_bugs.QaError) as leve:
            qa_bugs.parse_capture("une capture, quelque part")
        self.assertEqual(leve.exception.code, qa_bugs.USAGE)

    def test_un_chemin_windows_n_est_pas_pris_pour_une_legende(self):
        chemin, legende = qa_bugs.parse_capture("D:/captures/vue.png:ce qu'il faut voir")
        self.assertEqual(Path(chemin).name, "vue.png")
        self.assertEqual(legende, "ce qu'il faut voir")
        chemin, legende = qa_bugs.parse_capture("D:/captures/vue.png")
        self.assertEqual(Path(chemin).name, "vue.png")
        self.assertEqual(legende, "")

    def test_une_capture_absente_ou_trop_lourde_est_refusee(self):
        with self.assertRaises(qa_bugs.QaError) as leve:
            qa_bugs.pousser_captures([(Path("nulle-part.png"), "")], "c", "abc")
        self.assertIn("introuvable", str(leve.exception))

        with tempfile.TemporaryDirectory() as bac:
            gros = Path(bac) / "gros.png"
            gros.write_bytes(b"\0" * (qa_bugs.TAILLE_MAX_CAPTURE + 1))
            with self.assertRaises(qa_bugs.QaError) as leve:
                qa_bugs.pousser_captures([(gros, "")], "c", "abc")
            self.assertIn("trop lourde", str(leve.exception))


class Deduplication(unittest.TestCase):
    """Une campagne se rejoue — le jalon ne doit pas doubler pour autant."""

    def issue(self, numero, etat, marque):
        return {"number": numero, "state": etat, "title": "déjà vu",
                "url": f"https://github.com/x/y/issues/{numero}",
                "body": f"corps\n\n{qa_bugs.MARQUE_EMPREINTE}{marque} -->",
                "labels": [{"name": "P1"}]}

    def test_une_empreinte_ouverte_fait_commenter_et_non_creer(self):
        marque = qa_bugs.empreinte(CONSTAT["critere"], CONSTAT["module"],
                                   CONSTAT["url"])
        hub = Hub(issues=[self.issue(300, "OPEN", marque)])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, qa_bugs.OK)
        self.assertEqual(hub.creees, [], "aucun ticket ne doit être créé")
        self.assertEqual(len(hub.commentaires), 1)
        self.assertEqual(json.loads(sortie)["issue"], 300)
        self.assertTrue(json.loads(sortie)["doublon"])

    def test_une_empreinte_fermee_ouvre_un_ticket_de_regression(self):
        # Le défaut avait été corrigé : c'est une régression, et le nouveau
        # ticket doit dire où regarder d'abord.
        marque = qa_bugs.empreinte(CONSTAT["critere"], CONSTAT["module"],
                                   CONSTAT["url"])
        hub = Hub(issues=[self.issue(300, "CLOSED", marque)])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, qa_bugs.OK)
        self.assertEqual(len(hub.creees), 1)
        self.assertEqual(json.loads(sortie)["regression_de"], 300)
        self.assertIn("--milestone", hub.creees[0])

    def test_la_section_regression_cite_le_ticket_ferme(self):
        constat = {**CONSTAT, "empreinte": "abc123", "campagne": "20260910-1",
                   "date": "10/09/2026", "mesure": "", "reproduire": "",
                   "sans_capture": "essai"}
        corps = qa_bugs.corps(constat, [], doublon_ferme=300)
        self.assertIn("## Régression", corps)
        self.assertIn("#300", corps)

    def test_le_ticket_ouvert_l_emporte_sur_le_ferme_de_meme_empreinte(self):
        # Une fois la régression ouverte, deux issues portent la même marque :
        # l'ancienne corrigée et la nouvelle. Prendre la première venue ferait
        # ouvrir une régression de la régression à chaque campagne.
        marque = qa_bugs.empreinte(CONSTAT["critere"], CONSTAT["module"],
                                   CONSTAT["url"])
        hub = Hub(issues=[self.issue(300, "CLOSED", marque),
                          self.issue(700, "OPEN", marque)])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, qa_bugs.OK)
        self.assertEqual(hub.creees, [], "aucun ticket ne doit être créé")
        self.assertEqual(json.loads(sortie)["issue"], 700)

    def test_la_carte_de_project_est_posee_et_ne_bloque_pas(self):
        # `project-automation.yml` exige PROJECT_TOKEN, absent du dépôt : sans
        # ce rappel, le jalon se remplit et le board reste vide. Un échec de
        # carte ne doit pour autant pas faire échouer le ticket.
        hub = Hub(issues=[])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, qa_bugs.OK)
        cartes = [args for canal, args in hub.appels
                  if canal == "run" and any("project_status.py" in a for a in args)]
        self.assertEqual(len(cartes), 1)
        self.assertIn("--field", cartes[0])
        self.assertIs(json.loads(sortie)["project"], False)

    def test_une_empreinte_neuve_cree_un_ticket_complet(self):
        hub = Hub(issues=[])
        code, sortie, _ = lancer(argv_open(sans_capture="essai"), hub)
        self.assertEqual(code, qa_bugs.OK)
        self.assertEqual(len(hub.creees), 1)
        appel = hub.creees[0]
        for label in ("type:bug", "nature:projet", "ws:frontend",
                      "mod:appointments", "P1"):
            self.assertIn(label, appel)
        self.assertIn(qa_bugs.JALON, appel)
        self.assertIsNone(json.loads(sortie)["regression_de"])


class Jalon(unittest.TestCase):
    """« Bug & correction » — créé une fois, et sans échéance."""

    def test_un_jalon_existant_n_est_pas_recree(self):
        hub = Hub(jalons=((qa_bugs.JALON, 9),))
        with mock.patch.object(qa_bugs, "gh_json", hub.gh_json):
            with redirect_stdout(io.StringIO()):
                numero = qa_bugs.ensure_milestone()
        self.assertEqual(numero, 9)
        self.assertNotIn("--method", [a for _, args in hub.appels for a in args])

    def test_un_jalon_absent_est_cree_sans_echeance(self):
        # Une échéance le ferait rafler les `/ticket-new` suivants :
        # `current_milestone()` retient le premier jalon ouvert encore à échoir.
        hub = Hub(jalons=(("S4 — Notifications", 4),))
        with mock.patch.object(qa_bugs, "gh_json", hub.gh_json):
            with redirect_stdout(io.StringIO()):
                numero = qa_bugs.ensure_milestone()
        self.assertEqual(numero, 42)
        creation = [args for _, args in hub.appels if "--method" in args]
        self.assertEqual(len(creation), 1)
        self.assertNotIn("due_on", " ".join(creation[0]))

    def test_un_jalon_ferme_est_rouvert_et_non_recree(self):
        # L'API ne rend que les jalons ouverts par défaut : un « Bug &
        # correction » fermé une fois le stock écoulé ferait POSTer un homonyme,
        # que GitHub refuse (422) — et toute la campagne sortirait en échec.
        hub = Hub()
        hub.jalons = [{"number": 5, "title": qa_bugs.JALON, "state": "closed"}]
        with mock.patch.object(qa_bugs, "gh_json", hub.gh_json), \
                mock.patch.object(qa_bugs, "gh", hub.gh):
            with redirect_stdout(io.StringIO()):
                numero = qa_bugs.ensure_milestone()
        self.assertEqual(numero, 5)
        self.assertEqual([args for _, args in hub.appels if "--method" in args
                          and "POST" in args], [])
        rouverture = [args for _, args in hub.appels if "PATCH" in args]
        self.assertEqual(len(rouverture), 1)
        self.assertIn("state=open", rouverture[0])

    def test_les_jalons_sont_demandes_fermes_compris_et_sans_jq(self):
        # `--jq` combiné à `--paginate` fait émettre un tableau JSON par page,
        # que `json.loads` ne sait pas relire au-delà de la première.
        hub = Hub()
        with mock.patch.object(qa_bugs, "gh_json", hub.gh_json):
            qa_bugs.milestones()
        [(_, args)] = hub.appels
        self.assertIn("state=all", args)
        self.assertNotIn("--jq", args)

    def test_ouvrir_un_ticket_garantit_le_jalon(self):
        hub = Hub(jalons=(("S4 — Notifications", 4),))
        lancer(argv_open(sans_capture="essai"), hub)
        self.assertTrue(any("--method" in args for _, args in hub.appels),
                        "le jalon doit être créé s'il manque")


class Grille(unittest.TestCase):
    """La grille de critères est un contrat partagé avec la skill."""

    def test_chaque_critere_est_frontend_ou_backend(self):
        for critere in qa_bugs.CRITERES:
            with self.subTest(critere=critere):
                self.assertRegex(critere, r"^(fe|be):[a-z0-9]+$")

    def test_les_deux_volets_demandes_sont_couverts(self):
        # Le ticket #595 nomme explicitement ces critères : s'ils disparaissent
        # de la grille, c'est la demande qui n'est plus servie.
        for critere in ("fe:design", "fe:ux", "fe:espacement", "fe:positionnement",
                        "fe:responsive", "fe:performance",
                        "be:securite", "be:performance", "be:latence"):
            with self.subTest(critere=critere):
                self.assertIn(critere, qa_bugs.CRITERES)

    def test_la_skill_documente_exactement_la_grille(self):
        # Deux listes qui divergent, c'est un agent qui invoque un critère que
        # le script refuse — et un constat perdu au moment de l'ouvrir.
        skill = (Path(__file__).resolve().parents[2]
                 / ".claude" / "skills" / "qa" / "SKILL.md")
        if not skill.is_file():                     # pragma: no cover
            self.skipTest("la skill qa n'est pas dans ce worktree")
        texte = skill.read_text(encoding="utf-8")
        for critere in qa_bugs.CRITERES:
            with self.subTest(critere=critere):
                self.assertIn(f"`{critere}`", texte)


if __name__ == "__main__":
    unittest.main()
