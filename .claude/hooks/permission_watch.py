#!/usr/bin/env python3
"""Hook PreToolUse — répertorie les commandes qui vont demander une permission.

Un run de jalon lance plusieurs agents en parallèle pendant des heures. Chaque
commande non autorisée interrompt le travail par une demande d'accord, et ces
demandes se répètent d'un ticket à l'autre : c'est le même `npm run verify` qui
bloque à chaque agent.

Ce hook ne décide rien et ne bloque rien. Il **observe** : pour chaque commande
Bash, il calcule le motif d'allowlist correspondant, regarde si un réglage
existant le couvre déjà, et sinon consigne l'observation. C'est
[`scripts/permissions_review.py`](../../scripts/permissions_review.py) qui, plus
tard et sur accord explicite, transforme les motifs répétés en règles `allow`.

La séparation est délibérée : un hook qui ajouterait lui-même des permissions
élargirait silencieusement ce que Claude Code peut faire sans demander. Ici, le
hook compte, l'humain décide.

Réglages : `SPA_PERMISSION_WATCH=off` désactive · `SPA_PERMISSION_LOG` déplace
le fichier d'observations.
"""
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main_root():
    """La racine du dépôt principal, même appelé depuis un worktree lié.

    Un run de jalon fait travailler ses agents dans des worktrees isolés, où
    `.claude/.milestone/` n'existe pas — il est ignoré par git. Sans cette
    résolution, chaque observation d'agent serait rattachée à `run: null`, et la
    revue de fin de run (`permissions_review.py --run <id>`) annoncerait qu'aucune
    commande n'a demandé de permission alors que des dizaines l'auront fait.
    """
    try:
        proc = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=15)
    except (OSError, subprocess.SubprocessError):
        return ROOT
    if proc.returncode != 0 or not proc.stdout.strip():
        return ROOT
    common = Path(proc.stdout.strip())
    if not common.is_absolute():
        common = (ROOT / common).resolve()
    candidate = common.parent
    return candidate if (candidate / ".claude").is_dir() else ROOT


STATE_ROOT = main_root()
OBSERVED = Path(os.environ.get(
    "SPA_PERMISSION_LOG",
    STATE_ROOT / ".claude" / ".permissions" / "observed.ndjson"))
CURRENT_RUN = STATE_ROOT / ".claude" / ".milestone" / "current"

SETTINGS = [
    ROOT / ".claude" / "settings.json",
    ROOT / ".claude" / "settings.local.json",
    Path.home() / ".claude" / "settings.json",
]

# Outils dont le verbe se trouve après le nom : `git status` n'est pas `git`.
DEPTH = {"git": 2, "gh": 3, "npm": 3, "npx": 2, "yarn": 2, "pnpm": 3,
         "docker": 3, "terraform": 2, "aws": 3, "cargo": 2, "make": 2,
         "poetry": 2, "prisma": 2}
# Outils dont l'argument utile est le fichier exécuté, pas un verbe.
RUNNERS = {"python", "python3", "py", "node", "bash", "sh", "ruby", "perl", "deno"}

READ_ONLY = {
    "ls", "cat", "head", "tail", "sed", "grep", "rg", "find", "wc", "echo",
    "pwd", "which", "file", "stat", "tree", "jq", "sort", "uniq", "cut", "awk",
    "basename", "dirname", "date", "env", "printf", "diff", "less", "type",
    # Navigation et primitives de shell : elles n'écrivent rien, mais elles
    # apparaissent dans presque toute commande composée — et déclenchent donc
    # des demandes de permission bien réelles.
    "cd", "pushd", "popd", "true", "false", "test", ":", "[",
}
READ_ONLY_SUB = {
    "git status", "git log", "git diff", "git show", "git branch", "git ls-files",
    "git rev-parse", "git worktree list", "git remote", "git config",
    "gh issue list", "gh issue view", "gh pr list", "gh pr view", "gh pr diff",
    "gh pr checks", "gh run list", "gh run view", "gh api", "gh project item-list",
    "npm run lint", "npm run typecheck", "npm run test", "npm run build",
    "npm ls", "npm view", "terraform fmt", "terraform validate", "terraform plan",
    "docker compose ps", "docker compose logs", "docker ps",
}
NETWORK = {"curl", "wget", "ssh", "scp", "rsync", "aws", "ping", "nc"}
NETWORK_SUB = {"git push", "git fetch", "git pull", "git clone",
               "gh pr create", "gh pr merge", "gh release create", "npm publish"}
DESTRUCTIVE = {"rm", "rmdir", "shred", "dd", "mkfs", "shutdown", "reboot", "kill",
               "killall", "truncate"}
DESTRUCTIVE_TEXT = (
    "git reset --hard", "git push --force", "git push -f", "git clean",
    "terraform apply", "terraform destroy", "prisma migrate reset",
    "prisma db push", "drop table", "drop database", "--no-preserve-root",
)

SEPARATORS = ("&&", "||", ";", "|", "\n")


def quiet():
    sys.exit(0)


def read_event():
    # Sous Windows, sys.stdin décode en cp1252 : lire les octets et décoder en
    # UTF-8, sinon un accent dans la commande corrompt l'observation.
    try:
        return json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except Exception:
        return {}


def segments(command):
    """Découpe une commande composée — elle bloque si l'un de ses morceaux bloque."""
    parts = [command]
    for separator in SEPARATORS:
        nxt = []
        for part in parts:
            nxt.extend(part.split(separator))
        parts = nxt
    return [p.strip() for p in parts if p.strip()]


def tokenize(segment):
    try:
        tokens = shlex.split(segment, posix=True)
    except ValueError:
        tokens = segment.split()
    # `FOO=bar cmd` : l'affectation d'environnement n'est pas le programme.
    while tokens and "=" in tokens[0] and not tokens[0].startswith("-"):
        tokens = tokens[1:]
    return tokens


def pattern_of(segment):
    """Le motif d'allowlist le plus étroit qui couvre naturellement ce segment."""
    tokens = tokenize(segment)
    if not tokens:
        return None
    executable = Path(tokens[0]).name.lower()
    if executable.endswith(".exe"):
        executable = executable[:-4]

    if executable in RUNNERS:
        target = next((t for t in tokens[1:] if not t.startswith("-")), None)
        return f"{executable} {target}" if target else executable

    depth = DEPTH.get(executable, 1)
    kept = [executable]
    for token in tokens[1:]:
        if len(kept) >= depth:
            break
        if token.startswith("-") or token.isdigit():
            break
        kept.append(token)
    return " ".join(kept)


def classify(pattern, segment):
    lowered = segment.lower()
    if any(marker in lowered for marker in DESTRUCTIVE_TEXT):
        return "destructive"
    head = pattern.split()[0]
    if head in DESTRUCTIVE:
        return "destructive"
    if head in NETWORK or any(pattern.startswith(p) for p in NETWORK_SUB):
        return "network"
    if head in READ_ONLY or any(pattern.startswith(p) for p in READ_ONLY_SUB):
        return "read"
    return "write"


def load_rules():
    allow, deny, ask = [], [], []
    for path in SETTINGS:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        permissions = data.get("permissions") or {}
        allow.extend(permissions.get("allow") or [])
        deny.extend(permissions.get("deny") or [])
        ask.extend(permissions.get("ask") or [])
    return allow, deny, ask


def bash_rules(rules):
    """Les règles portant sur Bash, réduites à leur préfixe de commande."""
    out = []
    for rule in rules:
        if not isinstance(rule, str):
            continue
        if rule == "Bash" or rule == "Bash(*)":
            out.append(("", True))
        elif rule.startswith("Bash(") and rule.endswith(")"):
            inner = rule[5:-1]
            if inner.endswith(":*"):
                out.append((inner[:-2], True))
            else:
                out.append((inner, False))
    return out


def covered(segment, rules):
    for prefix, is_prefix in rules:
        if is_prefix:
            if prefix == "" or segment.startswith(prefix):
                return True
        elif segment == prefix:
            return True
    return False


def current_run():
    try:
        return CURRENT_RUN.read_text(encoding="utf-8").strip() or None
    except Exception:
        return None


def main():
    if os.environ.get("SPA_PERMISSION_WATCH", "").lower() in {"off", "0", "false"}:
        quiet()

    event = read_event()
    if event.get("tool_name") != "Bash":
        quiet()
    command = (event.get("tool_input") or {}).get("command") or ""
    if not command.strip():
        quiet()

    allow, deny, ask = load_rules()
    allow_rules, deny_rules, ask_rules = bash_rules(allow), bash_rules(deny), bash_rules(ask)

    observations = []
    for segment in segments(command):
        if covered(segment, allow_rules) and not covered(segment, ask_rules):
            continue                       # déjà autorisé : ne bloquera pas
        pattern = pattern_of(segment)
        if not pattern:
            continue
        observations.append({
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pattern": pattern,
            "example": segment[:200],
            "risk": classify(pattern, segment),
            "denied": covered(segment, deny_rules),
            "session": event.get("session_id"),
            "run": current_run(),
        })

    if not observations:
        quiet()

    try:
        OBSERVED.parent.mkdir(parents=True, exist_ok=True)
        # Une ligne, une écriture : plusieurs agents écrivent ici en même temps.
        with open(OBSERVED, "a", encoding="utf-8") as handle:
            for record in observations:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass                               # observer ne doit jamais empêcher d'agir

    quiet()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        quiet()
