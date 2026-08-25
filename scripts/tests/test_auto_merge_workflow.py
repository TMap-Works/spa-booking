#!/usr/bin/env python3
r"""Garde-fou : `auto-merge.yml` garde les droits sans lesquels il merge à moitié.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce test existe à cause de #154. GitHub ferme une issue liée (`Closes #N`) **au
nom de l'acteur qui merge**. Quand cet acteur est le `GITHUB_TOKEN` du workflow
et que celui-ci ne déclare pas `issues: write`, la fermeture est abandonnée en
silence : le merge réussit, l'issue reste ouverte, et rien n'est journalisé.

Le silence est le vrai défaut. `milestone_plan.py` raisonne sur l'état des
**issues**, pas des PR : une issue jamais fermée est reproposée à la vague
suivante — un agent a ainsi refait le travail de #139, déjà mergé le matin même
— et ses dépendantes ne se débloquent jamais. La corrélation était sans
exception sur les huit PR du projet : les trois mergées par un jeton utilisateur
ont fermé leur issue, les cinq mergées par `app/github-actions` non.

Rien dans la CI ne relit un bloc `permissions:`. Un droit retiré par mégarde —
réécriture du workflow, durcissement bien intentionné, fusion malheureuse — ne
casse aucun test et ne rougit nulle part : il se remarque des semaines plus tard,
sur un jalon qui n'avance plus. D'où ce garde-fou, qui couvre trois choses :

1. le bloc `permissions:` de premier niveau existe et porte `issues: write` ;
2. les droits déjà acquis au prix d'un incident restent là — `actions: read`
   vient de #125, `contents`/`pull-requests: write` du merge lui-même ;
3. le résumé d'exécution nomme toujours l'issue fermée, ou dit pourquoi aucune
   ne l'a été.

Aucune dépendance : `unittest` de la bibliothèque standard. Le dépôt n'installe
rien pour `scripts/tests` (voir le job `scripts` de ci.yml), donc PyYAML n'est
pas garanti — d'où le petit lecteur ci-dessous, lui-même éprouvé sur des blocs
synthétiques, et confronté à PyYAML quand il se trouve être installé.
"""
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
WORKFLOW = RACINE / ".github" / "workflows" / "auto-merge.yml"

# Les droits sans lesquels le workflow échoue, ou pire, réussit à moitié.
# Chacun a été payé par un incident : les retirer n'est jamais une simplification.
DROITS_REQUIS = {
    "contents": "write",  # squash-merge sur develop, suppression de la branche
    "pull-requests": "write",  # lire l'état de la PR, retirer le label, merger
    "issues": "write",  # fermer l'issue liée au merge — #154
    "actions": "read",  # `checkSuite.workflowRun` du rollup — #125
    "checks": "read",  # les `CheckRun` du rollup, sans quoi la barrière est aveugle
    "statuses": "read",  # les `StatusContext` du rollup, même raison
}


def lignes_du_workflow():
    """Le fichier découpé en lignes, ou un échec parlant s'il a disparu."""
    if not WORKFLOW.is_file():
        raise AssertionError(
            f"{WORKFLOW.relative_to(RACINE)} est introuvable : le merge du dépôt "
            "n'est plus délégué à la CI, ou le fichier a été déplacé sans mettre "
            "ce garde-fou à jour."
        )
    return WORKFLOW.read_text(encoding="utf-8").splitlines()


def permissions_de_premier_niveau(lignes):
    """Le bloc `permissions:` de premier niveau, en couples clé/valeur.

    Rend `None` si aucun bloc de premier niveau n'existe — cas important : sans
    bloc, le jeton reçoit les droits par défaut du dépôt, un réglage d'interface
    que rien dans le code ne fixe. Rend la chaîne telle quelle pour les formes
    scalaires (`permissions: read-all`, `permissions: {}`), qui ne se lisent pas
    comme un dictionnaire.

    Un `permissions:` **indenté** appartient à un job et n'est pas regardé ici :
    le bloc de premier niveau est celui qui s'applique à tous les jobs, et c'est
    celui que #154 a trouvé incomplet.
    """
    for index, ligne in enumerate(lignes):
        if not ligne.startswith("permissions:"):
            continue  # ligne indentée : bloc d'un job, ou autre clé
        _, _, reste = ligne.partition(":")
        reste = sans_commentaire(reste)
        if reste:
            return reste
        return corps_du_bloc(lignes[index + 1 :])
    return None


def corps_du_bloc(lignes):
    """Les couples clé/valeur indentés qui suivent, jusqu'au retour en marge."""
    droits = {}
    for ligne in lignes:
        nue = ligne.strip()
        if not nue or nue.startswith("#"):
            continue  # ligne vide ou commentaire : le bloc continue
        if not ligne[:1].isspace():
            break  # retour au premier niveau : le bloc est fini
        cle, separateur, valeur = nue.partition(":")
        if not separateur:
            continue
        droits[cle.strip()] = sans_commentaire(valeur)
    return droits


def sans_commentaire(valeur):
    """`write  # parce que …` → `write`. Aucune valeur de droit ne porte de `#`."""
    return valeur.split("#", 1)[0].strip()


def commentaire_au_dessus(lignes, cle):
    """Le bloc de commentaires contigu qui précède `cle:`, du haut vers le bas."""
    for index, ligne in enumerate(lignes):
        if ligne.strip().startswith(f"{cle}:"):
            precedentes = []
            for candidate in reversed(lignes[:index]):
                if candidate.strip().startswith("#"):
                    precedentes.append(candidate.strip().lstrip("#").strip())
                else:
                    break
            return list(reversed(precedentes))
    return []


class TestPermissionsDuWorkflow(unittest.TestCase):
    def setUp(self):
        self.lignes = lignes_du_workflow()
        self.droits = permissions_de_premier_niveau(self.lignes)

    def test_bloc_permissions_explicite(self):
        """Sans bloc, le jeton hérite d'un réglage d'interface, pas du code."""
        self.assertIsNotNone(
            self.droits,
            "auto-merge.yml ne déclare plus de bloc `permissions:` de premier "
            "niveau : les droits du GITHUB_TOKEN dépendraient alors du réglage "
            "« Workflow permissions » du dépôt, invisible depuis le code et "
            "modifiable sans revue.",
        )
        self.assertIsInstance(
            self.droits,
            dict,
            f"`permissions:` est passé à une forme scalaire ({self.droits!r}) : "
            "les droits doivent rester énumérés un par un, chacun avec sa raison "
            "d'être.",
        )

    def test_issues_write_present(self):
        """Le droit sans lequel le merge laisse son issue ouverte (#154)."""
        self.assertEqual(
            (self.droits or {}).get("issues"),
            "write",
            "auto-merge.yml ne déclare plus `issues: write`. GitHub ferme une "
            "issue liée au nom de l'acteur qui merge : sans ce droit, le merge "
            "réussit mais la fermeture est abandonnée **en silence**. L'issue "
            "reste « à traiter » pour milestone_plan.py, qui la reprogramme, et "
            "ses dépendantes ne se débloquent jamais. Voir #154.",
        )

    def test_droits_acquis_conserves(self):
        """Aucun droit du bloc ne se retire sans revenir sur son incident."""
        for droit, niveau in DROITS_REQUIS.items():
            with self.subTest(droit=droit):
                self.assertEqual(
                    (self.droits or {}).get(droit),
                    niveau,
                    f"`{droit}: {niveau}` a disparu du bloc `permissions:` de "
                    "auto-merge.yml. Chacun de ces droits répare une panne "
                    "constatée (#125 pour `actions`, #154 pour `issues`) — le "
                    "retirer les rejoue.",
                )

    def test_issues_write_est_justifie(self):
        """Un droit sans sa raison d'être est un droit qu'on retirera."""
        commentaire = commentaire_au_dessus(self.lignes, "issues")
        self.assertTrue(
            commentaire,
            "`issues: write` n'est plus précédé d'un commentaire. C'est ce "
            "commentaire qui empêche le prochain durcissement de le prendre pour "
            "un droit superflu.",
        )
        self.assertIn(
            "154",
            " ".join(commentaire),
            "le commentaire de `issues: write` ne renvoie plus à #154, où la "
            "corrélation merge → issue restée ouverte est établie.",
        )


class TestResumeDeFermeture(unittest.TestCase):
    """Le troisième critère de #154 : un merge qui ne ferme rien n'est plus muet.

    Ces cas ne rejouent pas le shell — ils vérifient que l'étape lit toujours les
    liens de fermeture et les écrit dans le résumé. Un résumé qui redeviendrait
    muet ferait retomber #154 dans son mode de défaillance d'origine : non pas
    une erreur, mais une absence que personne ne remarque.
    """

    def setUp(self):
        self.texte = WORKFLOW.read_text(encoding="utf-8")

    def test_les_liens_de_fermeture_sont_lus(self):
        self.assertIn(
            "closingIssuesReferences",
            self.texte,
            "auto-merge.yml ne lit plus `closingIssuesReferences` : le job ne "
            "peut plus nommer l'issue que son merge ferme (#154).",
        )

    def test_le_resume_parle_de_la_fermeture(self):
        """Le résumé doit distinguer « ferme #N » de « aucune issue fermée »."""
        for attendu in ("ferme $liees", "aucune issue fermée"):
            with self.subTest(attendu=attendu):
                self.assertIn(
                    attendu,
                    self.texte,
                    "le résumé d'exécution ne rend plus compte de la fermeture "
                    f"(« {attendu} » a disparu). Un merge qui ne ferme rien doit "
                    "le dire — c'est ce silence qui a laissé cinq issues "
                    "ouvertes sans que personne le voie (#154).",
                )


class TestLecture(unittest.TestCase):
    """Le lecteur de blocs, éprouvé à part.

    Sans ces cas, une faute dans `permissions_de_premier_niveau` rendrait un
    dictionnaire vide et **tous** les cas ci-dessus échoueraient bruyamment —
    ou, pire selon le sens de la faute, un dictionnaire trop généreux qui les
    ferait tous passer sur un workflow pourtant amputé.
    """

    def test_bloc_simple(self):
        texte = "name: X\npermissions:\n  contents: write\n  issues: write\njobs:\n"
        self.assertEqual(
            permissions_de_premier_niveau(texte.splitlines()),
            {"contents": "write", "issues": "write"},
        )

    def test_commentaires_et_lignes_vides_traverses(self):
        texte = (
            "permissions:\n"
            "  contents: write\n"
            "  # pourquoi ce droit existe\n"
            "\n"
            "  issues: write  # commentaire de fin de ligne\n"
            "\n"
            "concurrency:\n"
            "  group: x\n"
        )
        self.assertEqual(
            permissions_de_premier_niveau(texte.splitlines()),
            {"contents": "write", "issues": "write"},
        )

    def test_bloc_de_job_ignore(self):
        """Un `permissions:` indenté ne s'applique qu'à son job."""
        texte = (
            "jobs:\n"
            "  merge:\n"
            "    permissions:\n"
            "      issues: write\n"
            "    steps: []\n"
        )
        self.assertIsNone(permissions_de_premier_niveau(texte.splitlines()))

    def test_forme_scalaire(self):
        for ligne, attendu in (
            ("permissions: read-all", "read-all"),
            ("permissions: {}", "{}"),
            ("permissions: write-all  # tout, vraiment", "write-all"),
        ):
            with self.subTest(ligne=ligne):
                self.assertEqual(
                    permissions_de_premier_niveau([ligne, "jobs:"]), attendu
                )

    def test_absence_de_bloc(self):
        self.assertIsNone(permissions_de_premier_niveau(["name: X", "jobs:"]))

    def test_commentaire_au_dessus(self):
        texte = (
            "permissions:\n"
            "  contents: write\n"
            "  # première ligne\n"
            "  # seconde ligne\n"
            "  issues: write\n"
        )
        self.assertEqual(
            commentaire_au_dessus(texte.splitlines(), "issues"),
            ["première ligne", "seconde ligne"],
        )

    def test_accord_avec_pyyaml(self):
        """Quand PyYAML est là, le lecteur maison doit dire la même chose.

        Sauté en CI, qui n'installe rien : c'est un filet de développement, pas
        une dépendance. Il attrape la divergence là où elle se crée — sur le
        poste de celui qui réécrit le bloc.
        """
        try:
            import yaml
        except ImportError as erreur:  # pragma: no cover - dépend du poste
            raise unittest.SkipTest(f"PyYAML absent : {erreur}") from erreur
        document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(
            permissions_de_premier_niveau(lignes_du_workflow()),
            document.get("permissions"),
        )


if __name__ == "__main__":
    unittest.main()
