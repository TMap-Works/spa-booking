#!/usr/bin/env python3
"""Hook Stop — clôture le ticket de traçabilité avec le résumé des changements.

Contrepartie de request_open.py : à la fin du tour, publie ce qui a réellement
été produit (commits, fichiers modifiés, travail non commité), passe la carte du
Project en `Done` et referme le ticket. Sans état enregistré pour la session,
ne fait rien.

Le ticket ouvert à la main par `/ticket-new` est refermé de la même façon : il
vit sous l'état « manual », faute d'identifiant de session côté commande.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRACKING = ROOT / "scripts" / "tracking.py"
STATE_DIR = ROOT / ".claude" / ".tracking"


def close(session):
    if not (STATE_DIR / f"{session}.json").exists():
        return None
    proc = subprocess.run(
        [sys.executable, str(TRACKING), "close", "--session", session],
        cwd=ROOT, capture_output=True,
    )
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout.decode("utf-8", "replace").strip() or "{}")
    except Exception:
        return None


def main():
    try:
        # Sous Windows, sys.stdin décode en cp1252 : décoder explicitement.
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except Exception:
        sys.exit(0)

    session = event.get("session_id") or "unknown"
    closed = [result["issue"] for result in (close(session), close("manual"))
              if result and result.get("closed")]
    if not closed:
        sys.exit(0)

    numbers = ", ".join(f"#{number}" for number in closed)
    sys.stdout.buffer.write(json.dumps(
        {"systemMessage": f"Ticket de traçabilité {numbers} clôturé.",
         "suppressOutput": True},
        ensure_ascii=False,
    ).encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
