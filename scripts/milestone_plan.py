#!/usr/bin/env python3
"""Ordonne les issues d'un jalon et regroupe celles qui peuvent avancer en parallèle.

    python scripts/milestone_plan.py                 # premier jalon ouvert qui a encore des issues
    python scripts/milestone_plan.py S1              # un préfixe de titre suffit
    python scripts/milestone_plan.py S1 --width 4    # largeur maximale d'une vague
    python scripts/milestone_plan.py S1 --nature outillage   # le stock d'outillage
    python scripts/milestone_plan.py S1 --json       # sortie machine, consommée par /milestone

Le plan répond à deux questions, et à elles seules :

  1. **Dans quel ordre ?** Un score d'importance : priorité, risque, sécurité, et
     surtout le nombre d'issues qu'une issue débloque. Ce qui ouvre la voie passe
     avant ce qui est seulement urgent.
  2. **Quoi en même temps ?** Deux issues ne partagent une vague que si aucune ne
     dépend de l'autre *et* si leurs empreintes de fichiers sont disjointes. Deux
     branches qui écrivent le même fichier finissent en conflit de fusion : c'est
     le coût qui annule le gain du parallélisme.

Une issue que le plan écarte — PR déjà ouverte, classement incomplet, quelqu'un
d'autre dessus — reste un **prérequis non satisfait** : son travail n'est pas sur
`develop`. Elle retient donc ses dépendants, qui sortent du plan sous la rubrique
« Retenues » plutôt que d'être dispatchés sur une base amputée (#155). Seule une
issue **fermée** libère les siens, et elle n'arrive jamais jusqu'à `qualify()` :
`fetch_issues` ne lit que les ouvertes, une issue fermée n'a donc aucune arête.
Font exception les écartées de `NEVER_HOLDS` (hors périmètre, traçabilité,
épique, outillage) : le run ne les fera jamais, les retenir gèlerait le jalon à
vie.

**Le plan ne dispatche qu'une nature à la fois.** Par défaut, le produit : une
issue `nature:outillage` — scripts, `.claude/`, CI du dépôt — est écartée, parce
qu'elle modifie le dispositif au moment même où le dispositif tourne.
`--nature outillage` retourne le filtre et ne déroule que ce stock-là ; c'est
alors le produit qui est écarté. `--nature toutes` ne filtre plus rien, et ne
s'emploie qu'en connaissance de cause : un agent produit et un agent outillage
d'une même vague peuvent se retrouver à réécrire l'orchestrateur l'un sous
l'autre.

Un plan d'outillage sort **en séquentiel** : sans `--width` explicite, la largeur
vaut 1 plutôt que 3. Neuf des quinze tickets d'outillage du S1 touchent
`scripts/milestone-run` ou `.claude/commands` ; les paralléliser reviendrait à
faire réécrire l'orchestrateur par deux agents à la fois. L'ordre, lui, ne change
pas : c'est le même score d'importance — priorité, risque, sécurité, et surtout
ce que le ticket débloque.

Une issue sans label `nature:*` n'est dispatchée dans aucun des deux sens : elle
sort en « classement incomplet », au même titre qu'un `ws:*` manquant.

**`.claude/**` est en lecture seule pour un run.** Le classifieur du harnais
refuse `Edit`/`Write` sur ces chemins en session non interactive — dans toutes
les vagues, donc, et jusqu'à l'arbitre. Un ticket dont l'empreinte y est
**entièrement** contenue ne peut produire aucun commit : le programmer coûte une
leg entière pour rien (#360, constaté sur #226 puis #356). Il sort donc du plan
sous la rubrique « À reprendre en session interactive », distincte des
« Écartées » — le travail est recevable, c'est le run qui n'a pas la main. Une
empreinte **mixte** (#245, #186) reste programmée : le volet hors `.claude/` se
livre, et le reste part en issue de suivi. Le plan le prescrit ticket par
ticket, sous « À scinder ».

Ce n'est pas une contrainte à contourner par un heredoc `Bash` : écrire un
`.claude/*.md` par ce biais contournerait le système de permissions, et #358 l'a
refusé. La seule voie d'écriture légitime est un point d'entrée Python
pré-autorisé, à l'image de `scripts/milestone_rules.py`.

Rien ici n'est deviné définitivement. `.claude/milestone-rules.json` fige les
dépendances et les empreintes que l'heuristique ne peut pas connaître ; toute
correction faite en lisant une issue a vocation à y être écrite. Elle s'écrit par
`python scripts/milestone_rules.py set-resources|add-depends`, et non par un
`Edit` : le classifieur du harnais refuse toute écriture sur `.claude/**` en
session non interactive, donc dans toutes les vagues d'un run de jalon (#208).

Codes de sortie : 0 plan produit · 1 aucune issue traitable · 4 erreur d'appel.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# `scripts/` n'est pas un paquet, mais il est en tête de `sys.path` dès qu'on
# exécute un script qui s'y trouve. `milestone_rules` est le point d'accès unique
# au fichier de règles : lecture ici, écriture par sa ligne de commande (#208).
import milestone_rules

# La console Windows encode en cp1252 : sans cela, un accent dans un titre
# d'issue fait planter le script au moment d'afficher le plan.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
ROOT = Path(__file__).resolve().parents[1]

OK, EMPTY, USAGE = 0, 1, 4

PRIORITY_SCORE = {"P0": 100, "P1": 60, "P2": 25}
LABEL_BONUS = {"risk": 15, "security": 10}
UNBLOCK_WEIGHT = 4

# Ce qu'un plan déroule. `projet` et `outillage` s'excluent — c'est tout l'objet
# du filtre ; `toutes` le lève, et n'est pas le cas normal.
NATURES = ("projet", "outillage", "toutes")

# Largeur par défaut selon la nature déroulée. L'outillage réécrit `scripts/` et
# `.claude/` pendant que ces fichiers-là orchestrent le run : une vague, un
# ticket. Le produit, lui, se parallélise sans se marcher dessus.
DEFAULT_WIDTH = {"projet": 3, "outillage": 1, "toutes": 1}

WORKSTREAMS = {"ws:devops": "devops", "ws:backend": "backend",
               "ws:frontend": "frontend", "ws:design": "design", "ws:qa": "qa"}

# Une ressource est un point de contact du dépôt. Deux issues d'une même vague ne
# peuvent pas en partager une : elles écriraient les mêmes fichiers. Les
# ressources portant ce préfixe sont documentaires — deux maquettes ne se
# marchent jamais dessus, elles ne sérialisent donc rien.
FREE_PREFIXES = ("design/", "docs/")

# Ce qu'un run ne peut pas écrire, quelle que soit sa nature : le classifieur du
# harnais refuse `Edit`/`Write` sur `.claude/**` en session non interactive.
# Le préfixe est celui des ressources figées dans `.claude/milestone-rules.json`
# (`.claude/commands`, `.claude/settings`, `.claude/skills/project-flow`, …) ;
# l'heuristique de `resources_of` n'en produit aucune, ces empreintes-là sont
# toujours posées à la main.
READONLY_PREFIX = ".claude/"

# La consigne portée par le plan pour une empreinte mixte. C'est ce que #186 a
# fait à la main, et ce qui a marché : livrer ce qui est livrable, tracer le
# reste, plutôt que rendre une leg vide ou forcer l'écriture.
SPLIT_ADVICE = "livrer le volet hors .claude/**, ouvrir l'issue de suivi du reste"

# Ressources transverses, déduites du texte de l'issue. Ce sont les points chauds
# du dépôt : un seul fichier, touché par des travaux de modules différents.
TEXT_RESOURCES = [
    ("db:schema", r"sch[ée]ma prisma|prisma/schema|migration prisma|les sept entit[ée]s"),
    ("contracts:shared", r"packages/shared|types partag[ée]s|contrats? d'api|sch[ée]mas? zod"),
    ("ci:workflows", r"\.github/workflows|github actions|pipeline ci|workflow ci"),
    ("root:deps", r"package\.json racine|workspaces npm|monorepo npm"),
]


def gh(args):
    proc = subprocess.run(["gh"] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        sys.exit("échec gh : " + (proc.stderr or proc.stdout).strip())
    return proc.stdout


def gh_json(args):
    try:
        return json.loads(gh(args) or "[]")
    except json.JSONDecodeError:
        sys.exit("réponse gh illisible")


def load_rules():
    """Les règles figées du dépôt, lues par leur seul point d'accès."""
    try:
        return milestone_rules.load()
    except milestone_rules.RulesError as exc:
        sys.exit(str(exc))


# --------------------------------------------------------------------------- #
# Collecte
# --------------------------------------------------------------------------- #

def resolve_milestone(prefix):
    """Le jalon demandé, ou à défaut le premier ouvert qui a encore des issues."""
    milestones = gh_json(["api", f"repos/{REPO}/milestones", "--paginate",
                          "-X", "GET", "-f", "state=all"])
    if prefix:
        needle = prefix.strip().lower()
        matches = [m for m in milestones if needle in m["title"].lower()]
        if not matches:
            titles = " · ".join(m["title"] for m in milestones)
            sys.exit(f"aucun jalon ne correspond à « {prefix} » (existants : {titles})")
        if len(matches) > 1:
            titles = " · ".join(m["title"] for m in matches)
            sys.exit(f"« {prefix} » est ambigu : {titles}")
        return matches[0]

    opened = [m for m in milestones if m["state"] == "open"]
    if not opened:
        sys.exit("aucun jalon ouvert")
    opened.sort(key=lambda m: m.get("due_on") or "9999")
    # Un jalon dont toutes les issues sont closes reste « ouvert » jusqu'à ce que
    # quelqu'un le clôture à la main. Le retenir ferait sortir le planificateur
    # sur « aucune issue traitable » alors que le jalon suivant, lui, en a.
    return next((m for m in opened if m.get("open_issues", 0) > 0), opened[0])


def fetch_issues(title, limit):
    return gh_json(["issue", "list", "--repo", REPO, "--milestone", title,
                    "--state", "open", "--limit", str(limit),
                    "--json", "number,title,body,labels,assignees,url"])


def closing_refs(pr):
    """Les issues que cette PR **ferme**, telles que GitHub les a résolues.

    `closingIssuesReferences` est le lien que GitHub établit lui-même à partir
    des mots-clés de fermeture. C'est la seule source qui distingue « cette PR
    traite #34 » de « cette PR mentionne #34 » — et une regex du corps ne le
    peut pas, parce que les deux s'écrivent pareil.

    Les références d'un autre dépôt sont ignorées : un numéro d'issue n'a de
    sens que dans le sien, et le confondre rendrait occupée une issue d'ici qui
    porte le même numéro là-bas. La comparaison ignore la casse : `gh` accepte
    `--repo tmap-works/spa-booking`, mais l'API répond `TMap-Works` — comparer
    littéralement ferait rejeter *toutes* les fermetures dès que
    `SPA_TRACKING_REPO` n'est pas écrit exactement comme GitHub l'affiche, et le
    run relancerait un agent sur un ticket déjà en PR.
    """
    numeros = set()
    for ref in pr.get("closingIssuesReferences") or []:
        if not isinstance(ref, dict) or not isinstance(ref.get("number"), int):
            continue
        depot = ref.get("repository") or {}
        nom = depot.get("name")
        proprietaire = (depot.get("owner") or {}).get("login")
        if nom and proprietaire and ("%s/%s" % (proprietaire, nom)).lower() != REPO.lower():
            continue
        numeros.add(ref["number"])
    return numeros


def fetch_busy():
    """Numéros d'issue déjà couverts par une pull request ouverte.

    Deux sources, et **pas** le corps de la PR : les fermetures que GitHub a
    résolues, et le numéro que porte le nom de la branche. Ni l'une ni l'autre
    ne confond une référence avec un lien.

    Lire le corps à la regex `#(\\d+)` a coûté un jalon entier (#308). Un bon
    corps de PR nomme les tickets voisins pour justifier sa frontière de
    périmètre — « #35 possède l'endpoint, #36 l'agrégation, donc #34 est
    l'algorithme seul ». La PR #307 en citait neuf pour n'en fermer qu'une : les
    quatre ouvertes du jalon sont sorties du plan « PR déjà ouverte », leurs
    onze dépendantes ont été retenues derrière elles, `waves` est resté vide, et
    le run a conclu que S2 était déroulé sans avoir traité un seul ticket.

    Plus le corps de PR était soigné, plus il gelait de tickets : l'incitation
    exactement inverse de celle qu'on veut. `milestone_run.py` avait déjà tiré
    la leçon pour son propre appariement (`CLOSES_RE`) ; elle n'était jamais
    remontée jusqu'ici.
    """
    busy = {}
    prs = gh_json(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
                   "--json", "number,headRefName,closingIssuesReferences"])
    for pr in prs:
        found = {int(n) for n in re.findall(r"(?:^|[/+-])(\d+)-", pr.get("headRefName") or "")}
        found |= closing_refs(pr)
        for number in found:
            busy.setdefault(number, pr["number"])
    return busy


def whoami():
    proc = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    return proc.stdout.strip() if proc.returncode == 0 else ""


# --------------------------------------------------------------------------- #
# Qualification — reprend la phase 0 de /ticket, pour ne jamais dispatcher un
# agent sur une issue qu'il refuserait de traiter.
# --------------------------------------------------------------------------- #

# Écarter n'a pas partout le même sens. Ces quatre raisons-là sont structurelles :
# le run ne dispatchera jamais l'issue, et aucun merge qu'il déclenche ne la
# fermera. La tenir pour un prérequis non satisfait gèlerait ses dépendants pour
# toujours — le plan n'aurait plus aucun moyen de repartir. Les autres raisons —
# PR en vol, classement à compléter, quelqu'un d'autre dessus — se résorbent, et
# retiennent donc à raison.
#
# `TOOLING` est le seul des quatre dont le travail sera peut-être fait, et même
# bientôt : simplement, il le sera par un humain, hors run. Le retenir reviendrait
# à suspendre le produit à un chantier d'outillage dont le run ne sait rien.
OUT_OF_SCOPE = "hors périmètre MVP (post-mvp)"
TRACKING = "ticket de traçabilité, pas du travail produit"
EPIC = "épique — conteneur, ce sont ses sous-tâches qui portent le travail"
TOOLING = "outillage — traité à la main, une session à la fois"
# Le symétrique de `TOOLING` sous `--nature outillage`. Il ne retient personne
# pour la même raison : ce run-là ne fera jamais le produit, et un ticket
# d'outillage suspendu à une issue produit ne partirait plus jamais.
PRODUCT = "produit — pas d'un run d'outillage"
# Le cinquième, et le seul que `qualify()` ne sache pas voir : il se lit dans
# l'empreinte, pas dans les labels. Même régime que `TOOLING` — un humain le
# fera, en session interactive, et le retenir suspendrait le jalon à un
# rendez-vous que le run ne peut pas prendre.
INTERACTIVE = "empreinte entièrement sous .claude/** — à reprendre en session interactive"
NEVER_HOLDS = {OUT_OF_SCOPE, TRACKING, EPIC, TOOLING, PRODUCT, INTERACTIVE}


def qualify(issue, busy, me, nature="projet"):
    """(recevable, raison d'écarter).

    Ne voit que des issues **ouvertes** : `fetch_issues` filtre sur `--state open`.
    Une issue fermée ne passe donc jamais ici — elle est simplement absente, et
    c'est ce qui la fait, à raison, libérer ses dépendants : son travail est sur
    `develop`. Une issue qui ressort d'ici avec une raison résorbable, elle, a son
    travail ailleurs — en vol, en attente ou pas commencé — et retient les siens ;
    les raisons de `NEVER_HOLDS` ne retiennent personne.
    """
    labels = {label["name"] for label in issue["labels"]}
    if "post-mvp" in labels:
        return False, OUT_OF_SCOPE
    if "tracking" in labels:
        return False, TRACKING
    if "type:epic" in labels:
        return False, EPIC
    # Une seule nature est déroulée à la fois : l'autre est écartée sans retenir
    # personne — son travail se fera, mais dans un autre run.
    if nature == "projet" and "nature:outillage" in labels:
        return False, TOOLING
    if nature == "outillage" and "nature:projet" in labels:
        return False, PRODUCT

    missing = []
    if not any(l.startswith("ws:") for l in labels):
        missing.append("workstream")
    if not any(l.startswith("mod:") for l in labels):
        missing.append("module")
    if not any(l.startswith("type:") for l in labels):
        missing.append("type")
    # Sans nature, on ne sait pas si l'issue relève du run ou de l'humain.
    # Choisir à sa place serait faux dans un sens comme dans l'autre : la
    # supposer produit enverrait un agent réécrire l'outillage pendant qu'il
    # tourne, la supposer outillage ferait sortir du sprint un vrai ticket MVP.
    if not any(l.startswith("nature:") for l in labels):
        missing.append("nature")
    if not labels & set(PRIORITY_SCORE):
        missing.append("priorité")
    if missing:
        return False, "classement incomplet : " + ", ".join(missing)

    if issue["number"] in busy:
        return False, f"PR #{busy[issue['number']]} déjà ouverte"

    others = [a["login"] for a in issue.get("assignees", []) if a["login"] != me]
    if others:
        return False, "assignée à " + ", ".join(others)

    return True, None


def describe(issue):
    labels = {label["name"] for label in issue["labels"]}
    return {
        "number": issue["number"],
        "title": issue["title"],
        "url": issue["url"],
        "labels": sorted(labels),
        "workstream": next((WORKSTREAMS[l] for l in labels if l in WORKSTREAMS), "?"),
        "module": next((l[4:] for l in labels if l.startswith("mod:")), "?"),
        "type": next((l[5:] for l in labels if l.startswith("type:")), "?"),
        "nature": next((l[7:] for l in labels if l.startswith("nature:")), "?"),
        "priority": next((l for l in labels if l in PRIORITY_SCORE), "P2"),
        "body": issue.get("body") or "",
    }


def resources_of(node, rules):
    """Empreinte de fichiers attendue, sous forme de ressources nommées."""
    pinned = rules.get("resources", {}).get(str(node["number"]))
    if pinned is not None:
        return sorted(set(pinned))

    text = (node["title"] + "\n" + node["body"]).lower()
    found = {name for name, pattern in TEXT_RESOURCES if re.search(pattern, text)}

    ws, mod = node["workstream"], node["module"]
    if ws == "backend":
        found.add("api/core" if mod == "infra" else f"api/{mod}")
    elif ws == "frontend":
        found.add(f"web/{mod}")
    elif ws == "devops":
        found.add("ci:workflows" if "ci:workflows" in found else "infra/terraform")
    elif ws == "qa":
        found.add(f"tests/{mod}")
    elif ws == "design":
        found.add(f"design/{mod}")
    return sorted(found)


def blocking(resources):
    return {r for r in resources if not r.startswith(FREE_PREFIXES)}


def readonly_part(resources):
    """La part de l'empreinte qu'un run ne peut pas écrire, triée."""
    return sorted(r for r in resources if r.startswith(READONLY_PREFIX))


def undeliverable(resources):
    """L'empreinte est-elle **entièrement** en lecture seule ?

    Une empreinte vide ne l'est pas : elle ne dit rien, et écarter sur un silence
    ferait sortir du plan tout ticket dont l'heuristique n'a rien su déduire.

    Ressource par ressource, et non par comptage : une empreinte qui répéterait
    deux fois la même ressource `.claude/` ferait coïncider les décomptes d'une
    empreinte mixte, et sortirait du plan un ticket en partie livrable.
    """
    return bool(resources) and all(r.startswith(READONLY_PREFIX) for r in resources)


# --------------------------------------------------------------------------- #
# Graphe de dépendances
# --------------------------------------------------------------------------- #

DECLARED = re.compile(
    r"(?:d[ée]pend(?:s|ance)?\s+de|bloqu[ée]e?\s+par|pr[ée]requis|apr[èe]s)\s*:?\s*#(\d+)",
    re.IGNORECASE)

# Travaux de clôture d'un jalon : ils valident ou déploient ce que le reste du
# jalon a produit. Cherché dans le titre seulement — « vérifié en recette » est
# une case de la Definition of Done, donc présent dans le corps de chaque issue.
CLOSING = re.compile(
    r"recette|go-?live|\buat\b|mise en production|d[ée]ployer la production|"
    r"d[ée]ployer staging", re.IGNORECASE)


def build_edges(nodes, rules, held=()):
    """prereqs[n] = {parents}, et la liste des arêtes avec leur justification.

    Trois sources, par confiance décroissante : ce que l'issue déclare, ce que le
    dépôt fige, ce que l'heuristique déduit. Une arête heuristique n'est posée que
    si elle ne referme pas un cycle — c'est ce qui permet à une règle générale
    (« le schéma précède le code qui l'utilise ») de coexister avec l'exception
    qui la contredit (« le squelette NestJS précède le schéma »).
    """
    index = {n["number"]: n for n in nodes}
    # Une issue écartée du plan reste un sommet valide du graphe : c'est
    # précisément parce que son travail n'est pas sur `develop` qu'elle doit
    # retenir ses dépendants. Elle ne peut être que parent — le plan ne la
    # programme pas, seul `withheld_by` lit ce qu'elle bloque. Elle est donc
    # décrite comme les autres (`describe` + `resources_of`) et entre dans les
    # trois sources d'arêtes, l'heuristique comprise : c'est elle qui en produit
    # le plus, et l'en priver laisserait passer très exactement le défaut de #155
    # (l'écran part alors que l'API du même module est encore en PR).
    held = list(held)
    candidates = list(nodes) + held
    known = set(index) | {n["number"] for n in held}
    prereqs = {n["number"]: set() for n in nodes}
    edges = []

    def reaches(start, target):
        """target est-il déjà un prérequis, direct ou lointain, de start ?"""
        seen, stack = {start}, [start]
        while stack:
            current = stack.pop()
            if current == target:
                return True
            for parent in prereqs.get(current, ()):
                if parent not in seen:
                    seen.add(parent)
                    stack.append(parent)
        return False

    def add(child, parent, reason, hard):
        if child == parent or child not in index or parent not in known:
            return
        if parent in prereqs[child]:
            return
        if reaches(parent, child):
            if hard:
                edges.append({"child": child, "parent": parent, "reason": reason,
                              "dropped": "créerait un cycle"})
            return
        prereqs[child].add(parent)
        edges.append({"child": child, "parent": parent, "reason": reason})

    # 1. Ce que l'issue déclare elle-même.
    for node in nodes:
        for parent in DECLARED.findall(node["body"]):
            add(node["number"], int(parent), "déclarée dans l'issue", True)

    # 2. Ce que le dépôt fige.
    why = rules.get("why", {})
    for child, parents in rules.get("depends", {}).items():
        for parent in parents:
            add(int(child), int(parent),
                why.get(str(child), "règle du dépôt (.claude/milestone-rules.json)"), True)

    # 3. Ce que l'heuristique déduit.
    schema = [n["number"] for n in candidates if "db:schema" in n["resources"]]
    contracts = [n["number"] for n in candidates if "contracts:shared" in n["resources"]]
    for node in nodes:
        number, ws, mod = node["number"], node["workstream"], node["module"]

        if ws in {"backend", "qa"} and "db:schema" not in node["resources"]:
            for parent in schema:
                add(number, parent, "le schéma Prisma précède le code qui l'utilise", False)

        if ws == "frontend":
            for parent in contracts:
                add(number, parent, "l'écran consomme les contrats partagés", False)
            for other in candidates:
                if other["module"] == mod and other["workstream"] == "backend":
                    add(number, other["number"], "l'écran consomme l'API du même module", False)
                if other["module"] == mod and other["workstream"] == "design":
                    add(number, other["number"], "l'écran suit sa maquette", False)

        if ws == "qa":
            for other in candidates:
                if other["module"] == mod and other["workstream"] in {"backend", "frontend"}:
                    add(number, other["number"], "le test suit ce qu'il vérifie", False)

    closing = {n["number"] for n in candidates if CLOSING.search(n["title"])}
    for number in closing:
        for other in candidates:
            if other["number"] not in closing:
                add(number, other["number"], "un jalon se clôt par sa recette", False)

    return prereqs, edges


def withheld_by(numbers, prereqs, held):
    """{issue : prérequis retenus qui la bloquent}, transitivement.

    Un prérequis écarté du plan n'est pas satisfait : son travail est en vol ou en
    attente, pas sur `develop`. L'issue qui en dépend ne peut donc pas démarrer —
    ni celles qui dépendent d'elle. C'est le défaut de #155 : `plan_waves` lisait
    « absent de `remaining` » comme « fait », alors que la seule absence qui vaut
    « fait » est celle d'une issue fermée, jamais entrée dans le graphe.

    Point fixe plutôt que descente récursive : `prereqs` est acyclique par
    construction (`add` refuse ce qui referme un cycle), mais un graphe qui
    bouclerait ne doit pas faire boucler le planificateur. Les causes ne font que
    croître dans un ensemble fini, la boucle termine.
    """
    blocked = {}
    changed = True
    while changed:
        changed = False
        for number in numbers:
            causes = set()
            for parent in prereqs.get(number, ()):
                if parent in held:
                    causes.add(parent)
                causes |= blocked.get(parent, set())
            if causes and causes != blocked.get(number):
                blocked[number] = causes
                changed = True
    return blocked


def reachable_pairs(prereqs):
    """Ensemble des couples (a, b) tels que a dépend de b, directement ou non."""
    closure = {}

    def walk(node, stack):
        if node in closure:
            return closure[node]
        total = set()
        for parent in prereqs.get(node, ()):
            if parent in stack:
                continue
            total.add(parent)
            total |= walk(parent, stack | {node})
        closure[node] = total
        return total

    for node in prereqs:
        walk(node, set())
    return closure


def downstream(closure):
    """Combien d'issues chaque issue débloque, transitivement."""
    counts = {node: 0 for node in closure}
    for _, parents in closure.items():
        for parent in parents:
            if parent in counts:
                counts[parent] += 1
    return counts


def score(node, unblocks):
    value = PRIORITY_SCORE[node["priority"]]
    for label, bonus in LABEL_BONUS.items():
        if label in node["labels"]:
            value += bonus
    return value + UNBLOCK_WEIGHT * unblocks


# --------------------------------------------------------------------------- #
# Vagues
# --------------------------------------------------------------------------- #

def plan_waves(nodes, prereqs, width):
    """Couches topologiques, puis remplissage des vagues sans collision de fichiers."""
    index = {n["number"]: n for n in nodes}
    remaining = set(index)
    waves, cut = [], []

    while remaining:
        ready = [n for n in remaining if not prereqs[n] & remaining]
        if not ready:
            # Cycle résiduel : le trancher plutôt que rendre un plan vide.
            ready = [min(remaining, key=lambda n: (-index[n]["score"], n))]
            cut.append(ready[0])

        ready.sort(key=lambda n: (-index[n]["score"], n))

        # Une seule vague par tour, puis on recalcule ce qui est prêt. Vider la
        # couche entière d'un coup ferait passer une issue de faible score avant
        # une issue à fort score que la vague qu'on vient de composer vient
        # justement de débloquer — l'inverse de la promesse du plan, où ce qui
        # ouvre la voie passe avant ce qui n'est qu'urgent.
        wave, claimed = [], set()
        for number in ready:
            if len(wave) >= width:
                break
            needs = blocking(index[number]["resources"])
            if needs & claimed:
                continue          # même empreinte qu'un ticket déjà dans la vague
            wave.append(number)
            claimed |= needs

        waves.append(wave)
        remaining -= set(wave)

    return waves, cut


def separated_by_files(index, waves, closure):
    """Paires qui auraient pu être parallèles, et que seule l'empreinte a séparées."""
    wave_of = {number: position for position, group in enumerate(waves) for number in group}
    out = []
    numbers = sorted(index)
    for i, left in enumerate(numbers):
        for right in numbers[i + 1:]:
            if wave_of[left] == wave_of[right]:
                continue
            if right in closure.get(left, ()) or left in closure.get(right, ()):
                continue                      # séparées par une dépendance, pas par un fichier
            shared = blocking(index[left]["resources"]) & blocking(index[right]["resources"])
            if shared:
                out.append((left, right, sorted(shared)))
    return out


# --------------------------------------------------------------------------- #
# Rendu
# --------------------------------------------------------------------------- #

def due_in(milestone):
    raw = milestone.get("due_on")
    if not raw:
        return "sans échéance"
    due = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    days = (due - datetime.now(timezone.utc)).days
    when = "aujourd'hui" if days == 0 else (
        f"dans {days} j" if days > 0 else f"dépassée de {-days} j")
    return f"échéance {due:%Y-%m-%d} ({when})"


def render(milestone, waves, index, excluded, edges, cut, width, closure,
           withheld, catalog, reasons, nature="projet", interactive=()):
    counted = f"{len(index)} traitables"
    if withheld:
        counted += f" · {len(withheld)} retenues"
    aside = sum(1 for item in excluded if item["reason"] in (TOOLING, PRODUCT))
    if aside:
        counted += f" · {aside} d'une autre nature"
    if interactive:
        counted += f" · {len(interactive)} en session interactive"
    print(f"Jalon {milestone['title']} · {due_in(milestone)} · nature {nature}")
    print(f"{milestone['open_issues']} ouvertes · {milestone['closed_issues']} fermées · "
          f"{counted} · {len(waves)} vagues · largeur max {width}")
    print()

    rank = 0
    for position, numbers in enumerate(waves, 1):
        mode = "seule" if len(numbers) == 1 else f"{len(numbers)} en parallèle"
        print(f"Vague {position} · {mode}")
        for number in numbers:
            node = index[number]
            rank += 1
            title = node["title"]
            if len(title) > 46:
                title = title[:45] + "…"
            print(f"  {rank:>2}. #{number:<4} {node['priority']} {node['score']:>4} pts  "
                  f"{node['workstream']:<8} {node['module']:<13} {title:<46} "
                  f"[{', '.join(node['resources'])}]")
        print()

    # Programmés, mais pas d'un bloc : ce qui suit dit à l'agent où s'arrêter.
    split = [index[n] for group in waves for n in group if index[n]["readonly"]]
    if split:
        print("À scinder · une part de l'empreinte est sous .claude/**, "
              "qu'un run ne peut pas écrire")
        for node in split:
            print(f"  #{node['number']:<4} {SPLIT_ADVICE} · "
                  f"{', '.join(node['readonly'])}")
        print()

    # Une même raison vaut souvent pour plusieurs prérequis d'une même issue :
    # les regrouper, sans quoi une règle transverse noie tout le reste.
    grouped = {}
    for edge in edges:
        if not edge.get("dropped"):
            grouped.setdefault((edge["child"], edge["reason"]), []).append(edge["parent"])
    if grouped:
        print("Sérialisé, et pourquoi")
        for (child, reason), parents in sorted(grouped.items()):
            who = (", ".join(f"#{p}" for p in sorted(parents)) if len(parents) <= 4
                   else f"{len(parents)} autres issues du jalon")
            print(f"  #{child} après {who} · {reason}")
        print()

    conflicts = separated_by_files(index, waves, closure)
    if conflicts:
        print("Jamais ensemble · même empreinte de fichiers, aucune dépendance")
        for left, right, shared in conflicts[:15]:
            print(f"  #{left} ‖ #{right} · {', '.join(shared)}")
        if len(conflicts) > 15:
            print(f"  … et {len(conflicts) - 15} autres paires")
        print()

    if cut:
        print("Cycle tranché · à corriger dans .claude/milestone-rules.json")
        for number in cut:
            print(f"  #{number} placée d'office")
        print()

    dropped = [e for e in edges if e.get("dropped")]
    if dropped:
        print("Dépendance déclarée mais ignorée")
        for edge in dropped:
            print(f"  #{edge['child']} après #{edge['parent']} · {edge['dropped']}")
        print()

    # Distincte des « Écartées » : ces tickets-là sont recevables. Ce qui manque
    # n'est pas leur classement, c'est le travail dont ils dépendent — resté dans
    # une PR ouverte, donc pas sur `develop`.
    if withheld:
        print("Retenues · un prérequis n'est pas sur develop")
        for number in sorted(withheld):
            title = catalog[number]["title"]
            if len(title) > 46:
                title = title[:45] + "…"
            causes = " · ".join(
                (f"#{parent} ({reasons[parent]['reason']})" if parent in reasons
                 else f"#{parent}")
                for parent in sorted(withheld[number]))
            print(f"  #{number:<4} {title:<46} retenue par {causes}")
        print()

    # Ni « écartées » ni « retenues » : le ticket est recevable et son travail
    # attend, mais personne dans un run ne peut l'écrire. Le sortir ici plutôt
    # que dans une vague économise une leg entière par ticket (#360).
    if interactive:
        print("À reprendre en session interactive · empreinte entièrement sous "
              ".claude/**, hors de portée d'un run")
        for node in interactive:
            title = node["title"]
            if len(title) > 46:
                title = title[:45] + "…"
            print(f"  #{node['number']:<4} {title:<46} "
                  f"{', '.join(node['resources'])}")
        print()

    if excluded:
        print("Écartées · pas dispatchables — et celles dont la raison peut se "
              "résorber retiennent leurs dépendants")
        for item in excluded:
            print(f"  #{item['number']:<4} {item['reason']} — {item['title'][:58]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("milestone", nargs="?",
                        help="titre du jalon ou un fragment (défaut : échéance la plus proche)")
    parser.add_argument("--width", type=int, default=None,
                        help="nombre maximal d'issues menées en parallèle "
                             "(défaut 3 en projet, 1 en outillage)")
    parser.add_argument("--nature", choices=NATURES, default="projet",
                        help="ce que le plan déroule : le produit (défaut), "
                             "l'outillage — scripts/, .claude/ —, ou les deux")
    parser.add_argument("--limit", type=int, default=200, help="issues lues au maximum")
    parser.add_argument("--json", action="store_true", help="sortie machine")
    parser.add_argument("--include-busy", action="store_true",
                        help="ne pas écarter les issues déjà couvertes par une PR ouverte")
    args = parser.parse_args()

    # `--width` non passé vaut ce que la nature demande : le produit se
    # parallélise, l'outillage se déroule un ticket à la fois.
    if args.width is None:
        args.width = DEFAULT_WIDTH[args.nature]
    if args.width < 1:
        sys.exit("--width doit valoir au moins 1")

    milestone = resolve_milestone(args.milestone)
    issues = fetch_issues(milestone["title"], args.limit)
    if not issues:
        print(f"Jalon {milestone['title']} : aucune issue ouverte.")
        return EMPTY

    busy = {} if args.include_busy else fetch_busy()
    me = whoami()
    # Les règles avant la qualification : l'empreinte en fait désormais partie,
    # `qualify()` ne pouvant pas voir ce qui ne tient pas dans les labels.
    rules = load_rules()

    nodes, excluded, held_nodes, interactive = [], [], [], []
    for issue in issues:
        ok, reason = qualify(issue, busy, me, args.nature)
        node = describe(issue)
        node["resources"] = resources_of(node, rules)
        node["readonly"] = readonly_part(node["resources"])
        # Le seul motif qui se lit dans l'empreinte : un ticket par ailleurs
        # recevable dont tout le travail est sous `.claude/**` ne produira aucun
        # commit, faute pour un agent non interactif de pouvoir y écrire (#360).
        if ok and undeliverable(node["resources"]):
            ok, reason = False, INTERACTIVE
        if ok:
            nodes.append(node)
            continue
        if reason == INTERACTIVE:
            # Rubrique à part, et non « écartée » : rien ne cloche dans le
            # ticket, il attend seulement un humain devant son clavier.
            interactive.append(node)
            continue
        excluded.append({"number": issue["number"], "title": issue["title"],
                         "reason": reason, "pr": busy.get(issue["number"])})
        # Écartée du plan ne veut pas dire faite : aucune de ces issues n'a
        # son travail sur `develop`. Elles restent donc des prérequis non
        # satisfaits — sauf celles qui ne seront jamais faites du tout, qui
        # ne retiendraient personne, seulement pour toujours.
        if reason not in NEVER_HOLDS:
            held_nodes.append(node)

    if not nodes:
        print(f"Jalon {milestone['title']} · nature {args.nature} : rien de "
              f"traitable ({len(excluded)} issue(s) écartée(s)"
              + (f", {len(interactive)} en session interactive" if interactive else "")
              + ").")
        for item in excluded:
            print(f"  #{item['number']:<4} {item['reason']}")
        for node in interactive:
            print(f"  #{node['number']:<4} {INTERACTIVE}")
        return EMPTY

    held = {n["number"] for n in held_nodes}

    prereqs, edges = build_edges(nodes, rules, held_nodes)
    closure = reachable_pairs(prereqs)
    unblocks = downstream(closure)
    for node in nodes:
        node["unblocks"] = unblocks[node["number"]]
        node["score"] = score(node, node["unblocks"])

    # Ce qu'un prérequis retenu bloque sort du plan sans être « écarté » : le
    # ticket est recevable, c'est sa base qui n'est pas prête.
    catalog = {n["number"]: n for n in nodes}
    withheld = withheld_by(catalog, prereqs, held)
    reasons = {item["number"]: item for item in excluded}
    planned = [n for n in nodes if n["number"] not in withheld]

    index = {n["number"]: n for n in planned}
    waves, cut = plan_waves(planned, prereqs, args.width)

    if args.json:
        payload = {
            "milestone": {"title": milestone["title"], "number": milestone["number"],
                          "due_on": milestone.get("due_on"),
                          "open": milestone["open_issues"],
                          "closed": milestone["closed_issues"]},
            "width": args.width,
            "nature": args.nature,
            "waves": [
                {"index": position,
                 "issues": [{k: v for k, v in index[n].items() if k != "body"}
                            for n in numbers]}
                for position, numbers in enumerate(waves, 1)
            ],
            "edges": edges,
            "excluded": excluded,
            # Distincte d'« excluded » à dessein : ces tickets-là sont
            # recevables et attendent une session interactive. `/milestone`
            # recopie le plan entier dans `run.json` : la rubrique y survit, à
            # charge pour qui la relit de la restituer à l'humain — aucune
            # commande ne la consomme aujourd'hui.
            "interactive": [
                {"number": node["number"], "title": node["title"],
                 "url": node["url"], "resources": node["resources"],
                 "reason": INTERACTIVE}
                for node in interactive
            ],
            # Ce que le plan prescrit aux tickets qu'il programme malgré une part
            # non livrable — l'agent doit scinder plutôt que forcer l'écriture.
            "split": [
                {"number": node["number"], "title": node["title"],
                 "readonly": node["readonly"], "advice": SPLIT_ADVICE}
                for node in planned if node["readonly"]
            ],
            "withheld": [
                {"number": number,
                 "title": catalog[number]["title"],
                 "url": catalog[number]["url"],
                 "held_by": [{"number": parent,
                              "reason": reasons.get(parent, {}).get("reason"),
                              "pr": reasons.get(parent, {}).get("pr")}
                             for parent in sorted(causes)]}
                for number, causes in sorted(withheld.items())
            ],
            "cycles_cut": cut,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return OK

    render(milestone, waves, index, excluded, edges, cut, args.width, closure,
           withheld, catalog, reasons, args.nature, interactive)
    return OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(USAGE)
