#!/usr/bin/env python3
"""Transforme les demandes de permission répétées en règles d'allowlist.

    python scripts/permissions_review.py                      # ce qui a bloqué, et combien de fois
    python scripts/permissions_review.py --run <id>           # pendant ce run de jalon seulement
    python scripts/permissions_review.py --show-rejected      # y compris ce qui n'est pas une commande
    python scripts/permissions_review.py --apply              # autorise les motifs répétés
    python scripts/permissions_review.py --apply --pattern "npm run verify"
    python scripts/permissions_review.py --forget             # repart de zéro

Les observations viennent du hook
[`.claude/hooks/permission_watch.py`](../.claude/hooks/permission_watch.py), qui
consigne chaque commande Bash qu'aucune règle `allow` ne couvre. Ce script en
fait le bilan et, **sur accord explicite**, ajoute les motifs à
`.claude/settings.json`.

## Ce qui n'est jamais autorisé automatiquement

Élargir une allowlist, c'est réduire ce sur quoi on sera consulté. Cinq
garde-fous, qu'aucun `--yes` ne lève :

  - un motif dont le nom de commande n'en est pas un — corps de heredoc, prose,
    mot réservé du shell, ligne de source — est écarté avant tout le reste ;
  - un motif couvert par une règle `deny` n'est jamais proposé ;
  - un motif dont la portée est bornée par ses **arguments** et non par la
    commande — `head`, `cat`, `grep`, `sed`, `echo`, `tee`… — exige
    `--include-file-tools` **et** d'être nommé avec `--pattern` ;
  - `network` et `destructive` exigent leur drapeau `--include-*` **et** d'être
    nommés un par un avec `--pattern` ;
  - le motif proposé est le plus étroit qui couvre les commandes observées,
    jamais `git:*` là où `git status:*` suffit.

**Une règle `deny` protège un outil, jamais un chemin.** Les permissions sont
indexées par outil : `Read(./**/.env.production)` interdit à l'outil `Read`
d'ouvrir ce fichier, et ne dit rien de ce que `Bash` peut en faire. Autoriser
`Bash(head:*)` rend donc lisible tout ce que les `deny` de `Read` mettent à
l'abri, sans qu'aucune règle ne soit enfreinte — c'est ce qu'a montré #117. Le
garde-fou correspondant ne se déduit pas du bloc `deny` : il tient même vide.

Le rang de risque affiché est celui qu'a observé le hook, **relevé** à ce que
l'outil rend possible : ce qui peut écrire n'est jamais annoncé comme une
lecture, même si l'observation le prétend.

De la même façon, un motif n'est pas cru sur parole quand il prétend nommer une
commande : le hook découpe les invocations **ligne par ligne**, si bien que le
corps d'un heredoc, la suite d'une commande continuée par `\\` ou le milieu d'une
boucle `for … do … done` remontent comme autant de « commandes ». Ce qui n'en est
pas une est écarté de la revue — voir `not_a_command`, et `--show-rejected` pour
le voir quand même.

Le seuil de répétition (`--threshold`, 2 par défaut) traduit la demande d'origine :
ce qui n'a bloqué qu'une fois n'a pas fait ses preuves.
"""
import argparse
import functools
import json
import os
import re
import sys
from collections import defaultdict, namedtuple
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = Path(__file__).resolve().parents[1]
OBSERVED = Path(os.environ.get("SPA_PERMISSION_LOG",
                               ROOT / ".claude" / ".permissions" / "observed.ndjson"))
SETTINGS = ROOT / ".claude" / "settings.json"

SAFE_BY_DEFAULT = {"read", "write"}
RISK_ORDER = {"read": 0, "write": 1, "network": 2, "destructive": 3}
RISK_LABEL = {"read": "lecture", "write": "écriture",
              "network": "réseau", "destructive": "destructif"}

# Utilitaires dont la portée n'est pas bornée par la commande mais par ses
# arguments. `Bash(git status:*)` ne peut faire que ce que `git status` fait ;
# `Bash(head:*)` peut rendre le contenu de n'importe quel fichier du dépôt, et
# `Bash(echo:*)` en écrire n'importe lequel — `.claude/settings.json` compris,
# ce qui laisserait l'allowlist s'élargir toute seule.
#
# Ces deux ensembles ne remplacent pas le classement par risque de
# `.claude/hooks/permission_watch.py` : ils s'y ajoutent. `head` reste une
# lecture pour le système de fichiers ; ce qui se refuse ici, c'est la
# *largeur du motif*, pas ce que la commande observée a fait.
#
# Volontairement conservateurs : mieux vaut un drapeau de trop qu'un motif qui
# ouvre le dépôt. La liste s'allonge sans risque, elle ne peut que refuser plus.
FILE_READERS = {
    "cat", "tac", "nl", "head", "tail", "sed", "awk", "grep", "egrep", "fgrep",
    "rg", "ag", "ack", "less", "more", "strings", "xxd", "od", "hexdump",
    "cut", "sort", "uniq", "jq", "yq", "diff", "base64", "xargs",
}
FILE_WRITERS = {
    "echo", "printf", "tee", "sed", "cp", "mv", "dd", "install", "ln",
    "truncate", "touch", "chmod", "chown",
}

# ---------------------------------------------------------------------------
# Ce qui n'est même pas une commande (#137)
#
# Le hook d'observation découpe une invocation Bash sur ses séparateurs, saut de
# ligne compris, et prend le premier mot de chaque morceau pour un nom de
# commande. Or une commande réelle est très souvent multi-lignes :
#
#   - un heredoc (`cat > f <<'EOF' … EOF`) embarque un document entier — c'est
#     ainsi que les corps de PR, les corps d'issue et les livrables Markdown de
#     ce dépôt sont écrits. Ce corps n'est pas exécuté : c'est de la donnée ;
#   - une commande à rallonge se poursuit derrière un `\` — d'où `--title`,
#     `--label`, `--body-file` promus au rang d'exécutables ;
#   - une boucle `for … do … done` occupe trois lignes, dont deux mots réservés.
#
# Sur le run s1-fondations-20260825-093729, cela donnait `Bash(-:*)`,
# `Bash(##:*)`, `Bash(":*)`, `Bash(le:*)`, `Bash(for:*)`, `Bash(import:*)`
# proposés à l'allowlist. `Bash(":*)` couvre *toute* commande commençant par un
# guillemet : ce n'est pas « une commande » de plus, c'est une classe entière
# d'invocations que personne n'a examinée, sous une étiquette qui ne veut rien
# dire. Et l'opérateur à qui l'on présente 206 motifs dont la moitié est du bruit
# ne les lit plus — c'est le mécanisme même de la revue qui se vide de son sens.
#
# La correction de fond appartient au tokeniseur du hook, qui doit ne retenir que
# le premier mot de la *première* ligne, sauter les corps de heredoc et recoller
# les continuations. Ce qui se décide ici est ce que la revue **propose** : un
# fragment qui n'est pas une commande n'a rien à faire dans une allowlist, quelle
# que soit la raison pour laquelle il a été consigné.
# ---------------------------------------------------------------------------

# Le filet de sécurité, et le seul critère qui ne relève d'aucune heuristique :
# un nom de commande ne contient ni guillemet, ni accent, ni ponctuation
# Markdown. À lui seul il élimine `"`, `` ` ``, ``` ``` ```, `##`, `---`,
# `(.number)`, `try:`, `co-authored-by:` et `périmètre`.
COMMAND_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")

# Un motif entier — nom **et** sous-verbes — s'écrit en ASCII. Un accent dans
# `npm exécute ses scripts…` ou `périmètre retenu…` ne vient jamais d'une ligne
# de commande : c'est de la prose tombée dans un heredoc.
# (La règle jumelle — un nom de programme s'écrit en minuscules, d'où `Claude
# Code…`, `PR »…`, `EOF`, `ALTER TABLE…` écartés — vit dans
# `looks_like_invocation`, qui juge l'observation et non le motif.)
NON_ASCII_RE = re.compile(r"[^\x00-\x7f]")

# Ce qui suit le nom de commande dans un motif est un sous-verbe ou un chemin.
# Ni une accolade Terraform (`terraform {`), ni un reste de heredoc
# (`python <<PY`), ni un guillemet ouvert (`python "`), ni un numéro de version
# (`terraform 1.9.8`) : ceux-là viennent d'une ligne qui n'était pas une commande.
# Le `~` n'y figure pas : il n'a jamais désigné que le dossier personnel —
# `bash ~/bin/deploy.sh` est une invocation, pas un débris.
ARGUMENT_DEBRIS = ("\"", "'", "`", "{", "}", "#", "<<", "::")
VERSION_RE = re.compile(r"^[0-9][0-9.]*$")

# `id String @id`, `users User[]`, `description String?` : une ligne de schéma
# Prisma, où le second mot est un type. Une commande n'a pas de second mot
# capitalisé.
TYPE_TOKEN_RE = re.compile(r"^[A-Z][A-Za-z0-9_]*(\[\])?\??$")

# Ce qui trahit une vraie ligne de commande dans une phrase : un drapeau, un
# chemin, une redirection, une variable. Une phrase française n'en a aucun.
SHELLISH_RE = re.compile(r"^-|[/\\|><$=]")

# Mots réservés du shell. Ils ouvrent ou ferment une structure, ils ne nomment
# jamais un programme — et `Bash(done:*)` n'autoriserait rien d'intelligible.
SHELL_KEYWORDS = {
    "for", "do", "done", "if", "then", "elif", "else", "fi", "while", "until",
    "case", "esac", "select", "function", "in", "coproc", "time",
}

# Mots-clés de langage relevés dans les observations réelles : lignes de source
# Python, TypeScript, SQL ou Prisma tombées dans un heredoc. Certains existent
# aussi comme exécutables quelque part (`import` d'ImageMagick, `print` de
# Windows) : les nommer ici les refuse indépendamment de la machine, ce que le
# détour par le PATH ne saurait pas faire.
CODE_KEYWORDS = {
    "import", "from", "def", "class", "return", "lambda", "yield", "assert",
    "raise", "except", "finally", "try", "pass", "continue", "break", "with",
    "global", "nonlocal", "del", "async", "await", "const", "let", "var",
    "interface", "enum", "extends", "implements", "typeof", "instanceof",
    "public", "private", "protected", "static", "readonly", "namespace",
    "declare", "module", "generator", "datasource", "print",
    "insert", "update", "alter", "create", "drop", "table", "values",
    "join", "group", "order", "begin", "commit", "rollback",
}
# `where` manque volontairement à cette liste : c'est le `which` de Windows, la
# plateforme de ce dépôt, et il figure à ce titre parmi les outils connus. Le
# nommer ici le refuserait d'office, quelle que soit l'observation. Un `WHERE`
# de SQL tombé dans un heredoc reste écarté par `looks_like_invocation`, qui
# refuse un premier mot capitalisé et une ligne dont le second mot est `=`.

NEVER_COMMANDS = SHELL_KEYWORDS | CODE_KEYWORDS

# Exécutables tenus pour légitimes même absents de la machine qui passe la revue
# — un poste sans Terraform ni Docker doit pouvoir instruire les observations
# d'un run qui, lui, les avait. La liste s'allonge sans risque : elle ne peut que
# faire *proposer* un motif de plus, jamais en autoriser un.
KNOWN_COMMANDS = FILE_READERS | FILE_WRITERS | {
    "git", "gh", "npm", "npx", "node", "yarn", "pnpm", "nvm", "corepack",
    "python", "python3", "py", "pip", "pipx", "poetry", "pytest", "ruff",
    "bash", "sh", "zsh", "pwsh", "powershell", "cmd", "wsl",
    "docker", "docker-compose", "terraform", "tflint", "aws", "kubectl", "helm",
    "prisma", "psql", "pg_dump", "redis-cli", "sqlite3",
    "curl", "wget", "ssh", "scp", "rsync", "ping", "nc", "openssl",
    "ls", "pwd", "cd", "pushd", "popd", "mkdir", "rmdir", "rm", "find", "which",
    "where", "file", "stat", "tree", "wc", "date", "env", "export", "source",
    "true", "false", "test", "kill", "killall", "ps", "top", "df", "du",
    "tar", "zip", "unzip", "gzip", "gunzip", "make", "cargo", "go", "java",
    "mvn", "gradle", "ruby", "perl", "deno", "bun", "code", "sleep",
}


# ---------------------------------------------------------------------------
# Chercher un nom sur le `PATH` : parcours complet, ou sonde ciblée (#264)
#
# `path_executables()` répertorie tout le `PATH` d'un coup. C'est le bon calcul
# pour la revue, qui instruit des milliers de motifs dans un seul processus et
# amortit le parcours sur tous. C'est le mauvais pour
# `.claude/hooks/permission_watch.py`, qui importe `not_a_command` et n'a qu'un
# nom à juger : son processus meurt aussitôt après, et le cache avec lui.
#
# Mesuré sur le poste Windows du dépôt — 56 entrées de `PATH` dont 46 existent,
# 7 581 exécutables, 11 extensions dans `PATHEXT` :
#
#   parcours complet du PATH         18 ms à chaud · 36 ms à froid
#   sonde ciblée, nom introuvable     3,7 ms
#   sonde ciblée, nom trouvé          0,07 ms
#   hook de bout en bout             81 ms avec parcours · 58 ms sans
#
# Le parcours ajoutait donc ~23 ms — 40 % — à chaque commande Bash dont le nom
# n'est ni connu ni porteur d'extension d'exécutable. La sonde ramène cela à
# ~4 ms au pire, et à presque rien quand le nom existe.
#
# **Ce qui est proposé à l'allowlist ne bouge pas d'un motif**, et ce n'est pas
# une approximation qu'on espère bénigne : la sonde ne répond que lorsqu'elle
# est concluante, et le parcours reste seul juge dans les autres cas.
#
#   - un `os.path.isfile` positif prouve le fichier, donc l'entrée d'index ;
#   - un `isfile` négatif ne prouve l'absence que sur un système de fichiers
#     insensible à la casse — l'index, lui, replie les noms en minuscules, si
#     bien qu'un `Foo` du `PATH` y répond au nom `foo`. Sur un système sensible
#     à la casse, la sonde se déclare donc non concluante, et on retombe sur le
#     parcours.
# ---------------------------------------------------------------------------

# Cinq sondes infructueuses valent un parcours (3,7 ms contre 18 ms) : le budget
# se tient sous ce seuil, sans quoi la revue paierait les sondes *en plus* de
# l'index, qu'elle finit de toute façon par construire. Au pire elle y perd donc
# quatre sondes vaines — ~15 ms, une fois pour tout le processus. Le hook, lui,
# n'a qu'un nom à juger et n'approche jamais le seuil.
PROBE_BUDGET = 4

# Deux noms qui ne diffèrent que par la casse désignent-ils le même fichier ?
# `os.path.normcase` replie sous Windows et laisse tel quel sous POSIX. Il se
# trompe là où il ne peut pas savoir — un volume macOS est insensible à la casse
# sans que POSIX le dise — mais il se trompe du bon côté : la sonde y sera moins
# souvent concluante, jamais fausse.
CASE_INSENSITIVE_FS = os.path.normcase("A") == "a"

_probes_left = PROBE_BUDGET


@functools.lru_cache(maxsize=1)
def executable_suffixes():
    """Les extensions de `PATHEXT` qui font d'un fichier un exécutable nommable.

    Seules comptent celles qui s'écrivent « un point puis un seul segment » :
    c'est la seule forme que `path_executables()` sait retirer d'un nom de
    fichier, lui qui coupe sur le **dernier** point. Une entrée sans point
    (`EXE`) ou à points multiples (`.tar.gz`) n'ajoute aucun nom à l'index — elle
    n'a donc pas davantage à en faire trouver à la sonde.
    """
    return tuple(sorted({
        ext.lower()
        for ext in os.environ.get("PATHEXT", "").split(os.pathsep)
        if ext.startswith(".") and "." not in ext[1:]
    }))


def probe_path(name):
    """Ce nom désigne-t-il un exécutable du `PATH` ? `None` si l'on ne conclut pas.

    Quelques `stat` ciblés au lieu du parcours de tous les répertoires : le nom
    tel quel, puis le nom suivi de chaque extension de `PATHEXT`, dans chaque
    entrée du `PATH`, en s'arrêtant au premier trouvé.

    Un nom qui porte un séparateur n'est plus un nom mais un chemin : le
    concaténer à une entrée du `PATH` sortirait du répertoire interrogé, et la
    réponse ne vaudrait plus celle de l'index. On ne conclut pas.

    Même refus pour un nom que le système de fichiers réécrirait avant de
    répondre : Windows rogne les points et les espaces de fin de chaque segment,
    si bien que `npm.` y ouvre le fichier `npm` — alors que l'index, qui prend
    les noms tels que `scandir` les rend, ne connaît que `npm`. La sonde
    répondrait oui là où le parcours répond non, et un fragment de prose
    terminé par un point serait proposé à l'allowlist.
    """
    if os.sep in name or ":" in name or (os.altsep and os.altsep in name):
        return None
    if name != name.rstrip(". "):
        return None
    candidates = (name, *(name + suffix for suffix in executable_suffixes()))
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        for candidate in candidates:
            # `os.path.isfile` avale lui-même l'OSError d'une entrée illisible,
            # exactement comme le `try` du parcours complet.
            if os.path.isfile(os.path.join(entry, candidate)):
                return True
    return False if CASE_INSENSITIVE_FS else None


@functools.lru_cache(maxsize=None)
def on_path(name):
    """`name` figure-t-il parmi les exécutables du `PATH` ?

    Rend exactement `name in path_executables()`, par le chemin le moins cher :
    la sonde tant qu'il n'y a qu'une poignée de noms à juger, le parcours complet
    dès qu'il y en a assez pour l'amortir — ou dès que la sonde ne conclut pas.
    """
    global _probes_left
    if not path_executables.cache_info().currsize and _probes_left > 0:
        _probes_left -= 1
        verdict = probe_path(name)
        if verdict is not None:
            return verdict
    return name in path_executables()


def reset_path_cache():
    """Oublie tout ce qui a été retenu du `PATH`.

    Pour les tests, et pour tout appelant qui changerait `PATH` ou `PATHEXT` en
    cours de route — les caches, eux, ne s'en apercevraient pas.
    """
    global _probes_left
    _probes_left = PROBE_BUDGET
    executable_suffixes.cache_clear()
    path_executables.cache_clear()
    on_path.cache_clear()


@functools.lru_cache(maxsize=1)
def path_executables():
    """Les noms d'exécutables présents sur le `PATH`, sans extension.

    Un `os.path.isfile` par motif et par extension coûterait, sur les 4 549
    motifs distincts d'un run de jalon, des centaines de milliers d'appels
    système. Un seul parcours suffit, et le résultat sert à toute la revue.

    C'est la référence, et le dernier mot : `on_path()` ne s'en dispense que
    lorsqu'une sonde ciblée rend la même réponse pour moins cher (#264).
    """
    # En ensemble, pas en tuple : la sonde a besoin d'un ordre, le parcours
    # d'un test d'appartenance par fichier — et il en fait des milliers.
    suffixes = frozenset(executable_suffixes())
    names = set()
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        try:
            with os.scandir(entry) as children:
                for child in children:
                    try:
                        if not child.is_file():
                            continue
                    except OSError:
                        continue
                    lowered = child.name.lower()
                    names.add(lowered)
                    stem, dot, ext = lowered.rpartition(".")
                    if dot and "." + ext in suffixes:
                        names.add(stem)
        except OSError:
            continue
    return names


def plausible_command_name(head):
    """Ce mot peut-il désigner un programme ?

    Trois façons de l'être : porter un chemin ou une extension d'exécutable,
    figurer parmi les outils connus du projet, ou se trouver sur le `PATH`. Un
    mot réservé du shell ou un mot-clé de langage est refusé d'abord, avant même
    le `PATH` — sans quoi la réponse dépendrait de ce qui est installé sur la
    machine, et `import` passerait là où ImageMagick traîne.

    Les trois premiers critères répondent sans toucher au disque : le `PATH`
    n'est interrogé que pour un nom qui a franchi tout le reste, ce qui est rare
    — et cher, d'où `on_path()` (#264).
    """
    if not head or head in NEVER_COMMANDS:
        return False
    if "/" in head:
        return True
    stem, dot, ext = head.rpartition(".")
    if dot and stem and ext in {"sh", "bash", "py", "rb", "pl", "js", "mjs",
                                "cjs", "ts", "exe", "com", "bat", "cmd", "ps1"}:
        return True
    return head in KNOWN_COMMANDS or on_path(head)


def looks_like_invocation(example):
    """Cette ligne observée ressemble-t-elle à une invocation, ou à de la donnée ?

    Trois formes se reconnaissent à coup sûr et ne sont jamais des commandes :
    un premier mot capitalisé (`Claude Code…`, `PR »…`, `EOF`, `ALTER TABLE…`),
    une affectation (`source = "hashicorp/aws"`, `cmd = \\`), une déclaration de
    schéma (`id String @id`). S'y ajoute la phrase : plusieurs mots, un point
    final **qui termine un mot**, et pas le moindre drapeau, chemin ni
    redirection. La nuance n'est pas cosmétique : `git add .`, `ruff check .`,
    `terraform fmt .` ou `docker build .` finissent eux aussi par un point, sans
    porter ni drapeau ni chemin — un point isolé est un argument, jamais une
    ponctuation.
    """
    tokens = example.split()
    # Le hook écarte les affectations d'environnement avant de nommer la
    # commande — `DATABASE_URL=… npx prisma` reste une invocation de `npx`.
    while tokens and "=" in tokens[0] and not tokens[0].startswith("-"):
        tokens = tokens[1:]
    if not tokens:
        return False
    lead = tokens[0].lstrip("\"'`")
    if not lead:
        return False
    name = Path(lead).name
    if name != name.lower():
        return False
    if len(tokens) > 1:
        if tokens[1] == "=" or TYPE_TOKEN_RE.match(tokens[1]):
            return False
        words = example.split()
        final = words[-1] if words else ""
        if (len(tokens) >= 3 and final.endswith(".") and final.strip(".")
                and not any(SHELLISH_RE.search(token) for token in tokens)):
            return False
    return True


def not_a_command(pattern, examples=()):
    """Pourquoi ce motif ne nomme pas une commande — ou `None` s'il en nomme une.

    Les critères vont du plus mécanique au plus heuristique, et le message rendu
    dit lequel a joué : un refus qu'on ne peut pas expliquer est un refus qu'on
    finit par désactiver.
    """
    tokens = pattern.split()
    head = tokens[0] if tokens else ""
    if not head:
        return "motif vide"
    if head.startswith("-"):
        return "fragment d'une commande continuée par « \\ » — commence par un tiret"
    if not COMMAND_NAME_RE.match(head):
        return "nom de commande hors de ^[A-Za-z0-9_.\\-/]+$"
    lowered = head.lower()
    if lowered in SHELL_KEYWORDS:
        return "mot réservé du shell, jamais un exécutable"
    if lowered in CODE_KEYWORDS:
        return "mot-clé de langage — ligne de source, pas une commande"
    if NON_ASCII_RE.search(pattern):
        return "prose — un nom de commande et ses sous-verbes sont en ASCII"
    for token in tokens[1:]:
        if any(debris in token for debris in ARGUMENT_DEBRIS):
            return "débris de guillemet, de heredoc ou de ponctuation dans le motif"
        if VERSION_RE.match(token):
            return "numéro de version en guise de sous-commande — ligne de prose"
    if not plausible_command_name(lowered):
        return "introuvable comme exécutable — ni outil connu, ni binaire du PATH"
    if examples and not any(looks_like_invocation(ex) for ex in examples):
        return "aucune observation ne ressemble à une invocation — prose ou ligne de source"
    return None


# Les paramètres d'une revue, réunis pour ne pas les faire circuler un par un.
Policy = namedtuple("Policy", "allow read_denies threshold classes file_tools")


def effective_risk(pattern, risk):
    """Le rang de risque observé, relevé à ce que l'outil rend possible.

    Le rang vient du hook d'observation, qui décrit la commande *vue*. Deux
    raisons de ne pas s'y fier seul : un hook peut se tromper — `sed` et `echo`
    ont longtemps figuré parmi ses lectures alors que `sed -i` réécrit sur place
    et `echo >` écrase (#117) — et rien ne garantit que les observations lues
    ici viennent du hook de ce dépôt.

    Le plancher ne change pas ce qui est autorisé : `write` reste sûr par
    défaut, et le garde-fou des utilitaires à portée arbitraire refuse ces
    motifs de toute façon. Il change ce que la revue **annonce** — un `echo`
    présenté comme une « lecture » invite à l'autoriser sans y regarder.
    """
    head = pattern.split()[0] if pattern else ""
    if head in FILE_WRITERS and RISK_ORDER.get(risk, 1) < RISK_ORDER["write"]:
        return "write"
    return risk


def arbitrary_file_tool(pattern):
    """La portée de ce motif dépend-elle de ses arguments ? `"read"`, `"write"` ou `None`.

    `sed` figure dans les deux ensembles : il lit, et `sed -i` réécrit. La
    réponse la plus forte l'emporte — refuser au titre de l'écriture dit la
    chose la plus grave que le motif autoriserait.
    """
    head = pattern.split()[0] if pattern else ""
    if head in FILE_WRITERS:
        return "write"
    if head in FILE_READERS:
        return "read"
    return None


def file_tool_reason(kind, read_denies):
    """Pourquoi ce motif exige un drapeau — en nommant ce qu'il contournerait."""
    if kind == "write":
        return ("écrit un fichier quelconque, .claude/settings.json compris — "
                "exige --include-file-tools et --pattern")
    if read_denies:
        return (f"lit un fichier quelconque, dont les {len(read_denies)} chemins "
                "protégés par un deny Read — exige --include-file-tools et --pattern")
    return ("lit un fichier quelconque — exige --include-file-tools et --pattern")


def load_observations(run=None, session=None):
    if not OBSERVED.exists():
        return []
    records = []
    for line in OBSERVED.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if run and record.get("run") != run:
            continue
        if session and record.get("session") != session:
            continue
        records.append(record)
    return records


def aggregate(records):
    # Plancher au risque le plus faible : l'agrégat ne fait ensuite que monter.
    grouped = defaultdict(lambda: {"count": 0, "examples": [], "risk": "read",
                                   "denied": False, "runs": set(), "first": None,
                                   "last": None})
    for record in records:
        entry = grouped[record["pattern"]]
        entry["count"] += 1
        # Le plus élevé l'emporte, jamais le dernier vu : `git reset --hard`
        # (destructif) et `git reset HEAD~1` (écriture) se réduisent au même
        # motif `git reset`. Retenir le dernier observé ferait passer le motif
        # pour anodin et autoriserait `--hard` sans jamais demander le drapeau.
        seen = record.get("risk", "write")
        if RISK_ORDER.get(seen, 1) > RISK_ORDER.get(entry["risk"], 1):
            entry["risk"] = seen
        entry["denied"] = entry["denied"] or bool(record.get("denied"))
        if record.get("run"):
            entry["runs"].add(record["run"])
        entry["first"] = entry["first"] or record.get("ts")
        entry["last"] = record.get("ts")
        example = record.get("example")
        if example and example not in entry["examples"] and len(entry["examples"]) < 3:
            entry["examples"].append(example)
    for pattern, entry in grouped.items():
        entry["risk"] = effective_risk(pattern, entry["risk"])
    return grouped


def current_rules():
    """Les blocs `allow` et `deny` du fichier de réglages, tels quels."""
    if not SETTINGS.exists():
        return [], []
    permissions = (json.loads(SETTINGS.read_text(encoding="utf-8"))
                   .get("permissions") or {})
    return permissions.get("allow") or [], permissions.get("deny") or []


def read_denies(deny):
    """Les règles `deny` posées sur l'outil `Read`.

    Le hook d'observation ne confronte les commandes qu'aux `deny` **Bash** —
    seuls ceux-là peuvent l'empêcher de s'exécuter. Ces règles-ci n'arrêteront
    donc jamais une commande Bash : elles servent ici à *nommer* ce qu'un motif
    trop large rendrait accessible malgré elles.
    """
    return [rule for rule in deny
            if isinstance(rule, str) and rule.startswith("Read(")]


def already_covered(pattern, allow):
    """Une règle existante couvre-t-elle déjà ce motif ?"""
    for rule in allow:
        if not isinstance(rule, str) or not rule.startswith("Bash("):
            continue
        inner = rule[5:-1]
        prefix = inner[:-2] if inner.endswith(":*") else inner
        if pattern == prefix or pattern.startswith(prefix + " ") or prefix == "":
            return True
    return False


def eligible(pattern, entry, policy):
    # Avant toute question de risque ou de seuil : est-ce seulement une commande ?
    # Le refus vaut aussi pour `--pattern`, qui ne peut donc pas faire entrer un
    # fragment de heredoc dans l'allowlist en le nommant (#137).
    verdict = not_a_command(pattern, entry.get("examples") or ())
    if verdict:
        return False, verdict
    if entry["denied"]:
        return False, "couvert par une règle deny"
    if already_covered(pattern, policy.allow):
        return False, "déjà autorisé"
    if entry["count"] < policy.threshold:
        return False, f"vu {entry['count']}× (seuil {policy.threshold})"
    if entry["risk"] not in policy.classes:
        return False, f"{RISK_LABEL[entry['risk']]} — exige --include-{entry['risk']}"
    # Après le rang de risque, et non avant : un `rm` reste refusé au titre du
    # destructif, qui est l'objection la plus forte.
    kind = arbitrary_file_tool(pattern)
    if kind and not policy.file_tools:
        return False, file_tool_reason(kind, policy.read_denies)
    return True, None


def show(grouped, policy, as_json, show_rejected=False):
    if not grouped:
        print("aucune commande n'a demandé de permission depuis la dernière revue")
        return 0

    # Ce qui n'est pas une commande sort de la revue : le lister reviendrait à
    # noyer les vrais motifs sous du bruit, et c'est précisément ce bruit qui
    # avait fait cesser de lire la sortie (#137).
    # Le verdict se demande une fois : `eligible` l'oppose d'abord à tout le
    # reste, si bien qu'un second appel dirait la même chose — et qu'un jour où
    # il ne la dirait plus, la revue filtrerait sur un critère et motiverait sur
    # un autre.
    rows, ecartes = [], 0
    for pattern, entry in grouped.items():
        verdict = not_a_command(pattern, entry.get("examples") or ())
        if verdict:
            ecartes += 1
            if not show_rejected:
                continue
            rows.append((pattern, entry, False, verdict))
            continue
        rows.append((pattern, entry, *eligible(pattern, entry, policy)))
    rows.sort(key=lambda r: (-r[1]["count"], RISK_ORDER.get(r[1]["risk"], 9), r[0]))

    if as_json:
        print(json.dumps([{"pattern": p, "count": e["count"], "risk": e["risk"],
                           "eligible": ok, "reason": why, "examples": e["examples"],
                           "runs": sorted(e["runs"])}
                          for p, e, ok, why in rows], ensure_ascii=False, indent=2))
        return 0

    retenus = [r for r in rows if r[2]]
    entete = f"{len(rows)} motif(s) observé(s)"
    if ecartes and not show_rejected:
        entete += f" · {ecartes} fragment(s) écarté(s)"
    print(f"{entete} · {len(retenus)} éligible(s) à l'allowlist\n")
    for pattern, entry, ok, why in rows:
        mark = "+" if ok else " "
        note = "" if ok else f"  ({why})"
        print(f"{mark} {entry['count']:>3}×  {RISK_LABEL[entry['risk']]:<10} "
              f"Bash({pattern}:*){note}")
        for example in entry["examples"][:2]:
            print(f"            {example[:88]}")
    print()

    if ecartes and not show_rejected:
        print(f"{ecartes} fragment(s) écarté(s) — corps de heredoc, prose, "
              "mots réservés du shell, lignes de source ;")
        print("  python scripts/permissions_review.py --show-rejected  pour les voir\n")

    if retenus:
        print("Pour les autoriser durablement :")
        print("  python scripts/permissions_review.py --apply")
    return 0


def apply(grouped, policy, wanted, assume_yes):
    chosen = []
    for pattern, entry in grouped.items():
        if wanted and pattern not in wanted:
            continue
        ok, why = eligible(pattern, entry, policy)
        if not ok:
            if wanted:
                print(f"refusé · Bash({pattern}:*) — {why}")
            continue
        # Un drapeau `--include-*` ne suffit jamais à lui seul : ce qu'il ouvre
        # se nomme, motif par motif. Sans cela, `--include-file-tools` lâcherait
        # d'un coup tout ce que la campagne d'observation a croisé.
        if pattern not in (wanted or set()):
            if entry["risk"] in {"network", "destructive"}:
                print(f"ignoré · Bash({pattern}:*) — {RISK_LABEL[entry['risk']]}, "
                      f"à nommer explicitement avec --pattern")
                continue
            if arbitrary_file_tool(pattern):
                print(f"ignoré · Bash({pattern}:*) — portée bornée par ses arguments, "
                      f"à nommer explicitement avec --pattern")
                continue
        chosen.append((pattern, entry))

    if not chosen:
        print("rien à ajouter")
        return 1

    chosen.sort(key=lambda item: -item[1]["count"])
    print("À ajouter dans .claude/settings.json :\n")
    for pattern, entry in chosen:
        print(f"  Bash({pattern}:*)     {entry['count']}× · {RISK_LABEL[entry['risk']]}")
    print()

    if not assume_yes:
        try:
            answer = input("Confirmer l'ajout ? [o/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return 1
        if answer not in {"o", "oui", "y", "yes"}:
            print("abandonné — rien n'a été modifié")
            return 1

    data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    permissions = data.setdefault("permissions", {})
    rules = permissions.setdefault("allow", [])
    for pattern, _ in chosen:
        rule = f"Bash({pattern}:*)"
        if rule not in rules:
            rules.append(rule)
    SETTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print(f"{len(chosen)} règle(s) ajoutée(s) à {SETTINGS.relative_to(ROOT)}")

    forget({pattern for pattern, _ in chosen})
    print("observations correspondantes purgées")
    print("\nLes règles d'un fichier de réglages ne sont relues qu'au démarrage : "
          "relancer Claude Code, ou les rejouer via /permissions.")
    return 0


def forget(patterns=None):
    """Retire des observations les motifs traités — le reste est conservé."""
    if not OBSERVED.exists():
        return
    if patterns is None:
        OBSERVED.unlink()
        return
    kept = []
    for line in OBSERVED.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("pattern") not in patterns:
            kept.append(line)
    OBSERVED.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", help="ne regarder que les observations d'un run de jalon")
    parser.add_argument("--session", help="ne regarder qu'une session Claude Code")
    parser.add_argument("--threshold", type=int, default=2,
                        help="nombre de répétitions à partir duquel un motif est proposé")
    parser.add_argument("--apply", action="store_true", help="ajouter à l'allowlist")
    parser.add_argument("--pattern", action="append", default=[],
                        help="ne traiter que ce motif (répétable)")
    parser.add_argument("--include-network", action="store_true")
    parser.add_argument("--include-destructive", action="store_true")
    parser.add_argument("--include-file-tools", action="store_true",
                        help="autoriser les motifs dont la portée dépend de leurs "
                             "arguments (head, cat, grep, sed, echo, tee…) — "
                             "à combiner avec --pattern")
    parser.add_argument("--show-rejected", action="store_true",
                        help="montrer aussi les fragments écartés faute d'être "
                             "des commandes (corps de heredoc, prose, mots "
                             "réservés du shell, lignes de source)")
    parser.add_argument("--yes", action="store_true", help="ne pas demander confirmation")
    parser.add_argument("--forget", action="store_true",
                        help="effacer les observations et repartir de zéro")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.forget:
        forget(set(args.pattern) or None)
        print("observations effacées")
        return 0

    classes = set(SAFE_BY_DEFAULT)
    if args.include_network:
        classes.add("network")
    if args.include_destructive:
        classes.add("destructive")
        print("attention : --include-destructive autorise des commandes irréversibles\n")
    if args.include_file_tools:
        print("attention : --include-file-tools autorise des motifs qui atteignent "
              "n'importe quel chemin, y compris ceux qu'un deny Read protège\n")

    records = load_observations(args.run, args.session)
    grouped = aggregate(records)
    allow, deny = current_rules()
    policy = Policy(allow=allow, read_denies=read_denies(deny),
                    threshold=args.threshold, classes=classes,
                    file_tools=args.include_file_tools)

    if args.apply:
        return apply(grouped, policy, set(args.pattern), args.yes)
    return show(grouped, policy, args.json, args.show_rejected)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
