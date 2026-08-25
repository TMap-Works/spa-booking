#!/usr/bin/env python3
"""Déroule un jalon jusqu'au bout, tout seul — quota, plantages et reboots compris.

**Rien à lancer à la main.** `milestone_run.py start` — donc `/milestone` — arme
ce fichier au moment où le run s'ouvre. Les commandes ci-dessous ne servent qu'à
regarder ou à débrancher :

    python scripts/milestone_supervise.py --state       # qui veille, sur quoi
    python scripts/milestone_supervise.py --disarm      # tout débrancher
    python scripts/milestone_supervise.py --dry-run     # l'appel qui serait fait

## Deux boucles, parce qu'une seule ne suffit pas

**La boucle courte — le superviseur.** Elle demande au run s'il peut continuer
(`milestone_run.py gate`), lance `claude -p "/milestone … --waves 1"` — une
vague, pas le jalon entier : chaque vague est un point d'arrêt net, et un appel
neuf repart d'un contexte vide — puis lit le flux `stream-json` de cet appel.

Claude Code y émet un événement `rate_limit_event` portant `status`,
`rateLimitType` et surtout `resetsAt` : **l'instant exact où les jetons
reviennent**. Sur `rejected`, on inscrit la retenue, on dort jusqu'à cette
seconde-là, et on relance. Pas de sondage, pas d'estimation.

**La boucle longue — le chien de garde.** La boucle courte ne protège que d'une
chose : la fenêtre de quota. Elle ne survit ni à un plantage, ni à un terminal
fermé, ni à un redémarrage — et elle n'existe pas du tout quand la limite tombe
au milieu d'un `/milestone` lancé à la main. D'où une tâche planifiée Windows,
enregistrée à l'ouverture du run, qui se réveille toutes les cinq minutes et
pose trois questions : reste-t-il du travail ? un superviseur bat-il encore ?
le quota est-il revenu ? Si oui, non, oui — elle relance un superviseur détaché.

Ensemble : la coupure est encaissée à la seconde près par la boucle courte, et
tout ce qui pourrait tuer la boucle courte est rattrapé en cinq minutes par la
longue.

## La règle d'autorisation

**Tant qu'un run est ouvert, la relance automatique a le droit de s'exécuter.
Dès qu'il n'y en a plus, elle n'a plus rien à faire et se supprime.** C'est la
seule autorisation du dispositif, elle est vérifiée à chaque réveil par
`authorised()`, et son marqueur est le run lui-même — `current` pointant sur un
dossier de run existant — non le terminal qui l'a ouvert : un run doit survivre
à la fermeture d'une fenêtre et à un redémarrage, sinon la reprise après quota
ne servirait à rien.

Quatre choses retirent donc l'autorisation, et chacune fait que la tâche
planifiée se supprime au réveil suivant : jalon déroulé, `stop` ou `pause`
demandé dans le run, run effacé, et — garde-fou de dernier recours — intention
vieille de plus de quinze jours.

## Où reprendre

Nulle part ici. `milestone_run.py start` reprend de lui-même le run inachevé, et
`reconcile` réaligne le journal sur l'état réel du dépôt avant chaque reprise.
Le superviseur ne garde donc aucun état : on peut le tuer à tout moment.

## Ce qu'il ne fait pas

Il ne relit pas le code. Sauf `--no-merge`, il enchaîne des merges automatiques
sur `develop` sans arbitrage humain — c'est le prix du « sans intervention ».

Une exception, et elle est mécanique plutôt que consignée : sur un périmètre
sensible — `mod:payments`, le label `security`, une migration Prisma,
`infra/terraform` — `pr_gate.py` refuse le merge et laisse la PR ouverte. Le
superviseur le lui dit en posant `SPA_UNATTENDED` dans l'environnement des
vagues. Pour un jalon sensible de bout en bout, armer plutôt avec `--no-merge`.
"""
import argparse
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

# Les périmètres sensibles sont définis — et appliqués — par `pr_gate.py`. Les
# relire chez lui plutôt que d'en recopier la liste évite que l'annonce faite à
# l'opérateur finisse par décrire autre chose que ce que la barrière refuse. Et
# c'est justement le message qu'il ne peut pas vérifier : il est lu à l'instant
# où il cesse de regarder.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from pr_gate import SENSITIVE_SCOPES
except Exception:  # noqa: BLE001 — un pr_gate.py à demi écrit ne doit pas
    # emporter avec lui `--state`, `--disarm` et le réveil de la veille : ce
    # sont précisément les commandes qui servent à reprendre la main.
    SENSITIVE_SCOPES = "voir SENSITIVE_LABELS / SENSITIVE_PREFIXES dans pr_gate.py"

ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = ROOT / ".claude" / ".milestone"
CURRENT = RUNS_DIR / "current"
LEGS_DIR = RUNS_DIR / "legs"
SUPERVISOR_LOG = RUNS_DIR / "supervisor.log"
RUNNER = ROOT / "scripts" / "milestone_run.py"

# Ce que le chien de garde doit relancer, et avec quels réglages. Écrit une fois
# à l'armement ; c'est la mémoire du dispositif entre deux vies du superviseur.
INTENT = RUNS_DIR / "supervisor.json"
# Un battement daté plutôt qu'un PID : un PID est recyclé par le système, et un
# superviseur bloqué garderait le sien. Un battement qui vieillit ne ment pas.
HEARTBEAT = RUNS_DIR / "supervisor.alive"
HEARTBEAT_EVERY = 30
HEARTBEAT_STALE = 210
WATCHDOG_CMD = RUNS_DIR / "watchdog.cmd"
TASK_NAME = "SpaBooking-Milestone-Watchdog"
# Une panne qui n'est pas le quota — session `gh` expirée, dépôt inaccessible —
# ne doit pas faire relancer un superviseur toutes les cinq minutes pour rien.
# On repousse le prochain réveil sans désarmer : la panne peut se réparer seule.
BACKOFF = RUNS_DIR / "supervisor.backoff"
BACKOFF_SECONDS = 1800
# Garde-fou de dernier recours : une intention oubliée ne doit pas autoriser une
# relance des mois plus tard. Le désarmement normal vient de la fin du run.
INTENT_TTL = 14 * 86400

# Les branches d'intégration ne portent pas de travail de ticket. `develop`
# avance à chaque merge sans qu'un agent y soit pour rien : la compter ferait
# passer un leg stérile pour un leg productif.
INTEGRATION_BRANCHES = {"develop", "staging", "main"}
# Deux legs de suite sans un commit de plus, c'est la signature de #138 : la
# boucle rend la main avant la phase de commit, le leg suivant refait le même
# travail, et rien ne devient jamais durable. Deux et pas trois — chaque leg
# stérile coûte une dizaine de dollars, et le troisième n'apprend rien de plus
# que le deuxième.
DRY_LEGS_LIMIT = 2
# Au-delà de ce silence dans le journal du run, plus personne ne l'orchestre.
# Une phase de ticket dure quelques minutes, jamais dix : un journal muet depuis
# dix minutes signifie que l'orchestrateur est parti, pas qu'il réfléchit.
ORCHESTRATOR_QUIET = 600
# Ce que dit le `subtype` du message `result` de Claude Code, en clair. « success »
# ne signifie pas « la vague est terminée » : il dit seulement que l'appel s'est
# achevé sans erreur — y compris lorsque la boucle a rendu la main alors que ses
# agents travaillaient encore. Le journal doit nommer cela, sans quoi cinq legs
# stériles se lisent comme cinq succès.
END_REASONS = {
    "success": "rendu la main de lui-même",
    "error_max_turns": "limite de tours atteinte",
    "error_during_execution": "erreur pendant l'exécution",
}

GO, PAUSE, STOP, NO_RUN, QUOTA = 0, 1, 2, 3, 4

# Une fenêtre de quota dure cinq heures : c'est la seule attente à tenir quand
# l'API n'a pas dit quand elle se rouvrirait.
FALLBACK_WINDOW = 5 * 3600
# Le mot du serveur, pas le nôtre : ces motifs ne servent que si le flux s'est
# interrompu avant l'événement structuré.
# `429` seul se retrouve dans un numéro de ligne, un port ou un compte de tests :
# le motif exige donc un contexte HTTP. Ce filet ne sert que si le flux s'est
# interrompu avant l'événement structuré, qui reste la source de vérité.
LIMIT_TEXT = re.compile(
    r"usage limit reached|rate[ _-]?limit|limite d'utilisation"
    r"|quota (?:épuisé|exceeded)|too many requests"
    r"|(?:status|http|code)\s*[:= ]?\s*429", re.I)


def resolve_binary(name):
    """Le chemin complet de l'exécutable, ou son nom si on ne le trouve pas.

    Indispensable sous Windows : Claude Code s'installe en `claude.CMD`, que
    `Popen` sans shell ne résout pas — il lève `FileNotFoundError`. Le préflight
    passait pourtant, parce qu'il interroge `shutil.which` sans réinjecter ce
    qu'il trouve dans la commande.
    """
    return shutil.which(name) or name


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hm(epoch):
    return datetime.fromtimestamp(float(epoch)).strftime("%H:%M")


def human_delta(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02d}"
    return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}"


def say(message, level="INFO"):
    line = f"{datetime.now().strftime('%H:%M:%S')}  {level:<5}  {message}"
    print(line, flush=True)
    try:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        with open(SUPERVISOR_LOG, "a", encoding="utf-8") as handle:
            handle.write(f"{now()}  {level:<5}  {message}\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Dialogue avec le run
# --------------------------------------------------------------------------- #

def runner(*args, capture=True):
    return subprocess.run([sys.executable, str(RUNNER), *args], cwd=ROOT,
                          capture_output=capture, text=True,
                          encoding="utf-8", errors="replace")


def current_run():
    if CURRENT.exists():
        candidate = CURRENT.read_text(encoding="utf-8").strip()
        if candidate and (RUNS_DIR / candidate).exists():
            return candidate
    return None


def quota_file_hold():
    """La retenue en cours telle qu'elle est sur le disque, ou None.

    Lue à chaque tour de l'attente : un `quota clear` passé à la main depuis
    `milestone_run.py shell` doit réveiller le superviseur tout de suite.
    """
    run_id = current_run()
    if not run_id:
        return None
    path = RUNS_DIR / run_id / "quota.json"
    if not path.exists():
        return None
    try:
        quota = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if quota.get("status") != "held":
        return None
    if quota.get("until") is None or time.time() >= float(quota["until"]):
        return None
    return quota


def save_intent(args):
    INTENT.parent.mkdir(parents=True, exist_ok=True)
    INTENT.write_text(json.dumps({
        "milestone": args.milestone, "width": args.width,
        "waves_per_leg": args.waves_per_leg, "no_merge": args.no_merge,
        "permission_mode": args.permission_mode, "model": args.model,
        "margin": args.margin, "patience": args.patience,
        "max_legs": args.max_legs, "claude": args.claude, "armed": now(),
        "expires": time.time() + INTENT_TTL,
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def load_intent():
    if not INTENT.exists():
        return None
    try:
        return json.loads(INTENT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def authorised():
    """L'autorisation du dispositif, et rien d'autre : un run ouvert.

    C'est la règle posée par l'utilisateur, et elle est vérifiée ici plutôt que
    supposée ailleurs : **tant qu'un run est en cours, la relance automatique a
    le droit de s'exécuter ; dès qu'il n'y en a plus, elle n'a plus rien à
    faire et se supprime.** Le marqueur est le run lui-même — `current` pointant
    sur un dossier de run existant — et non le terminal qui l'a ouvert : un run
    doit survivre à la fermeture d'une fenêtre et à un redémarrage, sans quoi la
    reprise après quota ne servirait à rien.

    Rend (autorisé, motif du refus).
    """
    intent = load_intent()
    if intent is None:
        return False, "aucune intention armée"
    if current_run() is None:
        return False, "aucun run ouvert"
    expires = intent.get("expires")
    if expires is not None and time.time() >= float(expires):
        return False, "intention périmée"
    return True, None


def intent_argv(intent):
    """L'intention, retraduite en ligne de commande pour un superviseur neuf."""
    argv = []
    if intent.get("milestone"):
        argv.append(intent["milestone"])
    # `--yes` est inconditionnel, et c'est assumé : un superviseur ressuscité
    # par la tâche planifiée n'a aucun terminal, et une vague tourne en
    # `claude -p` où aucune question ne peut recevoir de réponse. Demander un
    # arbitrage ici bloquerait le jalon sans personne pour le débloquer. La
    # protection des périmètres sensibles ne passe donc pas par une question,
    # mais par `pr_gate.py`, qui refuse de les merger sans surveillance.
    argv += ["--width", str(intent.get("width", 3)),
             "--waves-per-leg", str(intent.get("waves_per_leg", 1)),
             "--permission-mode", intent.get("permission_mode", "acceptEdits"),
             "--margin", str(intent.get("margin", 90)),
             "--patience", str(intent.get("patience", 2)),
             "--max-legs", str(intent.get("max_legs", 40)),
             "--claude", intent.get("claude", "claude"), "--yes"]
    if intent.get("no_merge"):
        argv.append("--no-merge")
    if intent.get("model"):
        argv += ["--model", intent["model"]]
    return argv


def hold_off(seconds, why):
    """Repousse le prochain réveil de la veille, sans la désarmer."""
    until = time.time() + seconds
    try:
        BACKOFF.parent.mkdir(parents=True, exist_ok=True)
        BACKOFF.write_text(json.dumps({"until": until, "why": why,
                                       "iso": now()}), encoding="utf-8")
    except OSError:
        return
    say(f"veille repoussée à {hm(until)} — {why}", "WARN")


def held_off():
    if not BACKOFF.exists():
        return False
    try:
        until = json.loads(BACKOFF.read_text(encoding="utf-8"))["until"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return False
    if time.time() >= float(until):
        try:
            BACKOFF.unlink()
        except OSError:
            pass
        return False
    return True


def beat():
    try:
        HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT.write_text(json.dumps({"pid": os.getpid(), "at": time.time(),
                                         "iso": now()}), encoding="utf-8")
    except OSError:
        pass


def heartbeat_age():
    """Âge du dernier battement, ou None si personne ne bat."""
    if not HEARTBEAT.exists():
        return None
    try:
        beaten = json.loads(HEARTBEAT.read_text(encoding="utf-8"))["at"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return None
    return time.time() - float(beaten)


def supervisor_alive():
    age = heartbeat_age()
    return age is not None and age < HEARTBEAT_STALE


def start_beating():
    """Bat tant que le processus vit, et rend de quoi l'arrêter à la toute fin.

    Il faut un fil : la boucle principale passe des heures bloquée sur la
    lecture d'un flux ou sur une attente de quota, et un battement posé au fil
    des tours vieillirait assez pour que le chien de garde croie le superviseur
    mort et en lance un second.

    Son signal lui est propre — surtout pas celui de l'arrêt demandé. Un Ctrl-C
    ne coupe pas la vague en cours : elle tourne encore des dizaines de minutes.
    Faire cesser le battement à cet instant, c'est se déclarer mort en
    travaillant, et voir la veille lancer un second superviseur qui mènera une
    seconde vague et une seconde série de merges sur le même `develop`.
    """
    silence = threading.Event()

    def loop():
        while not silence.wait(HEARTBEAT_EVERY):
            beat()

    def stop():
        # Le battement s'éteint avec le processus, et le fichier disparaît avec
        # lui : sinon la veille attendrait trois minutes de plus avant de
        # constater une mort déjà consommée.
        silence.set()
        try:
            HEARTBEAT.unlink()
        except OSError:
            pass

    beat()
    threading.Thread(target=loop, daemon=True).start()
    atexit.register(stop)
    return silence


def progress_count(no_merge=False):
    """Combien de tickets ont abouti depuis l'ouverture du run.

    Délégué à `milestone_run.py progress`, qui compte dans le journal et non
    dans le plan. La distinction décide du sort du dispositif : chaque vague se
    termine par un `replan`, qui retire du plan les issues closes. Un décompte
    pris sur le plan retomberait donc à zéro après chaque vague **réussie**, le
    détecteur d'enlisement conclurait que rien n'avance, et le superviseur se
    débrancherait au bout de trois vagues — précisément quand tout va bien.

    En `--no-merge` c'est pire encore : rien ne se ferme jamais, le compte reste
    à zéro dès la première vague. D'où `--pr-open`, qui compte alors les tickets
    arrivés en PR — le seul avancement observable dans ce mode.
    """
    proc = runner("progress", *(["--pr-open"] if no_merge else []))
    if proc.returncode not in (GO, QUOTA) or not proc.stdout.strip():
        return None
    try:
        return int(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None


def git_lines(*argv):
    """Sortie de `git`, ligne à ligne ; liste vide si l'appel échoue.

    Le superviseur ne doit jamais mourir d'un appel git. Un dépôt momentanément
    verrouillé par un agent doit se lire « rien de neuf », pas « plantage » —
    sans quoi la veille relancerait toutes les cinq minutes un superviseur qui
    remourrait de la même façon.
    """
    try:
        proc = subprocess.run(["git", *argv], cwd=ROOT, capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def work_commits():
    """Les empreintes des commits de travail, toutes branches de tickets confondues.

    On rend un **ensemble d'empreintes**, jamais un décompte, et c'est délibéré :
    une branche mergée disparaît, et un décompte retomberait — le même piège que
    `progress_count` documente au-dessus. L'appelant accumule les empreintes
    vues, si bien qu'un merge ne peut pas faire passer un leg productif pour un
    leg stérile.

    Les branches d'intégration sont exclues : elles ne portent pas de travail de
    ticket, et `develop` avance à chaque merge sans qu'un agent y soit pour rien.
    """
    shas = set()
    for ref in git_lines("for-each-ref", "--format=%(refname:short)", "refs/heads"):
        if ref in INTEGRATION_BRANCHES:
            continue
        shas.update(git_lines("rev-list", f"origin/develop..{ref}"))
    return shas


def current_run_dir():
    """Le dossier du run courant, ou None si aucun n'est ouvert."""
    try:
        run_id = (RUNS_DIR / "current").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not run_id:
        return None
    path = RUNS_DIR / run_id
    return path if path.is_dir() else None


def current_run_milestone():
    """Le jalon du run ouvert, ou None.

    Un run ouvert **désigne déjà son jalon**. Sans cela, un superviseur lancé
    sans argument redevine « le jalon dont l'échéance est la plus proche » et
    peut ouvrir un run neuf sur un autre jalon, en abandonnant celui qui était
    en cours — c'est arrivé, et le run S1 a perdu la main au profit d'un S3
    parasite (#130).
    """
    directory = current_run_dir()
    if directory is None:
        return None
    try:
        return (json.loads((directory / "run.json").read_text(encoding="utf-8"))
                .get("milestone")) or None
    except (OSError, json.JSONDecodeError, AttributeError):
        return None


def orchestrator_active():
    """Quelqu'un orchestre-t-il déjà ce run, superviseur ou non ?

    `supervisor_alive()` ne voit qu'un superviseur, parce que lui seul écrit un
    battement. Une session Claude Code qui déroule `/milestone` à la main
    orchestre pourtant tout autant — et lui était invisible : la veille lançait
    un second orchestrateur sur le même run, dont la réconciliation prenait les
    worktrees du premier pour des vestiges et les supprimait (#130).

    Le journal du run fait office de battement : agents et orchestrateur y
    écrivent à chaque phase. Un journal touché il y a moins de
    `ORCHESTRATOR_QUIET` secondes signifie que quelqu'un travaille, et la veille
    n'a alors rien à faire.
    """
    directory = current_run_dir()
    if directory is None:
        return False
    try:
        age = time.time() - (directory / "journal.ndjson").stat().st_mtime
    except OSError:
        return False
    return age < ORCHESTRATOR_QUIET


def sterile_streak(previous, fresh, issue):
    """Combien de legs de suite n'ont rien rendu durable, celui-ci compris.

    Un leg est stérile quand il n'a produit aucun commit — quoi qu'en dise son
    propre compte rendu. Le quota fait exception : un leg coupé par l'API n'a pas
    démérité, il n'a pas eu le temps, et le compter stérile désarmerait le
    dispositif pour la seule raison que la fenêtre s'est refermée.

    Toute autre panne compte, elle : un leg qui échoue sans rien commiter laisse
    exactement le même dépôt qu'un leg qui rend la main trop tôt.
    """
    if issue == "quota":
        return previous
    return 0 if fresh else previous + 1


def journal(status, message, level=None):
    args = ["event", "--actor", "superviseur", "--status", status,
            "--message", message, "--quiet"]
    if level:
        args += ["--level", level]
    runner(*args)


# --------------------------------------------------------------------------- #
# Le chien de garde — ce qui survit au superviseur
# --------------------------------------------------------------------------- #

def pythonw():
    """L'interpréteur sans console : la veille ne doit ouvrir aucune fenêtre."""
    candidate = Path(sys.executable).with_name("pythonw.exe")
    return str(candidate) if candidate.exists() else sys.executable


def write_watchdog_cmd():
    """Un .cmd d'une ligne plutôt que des arguments dans la tâche.

    `schtasks /TR` cite ses arguments d'une façon qui varie avec la version de
    Windows et se casse sur un chemin contenant une espace — et celui de ce
    dépôt en contient une. Un fichier .cmd ramène la tâche à un simple chemin.
    """
    WATCHDOG_CMD.parent.mkdir(parents=True, exist_ok=True)
    WATCHDOG_CMD.write_text(
        "@echo off\r\n"
        f'cd /d "{ROOT}"\r\n'
        f'"{pythonw()}" "{Path(__file__).resolve()}" --watchdog\r\n',
        encoding="utf-8")


def schtasks(*args):
    try:
        return subprocess.run(["schtasks", *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(args, 1, "", str(exc))


def watchdog_armed():
    return os.name == "nt" and schtasks("/Query", "/TN", TASK_NAME).returncode == 0


def arm_watchdog(every):
    """Enregistre la veille — idempotent, et sans droits d'administrateur.

    C'est ce qui rend la reprise vraie : le superviseur peut mourir de n'importe
    quoi, la tâche le rappellera dans les `every` minutes.
    """
    if os.name != "nt":
        say("veille automatique non gérée hors Windows — laisser "
            "`milestone_supervise.py` tourner dans un terminal", "WARN")
        return False
    write_watchdog_cmd()
    # Les guillemets sont indispensables et invisibles : sans eux `schtasks`
    # coupe le chemin à la première espace, rend malgré tout 0, et la tâche ne
    # s'exécute jamais. Vérifié — création réussie, exécution muette.
    proc = schtasks("/Create", "/TN", TASK_NAME, "/TR", f'"{WATCHDOG_CMD}"',
                    "/SC", "MINUTE", "/MO", str(every), "/F")
    if proc.returncode != 0:
        say("la tâche de veille n'a pas pu être enregistrée : "
            + (proc.stderr or proc.stdout).strip()[:200], "ERROR")
        return False
    say(f"veille armée · réveil toutes les {every} min · tâche « {TASK_NAME} »")
    return True


def disarm_watchdog(quiet=False):
    if os.name != "nt":
        return True
    proc = schtasks("/Delete", "/TN", TASK_NAME, "/F")
    if not quiet:
        say("veille désarmée" if proc.returncode == 0
            else "aucune veille à désarmer")
    try:
        WATCHDOG_CMD.unlink()
    except OSError:
        pass
    return proc.returncode == 0


def spawn_supervisor(intent):
    """Relance un superviseur détaché — il survivra à la tâche qui l'a lancé."""
    command = [resolve_binary(pythonw()), str(Path(__file__).resolve()),
               *intent_argv(intent)]
    flags = 0
    if os.name == "nt":
        flags = (getattr(subprocess, "DETACHED_PROCESS", 0)
                 | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    with open(SUPERVISOR_LOG, "a", encoding="utf-8") as log:
        subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT,
                         creationflags=flags, close_fds=True)
    say("veille : superviseur relancé · " + " ".join(intent_argv(intent)))


def cmd_watchdog(args):
    """Un réveil de la tâche planifiée : trois questions, aucune action inutile.

    Ce tour se produit toutes les cinq minutes pendant des jours : il n'écrit
    donc dans le journal que lorsqu'il agit, jamais pour dire qu'il n'a rien
    fait.
    """
    # Un superviseur qui bat passe avant tout contrôle : au tout premier appel,
    # le run n'existe pas encore — c'est la première vague qui l'ouvre — et le
    # désarmer ici tuerait le dispositif au moment précis où il démarre.
    if supervisor_alive():
        return 0

    # Un orchestrateur qui n'est pas un superviseur en est un quand même. Une
    # session Claude Code déroulant `/milestone` à la main n'écrit aucun
    # battement : sans ce contrôle, la veille lui lance un concurrent sur le
    # même run, et le second prend les worktrees du premier pour des vestiges.
    if orchestrator_active():
        return 0

    # L'autorisation ensuite, avant toute relance : sans run ouvert, la veille
    # n'a plus de raison d'être et se supprime elle-même.
    allowed, refusal = authorised()
    if not allowed:
        if watchdog_armed():
            say(f"veille : {refusal} — désarmement")
            retire(refusal)
        return 0

    intent = load_intent()

    if quota_file_hold() is not None:
        return 0                    # quota encore fermé : ne pas brûler un appel

    if held_off():
        return 0                    # panne récente, on laisse le temps passer

    verdict = runner("gate").returncode
    if verdict in (STOP, PAUSE):
        say("veille : pause ou arrêt demandé dans le run — désarmement", "WARN")
        disarm_watchdog(quiet=True)
        return 0
    if verdict == NO_RUN:
        say("veille : plus rien à traiter — jalon déroulé, désarmement")
        disarm_watchdog(quiet=True)
        try:
            INTENT.unlink()
        except OSError:
            pass
        return 0
    if verdict == QUOTA:
        return 0                    # une retenue vient d'être posée

    say("veille : du travail reste et aucun superviseur ne bat — relance")
    spawn_supervisor(intent)
    return 0


def cmd_state(args):
    intent = load_intent()
    age = heartbeat_age()
    allowed, refusal = authorised()
    print(f"veille planifiée   : {'armée' if watchdog_armed() else 'absente'}"
          f"  ({TASK_NAME})")
    print("autorisation       : "
          + (f"accordée — run {current_run()} ouvert" if allowed
             else f"retirée — {refusal}"))
    print("superviseur        : "
          + (f"vivant, dernier battement il y a {human_delta(age)}"
             if supervisor_alive()
             else (f"éteint — dernier battement il y a {human_delta(age)}"
                   if age is not None else "éteint")))
    if intent:
        print(f"jalon armé         : {intent.get('milestone') or '(le plus proche)'}"
              f" · largeur {intent.get('width')} · "
              f"{'PR seules' if intent.get('no_merge') else 'merge automatique'}")
        print(f"armé le            : {intent.get('armed')}")
    else:
        print("jalon armé         : aucun")
    hold = quota_file_hold()
    print("quota              : "
          + (f"épuisé, reprise à {hm(hold['until'])} dans "
             f"{human_delta(float(hold['until']) - time.time())}"
             if hold else "disponible"))
    print(f"journal            : {SUPERVISOR_LOG}")
    return 0


# --------------------------------------------------------------------------- #
# Préflight — ce qui rendrait l'attente inutile
# --------------------------------------------------------------------------- #

def workspace_trusted():
    """Claude Code ignore l'allowlist d'un dossier non approuvé.

    En mode `-p`, aucune demande de permission ne peut être répondue : les
    outils refusés font échouer les agents en silence. Autant le dire avant de
    lancer un run de plusieurs heures.
    """
    path = Path.home() / ".claude.json"
    if not path.exists():
        return None
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    for key, project in (config.get("projects") or {}).items():
        if Path(key).resolve() == ROOT.resolve():
            return bool(project.get("hasTrustDialogAccepted"))
    return False


def announce_merge_policy(args):
    """Dit, à l'armement, ce que le dispositif mergera tout seul.

    Ce n'est pas une invite, et ce n'est pas un oubli : `arm_supervision()`
    appelle ce script en `subprocess.run(capture_output=True)`, donc sans
    terminal ni entrée standard. Un `input()` ici n'aurait personne pour y
    répondre — il ferait échouer l'armement au lieu de le protéger. L'opérateur
    est donc informé par la sortie, que l'appelant recopie ligne à ligne.
    """
    if args.no_merge:
        say("armé en --no-merge : les vagues s'arrêteront aux PR, aucune ne "
            "sera mergée.")
        return
    say("armé SANS --no-merge : toute PR verte sera mergée sur develop sans "
        "relecture humaine, y compris après une coupure de quota et hors de "
        "toute session.", "WARN")
    say("exception — périmètres sensibles ({}) : ces PR ne seront pas mergées "
        "et resteront ouvertes pour relecture.".format(SENSITIVE_SCOPES), "WARN")
    say("tout débrancher : python scripts/milestone_supervise.py --disarm")


def preflight(args):
    problems, warnings = [], []

    if shutil.which(args.claude) is None:
        problems.append(f"« {args.claude} » introuvable dans le PATH")
    if shutil.which("gh") is None:
        problems.append("« gh » introuvable — le plan ne peut pas être calculé")
    else:
        # Le délai est indispensable — ce contrôle est sur le chemin critique de
        # `/milestone start` — mais il lève, et l'exception tuerait le
        # superviseur que la veille relancerait pour qu'il remeure pareil.
        try:
            proc = subprocess.run(["gh", "auth", "status"], capture_output=True,
                                  text=True, encoding="utf-8",
                                  errors="replace", timeout=30)
            failed = proc.returncode != 0
        except subprocess.SubprocessError:
            failed = True
        if failed:
            problems.append("`gh auth status` en échec — session GitHub expirée")
    if not (ROOT / ".git").exists():
        problems.append(f"{ROOT} n'est pas un dépôt git")

    trusted = workspace_trusted()
    if trusted is False:
        warnings.append(
            "ce dossier n'est pas approuvé : Claude Code ignorera les "
            "permissions de .claude/settings.json et les agents seront bloqués. "
            "Ouvrir Claude Code une fois ici et accepter la boîte de confiance, "
            "ou lancer avec --permission-mode bypassPermissions.")
    if args.permission_mode == "bypassPermissions":
        warnings.append("--permission-mode bypassPermissions : aucune commande "
                        "ne sera soumise à autorisation pendant tout le run.")

    for problem in problems:
        say(problem, "ERROR")
    for warning in warnings:
        say(warning, "WARN")
    return not problems


# --------------------------------------------------------------------------- #
# Une étape : un appel à Claude Code, une vague
# --------------------------------------------------------------------------- #

def leg_prompt(args):
    parts = ["/milestone"]
    if args.milestone:
        parts.append(args.milestone)
    parts += ["--width", str(args.width), "--waves", str(args.waves_per_leg)]
    if args.no_merge:
        parts.append("--no-merge")
    if args.yes:
        parts.append("--yes")
    return " ".join(parts)


def drain(stream, sink):
    for line in iter(stream.readline, ""):
        sink.append(line)
    try:
        stream.close()
    except OSError:
        pass


def run_leg(args, index):
    """Un appel `claude -p`, lu au fil de l'eau.

    Rend (issue, info_quota, résumé). `issue` vaut « quota » dès que le serveur
    a refusé la requête : le reste du flux n'a plus d'intérêt, l'appel est mort.
    """
    prompt = leg_prompt(args)
    command = [resolve_binary(args.claude), "-p", prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", args.permission_mode]
    if args.model:
        command += ["--model", args.model]

    say(f"vague {index} · claude -p \"{prompt}\"")
    if args.dry_run:
        return None, None, "simulation — rien lancé"

    LEGS_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = LEGS_DIR / f"leg-{index:03d}-{datetime.now():%Y%m%d-%H%M%S}.ndjson"

    # Sans surveillance, aucun arbitrage ne peut être posé : `pr_gate.py` lit
    # cette variable et refuse alors de merger les PR de périmètre sensible, qui
    # restent ouvertes. Passer par l'environnement plutôt que par un drapeau du
    # prompt est ce qui rend la règle vraie même si l'orchestrateur l'oublie —
    # tout `pr_gate.py` lancé dans la vague en hérite sans avoir à y penser.
    env = dict(os.environ)
    if not args.no_merge:
        env["SPA_UNATTENDED"] = "1"

    try:
        process = subprocess.Popen(
            command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
    except (OSError, ValueError) as exc:
        # Sans cela, l'exception remonte, le superviseur meurt, et la veille le
        # relance toutes les cinq minutes pour qu'il remeure de la même façon.
        say(f"impossible de lancer « {command[0]} » : {exc}", "ERROR")
        return "lancement", None, f"{type(exc).__name__} : {exc}"

    errors = []
    pump = threading.Thread(target=drain, args=(process.stderr, errors), daemon=True)
    pump.start()

    limit_info, summary, issue = None, None, None
    with open(raw_path, "w", encoding="utf-8") as raw:
        for line in process.stdout:
            raw.write(line)
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = message.get("type")
            if kind == "rate_limit_event":
                info = message.get("rate_limit_info") or {}
                status = info.get("status")
                if status == "rejected":
                    limit_info, issue = info, "quota"
                    say(f"quota {info.get('rateLimitType') or 'inconnu'} refusé "
                        f"par le serveur", "WARN")
                    break
                if status == "allowed_warning":
                    used = info.get("utilization")
                    say(f"quota {info.get('rateLimitType') or ''} à "
                        f"{int((used or 0) * 100)}%"
                        + (f", fenêtre jusqu'à {hm(info['resetsAt'])}"
                           if info.get("resetsAt") else ""), "WARN")
                    limit_info = info
                elif info.get("resetsAt"):
                    limit_info = info

            elif kind == "assistant" and args.echo:
                for block in (message.get("message") or {}).get("content") or []:
                    text = (block.get("text") or "").strip()
                    if text:
                        say("  claude · " + text.splitlines()[0][:140], "DEBUG")

            elif kind == "result":
                summary = message
                if message.get("is_error") and LIMIT_TEXT.search(
                        str(message.get("result") or "")):
                    issue = issue or "quota"

    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
    pump.join(timeout=5)

    stderr = "".join(errors)
    if issue is None and process.returncode not in (0, None):
        issue = "quota" if LIMIT_TEXT.search(stderr) else "échec"

    note = "terminée"
    if summary:
        cost = summary.get("total_cost_usd")
        subtype = summary.get("subtype") or "?"
        note = (f"{END_REASONS.get(subtype, subtype)} · "
                f"{summary.get('num_turns', '?')} tours"
                + (f" · {cost:.2f} $" if isinstance(cost, (int, float)) else ""))
    elif stderr.strip():
        note = stderr.strip().splitlines()[-1][:160]

    return issue, limit_info, note


# --------------------------------------------------------------------------- #
# L'attente
# --------------------------------------------------------------------------- #

def wait_for_quota(args, info, stop_flag, source=None):
    """Inscrit la retenue, dort jusqu'au rafraîchissement, puis la lève.

    L'échéance vient du serveur (`resetsAt`) quand il l'a donnée ; sinon on
    prend la fenêtre pleine, quitte à attendre trop — se réveiller trop tôt
    coûterait un appel refusé de plus, et la même attente derrière.
    """
    until = info.get("resetsAt") if info else None
    kind = (info or {}).get("rateLimitType") or "five_hour"
    if until:
        until = float(until) + args.margin
        source = source or "annoncé par le serveur"
    else:
        until = time.time() + FALLBACK_WINDOW + args.margin
        source = source or "fenêtre de 5 h par défaut, le serveur n'a rien annoncé"

    runner("quota", "hold", "--until", str(until), "--kind", kind,
           "--reason", source,
           *(["--utilization", str(info["utilization"])]
             if info and info.get("utilization") is not None else []))
    say(f"quota épuisé — reprise à {hm(until)} "
        f"(dans {human_delta(until - time.time())}, {source})", "WARN")

    last_shown = 0
    while time.time() < until:
        if stop_flag.is_set():
            say("interruption pendant l'attente — la retenue reste inscrite", "WARN")
            return False
        # Un `quota clear` passé à la main depuis le shell doit réveiller tout
        # de suite : on relit le fichier plutôt que de dormir en aveugle.
        if quota_file_hold() is None:
            say("retenue levée à la main — reprise immédiate")
            return True
        left = until - time.time()
        if time.time() - last_shown >= args.tick:
            say(f"attente du quota · encore {human_delta(left)} "
                f"· reprise à {hm(until)}", "DEBUG")
            last_shown = time.time()
        time.sleep(min(15, max(1, left)))

    runner("quota", "clear")
    say("quota reconstitué — reprise du run")
    return True


# --------------------------------------------------------------------------- #

def retire(why):
    """Débranche le dispositif : plus de veille, plus d'intention à relancer.

    Appelé quand il n'y a plus rien à reprendre — jalon déroulé, arrêt demandé,
    run bloqué. Sans cela, la tâche planifiée ressusciterait un superviseur
    toutes les cinq minutes pour lui faire constater la même chose.
    """
    say(f"dispositif débranché — {why}")
    disarm_watchdog(quiet=True)
    for path in (INTENT, HEARTBEAT, BACKOFF):
        try:
            path.unlink()
        except OSError:
            pass


def supervise(args):
    stop_flag = threading.Event()

    def interrupt(signum, frame):
        stop_flag.set()
        say("arrêt demandé (Ctrl-C) — fin après l'étape en cours", "WARN")

    signal.signal(signal.SIGINT, interrupt)
    start_beating()

    say(f"superviseur ouvert · jalon {args.milestone or '(le plus proche)'} "
        f"· largeur {args.width} · {'PR seules' if args.no_merge else 'merge automatique'}")
    say(f"journal du superviseur : {SUPERVISOR_LOG}")
    say("suivre le run : python scripts/milestone_run.py watch")

    # S'armer soi-même : un superviseur lancé à la main doit laisser derrière lui
    # de quoi le ressusciter. C'est idempotent, donc sans effet s'il l'est déjà.
    if not args.dry_run and not args.no_watchdog:
        save_intent(args)
        if not watchdog_armed():
            arm_watchdog(args.every)

    # Une retenue héritée d'un plantage précédent : on la purge avant de juger.
    held = quota_file_hold()
    if held:
        say("retenue de quota trouvée en arrivant", "WARN")
        if not wait_for_quota(args, {"resetsAt": float(held["until"]) - args.margin,
                                     "rateLimitType": held.get("kind")}, stop_flag,
                              source="retenue déjà inscrite dans le run"):
            return 1

    legs, barren, dry_legs = 0, 0, 0
    # Les commits déjà là en arrivant ne sont l'œuvre d'aucun leg de ce
    # superviseur : on les tient pour vus, faute de quoi le premier leg
    # passerait pour productif sans avoir rien produit.
    seen_commits = work_commits()
    while not stop_flag.is_set():
        if legs >= args.max_legs:
            say(f"{legs} étapes atteintes (--max-legs) — arrêt", "WARN")
            return 1

        gate = runner("gate")
        verdict = gate.returncode
        for line in (gate.stdout or "").strip().splitlines():
            say("  gate · " + line, "DEBUG")

        if verdict == NO_RUN and legs > 0:
            say("plus rien à traiter — jalon déroulé")
            retire("jalon déroulé")
            return 0
        if verdict == STOP:
            say("arrêt demandé dans le run — le superviseur s'efface", "WARN")
            retire("arrêt demandé dans le run")
            return 0
        if verdict == PAUSE:
            say("pause demandée dans le run — le superviseur s'efface. "
                "`milestone_run.py shell` puis `go`, puis relancer "
                "`/milestone`, pour repartir", "WARN")
            retire("pause demandée dans le run")
            return 0
        if verdict == QUOTA:
            held = quota_file_hold()
            if held and not wait_for_quota(
                    args, {"resetsAt": float(held["until"]) - args.margin,
                           "rateLimitType": held.get("kind")}, stop_flag,
                    source="retenue déjà inscrite dans le run"):
                return 1
            continue

        before = progress_count(args.no_merge)
        legs += 1
        started = time.time()
        journal("leg_started", f"étape {legs} — une vague, largeur {args.width}")

        issue, info, note = run_leg(args, legs)
        elapsed = human_delta(time.time() - started)

        # Ce que le leg a rendu durable, mesuré sur le dépôt et non sur son
        # propre compte rendu : un leg qui se termine « success » sans un commit
        # de plus n'a rien produit qu'un `reconcile` ne puisse effacer.
        fresh = set() if args.dry_run else work_commits() - seen_commits
        seen_commits |= fresh
        if not args.dry_run:
            note = f"{note} · {len(fresh)} commit(s)"

        sterile = not args.dry_run and issue is None and not fresh
        journal("leg_ended", f"étape {legs} en {elapsed} — {note}",
                level="WARN" if issue or sterile else "INFO")
        say(f"vague {legs} rendue en {elapsed} · {note}",
            "WARN" if issue or sterile else "INFO")

        if args.dry_run:
            say("--dry-run : une seule étape simulée")
            return 0

        if issue == "quota":
            # Un leg coupé par le quota n'a pas démérité : il n'a pas eu le temps.
            # Le compter stérile désarmerait le dispositif pour la seule raison
            # que l'API s'est refermée.
            if not wait_for_quota(args, info or {}, stop_flag):
                return 1
            continue

        dry_legs = sterile_streak(dry_legs, fresh, issue)
        if dry_legs >= DRY_LEGS_LIMIT:
            # Le travail existe peut-être dans les worktrees, mais il n'est pas
            # commité : le leg suivant le refera à l'identique, pour le même
            # prix. On s'arrête et on dit où regarder.
            say(f"{dry_legs} legs de suite sans un commit de plus. Le travail "
                "n'atteint pas la phase de commit — il ne survivra pas au "
                "prochain `reconcile`. Arrêt et désarmement : regarder les "
                "worktrees de `git worktree list`, commiter ce qui s'y trouve, "
                "puis relancer. Voir #138.", "ERROR")
            journal("blocked",
                    f"{dry_legs} legs sans commit — superviseur arrêté (#138)")
            retire(f"{dry_legs} legs sans commit")
            return 1

        after = progress_count(args.no_merge)
        progressed = before is None or after is None or after > before
        barren = 0 if progressed else barren + 1
        if progressed and after is not None:
            say(f"{after} ticket(s) aboutis sur le jalon")
        if barren >= args.patience:
            # Ce n'est plus une question de quota : relancer indéfiniment un run
            # qui n'avance pas brûlerait des jetons pour rien. On débranche tout,
            # en le disant — c'est le seul cas où l'humain doit revenir.
            say(f"{barren} étapes de suite sans un ticket de plus — ce n'est pas "
                "une malchance. Arrêt et désarmement : lire "
                "`python scripts/milestone_run.py log --level WARN`, puis "
                "relancer `/milestone` une fois la cause levée.", "ERROR")
            journal("blocked", f"{barren} étapes sans avancement — superviseur arrêté")
            retire(f"{barren} étapes sans avancement")
            return 1

        if args.max_hours and (time.time() - START) > args.max_hours * 3600:
            say(f"--max-hours {args.max_hours} atteint — la veille prendra le relais",
                "WARN")
            return 0

    return 0


START = time.time()


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("milestone", nargs="?",
                        help="jalon à dérouler (défaut : l'ouvert le plus proche)")
    parser.add_argument("--width", type=int, default=3,
                        help="agents simultanés dans une vague")
    parser.add_argument("--waves-per-leg", type=int, default=1,
                        help="vagues traitées par appel à Claude Code")
    parser.add_argument("--no-merge", action="store_true",
                        help="tout mener jusqu'à la PR, sans rien merger")
    parser.add_argument("--yes", action="store_true",
                        help="ne demander aucun arbitrage — indispensable sans surveillance")
    parser.add_argument("--model", help="modèle passé à claude -p")
    parser.add_argument("--claude", default="claude", help="binaire Claude Code")
    parser.add_argument("--permission-mode", default="acceptEdits",
                        choices=["acceptEdits", "auto", "bypassPermissions",
                                 "dontAsk", "manual", "plan"])
    parser.add_argument("--margin", type=int, default=90,
                        help="secondes d'attente en plus après le rafraîchissement")
    parser.add_argument("--tick", type=int, default=300,
                        help="secondes entre deux lignes de compte à rebours")
    parser.add_argument("--max-legs", type=int, default=40,
                        help="garde-fou : nombre d'appels à Claude Code")
    parser.add_argument("--max-hours", type=float,
                        help="garde-fou : durée totale du superviseur")
    parser.add_argument("--patience", type=int, default=3,
                        help="étapes sans avancement tolérées avant l'arrêt")
    parser.add_argument("--echo", action="store_true",
                        help="recopier ce que dit Claude, ligne par ligne")
    parser.add_argument("--dry-run", action="store_true",
                        help="montrer l'appel qui serait fait, et s'arrêter")
    parser.add_argument("--force", action="store_true",
                        help="passer outre le préflight, ou un superviseur déjà vivant")

    veille = parser.add_argument_group(
        "veille", "la tâche planifiée qui ressuscite le superviseur")
    veille.add_argument("--arm", action="store_true",
                        help="armer la veille et rendre la main (appelé par `start`)")
    veille.add_argument("--disarm", action="store_true",
                        help="tout débrancher : plus aucune reprise automatique")
    veille.add_argument("--watchdog", action="store_true",
                        help="un réveil de la tâche planifiée — usage interne")
    veille.add_argument("--state", action="store_true",
                        help="qui veille, sur quoi, et où en est le quota")
    veille.add_argument("--every", type=int, default=5,
                        help="minutes entre deux réveils de la veille")
    veille.add_argument("--no-watchdog", action="store_true",
                        help="ne pas armer la veille — la reprise redevient manuelle")
    args = parser.parse_args()

    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    # Les modes qui ne lancent aucun agent, avant tout le reste : la veille se
    # réveille toutes les cinq minutes et n'a rien à faire d'un préflight.
    if args.watchdog:
        return cmd_watchdog(args)
    if args.state:
        return cmd_state(args)
    if args.disarm:
        retire("désarmement demandé")
        return 0
    if args.arm:
        # Le préflight et l'annonce de la politique de merge étaient jusqu'ici
        # hors d'atteinte de ce chemin : `--arm` rendait la main avant eux,
        # alors que c'est précisément lui qu'appelle `/milestone`. Armer était
        # donc silencieux, et un dossier de travail non approuvé n'était
        # découvert qu'au premier réveil de la veille — des heures plus tard,
        # après que les agents eurent échoué en silence faute de permissions.
        if not preflight(args) and not args.force:
            say("préflight en échec — rien n'a été armé (`--force` pour passer "
                "outre)", "ERROR")
            # Ne rien armer ne veut pas dire que rien n'est armé : une veille
            # d'un run précédent survivrait, et continuerait de ressusciter un
            # superviseur sur l'ancienne intention. Le taire laisserait
            # l'opérateur croire le dispositif à l'arrêt.
            if watchdog_armed():
                say("une veille d'un run précédent est toujours enregistrée et "
                    "continuera de tourner sur l'ancienne intention — "
                    "`--disarm` pour la retirer.", "WARN")
            return 2
        announce_merge_policy(args)
        save_intent(args)
        # `--no-watchdog` était accepté puis ignoré sur ce chemin : l'intention
        # était inscrite et la veille armée quand même. Seul `arm_supervision()`
        # filtrait, côté appelant — un garde-fou que l'appelant doit penser à
        # demander, c'est-à-dire celui qui ne se déclenche pas.
        if args.no_watchdog:
            say("veille non armée (--no-watchdog) : la reprise après une "
                "coupure devra être relancée à la main", "WARN")
            return 0
        return 0 if arm_watchdog(args.every) else 2

    # Deux superviseurs sur le même run se marcheraient dessus : deux vagues
    # lancées en même temps sur le même `develop`, et des merges concurrents.
    if supervisor_alive() and not args.force:
        say(f"un superviseur bat déjà (il y a {human_delta(heartbeat_age())}) "
            "— rien à faire. `--state` pour le voir, `--force` pour passer outre.")
        return 0

    # Même règle pour un orchestrateur qui n'est pas un superviseur : deux
    # orchestrateurs sur un run, c'est deux vagues sur le même `develop`.
    if orchestrator_active() and not args.force:
        say("le journal du run vient d'être écrit : quelqu'un orchestre déjà ce "
            "run — rien à faire. `milestone_run.py watch` pour le voir, "
            "`--force` pour passer outre.")
        return 0

    # Un run ouvert désigne son jalon ; le redeviner peut en ouvrir un autre et
    # abandonner celui qui était en cours.
    if not args.milestone:
        args.milestone = current_run_milestone()
        if args.milestone:
            say(f"jalon repris du run ouvert : {args.milestone}")

    if not preflight(args) and not args.force:
        say("préflight en échec — rien n'a été lancé (`--force` pour passer outre)",
            "ERROR")
        hold_off(BACKOFF_SECONDS, "préflight en échec")
        return 2

    if not args.no_merge and not args.yes and not args.dry_run:
        # Le même texte qu'à l'armement, et pour la même raison : deux
        # descriptions du même dispositif finiraient par diverger, et c'est
        # celle-ci que l'opérateur confirme.
        announce_merge_policy(args)
        try:
            if input("Confirmer ? [o/N] ").strip().lower() not in {"o", "oui", "y"}:
                say("abandon")
                return 1
        except EOFError:
            say("pas de terminal pour confirmer — relancer avec --yes ou --no-merge",
                "ERROR")
            return 2
        args.yes = True

    return supervise(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
