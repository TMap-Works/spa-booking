#!/usr/bin/env python3
"""Supprime les worktrees dont le ticket est terminé.

    python scripts/worktree_gc.py               # nettoie ce qui est validé
    python scripts/worktree_gc.py --dry-run     # montre sans rien supprimer
    python scripts/worktree_gc.py --force       # ignore les garde-fous

Un worktree est considéré comme terminé si l'un de ces signaux est vrai :

  1. une pull request dont la branche est la tête a été **mergée** ;
  2. la branche est déjà **ancêtre** de la base (`origin/develop`) ;
  3. l'issue portée par le nom de branche (`feature/42-slug`) est **fermée**.

Des garde-fous priment sur ces signaux :

  - le worktree courant n'est jamais supprimé ;
  - `develop`, `staging`, `main` et les HEAD détachées ne sont jamais touchées ;
  - une PR encore ouverte conserve le worktree, même si l'issue est fermée ;
  - un worktree sale ou porteur de commits jamais poussés est conservé, avec
    les fichiers en cause nommés — sauf `--force`. Une preuve d'intégration
    lève ce garde-fou pour les seuls **résidus d'outillage** (vidage de crash,
    lockfile réécrit par `npm install`), jamais pour du travail.

Second passage : les **branches de ticket orphelines**, que plus aucun worktree
ne détient — ce que laisse derrière lui un répertoire supprimé à la main. Leur
suppression est délibérément plus stricte, faute de worktree à inspecter : il
faut une PR mergée, ou une branche déjà intégrée *et* une issue fermée. Dans les
deux cas le contenu est dans la base, rien ne peut être perdu. `--no-branches`
s'en tient aux worktrees.

Troisième passage : les **répertoires orphelins** de `.claude/worktrees/`, que
`git worktree list` ne connaît plus. `git worktree remove` supprime l'entrée
d'administration *même quand la suppression récursive du répertoire échoue* —
le cas courant sous Windows sur un `node_modules` verrouillé. Le répertoire
devient alors invisible de tout le monde et reste à vie : quatorze d'entre eux
occupaient 1,0 Go (#173). Plus rien ne les rattache au dépôt — aucune branche
ne les désigne, rien ne peut y être commité — et le balayage ne sort jamais de
`.claude/worktrees/`. `--no-dirs` s'en tient aux deux premiers passages.

Sans réseau ni `gh`, le script se rabat sur le seul signal local (l'ancestralité)
au lieu d'échouer : le nettoyage ne doit jamais bloquer le travail.
"""
import argparse
import fnmatch
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un accent dans un nom de
# branche ferait planter le script APRÈS des suppressions déjà appliquées.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
BASE_REF = os.environ.get("SPA_WORKTREE_BASE", "origin/develop")
PROTECTED = {"develop", "staging", "main", "master"}
WINDOWS = os.name == "nt"

# Là où Claude Code pose les worktrees. La passe « répertoires orphelins » ne
# balaie que celui-ci, et rien de ce qui pointe ailleurs.
WORKTREE_DIR = os.environ.get("SPA_WORKTREE_DIR", ".claude/worktrees")

# Un répertoire tout juste créé peut être un worktree en cours d'installation,
# pas encore enregistré. Sous `/milestone`, plusieurs agents en créent de front :
# sans ce délai, le nettoyage d'un run emporterait le worktree d'un autre.
MIN_ORPHAN_AGE = int(os.environ.get("SPA_WORKTREE_MIN_AGE", "600"))

# Temps total accordé à l'inventaire des volumes. Le hook `Stop` tourne à chaque
# tour : mieux vaut taire un chiffre que faire attendre la session.
SIZE_BUDGET = float(os.environ.get("SPA_WORKTREE_SIZE_BUDGET", "15"))

# Ce que l'outillage laisse tomber dans un worktree et que personne n'a écrit.
# Un worktree dont la PR est mergée n'a pas à survivre à ça : un `.stackdump` a
# retenu 126 Mo et un `package-lock.json` réécrit par npm 358 Mo (#173).
RESIDUE = (
    "*.stackdump",          # vidage de crash MSYS/Cygwin (#139)
    "npm-debug.log*",
    "yarn-error.log",
    "package-lock.json",    # réécrit par un `npm install` fait dans le worktree
    ".npmrc",
    "*.tsbuildinfo",
)

# feature/42-slug (nom conforme) ou worktree-feature+42-slug (nom brut
# d'EnterWorktree, quand le renommage de la phase 1 de /ticket n'a pas eu lieu).
ISSUE_IN_BRANCH = re.compile(r"(?:^|[/+-])(\d+)-")
TYPES = "feature|bugfix|hotfix|chore|docs"
TICKET_BRANCH = re.compile(
    r"^(?:worktree-)?(?:{})[/+]\d+-[a-z0-9._-]+$".format(TYPES))
MAX_ISSUE_LOOKUPS = 20


def run(args, cwd=None, timeout=30):
    try:
        return subprocess.run(
            args, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return subprocess.CompletedProcess(args, 1, "", "commande indisponible")


def norm(path):
    return os.path.normcase(os.path.normpath(str(path)))


def same_path(a, b):
    return norm(a) == norm(b)


def within(child, parent):
    try:
        Path(child).relative_to(Path(parent))
        return True
    except ValueError:
        return False


def native(path):
    r"""Chemin absolu, préfixé `\\?\` sous Windows.

    Sans ce préfixe, tout chemin de plus de 260 caractères est refusé par l'API
    Win32 — et un `node_modules` en produit à la pelle. C'est précisément ce qui
    fait échouer la suppression que ce script doit rattraper.
    """
    text = os.path.abspath(str(path))
    if WINDOWS and not text.startswith("\\\\?\\"):
        text = "\\\\?\\" + text.replace("/", "\\")
    return text


def is_reparse(path):
    """Lien symbolique ou jonction NTFS.

    `os.path.islink` ne voit pas les jonctions avant Python 3.12. Sans ce test,
    un `node_modules` symboliqué par le réglage `worktree.symlinkDirectories`
    serait traversé à la suppression — et c'est le `node_modules` du dépôt
    principal qui serait vidé. Un lien se supprime, sa cible jamais.
    """
    try:
        info = os.lstat(native(path))
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _drop(path, directory):
    """Supprime un seul élément — lien, fichier, ou répertoire déjà vidé.

    Les deux appels sont tentés dans l'ordre le plus probable : sous Windows un
    lien de répertoire se retire avec `rmdir`, un lien de fichier avec `unlink`,
    et l'attribut du lien ne dit pas toujours lequel. Entre les deux tours,
    l'attribut lecture seule est levé — npm en pose, et il bloque la suppression.
    """
    order = (os.rmdir, os.unlink) if directory else (os.unlink, os.rmdir)
    first = None
    for attempt, action in enumerate(order + order):
        try:
            action(path)
            return None
        except FileNotFoundError:
            return None
        except OSError as exc:
            first = first or str(exc)
        if attempt == len(order) - 1:
            # Ajouter le droit d'écriture, jamais remplacer le mode : un 0o200
            # posé sur un répertoire qui a résisté le rendrait illisible sous
            # POSIX, et le passage suivant ne pourrait même plus le parcourir —
            # à rebours du « ce qui résiste sera repris » de `remove_tree`.
            try:
                mode = os.stat(path).st_mode
            except OSError:
                mode = 0
            mode |= stat.S_IWRITE | stat.S_IREAD
            if directory:
                mode |= stat.S_IEXEC
            try:
                os.chmod(path, mode)
            except OSError:
                return first
    return first


def remove_tree(path):
    """Supprime un arbre sans jamais traverser un lien ni une jonction.

    Rend la première erreur rencontrée, ou None. La suppression continue après
    une erreur : reprendre 900 Mo sur 1 Go vaut mieux que rien, et ce qui
    résiste sera repris au passage suivant.
    """
    target = native(path)
    if is_reparse(target):
        return _drop(target, os.path.isdir(target))

    first = None
    try:
        entries = list(os.scandir(target))
    except NotADirectoryError:
        return _drop(target, False)
    except OSError as exc:
        return str(exc)

    for entry in entries:
        if entry.is_dir(follow_symlinks=False) and not is_reparse(entry.path):
            error = remove_tree(entry.path)
        else:
            error = _drop(entry.path, is_reparse(entry.path) and entry.is_dir())
        first = first or error

    return first or _drop(target, True)


def dir_size(path, deadline):
    """Octets occupés, ou None si l'inventaire dépasse le temps imparti.

    Sous Windows, `DirEntry.stat(follow_symlinks=False)` est servi par le cache
    du parcours de répertoire : l'inventaire ne coûte pas un appel système par
    fichier. Un lien n'est pas suivi — son contenu appartient à sa cible.
    """
    total, stack = 0, [native(path)]
    while stack:
        if time.monotonic() > deadline:
            return None
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if not is_reparse(entry.path):
                        stack.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
    return total


def main_root():
    """Racine du dépôt principal, quel que soit l'endroit d'où on nous appelle."""
    proc = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
    if proc.returncode != 0:
        return None
    common = Path(proc.stdout.strip())
    return common.parent if common.name == ".git" else None


def list_worktrees(root):
    """Entrées de `git worktree list`, la première étant le dépôt principal."""
    proc = run(["git", "worktree", "list", "--porcelain"], cwd=root)
    if proc.returncode != 0:
        return []
    entries, current = [], {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            if current:
                entries.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = {"path": value, "branch": None,
                       "detached": False, "locked": False}
        elif key == "branch":
            current["branch"] = value.removeprefix("refs/heads/")
        elif key == "detached":
            current["detached"] = True
        elif key == "locked":
            current["locked"] = True
    if current:
        entries.append(current)
    return entries


def pull_requests(root):
    """headRefName -> pull request la plus pertinente (ouverte, sinon mergée)."""
    proc = run([
        "gh", "pr", "list", "--repo", REPO, "--state", "all", "--limit", "100",
        "--json", "number,headRefName,state,url",
    ], cwd=root)
    if proc.returncode != 0:
        return None  # gh absent, non authentifié ou hors ligne
    try:
        records = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        return None
    rank = {"OPEN": 0, "MERGED": 1, "CLOSED": 2}
    best = {}
    for pr in records:
        head = pr.get("headRefName")
        if not head:
            continue
        kept = best.get(head)
        if kept is None or rank.get(pr.get("state"), 3) < rank.get(kept.get("state"), 3):
            best[head] = pr
    return best


def issue_state(root, number, cache):
    if number in cache:
        return cache[number]
    if len(cache) >= MAX_ISSUE_LOOKUPS:
        return None
    proc = run(["gh", "issue", "view", str(number), "--repo", REPO,
                "--json", "state,url"], cwd=root)
    state = None
    if proc.returncode == 0:
        try:
            state = json.loads(proc.stdout)
        except json.JSONDecodeError:
            state = None
    cache[number] = state
    return state


def is_ancestor(root, branch, base):
    return run(["git", "merge-base", "--is-ancestor", branch, base],
               cwd=root).returncode == 0


def dirt(path):
    """Entrées de `git status --porcelain`, en (code, chemin).

    `-z` plutôt que la forme lisible : sinon un nom accentué ou espacé revient
    entre guillemets et échappé, et c'est sur ce nom que se décide la suite.
    """
    proc = run(["git", "status", "--porcelain", "-z"], cwd=path)
    if proc.returncode != 0:
        return []
    fields = [field for field in proc.stdout.split(chr(0)) if field]
    changes, index = [], 0
    while index < len(fields):
        code = fields[index][:2]
        changes.append((code, fields[index][3:]))
        # Un renommage ou une copie ajoutent l'ancien chemin au champ suivant.
        index += 2 if code[:1] in ("R", "C") else 1
    return changes


def residue(name):
    """Ce fichier est-il un résidu d'outillage plutôt que du travail ?"""
    base = os.path.basename(name.replace(chr(92), "/").rstrip("/"))
    return any(fnmatch.fnmatch(base, pattern) for pattern in RESIDUE)


def preview(names, limit=3):
    """« a.ts, b.ts, c.ts +4 » — de quoi agir sans ouvrir le worktree."""
    extra = len(names) - limit
    return ", ".join(names[:limit]) + (" +{}".format(extra) if extra > 0 else "")


def human(size):
    """« 1,01 Go » — le volume tel qu'un humain le lit."""
    if size is None:
        return None
    value = float(size)
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if value < 1024 or unit == "To":
            text = "{:.0f}".format(value) if unit == "o" else "{:.2f}".format(value)
            return text.replace(".", ",") + " " + unit
        value /= 1024


def unpushed(root, path):
    """Commits présents ici et nulle part ailleurs, ou None si indéterminable."""
    proc = run(["git", "rev-list", "--count", "@{upstream}..HEAD"], cwd=path)
    if proc.returncode == 0:
        return int(proc.stdout.strip() or 0)
    # Pas de branche de suivi : comparer à la base. Une branche jamais poussée
    # dont les commits ne sont pas dans develop est du travail à ne pas perdre.
    proc = run(["git", "rev-list", "--count", BASE_REF + "..HEAD"], cwd=path)
    if proc.returncode != 0:
        return None
    return int(proc.stdout.strip() or 0)


def issue_number(branch):
    match = ISSUE_IN_BRANCH.search(branch)
    return int(match.group(1)) if match else None


def verdict(root, entry, prs, issues):
    """(action, raison, issue) — action vaut 'remove' ou 'keep'."""
    branch = entry["branch"]
    if entry["detached"] or not branch:
        return "keep", "HEAD détachée", None
    if branch in PROTECTED:
        return "keep", "branche protégée", None

    number = issue_number(branch)

    # Un worktree verrouillé est un worktree occupé : sous `/milestone`, c'est
    # la trace qu'un agent tient le ticket, et le lui retirer casse son leg
    # (#130). Aucun signal d'intégration ne prime là-dessus.
    if entry.get("locked"):
        return "keep", "worktree verrouillé — un agent le tient", number

    if prs is not None:
        pr = prs.get(branch)
        if pr and pr.get("state") == "OPEN":
            return "keep", "PR #{} encore ouverte".format(pr["number"]), number
        if pr and pr.get("state") == "MERGED":
            return "remove", "PR #{} mergée".format(pr["number"]), number

    if is_ancestor(root, branch, BASE_REF):
        return "remove", "branche déjà intégrée dans " + BASE_REF, number

    if number is not None:
        state = issue_state(root, number, issues)
        if state and state.get("state") == "CLOSED":
            return "remove", "issue #{} fermée".format(number), number

    return "keep", "ticket encore en cours", number


def safety_hold(root, entry, reason, force):
    """Raison de conserver malgré un verdict de suppression, sinon None."""
    if force:
        return None

    # Une PR mergée ou une branche déjà intégrée garantissent que le contenu est
    # dans develop : un merge en squash laisse des commits locaux sans jumeau
    # dans develop, les compter ici bloquerait tous les nettoyages légitimes.
    integrated = reason.startswith("PR ") or reason.startswith("branche déjà")

    changes = dirt(entry["path"])
    if changes:
        # Le ticket est fini : ce qui traîne encore n'est passé par aucune revue
        # et n'ira nulle part. Ne s'y opposer que si c'est du travail — sinon un
        # vidage de crash ou un lockfile réécrit par `npm install` retient le
        # worktree à vie, ce qui a laissé 484 Mo derrière deux PR mergées (#173).
        blocking = [name for code, name in changes
                    if not integrated or not residue(name)]
        if blocking:
            return "modifications non commitées ({})".format(preview(blocking))

    if integrated:
        return None
    ahead = unpushed(root, entry["path"])
    if ahead:
        return "{} commit(s) jamais poussé(s)".format(ahead)
    return None


def remove(root, entry):
    """Supprime le worktree puis la branche locale. Retourne une erreur ou None.

    `--force` est systématique : `verdict` et `safety_hold` ont déjà tranché, et
    sans lui git refuse tout worktree portant le moindre fichier non suivi — un
    `grep.exe.stackdump` suffisait à faire échouer le nettoyage. Un seul
    `--force` ne brise aucun verrou (il en faudrait deux), et un worktree
    verrouillé est de toute façon écarté par `verdict`.
    """
    proc = run(["git", "worktree", "remove", "--force", entry["path"]], cwd=root)
    if proc.returncode != 0:
        details = (proc.stderr or proc.stdout).strip().splitlines()
        return details[-1] if details else "échec inconnu"

    branch = entry["branch"]
    if branch and branch not in PROTECTED:
        # -D et non -d : un merge en squash laisse la branche non-ancêtre de
        # develop, git refuserait de la supprimer alors que tout est intégré.
        run(["git", "branch", "-D", branch], cwd=root)
    run(["git", "worktree", "prune"], cwd=root)
    return None


def orphan_branches(root, held):
    """Branches de ticket qu'aucun worktree ne détient plus."""
    proc = run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
               cwd=root)
    if proc.returncode != 0:
        return []
    return [b for b in (line.strip() for line in proc.stdout.splitlines())
            if b and b not in held and b not in PROTECTED and TICKET_BRANCH.match(b)]


def attached(root, path):
    """Le répertoire est-il encore un worktree git à part entière ?

    `git rev-parse` remonte l'arborescence : lancé dans un répertoire orphelin,
    il trouve le dépôt principal, puisque `.claude/worktrees/` est dans son
    arbre de travail. Le seul verdict fiable est donc l'identité du répertoire
    git obtenu — celui du dépôt principal signifie « plus rattaché ».
    """
    proc = run(["git", "rev-parse", "--path-format=absolute", "--git-dir"], cwd=path)
    if proc.returncode != 0:
        return False
    return not same_path(proc.stdout.strip(), Path(root) / ".git")


def stray_dirs(root, live_paths):
    """Répertoires de WORKTREE_DIR qu'aucun worktree vivant ne revendique."""
    base = Path(root) / WORKTREE_DIR
    if not base.is_dir():
        return []
    claimed = {norm(path) for path in live_paths}
    found = []
    for child in sorted(base.iterdir()):
        # Un lien n'est pas un worktree égaré : le suivre supprimerait sa cible.
        if not child.is_dir() or is_reparse(child):
            continue
        if norm(child) in claimed:
            continue
        # Confinement : rien qui, une fois les liens résolus, sorte du dossier.
        if not within(child.resolve(), base.resolve()):
            continue
        found.append(child)
    return found


def stray_verdict(root, path, here, now, released=False):
    """(action, raison) — sans git pour l'interroger, la preuve est ailleurs."""
    if same_path(path, here) or within(here, path):
        return "keep", "répertoire courant"
    if attached(root, path):
        return "keep", "worktree git valide mais absent de la liste — `git worktree repair`"
    # Un répertoire que le premier passage vient de faire relâcher par git ne
    # peut pas être une installation en cours : son mtime tout frais est celui
    # de la suppression partielle. Sans cette exception, le garde-fou d'âge le
    # renverrait au passage suivant — l'inverse de ce que le recalcul cherche.
    if released:
        return "remove", "résidu d'un worktree tout juste supprimé"
    try:
        age = now - os.stat(str(path)).st_mtime
    except OSError:
        age = MIN_ORPHAN_AGE
    if age < MIN_ORPHAN_AGE:
        return "keep", "touché il y a moins de {} min — installation peut-être en cours".format(
            max(1, MIN_ORPHAN_AGE // 60))
    return "remove", "répertoire orphelin — aucun worktree git ne le revendique"


def branch_verdict(root, branch, prs, issues):
    """Sans worktree à inspecter, n'accepter que les preuves d'intégration."""
    number = issue_number(branch)

    if prs is not None:
        pr = prs.get(branch)
        if pr and pr.get("state") == "OPEN":
            return "keep", "PR #{} encore ouverte".format(pr["number"]), number
        if pr and pr.get("state") == "MERGED":
            return "remove", "PR #{} mergée".format(pr["number"]), number

    # L'ancestralité seule ne suffit pas : une branche tout juste créée sur
    # develop la satisfait aussi. Il faut que le ticket soit clos par ailleurs.
    if is_ancestor(root, branch, BASE_REF) and number is not None:
        state = issue_state(root, number, issues)
        if state and state.get("state") == "CLOSED":
            return "remove", "issue #{} fermée, branche intégrée".format(number), number

    return "keep", "ticket encore en cours", number


def parse_args():
    parser = argparse.ArgumentParser(
        description="Supprime les worktrees dont le ticket est terminé.")
    parser.add_argument("--dry-run", action="store_true",
                        help="montre les décisions sans rien supprimer")
    parser.add_argument("--force", action="store_true",
                        help="supprime même si le worktree est sale ou non poussé")
    parser.add_argument("--no-fetch", action="store_true",
                        help="ne rafraîchit pas la base avant l'analyse")
    parser.add_argument("--no-branches", action="store_true",
                        help="ne touche pas aux branches de ticket orphelines")
    parser.add_argument("--no-dirs", action="store_true",
                        help="ne touche pas aux répertoires orphelins de "
                             + WORKTREE_DIR)
    parser.add_argument("--size", action="store_true",
                        help="chiffre aussi le volume des worktrees conservés")
    parser.add_argument("--json", action="store_true",
                        help="sortie machine, pour les hooks")
    parser.add_argument("--quiet", action="store_true",
                        help="n'affiche rien si aucun worktree n'a été supprimé")
    return parser.parse_args()


def main():
    args = parse_args()
    root = main_root()
    if root is None:
        return report(args, [], [], ["dépôt git introuvable"])

    run(["git", "worktree", "prune"], cwd=root)
    entries = list_worktrees(root)
    candidates = [e for e in entries[1:] if not same_path(e["path"], root)]
    held = {e["branch"] for e in entries if e.get("branch")}
    orphans = [] if args.no_branches else orphan_branches(root, held)
    pending = [] if args.no_dirs else stray_dirs(root, [e["path"] for e in entries])
    if not candidates and not orphans and not pending:
        return report(args, [], [], [])

    here = Path.cwd().resolve()
    now = time.time()
    if not args.no_fetch and "/" in BASE_REF:
        remote, _, branch = BASE_REF.partition("/")
        run(["git", "fetch", "--quiet", remote, branch], cwd=root, timeout=20)

    prs = pull_requests(root)
    # Après le réseau, jamais avant : un `git fetch` lent mangerait à lui seul
    # tout le budget, et plus aucun volume ne serait mesuré.
    deadline = time.monotonic() + SIZE_BUDGET
    issues, removed, kept, errors = {}, [], [], []
    released = set()
    if prs is None:
        errors.append("GitHub injoignable — analyse limitée aux signaux locaux")

    for entry in candidates:
        record = {"kind": "worktree", "path": entry["path"], "branch": entry["branch"]}
        if same_path(entry["path"], here) or within(here, entry["path"]):
            kept.append(dict(record, reason="worktree courant"))
            continue

        action, reason, number = verdict(root, entry, prs, issues)
        record["issue"] = number
        if action == "keep":
            kept.append(dict(record, reason=reason))
            continue

        hold = safety_hold(root, entry, reason, args.force)
        if hold:
            kept.append(dict(record, reason="{}, mais {}".format(reason, hold)))
            continue

        size = dir_size(entry["path"], deadline)
        if args.dry_run:
            removed.append(dict(record, reason=reason, bytes=size, dry_run=True))
            continue

        error = remove(root, entry)
        if error:
            errors.append("{} : {}".format(entry["branch"], error))
            kept.append(dict(record, bytes=size,
                             reason="suppression impossible ({})".format(error)))
        else:
            released.add(norm(entry["path"]))
            removed.append(dict(record, reason=reason, bytes=size))

    # Les branches détenues par un worktree ont été exclues de `orphans` : ce
    # passage ne voit que celles dont le répertoire avait déjà disparu.
    for branch in orphans:
        record = {"kind": "branche", "path": None, "branch": branch}
        action, reason, number = branch_verdict(root, branch, prs, issues)
        record["issue"] = number
        if action == "keep":
            kept.append(dict(record, reason=reason))
            continue
        if args.dry_run:
            removed.append(dict(record, reason=reason, dry_run=True))
            continue
        proc = run(["git", "branch", "-D", branch], cwd=root)
        if proc.returncode != 0:
            errors.append("{} : {}".format(branch, proc.stderr.strip()))
            kept.append(dict(record, reason="suppression impossible"))
        else:
            removed.append(dict(record, reason=reason))

    # Troisième passage. Recalculé après le premier : un `git worktree remove`
    # qui échoue supprime quand même l'entrée d'administration, et le répertoire
    # qu'il laisse derrière lui devient orphelin à l'instant même — le reprendre
    # ici évite d'attendre le passage suivant.
    strays = [] if args.no_dirs else stray_dirs(
        root, [e["path"] for e in list_worktrees(root)])
    for path in strays:
        # Le premier passage a déjà compté et annoncé ce répertoire-là : finir
        # son ménage, mais sans le porter une seconde fois au total.
        known = norm(path) in released
        record = {"kind": "répertoire", "path": str(path),
                  "branch": None, "issue": None}
        action, reason = stray_verdict(root, path, here, now, known)
        if action == "keep":
            kept.append(dict(record, reason=reason))
            continue

        size = None if known else dir_size(path, deadline)
        if args.dry_run:
            removed.append(dict(record, reason=reason, bytes=size, dry_run=True))
            continue

        error = remove_tree(path)
        if error:
            errors.append("{} : {}".format(path.name, error))
            if not known:
                kept.append(dict(record, bytes=dir_size(path, deadline),
                                 reason="suppression impossible ({})".format(error)))
        elif not known:
            removed.append(dict(record, reason=reason, bytes=size))
    if strays and not args.dry_run:
        run(["git", "worktree", "prune"], cwd=root)

    # Le volume de ce qui est conservé se paie en temps d'inventaire : hors du
    # budget des suppressions, et seulement quand on l'a demandé.
    if args.size:
        budget = time.monotonic() + SIZE_BUDGET
        for item in kept:
            if item.get("path") and item.get("bytes") is None:
                item["bytes"] = dir_size(item["path"], budget)

    return report(args, removed, kept, errors)


def total_bytes(items):
    return sum(item.get("bytes") or 0 for item in items)


def measured(items):
    """Volume mis en forme, ou None quand rien n'a pu être mesuré.

    `human(0)` rend « 0 o », qui est vrai : sans ce filtre, un passage n'ayant
    supprimé que des branches — ou dont l'inventaire a dépassé son budget —
    annoncerait « 0 o récupéré ».
    """
    total = total_bytes(items)
    return human(total) if total else None


def report(args, removed, kept, errors):
    if args.json:
        # `volume` est mis en forme ici et pas dans le hook : deux façons
        # d'écrire « 1,01 Go » finiraient par diverger.
        print(json.dumps({"removed": removed, "kept": kept, "errors": errors,
                          "bytes": total_bytes(removed),
                          "volume": measured(removed)},
                         ensure_ascii=False))
        return 0
    if args.quiet and not removed and not errors:
        return 0

    def line(item):
        kind = item.get("kind", "worktree")
        size = human(item.get("bytes"))
        return "  - [{}] {} — {}{}".format(
            kind, item["branch"] or item["path"], item["reason"],
            " ({})".format(size) if size else "")

    def volume(items, wording):
        size = measured(items)
        return " — {} {}".format(size, wording) if size else ""

    if removed:
        prefix = "À supprimer" if args.dry_run else "Supprimé"
        print("{} ({}){} :".format(
            prefix, len(removed),
            volume(removed, "à récupérer" if args.dry_run else "récupéré")))
        for item in removed:
            print(line(item))
    else:
        print("Aucun worktree à nettoyer.")
    if kept and not args.quiet:
        print("Conservé ({}){} :".format(len(kept), volume(kept, "retenu")))
        for item in kept:
            print(line(item))
    for error in errors:
        print("! " + error, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
