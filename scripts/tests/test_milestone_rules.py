#!/usr/bin/env python3
"""Tests du point d'écriture des règles de plan — `scripts/milestone_rules.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce qui est surveillé ici tient en une phrase : **une correction d'empreinte posée
par un agent doit survivre à l'étape et arriver intacte jusqu'au plan** (#208).

Le défaut d'origine n'était pas un bug de code, c'était une impasse
d'autorisation. En session non interactive — donc dans toutes les vagues d'un run
de jalon — le classifieur « fichier sensible » du harnais refuse `Edit` et
`Write` sur `.claude/**`, et personne n'est là pour accorder l'exception. Les
règles `Edit(./.claude/milestone-rules.json)` et `Write(...)` posées dans
`settings.json` n'y ont rien changé : sept refus les ont suivies. L'orchestrateur
recalculait donc à chaque étape des corrections qu'il ne pouvait pas enregistrer.

Ces tests figent le contrat du contournement retenu — un exécutable appelé par
`Bash(python scripts/…)`, qui lui est autorisé :

  * ce qu'on écrit se relit, et `milestone_plan.py` le voit (`CheminDEcriture`,
    `LePlanVoitLaCorrection`) — c'est le critère 1 de #208, sous forme de test ;
  * l'écriture est **étroite** : elle ne touche que la section visée et laisse le
    reste du fichier — à commencer par la notice `$doc` — au caractère près
    (`FideliteDuFichier`). Un point d'écriture qui abîmerait le fichier qu'il
    protège ne vaudrait pas mieux que pas de point d'écriture du tout ;
  * ce qui est fautif est refusé **avant** d'écrire, pas diagnostiqué plus tard
    dans un plan gelé (`EntreesFautives`).

Le risque de régression est silencieux, comme souvent ici : un `save()` qui
perdrait `$doc`, ou un `set-resources` qui compléterait au lieu de remplacer,
laisserait le plan vert et se paierait en vagues mal parallélisées.

Aucune dépendance : `unittest` de la bibliothèque standard, comme le reste de
`scripts/tests`. Le dépôt n'a pas de gestion de paquets Python.
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import milestone_plan  # noqa: E402 — l'insertion de chemin ci-dessus doit la précéder
import milestone_rules  # noqa: E402


# La notice du vrai fichier, en plus court. Elle n'a aucun rôle fonctionnel —
# c'est précisément pour cela qu'elle est un bon témoin : rien dans le code n'a
# de raison de la relire, donc rien ne la protège sinon la discipline de `save()`.
DOC = ["Ce que scripts/milestone_plan.py ne peut pas déduire des labels.",
       "Corriger ici plutôt qu'à la main dans le plan."]


class BaseRegles(unittest.TestCase):
    """Un fichier de règles jetable, monté à la place du vrai."""

    DEPART = {
        "$doc": DOC,
        "resources": {"10": ["infra/terraform/bootstrap"],
                      "155": ["scripts/milestone-plan", "scripts/tests/plan"]},
        "depends": {"11": [10]},
        "why": {"11": "aucun module ne s'applique sans backend d'état distant"},
    }

    def setUp(self):
        self.dossier = tempfile.TemporaryDirectory()
        self.addCleanup(self.dossier.cleanup)
        self.chemin = Path(self.dossier.name) / "milestone-rules.json"
        self.ecrire(self.DEPART)
        patch = mock.patch.object(milestone_rules, "RULES_FILE", self.chemin)
        patch.start()
        self.addCleanup(patch.stop)

    def ecrire(self, data):
        self.chemin.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")

    def relire(self):
        return json.loads(self.chemin.read_text(encoding="utf-8"))

    def lancer(self, *argv):
        """La ligne de commande, telle qu'un orchestrateur l'appelle.

        Rend (code de sortie, sortie standard) — c'est le contrat que voit
        l'appelant, pas les fonctions internes.
        """
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = milestone_rules.main(list(argv))
        return code, out.getvalue() + err.getvalue()


class CheminDEcriture(BaseRegles):
    """Le cœur de #208 : ce qu'on écrit se relit."""

    def test_une_empreinte_posee_se_relit(self):
        code, _ = self.lancer("set-resources", "208",
                              "scripts/milestone-rules", ".claude/settings")
        self.assertEqual(code, milestone_rules.OK)
        # Relue depuis le disque, pas depuis l'objet en mémoire : c'est la
        # survie à l'étape qui est en cause, pas le calcul.
        self.assertEqual(milestone_rules.load(self.chemin)["resources"]["208"],
                         [".claude/settings", "scripts/milestone-rules"])

    def test_l_empreinte_remplace_et_ne_complete_pas(self):
        # Une empreinte figée se substitue *entièrement* à l'heuristique du
        # planificateur. La compléter laisserait croire l'inverse.
        self.lancer("set-resources", "155", "scripts/milestone-rules")
        self.assertEqual(self.relire()["resources"]["155"],
                         ["scripts/milestone-rules"])

    def test_les_ressources_sont_dedupliquees_et_triees(self):
        self.lancer("set-resources", "208", "b:deux", "a:un", "b:deux")
        self.assertEqual(self.relire()["resources"]["208"], ["a:un", "b:deux"])

    def test_reposer_la_meme_empreinte_ne_recrit_pas(self):
        self.lancer("set-resources", "208", "scripts/milestone-rules")
        avant = self.chemin.read_text(encoding="utf-8")
        code, sortie = self.lancer("set-resources", "208",
                                   "scripts/milestone-rules")
        self.assertEqual(code, milestone_rules.OK)
        self.assertIn("inchangée", sortie)
        self.assertEqual(self.chemin.read_text(encoding="utf-8"), avant)

    def test_le_croisillon_est_tolere(self):
        # L'orchestrateur manipule des « #208 » toute la journée.
        self.lancer("set-resources", "#208", "scripts/milestone-rules")
        self.assertIn("208", self.relire()["resources"])

    def test_un_prerequis_pose_s_ajoute_sans_effacer_les_siens(self):
        code, _ = self.lancer("add-depends", "11", "12")
        self.assertEqual(code, milestone_rules.OK)
        self.assertEqual(self.relire()["depends"]["11"], [10, 12])

    def test_un_prerequis_porte_sa_justification(self):
        self.lancer("add-depends", "22", "202", "--why", "l'énumération d'abord")
        releve = self.relire()
        self.assertEqual(releve["depends"]["22"], [202])
        self.assertEqual(releve["why"]["22"], "l'énumération d'abord")

    def test_les_prerequis_sont_dedupliques_et_tries(self):
        self.lancer("add-depends", "11", "12", "10", "12")
        self.assertEqual(self.relire()["depends"]["11"], [10, 12])

    def test_le_fichier_absent_est_cree(self):
        self.chemin.unlink()
        code, _ = self.lancer("set-resources", "208", "scripts/milestone-rules")
        self.assertEqual(code, milestone_rules.OK)
        self.assertEqual(self.relire()["resources"], {"208": ["scripts/milestone-rules"]})


class FideliteDuFichier(BaseRegles):
    """L'écriture est étroite : elle ne touche que ce qu'on lui demande."""

    def test_la_notice_survit_a_une_ecriture(self):
        self.lancer("set-resources", "208", "scripts/milestone-rules")
        self.assertEqual(self.relire()["$doc"], DOC)

    def test_les_autres_issues_ne_bougent_pas(self):
        self.lancer("set-resources", "208", "scripts/milestone-rules")
        releve = self.relire()
        self.assertEqual(releve["resources"]["10"], ["infra/terraform/bootstrap"])
        self.assertEqual(releve["depends"], {"11": [10]})
        self.assertEqual(releve["why"], self.DEPART["why"])

    def test_le_format_reste_diffable(self):
        """Indentation 2, accents littéraux, saut de ligne final.

        Ce n'est pas de la cosmétique : la revue porte sur le diff de ce
        fichier. Un `ensure_ascii` par défaut réécrirait chaque accent en
        `\\uXXXX` et rendrait illisible un diff d'une ligne.
        """
        self.lancer("add-depends", "22", "202", "--why", "l'énumération d'abord")
        brut = self.chemin.read_text(encoding="utf-8")
        self.assertTrue(brut.endswith("}\n"))
        self.assertNotIn("\\u", brut)
        self.assertIn("l'énumération d'abord", brut)
        self.assertIn('\n  "resources": {', brut)

    def test_l_ecriture_ne_laisse_pas_de_fichier_temporaire(self):
        # `save()` passe par un temporaire puis `os.replace`. S'il en laissait
        # traîner, le dossier `.claude/` se remplirait à chaque correction.
        self.lancer("set-resources", "208", "scripts/milestone-rules")
        restes = [p.name for p in self.chemin.parent.iterdir()
                  if p.name != self.chemin.name]
        self.assertEqual(restes, [])


class EntreesFautives(BaseRegles):
    """Ce qui est fautif est refusé avant d'écrire, jamais à moitié écrit."""

    def refus(self, *argv):
        avant = self.chemin.read_text(encoding="utf-8")
        code, sortie = self.lancer(*argv)
        self.assertEqual(code, milestone_rules.USAGE, sortie)
        self.assertEqual(self.chemin.read_text(encoding="utf-8"), avant,
                         "le fichier a été touché malgré un appel refusé")
        return sortie

    def test_un_numero_qui_n_en_est_pas_un(self):
        self.assertIn("numéro d'issue", self.refus("set-resources", "abc", "x"))

    def test_un_numero_negatif(self):
        self.refus("set-resources", "0", "x")

    def test_un_chiffre_qui_n_est_pas_ascii(self):
        """`'²'.isdigit()` est vrai, `int('²')` lève.

        Sans le garde `isascii()`, l'appel sortait en traceback avec un code 1
        — « fichier illisible » — pour une entrée simplement fautive.
        """
        self.refus("set-resources", "²", "x")
        self.refus("add-depends", "11", "²")

    def test_une_ressource_vide(self):
        self.assertIn("ressource vide", self.refus("set-resources", "208", "  "))

    def test_une_issue_ne_depend_pas_d_elle_meme(self):
        self.assertIn("propre prérequis", self.refus("add-depends", "11", "11"))

    def test_un_prerequis_circulaire_est_refuse(self):
        """#11 dépend déjà de #10 : poser #10 après #11 referme la boucle.

        Les prérequis figés priment sur l'heuristique et ne sont pas coupés
        comme le sont les arêtes déduites — un cycle posé ici gèlerait les deux
        issues, sans rien dire de compréhensible dans le plan.
        """
        sortie = self.refus("add-depends", "10", "11")
        self.assertIn("circulaire", sortie)
        self.assertIn("#10", sortie)

    def test_un_cycle_indirect_est_refuse_aussi(self):
        self.lancer("add-depends", "12", "11")   # 12 → 11 → 10
        self.refus("add-depends", "10", "12")

    def test_un_fichier_illisible_est_signale_sans_etre_ecrase(self):
        self.chemin.write_text("{ pas du json", encoding="utf-8")
        code, sortie = self.lancer("show")
        self.assertEqual(code, milestone_rules.FAIL)
        self.assertIn("illisible", sortie)
        self.assertEqual(self.chemin.read_text(encoding="utf-8"), "{ pas du json")


class Relecture(BaseRegles):
    """`show` — ce qu'un orchestrateur lit avant de décider."""

    def test_show_rend_une_issue_en_json(self):
        code, sortie = self.lancer("show", "11", "--json")
        self.assertEqual(code, milestone_rules.OK)
        self.assertEqual(json.loads(sortie),
                         {"issue": 11, "resources": [], "depends": [10],
                          "why": self.DEPART["why"]["11"]})

    def test_show_d_une_issue_inconnue_le_dit_sans_echouer(self):
        code, sortie = self.lancer("show", "999")
        self.assertEqual(code, milestone_rules.OK)
        self.assertIn("heuristique", sortie)

    def test_show_liste_toutes_les_issues_figees(self):
        code, sortie = self.lancer("show")
        self.assertEqual(code, milestone_rules.OK)
        for number in ("#10", "#11", "#155"):
            self.assertIn(number, sortie)

    def test_show_tout_en_json_rend_le_fichier(self):
        _, sortie = self.lancer("show", "--json")
        self.assertEqual(json.loads(sortie), self.DEPART)


class LePlanVoitLaCorrection(BaseRegles):
    """Le critère 1 de #208, de bout en bout.

    Poser une empreinte ne sert à rien si le planificateur continue de lire
    ailleurs. `milestone_plan` n'a plus de chemin à lui : il passe par
    `milestone_rules.load()`, donc par le fichier que la ligne de commande vient
    d'écrire.
    """

    def test_le_planificateur_lit_ce_que_la_commande_ecrit(self):
        self.lancer("set-resources", "208",
                    "scripts/milestone-rules", ".claude/settings")
        self.assertEqual(milestone_plan.load_rules()["resources"]["208"],
                         [".claude/settings", "scripts/milestone-rules"])

    def test_l_empreinte_corrigee_remplace_l_heuristique(self):
        """Sans règle, #208 (ws:devops + mod:infra) hérite d'`infra/terraform`.

        C'est l'empreinte fautive que le plan lui donnait, et qui la sérialisait
        derrière tous les tickets Terraform du jalon alors qu'elle ne touche
        aucun fichier Terraform.
        """
        node = {"number": 208, "title": "Le classifieur du harnais",
                "body": "", "workstream": "devops", "module": "infra"}

        self.assertEqual(milestone_plan.resources_of(node, milestone_plan.load_rules()),
                         ["infra/terraform"])

        self.lancer("set-resources", "208",
                    "scripts/milestone-rules", ".claude/settings")
        self.assertEqual(milestone_plan.resources_of(node, milestone_plan.load_rules()),
                         [".claude/settings", "scripts/milestone-rules"])

    def test_un_prerequis_pose_devient_une_arete_du_graphe(self):
        self.lancer("add-depends", "208", "179", "--why", "la même empreinte")
        rules = milestone_plan.load_rules()
        self.assertEqual(rules["depends"]["208"], [179])
        self.assertEqual(rules["why"]["208"], "la même empreinte")


if __name__ == "__main__":
    unittest.main()
