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

**Une invocation, une observation** — voir la note sur la tokenisation plus bas.

Réglages : `SPA_PERMISSION_WATCH=off` désactive · `SPA_PERMISSION_LOG` déplace
le fichier d'observations.
"""
import functools
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"


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
# Drapeaux dont l'argument est un programme écrit sur place, et non un fichier :
# `python -c "import io"` n'exécute pas un script nommé « import ». La table est
# donnée par outil, car le même drapeau ne dit pas la même chose partout : `-e`
# évalue du code pour node, deno, ruby et perl, mais arme `errexit` pour bash et
# sh — `bash -e scripts/deploy.sh` exécute bien un fichier.
INLINE_CODE_FLAGS = {
    "python": {"-c"}, "python3": {"-c"}, "py": {"-c"},
    "bash": {"-c"}, "sh": {"-c"},
    "node": {"-e", "--eval"}, "deno": {"-e", "--eval"},
    "ruby": {"-e"}, "perl": {"-e"},
}

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

# ---------------------------------------------------------------------------
# Tokenisation : une invocation, une observation (#215)
#
# Ce hook a longtemps découpé la commande sur ses séparateurs, **saut de ligne
# compris**, et pris le premier mot de chaque morceau pour un nom de programme.
# Or une invocation Bash est très souvent multi-lignes sans être multi-commandes :
#
#   - un heredoc embarque un document entier — c'est ainsi que les corps de PR,
#     les corps d'issue et les livrables Markdown de ce dépôt sont écrits. Ce
#     corps n'est pas exécuté : c'est de la donnée ;
#   - une commande à rallonge se poursuit derrière un « \ » — d'où `--title`,
#     `--label`, `--body-file` promus au rang d'exécutables ;
#   - une boucle `for … do … done` occupe trois lignes, dont deux mots réservés.
#
# Sur le run `s1-fondations-20260825-093729`, 4 409 des 4 672 motifs consignés —
# 94 % — étaient de la donnée prise pour du code. #137 a appris à la revue à les
# écarter *à la lecture* ; ici, on cesse de les **écrire** :
#
#   - le corps d'un heredoc est retiré avant tout découpage ;
#   - les lignes continuées par « \ » sont recollées ;
#   - le découpage sur `&&`, `||`, `;` et `|` ignore ce qui est entre quotes —
#     un `|` dans un message de commit n'est pas un tuyau ;
#   - le saut de ligne ne sépare plus que ce qui reste après ces deux passes, et
#     jamais à l'intérieur de quotes : une invocation étalée sur dix lignes reste
#     une invocation, mais deux commandes écrites l'une sous l'autre restent deux
#     commandes — sans quoi `cd apps/api` suivi de `npm run verify` ne
#     consignerait que le `cd`, et le second n'aurait aucune chance d'être un
#     jour autorisé ;
#   - le corps de `-c` / `-e` n'est pas la cible du runner :
#     `python -c "import io"` donne `python -c`, et non `python import io` —
#     seul résidu que le garde-fou de #137 ne savait pas voir, puisque son nom de
#     commande est légitime.
#
# Enfin ce garde-fou — `permissions_review.py::not_a_command` — est **importé**
# plutôt que dupliqué : ce que la revue écarte de toute façon n'a plus à occuper
# le disque ni à être trié à chaque lecture.
# ---------------------------------------------------------------------------

# `&` seul n'est pas un séparateur : le dépôt vit sous « Spa & Booking », et une
# esperluette non citée y désigne bien plus souvent un chemin qu'un arrière-plan.
#
# `<<MARQUEUR`, `<<-MARQUEUR`, `<< "MARQUEUR"`, `<<'MARQUEUR'`. Le `(?!<)` écarte
# le herestring `<<<`, qui n'ouvre aucun corps, et le marqueur doit commencer par
# une lettre — sans quoi un décalage de bits `1 << 2` passerait pour un heredoc.
HEREDOC_RE = re.compile(
    r"<<(?!<)(-?)[ \t]*(?:'([^']*)'|\"([^\"]*)\"|\\?([A-Za-z_][A-Za-z0-9_]*))")

# Une ligne que termine un antislash se poursuit sur la suivante. Le `(?<!\\)`
# laisse tranquille un antislash lui-même échappé.
CONTINUATION_RE = re.compile(r"(?<!\\)\\\r?\n[ \t]*")

# `> out`, `>>out`, `2>&1`, `<in`, `<<EOF` : une redirection n'est pas un argument
# de la commande, et son fichier cible n'en est pas la sous-commande.
REDIRECTION_RE = re.compile(r"^\d*(?:<<-?|<<<|>>|[<>])")

# Le filet de dernier recours si la revue n'est pas importable : un nom de
# commande ne contient ni guillemet, ni accent, ni ponctuation Markdown.
COMMAND_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")


def quiet():
    sys.exit(0)


def read_event():
    # Sous Windows, sys.stdin décode en cp1252 : lire les octets et décoder en
    # UTF-8, sinon un accent dans la commande corrompt l'observation.
    try:
        return json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except Exception:
        return {}


def heredoc_markers(line):
    """Les marqueurs de heredoc qu'ouvre cette ligne, dans l'ordre d'ouverture.

    Le suivi des quotes est indispensable : un marqueur cité dans le corps d'un
    message n'ouvre aucun document, et avaler la suite du script serait pire que
    le bruit qu'on cherche à supprimer.
    """
    markers = []
    quote = None
    index, length = 0, len(line)
    while index < length:
        char = line[index]
        if quote:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "\"'":
            quote = char
            index += 1
            continue
        if char == "\\":
            index += 2
            continue
        if char == "<" and line.startswith("<<", index):
            if line.startswith("<<<", index):
                index += 3                 # herestring : aucun document ouvert
                continue
            match = HEREDOC_RE.match(line, index)
            if match:
                marker = next((group for group in match.group(2, 3, 4) if group),
                              None)
                if marker:
                    markers.append((marker, bool(match.group(1))))
                index = match.end()
                continue
        index += 1
    return markers


def strip_heredocs(command):
    """La commande privée du corps de ses heredocs — de la donnée, pas du code.

    Un corps non terminé est consommé jusqu'à la fin : c'est bien ce que fait le
    shell, et c'est la lecture la plus sûre pour nous — mieux vaut perdre une
    observation qu'en fabriquer une par ligne de prose.
    """
    lines = command.split("\n")
    kept, index = [], 0
    while index < len(lines):
        line = lines[index]
        index += 1
        kept.append(line)
        for marker, dedent in heredoc_markers(line):
            while index < len(lines):
                candidate = lines[index]
                index += 1
                probe = candidate.strip() if dedent else candidate.rstrip()
                if probe == marker:
                    break
    return "\n".join(kept)


def join_continuations(command):
    """Recolle les lignes qu'un antislash terminal poursuit."""
    return CONTINUATION_RE.sub(" ", command)


def segments(command):
    """Découpe une commande composée — elle bloque si l'un de ses morceaux bloque.

    Le découpage se fait sur `&&`, `||`, `;`, `|` et le saut de ligne, hors
    quotes, après avoir retiré les corps de heredoc et recollé les continuations.
    Ces deux passes suffisent à ce qu'une invocation étalée sur dix lignes reste
    une invocation ; le saut de ligne qui subsiste sépare bien deux commandes, et
    l'ignorer ferait disparaître du journal tout ce qui suit la première ligne.
    """
    text = join_continuations(strip_heredocs(command))
    parts, current = [], []
    quote = None
    index, length = 0, len(text)
    while index < length:
        char = text[index]
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "\"'":
            quote = char
            current.append(char)
            index += 1
            continue
        if char == "\\" and index + 1 < length:
            current.append(char)
            current.append(text[index + 1])
            index += 2
            continue
        if text.startswith(("&&", "||"), index):
            parts.append("".join(current))
            current = []
            index += 2
            continue
        if char in ";|\n":
            parts.append("".join(current))
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def invocation(segment):
    """La première ligne non vide d'un morceau — c'est elle qui nomme la commande.

    Un morceau est normalement d'une seule ligne ; il en garde plusieurs quand un
    saut de ligne tombe à l'intérieur de quotes — `--body "$(cat <<EOF …` — et
    c'est encore la première qui nomme le programme.
    """
    for line in segment.splitlines():
        if line.strip():
            return line.strip()
    return ""


def strip_redirections(tokens):
    """Les tokens de redirection, et le fichier cible quand l'opérateur est seul."""
    kept, skip_next = [], False
    for token in tokens:
        if skip_next:
            skip_next = False
            continue
        match = REDIRECTION_RE.match(token)
        if not match:
            kept.append(token)
            continue
        if token == match.group(0):
            skip_next = True               # `> out`, `<< EOF` : la cible suit
    return kept


def tokenize(segment):
    try:
        tokens = shlex.split(segment, posix=True)
    except ValueError:
        tokens = segment.split()
    # `FOO=bar cmd` : l'affectation d'environnement n'est pas le programme.
    while tokens and "=" in tokens[0] and not tokens[0].startswith("-"):
        tokens = tokens[1:]
    return strip_redirections(tokens)


def pattern_of(segment):
    """Le motif d'allowlist le plus étroit qui couvre naturellement ce segment."""
    tokens = tokenize(invocation(segment))
    if not tokens:
        return None
    executable = Path(tokens[0]).name.lower()
    if executable.endswith(".exe"):
        executable = executable[:-4]

    if executable in RUNNERS:
        inline = INLINE_CODE_FLAGS.get(executable, ())
        for token in tokens[1:]:
            if token in inline:
                return f"{executable} {token}"
            if not token.startswith("-"):
                return f"{executable} {token}"
        return executable

    depth = DEPTH.get(executable, 1)
    kept = [executable]
    for token in tokens[1:]:
        if len(kept) >= depth:
            break
        if token.startswith("-") or token.isdigit():
            break
        kept.append(token)
    return " ".join(kept)


@functools.lru_cache(maxsize=1)
def reviewer_guard():
    """`not_a_command` de la revue, ou `None` si le module n'est pas importable.

    L'import est tardif et défensif : observer ne doit jamais empêcher d'agir, et
    un hook qui planterait parce qu'un script voisin a bougé bloquerait chaque
    commande Bash de la session.
    """
    try:
        if str(SCRIPTS) not in sys.path:
            sys.path.insert(0, str(SCRIPTS))
        from permissions_review import not_a_command
        return not_a_command
    except Exception:
        return None


def is_noise(pattern, example):
    """Ce motif est-il de la donnée prise pour une commande ?

    Le verdict est celui de la revue (`not_a_command`), pour que le hook cesse
    d'écrire exactement ce qu'elle écarte. À défaut, le filet minimal : un nom de
    commande s'écrit dans `^[A-Za-z0-9_.\\-/]+$`.
    """
    guard = reviewer_guard()
    if guard is not None:
        try:
            return guard(pattern, (example,)) is not None
        except Exception:
            pass
    tokens = pattern.split()
    return not (tokens and COMMAND_NAME_RE.match(tokens[0]))


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
        example = invocation(segment)[:200]
        if is_noise(pattern, example):
            continue                       # de la donnée, pas une commande (#215)
        observations.append({
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pattern": pattern,
            "example": example,
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
