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
  - un worktree sale (fichiers modifiés) ou porteur de commits jamais poussés
    est conservé, avec la raison affichée — sauf `--force`.

Second passage : les **branches de ticket orphelines**, que plus aucun worktree
ne détient — ce que laisse derrière lui un répertoire supprimé à la main. Leur
suppression est délibérément plus stricte, faute de worktree à inspecter : il
faut une PR mergée, ou une branche déjà intégrée *et* une issue fermée. Dans les
deux cas le contenu est dans la base, rien ne peut être perdu. `--no-branches`
s'en tient aux worktrees.

Sans réseau ni `gh`, le script se rabat sur le seul signal local (l'ancestralité)
au lieu d'échouer : le nettoyage ne doit jamais bloquer le travail.
"""
import argparse
import json
import os
import re
import subprocess
import sys
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


def same_path(a, b):
    return (os.path.normcase(os.path.normpath(str(a)))
            == os.path.normcase(os.path.normpath(str(b))))


def within(child, parent):
    try:
        Path(child).relative_to(Path(parent))
        return True
    except ValueError:
        return False


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
            current = {"path": value, "branch": None, "detached": False}
        elif key == "branch":
            current["branch"] = value.removeprefix("refs/heads/")
        elif key == "detached":
            current["detached"] = True
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


def dirty(path):
    proc = run(["git", "status", "--porcelain"], cwd=path)
    return bool(proc.stdout.strip()) if proc.returncode == 0 else False


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
    if dirty(entry["path"]):
        return "modifications non commitées"
    # Une PR mergée ou une branche déjà intégrée garantissent que le contenu est
    # dans develop : un merge en squash laisse des commits locaux sans jumeau
    # dans develop, les compter ici bloquerait tous les nettoyages légitimes.
    if reason.startswith("PR ") or reason.startswith("branche déjà"):
        return None
    ahead = unpushed(root, entry["path"])
    if ahead:
        return "{} commit(s) jamais poussé(s)".format(ahead)
    return None


def remove(root, entry, force):
    """Supprime le worktree puis la branche locale. Retourne une erreur ou None."""
    args = ["git", "worktree", "remove", entry["path"]]
    if force:
        args.insert(3, "--force")
    proc = run(args, cwd=root)
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
    if not candidates and not orphans:
        return report(args, [], [], [])

    here = Path.cwd().resolve()
    if not args.no_fetch and "/" in BASE_REF:
        remote, _, branch = BASE_REF.partition("/")
        run(["git", "fetch", "--quiet", remote, branch], cwd=root, timeout=20)

    prs = pull_requests(root)
    issues, removed, kept, errors = {}, [], [], []
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

        if args.dry_run:
            removed.append(dict(record, reason=reason, dry_run=True))
            continue

        error = remove(root, entry, args.force)
        if error:
            errors.append("{} : {}".format(entry["branch"], error))
            kept.append(dict(record, reason="suppression impossible ({})".format(error)))
        else:
            removed.append(dict(record, reason=reason))

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

    return report(args, removed, kept, errors)


def report(args, removed, kept, errors):
    if args.json:
        print(json.dumps({"removed": removed, "kept": kept, "errors": errors},
                         ensure_ascii=False))
        return 0
    if args.quiet and not removed and not errors:
        return 0

    def line(item):
        kind = item.get("kind", "worktree")
        return "  - [{}] {} — {}".format(
            kind, item["branch"] or item["path"], item["reason"])

    if removed:
        prefix = "À supprimer" if args.dry_run else "Supprimé"
        print("{} ({}) :".format(prefix, len(removed)))
        for item in removed:
            print(line(item))
    else:
        print("Aucun worktree à nettoyer.")
    if kept and not args.quiet:
        print("Conservé ({}) :".format(len(kept)))
        for item in kept:
            print(line(item))
    for error in errors:
        print("! " + error, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
