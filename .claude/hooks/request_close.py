#!/usr/bin/env python3
"""Hook Stop — clôture le ticket de traçabilité avec le résumé des changements.

Contrepartie de request_open.py : à la fin du tour, publie ce qui a réellement
été produit (commits, fichiers modifiés, travail non commité) puis referme le
ticket. Sans état enregistré pour la session, ne fait rien.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".claude" / ".tracking"
MAX_LINES = 40


def run(args):
    return subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        errors="replace",
    )


def block(title, content, lang=""):
    if not content.strip():
        return ""
    lines = content.strip().splitlines()
    truncated = len(lines) > MAX_LINES
    shown = "\n".join(lines[:MAX_LINES])
    suffix = f"\n… et {len(lines) - MAX_LINES} ligne(s) de plus" if truncated else ""
    return f"**{title}**\n\n```{lang}\n{shown}{suffix}\n```\n\n"


def main():
    try:
        # Sous Windows, sys.stdin décode en cp1252 : décoder explicitement.
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except Exception:
        sys.exit(0)

    session = event.get("session_id") or "unknown"
    state_file = STATE_DIR / f"{session}.json"
    if not state_file.exists():
        sys.exit(0)

    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        state_file.unlink(missing_ok=True)
        sys.exit(0)

    number = state.get("issue")
    base = state.get("base") or ""

    commits = diffstat = ""
    if base:
        commits = run(["git", "log", "--oneline", f"{base}..HEAD"]).stdout
        diffstat = run(["git", "diff", "--stat", f"{base}..HEAD"]).stdout
    pending = run(["git", "status", "--short"]).stdout
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    now = datetime.now(timezone.utc).astimezone()

    parts = ["## Résultat\n\n"]
    if not (commits.strip() or diffstat.strip() or pending.strip()):
        parts.append("Aucune modification de fichier — échange sans production de code.\n\n")
    parts.append(block("Commits", commits))
    parts.append(block("Fichiers modifiés", diffstat))
    parts.append(block("Travail non commité en fin de tour", pending))
    parts.append(
        f"---\n\nClôturé le {now.strftime('%d/%m/%Y à %H:%M %Z')} · "
        f"branche `{branch or 'inconnue'}`"
    )
    comment = "".join(parts)

    proc = subprocess.run(
        ["gh", "issue", "comment", str(number), "--repo", REPO, "--body-file", "-"],
        cwd=ROOT, input=comment, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode == 0:
        run(["gh", "issue", "close", str(number), "--repo", REPO,
             "--reason", "completed"])

    state_file.unlink(missing_ok=True)
    sys.stdout.buffer.write(json.dumps(
        {"systemMessage": f"Ticket de traçabilité #{number} clôturé.",
         "suppressOutput": True},
        ensure_ascii=False,
    ).encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
