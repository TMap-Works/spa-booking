#!/usr/bin/env python3
"""Journal, état et pilotage d'un run de jalon lancé par /milestone.

    python scripts/milestone_run.py start S1 --width 3     # ouvre le run
    python scripts/milestone_run.py watch                  # tableau de bord continu
    python scripts/milestone_run.py event --ticket 19 --phase implementation \
                                          --status running --message "..."
    python scripts/milestone_run.py log --level WARN       # ce qui a mal tourné
    python scripts/milestone_run.py gate                   # continuer ? code de sortie
    python scripts/milestone_run.py shell                  # piloter le run à la main

Un run de jalon fait travailler plusieurs agents en parallèle, et le compte rendu
d'un agent n'est pas montré à l'utilisateur. Sans journal, un run est une boîte
noire de plusieurs heures.

## Deux vues, rien à relancer

`.claude/.milestone/latest.log` est un log en clair, daté et à niveaux, qui se
remplit tout seul : on l'ouvre dans un éditeur ou sous `tail -f` et on le laisse.
`watch` est un tableau de bord qui se redessine tout seul — avancement, vague en
cours avec le temps passé dans chaque phase, ce qu'il y a à reprendre.

Ce sont les agents eux-mêmes qui alimentent tout cela, via la section « Journal
d'exécution » de `.claude/commands/ticket.md`. Hors run, `event` sort sans rien
faire : la même commande sert donc au ticket isolé sans le perturber.

## Quatre fichiers, trois écrivains

`run.json` porte le plan et n'est écrit que par l'orchestrateur (`start`,
`replan`). `journal.ndjson` (machine) et `run.log` (humain) sont en **ajout
seul** : chaque agent y écrit ses propres lignes, une ligne par écriture, ce qui
rend l'écriture concurrente sûre sans verrou. `control.json` n'est écrit que par
l'humain, depuis `shell`.

L'état d'un ticket n'est donc stocké nulle part : il se **rejoue** depuis le
journal. C'est ce qui permet à cinq agents d'écrire en même temps sans qu'aucun
n'écrase l'état d'un autre.

## Reprendre, et survivre au quota

`start` **reprend** le run inachevé du jalon au lieu d'en ouvrir un nouveau —
`--fresh` pour forcer un run neuf. Avant de dire où reprendre, `reconcile`
confronte le journal à l'état réel du dépôt (issues closes, PR ouvertes ou
mergées, branches poussées) : un agent tué entre son `git push` et sa PR laisse
le journal sur `running` alors que le travail est là. Le dépôt fait foi.

La fenêtre de quota de cinq heures se referme au milieu d'un jalon. `quota hold`
inscrit la retenue et son heure de fin ; `gate` rend alors `4` et personne ne
lance d'agent ; `quota clear` la lève. C'est
[milestone_supervise.py](milestone_supervise.py) — qui vit **hors** de Claude
Code, donc survit à la coupure — qui écrit ces trois appels tout seul.

Codes de sortie de `gate` : 0 continuer · 1 pause demandée · 2 arrêt demandé ·
3 aucun run actif · 4 quota épuisé, reprise différée.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un accent dans un message de
# journal fait planter l'affichage de l'état.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = Path(__file__).resolve().parents[1]


def main_root():
    """La racine du dépôt principal, même appelé depuis un worktree lié.

    Les agents d'un run travaillent chacun dans un worktree isolé, où
    `.claude/.milestone/` n'existe pas : le dossier est ignoré par git, donc
    jamais recopié. Sans cette résolution, chaque `event` d'agent sortirait sans
    rien écrire — et le journal, qui est la seule trace visible de leur travail,
    resterait vide alors que tout semblerait marcher.
    """
    try:
        proc = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ROOT
    if proc.returncode != 0 or not proc.stdout.strip():
        return ROOT
    common = Path(proc.stdout.strip())
    if not common.is_absolute():
        common = (ROOT / common).resolve()
    candidate = common.parent
    return candidate if (candidate / ".claude").is_dir() else ROOT


# L'état d'un run appartient au dépôt principal, jamais au worktree d'un agent.
STATE_ROOT = main_root()
RUNS_DIR = STATE_ROOT / ".claude" / ".milestone"
CURRENT = RUNS_DIR / "current"
# Chemin stable, quel que soit le run : c'est celui qu'on ouvre dans un éditeur
# ou qu'on suit avec `tail -f`, sans avoir à connaître l'identifiant du run.
LATEST_LOG = RUNS_DIR / "latest.log"
PLANNER = ROOT / "scripts" / "milestone_plan.py"
# Même chemin que `permission_watch.py` et `permissions_review.py`, variable
# d'environnement comprise : trois lectures divergentes d'un même journal
# donneraient un état vide sans que personne ne s'en aperçoive.
OBSERVED = Path(os.environ.get(
    "SPA_PERMISSION_LOG",
    STATE_ROOT / ".claude" / ".permissions" / "observed.ndjson"))

LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"]
LEVEL_OF_STATUS = {
    "running": "INFO", "pr_open": "INFO", "ci_green": "INFO", "reviewed": "INFO",
    "merged": "INFO", "started": "INFO", "resumed": "INFO", "replanned": "INFO",
    "skipped": "WARN", "pause": "WARN", "stop": "WARN", "blocked": "ERROR",
    "failed": "ERROR", "reconciled": "INFO", "quota_hold": "WARN",
    "quota_cleared": "INFO", "leg_started": "INFO", "leg_ended": "INFO",
}

GO, PAUSE, STOP, NO_RUN, QUOTA = 0, 1, 2, 3, 4

# Ordre d'avancement d'un ticket. Un état plus avancé ne redescend jamais tout
# seul : seuls `failed`, `skipped` et `blocked` peuvent survenir à tout moment.
FLOW = ["pending", "running", "pr_open", "ci_green", "reviewed", "merged"]
TERMINAL = {"merged", "skipped"}
BAD = {"failed", "blocked"}
STATUSES = FLOW + ["failed", "blocked", "skipped"]

# Statuts de cycle de vie du run. Journalisables comme les autres, mais sans
# effet sur l'état d'un ticket : `replay` ne retient que ceux de STATUSES.
RUN_STATUSES = ["started", "resumed", "replanned", "reconciled", "quota_hold",
                "quota_cleared", "leg_started", "leg_ended"]

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
BRANCH_RE = re.compile(r"^(?:feature|bugfix|chore|docs)/(\d+)-")
# Seul un mot-clé de fermeture lie une PR à une issue. Un `#24` cité au fil du
# texte — « suit le même schéma que #24 » — n'est qu'une référence : le prendre
# pour un lien ferait passer l'issue 24 pour traitée, et personne n'y
# reviendrait jamais.
CLOSES_RE = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)",
                       re.IGNORECASE)

PHASES = ["recevabilite", "isolation", "prise-en-charge", "implementation",
          "validation", "commits", "pr", "ci", "revue", "merge", "cloture",
          "nettoyage", "orchestration"]

MARK = {"pending": "·", "running": "▸", "pr_open": "◇", "ci_green": "◆",
        "reviewed": "◆", "merged": "✔", "failed": "✖", "blocked": "■",
        "skipped": "—"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fail(message):
    sys.exit(message)


# --------------------------------------------------------------------------- #
# Localisation du run
# --------------------------------------------------------------------------- #

def run_dir(run_id):
    return RUNS_DIR / run_id


def run_dirs():
    """Les runs présents, du plus récent au plus ancien.

    Trier sur le nom du dossier classerait par jalon d'abord et par date
    ensuite : « le run le plus récent » deviendrait celui du jalon dernier dans
    l'alphabet. Un S2 vieux de trois semaines passerait devant le S1 d'hier —
    et `start` reprendrait le mauvais, `prune` supprimerait le bon.
    """
    if not RUNS_DIR.exists():
        return []
    found = []
    for directory in RUNS_DIR.iterdir():
        if not directory.is_dir() or not (directory / "run.json").exists():
            continue
        try:
            created = json.loads(
                (directory / "run.json").read_text(encoding="utf-8")).get("created")
        except (OSError, json.JSONDecodeError, AttributeError):
            created = None
        found.append((created or "", directory.name, directory))
    return [d for _, _, d in sorted(found, key=lambda row: (row[0], row[1]),
                                    reverse=True)]


def current_id():
    if CURRENT.exists():
        candidate = CURRENT.read_text(encoding="utf-8").strip()
        if candidate and run_dir(candidate).exists():
            return candidate
    return None


def resolve(run_id, required=True):
    """Le run demandé, le run courant, ou rien."""
    if run_id:
        if not run_dir(run_id).exists():
            matches = [d.name for d in RUNS_DIR.glob(f"*{run_id}*") if d.is_dir()]
            if len(matches) == 1:
                return matches[0]
            if required:
                fail(f"run « {run_id} » introuvable"
                     + (f" (candidats : {', '.join(matches)})" if matches else ""))
            return None
        return run_id

    found = current_id()
    if found is None and required:
        fail("aucun run en cours — `milestone_run.py start <jalon>` pour en ouvrir un")
    return found


def load_run(run_id):
    path = run_dir(run_id) / "run.json"
    if not path.exists():
        fail(f"{path} absent — run corrompu")
    return json.loads(path.read_text(encoding="utf-8"))


def load_control(run_id):
    path = run_dir(run_id) / "control.json"
    if not path.exists():
        return {"signal": "run", "skip": {}, "retry": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"signal": "run", "skip": {}, "retry": []}


def save_control(run_id, control):
    control["updated"] = now()
    (run_dir(run_id) / "control.json").write_text(
        json.dumps(control, ensure_ascii=False, indent=2), encoding="utf-8")


def read_journal(run_id):
    path = run_dir(run_id) / "journal.ndjson"
    if not path.exists():
        return []
    events = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue          # ligne tronquée par une écriture concurrente : on l'ignore
    return events


def log_line(event, short=False):
    """La forme lisible d'un événement — une ligne de log, alignée et datée.

    `short` ne garde que l'heure : dans le tableau de bord, la date est la même
    pour tout le monde et ne fait que manger la largeur utile.
    """
    stamp = (event.get("ts") or "").replace("T", " ")[11:19] if short \
        else (event.get("ts") or "").replace("T", " ")[:19]
    level = event.get("level") or LEVEL_OF_STATUS.get(event.get("status"), "INFO")
    who = f"#{event['ticket']}" if event.get("ticket") else "run"
    phase = event.get("phase") or ("orchestration" if not event.get("ticket") else "")

    message = event.get("message") or ""
    if event.get("status"):
        message = f"[{event['status']}] {message}".rstrip()
    if event.get("pr"):
        message += f"  ·  PR #{event['pr']}"
    if event.get("branch"):
        message += f"  ·  {event['branch']}"
    if event.get("actor") and event["actor"] != "agent":
        message += f"  ({event['actor']})"

    return f"{stamp}  {level:<5}  {who:<5} {phase:<16}  {message}".rstrip()


def append_journal(run_id, event):
    """Écrit l'événement deux fois : en NDJSON pour la machine, en clair pour l'humain.

    Une ligne, une écriture, en mode ajout : c'est ce qui rend sûre l'écriture
    simultanée par plusieurs agents, sans verrou. Le fichier `latest.log` reçoit
    une copie de chaque ligne — c'est le chemin stable qu'on laisse ouvert dans
    un éditeur ou sous un `tail -f` pendant tout le run.
    """
    event.setdefault("level", LEVEL_OF_STATUS.get(event.get("status"), "INFO"))
    payload = json.dumps(event, ensure_ascii=False) + "\n"
    readable = log_line(event) + "\n"

    with open(run_dir(run_id) / "journal.ndjson", "a", encoding="utf-8") as handle:
        handle.write(payload)
    for path in (run_dir(run_id) / "run.log", LATEST_LOG):
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(readable)
        except OSError:
            pass          # journaliser ne doit jamais interrompre le travail


# --------------------------------------------------------------------------- #
# Rejeu de l'état
# --------------------------------------------------------------------------- #

def advance(known, incoming):
    """Nouvel état d'un ticket au vu d'un événement.

    Un avancement ne recule jamais — un agent qui journalise `running` après
    `pr_open` a simplement rejournalisé une phase déjà passée. Un échec, un
    blocage ou un abandon prime en revanche sur tout, et repartir d'un état
    d'échec vers un état de progression est une reprise légitime.
    """
    if incoming in BAD or incoming in TERMINAL:
        return incoming
    if known in BAD:
        return incoming
    if known in FLOW and incoming in FLOW:
        return incoming if FLOW.index(incoming) >= FLOW.index(known) else known
    return incoming


def replay(run, events, control):
    """État courant de chaque ticket, reconstruit depuis le journal."""
    tickets = {}
    for wave in run["plan"]["waves"]:
        for issue in wave["issues"]:
            tickets[issue["number"]] = {
                "number": issue["number"], "title": issue["title"],
                "priority": issue["priority"], "workstream": issue["workstream"],
                "module": issue["module"], "resources": issue["resources"],
                "wave": wave["index"], "status": "pending", "phase": None,
                "pr": None, "branch": None, "last": None, "events": 0,
                "note": None,
            }

    for event in events:
        number = event.get("ticket")
        if number is None or number not in tickets:
            continue
        ticket = tickets[number]
        ticket["events"] += 1
        ticket["last"] = event.get("ts")
        if event.get("phase"):
            ticket["phase"] = event["phase"]
        if event.get("reset"):
            # Une reconciliation dit tout ce qu'elle a trouve : ce qu'elle
            # tait n'existe pas non plus dans le depot. Garder une PR que
            # le depot ignore ferait croire le ticket plus avance qu'il ne l'est.
            ticket["pr"] = event.get("pr")
            ticket["branch"] = event.get("branch")
        else:
            if event.get("pr"):
                ticket["pr"] = event["pr"]
            if event.get("branch"):
                ticket["branch"] = event["branch"]
        status = event.get("status")
        if status in STATUSES:
            # `reset` est le seul moyen de faire reculer un ticket : il vient
            # de `reconcile`, qui a lu l'etat reel du depot. Le journal peut
            # avoir tort, GitHub non.
            ticket["status"] = (status if event.get("reset")
                                else advance(ticket["status"], status))
        if event.get("message"):
            ticket["note"] = event["message"]

    for raw, reason in (control.get("skip") or {}).items():
        number = as_ticket(raw)
        if number is None:
            continue                  # jeton abîmé : l'ignorer, pas planter dessus
        if number in tickets and tickets[number]["status"] not in TERMINAL:
            tickets[number]["status"] = "skipped"
            tickets[number]["note"] = reason or "écarté à la main"

    for number in control.get("retry") or []:
        if number in tickets and tickets[number]["status"] in BAD:
            tickets[number]["status"] = "pending"
            tickets[number]["note"] = "reprise demandée"

    return tickets


def wave_state(run, tickets):
    """(vague courante, vagues terminées) — la première vague non achevée."""
    waves = []
    for wave in run["plan"]["waves"]:
        numbers = [i["number"] for i in wave["issues"]]
        states = [tickets[n]["status"] for n in numbers]
        # Une vague est achevée même si un ticket a échoué : sans cela, un seul
        # blocage retiendrait le jalon entier. L'échec reste visible.
        done = all(s in TERMINAL or s in BAD for s in states)
        started = any(s != "pending" for s in states)
        waves.append({"index": wave["index"], "numbers": numbers,
                      "done": done, "started": started,
                      "clean": done and not any(s in BAD for s in states)})
    current = next((w for w in waves if not w["done"]), None)
    return current, waves



# --------------------------------------------------------------------------- #
# Quota — la fenêtre de cinq heures du compte Claude
# --------------------------------------------------------------------------- #
#
# Un jalon dure plus longtemps qu'une fenêtre de quota. Quand elle se referme,
# la session qui orchestrait meurt : elle ne peut donc pas se rappeler
# elle-même. La retenue est écrite ici, dans un fichier que le superviseur
# — hors de Claude Code, donc vivant — relit pour savoir quand relancer, et que
# `gate` relit pour ne lancer aucun agent entre-temps.

def quota_path(run_id):
    return run_dir(run_id) / "quota.json"


def load_quota(run_id):
    path = quota_path(run_id)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def quota_hold(run_id):
    """La retenue en cours, ou None si le quota est de nouveau disponible.

    Une échéance dépassée n'est pas effacée ici : seul `quota clear` le fait,
    une fois la reprise journalisée. Lire ne modifie rien — le superviseur, le
    tableau de bord et le `gate` lisent ce fichier en même temps.
    """
    quota = load_quota(run_id)
    if quota.get("status") != "held":
        return None
    until = quota.get("until")
    if until is None or time.time() >= float(until):
        return None
    return quota


def parse_when(text):
    """Une échéance : epoch, ISO 8601, ou un délai relatif « +90m »."""
    text = (text or "").strip()
    if not text:
        fail("--until attend un instant : epoch, ISO 8601, ou +90m")
    match = re.fullmatch(r"\+(\d+)([smh])", text)
    if match:
        factor = {"s": 1, "m": 60, "h": 3600}[match.group(2)]
        return time.time() + int(match.group(1)) * factor
    try:
        return float(text)
    except ValueError:
        pass
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        fail(f"échéance illisible : {text}")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def local_hm(epoch):
    return datetime.fromtimestamp(float(epoch)).strftime("%H:%M")


def cmd_quota(args):
    run_id = resolve(args.run)

    if args.action == "hold":
        until = parse_when(args.until)
        quota = {
            "status": "held", "until": until, "since": now(),
            "until_iso": datetime.fromtimestamp(until, timezone.utc)
                                 .isoformat(timespec="seconds"),
            "kind": args.kind, "reason": args.reason or "",
            "utilization": args.utilization,
        }
        quota_path(run_id).write_text(
            json.dumps(quota, ensure_ascii=False, indent=2), encoding="utf-8")
        append_journal(run_id, {
            "ts": now(), "kind": "run", "status": "quota_hold",
            "actor": args.actor,
            "message": f"quota {args.kind} épuisé — reprise à {local_hm(until)}"
                       + (f" ({args.reason})" if args.reason else "")})
        print(f"run en attente de quota jusqu'à {local_hm(until)} "
              f"({human_delta(until - time.time())})")
        return QUOTA

    if args.action == "clear":
        quota = load_quota(run_id)
        quota_path(run_id).write_text(
            json.dumps({"status": "clear", "cleared": now(),
                        "previous": quota or None},
                       ensure_ascii=False, indent=2), encoding="utf-8")
        append_journal(run_id, {
            "ts": now(), "kind": "run", "status": "quota_cleared",
            "actor": args.actor,
            "message": "quota reconstitué"
                       + (f", attente ouverte le {quota['since']}"
                          if quota.get("since") else "")})
        print("quota reconstitué — le run peut repartir")
        return GO

    hold = quota_hold(run_id)
    if args.json:
        print(json.dumps(hold or load_quota(run_id) or {"status": "clear"},
                         ensure_ascii=False, indent=2))
        return QUOTA if hold else GO
    if not hold:
        print("quota disponible")
        return GO
    print(f"quota {hold.get('kind') or 'five_hour'} épuisé depuis {hold.get('since')}")
    print(f"reprise automatique à {local_hm(hold['until'])} — dans "
          f"{human_delta(float(hold['until']) - time.time())}")
    if hold.get("reason"):
        print(hold["reason"])
    return QUOTA


# --------------------------------------------------------------------------- #
# Vérité GitHub — ce que le journal ne peut pas savoir
# --------------------------------------------------------------------------- #

def gh_json(args):
    """(données, erreur) — jamais une sortie du programme.

    Une réconciliation qui échoue ne doit pas empêcher la reprise : on repart
    alors du seul journal, en le disant.
    """
    try:
        proc = subprocess.run(["gh"] + args, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"gh indisponible ({exc})"
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip()
    try:
        return json.loads(proc.stdout or "[]"), None
    except json.JSONDecodeError:
        return None, "réponse gh illisible"


def remote_branches():
    """Numéro d'issue → branche poussée sur origin."""
    try:
        proc = subprocess.run(["git", "ls-remote", "--heads", "origin"], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
    except (OSError, subprocess.SubprocessError):
        return {}
    if proc.returncode != 0:
        return {}
    found = {}
    for line in proc.stdout.splitlines():
        _, _, ref = line.partition("refs/heads/")
        match = BRANCH_RE.match(ref.strip())
        if match:
            found.setdefault(int(match.group(1)), ref.strip())
    return found


def pr_by_issue(prs):
    """Numéro d'issue → la PR qui la porte, la plus avancée l'emportant."""
    rank = {"MERGED": 3, "OPEN": 2, "CLOSED": 1}
    found = {}
    for pr in prs:
        numbers = set()
        match = BRANCH_RE.match(pr.get("headRefName") or "")
        if match:
            numbers.add(int(match.group(1)))
        numbers |= {int(n) for n in CLOSES_RE.findall(pr.get("body") or "")}
        for number in numbers:
            best = found.get(number)
            if best is None or rank.get(pr.get("state"), 0) > rank.get(best.get("state"), 0):
                found[number] = pr
    return found


def cmd_reconcile(args):
    """Confronte l'état journalisé à l'état réel du dépôt, et corrige le journal.

    C'est ce qui permet de reprendre sans rien demander à l'humain. Un agent tué
    entre son `git push` et l'ouverture de sa PR laisse le journal sur
    `running` alors que la branche existe ; un autre, tué juste après le merge,
    laisse un ticket en `pr_open` alors qu'il est fini. Trois appels — issues,
    PR, branches distantes — suffisent à trancher, et le dépôt a toujours
    raison contre le journal.
    """
    run_id = resolve(args.run)
    run = load_run(run_id)
    control = load_control(run_id)
    tickets = replay(run, read_journal(run_id), control)
    pending = {n: t for n, t in tickets.items() if t["status"] not in TERMINAL}
    if not pending:
        print("rien à réconcilier — aucun ticket ouvert")
        return GO

    issues, error = gh_json(["issue", "list", "--repo", REPO,
                             "--milestone", run["milestone"], "--state", "all",
                             "--limit", "300", "--json", "number,state"])
    if error:
        print(f"GitHub injoignable ({error}) — reprise sur le seul journal",
              file=sys.stderr)
        return GO
    prs, error = gh_json(["pr", "list", "--repo", REPO, "--state", "all",
                          "--limit", "200",
                          "--json", "number,body,headRefName,state"])
    if error:
        print(f"pull requests illisibles ({error}) — reprise sur le seul journal",
              file=sys.stderr)
        return GO

    issue_state = {i["number"]: i["state"] for i in issues}
    carried = pr_by_issue(prs)
    branches = remote_branches()

    corrections = []
    for number, ticket in sorted(pending.items()):
        pr = carried.get(number)
        branch = branches.get(number)

        if issue_state.get(number) == "CLOSED":
            target, why = "merged", "issue close sur GitHub"
        elif pr and pr["state"] == "MERGED":
            target, why = "merged", f"PR #{pr['number']} déjà mergée"
        elif pr and pr["state"] == "OPEN":
            target, why = "pr_open", f"PR #{pr['number']} ouverte"
        elif branch:
            target, why = "running", f"branche {branch} poussée, aucune PR"
        else:
            target, why = "pending", "ni branche ni PR — jamais démarré"

        # GitHub ne connaît que trois états ; le journal en connaît six. Un ticket
        # dont l'agent avait journalisé `ci_green` puis `reviewed` avant d'être tué
        # a bien une PR ouverte — le ramener à `pr_open` ferait refaire la CI et la
        # revue à chaque reprise. Un état déjà plus avancé que ce que le dépôt sait
        # dire n'est donc pas une divergence.
        avance = (target in FLOW and ticket["status"] in FLOW
                  and FLOW.index(ticket["status"]) > FLOW.index(target))
        if target == ticket["status"] or avance:
            # Rien à corriger sur l'état. Reste à noter la PR si le journal ne la
            # connaissait pas — sans `reset`, qui ferait reculer le ticket.
            if pr and ticket["pr"] != pr["number"]:
                append_journal(run_id, {
                    "ts": now(), "kind": "ticket", "ticket": number,
                    "phase": "orchestration", "actor": "reconcile",
                    "pr": pr["number"], "branch": branch,
                    "message": f"PR #{pr['number']} rattachée au ticket"})
            continue

        event = {"ts": now(), "kind": "ticket", "ticket": number,
                 "phase": "orchestration", "status": target, "reset": True,
                 "actor": "reconcile", "message": why}
        if pr:
            event["pr"] = pr["number"]
        if branch:
            event["branch"] = branch
        append_journal(run_id, event)
        corrections.append((number, ticket["status"], target, why))

    append_journal(run_id, {"ts": now(), "kind": "run", "status": "reconciled",
                            "actor": "reconcile",
                            "message": f"{len(corrections)} correction(s) sur "
                                       f"{len(pending)} ticket(s) ouverts"})
    if not corrections:
        print(f"journal conforme au dépôt ({len(pending)} ticket(s) ouverts)")
        return GO
    print(f"{len(corrections)} correction(s) — le dépôt fait foi :")
    for number, was, target, why in corrections:
        print(f"  #{number:<4} {was} → {target:<9} {why}")
    return GO


# --------------------------------------------------------------------------- #
# Commandes
# --------------------------------------------------------------------------- #

def plan_json(milestone, width):
    proc = subprocess.run(
        [sys.executable, str(PLANNER), *( [milestone] if milestone else [] ),
         "--width", str(width), "--json"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        fail("le plan n'a pas pu être calculé :\n" + (proc.stderr or proc.stdout).strip())
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        fail("plan illisible — `milestone_plan.py --json` n'a pas rendu du JSON")


def unfinished_run(milestone):
    """Le run le plus récent sur ce jalon qui n'est pas allé au bout.

    Un run arrêté à la main (`stop`) n'est pas repris : l'humain a tranché.
    """
    needle = (milestone or "").strip().lower()
    for directory in run_dirs():
        try:
            run = json.loads((directory / "run.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if needle and needle not in run.get("milestone", "").lower():
            continue
        control = load_control(directory.name)
        if control.get("signal") == "stop":
            continue
        tickets = replay(run, read_journal(directory.name), control)
        current, _ = wave_state(run, tickets)
        if current is not None:
            return directory.name
    return None


def arm_supervision(milestone, args):
    """Arme la reprise automatique — la veille qui survit à cette session.

    Un jalon dure plus longtemps que la fenêtre de quota de cinq heures, et la
    session qui l'orchestre meurt avec elle. Armer ici plutôt que de compter sur
    un lancement à la main est le seul moyen d'y survivre : à partir de cet
    instant, plus rien n'est à relancer, quoi qu'il arrive.
    """
    if getattr(args, "no_watchdog", False):
        print("veille non armée (--no-watchdog) : la reprise après une coupure "
              "de quota devra être relancée à la main")
        return
    command = [sys.executable, str(ROOT / "scripts" / "milestone_supervise.py"),
               "--arm", "--width", str(args.width)]
    if milestone:
        command.append(milestone)
    if getattr(args, "no_merge", False):
        command.append("--no-merge")
    try:
        proc = subprocess.run(command, cwd=ROOT, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"veille non armée ({exc}) — la reprise restera manuelle",
              file=sys.stderr)
        return
    output = (proc.stdout or proc.stderr).strip()
    if proc.returncode != 0:
        print(f"veille non armée — la reprise restera manuelle\n{output}",
              file=sys.stderr)
        return
    for line in output.splitlines():
        print(line)
    print("reprise automatique armée : quota, plantage ou redémarrage, le run "
          "repart tout seul")


def cmd_start(args):
    # Reprendre est le cas courant : un jalon dure plus longtemps qu'une session,
    # et rouvrir un run repartirait de zéro sur des tickets déjà en PR. Il faut
    # dire `--fresh` pour en ouvrir un nouveau — jamais l'inverse.
    if not args.fresh:
        existing = unfinished_run(args.milestone)
        if existing:
            CURRENT.write_text(existing, encoding="utf-8")
            run = load_run(existing)
            try:
                with open(LATEST_LOG, "a", encoding="utf-8") as handle:
                    handle.write(f"# reprise du run {existing} le {now()}\n")
            except OSError:
                pass
            append_journal(existing, {"ts": now(), "kind": "run", "status": "resumed",
                                      "actor": "orchestrateur",
                                      "message": "run inachevé repris automatiquement"})
            print(f"run {existing} repris · {run['milestone']}")
            print("(`start --fresh` pour en ouvrir un nouveau à la place)\n")
            arm_supervision(run["milestone"], args)
            print()
            return cmd_resume(argparse.Namespace(
                run=existing, no_reconcile=getattr(args, "no_reconcile", False)))

    plan = plan_json(args.milestone, args.width)
    slug = re.sub(r"[^a-z0-9]+", "-", plan["milestone"]["title"].lower()).strip("-")[:24]
    run_id = f"{slug}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

    directory = run_dir(run_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "run.json").write_text(json.dumps({
        "id": run_id, "milestone": plan["milestone"]["title"],
        "width": args.width, "created": now(), "plan": plan,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    CURRENT.write_text(run_id, encoding="utf-8")

    total = sum(len(w["issues"]) for w in plan["waves"])
    # `latest.log` appartient au run en cours : on repart d'un fichier vierge,
    # l'historique restant dans le run.log de chaque run.
    LATEST_LOG.write_text(
        f"# {plan['milestone']['title']} · run {run_id} · ouvert le {now()}\n"
        f"# {total} tickets · {len(plan['waves'])} vagues · largeur {args.width}\n",
        encoding="utf-8")
    append_journal(run_id, {"ts": now(), "kind": "run", "status": "started",
                            "actor": "orchestrateur",
                            "message": f"{len(plan['waves'])} vagues, largeur {args.width}"})
    prune(args.keep)

    print(f"run {run_id}")
    print(f"{plan['milestone']['title']} · {total} tickets · {len(plan['waves'])} vagues "
          f"· largeur {args.width}")
    print(f"log    {LATEST_LOG}")
    print(f"suivre python scripts/milestone_run.py watch")
    arm_supervision(plan["milestone"]["title"], args)
    return GO


def prune(keep):
    """Ne garde que les `keep` runs les plus récents — le reste encombre."""
    for directory in run_dirs()[keep:]:
        try:
            shutil.rmtree(directory)
        except OSError:
            pass


def cmd_replan(args):
    run_id = resolve(args.run)
    run = load_run(run_id)
    plan = plan_json(run["milestone"], args.width or run["width"])
    run["plan"] = plan
    run["width"] = args.width or run["width"]
    (run_dir(run_id) / "run.json").write_text(
        json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(len(w["issues"]) for w in plan["waves"])
    append_journal(run_id, {"ts": now(), "kind": "run", "status": "replanned",
                            "actor": "orchestrateur",
                            "message": f"{total} tickets restants, {len(plan['waves'])} vagues"})
    print(f"plan recalculé : {total} tickets restants, {len(plan['waves'])} vagues")
    return GO


def cmd_event(args):
    run_id = resolve(args.run, required=False)
    if run_id is None:
        # Un agent lancé hors run (via /ticket seul) ne doit pas être dérailé.
        print("aucun run en cours — événement ignoré", file=sys.stderr)
        return GO

    event = {"ts": now(), "kind": "ticket" if args.ticket else "run",
             "actor": args.actor}
    for name in ("ticket", "wave", "phase", "status", "message", "pr", "branch",
                 "level"):
        value = getattr(args, name, None)
        if value is not None:
            event[name] = value
    if getattr(args, "reset", False):
        event["reset"] = True
    append_journal(run_id, event)

    if not args.quiet:
        label = f"#{args.ticket}" if args.ticket else "run"
        print(f"{label} {args.phase or ''} {args.status or ''}".strip())
    return GO


def cmd_gate(args):
    run_id = resolve(args.run, required=False)
    if run_id is None:
        print("aucun run en cours")
        return NO_RUN

    control = load_control(run_id)
    run = load_run(run_id)
    tickets = replay(run, read_journal(run_id), control)
    current, waves = wave_state(run, tickets)

    for number, reason in (control.get("skip") or {}).items():
        print(f"écarter #{number} · {reason or 'décision humaine'}")
    for number in control.get("retry") or []:
        print(f"reprendre #{number}")

    signal = control.get("signal", "run")
    if signal == "stop":
        print("arrêt demandé — clore le run, ne pas lancer d'agent")
        return STOP

    # Avant la décision humaine, la contrainte matérielle : sans quota, un agent
    # lancé maintenant mourra au milieu de son ticket et laissera une branche
    # sans PR. Mieux vaut ne pas le lancer et laisser le superviseur attendre.
    hold = quota_hold(run_id)
    if hold:
        print(f"quota {hold.get('kind') or 'five_hour'} épuisé — ne lancer aucun "
              f"agent ; reprise automatique à {local_hm(hold['until'])} "
              f"(dans {human_delta(float(hold['until']) - time.time())})")
        return QUOTA

    if signal == "pause":
        print("pause demandée — terminer la vague en cours, ne pas en lancer d'autre")
        return PAUSE

    if current is None:
        print("toutes les vagues sont achevées")
        return NO_RUN

    ready = [n for n in current["numbers"] if tickets[n]["status"] == "pending"]
    print(f"vague {current['index']} · {len(ready)} ticket(s) à lancer : "
          + (", ".join(f"#{n}" for n in ready) or "aucun"))
    return GO


def cmd_status(args):
    run_id = resolve(args.run)
    run = load_run(run_id)
    control = load_control(run_id)
    tickets = replay(run, read_journal(run_id), control)
    current, waves = wave_state(run, tickets)

    if args.json:
        print(json.dumps({"run": run_id, "milestone": run["milestone"],
                          "signal": control.get("signal", "run"),
                          "current_wave": current["index"] if current else None,
                          "tickets": list(tickets.values())},
                         ensure_ascii=False, indent=2))
        return GO

    counts = {}
    for ticket in tickets.values():
        counts[ticket["status"]] = counts.get(ticket["status"], 0) + 1
    summary = " · ".join(f"{count} {status}" for status, count in sorted(counts.items()))

    print(f"run {run_id} · {run['milestone']} · signal {control.get('signal', 'run')}")
    print(f"{len(tickets)} tickets · {summary}")
    print()

    for wave in waves:
        if wave["done"]:
            mark = "✔" if wave["clean"] else "!"
        else:
            mark = "▸" if wave["started"] else "·"
        print(f"{mark} Vague {wave['index']}")
        for number in wave["numbers"]:
            ticket = tickets[number]
            extra = []
            if ticket["pr"]:
                extra.append(f"PR #{ticket['pr']}")
            if ticket["phase"]:
                extra.append(ticket["phase"])
            if ticket["note"]:
                extra.append(ticket["note"][:60])
            title = ticket["title"][:44]
            print(f"    {MARK.get(ticket['status'], '?')} #{number:<4} "
                  f"{ticket['status']:<9} {title:<44} {' · '.join(extra)}")
        print()

    observations = permission_observations(run_id)
    if observations:
        print(f"{len(observations)} commande(s) ont demandé une permission pendant ce run "
              f"— `python scripts/permissions_review.py`")
    return GO


def cmd_progress(args):
    """Combien de tickets ont abouti depuis l'ouverture du run.

    Mesuré sur le journal, jamais sur le plan : `replan` retire du plan les
    issues closes, si bien qu'un décompte fondé sur le plan retomberait à zéro
    après chaque vague réussie. Le superviseur en conclurait que le run piétine
    et se débrancherait au bout de quelques vagues — précisément quand tout va
    bien. Le journal, lui, est en ajout seul : ce compte ne recule jamais.

    `--pr-open` compte aussi les tickets arrivés en PR : c'est le seul
    avancement observable quand le run tourne en `--no-merge`, où rien ne se
    ferme jamais.
    """
    run_id = resolve(args.run)
    counted = {"merged", "skipped"}
    if args.pr_open:
        counted |= {"pr_open", "ci_green", "reviewed"}
    reached = {event["ticket"] for event in read_journal(run_id)
               if event.get("ticket") is not None and event.get("status") in counted}
    print(len(reached))
    return GO


def cmd_log(args):
    run_id = resolve(args.run)
    events = read_journal(run_id)
    if args.ticket:
        events = [e for e in events if e.get("ticket") == args.ticket]
    if args.phase:
        events = [e for e in events if e.get("phase") == args.phase]
    if args.tail:
        events = events[-args.tail:]
    if args.level:
        floor = LEVELS.index(args.level)
        events = [e for e in events
                  if LEVELS.index(e.get("level") or "INFO") >= floor]
    for event in events:
        print(log_line(event))
    if not events:
        print("journal vide pour ce filtre")
    return GO


def cmd_signal(args, signal):
    run_id = resolve(args.run)
    control = load_control(run_id)
    control["signal"] = signal
    save_control(run_id, control)
    append_journal(run_id, {"ts": now(), "kind": "run", "status": signal,
                            "actor": "humain"})
    print({"pause": "pause demandée — prendra effet à la fin de la vague en cours",
           "stop": "arrêt demandé — aucun nouvel agent ne sera lancé",
           "run": "run relancé"}[signal])
    return GO


def cmd_resume(args):
    run_id = resolve(args.run)
    # Le journal dit ce que les agents ont eu le temps d'écrire ; le dépôt dit ce
    # qui existe vraiment. On aligne le premier sur le second avant de décider
    # quoi que ce soit — sans quoi la reprise relancerait un ticket déjà en PR.
    if not getattr(args, "no_reconcile", False):
        cmd_reconcile(argparse.Namespace(run=run_id))
        print()
    control = load_control(run_id)
    control["signal"] = "run"
    save_control(run_id, control)
    run = load_run(run_id)
    tickets = replay(run, read_journal(run_id), control)
    current, _ = wave_state(run, tickets)
    append_journal(run_id, {"ts": now(), "kind": "run", "status": "resumed",
                            "actor": "humain"})

    print(f"run {run_id} · {run['milestone']}")
    if current is None:
        print("toutes les vagues sont achevées — rien à reprendre")
        return NO_RUN
    pending = [n for n in current["numbers"] if tickets[n]["status"] == "pending"]
    started = [n for n in current["numbers"]
               if tickets[n]["status"] not in TERMINAL and tickets[n]["status"] != "pending"]
    print(f"reprendre à la vague {current['index']}")
    if started:
        print("  déjà engagés (état confirmé sur GitHub) : "
              + ", ".join(f"#{n} ({tickets[n]['status']})" for n in started))
    if pending:
        print("  à lancer : " + ", ".join(f"#{n}" for n in pending))

    hold = quota_hold(run_id)
    if hold:
        print(f"\nquota épuisé — reprise possible à {local_hm(hold['until'])}, "
              f"dans {human_delta(float(hold['until']) - time.time())}")
    print("\nDans Claude Code : `/milestone` — la reprise est automatique.")
    print("Sans surveillance, quota compris : "
          "`python scripts/milestone_supervise.py`")
    return GO


def cmd_list(args):
    if not RUNS_DIR.exists():
        print("aucun run")
        return NO_RUN
    active = current_id()
    rows = []
    for directory in run_dirs():
        run = json.loads((directory / "run.json").read_text(encoding="utf-8"))
        control = load_control(directory.name)
        tickets = replay(run, read_journal(directory.name), control)
        done = sum(1 for t in tickets.values() if t["status"] in TERMINAL)
        rows.append((directory.name, run["milestone"], done, len(tickets),
                     control.get("signal", "run"), directory.name == active))
    if not rows:
        print("aucun run")
        return NO_RUN
    for name, milestone, done, total, signal, is_current in rows:
        print(f"{'*' if is_current else ' '} {name:<34} {milestone:<38} "
              f"{done}/{total} · {signal}")
    return GO


def permission_observations(run_id):
    if not OBSERVED.exists():
        return []
    out = []
    for line in OBSERVED.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("run") == run_id:
            out.append(record)
    return out


# --------------------------------------------------------------------------- #
# Shell interactif
# --------------------------------------------------------------------------- #

HELP = """\
  status              état du run, vague par vague
  plan                le plan courant
  log [N] [-n K]      journal, filtré sur le ticket N
  watch               tableau de bord rafraîchi en continu (Ctrl-C pour sortir)
  tail                défilement brut du log, ligne à ligne
  perms               commandes ayant demandé une permission pendant ce run
  quota               état du quota, et quand le run repartira
  quota clear         lever la retenue de quota sans attendre
  reconcile           réaligner le journal sur l'état réel du dépôt
  pause               s'arrêter à la fin de la vague en cours
  stop                s'arrêter sans lancer d'autre agent
  go                  lever la pause et reprendre
  skip N [raison]     écarter un ticket du run
  retry N             relancer un ticket en échec
  note N <texte>      annoter un ticket dans le journal
  runs                tous les runs connus
  help                cet écran
  quit                sortir (le run n'est pas arrêté)
"""


def as_ticket(token):
    """Le numéro d'issue porté par ce jeton, ou None — `#19` compris."""
    if not token:
        return None
    try:
        return int(str(token).lstrip("#"))
    except (TypeError, ValueError):
        return None


def cmd_shell(args):
    run_id = resolve(args.run)
    run = load_run(run_id)
    print(f"run {run_id} · {run['milestone']}")
    print("`help` pour les commandes · `quit` pour sortir sans arrêter le run\n")

    while True:
        try:
            raw = input("milestone> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return GO
        if not raw:
            continue

        parts = raw.split()
        verb, rest = parts[0].lower(), parts[1:]
        namespace = argparse.Namespace(run=run_id, json=False, tail=None,
                                       ticket=None, phase=None, level=None,
                                       lines=14, interval=2)

        try:
            if verb in {"quit", "q", "exit"}:
                return GO
            if verb in {"help", "?", "h"}:
                print(HELP)
            elif verb in {"status", "s"}:
                cmd_status(namespace)
            elif verb == "plan":
                show_plan(run_id)
            elif verb == "log":
                if rest and rest[0].isdigit():
                    namespace.ticket = int(rest[0])
                    rest = rest[1:]
                if "-n" in rest:
                    namespace.tail = int(rest[rest.index("-n") + 1])
                elif namespace.ticket is None:
                    namespace.tail = 30
                cmd_log(namespace)
            elif verb == "watch":
                cmd_watch(namespace)
            elif verb == "tail":
                tail(run_id)
            elif verb == "perms":
                show_perms(run_id)
            elif verb == "quota":
                cmd_quota(argparse.Namespace(
                    run=run_id, json=False, actor="humain",
                    action="clear" if rest and rest[0] == "clear" else "state",
                    until=None, kind="five_hour", reason=None, utilization=None))
            elif verb == "reconcile":
                cmd_reconcile(namespace)
            elif verb in {"pause", "stop"}:
                cmd_signal(namespace, verb)
            elif verb == "go":
                cmd_signal(namespace, "run")
            elif verb == "skip":
                # Valider avant d'écrire : `control.json` est relu par `replay` à
                # chaque appel, et un jeton non numérique y ferait planter status,
                # gate, watch et resume jusqu'à correction du fichier à la main.
                number = as_ticket(rest[0] if rest else None)
                if number is None:
                    print("skip N [raison] — N est un numéro d'issue")
                    continue
                reason = " ".join(rest[1:])
                control = load_control(run_id)
                control.setdefault("skip", {})[str(number)] = reason
                save_control(run_id, control)
                append_journal(run_id, {"ts": now(), "kind": "ticket",
                                        "ticket": number, "status": "skipped",
                                        "actor": "humain",
                                        "message": reason or "écarté à la main"})
                print(f"#{number} écarté — l'orchestrateur le verra au prochain `gate`")
            elif verb == "retry":
                number = as_ticket(rest[0] if rest else None)
                if number is None:
                    print("retry N — N est un numéro d'issue")
                    continue
                control = load_control(run_id)
                control["retry"] = sorted(set(control.get("retry") or []) | {number})
                control.get("skip", {}).pop(str(number), None)
                save_control(run_id, control)
                # `skip` a journalisé un statut terminal, que `replay` n'annule
                # pas : sans cette ligne, « sera relancé » serait un mensonge et
                # le ticket disparaîtrait du jalon.
                append_journal(run_id, {"ts": now(), "kind": "ticket",
                                        "ticket": number, "status": "pending",
                                        "reset": True, "actor": "humain",
                                        "message": "remis en file à la main"})
                print(f"#{number} sera relancé à la prochaine vague")
            elif verb == "note":
                number = as_ticket(rest[0] if rest else None)
                if number is None or len(rest) < 2:
                    print("note N <texte> — N est un numéro d'issue")
                    continue
                append_journal(run_id, {"ts": now(), "kind": "ticket",
                                        "ticket": number, "actor": "humain",
                                        "message": " ".join(rest[1:])})
                print("noté")
            elif verb == "runs":
                cmd_list(namespace)
            else:
                print(f"commande inconnue : {verb} — `help`")
        except SystemExit as exc:            # une sous-commande a appelé fail()
            if exc.code not in (0, GO, PAUSE, STOP, NO_RUN):
                print(exc.code)
        except Exception as exc:             # le shell ne meurt pas sur une faute de frappe
            print(f"erreur : {exc}")


def show_plan(run_id):
    run = load_run(run_id)
    for wave in run["plan"]["waves"]:
        mode = "seule" if len(wave["issues"]) == 1 else f"{len(wave['issues'])} en parallèle"
        print(f"Vague {wave['index']} · {mode}")
        for issue in wave["issues"]:
            print(f"    #{issue['number']:<4} {issue['priority']} "
                  f"{issue['workstream']:<8} {issue['title'][:52]}")


def show_perms(run_id):
    records = permission_observations(run_id)
    if not records:
        print("aucune commande n'a demandé de permission pendant ce run")
        return
    counts = {}
    for record in records:
        counts[record["pattern"]] = counts.get(record["pattern"], 0) + 1
    for pattern, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {count:>3}×  {pattern}")
    print("\n`python scripts/permissions_review.py` pour les autoriser durablement")


def tail(run_id):
    """Suit le journal en direct — l'équivalent d'un `tail -f` portable."""
    path = run_dir(run_id) / "run.log"
    print("(Ctrl-C pour revenir au shell)")
    position = path.stat().st_size if path.exists() else 0
    try:
        while True:
            if path.exists() and path.stat().st_size > position:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(position)
                    for line in handle:
                        if line.strip():
                            print(line.rstrip())
                    position = handle.tell()
            time.sleep(1)
    except KeyboardInterrupt:
        print()


# --------------------------------------------------------------------------- #
# Tableau de bord — la vue qu'on laisse ouverte pendant tout le run
# --------------------------------------------------------------------------- #

COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
TINT = {"merged": 32, "ci_green": 32, "reviewed": 32, "running": 36,
        "pr_open": 36, "failed": 31, "blocked": 31, "skipped": 33,
        "pending": 90, "ERROR": 31, "WARN": 33, "DEBUG": 90}


def paint(text, key):
    code = TINT.get(key)
    return f"\x1b[{code}m{text}\x1b[0m" if COLOR and code else text


def human_delta(seconds):
    if seconds is None:
        return "—"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02d}"
    return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}"


def age(iso):
    if not iso:
        return None
    try:
        return (datetime.now(timezone.utc)
                - datetime.fromisoformat(iso)).total_seconds()
    except ValueError:
        return None


def bar(done, total, width=28):
    filled = 0 if not total else round(width * done / total)
    return "█" * filled + "░" * (width - filled)


def dashboard(run_id, lines):
    """Une image de l'état du run, à réafficher telle quelle."""
    run = load_run(run_id)
    control = load_control(run_id)
    events = read_journal(run_id)
    tickets = replay(run, events, control)
    current, waves = wave_state(run, tickets)
    columns = max(60, shutil.get_terminal_size((110, 30)).columns - 1)

    done = sum(1 for t in tickets.values() if t["status"] in TERMINAL)
    failed = [t for t in tickets.values() if t["status"] in BAD]
    active = [t for t in tickets.values()
              if t["status"] not in TERMINAL and t["status"] not in BAD
              and t["status"] != "pending"]
    signal = control.get("signal", "run")

    out = []
    header = (f" {run['milestone']}  ·  {run_id}  ·  {human_delta(age(run['created']))} "
              f" ·  signal {signal}")
    out.append(paint(header, "WARN" if signal != "run" else None))
    out.append(f" {bar(done, len(tickets))}  {done}/{len(tickets)} tickets  ·  "
               f"vague {current['index'] if current else '—'}/{len(waves)}  ·  "
               f"{len(active)} agent(s) au travail"
               + (f"  ·  {paint(str(len(failed)) + ' en échec', 'failed')}" if failed else ""))

    hold = quota_hold(run_id)
    if hold:
        left = human_delta(float(hold["until"]) - time.time())
        out.append(paint(f" ⏸  quota {hold.get('kind') or 'five_hour'} épuisé  ·  "
                         f"reprise automatique à {local_hm(hold['until'])}  ·  "
                         f"dans {left}", "WARN"))
    out.append("")

    if current:
        out.append(f" VAGUE {current['index']}")
        for number in current["numbers"]:
            ticket = tickets[number]
            since = human_delta(age(ticket["last"])) if ticket["last"] else "—"
            mark = paint(MARK.get(ticket["status"], "?"), ticket["status"])
            state = paint(f"{ticket['status']:<9}", ticket["status"])
            phase = (ticket["phase"] or "")[:15]
            pr = f"PR #{ticket['pr']}" if ticket["pr"] else ""
            title = ticket["title"][:40]
            out.append(f"   {mark} #{number:<4} {state} {phase:<15} {since:>6}  "
                       f"{title:<40} {pr}")
        out.append("")

    if failed:
        out.append(" À REPRENDRE")
        for ticket in failed:
            out.append(paint(f"   ✖ #{ticket['number']:<4} {ticket['note'] or ''}"[:columns],
                             "failed"))
        out.append("")

    out.append(" JOURNAL")
    for event in events[-lines:]:
        level = event.get("level") or "INFO"
        out.append("   " + paint(log_line(event, short=True)[:columns - 4], level))

    out.append("")
    out.append(paint(" milestone_run.py shell pour agir  ·  Ctrl-C pour sortir", "DEBUG"))
    return "\n".join(line[:columns] if "\x1b" not in line else line for line in out)


def cmd_watch(args):
    run_id = resolve(args.run)
    if os.name == "nt":
        os.system("")          # active le traitement des séquences ANSI sous Windows
    try:
        while True:
            frame = dashboard(run_id, args.lines)
            sys.stdout.write("\x1b[H\x1b[J" + frame + "\n")
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        return GO


def cmd_path(args):
    run_id = resolve(args.run)
    print(f"log courant  {LATEST_LOG}")
    print(f"log du run   {run_dir(run_id) / 'run.log'}")
    print(f"journal      {run_dir(run_id) / 'journal.ndjson'}")
    print(f"plan         {run_dir(run_id) / 'run.json'}")
    return GO


# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    starter = sub.add_parser("start", help="ouvre un run sur un jalon")
    starter.add_argument("milestone", nargs="?")
    starter.add_argument("--width", type=int, default=3)
    starter.add_argument("--keep", type=int, default=10,
                         help="nombre de runs conservés sur le disque")
    starter.add_argument("--fresh", action="store_true",
                         help="ouvrir un run neuf au lieu de reprendre l'inachevé")
    starter.add_argument("--no-reconcile", action="store_true",
                         help="à la reprise, ne pas interroger GitHub")
    starter.add_argument("--no-merge", action="store_true",
                         help="la reprise automatique s'arrêtera aux PR, sans merger")
    starter.add_argument("--no-watchdog", action="store_true",
                         help="ne pas armer la reprise automatique")

    replanner = sub.add_parser("replan", help="recalcule le plan des tickets restants")
    replanner.add_argument("--run")
    replanner.add_argument("--width", type=int)

    eventer = sub.add_parser("event", help="journalise une étape")
    eventer.add_argument("--run")
    eventer.add_argument("--ticket", type=int)
    eventer.add_argument("--wave", type=int)
    eventer.add_argument("--phase", choices=PHASES)
    eventer.add_argument("--status", choices=STATUSES + RUN_STATUSES)
    eventer.add_argument("--message")
    eventer.add_argument("--pr", type=int)
    eventer.add_argument("--branch")
    eventer.add_argument("--level", choices=LEVELS,
                         help="défaut : déduit du statut, INFO sans statut")
    eventer.add_argument("--actor", default="agent")
    eventer.add_argument("--quiet", action="store_true")
    eventer.add_argument("--reset", action="store_true",
                         help="autorise le statut à faire reculer le ticket")

    for name, helptext in [("gate", "peut-on continuer ? code de sortie"),
                           ("shell", "piloter le run à la main"),
                           ("reconcile", "réaligner le journal sur l'état du dépôt")]:
        node = sub.add_parser(name, help=helptext)
        node.add_argument("--run")

    resumer = sub.add_parser("resume", help="que reprendre, et où")
    resumer.add_argument("--run")
    resumer.add_argument("--no-reconcile", action="store_true",
                         help="ne pas interroger GitHub avant de répondre")

    quota = sub.add_parser("quota", help="la fenêtre de quota du compte Claude")
    quota.add_argument("action", nargs="?", default="state",
                       choices=["state", "hold", "clear"])
    quota.add_argument("--run")
    quota.add_argument("--until",
                       help="fin de la retenue : epoch, ISO 8601, ou +90m")
    quota.add_argument("--kind", default="five_hour",
                       help="fenêtre en cause (five_hour, seven_day, overage)")
    quota.add_argument("--reason")
    quota.add_argument("--utilization", type=float)
    quota.add_argument("--actor", default="superviseur")
    quota.add_argument("--json", action="store_true")

    progress = sub.add_parser("progress",
                              help="nombre de tickets aboutis depuis l'ouverture")
    progress.add_argument("--run")
    progress.add_argument("--pr-open", action="store_true",
                          help="compter aussi les tickets arrivés en PR")

    viewer = sub.add_parser("status", help="état du run")
    viewer.add_argument("--run")
    viewer.add_argument("--json", action="store_true")

    logger = sub.add_parser("log", help="journal du run")
    logger.add_argument("--run")
    logger.add_argument("--ticket", type=int)
    logger.add_argument("--phase", choices=PHASES)
    logger.add_argument("--level", choices=LEVELS, help="ce niveau et au-dessus")
    logger.add_argument("-n", "--tail", type=int)

    watcher = sub.add_parser("watch", help="tableau de bord rafraîchi en continu")
    watcher.add_argument("--run")
    watcher.add_argument("--interval", type=float, default=2.0)
    watcher.add_argument("--lines", type=int, default=14,
                         help="lignes de journal affichées sous l'état")

    sub.add_parser("path", help="où se trouvent le log et le journal").add_argument("--run")

    for name in ("pause", "stop"):
        node = sub.add_parser(name, help=f"{name} le run")
        node.add_argument("--run")

    sub.add_parser("list", help="tous les runs connus").add_argument("--run")

    args = parser.parse_args()
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    handlers = {
        "start": cmd_start, "replan": cmd_replan, "event": cmd_event,
        "gate": cmd_gate, "status": cmd_status, "log": cmd_log,
        "resume": cmd_resume, "shell": cmd_shell, "list": cmd_list,
        "reconcile": cmd_reconcile, "quota": cmd_quota,
        "progress": cmd_progress,
        "watch": cmd_watch, "path": cmd_path,
        "pause": lambda a: cmd_signal(a, "pause"),
        "stop": lambda a: cmd_signal(a, "stop"),
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(GO)
