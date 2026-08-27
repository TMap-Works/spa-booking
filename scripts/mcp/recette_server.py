#!/usr/bin/env python3
"""
Serveur MCP de **recette fonctionnelle** — la sonde qui exerce pour de vrai ce
qu'un ticket vient d'écrire.

## Ce qu'il donne à l'agent, et ce qu'il lui refuse

`npm run verify` prouve que le code compile et que les tests passent. Il ne
prouve pas qu'un endpoint répond quand on l'appelle : un contrôleur oublié dans
les `controllers` de son module compile, passe ses tests unitaires — et rend 404
en vrai. La recette comble exactement cet écart, et rien d'autre.

Le refus est aussi important que le service : ce serveur ne sait pas exercer
« toute l'API ». `perimetre` réduit d'abord le travail aux routes et aux pages
que **ce ticket** a touchées ; hors de cette liste, il n'y a rien à recetter.
Rejouer le système entier à chaque ticket coûterait plus cher que la CI, pour
retrouver ce que la CI a déjà dit.

## Les huit outils

| Outil | Ce qu'il fait |
|---|---|
| `perimetre` | déduit du diff les routes et les pages à recetter — ou dit qu'il n'y a rien à faire |
| `api_demarrer` | lève l'API sur un port libre et attend `/health` |
| `api_jeu_dessai` | crée l'établissement et les comptes sans lesquels aucune route authentifiée ne s'exerce |
| `api_openapi` | liste les routes **réellement servies**, pour confondre un contrôleur non enregistré |
| `api_appel` | envoie une requête et rend statut, durée et corps — jetons masqués |
| `web_demarrer` | sert le front (ou les maquettes) pour que Playwright ait une URL |
| `arreter` | tue ce que ce serveur a démarré |
| `rapport` | le tableau des appels, à coller sur la PR |

## Trois propriétés que le dispositif doit tenir

- **Aucun secret ne sort d'ici.** Les valeurs d'environnement servent à démarrer
  l'API, jamais à être rendues. Tout ce qui repart vers l'agent passe par
  `masquer()` : jetons JWT, mots de passe, valeurs de `.env`.
- **Deux agents d'une même vague ne se gênent pas.** Le port est alloué libre, et
  le jeu d'essai est cloisonné par numéro de ticket.
- **Rien ne survit à la session.** `arreter` est rejoué à la sortie du serveur,
  quoi qu'il arrive.

Le dialogue est du JSON-RPC 2.0 délimité par des sauts de ligne sur stdin/stdout
(transport stdio de MCP). **Rien d'autre que du JSON-RPC ne doit atteindre
stdout** — toute trace de diagnostic part sur stderr.

Doctrine d'usage : `.claude/skills/recette-mcp/SKILL.md`.
"""

from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parents[2]

NOM_SERVEUR = "recette"
VERSION_SERVEUR = "1.0.0"

# Version du protocole annoncée si le client en demande une inconnue. On rend
# toujours **celle du client** quand elle nous est connue : c'est ce que demande
# la spécification MCP, et cela évite qu'une montée de version de Claude Code
# fasse tomber le serveur.
PROTOCOLE_DEFAUT = "2025-06-18"
PROTOCOLES_CONNUS = {"2024-11-05", "2025-03-26", "2025-06-18"}

# Journaux des processus démarrés. Ignoré par git, effaçable sans conséquence.
TRAVAIL = RACINE / ".claude" / ".recette"


# --------------------------------------------------------------------------- #
# Environnement et masquage
# --------------------------------------------------------------------------- #

# Ordre de superposition : l'exemple pose les défauts, `.env` puis `.env.local`
# les remplacent. Le dernier lu gagne.
FICHIERS_ENV = (".env.example", ".env", ".env.local")

# Ce qui, dans un nom de variable, désigne une valeur qu'on ne rend jamais.
CLE_SENSIBLE = re.compile(r"(SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|REDIS_URL)", re.IGNORECASE)

JETON_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}")
CHAMP_SENSIBLE = re.compile(
    r'("(?:password|passwordHash|motDePasse|secret|accessToken|refreshToken|token)"\s*:\s*)"[^"]*"',
    re.IGNORECASE,
)


def charger_env(racine: Path | None = None, environnement=None) -> dict:
    """Les variables des fichiers `.env*`, superposées, puis **l'environnement réel**.

    Lire `.env` ici n'est pas une entorse à la règle « aucun secret dans le
    code » : ces valeurs servent à démarrer un processus local, elles ne
    traversent jamais la frontière du serveur — `masquer()` s'en assure.

    Ce que le processus porte déjà l'emporte sur les fichiers : c'est ce qui
    permet de lancer la recette contre une autre base que celle du
    `docker-compose.yml` — un port 5432 déjà pris par un PostgreSQL natif, par
    exemple, cas rencontré sur la machine de développement du projet.
    """
    base = racine or RACINE
    valeurs = {}
    for nom in FICHIERS_ENV:
        chemin = base / nom
        if not chemin.is_file():
            continue
        for ligne in chemin.read_text(encoding="utf-8", errors="replace").splitlines():
            ligne = ligne.strip()
            if not ligne or ligne.startswith("#") or "=" not in ligne:
                continue
            cle, _, valeur = ligne.partition("=")
            valeurs[cle.strip()] = valeur.strip().strip('"').strip("'")

    reel = os.environ if environnement is None else environnement
    for cle in list(valeurs):
        if reel.get(cle):
            valeurs[cle] = reel[cle]
    return valeurs


def secrets_de(env: dict) -> list:
    """Les valeurs à effacer de toute sortie, déduites du nom de leur variable."""
    return [v for c, v in env.items() if CLE_SENSIBLE.search(c) and len(v) >= 8]


def masquer(texte: str, secrets=None) -> str:
    """Efface d'un texte jetons, mots de passe et secrets connus.

    Passage obligé de **toute** sortie du serveur : un jeton recopié dans le
    transcript d'un ticket y reste, puis finit dans un journal de run et dans un
    commentaire de PR.
    """
    if not texte:
        return texte
    texte = JETON_JWT.sub("<jeton masqué>", texte)
    texte = CHAMP_SENSIBLE.sub(r'\1"<masqué>"', texte)
    for secret in secrets or []:
        if secret and len(secret) >= 8:
            texte = texte.replace(secret, "<masqué>")
    return texte


# --------------------------------------------------------------------------- #
# Réseau
# --------------------------------------------------------------------------- #

def port_disponible(port: int, hote: str = "127.0.0.1") -> bool:
    """Peut-on **écouter** sur ce port ?

    Une tentative de `bind` et non de `connect` : la question posée est celle
    d'un serveur qui va s'y poser. Sonder par connexion donnait un faux « libre »
    dès que la file d'attente du service occupant était pleine — le port était
    alors déclaré disponible, et l'API démarrait pour mourir aussitôt.
    """
    with socket.socket() as sonde:
        try:
            sonde.bind((hote, port))
        except OSError:
            return False
        return True


def port_libre(prefere=None) -> int:
    """Un port réellement libre — `prefere` s'il l'est, sinon un éphémère.

    C'est ce qui permet à trois agents d'une même vague de lever chacun leur API
    sans se disputer le 3001.
    """
    if prefere and port_disponible(int(prefere)):
        return int(prefere)
    with socket.socket() as sonde:
        sonde.bind(("127.0.0.1", 0))
        return int(sonde.getsockname()[1])


def service_joignable(url: str, port_defaut: int):
    """Un `postgresql://…` ou `redis://…` répond-il ? Rend aussi « hôte:port »."""
    try:
        decoupe = urllib.parse.urlparse(url)
        hote = decoupe.hostname or "127.0.0.1"
        port = decoupe.port or port_defaut
    except ValueError:
        return False, url
    with socket.socket() as sonde:
        sonde.settimeout(1.5)
        return sonde.connect_ex((hote, port)) == 0, "%s:%s" % (hote, port)


def http(methode: str, url: str, corps=None, entetes=None, delai: float = 20.0) -> dict:
    """Une requête HTTP rendue sous une forme uniforme — jamais d'exception."""
    entetes = dict(entetes or {})
    donnees = None
    if corps is not None:
        if isinstance(corps, (dict, list)):
            donnees = json.dumps(corps, ensure_ascii=False).encode("utf-8")
            entetes.setdefault("Content-Type", "application/json")
        elif isinstance(corps, str):
            donnees = corps.encode("utf-8")
        else:
            donnees = corps

    requete = urllib.request.Request(url, data=donnees, method=methode.upper(), headers=entetes)
    debut = time.monotonic()
    try:
        with urllib.request.urlopen(requete, timeout=delai) as reponse:
            brut = reponse.read().decode("utf-8", "replace")
            entetes_recus = dict(reponse.headers)
            statut = reponse.status
    except urllib.error.HTTPError as erreur:
        brut = erreur.read().decode("utf-8", "replace")
        entetes_recus = dict(erreur.headers or {})
        statut = erreur.code
    except Exception as erreur:  # URLError, timeout, OSError — tous équivalents ici
        return {
            "statut": None,
            "erreur": str(getattr(erreur, "reason", erreur)),
            "duree_ms": round((time.monotonic() - debut) * 1000),
        }
    return {
        "statut": statut,
        "entetes": entetes_recus,
        "corps": brut,
        "duree_ms": round((time.monotonic() - debut) * 1000),
    }


def attendre_http(url: str, delai: float, intervalle: float = 0.7):
    """Sonde `url` jusqu'à une réponse HTTP, ou `None` au bout de `delai` secondes."""
    limite = time.monotonic() + delai
    while time.monotonic() < limite:
        reponse = http("GET", url, delai=4)
        if reponse.get("statut"):
            return reponse
        time.sleep(intervalle)
    return None


# --------------------------------------------------------------------------- #
# Périmètre — ce que le ticket a réellement touché
# --------------------------------------------------------------------------- #

# `@Controller('services')` et `@Controller({ path: 'services', version: '1' })`
# cohabitent dans Nest. Le dépôt n'emploie que la seconde forme, mais la
# première reste légale et coûte trois caractères de motif.
DEC_CONTROLEUR = re.compile(
    r"@Controller\(\s*(?:'([^']*)'|\"([^\"]*)\"|\{(.*?)\})\s*\)", re.S
)
DEC_METHODE = re.compile(r"@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|\"([^\"]*)\")?\s*\)")
DEC_AUTH = re.compile(r"@Auth\(\s*([^)]*)\)")
DEC_AUTH_MIN = re.compile(r"@AuthAtLeast\(\s*['\"]([A-Z]+)['\"]\s*\)")
DEC_CODE = re.compile(r"@HttpCode\(\s*HttpStatus\.([A-Z_]+)\s*\)")
DEC_VERSION = re.compile(r"@Version\(\s*['\"]([^'\"]+)['\"]\s*\)")

CODES_HTTP = {
    "OK": 200,
    "CREATED": 201,
    "ACCEPTED": 202,
    "NO_CONTENT": 204,
}

STATUT_PAR_DEFAUT = {"GET": 200, "POST": 201, "PUT": 200, "PATCH": 200, "DELETE": 200}

# `configureApp` exclut `health` du préfixe global. La liste est courte et vit
# dans `apps/api/src/bootstrap.ts` — la répéter ici est un doublon assumé : la
# lire depuis TypeScript demanderait un analyseur, et un chemin faux se voit au
# premier appel de recette.
EXCLUSIONS_PREFIXE = {"health"}

ROLES = ("CLIENT", "STAFF", "MANAGER", "ADMIN")


def classer_chemin(chemin: str) -> str:
    """La nature d'un fichier modifié, du point de vue de la recette."""
    p = chemin.replace("\\", "/")
    if "/__tests__/" in p or p.startswith("apps/api/test/") or p.startswith("apps/web/tests/"):
        return "test"
    if p.startswith("apps/api/prisma/"):
        return "migration"
    if p.startswith("apps/api/src/") and p.endswith(".controller.ts"):
        return "api:controleur"
    if p.startswith("apps/api/src/"):
        return "api:code"
    if p.startswith("apps/web/mockups/") and p.endswith(".html"):
        return "web:maquette"
    if re.search(r"^apps/web/(?:src/)?app/.*(?:page|layout|template|error|loading)\.[jt]sx?$", p):
        return "web:page"
    if p.startswith("apps/web/") and re.search(r"\.[jt]sx$", p):
        return "web:composant"
    if p.startswith("apps/web/styles/"):
        return "web:style"
    if p.startswith("packages/"):
        return "contrats"
    if p.startswith("infra/"):
        return "infra"
    if p.startswith("scripts/") or p.startswith(".claude/"):
        return "outillage"
    if p.startswith("docs/"):
        return "docs"
    if p.startswith(".github/"):
        return "ci"
    return "autre"


def _meta_controleur(source: str) -> dict:
    """Le `path` et la `version` déclarés par `@Controller`."""
    trouve = DEC_CONTROLEUR.search(source)
    if not trouve:
        return {}
    simple = trouve.group(1) or trouve.group(2)
    if simple is not None:
        return {"path": simple, "version": "1"}
    corps = trouve.group(3) or ""
    chemin = re.search(r"path\s*:\s*['\"]([^'\"]*)['\"]", corps)
    version = re.search(r"version\s*:\s*(?:['\"]([^'\"]+)['\"]|(VERSION_NEUTRAL))", corps)
    return {
        "path": chemin.group(1) if chemin else "",
        "version": "NEUTRAL" if (version and version.group(2)) else (version.group(1) if version else "1"),
    }


MOTS_TRAVERSES = {
    "public", "private", "protected", "async", "static", "readonly",
    "abstract", "override", "export", "class", "declare", "default",
}


def _fin_chaine(source: str, i: int) -> int:
    """L'indice qui suit la chaîne ouverte en `i` — échappements compris."""
    delimiteur = source[i]
    i += 1
    n = len(source)
    while i < n:
        if source[i] == "\\":
            i += 2
            continue
        if source[i] == delimiteur:
            return i + 1
        i += 1
    return n


def _fin_parenthese(source: str, i: int) -> int:
    """L'indice qui suit la parenthèse fermante appariée à celle ouverte en `i`."""
    profondeur = 0
    n = len(source)
    while i < n:
        caractere = source[i]
        if caractere in "\"'`":
            i = _fin_chaine(source, i)
            continue
        if caractere == "(":
            profondeur += 1
        elif caractere == ")":
            profondeur -= 1
            if profondeur == 0:
                return i + 1
        i += 1
    return n


def decorateurs_empiles(source: str):
    """Découpe un fichier TypeScript en (décorateurs, ce qu'ils décorent, position).

    Un scanner plutôt qu'un motif ligne à ligne, pour deux raisons vérifiées sur
    ce dépôt : les décorateurs de Nest s'étalent sur plusieurs lignes
    (`@ApiOperation({ summary: …, description: … })`), et les commentaires de
    `public-services.controller.ts` **citent** « Aucun `@Auth()` » — une lecture
    naïve y verrait une garde et déclarerait authentifiée une route ouverte.
    Ici, commentaires et chaînes sont traversés sans être lus.
    """
    membres = []
    courant = []
    debut_pile = None
    i = 0
    n = len(source)
    while i < n:
        caractere = source[i]
        if caractere == "/" and i + 1 < n and source[i + 1] == "/":
            saut = source.find("\n", i)
            i = n if saut == -1 else saut + 1
            continue
        if caractere == "/" and i + 1 < n and source[i + 1] == "*":
            saut = source.find("*/", i)
            i = n if saut == -1 else saut + 2
            continue
        if caractere in "\"'`":
            i = _fin_chaine(source, i)
            continue
        if caractere == "@":
            debut = i
            i += 1
            while i < n and (source[i].isalnum() or source[i] == "_"):
                i += 1
            suivant = i
            while suivant < n and source[suivant] in " \t\r\n":
                suivant += 1
            if suivant < n and source[suivant] == "(":
                i = _fin_parenthese(source, suivant)
            if not courant:
                debut_pile = debut
            courant.append(source[debut:i])
            continue
        if courant and (caractere.isalpha() or caractere == "_"):
            debut = i
            while i < n and (source[i].isalnum() or source[i] == "_"):
                i += 1
            mot = source[debut:i]
            if mot in MOTS_TRAVERSES:
                continue
            membres.append(("\n".join(courant), mot, debut_pile or debut))
            courant = []
            debut_pile = None
            continue
        i += 1
    return membres


def _roles_exiges(bloc: str):
    """Les rôles qu'un bloc de décorateurs impose, ou `None` si la route est ouverte."""
    minimum = DEC_AUTH_MIN.search(bloc)
    if minimum:
        seuil = minimum.group(1)
        if seuil in ROLES:
            return list(ROLES[ROLES.index(seuil):])
        return [seuil]
    exact = DEC_AUTH.search(bloc)
    if exact:
        cites = re.findall(r"['\"]([A-Z]+)['\"]", exact.group(1))
        return cites or list(ROLES)
    return None


def construire_chemin(base: str, version: str, suffixe: str) -> str:
    """Le chemin servi : préfixe `api`, version d'URI, chemin de classe, chemin de méthode."""
    parties = []
    if base not in EXCLUSIONS_PREFIXE:
        parties.append("api")
        if version and version != "NEUTRAL":
            parties.append("v%s" % version)
    parties.extend(x for x in (base, suffixe) if x)
    segments = [p.strip("/") for p in parties if p and p.strip("/")]
    return "/" + "/".join(segments)


def extraire_routes(source: str, fichier: str):
    """Les routes qu'un fichier de contrôleur déclare — méthode, chemin, rôles, statut attendu."""
    membres = decorateurs_empiles(source)
    classe = next((bloc for bloc, _, _ in membres if "@Controller" in bloc), None)
    if classe is None:
        return []
    meta = _meta_controleur(classe)
    roles_classe = _roles_exiges(classe)

    routes = []
    for bloc, nom, position in membres:
        if bloc is classe:
            continue
        trouve = DEC_METHODE.search(bloc)
        if not trouve:
            continue
        verbe = trouve.group(1).upper()
        suffixe = trouve.group(2) or trouve.group(3) or ""

        version = meta.get("version", "1")
        version_locale = DEC_VERSION.search(bloc)
        if version_locale:
            version = version_locale.group(1)

        code = DEC_CODE.search(bloc)
        statut = CODES_HTTP.get(code.group(1)) if code else None
        if statut is None:
            statut = STATUT_PAR_DEFAUT.get(verbe, 200)

        routes.append(
            {
                "methode": verbe,
                "chemin": construire_chemin(meta.get("path", ""), version, suffixe),
                "auth": _roles_exiges(bloc) or roles_classe,
                "statut_attendu": statut,
                "fichier": fichier,
                "ligne": source.count("\n", 0, position) + 1,
                "handler": nom,
            }
        )
    return routes


def route_web(chemin: str) -> str:
    """L'URL que sert un fichier de l'App Router — groupes de routes ôtés."""
    p = chemin.replace("\\", "/")
    p = re.sub(r"^apps/web/(?:src/)?app/", "", p)
    p = re.sub(r"/?(?:page|layout|template|error|loading)\.[jt]sx?$", "", p)
    segments = [s for s in p.split("/") if s and not (s.startswith("(") and s.endswith(")"))]
    return "/" + "/".join(segments)


def _git(args, racine: Path):
    try:
        sortie = subprocess.run(
            ["git"] + args,
            cwd=str(racine),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if sortie.returncode != 0:
        return []
    return [l.strip() for l in sortie.stdout.splitlines() if l.strip()]


def fichiers_modifies(base: str, racine: Path):
    """Les fichiers que le ticket a touchés : commits de la branche **et** arbre de travail.

    Les deux, parce que la recette a lieu en phase 4bis : une partie du travail
    est déjà commitée (phase 3), le reste ne l'est pas encore (phase 6).
    """
    chemins = set(_git(["diff", "--name-only", "%s...HEAD" % base], racine))
    # `-uall` et non le défaut : sans lui, git rend « scripts/mcp/ » — le dossier
    # entier pour un seul fichier neuf — et le classement porterait sur un chemin
    # qui n'existe pas.
    for ligne in _git(["status", "--porcelain", "-uall"], racine):
        chemin = ligne[3:].strip() if len(ligne) > 3 else ""
        if " -> " in chemin:  # renommage
            chemin = chemin.split(" -> ", 1)[1]
        if chemin:
            chemins.add(chemin.strip('"'))
    return sorted(c.replace("\\", "/") for c in chemins if c)


def _symbole(nom_fichier: str) -> str:
    """« services.service » → « ServicesService » — la classe qu'un fichier exporte."""
    morceaux = re.split(r"[.\-_]", nom_fichier)
    return "".join(m[:1].upper() + m[1:] for m in morceaux if m)


def _controleurs_du_module(chemin: str, racine: Path):
    """Les contrôleurs par lesquels un fichier de module s'exerce.

    Un service ou un dépôt n'a pas d'URL : il se recette par la route qui
    l'appelle. On remonte donc jusqu'au dossier du module, et on ne retient que
    les contrôleurs qui **citent** le fichier modifié — sinon toucher un service
    du catalogue mettrait les douze routes du module au programme, quand deux
    suffisent.
    """
    limite = (racine / "apps" / "api" / "src").resolve()
    dossier = (racine / chemin).parent.resolve()
    candidats = []
    while True:
        candidats = sorted(dossier.glob("*.controller.ts"))
        if candidats or dossier == limite or limite not in dossier.parents:
            break
        dossier = dossier.parent
    if not candidats:
        return []

    racine_nom = Path(chemin).name[:-3] if chemin.endswith(".ts") else Path(chemin).stem
    symbole = _symbole(racine_nom)
    retenus = []
    for fichier in candidats:
        try:
            contenu = fichier.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if ("/%s'" % racine_nom) in contenu or ("./%s'" % racine_nom) in contenu or symbole in contenu:
            retenus.append(fichier)

    return [str(f.relative_to(racine)).replace("\\", "/") for f in (retenus or candidats)]


def _pages_utilisant(composant: str, racine: Path):
    """Les pages de l'App Router qui importent ce composant, par son nom de fichier."""
    nom = Path(composant).stem
    racine_app = racine / "apps" / "web"
    if not racine_app.is_dir():
        return []
    pages = []
    for fichier in racine_app.rglob("page.[jt]sx"):
        if "node_modules" in fichier.parts:
            continue
        try:
            contenu = fichier.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if re.search(r"\b%s\b" % re.escape(nom), contenu):
            pages.append(route_web(str(fichier.relative_to(racine)).replace("\\", "/")))
    return sorted(set(pages))


def calculer_perimetre(base: str = "origin/develop", racine: Path | None = None, fichiers=None) -> dict:
    """Ce qu'il y a à recetter, et rien de plus.

    `fichiers` n'est fourni que par les tests : en usage réel, la liste vient du
    diff. Le verdict `saut` est motivé — un agent qui saute la recette doit
    pouvoir écrire **pourquoi** dans son journal.
    """
    racine = racine or RACINE
    chemins = list(fichiers) if fichiers is not None else fichiers_modifies(base, racine)

    par_nature = {}
    for chemin in chemins:
        par_nature.setdefault(classer_chemin(chemin), []).append(chemin)

    controleurs = list(par_nature.get("api:controleur", []))
    for chemin in par_nature.get("api:code", []):
        for voisin in _controleurs_du_module(chemin, racine):
            if voisin not in controleurs:
                controleurs.append(voisin)

    routes = []
    for chemin in sorted(controleurs):
        fichier = racine / chemin
        if not fichier.is_file():
            continue
        routes.extend(extraire_routes(fichier.read_text(encoding="utf-8", errors="replace"), chemin))

    cibles = []
    for chemin in par_nature.get("web:page", []):
        cibles.append({"url": route_web(chemin), "fichier": chemin, "nature": "page"})
    for chemin in par_nature.get("web:composant", []):
        pages = _pages_utilisant(chemin, racine)
        cibles.append(
            {
                "url": pages[0] if pages else None,
                "pages": pages,
                "fichier": chemin,
                "nature": "composant",
            }
        )
    for chemin in par_nature.get("web:maquette", []):
        cibles.append(
            {
                "url": "/" + chemin.replace("\\", "/").split("apps/web/", 1)[-1],
                "fichier": chemin,
                "nature": "maquette",
            }
        )

    saut = not routes and not cibles
    if saut:
        natures = sorted(par_nature) or ["aucun fichier modifié"]
        raison = (
            "aucune route ni page touchée — le diff ne porte que sur : %s"
            % ", ".join(natures)
        )
    else:
        raison = "%d route(s) et %d cible(s) web à recetter" % (len(routes), len(cibles))

    return {
        "base": base,
        "fichiers": {nature: sorted(liste) for nature, liste in sorted(par_nature.items())},
        "api": {"routes": routes},
        "web": {"cibles": cibles},
        "saut": saut,
        "raison": raison,
        "rappel": (
            "Ne recetter que ce qui figure ci-dessus. Une route absente de cette liste "
            "est couverte par la CI, pas par ce ticket."
        ),
    }


# --------------------------------------------------------------------------- #
# Processus — API et front
# --------------------------------------------------------------------------- #

ETAT = {
    "api": None,       # {"proc", "port", "base", "journal", "externe"}
    "web": None,
    "jetons": {},      # alias -> jeton d'accès
    "jeu": None,       # dernière sortie de api_jeu_dessai
    "appels": [],      # journal des appels, pour `rapport`
}


def _executable(nom: str) -> str:
    """Le chemin d'un exécutable — `npm.cmd` plutôt que `npm` sous Windows."""
    trouve = shutil.which(nom)
    if not trouve:
        raise RuntimeError("« %s » est introuvable dans le PATH." % nom)
    return trouve


def _demarrer(commande, cwd: Path, env: dict, journal: Path):
    """Lance un processus détaché, sa sortie dans un fichier."""
    TRAVAIL.mkdir(parents=True, exist_ok=True)
    flux = open(journal, "w", encoding="utf-8", errors="replace")
    options = {}
    if sys.platform == "win32":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    processus = subprocess.Popen(
        commande,
        cwd=str(cwd),
        env=env,
        stdout=flux,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        **options,
    )
    return processus, flux


def _tuer(processus) -> None:
    """Tue le processus **et sa descendance** — `npm run dev` en a toujours une."""
    if processus is None or processus.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(processus.pid)],
                capture_output=True,
                timeout=20,
            )
        else:
            os.killpg(os.getpgid(processus.pid), 15)
    except (OSError, subprocess.SubprocessError):
        try:
            processus.kill()
        except OSError:
            pass
    try:
        processus.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def _fin_de_journal(chemin: Path, lignes: int = 30, secrets=None) -> str:
    if not chemin.is_file():
        return ""
    contenu = chemin.read_text(encoding="utf-8", errors="replace").splitlines()
    return masquer("\n".join(contenu[-lignes:]), secrets)


def _arreter(cle: str) -> bool:
    """Arrête **un seul** service — son processus, puis son fichier de journal.

    Un service à la fois, et non les deux : redémarrer l'API ne doit pas
    emporter le front que Playwright est en train de piloter.
    """
    service = ETAT.get(cle)
    if not service:
        return False
    _tuer(service.get("proc"))
    flux = service.get("flux")
    if flux:
        try:
            flux.close()
        except OSError:
            pass
    ETAT[cle] = None
    return True


def _arreter_tout():
    for cle in ("api", "web"):
        _arreter(cle)


atexit.register(_arreter_tout)


def _horodatage_dist():
    """Date de la compilation servie, ou `None` si `dist/` est absent."""
    dist = RACINE / "apps" / "api" / "dist" / "main.js"
    return dist.stat().st_mtime if dist.is_file() else None


def _dist_perimee() -> bool:
    """La compilation est-elle en retard sur les sources ?

    Recetter un `dist/` périmé est pire que ne pas recetter : le verdict porte
    sur du code que le ticket a déjà remplacé.
    """
    reference = _horodatage_dist()
    if reference is None:
        return True
    src = RACINE / "apps" / "api" / "src"
    for fichier in src.rglob("*.ts"):
        if fichier.stat().st_mtime > reference:
            return True
    return False


def outil_api_demarrer(args: dict) -> dict:
    port_demande = args.get("port")
    attente = float(args.get("attente", 90))
    construire = args.get("construire", True)

    env_fichiers = charger_env()
    secrets = secrets_de(env_fichiers)

    if ETAT.get("api"):
        base = ETAT["api"]["base"]
        # Réutiliser un processus lancé **avant** une recompilation ferait porter
        # la recette sur le code que le ticket vient justement de remplacer : la
        # panne exacte que `_dist_perimee` existe pour éviter.
        rejoue = _horodatage_dist() != ETAT["api"].get("dist") or _dist_perimee()
        sante = http("GET", base + "/health", delai=5) if not rejoue else {}
        if sante.get("statut"):
            return {"base_url": base, "port": ETAT["api"]["port"], "reutilise": True, "sante": sante.get("statut")}
        _arreter("api")

    # Les dépendances locales d'abord : une API qui démarre sans base rend 500
    # sur tout, et le diagnostic coûte dix minutes à qui lit le journal.
    for nom, url, port_defaut in (
        ("PostgreSQL", env_fichiers.get("DATABASE_URL", ""), 5432),
        ("Redis", env_fichiers.get("REDIS_URL", ""), 6379),
    ):
        joignable, adresse = service_joignable(url, port_defaut)
        if not joignable:
            return {
                "erreur": "%s injoignable sur %s — lancer « docker compose up -d »." % (nom, adresse),
                "remede": "docker compose up -d",
            }

    construction = None
    if _dist_perimee():
        if not construire:
            return {"erreur": "apps/api/dist est absent ou périmé — relancer « npm run build » ou passer construire=true."}
        sortie = subprocess.run(
            [_executable("npm"), "run", "build", "-w", "@spa/api"],
            cwd=str(RACINE),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
        construction = "ok" if sortie.returncode == 0 else "échec"
        if sortie.returncode != 0:
            return {
                "erreur": "la compilation de l'API a échoué",
                "sortie": masquer((sortie.stdout or "")[-2000:] + (sortie.stderr or "")[-2000:], secrets),
            }

    port = port_libre(port_demande)
    env = os.environ.copy()
    env.update(env_fichiers)
    env["PORT"] = str(port)
    env["NODE_ENV"] = "development"
    env["API_URL"] = "http://127.0.0.1:%d" % port

    journal = TRAVAIL / ("api-%d.log" % port)
    processus, flux = _demarrer(
        [_executable("node"), "dist/main.js"],
        RACINE / "apps" / "api",
        env,
        journal,
    )

    base = "http://127.0.0.1:%d" % port
    sante = attendre_http(base + "/health", attente)
    if not sante or sante.get("statut") != 200:
        detail = _fin_de_journal(journal, 30, secrets)
        _tuer(processus)
        flux.close()
        if not sante:
            motif = "l'API n'a pas répondu sur %s/health en %ds" % (base, int(attente))
        else:
            # Un /health qui répond 503 nomme lui-même la dépendance tombée : le
            # rendre tel quel évite de faire chercher dans le journal ce que le
            # corps de la réponse dit déjà.
            motif = "%s/health a rendu %s : %s" % (
                base,
                sante.get("statut"),
                masquer((sante.get("corps") or "")[:600], secrets),
            )
        resultat = {"erreur": motif, "journal": detail}
        if sante and '"database":{"status":"down"' in (sante.get("corps") or "").replace(" ", ""):
            # Le port répond mais l'authentification échoue : sur une machine de
            # développement, c'est presque toujours un **autre** serveur qui
            # occupe le port du conteneur.
            resultat["piste"] = (
                "le port de la base répond mais refuse les identifiants — vérifier qu'aucun "
                "PostgreSQL natif n'occupe le port du conteneur (« netstat -ano | findstr 5432 » "
                "sous Windows), et au besoin poser DATABASE_URL dans .env.local sur un autre port."
            )
        return resultat

    ETAT["api"] = {"proc": processus, "flux": flux, "port": port, "base": base,
                   "journal": str(journal), "dist": _horodatage_dist()}
    return {
        "base_url": base,
        "port": port,
        "pid": processus.pid,
        "sante": json.loads(sante.get("corps") or "{}") if sante.get("corps", "").startswith("{") else sante.get("statut"),
        "compilation": construction or "à jour",
        "journal": str(journal),
    }


def outil_api_jeu_dessai(args: dict) -> dict:
    """Établissement, comptes des quatre rôles, établissement voisin — via Prisma."""
    ticket = str(args.get("ticket") or "0")
    env_fichiers = charger_env()
    secrets = secrets_de(env_fichiers)

    joignable, adresse = service_joignable(env_fichiers.get("DATABASE_URL", ""), 5432)
    if not joignable:
        return {"erreur": "PostgreSQL injoignable sur %s — « docker compose up -d »." % adresse}

    env = os.environ.copy()
    env.update(env_fichiers)

    sortie = subprocess.run(
        [_executable("node"), str(RACINE / "scripts" / "mcp" / "recette_fixture.mjs"), "--ticket", ticket],
        cwd=str(RACINE),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    if sortie.returncode != 0:
        return {
            "erreur": "le jeu d'essai a échoué",
            "sortie": masquer(((sortie.stdout or "") + (sortie.stderr or ""))[-2000:], secrets),
        }
    try:
        jeu = json.loads((sortie.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"erreur": "sortie du jeu d'essai illisible", "sortie": masquer((sortie.stdout or "")[-1000:], secrets)}

    ETAT["jeu"] = jeu
    return jeu


def outil_api_openapi(args: dict) -> dict:
    """Les routes **réellement servies**, telles que Nest les a enregistrées."""
    base = args.get("base") or (ETAT["api"]["base"] if ETAT.get("api") else None)
    if not base:
        return {"erreur": "aucune API démarrée — appeler api_demarrer d'abord."}
    filtre = (args.get("filtre") or "").lower()

    reponse = http("GET", base + "/api/docs-json", delai=30)
    if reponse.get("statut") != 200:
        return {"erreur": "OpenAPI indisponible sur %s/api/docs-json" % base, "statut": reponse.get("statut")}
    try:
        document = json.loads(reponse["corps"])
    except ValueError:
        return {"erreur": "document OpenAPI illisible"}

    routes = []
    for chemin, operations in sorted((document.get("paths") or {}).items()):
        for verbe in sorted(operations):
            if verbe.upper() not in STATUT_PAR_DEFAUT:
                continue
            if filtre and filtre not in chemin.lower():
                continue
            routes.append({"methode": verbe.upper(), "chemin": chemin})
    return {"total": len(routes), "routes": routes}


def _extraire_jeton(corps: str):
    try:
        charge = json.loads(corps)
    except (ValueError, TypeError):
        return None
    if not isinstance(charge, dict):
        return None
    for cle in ("accessToken", "access_token", "token"):
        valeur = charge.get(cle)
        if isinstance(valeur, str) and valeur:
            return valeur
    return None


def outil_api_appel(args: dict) -> dict:
    base = args.get("base") or (ETAT["api"]["base"] if ETAT.get("api") else None)
    if not base:
        return {"erreur": "aucune API démarrée — appeler api_demarrer d'abord."}

    methode = str(args.get("methode", "GET")).upper()
    chemin = str(args.get("chemin", "/"))
    if chemin.startswith("http://") or chemin.startswith("https://"):
        url = chemin
    elif chemin.startswith("/"):
        url = base + chemin
    else:
        url = base + "/api/v1/" + chemin.lstrip("/")

    entetes = dict(args.get("entetes") or {})
    alias = args.get("jeton")
    if alias:
        jeton = ETAT["jetons"].get(alias)
        if not jeton:
            return {
                "erreur": "aucun jeton enregistré sous « %s » — se connecter avec enregistrer_jeton d'abord." % alias,
                "jetons_connus": sorted(ETAT["jetons"]),
            }
        entetes["Authorization"] = "Bearer " + jeton

    secrets = secrets_de(charger_env())
    reponse = http(methode, url, corps=args.get("corps"), entetes=entetes, delai=float(args.get("delai", 25)))

    if reponse.get("statut") is None:
        resultat = {"requete": {"methode": methode, "url": url}, "erreur": reponse.get("erreur"), "duree_ms": reponse.get("duree_ms")}
        ETAT["appels"].append({"methode": methode, "url": url, "statut": None, "duree_ms": reponse.get("duree_ms"), "conforme": False})
        return resultat

    corps_brut = reponse.get("corps") or ""
    enregistre = None
    if args.get("enregistrer_jeton"):
        jeton = _extraire_jeton(corps_brut)
        if jeton:
            ETAT["jetons"][str(args["enregistrer_jeton"])] = jeton
            enregistre = str(args["enregistrer_jeton"])

    attendu = args.get("attendu")
    conforme = None
    if attendu is not None:
        attendus = attendu if isinstance(attendu, list) else [attendu]
        conforme = reponse["statut"] in [int(a) for a in attendus]

    utiles = {
        cle: valeur
        for cle, valeur in (reponse.get("entetes") or {}).items()
        if cle.lower() in ("content-type", "location", "cache-control", "x-request-id")
    }
    if any(c.lower() == "set-cookie" for c in (reponse.get("entetes") or {})):
        utiles["set-cookie"] = "<présent, masqué>"

    corps_visible = masquer(corps_brut[:4000], secrets)
    if len(corps_brut) > 4000:
        corps_visible += "\n… (%d caractères tronqués)" % (len(corps_brut) - 4000)

    ETAT["appels"].append(
        {
            "methode": methode,
            "url": url,
            "statut": reponse["statut"],
            "duree_ms": reponse["duree_ms"],
            "conforme": conforme,
        }
    )

    return {
        "requete": {"methode": methode, "url": url, "authentifie": bool(alias)},
        "statut": reponse["statut"],
        "duree_ms": reponse["duree_ms"],
        "attendu": attendu,
        "conforme": conforme,
        "entetes": utiles,
        "corps": corps_visible,
        "jeton_enregistre": enregistre,
    }


def outil_web_demarrer(args: dict) -> dict:
    """Sert le front — l'application Next si elle existe, les maquettes sinon."""
    if ETAT.get("web"):
        base = ETAT["web"]["base"]
        if http("GET", base + "/", delai=5).get("statut"):
            return {"base_url": base, "port": ETAT["web"]["port"], "reutilise": True, "mode": ETAT["web"]["mode"]}
        _arreter("web")

    port = port_libre(args.get("port"))
    attente = float(args.get("attente", 120))
    paquet = RACINE / "apps" / "web" / "package.json"
    scripts = {}
    if paquet.is_file():
        try:
            scripts = (json.loads(paquet.read_text(encoding="utf-8")) or {}).get("scripts", {})
        except ValueError:
            scripts = {}

    env_fichiers = charger_env()
    secrets = secrets_de(env_fichiers)
    env = os.environ.copy()
    env.update(env_fichiers)
    env["PORT"] = str(port)

    journal = TRAVAIL / ("web-%d.log" % port)
    if "dev" in scripts:
        mode = "next"
        commande = [_executable("npm"), "run", "dev", "-w", "@spa/web"]
        cwd = RACINE
    else:
        # Le front n'existe pas encore en Next : les maquettes HTML sont la seule
        # surface cliquable, et elles se recettent exactement de la même façon.
        mode = "statique"
        commande = [sys.executable, "-m", "http.server", str(port), "--directory", str(RACINE / "apps" / "web")]
        cwd = RACINE

    processus, flux = _demarrer(commande, cwd, env, journal)
    base = "http://127.0.0.1:%d" % port
    reponse = attendre_http(base + "/", attente)
    if not reponse:
        detail = _fin_de_journal(journal, 30, secrets)
        _tuer(processus)
        flux.close()
        return {"erreur": "le front n'a pas répondu sur %s en %ds" % (base, int(attente)), "journal": detail}

    ETAT["web"] = {"proc": processus, "flux": flux, "port": port, "base": base, "mode": mode}
    resultat = {"base_url": base, "port": port, "pid": processus.pid, "mode": mode, "journal": str(journal)}
    if mode == "statique":
        resultat["maquettes"] = base + "/mockups/admin/index.html"
        resultat["note"] = "apps/web n'a pas de script « dev » : les maquettes statiques sont servies telles quelles."
    return resultat


def outil_arreter(args: dict) -> dict:
    quoi = args.get("quoi", "tout")
    arretes = []
    for cle in ("api", "web"):
        if quoi in ("tout", cle) and ETAT.get(cle):
            port = ETAT[cle].get("port")
            _arreter(cle)
            arretes.append("%s (port %s)" % (cle, port))
    return {"arretes": arretes or ["rien à arrêter"]}


def outil_rapport(args: dict) -> dict:
    """Le tableau des appels — ce qui se colle tel quel sur la PR."""
    appels = ETAT["appels"]
    if not appels:
        return {"markdown": "_Aucun appel de recette enregistré._", "total": 0, "echecs": 0}

    lignes = ["| Appel | Statut | Verdict | Durée |", "|---|---|---|---|"]
    echecs = 0
    for appel in appels:
        conforme = appel.get("conforme")
        if conforme is False:
            echecs += 1
        marque = {True: "✔", False: "✖", None: "·"}[conforme]
        chemin = urllib.parse.urlparse(appel["url"]).path or appel["url"]
        lignes.append(
            "| `%s %s` | %s | %s | %s ms |"
            % (appel["methode"], chemin, appel["statut"] if appel["statut"] else "—", marque, appel["duree_ms"])
        )
    return {
        "markdown": "\n".join(lignes),
        "total": len(appels),
        "echecs": echecs,
        "verdict": "rouge" if echecs else "vert",
    }


def outil_perimetre(args: dict) -> dict:
    return calculer_perimetre(base=args.get("base", "origin/develop"))


# --------------------------------------------------------------------------- #
# Déclaration MCP
# --------------------------------------------------------------------------- #

OUTILS = [
    {
        "name": "perimetre",
        "description": (
            "Ce que ce ticket a réellement touché, et donc tout ce qu'il y a à recetter : "
            "routes API (méthode, chemin servi, rôle exigé, statut attendu) et pages web. "
            "Rend « saut: true » avec sa raison quand le diff ne touche ni API ni UI — "
            "dans ce cas la phase de recette se journalise « skipped » et s'arrête là. "
            "À appeler EN PREMIER, avant tout démarrage."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "base": {
                    "type": "string",
                    "description": "Référence de comparaison. Par défaut « origin/develop ».",
                }
            },
        },
        "fonction": outil_perimetre,
    },
    {
        "name": "api_demarrer",
        "description": (
            "Lève l'API NestJS sur un port libre et attend que /health réponde. Compile "
            "d'abord si dist/ est absent ou périmé — recetter du code déjà remplacé ne "
            "prouve rien. Réutilise l'instance déjà démarrée. Exige Postgres et Redis "
            "(« docker compose up -d »)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "port": {"type": "integer", "description": "Port souhaité ; un port libre est choisi s'il est pris."},
                "attente": {"type": "number", "description": "Secondes d'attente de /health (90 par défaut)."},
                "construire": {"type": "boolean", "description": "Compiler si dist/ est périmé (vrai par défaut)."},
            },
        },
        "fonction": outil_api_demarrer,
    },
    {
        "name": "api_jeu_dessai",
        "description": (
            "Crée en base l'établissement de recette, ses comptes CLIENT/STAFF/MANAGER/ADMIN "
            "et un établissement voisin pour la sonde d'isolation. Idempotent, cloisonné par "
            "numéro de ticket. Sans lui, aucune route authentifiée ne peut être exercée."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticket": {"type": "string", "description": "Numéro d'issue — cloisonne le jeu d'essai."}
            },
            "required": ["ticket"],
        },
        "fonction": outil_api_jeu_dessai,
    },
    {
        "name": "api_openapi",
        "description": (
            "Les routes réellement enregistrées par Nest, lues sur /api/docs-json. "
            "C'est ce qui confond un contrôleur absent des « controllers » de son module : "
            "il compile, ses tests passent, et il n'est servi nulle part."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "filtre": {"type": "string", "description": "Ne garder que les chemins contenant ce fragment."},
                "base": {"type": "string", "description": "URL de base ; celle de api_demarrer par défaut."},
            },
        },
        "fonction": outil_api_openapi,
    },
    {
        "name": "api_appel",
        "description": (
            "Envoie une requête HTTP à l'API et rend statut, durée et corps — jetons, mots de "
            "passe et secrets masqués. « enregistrer_jeton » retient le jeton d'une réponse de "
            "connexion sous un alias ; « jeton » le rejoue en Authorization. « attendu » compare "
            "le statut obtenu et pose le verdict du rapport."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "methode": {"type": "string", "description": "GET, POST, PATCH, PUT, DELETE."},
                "chemin": {
                    "type": "string",
                    "description": "« /api/v1/services », « services » (préfixé automatiquement) ou une URL complète.",
                },
                "corps": {"type": "object", "description": "Corps JSON de la requête."},
                "entetes": {"type": "object", "description": "En-têtes supplémentaires."},
                "jeton": {"type": "string", "description": "Alias d'un jeton déjà enregistré."},
                "enregistrer_jeton": {"type": "string", "description": "Alias sous lequel retenir le jeton de la réponse."},
                "attendu": {"description": "Statut attendu, ou liste de statuts acceptables."},
                "delai": {"type": "number", "description": "Délai d'attente en secondes (25 par défaut)."},
                "base": {"type": "string", "description": "URL de base ; celle de api_demarrer par défaut."},
            },
            "required": ["methode", "chemin"],
        },
        "fonction": outil_api_appel,
    },
    {
        "name": "web_demarrer",
        "description": (
            "Sert le front sur un port libre et rend l'URL de base à donner à Playwright. "
            "Lance « npm run dev » si apps/web en a un, sert les maquettes statiques sinon."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "port": {"type": "integer", "description": "Port souhaité ; un port libre est choisi s'il est pris."},
                "attente": {"type": "number", "description": "Secondes d'attente (120 par défaut)."},
            },
        },
        "fonction": outil_web_demarrer,
    },
    {
        "name": "arreter",
        "description": "Tue ce que ce serveur a démarré. À appeler en fin de recette, avant la phase de revue.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "quoi": {"type": "string", "enum": ["tout", "api", "web"], "description": "Par défaut « tout »."}
            },
        },
        "fonction": outil_arreter,
    },
    {
        "name": "rapport",
        "description": (
            "Le tableau markdown des appels effectués, avec le verdict vert/rouge. "
            "C'est ce qui se colle dans le journal de phase et sur la PR."
        ),
        "inputSchema": {"type": "object", "properties": {}},
        "fonction": outil_rapport,
    },
]

INDEX_OUTILS = {outil["name"]: outil for outil in OUTILS}


def schema_public():
    return [{cle: outil[cle] for cle in ("name", "description", "inputSchema")} for outil in OUTILS]


# --------------------------------------------------------------------------- #
# Boucle JSON-RPC
# --------------------------------------------------------------------------- #

def _resultat(identifiant, charge):
    return {"jsonrpc": "2.0", "id": identifiant, "result": charge}


def _erreur(identifiant, code, message):
    return {"jsonrpc": "2.0", "id": identifiant, "error": {"code": code, "message": message}}


def appeler_outil(nom: str, arguments: dict):
    """Exécute un outil et rend (texte, en_erreur). Aucune exception ne sort d'ici."""
    outil = INDEX_OUTILS.get(nom)
    if not outil:
        return "Outil inconnu : %s" % nom, True
    try:
        charge = outil["fonction"](arguments or {})
    except Exception as erreur:  # un outil qui plante ne doit pas tuer le serveur
        trace = traceback.format_exc().strip().splitlines()
        return json.dumps(
            {"erreur": "%s: %s" % (type(erreur).__name__, erreur), "trace": trace[-3:]},
            ensure_ascii=False,
            indent=2,
        ), True
    texte = json.dumps(charge, ensure_ascii=False, indent=2, default=str)
    return texte, bool(isinstance(charge, dict) and charge.get("erreur"))


def dispatch(requete: dict):
    """Traite un message JSON-RPC. Rend la réponse, ou `None` pour une notification."""
    methode = requete.get("method")
    identifiant = requete.get("id")
    parametres = requete.get("params") or {}

    if methode == "initialize":
        demande = parametres.get("protocolVersion")
        return _resultat(
            identifiant,
            {
                "protocolVersion": demande if demande in PROTOCOLES_CONNUS else PROTOCOLE_DEFAUT,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": NOM_SERVEUR, "version": VERSION_SERVEUR},
            },
        )

    if methode in ("notifications/initialized", "notifications/cancelled"):
        return None

    if methode == "ping":
        return _resultat(identifiant, {})

    if methode == "tools/list":
        return _resultat(identifiant, {"tools": schema_public()})

    if methode == "tools/call":
        nom = parametres.get("name")
        texte, en_erreur = appeler_outil(nom, parametres.get("arguments") or {})
        return _resultat(identifiant, {"content": [{"type": "text", "text": texte}], "isError": en_erreur})

    if methode in ("resources/list", "prompts/list"):
        return _resultat(identifiant, {"resources": [], "prompts": []})

    if identifiant is None:
        return None
    return _erreur(identifiant, -32601, "Méthode inconnue : %s" % methode)


def main() -> int:
    # UTF-8 explicite : sous Windows, la console rendrait du cp1252 et le premier
    # accent d'une description d'outil casserait le décodage côté client.
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:  # pragma: no cover — Python < 3.7
        pass

    for ligne in sys.stdin:
        ligne = ligne.strip()
        if not ligne:
            continue
        try:
            requete = json.loads(ligne)
        except ValueError:
            sys.stdout.write(json.dumps(_erreur(None, -32700, "JSON illisible"), ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        if not isinstance(requete, dict):
            # Le transport ne porte qu'un objet par ligne : un tableau (lot
            # JSON-RPC, retiré de MCP depuis 2025-06-18) ou un scalaire ferait
            # sinon tomber la boucle sur un AttributeError, et le serveur avec.
            invalide = _erreur(None, -32600, "Requête JSON-RPC invalide")
            sys.stdout.write(json.dumps(invalide, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        try:
            reponse = dispatch(requete)
        except Exception as erreur:  # aucune exception ne doit couper le transport
            reponse = _erreur(requete.get("id"), -32603,
                              "%s: %s" % (type(erreur).__name__, erreur))
        if reponse is not None:
            sys.stdout.write(json.dumps(reponse, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    _arreter_tout()
    return 0


if __name__ == "__main__":
    sys.exit(main())
