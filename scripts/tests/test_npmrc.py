#!/usr/bin/env python3
r"""Garde-fou : aucun `.npmrc` versionné ne porte de chemin absolu.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce test existe à cause de #139. Sur un poste Windows dont le chemin de dépôt
contient une esperluette — `D:\spyle\Spa & Booking` — `cmd.exe` coupe la ligne
de commande à ce caractère et **aucun binaire local ne se résout** : ni
`eslint`, ni `tsc`, ni `jest`. `npm run verify` devient infranchissable. Le
remède est de faire exécuter les scripts npm par bash :

    npm config set script-shell "C:/Program Files/Git/bin/bash.exe"

Le piège est là : cette commande accepte `--location=project`, qui écrit le
réglage dans un `.npmrc` **du dépôt**. Un tel fichier partirait en CI, où
`C:/Program Files/…` n'existe pas, et casserait le job Linux pour tout le
monde — un correctif de poste transformé en panne collective.

D'où deux verrous complémentaires : `.npmrc` est dans `.gitignore`, et ce test
échoue si un `.npmrc` versionné réapparaît malgré tout avec un chemin absolu
dedans (`git add -f`, fusion, ou fichier posé avant la règle d'exclusion).

Un `.npmrc` versionné *sans* chemin absolu reste permis : `engine-strict=true`
ou `save-exact=true` sont portables et n'ont rien à faire ici.

Aucune dépendance : `unittest` de la bibliothèque standard.
"""
import re
import subprocess
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]

# Un chemin absolu, dans les trois dialectes qu'un `.npmrc` peut porter :
# `C:/Program Files/...` ou `C:\Program Files\...` côté Windows, `\\poste\part`
# en UNC — tout aussi propre à une machine — et `/usr/bin/...` côté POSIX. Les
# valeurs relatives (`bash`, `./outil`) passent — elles se résolvent sur chaque
# poste au lieu d'en figer un seul.
ABSOLU = re.compile(r"^(?:[A-Za-z]:[\\/]|[\\/])")


def git(*arguments):
    """Lance git depuis la racine, ou saute le test si git ne répond pas.

    Git absent du PATH lève OSError bien avant de rendre un code de retour :
    sans ce filet, un poste ou une image de CI sans git ferait rougir le
    garde-fou par une trace Python au lieu de le sauter proprement.
    """
    try:
        return subprocess.run(
            ["git", *arguments],
            cwd=RACINE,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as erreur:
        raise unittest.SkipTest(f"git indisponible : {erreur}") from erreur


def npmrc_versionnes():
    """Les `.npmrc` connus de git, à la racine comme dans les workspaces."""
    fini = git("ls-files", "-z", "--", "*.npmrc", ".npmrc")
    if fini.returncode != 0:
        raise unittest.SkipTest(f"git ls-files indisponible : {fini.stderr.strip()}")
    return [RACINE / chemin for chemin in fini.stdout.split("\0") if chemin]


def valeurs(texte):
    """Les couples clé/valeur d'un `.npmrc`, commentaires et vides écartés."""
    for numero, ligne in enumerate(texte.splitlines(), start=1):
        nue = ligne.strip()
        if not nue or nue.startswith((";", "#")) or "=" not in nue:
            continue
        cle, _, valeur = nue.partition("=")
        yield numero, cle.strip(), valeur.strip().strip('"').strip("'")


class TestNpmrcVersionne(unittest.TestCase):
    def test_aucun_chemin_absolu(self):
        """Un chemin de poste dans un `.npmrc` versionné casse la CI Linux."""
        for fichier in npmrc_versionnes():
            if not fichier.is_file():
                continue  # index sans fichier de travail (suppression non indexée)
            texte = fichier.read_text(encoding="utf-8", errors="replace")
            for numero, cle, valeur in valeurs(texte):
                self.assertIsNone(
                    ABSOLU.match(valeur),
                    f"{fichier.relative_to(RACINE)}:{numero} — «{cle}» porte le "
                    f"chemin absolu «{valeur}». Un réglage propre au poste "
                    f"s'écrit dans ~/.npmrc : npm config set {cle} \"…\" "
                    f"(voir CONTRIBUTING.md, prérequis Windows).",
                )

    def test_npmrc_est_exclu(self):
        """`.gitignore` doit couvrir `.npmrc`, faute de quoi le verrou est nu."""
        fini = git("check-ignore", "-q", ".npmrc")
        # 0 = ignoré, 1 = non ignoré ; tout le reste veut dire que git n'a pas
        # pu répondre (hors dépôt, index illisible) — pas que la règle a sauté.
        if fini.returncode not in (0, 1):
            raise unittest.SkipTest(
                f"git check-ignore n'a pas pu répondre : {fini.stderr.strip()}"
            )
        self.assertEqual(
            fini.returncode,
            0,
            "`.npmrc` n'est plus exclu par .gitignore : un réglage de poste "
            "peut à nouveau être versionné par inadvertance (#139).",
        )


class TestDetection(unittest.TestCase):
    """La logique de détection, éprouvée sur des `.npmrc` synthétiques.

    Les deux cas ci-dessus passent à vide tant qu'aucun `.npmrc` n'est versionné
    — c'est justement l'état recherché. Sans ces cas-ci, une faute de frappe
    dans `ABSOLU` ou dans `valeurs()` neutraliserait le garde-fou sans que rien
    ne rougisse : un verrou muet, exactement le mode de défaillance que #139
    reproche à la barrière elle-même.
    """

    def test_chemins_absolus_detectes(self):
        for valeur in (
            "C:/Program Files/Git/bin/bash.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            "d:/outils/bash.exe",
            r"\\poste-dev\outils\bash.exe",
            "//wsl$/Ubuntu/bin/bash",
            "/usr/bin/bash",
            "/opt/homebrew/bin/bash",
        ):
            with self.subTest(valeur=valeur):
                self.assertIsNotNone(ABSOLU.match(valeur))

    def test_valeurs_portables_acceptees(self):
        """Un `.npmrc` versionné reste permis tant qu'il ne fige aucun poste."""
        for valeur in (
            "bash",
            "true",
            "https://registry.npmjs.org/",
            "./scripts/shell.sh",
            "~/bin/bash",
            "",
        ):
            with self.subTest(valeur=valeur):
                self.assertIsNone(ABSOLU.match(valeur))

    def test_lecture_dun_npmrc(self):
        """Commentaires, lignes vides, guillemets et espaces autour du `=`."""
        contenu = "\n".join(
            [
                "; réglage propre au poste",
                "# autre commentaire",
                "",
                "engine-strict=true",
                'script-shell="C:/Program Files/Git/bin/bash.exe"',
                "  save-exact = true  ",
                "ligne-sans-egal",
            ]
        )
        self.assertEqual(
            list(valeurs(contenu)),
            [
                (4, "engine-strict", "true"),
                (5, "script-shell", "C:/Program Files/Git/bin/bash.exe"),
                (6, "save-exact", "true"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
