#!/usr/bin/env python3
"""Hook UserPromptSubmit — ouvre un ticket de traçabilité pour chaque demande.

Historise dans GitHub tout ce qui est demandé à Claude Code sur ce projet.
Le ticket est refermé en fin de tour par request_close.py, avec le résumé des
changements effectivement produits.

Les relances triviales (« ok », « continue », « merci ») et les commandes slash
sont ignorées : un historique noyé sous des tickets vides ne documente rien.
Seuil de longueur ajustable via SPA_TRACKING_MIN_CHARS ; traçabilité
désactivable d'un coup via SPA_TRACKING=off.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
LABEL = "tracking"
MIN_CHARS = int(os.environ.get("SPA_TRACKING_MIN_CHARS", "30"))
ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".claude" / ".tracking"

# Relances qui ne constituent pas une nouvelle demande.
TRIVIAL = re.compile(
    r"^(ok|oui|non|yes|no|ouais|go|vas[-\s]?y|continue[rz]?|suite|encore|"
    r"merci|thanks|thx|stop|next|refais|relance|retry|essaie\s+encore|"
    r"c'?est\s+bon|parfait|nickel|super|top|d'?accord|ça\s+marche|"
    r"fais[-\s]?le|termine|finis)\b[\s.!?…]*$",
    re.IGNORECASE,
)


def read_event():
    # Sous Windows, sys.stdin décode en cp1252 : lire les octets et décoder
    # explicitement en UTF-8, sinon les accents du prompt sont doublement encodés.
    return json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))


def emit(payload):
    sys.stdout.buffer.write(
        json.dumps(payload, ensure_ascii=False).encode("utf-8")
    )
    sys.exit(0)


def quiet():
    sys.exit(0)


def run(args, **kw):
    return subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        errors="replace", **kw
    )


def main():
    try:
        event = read_event()
    except Exception:
        quiet()

    if os.environ.get("SPA_TRACKING", "").lower() in {"off", "0", "false"}:
        quiet()

    prompt = (event.get("prompt") or "").strip()
    session = event.get("session_id") or "unknown"

    if not prompt:
        quiet()
    # Une commande slash porte déjà sa propre traçabilité (/feature-start ouvre
    # le travail sur une issue existante).
    if prompt.startswith("/"):
        quiet()
    if TRIVIAL.match(prompt):
        quiet()
    if len(prompt) < MIN_CHARS:
        quiet()

    # Un ticket est déjà ouvert pour ce tour (double soumission) : ne pas doubler.
    state_file = STATE_DIR / f"{session}.json"
    if state_file.exists():
        quiet()

    first_line = prompt.splitlines()[0].strip()
    title = first_line if len(first_line) <= 72 else first_line[:69].rstrip() + "…"

    head = run(["git", "rev-parse", "HEAD"])
    base = head.stdout.strip() if head.returncode == 0 else ""
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    now = datetime.now(timezone.utc).astimezone()

    body = (
        "## Demande\n\n"
        + "\n".join("> " + line for line in prompt.splitlines())
        + "\n\n## Contexte\n\n"
        f"- Ouvert le {now.strftime('%d/%m/%Y à %H:%M %Z')}\n"
        f"- Branche : `{branch or 'inconnue'}`\n"
        + (f"- Commit de départ : `{base[:8]}`\n" if base else "")
        + f"- Session Claude Code : `{session[:8]}`\n\n"
        "---\n\n"
        "_Ticket de traçabilité ouvert automatiquement. Le résumé des "
        "changements est publié en commentaire à la fin du tour, puis le "
        "ticket est clôturé._"
    )

    created = run([
        "gh", "issue", "create",
        "--repo", REPO,
        "--title", title,
        "--body", body,
        "--label", LABEL,
    ])
    if created.returncode != 0:
        # gh absent, non authentifié, hors ligne : la traçabilité ne doit jamais
        # bloquer le travail.
        emit({
            "systemMessage": "Traçabilité GitHub indisponible — ticket non créé.",
            "suppressOutput": True,
        })

    url = created.stdout.strip().splitlines()[-1] if created.stdout.strip() else ""
    number = url.rstrip("/").rsplit("/", 1)[-1]
    if not number.isdigit():
        quiet()

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_file.write_text(
        json.dumps({
            "issue": int(number),
            "url": url,
            "base": base,
            "branch": branch,
            "opened_at": now.isoformat(),
            "title": title,
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    emit({
        "systemMessage": f"Ticket de traçabilité #{number} — {url}",
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": (
                f"Traçabilité : cette demande est historisée dans l'issue "
                f"#{number} de {REPO} ({url}). Si tu produis des commits pour "
                f"cette demande, ajoute la ligne `Refs #{number}` dans le "
                f"message. Ne clôture pas ce ticket toi-même : un hook s'en "
                f"charge en fin de tour."
            ),
        },
    })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Un hook qui plante ne doit jamais empêcher la demande d'aboutir.
        sys.exit(0)
