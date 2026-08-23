#!/usr/bin/env python3
"""Hooks SessionStart et Stop — nettoie les worktrees dont le ticket est terminé.

Enveloppe fine autour de `scripts/worktree_gc.py` : le hook décide *quand*
nettoyer, le script décide *quoi*. Deux moments complémentaires :

- `SessionStart` : ramasse ce que les sessions précédentes ont laissé, y compris
  les tickets mergés depuis, hors session ;
- `Stop` : nettoie dans la foulée du merge fait pendant le tour.

Ne dit rien quand il n'y a rien à dire, et ne bloque jamais : sans worktree
secondaire, le script sort en quelques millisecondes sans toucher au réseau.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "scripts" / "worktree_gc.py"
TIMEOUT = int(os.environ.get("SPA_WORKTREE_GC_TIMEOUT", "60"))


def quiet():
    sys.exit(0)


def emit(message):
    sys.stdout.buffer.write(
        json.dumps({"systemMessage": message, "suppressOutput": True},
                   ensure_ascii=False).encode("utf-8")
    )
    sys.exit(0)


def main():
    if os.environ.get("SPA_WORKTREE_GC", "").lower() in {"off", "0", "false"}:
        quiet()
    if not ENGINE.exists():
        quiet()

    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except Exception:
        event = {}

    # `Stop` se déclenche à chaque tour : le signal décisif y vient de `gh pr
    # list`, pas des refs locales, donc pas de fetch à chaque fois. En début de
    # session en revanche, la base a pu bouger ailleurs — là, il est utile.
    args = [sys.executable, str(ENGINE), "--json", "--quiet"]
    if event.get("hook_event_name") != "SessionStart":
        args.append("--no-fetch")

    proc = subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=TIMEOUT,
    )
    if proc.returncode != 0:
        quiet()

    try:
        result = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        quiet()

    removed = result.get("removed") or []
    if not removed:
        quiet()

    names = ", ".join(item.get("branch") or item.get("path", "?") for item in removed)
    reasons = {item.get("reason", "") for item in removed}
    detail = " ({})".format(reasons.pop()) if len(reasons) == 1 else ""
    emit("Worktree{} nettoyé{} : {}{}".format(
        "s" if len(removed) > 1 else "",
        "s" if len(removed) > 1 else "",
        names, detail,
    ))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Un hook qui plante ne doit jamais empêcher la session de continuer.
        sys.exit(0)
