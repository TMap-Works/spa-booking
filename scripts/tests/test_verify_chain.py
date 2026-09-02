#!/usr/bin/env python3
r"""Garde-fou : `npm run verify` commence par `db:generate`, `apps/api` garde `pretypecheck`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce test existe à cause de #220, corrigée par #270. Le client Prisma est un
artefact **généré** : tant qu'il n'est pas régénéré après une migration, `tsc`
voit un schéma périmé et rend des `TS2322` sur des valeurs d'énumération qui
existent pourtant. #270 a réglé cela en deux endroits complémentaires :

1. `verify` (racine) commence par `db:generate` — la barrière régénère avant de
   typer, quel que soit l'âge du `node_modules` du poste ;
2. `pretypecheck` (`apps/api`) lance `prisma generate` — npm le déclenche seul
   devant `typecheck`, donc même un `npm run typecheck` isolé part d'un client à
   jour.

Rien ne verrouillait leur présence, et **la CI ne peut pas la verrouiller** :
elle fait `npm ci` à chaque exécution, dont le `postinstall` d'`apps/api` lance
`prisma generate`. Le client y est donc toujours frais, que `verify` commence
par `db:generate` ou non. Un remaniement qui retirerait l'un ou l'autre passerait
au vert en CI et ne casserait que les postes — exactement le mécanisme qui a
laissé #220 passer inaperçue jusqu'à ce qu'elle arrête un jalon sain.

D'où ce garde-fou, qui couvre deux choses et rien d'autre :

1. la **première** cible de la chaîne `verify` est `db:generate` — sa présence
   ne suffit pas, l'ordre est tout le propos ;
2. `apps/api` déclare toujours un `pretypecheck` qui génère le client Prisma.

Aucune dépendance : `unittest` et `json` de la bibliothèque standard. Le dépôt
n'installe rien pour `scripts/tests` (voir le job `scripts` de ci.yml).
"""
import json
import re
import tempfile
import unittest
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]
PACKAGE_RACINE = RACINE / "package.json"
PACKAGE_API = RACINE / "apps" / "api" / "package.json"

# Une cible npm telle qu'un script la lance : `npm run db:generate`, avec ou
# sans drapeaux derrière (`--workspaces`, `--if-present`). `npm run-script` et
# le raccourci `npm run` sont acceptés — npm les traite à l'identique.
CIBLE_NPM = re.compile(r"^npm\s+run(?:-script)?\s+(?P<cible>[\w:@./-]+)")


def scripts_de(fichier):
    """Le bloc `scripts` d'un package.json, ou un échec nommant le fichier."""
    try:
        contenu = json.loads(fichier.read_text(encoding="utf-8"))
    except OSError as erreur:  # fichier déplacé ou renommé : c'est un défaut
        raise AssertionError(f"{fichier} illisible : {erreur}") from erreur
    except json.JSONDecodeError as erreur:
        raise AssertionError(f"{fichier} n'est pas un JSON valide : {erreur}") from erreur
    scripts = contenu.get("scripts")
    if not isinstance(scripts, dict):
        raise AssertionError(f"{fichier} ne déclare aucun bloc «scripts».")
    return scripts


def maillons(chaine):
    """Les commandes d'une chaîne shell `a && b && c`, dans l'ordre.

    Les `&&` seuls comptent : un `&` isolé n'enchaîne pas séquentiellement, et
    couper dessus disloquerait une commande qui en porterait un — le chemin de
    ce dépôt en contient un, c'est tout le sujet de #139.
    """
    return [maillon.strip() for maillon in re.split(r"&&", chaine) if maillon.strip()]


def premiere_cible(chaine):
    """La cible npm lancée en premier par une chaîne, ou None si ce n'en est pas une."""
    premiers = maillons(chaine)
    if not premiers:
        return None
    trouve = CIBLE_NPM.match(premiers[0])
    return trouve.group("cible") if trouve else None


class TestChaineVerify(unittest.TestCase):
    """Ce que #270 a posé dans les deux package.json, tel qu'il doit rester."""

    def test_verify_commence_par_db_generate(self):
        """`db:generate` ailleurs que devant ne protège plus le typecheck."""
        scripts = scripts_de(PACKAGE_RACINE)
        self.assertIn(
            "verify",
            scripts,
            "package.json ne déclare plus de script «verify» — c'est la barrière "
            "que /ticket et /milestone lancent en phase 4.",
        )
        self.assertEqual(
            premiere_cible(scripts["verify"]),
            "db:generate",
            "le script «verify» de package.json ne commence plus par "
            f"«npm run db:generate» mais par «{maillons(scripts['verify'])[:1]}». "
            "Le typecheck partirait d'un client Prisma périmé et rendrait des "
            "TS2322 sur des valeurs d'énumération pourtant migrées (#220, #270). "
            "La CI ne verra rien : son «npm ci» régénère le client à chaque fois.",
        )

    def test_api_garde_son_pretypecheck(self):
        """Sans lui, un `npm run typecheck` isolé retombe dans le piège de #220."""
        scripts = scripts_de(PACKAGE_API)
        self.assertIn(
            "pretypecheck",
            scripts,
            "apps/api/package.json ne déclare plus «pretypecheck» : npm ne "
            "régénère plus le client Prisma devant «typecheck», et un typecheck "
            "lancé seul repart d'un client périmé (#220, #270).",
        )
        self.assertIn(
            "prisma generate",
            scripts["pretypecheck"],
            "le «pretypecheck» d'apps/api ne lance plus «prisma generate» mais "
            f"«{scripts['pretypecheck']}» — le hook existe encore mais ne "
            "régénère plus rien.",
        )


class TestDetection(unittest.TestCase):
    """La lecture de chaîne, éprouvée sur des scripts synthétiques.

    Les deux cas ci-dessus passent tant que les package.json sont conformes —
    c'est l'état recherché. Sans ces cas-ci, une faute dans `CIBLE_NPM` ou dans
    `maillons()` rendrait `premiere_cible()` incapable de reconnaître quoi que
    ce soit, et le garde-fou deviendrait muet : il passerait au vert sur un
    `verify` amputé, exactement le mode de défaillance qu'il est censé fermer.
    """

    def test_premiere_cible_reconnue(self):
        for chaine, attendu in (
            ("npm run db:generate && npm run lint", "db:generate"),
            ("npm run db:generate", "db:generate"),
            ("  npm  run   db:generate   &&  npm run lint  ", "db:generate"),
            ("npm run-script db:generate && npm run lint", "db:generate"),
            ("npm run db:generate --workspaces --if-present && npm run lint", "db:generate"),
            ("npm run lint && npm run db:generate", "lint"),
        ):
            with self.subTest(chaine=chaine):
                self.assertEqual(premiere_cible(chaine), attendu)

    def test_premiere_commande_non_npm(self):
        """Un `verify` qui ne commence pas par une cible npm n'en a aucune."""
        for chaine in (
            "prisma generate && npm run lint",
            "node scripts/verify.js",
            "npx prisma generate && npm run db:generate",
            "",
            "   ",
        ):
            with self.subTest(chaine=chaine):
                self.assertIsNone(premiere_cible(chaine))

    def test_esperluette_simple_ne_coupe_pas(self):
        """Un `&` isolé n'enchaîne pas : le couper disloquerait la commande (#139)."""
        self.assertEqual(
            maillons('cd "D:/Spa & Booking" && npm run lint'),
            ['cd "D:/Spa & Booking"', "npm run lint"],
        )

    def test_scripts_de_signale_un_package_json_inexploitable(self):
        """Un package.json illisible est un défaut, pas un test à sauter.

        Les trois voies d'échec de `scripts_de()` doivent lever `AssertionError`
        et non remonter brutes : fichier absent, JSON invalide, bloc «scripts»
        manquant. Sans ces cas, une de ces voies pourrait cesser de signaler et
        le garde-fou passerait au vert sur un package.json qu'il n'a pas lu.
        """
        with self.assertRaises(AssertionError):  # fichier absent
            scripts_de(RACINE / "package.json.absent-de-ce-depot")
        with tempfile.TemporaryDirectory() as tmp:
            for cas, contenu in (
                ("JSON invalide", '{"scripts": '),
                ("bloc «scripts» absent", '{"name": "spa-booking"}'),
                ("bloc «scripts» non-objet", '{"scripts": []}'),
            ):
                with self.subTest(cas=cas):
                    fichier = Path(tmp) / "package.json"
                    fichier.write_text(contenu, encoding="utf-8")
                    with self.assertRaises(AssertionError):
                        scripts_de(fichier)


if __name__ == "__main__":
    unittest.main()
