#!/usr/bin/env python3
"""Barrière de merge : n'autorise une PR que si toute la CI est verte.

    python scripts/pr_gate.py 42                # attend la CI, rend un verdict
    python scripts/pr_gate.py 42 --merge        # merge en squash si tout est vert
    python scripts/pr_gate.py 42 --no-wait      # verdict immédiat, sans attendre

Le dépôt est sur un plan GitHub Free : ni protection de branche, ni check
obligatoire. GitHub laisserait donc merger une PR dont la CI est rouge — c'est
ce script qui tient le rôle, côté client, et il le tient par un code de sortie
plutôt que par une consigne en prose.

Un check ne passe que s'il conclut sur SUCCESS, SKIPPED ou NEUTRAL. Tout le
reste bloque. Une PR sans aucun check bloque aussi : cela signifie qu'aucun
workflow ne s'est déclenché, pas que tout va bien.

Codes de sortie — 0 vert · 1 en attente ou délai dépassé · 2 check en échec ·
3 PR inapte au merge (brouillon, conflit, mauvaise base) · 4 erreur d'appel.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un nom de job accentué ferait
# planter le script, éventuellement APRÈS un merge déjà effectué.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
ROOT = Path(__file__).resolve().parents[1]

# Un workflow filtré par chemin (terraform.yml) ou sorti volontairement
# (project-automation.yml sans PROJECT_TOKEN) conclut SKIPPED ou NEUTRAL :
# l'exiger vert bloquerait tous les merges.
PASSING = {"SUCCESS", "SKIPPED", "NEUTRAL"}
PENDING_STATUS = {"QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"}

FIELDS = ("number,state,isDraft,baseRefName,headRefName,mergeable,"
          "mergeStateStatus,statusCheckRollup,url,title")

GREEN, PENDING, FAILED, UNFIT, USAGE = 0, 1, 2, 3, 4


def run(args, cwd=None, timeout=120):
    try:
        return subprocess.run(
            args, cwd=cwd or ROOT, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return subprocess.CompletedProcess(args, 1, "", "commande indisponible")


def fetch_pr(number):
    proc = run(["gh", "pr", "view", str(number), "--repo", REPO, "--json", FIELDS])
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip()
    try:
        return json.loads(proc.stdout), None
    except json.JSONDecodeError:
        return None, "réponse gh illisible"


def check_entries(rollup):
    """Normalise le rollup hétérogène de GitHub en (nom, état, détail)."""
    for item in rollup or []:
        if item.get("__typename") == "StatusContext":
            name = item.get("context") or "statut externe"
            raw = (item.get("state") or "").upper()
            if raw == "SUCCESS":
                yield name, "pass", raw
            elif raw in {"PENDING", "EXPECTED"}:
                yield name, "pending", raw or "PENDING"
            else:
                yield name, "fail", raw or "INCONNU"
            continue

        name = item.get("name") or "check"
        workflow = item.get("workflowName")
        if workflow and workflow != name:
            name = "{} / {}".format(workflow, name)
        status = (item.get("status") or "").upper()
        conclusion = (item.get("conclusion") or "").upper()

        if status and status != "COMPLETED":
            yield name, "pending", status
        elif conclusion in PASSING:
            yield name, "pass", conclusion
        elif not conclusion:
            yield name, "pending", status or "PENDING"
        else:
            yield name, "fail", conclusion


def fitness(pr, base):
    """Ce qui rend la PR inapte au merge, indépendamment de la CI."""
    if pr.get("state") != "OPEN":
        return "la PR est {}, pas ouverte".format(pr.get("state", "?").lower())
    if pr.get("isDraft"):
        return "la PR est en brouillon"
    if pr.get("baseRefName") != base:
        return "la PR cible {} au lieu de {}".format(pr.get("baseRefName"), base)
    if (pr.get("mergeable") or "").upper() == "CONFLICTING":
        return "la PR est en conflit avec sa base"
    if (pr.get("mergeStateStatus") or "").upper() == "DIRTY":
        return "la base a divergé, la PR doit être rebasée"
    return None


def assess(pr, base, allow_no_checks):
    """(code, message, checks) — l'unique endroit qui décide."""
    unfit = fitness(pr, base)
    if unfit:
        return UNFIT, unfit, []

    checks = list(check_entries(pr.get("statusCheckRollup")))
    failed = [c for c in checks if c[1] == "fail"]
    pending = [c for c in checks if c[1] == "pending"]

    if failed:
        return FAILED, "{} check(s) en échec".format(len(failed)), checks
    if pending:
        return PENDING, "{} check(s) en cours".format(len(pending)), checks
    if not checks:
        if allow_no_checks:
            return GREEN, "aucun check déclaré (toléré)", checks
        return PENDING, "aucun check déclaré pour l'instant", checks

    # mergeable UNKNOWN : GitHub calcule encore la fusion, il refuserait le merge.
    if (pr.get("mergeable") or "").upper() == "UNKNOWN":
        return PENDING, "GitHub calcule encore la fusion", checks

    return GREEN, "{} check(s) au vert".format(len(checks)), checks


def show(checks, quiet):
    if quiet:
        return
    symbol = {"pass": "OK  ", "pending": "... ", "fail": "KO  "}
    for name, state, detail in sorted(checks, key=lambda c: (c[1] != "fail", c[0])):
        print("  {}{} — {}".format(symbol[state], name, detail.lower()))


def wait_for_checks(number, args):
    """Sonde la PR jusqu'à ce que la CI conclue, ou que le délai expire."""
    deadline = time.time() + args.timeout
    last_message = None
    while True:
        pr, error = fetch_pr(number)
        if pr is None:
            return USAGE, "PR #{} introuvable : {}".format(number, error), None, []

        code, message, checks = assess(pr, args.base, args.allow_no_checks)
        if code != PENDING or args.no_wait:
            return code, message, pr, checks

        if not args.quiet and message != last_message:
            print("… {} (délai restant : {}s)".format(
                message, max(0, int(deadline - time.time()))))
            last_message = message

        if time.time() + args.interval >= deadline:
            return PENDING, "délai dépassé — " + message, pr, checks
        time.sleep(args.interval)


def merge(number, pr, args):
    """Merge en squash puis supprime la branche. Retourne (code, message)."""
    command = ["gh", "pr", "merge", str(number), "--repo", REPO, "--squash"]
    if not args.no_delete_branch:
        command.append("--delete-branch")
    proc = run(command)
    if proc.returncode != 0:
        return FAILED, "merge refusé par GitHub : " + \
            (proc.stderr or proc.stdout).strip()

    after, _ = fetch_pr(number)
    if after and after.get("state") != "MERGED":
        return FAILED, "après appel, la PR est {} et non MERGED".format(
            after.get("state"))

    lines = ["PR #{} mergée en squash.".format(number)]
    if not args.no_delete_branch:
        lines.append(branch_cleanup(pr.get("headRefName")))
    return GREEN, " ".join(part for part in lines if part)


def branch_cleanup(head):
    """Vérifie la disparition du distant, délègue le local au ramasse-miettes."""
    if not head:
        return ""
    run(["git", "fetch", "--prune", "--quiet", "origin"], timeout=60)
    remote = run(["git", "ls-remote", "--heads", "origin", head], timeout=60)
    if remote.returncode == 0 and remote.stdout.strip():
        return "Branche distante {} toujours présente — à supprimer à la main.".format(head)

    # worktree_gc voit la PR mergée et supprime worktree comme branche locale ;
    # lui déléguer évite de dupliquer ici ses garde-fous (worktree sale, etc.).
    gc = ROOT / "scripts" / "worktree_gc.py"
    if gc.exists():
        run([sys.executable, str(gc), "--quiet", "--no-fetch"], timeout=120)
    still_local = run(["git", "branch", "--list", head])
    if still_local.returncode == 0 and still_local.stdout.strip():
        return ("Branche distante supprimée ; la locale {} subsiste "
                "(worktree sale ou commits non poussés).".format(head))
    return "Branche {} supprimée, distante et locale.".format(head)


def parse_args():
    parser = argparse.ArgumentParser(
        description="N'autorise le merge d'une PR que si toute la CI est verte.")
    parser.add_argument("pr", type=int, help="numéro de la pull request")
    parser.add_argument("--merge", action="store_true",
                        help="merge en squash si et seulement si tout est vert")
    parser.add_argument("--base", default="develop",
                        help="base attendue de la PR (défaut : develop)")
    parser.add_argument("--timeout", type=int, default=1800,
                        help="attente maximale de la CI, en secondes")
    parser.add_argument("--interval", type=int, default=15,
                        help="intervalle entre deux sondages, en secondes")
    parser.add_argument("--no-wait", action="store_true",
                        help="verdict immédiat, sans attendre la fin de la CI")
    parser.add_argument("--no-delete-branch", action="store_true",
                        help="conserve la branche après le merge")
    parser.add_argument("--allow-no-checks", action="store_true",
                        help="tolère une PR sur laquelle aucun workflow ne tourne")
    parser.add_argument("--quiet", action="store_true",
                        help="n'affiche que le verdict final")
    return parser.parse_args()


def main():
    args = parse_args()
    code, message, pr, checks = wait_for_checks(args.pr, args)

    if pr is not None and not args.quiet:
        print("PR #{} — {}".format(pr.get("number"), pr.get("title", "")))
        show(checks, args.quiet)

    if code != GREEN:
        print("BLOQUÉ : {}".format(message), file=sys.stderr)
        if code == FAILED:
            print("Logs : gh run view --log-failed --repo {}".format(REPO),
                  file=sys.stderr)
        return code

    print("VERT : {}".format(message))
    if not args.merge:
        return GREEN

    # Deuxième lecture juste avant d'agir : un check a pu démarrer entre le
    # verdict et maintenant, et le premier verdict serait alors périmé.
    fresh, error = fetch_pr(args.pr)
    if fresh is None:
        print("BLOQUÉ : relecture impossible avant merge : " + str(error),
              file=sys.stderr)
        return USAGE
    recheck, remessage, _ = assess(fresh, args.base, args.allow_no_checks)
    if recheck != GREEN:
        print("BLOQUÉ : l'état a changé avant le merge — " + remessage,
              file=sys.stderr)
        return recheck

    code, message = merge(args.pr, fresh, args)
    print(message if code == GREEN else "BLOQUÉ : " + message,
          file=sys.stdout if code == GREEN else sys.stderr)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(USAGE)
