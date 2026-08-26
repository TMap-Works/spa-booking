#!/usr/bin/env python3
"""Journal, état et pilotage d'un run de jalon lancé par /milestone.

    python scripts/milestone_run.py next                   # où en est-on, que lancer
    python scripts/milestone_run.py start                  # ouvre — ou reprend — ce jalon-là
    python scripts/milestone_run.py start S1 --width 3     # ou le nommer soi-même
    python scripts/milestone_run.py watch                  # tableau de bord continu
    python scripts/milestone_run.py ticket 19 --follow     # entrer dans un traitement
    python scripts/milestone_run.py event --ticket 19 --phase implementation \
                                          --status running --message "..."
    python scripts/milestone_run.py log --level WARN       # ce qui a mal tourné
    python scripts/milestone_run.py onerror pause          # un échec retient le run
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
rend l'écriture concurrente sûre sans verrou — et chaque événement porteur d'un
ticket est recopié dans `tickets/<N>.log`, le log propre à ce traitement.
`control.json` n'est écrit que par l'humain, depuis `shell`.

L'état d'un ticket n'est donc stocké nulle part : il se **rejoue** depuis le
journal. C'est ce qui permet à cinq agents d'écrire en même temps sans qu'aucun
n'écrase l'état d'un autre.

## Sans nommer le jalon

`start` sans argument ne demande pas « lequel ? » : il le déduit. `next` montre
le même raisonnement sans rien ouvrir — un tableau des jalons, leurs issues
closes, le run attaché à chacun, et celui qu'il propose. La règle tient en une
phrase : **reprendre passe avant ouvrir**, puis c'est l'échéance qui tranche.
Sur un terminal, la proposition peut être écartée d'un chiffre ; ailleurs — le
superviseur, la tâche planifiée, `claude -p` — elle est prise telle quelle,
faute de clavier à qui demander.

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
# La branche que `EnterWorktree` crée **avant** le renommage de la phase 1 de
# `/ticket` : il préfixe `worktree-` et remplace le « / » par un « + ». Elle ne
# satisfait pas BRANCH_RE, et personne ne la pousse — mais elle nomme bien un
# ticket, et c'est la seule trace d'un agent pendant les quelques secondes qui
# séparent la création du worktree de `git branch -m`. La lire ici évite que le
# requeue d'un `running` sans trace (#134) ne relance un agent sur l'empreinte
# d'un autre (#130).
WORKTREE_BRANCH_RE = re.compile(r"^worktree-(?:feature|bugfix|chore|docs)\+(\d+)-")

PHASES = ["recevabilite", "isolation", "prise-en-charge", "implementation",
          "validation", "commits", "pr", "ci", "revue", "merge", "cloture",
          "nettoyage", "orchestration"]

MARK = {"pending": "·", "running": "▸", "pr_open": "◇", "ci_green": "◆",
        "reviewed": "◆", "merged": "✔", "failed": "✖", "blocked": "■",
        "skipped": "—"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso_seconds(start, end):
    """Secondes entre deux instants ISO, ou None si l'un des deux est illisible."""
    try:
        return (datetime.fromisoformat(end)
                - datetime.fromisoformat(start)).total_seconds()
    except (ValueError, TypeError):
        return None


def clock(ts, seconds=True):
    """L'heure locale d'un instant ISO — HH:MM:SS, ou HH:MM.

    Locale, pas UTC : c'est l'heure qu'on affiche à un humain, à côté de
    `local_hm` qui fait déjà ce choix pour le quota. Le journal sur disque,
    lui, reste en UTC.
    """
    try:
        moment = datetime.fromisoformat(ts).astimezone()
    except (ValueError, TypeError):
        return ""
    return moment.strftime("%H:%M:%S" if seconds else "%H:%M")


def event_level(event):
    """Le niveau d'un événement : explicite, déduit du statut, INFO sinon."""
    return event.get("level") or LEVEL_OF_STATUS.get(event.get("status"), "INFO")


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
    stamp = clock(event.get("ts")) if short \
        else (event.get("ts") or "").replace("T", " ")[:19]
    level = event_level(event)
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
    event.setdefault("level", event_level(event))
    payload = json.dumps(event, ensure_ascii=False) + "\n"
    readable = log_line(event) + "\n"

    with open(run_dir(run_id) / "journal.ndjson", "a", encoding="utf-8") as handle:
        handle.write(payload)
    targets = [run_dir(run_id) / "run.log", LATEST_LOG]
    # Chaque ticket a aussi son propre fichier : `tail -f tickets/117.log` suit
    # un seul traitement sans le bruit des agents voisins. Son dossier est le
    # seul à créer ici — les autres chemins existent dès l'ouverture du run.
    if event.get("ticket") is not None:
        per_ticket = ticket_log_path(run_id, event["ticket"])
        try:
            per_ticket.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        targets.append(per_ticket)
    for path in targets:
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(readable)
        except OSError:
            pass          # journaliser ne doit jamais interrompre le travail


def ticket_log_path(run_id, number):
    return run_dir(run_id) / "tickets" / f"{number}.log"


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

    # `retry` ne se rejoue pas ici : c'est l'événement `reset → pending` que le
    # shell journalise qui remet le ticket en file, dans l'ordre du journal.
    # Rejouer la liste par-dessus masquerait un **second** échec pour toujours —
    # le ticket relancé retomberait, et `replay` le redirait pending à chaque
    # lecture, gate ouvert, échec invisible. La liste ne sert qu'au `gate`, qui
    # la porte à l'orchestrateur.

    return tickets


def leg_start():
    """Sommes-nous au démarrage d'une étape de reprise automatique ?

    Le superviseur lance chaque vague dans un `claude -p` neuf, et **tous les
    agents de l'étape précédente sont morts avec le processus qui les portait**.
    À cet instant précis, aucun agent ne tient de worktree : un ticket resté
    `running` n'est donc pas un ticket en cours, c'est un ticket abandonné.

    Le distinguer compte, parce que c'est l'inverse du cas #130 — là, un agent
    était vivant et on lui a pris son worktree. Ici personne ne travaille, et
    ne pas requeuer fige la vague pour toujours : `gate` ne lance que des
    `pending`, si bien qu'une étape entière n'a plus rien à faire. C'est ce qui
    a coûté deux étapes à vide dans la nuit du 25 août (#180).

    Le worktree, lui, n'est pas détruit : il porte le travail déjà fait, et
    l'agent relancé est envoyé dedans (voir `milestone.md`, phase 3).

    `SPA_LEG_START` est le signal propre, posé par `milestone_supervise.py` sur
    **chaque** étape. `SPA_UNATTENDED` n'est qu'un repli : le superviseur ne la
    pose que hors `--no-merge`, si bien qu'un jalon armé en `--no-merge` — le
    mode recommandé pour un jalon sensible — n'aurait jamais requeué ses agents
    morts, et retrouverait la vague figée de #180.
    """
    for name in ("SPA_LEG_START", "SPA_UNATTENDED"):
        if os.environ.get(name, "").strip().lower() not in ("", "0", "false", "no"):
            return True
    return False


def resume_context(number, worktrees):
    """Où reprendre un ticket déjà entamé — worktree, branche, travail présent.

    Rendue à l'orchestrateur par `gate`, cette ligne est ce qui empêche l'agent
    relancé de repartir d'un worktree vierge et de perdre le travail du
    précédent.
    """
    found = worktrees.get(number)
    if not found:
        return None
    detail = []
    ahead = git_lines(["log", "--oneline", f"origin/develop..{found['branch']}"])
    if ahead:
        detail.append(f"{len(ahead)} commit(s)")
    dirty = git_lines(["status", "--porcelain"], cwd=found["path"])
    if dirty:
        detail.append(f"{len(dirty)} fichier(s) non commités")
    if not detail:
        detail.append("rien encore posé")
    return {"path": found["path"], "branch": found["branch"],
            "detail": ", ".join(detail)}


def git_lines(args, cwd=None):
    try:
        proc = subprocess.run(["git"] + args, cwd=cwd or ROOT, capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              timeout=60)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    return [line for line in proc.stdout.splitlines() if line.strip()]


def fallen_tickets(tickets):
    """Les tickets tombés, du plus petit numéro au plus grand — la définition
    unique de « en échec » que gate, status et watch partagent."""
    return sorted((t for t in tickets.values() if t["status"] in BAD),
                  key=lambda t: t["number"])


def failure_line(ticket):
    """La ligne d'échec commune à status et watch : marque, statut, phase, cause."""
    return (f"{MARK.get(ticket['status'], '✖')} #{ticket['number']:<4} "
            f"{ticket['status']:<8} {(ticket['phase'] or '?'):<15} "
            f"{ticket['note'] or 'sans détail'}")


def brief_failure(ticket):
    suffix = f", {ticket['phase']}" if ticket["phase"] else ""
    return f"#{ticket['number']} ({ticket['status']}{suffix})"


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


# Les sondes locales (`git ls-remote`, `git worktree list`) rendent un
# dictionnaire vide aussi bien quand elles n'ont rien trouvé que quand elles
# n'ont pas pu regarder — réseau coupé, timeout, git en erreur. Les deux se
# lisaient « ni branche ni worktree », ce qui est sans conséquence tant que
# `reconcile` ne fait pas reculer un ticket, mais devient destructeur depuis
# qu'un `running` sans trace est requeué (#134) : une sonde muette suffirait
# alors à relancer un agent sur un ticket dont le travail existe. Chaque échec
# se note ici, et `reconcile` s'abstient tant que la liste n'est pas vide.
PROBE_FAILURES = []


def note_probe_failure(what):
    PROBE_FAILURES.append(what)
    return {}


def remote_branches():
    """Numéro d'issue → branche poussée sur origin."""
    try:
        proc = subprocess.run(["git", "ls-remote", "--heads", "origin"], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return note_probe_failure(f"git ls-remote ({exc})")
    if proc.returncode != 0:
        return note_probe_failure("git ls-remote : "
                                  + ((proc.stderr or "").strip() or "en erreur"))
    found = {}
    for line in proc.stdout.splitlines():
        _, _, ref = line.partition("refs/heads/")
        match = BRANCH_RE.match(ref.strip())
        if match:
            found.setdefault(int(match.group(1)), ref.strip())
    return found


def live_worktrees():
    """Numéro d'issue → worktree vivant, verrouillé ou non.

    Le pendant local de `remote_branches()`, et il manquait. `reconcile` ne
    regardait que le dépôt distant : un ticket dont le travail existe en local
    mais n'a pas encore été poussé s'y lisait « ni branche ni PR — jamais
    démarré ». Il était donc remis en file, un second agent était lancé dessus,
    et le premier se faisait prendre son worktree pour un vestige (#130).

    Un worktree est la trace qu'un agent tient le ticket. Elle vaut avant le
    premier push, c'est-à-dire précisément pendant la fenêtre où le dépôt
    distant ne sait rien dire.

    Les deux formes de nom comptent : celle d'après le renommage de la phase 1
    (`bugfix/134-…`) et celle que `EnterWorktree` pose avant lui
    (`worktree-bugfix+134-…`). Depuis #134, un ticket `running` sans aucune
    trace redevient `pending` : ne pas lire la seconde forme rendrait invisible
    l'agent qui n'a pas encore eu le temps de renommer sa branche.

    Reste une fenêtre irréductible, à connaître : le worktree qu'un agent de
    jalon reçoit s'appelle d'abord `agent-<aléa>`, sans numéro d'issue. Un agent
    mort là n'a rien posé et son ticket doit repartir ; un agent **vivant** là
    n'est pas détectable — c'est pourquoi `reconcile` se lance entre deux
    vagues, jamais pendant.
    """
    try:
        proc = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return note_probe_failure(f"git worktree list ({exc})")
    if proc.returncode != 0:
        return note_probe_failure("git worktree list : "
                                  + ((proc.stderr or "").strip() or "en erreur"))

    found, current = {}, {}
    for line in proc.stdout.splitlines() + [""]:
        line = line.strip()
        if not line:                       # ligne vide : fin d'une entrée
            branch = current.get("branch", "")
            match = BRANCH_RE.match(branch) or WORKTREE_BRANCH_RE.match(branch)
            if match and current.get("path"):
                found.setdefault(int(match.group(1)), {
                    "path": current["path"], "branch": branch,
                    "locked": current.get("locked", False)})
            current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current["path"] = value
        elif key == "branch":
            current["branch"] = value.replace("refs/heads/", "")
        elif key == "locked":
            current["locked"] = True
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

    Le cas symétrique compte autant, et manquait (#134) : l'agent tué **avant**
    son premier push laisse un `running` que rien n'atteste. C'est le mode de
    mort ordinaire sous reprise automatique, où les agents meurent avec le leg
    qui les a lancés. Ce ticket-là redevient `pending` — sans quoi il ne peut
    plus rien devenir : le `gate` ne lance que des `pending`, et une vague qui
    en garde un ne se clôt jamais.
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
    # Requeuer un `running` ne se fonde pas sur une absence de trace, mais sur
    # une absence **constatée** : les deux sondes doivent avoir répondu. Muettes,
    # elles rendent le même dictionnaire vide qu'un ticket jamais démarré.
    PROBE_FAILURES.clear()
    branches = remote_branches()
    worktrees = live_worktrees()
    sondes_sures = not PROBE_FAILURES
    if not sondes_sures:
        print("sonde locale muette (" + " ; ".join(PROBE_FAILURES) + ") — les "
              "tickets `running` sont laissés tels quels", file=sys.stderr)

    # Au démarrage d'une étape de reprise automatique, aucun agent de l'étape
    # précédente n'a survécu : un `running` y est un abandon, pas un travail en
    # cours. Une sonde muette suspend ce raisonnement comme le reste — sans
    # certitude sur l'état local, on ne fait reculer personne.
    depart = sondes_sures and (getattr(args, "leg_start", False) or leg_start())
    if depart:
        print("démarrage d'étape : les tickets restés `running` sont repris "
              "dans leur worktree existant")

    corrections = []
    for number, ticket in sorted(pending.items()):
        pr = carried.get(number)
        branch = branches.get(number)
        worktree = worktrees.get(number)

        if issue_state.get(number) == "CLOSED":
            target, why = "merged", "issue close sur GitHub"
        elif pr and pr["state"] == "MERGED":
            target, why = "merged", f"PR #{pr['number']} déjà mergée"
        elif pr and pr["state"] == "OPEN":
            target, why = "pr_open", f"PR #{pr['number']} ouverte"
        elif branch:
            target, why = "running", f"branche {branch} poussée, aucune PR"
        elif worktree and ticket["status"] in BAD:
            # Un ticket tombé a été **jugé**, pas abandonné : son worktree ne dit
            # rien de plus que ce que l'agent a déjà journalisé. Le déplacer —
            # vers `running` comme vers `pending` — effacerait le seul état que
            # la pause sur erreur regarde : `gate` ne retient que ce qui est
            # `failed` ou `blocked`, et un ticket qui échoue à chaque étape
            # repartirait indéfiniment sans que personne soit consulté. C'est
            # `retry N` qui le remet en file, et lui seul.
            target, why = ticket["status"], "ticket tombé — worktree conservé"
        elif worktree and not (depart and ticket["status"] == "running"):
            # Avant le premier push, le dépôt distant ne sait rien dire. Le
            # worktree, lui, dit qu'un agent tient le ticket — et le remettre en
            # file lancerait un second agent sur la même empreinte, dont le
            # premier réflexe serait de « nettoyer » le worktree du premier.
            target = "running"
            why = (f"worktree vivant sur {worktree['branch']}, rien de poussé"
                   + (" (verrouillé)" if worktree["locked"] else ""))
        elif worktree:
            # Au démarrage d'une étape, personne ne tient plus ce worktree : les
            # agents de l'étape précédente sont morts avec leur `claude -p`. Le
            # ticket doit être resté `running` pour ça — un ticket tombé est
            # traité au-dessus. Le ticket est donc à reprendre — **dans ce worktree-là**, que l'agent
            # relancé rejoint par `EnterWorktree(path=…)` au lieu d'en ouvrir un
            # neuf. Ne pas le faire figeait la vague : `gate` ne lance que des
            # `pending`, et deux étapes de suite n'ont eu personne à lancer.
            target = "pending"
            why = (f"agent mort avec son étape — reprendre dans {worktree['path']} "
                   f"({worktree['branch']})")
        else:
            target, why = "pending", "ni branche ni PR ni worktree — jamais démarré"

        # GitHub ne connaît que trois états ; le journal en connaît six. Un ticket
        # dont l'agent avait journalisé `ci_green` puis `reviewed` avant d'être tué
        # a bien une PR ouverte — le ramener à `pr_open` ferait refaire la CI et la
        # revue à chaque reprise. Un état déjà plus avancé que ce que le dépôt sait
        # dire n'est donc pas une divergence.
        #
        # `running` est l'exception, et c'est tout le sujet de #134 : c'est le
        # seul état de FLOW qui ne laisse **aucune trace** — ni PR, ni branche,
        # ni worktree. N'en rien trouver n'est donc pas une ignorance du dépôt
        # mais une information sûre : l'agent est mort avant d'avoir rien posé.
        # Le protéger comme les autres figeait le ticket pour toujours — le
        # `gate` ne lance que des `pending`, et la vague ne pouvait plus ni
        # avancer ni se clore. Sûre à une condition : que les sondes locales
        # aient répondu. Muettes, elles ne prouvent rien et le garde-fou tient.
        recule_running = ticket["status"] == "running" and sondes_sures
        avance = (target in FLOW and ticket["status"] in FLOW
                  and FLOW.index(ticket["status"]) > FLOW.index(target)
                  and not recule_running)
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
    # Relayée telle quelle. `cmd_start` l'a déjà confrontée au registre — celui
    # du superviseur, emprunté et non recopié — de sorte qu'une coquille se dise
    # avant l'ouverture du run plutôt qu'ici, où elle emporterait la veille.
    if getattr(args, "merge_sensitive", ""):
        command += ["--merge-sensitive", args.merge_sensitive]
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


# --------------------------------------------------------------------------- #
# Quel jalon ? — la question à laquelle l'orchestrateur répond de lui-même
# --------------------------------------------------------------------------- #
#
# Taper « S1 » suppose de savoir où on en est : quel jalon est entamé, lequel
# est déroulé, s'il traîne un run inachevé quelque part. Or c'est exactement ce
# que l'état sait déjà — le journal des runs d'un côté, les jalons GitHub de
# l'autre. `start` sans argument dresse donc le tableau, propose, et sur un
# terminal laisse trancher.

def run_digest(name):
    """Ce qu'un run raconte de lui-même : avancement, vague en cours, signal.

    None si le run est illisible — et « illisible » va au-delà du fichier
    absent : un `run.json` sans plan, ou qui n'est pas un objet, se relit sans
    erreur mais ne se rejoue pas. Le tableau doit sauter ce run-là, pas mourir
    dessus : `next` et `start` sans jalon passent ici sur *tous* les runs du
    disque, et un seul dossier abîmé rendrait les deux inutilisables.
    """
    try:
        run = json.loads((run_dir(name) / "run.json").read_text(encoding="utf-8"))
        control = load_control(name)
        tickets = replay(run, read_journal(name), control)
        current, waves = wave_state(run, tickets)
    except (OSError, json.JSONDecodeError, AttributeError, TypeError, KeyError):
        return None
    return {
        "id": name,
        "milestone": run.get("milestone", ""),
        "created": run.get("created", ""),
        "width": run.get("width"),
        "done": sum(1 for t in tickets.values() if t["status"] in TERMINAL),
        "total": len(tickets),
        "wave": current["index"] if current else None,
        "waves": len(waves),
        "signal": control.get("signal", "run"),
        "finished": current is None,
        "active": name == current_id(),
    }


def survey():
    """(lignes, avertissement) — un jalon par ligne, GitHub et runs réunis.

    GitHub muet ne rend pas la commande inutilisable : les runs présents sur le
    disque portent leur plan et suffisent à reprendre. Le tableau est alors
    réduit à ceux-là, et le dit plutôt que de laisser croire à un jalon vide.
    """
    digests = [d for d in (run_digest(directory.name) for directory in run_dirs())
               if d]
    milestones, error = gh_json(["api", f"repos/{REPO}/milestones", "--paginate",
                                 "-X", "GET", "-f", "state=all"])
    rows = []
    for milestone in milestones or []:
        title = milestone.get("title", "")
        # `run_dirs()` va du plus récent au plus ancien : le premier run trouvé
        # sur un jalon est celui qui compte, les précédents sont de l'histoire.
        attached = next((d for d in digests if d["milestone"] == title), None)
        if milestone.get("state") != "open" and attached is None:
            continue          # jalon clos et sans run : plus rien à en dire
        rows.append({
            "title": title, "state": milestone.get("state", "open"),
            "due": (milestone.get("due_on") or "")[:10],
            "open": milestone.get("open_issues", 0),
            "closed": milestone.get("closed_issues", 0),
            "run": attached,
        })
    rows.sort(key=lambda row: (row["due"] or "9999", row["title"]))

    # Un run dont le jalon n'a pas été retrouvé — dépôt injoignable, jalon
    # supprimé — reste reprenable : son plan est dans son run.json.
    for digest in digests:
        if not any(row["title"] == digest["milestone"] for row in rows):
            rows.append({"title": digest["milestone"], "state": "?", "due": "",
                         "open": None, "closed": None, "run": digest})
    return rows, error


def workable(row):
    """Un jalon sur lequel il reste quelque chose à faire."""
    if row["run"] and not row["run"]["finished"] and row["run"]["signal"] != "stop":
        return True
    return row["state"] == "open" and (row["open"] or 0) > 0


def held(row):
    """« · pause demandée », le cas échéant — un signal posé à la main survit à
    la reprise, et `gate` le fera valoir dès la vague suivante."""
    signal = row["run"]["signal"] if row["run"] else "run"
    return f" · {signal} demandée" if signal != "run" else ""


def recommend(rows):
    """(ligne à lancer, pourquoi) — l'ordre dans lequel un humain choisirait.

    **Reprendre passe avant ouvrir.** Un run inachevé, ce sont des worktrees
    vivants, des branches poussées et des PR ouvertes ; ouvrir un autre jalon
    par-dessus les laisserait en plan sans que rien ne le signale. Entre deux
    runs inachevés, celui que `current` désigne — le dernier ouvert — passe
    devant ; à défaut, le jalon dont l'échéance est la plus proche, les jalons
    se déroulant dans l'ordre, S1 avant S3.
    """
    live = [row for row in rows if row["run"] and not row["run"]["finished"]
            and row["run"]["signal"] != "stop"]
    active = next((row for row in live if row["run"]["active"]), None)
    if active:
        return active, f"run {active['run']['id']} en cours{held(active)}"
    if live:
        return live[0], f"run {live[0]['run']['id']} inachevé{held(live[0])}"
    todo = [row for row in rows if row["state"] == "open" and (row["open"] or 0) > 0]
    if todo:
        return todo[0], "jalon ouvert dont l'échéance est la plus proche"
    return None, "aucun jalon ouvert n'a d'issue à traiter"


def print_survey(rows, error=None):
    if error:
        print(f"GitHub muet ({error}) — tableau réduit aux runs présents ici\n")
    if not rows:
        print("aucun jalon connu")
        return
    width = max(len(row["title"]) for row in rows + [{"title": "jalon"}])
    print(f"   {'jalon':<{width}} {'échéance':<11} {'issues':<14} run")
    for row in rows:
        digest = row["run"]
        if digest is None:
            state = "—"
        elif digest["finished"]:
            state = f"{digest['id']} · déroulé"
        else:
            state = (f"{digest['id']} · {digest['done']}/{digest['total']} tickets"
                     f" · vague {digest['wave']}/{digest['waves']}")
            if digest["signal"] != "run":
                state += f" · {digest['signal']}"
        if row["open"] is None:
            issues = "?"
        else:
            issues = f"{row['closed']}/{row['closed'] + row['open']} closes"
        print(f" {'*' if digest and digest['active'] else ' '} "
              f"{row['title']:<{width}} {row['due'] or '—':<11} {issues:<14} "
              f"{state}")


def ask_milestone(rows, default):
    """Le jalon retenu — la question n'étant posée que s'il y a un clavier.

    Un run est aussi ouvert par le superviseur, par la tâche planifiée et par
    `claude -p` : aucun des trois n'a quelqu'un derrière lui. Une question posée
    là bloquerait la reprise automatique pour de bon, c'est-à-dire exactement ce
    que la reprise automatique existe pour éviter. Hors terminal, on prend donc
    la proposition — et on l'écrit, pour qu'elle reste lisible dans le log.
    """
    # Même lecture que `pr_gate.py` : « 0 », « false », « no » disent qu'il y a
    # bien quelqu'un. Se contenter de la vérité de Python ferait de `=0` — la
    # façon dont on désarme une variable — l'exact contraire de ce qu'il dit.
    if os.environ.get("SPA_UNATTENDED", "").strip().lower() not in (
            "", "0", "false", "no"):
        return default
    try:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            return default
    except (AttributeError, ValueError):
        return default

    candidates = [row for row in rows if workable(row)]
    if default not in candidates:
        candidates.insert(0, default)
    if len(candidates) < 2:
        return default          # rien à arbitrer : une seule réponse possible

    print()
    for index, row in enumerate(candidates, 1):
        print(f"  {'→' if row is default else ' '} {index}. {row['title']}")
    try:
        answer = input(f"\njalon [{candidates.index(default) + 1}] ? ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return default
    if not answer:
        return default
    if answer.isdigit() and 1 <= int(answer) <= len(candidates):
        return candidates[int(answer) - 1]
    matches = [row for row in candidates if answer.lower() in row["title"].lower()]
    if len(matches) == 1:
        return matches[0]
    print(f"« {answer} » ne désigne aucun jalon de la liste — "
          f"{default['title']} retenu")
    return default


def choose_milestone():
    """Le jalon sur lequel `start` va travailler quand personne ne l'a nommé."""
    rows, error = survey()
    if not rows:
        fail("aucun jalon à proposer" + (f" — {error}" if error else "")
             + "\n`milestone_run.py start <jalon>` pour en nommer un à la main")
    print_survey(rows, error)
    proposed, why = recommend(rows)
    if proposed is None:
        print(f"\n{why} — rien à lancer")
        return None
    chosen = ask_milestone(rows, proposed)
    print(f"\n→ {chosen['title']} · "
          f"{why if chosen is proposed else 'choisi à la main'}")
    return chosen["title"]


def cmd_next(args):
    """Où en est-on, et que lancer — sans rien ouvrir."""
    rows, error = survey()
    proposed, why = recommend(rows)
    if args.json:
        print(json.dumps({"milestones": rows, "warning": error, "reason": why,
                          "recommended": proposed["title"] if proposed else None},
                         ensure_ascii=False, indent=2))
        return GO if proposed else NO_RUN
    print_survey(rows, error)
    if proposed is None:
        print(f"\n{why}")
        return NO_RUN
    print(f"\n→ {proposed['title']} · {why}")
    print("  python scripts/milestone_run.py start     # sans nommer le jalon")
    return GO


def check_merge_sensitive(value):
    """Refuse une pré-autorisation fautive **avant** que le run ne s'ouvre.

    Le registre reste celui du superviseur : on le lui emprunte au lieu d'en
    tenir une seconde copie, qui finirait par diverger de ce que la barrière
    refuse vraiment.

    Vérifier ici, et pas seulement à l'armement, tient à l'ordre des choses :
    `start` ouvre le run puis arme la veille. Une faute de frappe découverte à
    l'armement fait échouer tout le sous-processus — et le run se retrouve
    ouvert **sans aucune reprise automatique**, pour un mot mal tapé. Le
    dispositif que ce ticket répare se serait débranché sur une coquille.

    Rend un message d'erreur, ou None.
    """
    if not (value or "").strip():
        return None
    try:
        sys.path.insert(0, str(ROOT / "scripts"))
        from milestone_supervise import ALL_SCOPES, SCOPE_KEYS, parse_scopes
    except Exception:  # noqa: BLE001 — un superviseur illisible ne doit pas
        # emporter `start` : il le dira lui-même à l'armement, et le run vaut
        # mieux ouvert sans veille que pas ouvert du tout.
        return None
    _, unknown = parse_scopes(value)
    if not unknown or not SCOPE_KEYS:
        return None
    return "périmètre inconnu : {} — attendus : {}, ou « {} »".format(
        ", ".join(unknown), ", ".join(sorted(SCOPE_KEYS)), ALL_SCOPES)


def cmd_start(args):
    # Une pré-autorisation fautive se dit maintenant, avant d'ouvrir quoi que ce
    # soit : plus tard, elle coûterait la veille entière (voir ci-dessus).
    problem = check_merge_sensitive(getattr(args, "merge_sensitive", ""))
    if problem:
        print(problem, file=sys.stderr)
        return NO_RUN

    # Sans jalon nommé, l'orchestrateur regarde où on en est et propose : savoir
    # qu'on en est au S1 est son travail, pas celui de qui tape la commande.
    if not args.milestone:
        args.milestone = choose_milestone()
        if args.milestone is None:
            return NO_RUN
        print()

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
    # Une demande de reprise ne vaut que tant qu'elle n'a pas été honorée : le
    # `reset → pending` du shell la consomme, et la vague suivante la relance.
    # Continuer de l'annoncer ensuite — c'est ce que faisait cette boucle, pour
    # tout le reste du run — dirait à l'orchestrateur de relancer un ticket déjà
    # mergé, ou pire, un ticket qu'un agent tient à cet instant (#130).
    # `control["retry"]` n'est jamais purgé : seul l'état du ticket dit si la
    # demande reste à honorer. Un ticket tombé (`failed`/`blocked`) l'est encore
    # — c'est le seul cas où le shell n'a pas déjà écrit son `reset → pending`,
    # ou bien le ticket est retombé depuis et l'humain doit le revoir. Tout le
    # reste — `pending` en file, `running` relancé, `pr_open` en vol, `merged` —
    # a consommé la demande.
    for number in control.get("retry") or []:
        ticket = tickets.get(number)
        if ticket and ticket["status"] in BAD:
            print(f"reprendre #{number} ({ticket['status']})")

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

    # La pause sur erreur, quand elle est armée (`onerror pause`) : un ticket
    # tombé retient le run entier tant qu'un humain n'a pas tranché — `retry N`
    # pour le relancer, `skip N` pour l'écarter, `onerror continue` pour
    # désarmer. Sans elle, l'échec s'empile sous les vagues suivantes et ne se
    # traite qu'en fin de jalon. Après la fin du jalon (`current is None`),
    # elle n'a plus rien à retenir : l'échec se lit dans le compte rendu.
    if control.get("pause_on_error") and any(t["status"] in BAD
                                             for t in tickets.values()):
        print("pause sur erreur — traiter d'abord : "
              + ", ".join(brief_failure(t) for t in fallen_tickets(tickets)))
        print("`milestone_run.py shell` puis `retry N`, `skip N [raison]` ou "
              "`onerror continue` ; `ticket N` pour entrer dans le détail")
        return PAUSE

    ready = [n for n in current["numbers"] if tickets[n]["status"] == "pending"]
    print(f"vague {current['index']} · {len(ready)} ticket(s) à lancer : "
          + (", ".join(f"#{n}" for n in ready) or "aucun"))

    # Un ticket déjà entamé garde son worktree et son travail. Le dire ici est
    # ce qui empêche l'agent relancé d'ouvrir un worktree vierge et de repartir
    # de zéro — ou, pire, de prendre l'ancien pour un vestige et de l'effacer.
    if ready:
        worktrees = live_worktrees()
        for number in ready:
            context = resume_context(number, worktrees)
            if context:
                print(f"  #{number} À REPRENDRE dans {context['path']} "
                      f"({context['branch']} — {context['detail']}) : "
                      f"EnterWorktree(path=…), ne pas en ouvrir un neuf")
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
    if control.get("pause_on_error"):
        print(paint("pause sur erreur armée — un ticket tombé retiendra le run "
                    "au prochain gate", "WARN"))
    print()

    # Les échecs d'abord, en clair : c'est ce qu'on vient chercher quand un run
    # tourne mal, et ils se noyaient dans la liste des vagues.
    fallen = fallen_tickets(tickets)
    if fallen:
        print(paint(f"⚠ {len(fallen)} ticket(s) en échec — "
                    f"`milestone_run.py ticket N` pour entrer dans le détail :",
                    "failed"))
        for ticket in fallen:
            print(paint("    " + failure_line(ticket), "failed"))
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
            line = (f"    {MARK.get(ticket['status'], '?')} #{number:<4} "
                    f"{ticket['status']:<9} {title:<44} {' · '.join(extra)}")
            print(paint_if_bad(line, ticket["status"]))
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
        level = event.get("level") or LEVEL_OF_STATUS.get(event.get("status"), "INFO")
        print(paint(log_line(event), level))
    if not events:
        print("journal vide pour ce filtre")
    return GO


# --------------------------------------------------------------------------- #
# Vue ticket — entrer dans un traitement pendant le run
# --------------------------------------------------------------------------- #
#
# Le tableau de bord montre la vague ; il ne dit pas ce qu'un agent fait de son
# ticket. Cette vue rejoue le journal d'un seul ticket : les phases traversées
# avec leur durée, l'échec là où il s'est produit, et les derniers événements.
# `--follow` la redessine en continu — c'est la loupe qu'on pose sur un ticket
# dont le temps de phase grimpe sans nouvelle ligne.

def iso_seconds(start, end):
    try:
        return (datetime.fromisoformat(end)
                - datetime.fromisoformat(start)).total_seconds()
    except (ValueError, TypeError):
        return None


def phase_segments(mine):
    """Les phases dans l'ordre où le ticket les a vécues, avec leurs bornes.

    Une phase peut revenir — validation, revue, validation de nouveau — et
    chaque retour est un segment distinct : fusionner les occurrences ferait
    d'une boucle de correction une phase unique faussement longue. Un retour
    sur la phase **même nom** après un échec est aussi un segment neuf : c'est
    un `retry`, et l'échec du premier passage doit rester visible.

    Un événement sans phase ne se jette pas : son statut appartient au segment
    en cours — `event --status failed` sans `--phase` est accepté, et l'échec
    doit marquer la phase où il est tombé.
    """
    segments = []
    for event in mine:
        phase = event.get("phase")
        if not phase:
            if segments and event.get("status"):
                segments[-1]["status"] = event["status"]
                segments[-1]["end"] = event.get("ts") or segments[-1]["end"]
            continue
        retried = (segments and segments[-1]["phase"] == phase
                   and segments[-1]["status"] in BAD and event.get("status"))
        if not segments or segments[-1]["phase"] != phase or retried:
            segments.append({"phase": phase, "start": event.get("ts"),
                             "end": event.get("ts"), "status": None})
        segment = segments[-1]
        segment["end"] = event.get("ts") or segment["end"]
        if event.get("status"):
            segment["status"] = event["status"]
    return segments


def ticket_frame(run_id, number, tail, worktrees=None):
    run = load_run(run_id)
    control = load_control(run_id)
    events = read_journal(run_id)
    tickets = replay(run, events, control)
    if number not in tickets:
        fail(f"#{number} n'est pas au plan du run {run_id} — "
             "`milestone_run.py status` pour la liste")
    ticket = tickets[number]
    mine = [e for e in events if e.get("ticket") == number]
    worktree = (live_worktrees() if worktrees is None else worktrees).get(number)
    columns = max(60, shutil.get_terminal_size((110, 30)).columns - 1)

    out = [""]

    def emit(text, tint=None):
        # Tronquer avant de peindre : couper une chaîne déjà peinte emporterait
        # le code de reset, et une ligne trop longue casse le redessin --follow.
        out.append(paint(text[:columns], tint) if tint else text[:columns])

    emit(f" #{number}  {ticket['title']}")
    facts = [ticket["status"], f"vague {ticket['wave']}",
             f"{ticket['priority']} · {ticket['workstream']}/{ticket['module']}"]
    if ticket["phase"]:
        facts.append(f"phase {ticket['phase']}")
    if ticket["last"]:
        facts.append(f"dernier événement il y a {human_delta(age(ticket['last']))}")
    emit(" " + "  ·  ".join(facts),
         ticket["status"] if ticket["status"] in BAD else None)
    if ticket["status"] in BAD:
        emit(f" ⚠ {ticket['status']} — {ticket['note'] or 'sans détail'}"
             f"  ·  `shell` puis `retry {number}` ou `skip {number}`", "failed")
    if ticket["pr"]:
        emit(f" PR       #{ticket['pr']}")
    if ticket["branch"] or worktree:
        emit(f" branche  {ticket['branch'] or worktree['branch']}")
    if worktree:
        emit(f" worktree {worktree['path']}"
             + ("  (verrouillé)" if worktree["locked"] else ""))
    if ticket["resources"]:
        emit(f" empreinte {', '.join(ticket['resources'])}")

    segments = phase_segments(mine)
    if segments:
        emit("")
        emit(" PHASES")
        open_ended = ticket["status"] not in TERMINAL and ticket["status"] not in BAD
        for index, segment in enumerate(segments):
            last = index + 1 == len(segments)
            if last and open_ended:
                # La phase en cours vieillit entre deux événements : la mesurer
                # au dernier événement la figerait — et un agent muet depuis
                # 40 minutes semblerait n'avoir que 12 secondes de retard.
                spent = human_delta(iso_seconds(segment["start"], now()))
            else:
                following = segments[index + 1]["start"] if not last else segment["end"]
                spent = human_delta(iso_seconds(segment["start"], following))
            badge = f"[{segment['status']}]" if segment["status"] else ""
            if last and open_ended:
                badge = (badge + "  ← en cours").lstrip()
            emit(f"   {clock(segment['start'])}  {segment['phase']:<16} "
                 f"{spent:>6}  {badge}",
                 segment["status"] if segment["status"] in BAD else None)

    emit("")
    shown = mine[-tail:] if tail else mine
    emit(f" JOURNAL — {len(mine)} événement(s)"
         + (f", {len(shown)} derniers" if len(shown) < len(mine) else ""))
    for event in shown:
        emit("   " + log_line(event, short=True), event_level(event))
    if not mine:
        emit("   aucun événement journalisé pour ce ticket")

    log_path = ticket_log_path(run_id, number)
    emit("")
    emit(f" log ticket  {log_path}"
         + ("" if log_path.exists() else "  (pas encore écrit)"), "DEBUG")
    return "\n".join(out)


def cmd_ticket(args):
    run_id = resolve(args.run)
    if not args.follow:
        print(ticket_frame(run_id, args.number, args.tail))
        return GO
    if os.name == "nt":
        os.system("")          # active le traitement des séquences ANSI sous Windows
    # Le worktree bouge rarement ; le journal, tout le temps. Un `git worktree
    # list` par redessin serait un fork toutes les 2 s pour une donnée quasi
    # figée — on la rafraîchit toutes les 30 s.
    worktrees, refreshed = live_worktrees(), time.monotonic()
    clear = "\x1b[H\x1b[J" if COLOR else ""
    try:
        while True:
            if time.monotonic() - refreshed > 30:
                worktrees, refreshed = live_worktrees(), time.monotonic()
            frame = ticket_frame(run_id, args.number, args.tail,
                                 worktrees=worktrees)
            sys.stdout.write(clear + frame + "\n")
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        return GO


def cmd_onerror(args):
    """Arme ou désarme la pause sur erreur — lue par le `gate` de chaque vague."""
    run_id = resolve(args.run)
    control = load_control(run_id)

    if not args.mode:
        if control.get("pause_on_error"):
            print("pause sur erreur armée — un ticket tombé retiendra le run au "
                  "prochain gate")
        else:
            print("pause sur erreur désarmée — un échec ne retient pas le run")
        return GO

    wanted = args.mode == "pause"
    control["pause_on_error"] = wanted
    save_control(run_id, control)
    if wanted:
        journal_message = ("pause sur erreur armée — un ticket en échec "
                           "retiendra le run à la fin de sa vague")
        answer = ("pause sur erreur armée — au premier échec, le run se "
                  "retiendra à la fin de la vague, `retry N` ou `skip N` pour "
                  "le relâcher")
    else:
        journal_message = "pause sur erreur désarmée"
        answer = "pause sur erreur désarmée — les échecs ne retiennent plus le run"
    append_journal(run_id, {"ts": now(), "kind": "run", "actor": args.actor,
                            "level": "WARN" if wanted else "INFO",
                            "message": journal_message})
    print(answer)
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
    # `go` lève le signal, pas la retenue d'erreur : elle se lève en traitant
    # l'échec. Le dire ici épargne un gate qui « re-refuse » sans explication.
    if signal == "run" and control.get("pause_on_error"):
        print("pause sur erreur toujours armée — un ticket encore en échec "
              "retiendra le gate (`retry N`, `skip N` ou `onerror continue`)")
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
  ticket N [-n K] [-f]  entrer dans le traitement du ticket N — phases, durées, journal
  watch               tableau de bord rafraîchi en continu (Ctrl-C pour sortir)
  tail                défilement brut du log, ligne à ligne
  perms               commandes ayant demandé une permission pendant ce run
  quota               état du quota, et quand le run repartira
  quota clear         lever la retenue de quota sans attendre
  reconcile           réaligner le journal sur l'état réel du dépôt
  pause               s'arrêter à la fin de la vague en cours
  stop                s'arrêter sans lancer d'autre agent
  go                  lever la pause et reprendre
  onerror [pause|continue]  armer/désarmer la pause automatique sur ticket en échec
  skip N [raison]     écarter un ticket du run
  retry N             relancer un ticket en échec — ou figé en running
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
            elif verb == "ticket":
                number = as_ticket(rest[0] if rest else None)
                if number is None:
                    print("ticket N [-n K] [-f] — N est un numéro d'issue")
                    continue
                options = rest[1:]
                count = (int(options[options.index("-n") + 1])
                         if "-n" in options else 15)
                cmd_ticket(argparse.Namespace(
                    run=run_id, number=number, tail=count,
                    follow="-f" in options or "--follow" in options, interval=2))
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
            elif verb == "onerror":
                mode = rest[0].lower() if rest else None
                if mode not in (None, "pause", "continue"):
                    print("onerror [pause|continue]")
                    continue
                cmd_onerror(argparse.Namespace(run=run_id, mode=mode,
                                               actor="humain"))
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
                # C'est cette ligne qui remet le ticket en file, et elle seule :
                # `reset` est le seul moyen de faire reculer un statut, si bien
                # que `retry` mord sur tout — un `skip` journalisé terminal comme
                # un `running` figé par un agent mort (#134), que `reconcile` ne
                # rattrape que si le dépôt confirme l'absence de trace.
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


def paint_if_bad(text, status):
    return paint(text, status) if status in BAD else text


def signal_event(events, signal):
    """Le dernier événement qui a posé ce signal — pour dire qui, et quand."""
    for event in reversed(events):
        if event.get("kind") == "run" and event.get("status") == signal:
            return event
    return None


def posed_by(event, participle):
    if event is None:
        return f" {participle}"
    stamp = clock(event.get("ts"), seconds=False)
    actor = event.get("actor") or "humain"
    return f" {participle} par {actor}" + (f" à {stamp}" if stamp else "")


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

    # Un signal posé à la main mérite mieux qu'un mot dans l'en-tête : la
    # bannière dit qui l'a posé, quand, et ce que le run va faire de la vague
    # en cours — c'est ce qu'on vient vérifier en ouvrant le tableau de bord.
    if signal == "pause":
        banner = (" ⏸  PAUSE" + posed_by(signal_event(events, "pause"), "demandée")
                  + "  ·  la vague en cours se termine, aucune nouvelle ne sera "
                    "lancée  ·  `shell` puis `go` pour reprendre")
        out.append(paint(banner[:columns], "WARN"))
    elif signal == "stop":
        banner = (" ⏹  ARRÊT" + posed_by(signal_event(events, "stop"), "demandé")
                  + "  ·  aucun nouvel agent ne sera lancé")
        out.append(paint(banner[:columns], "failed"))
    if control.get("pause_on_error"):
        out.append(paint(" ⚠  pause sur erreur armée — un ticket tombé retiendra le "
                         "run au prochain gate"[:columns], "WARN"))

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
        out.append(paint(" EN ÉCHEC — `shell` puis `retry N` ou `skip N` · "
                         "`ticket N` pour le détail", "failed"))
        for ticket in sorted(failed, key=lambda t: t["number"]):
            out.append(paint(("   " + failure_line(ticket))[:columns], "failed"))
        out.append("")

    out.append(" JOURNAL")
    for event in events[-lines:]:
        out.append("   " + paint(log_line(event, short=True)[:columns - 4],
                                 event_level(event)))

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
    print(f"log courant     {LATEST_LOG}")
    print(f"log du run      {run_dir(run_id) / 'run.log'}")
    print(f"logs par ticket {run_dir(run_id) / 'tickets' / '<N>.log'}")
    print(f"journal         {run_dir(run_id) / 'journal.ndjson'}")
    print(f"plan            {run_dir(run_id) / 'run.json'}")
    return GO


# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    starter = sub.add_parser("start", help="ouvre un run sur un jalon")
    starter.add_argument("milestone", nargs="?",
                         help="préfixe du titre ; à défaut, le jalon proposé")
    starter.add_argument("--width", type=int, default=3)
    starter.add_argument("--keep", type=int, default=10,
                         help="nombre de runs conservés sur le disque")
    starter.add_argument("--fresh", action="store_true",
                         help="ouvrir un run neuf au lieu de reprendre l'inachevé")
    starter.add_argument("--no-reconcile", action="store_true",
                         help="à la reprise, ne pas interroger GitHub")
    starter.add_argument("--no-merge", action="store_true",
                         help="la reprise automatique s'arrêtera aux PR, sans merger")
    starter.add_argument("--merge-sensitive", default="", metavar="PÉRIMÈTRES",
                         help="pré-autorise le merge de ces périmètres sensibles "
                              "pour tout le run, séparés par des virgules "
                              "(voir milestone_supervise.py --merge-sensitive)")
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

    entrant = sub.add_parser("ticket",
                             help="entrer dans le traitement d'un ticket — "
                                  "phases, durées, journal, worktree")
    entrant.add_argument("number", type=int, metavar="N")
    entrant.add_argument("--run")
    entrant.add_argument("-n", "--tail", type=int, default=15,
                         help="événements affichés (0 = tous)")
    entrant.add_argument("-f", "--follow", action="store_true",
                         help="redessiner en continu, comme watch")
    entrant.add_argument("--interval", type=float, default=2.0)

    onerror = sub.add_parser("onerror",
                             help="pause automatique quand un ticket échoue")
    onerror.add_argument("mode", nargs="?", choices=["pause", "continue"],
                         help="sans argument : l'état courant")
    onerror.add_argument("--run")
    onerror.add_argument("--actor", default="humain")

    sub.add_parser("path", help="où se trouvent le log et le journal").add_argument("--run")

    for name in ("pause", "stop"):
        node = sub.add_parser(name, help=f"{name} le run")
        node.add_argument("--run")

    sub.add_parser("list", help="tous les runs connus").add_argument("--run")

    nexter = sub.add_parser("next", help="où en est-on, et quel jalon lancer")
    nexter.add_argument("--json", action="store_true")

    args = parser.parse_args()
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    handlers = {
        "start": cmd_start, "replan": cmd_replan, "event": cmd_event,
        "gate": cmd_gate, "status": cmd_status, "log": cmd_log,
        "resume": cmd_resume, "shell": cmd_shell, "list": cmd_list,
        "reconcile": cmd_reconcile, "quota": cmd_quota,
        "progress": cmd_progress, "next": cmd_next,
        "watch": cmd_watch, "path": cmd_path,
        "ticket": cmd_ticket, "onerror": cmd_onerror,
        "pause": lambda a: cmd_signal(a, "pause"),
        "stop": lambda a: cmd_signal(a, "stop"),
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(GO)
