#!/usr/bin/env python3
"""Ordonne les issues d'un jalon et regroupe celles qui peuvent avancer en parallèle.

    python scripts/milestone_plan.py                 # jalon ouvert dont l'échéance est la plus proche
    python scripts/milestone_plan.py S1              # un préfixe de titre suffit
    python scripts/milestone_plan.py S1 --width 4    # largeur maximale d'une vague
    python scripts/milestone_plan.py S1 --json       # sortie machine, consommée par /milestone

Le plan répond à deux questions, et à elles seules :

  1. **Dans quel ordre ?** Un score d'importance : priorité, risque, sécurité, et
     surtout le nombre d'issues qu'une issue débloque. Ce qui ouvre la voie passe
     avant ce qui est seulement urgent.
  2. **Quoi en même temps ?** Deux issues ne partagent une vague que si aucune ne
     dépend de l'autre *et* si leurs empreintes de fichiers sont disjointes. Deux
     branches qui écrivent le même fichier finissent en conflit de fusion : c'est
     le coût qui annule le gain du parallélisme.

Rien ici n'est deviné définitivement. `.claude/milestone-rules.json` fige les
dépendances et les empreintes que l'heuristique ne peut pas connaître ; toute
correction faite en lisant une issue a vocation à y être écrite.

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

# La console Windows encode en cp1252 : sans cela, un accent dans un titre
# d'issue fait planter le script au moment d'afficher le plan.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
ROOT = Path(__file__).resolve().parents[1]
RULES_FILE = ROOT / ".claude" / "milestone-rules.json"

OK, EMPTY, USAGE = 0, 1, 4

PRIORITY_SCORE = {"P0": 100, "P1": 60, "P2": 25}
LABEL_BONUS = {"risk": 15, "security": 10}
UNBLOCK_WEIGHT = 4

WORKSTREAMS = {"ws:devops": "devops", "ws:backend": "backend",
               "ws:frontend": "frontend", "ws:design": "design", "ws:qa": "qa"}

# Une ressource est un point de contact du dépôt. Deux issues d'une même vague ne
# peuvent pas en partager une : elles écriraient les mêmes fichiers. Les
# ressources portant ce préfixe sont documentaires — deux maquettes ne se
# marchent jamais dessus, elles ne sérialisent donc rien.
FREE_PREFIXES = ("design/", "docs/")

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
    if not RULES_FILE.exists():
        return {}
    try:
        return json.loads(RULES_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"{RULES_FILE.name} illisible : {exc}")


# --------------------------------------------------------------------------- #
# Collecte
# --------------------------------------------------------------------------- #

def resolve_milestone(prefix):
    """Le jalon demandé, ou à défaut l'ouvert dont l'échéance est la plus proche."""
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
    return sorted(opened, key=lambda m: m.get("due_on") or "9999")[0]


def fetch_issues(title, limit):
    return gh_json(["issue", "list", "--repo", REPO, "--milestone", title,
                    "--state", "open", "--limit", str(limit),
                    "--json", "number,title,body,labels,assignees,url"])


def fetch_busy():
    """Numéros d'issue déjà couverts par une pull request ouverte."""
    busy = {}
    prs = gh_json(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
                   "--json", "number,body,headRefName"])
    for pr in prs:
        found = set(re.findall(r"(?:^|[/+-])(\d+)-", pr.get("headRefName") or ""))
        found |= set(re.findall(r"#(\d+)", pr.get("body") or ""))
        for number in found:
            busy.setdefault(int(number), pr["number"])
    return busy


def whoami():
    proc = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    return proc.stdout.strip() if proc.returncode == 0 else ""


# --------------------------------------------------------------------------- #
# Qualification — reprend la phase 0 de /ticket, pour ne jamais dispatcher un
# agent sur une issue qu'il refuserait de traiter.
# --------------------------------------------------------------------------- #

def qualify(issue, busy, me):
    """(recevable, raison d'écarter)."""
    labels = {label["name"] for label in issue["labels"]}
    if "post-mvp" in labels:
        return False, "hors périmètre MVP (post-mvp)"
    if "tracking" in labels:
        return False, "ticket de traçabilité, pas du travail produit"
    if "type:epic" in labels:
        return False, "épique — conteneur, ce sont ses sous-tâches qui portent le travail"

    missing = []
    if not any(l.startswith("ws:") for l in labels):
        missing.append("workstream")
    if not any(l.startswith("mod:") for l in labels):
        missing.append("module")
    if not any(l.startswith("type:") for l in labels):
        missing.append("type")
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


def build_edges(nodes, rules):
    """prereqs[n] = {parents}, et la liste des arêtes avec leur justification.

    Trois sources, par confiance décroissante : ce que l'issue déclare, ce que le
    dépôt fige, ce que l'heuristique déduit. Une arête heuristique n'est posée que
    si elle ne referme pas un cycle — c'est ce qui permet à une règle générale
    (« le schéma précède le code qui l'utilise ») de coexister avec l'exception
    qui la contredit (« le squelette NestJS précède le schéma »).
    """
    index = {n["number"]: n for n in nodes}
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
        if child == parent or child not in index or parent not in index:
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
    schema = [n["number"] for n in nodes if "db:schema" in n["resources"]]
    contracts = [n["number"] for n in nodes if "contracts:shared" in n["resources"]]
    for node in nodes:
        number, ws, mod = node["number"], node["workstream"], node["module"]

        if ws in {"backend", "qa"} and "db:schema" not in node["resources"]:
            for parent in schema:
                add(number, parent, "le schéma Prisma précède le code qui l'utilise", False)

        if ws == "frontend":
            for parent in contracts:
                add(number, parent, "l'écran consomme les contrats partagés", False)
            for other in nodes:
                if other["module"] == mod and other["workstream"] == "backend":
                    add(number, other["number"], "l'écran consomme l'API du même module", False)
                if other["module"] == mod and other["workstream"] == "design":
                    add(number, other["number"], "l'écran suit sa maquette", False)

        if ws == "qa":
            for other in nodes:
                if other["module"] == mod and other["workstream"] in {"backend", "frontend"}:
                    add(number, other["number"], "le test suit ce qu'il vérifie", False)

    closing = {n["number"] for n in nodes if CLOSING.search(n["title"])}
    for number in closing:
        for other in nodes:
            if other["number"] not in closing:
                add(number, other["number"], "un jalon se clôt par sa recette", False)

    return prereqs, edges


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


def render(milestone, waves, index, excluded, edges, cut, width, closure):
    print(f"Jalon {milestone['title']} · {due_in(milestone)}")
    print(f"{milestone['open_issues']} ouvertes · {milestone['closed_issues']} fermées · "
          f"{len(index)} traitables · {len(waves)} vagues · largeur max {width}")
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

    if excluded:
        print("Écartées")
        for item in excluded:
            print(f"  #{item['number']:<4} {item['reason']} — {item['title'][:58]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("milestone", nargs="?",
                        help="titre du jalon ou un fragment (défaut : échéance la plus proche)")
    parser.add_argument("--width", type=int, default=3,
                        help="nombre maximal d'issues menées en parallèle (défaut 3)")
    parser.add_argument("--limit", type=int, default=200, help="issues lues au maximum")
    parser.add_argument("--json", action="store_true", help="sortie machine")
    parser.add_argument("--include-busy", action="store_true",
                        help="ne pas écarter les issues déjà couvertes par une PR ouverte")
    args = parser.parse_args()

    if args.width < 1:
        sys.exit("--width doit valoir au moins 1")

    milestone = resolve_milestone(args.milestone)
    issues = fetch_issues(milestone["title"], args.limit)
    if not issues:
        print(f"Jalon {milestone['title']} : aucune issue ouverte.")
        return EMPTY

    busy = {} if args.include_busy else fetch_busy()
    me = whoami()

    nodes, excluded = [], []
    for issue in issues:
        ok, reason = qualify(issue, busy, me)
        if ok:
            nodes.append(describe(issue))
        else:
            excluded.append({"number": issue["number"], "title": issue["title"],
                             "reason": reason})

    if not nodes:
        print(f"Jalon {milestone['title']} : rien de traitable "
              f"({len(excluded)} issue(s) écartée(s)).")
        for item in excluded:
            print(f"  #{item['number']:<4} {item['reason']}")
        return EMPTY

    rules = load_rules()
    for node in nodes:
        node["resources"] = resources_of(node, rules)

    prereqs, edges = build_edges(nodes, rules)
    closure = reachable_pairs(prereqs)
    unblocks = downstream(closure)
    for node in nodes:
        node["unblocks"] = unblocks[node["number"]]
        node["score"] = score(node, node["unblocks"])

    index = {n["number"]: n for n in nodes}
    waves, cut = plan_waves(nodes, prereqs, args.width)

    if args.json:
        payload = {
            "milestone": {"title": milestone["title"], "number": milestone["number"],
                          "due_on": milestone.get("due_on"),
                          "open": milestone["open_issues"],
                          "closed": milestone["closed_issues"]},
            "width": args.width,
            "waves": [
                {"index": position,
                 "issues": [{k: v for k, v in index[n].items() if k != "body"}
                            for n in numbers]}
                for position, numbers in enumerate(waves, 1)
            ],
            "edges": edges,
            "excluded": excluded,
            "cycles_cut": cut,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return OK

    render(milestone, waves, index, excluded, edges, cut, args.width, closure)
    return OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(USAGE)
