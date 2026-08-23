#!/usr/bin/env python3
"""Hook UserPromptSubmit — ouvre un ticket de traçabilité pour chaque demande.

Historise dans GitHub tout ce qui est demandé à Claude Code sur ce projet.
Le ticket est refermé en fin de tour par request_close.py, avec le résumé des
changements effectivement produits.

Ce hook décide *quand* ouvrir ; [`scripts/tracking.py`](../../scripts/tracking.py)
décide *quoi* écrire — jalon de sprint, labels, carte sur le GitHub Project.

Les relances triviales (« ok », « continue », « merci ») et les commandes slash
sont ignorées : un historique noyé sous des tickets vides ne documente rien.
Seuil de longueur ajustable via SPA_TRACKING_MIN_CHARS ; traçabilité
désactivable d'un coup via SPA_TRACKING=off. Ce que ce filtre laisse passer à
tort se rattrape avec `/ticket-new`.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MIN_CHARS = int(os.environ.get("SPA_TRACKING_MIN_CHARS", "30"))
ROOT = Path(__file__).resolve().parents[2]
TRACKING = ROOT / "scripts" / "tracking.py"
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
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sys.exit(0)


def quiet():
    sys.exit(0)


def tracking(subcommand, prompt, *args):
    proc = subprocess.run(
        [sys.executable, str(TRACKING), subcommand, "--prompt-file", "-", *args],
        cwd=ROOT, input=prompt.encode("utf-8"), capture_output=True,
    )
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout.decode("utf-8", "replace").strip() or "{}")
    except Exception:
        return None


def context(number, url, extra=""):
    return (
        f"Traçabilité : cette demande est historisée dans l'issue #{number} de "
        f"TMap-Works/spa-booking ({url}). Si tu produis des commits pour cette "
        f"demande, ajoute la ligne `Refs #{number}` dans le message. Ne clôture "
        f"pas ce ticket toi-même : un hook s'en charge en fin de tour." + extra
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
    # le travail sur une issue existante, /ticket-new ouvre le ticket lui-même).
    if prompt.startswith("/"):
        quiet()
    if TRIVIAL.match(prompt):
        quiet()
    if len(prompt) < MIN_CHARS:
        quiet()

    # Un ticket est déjà ouvert pour cette session : le tour est encore en cours
    # (message enchaîné pendant que Claude travaille) ou il a été interrompu
    # avant le hook Stop. Dans les deux cas la demande est rattachée au ticket
    # ouvert plutôt que perdue — c'est le hook Stop qui refermera l'ensemble.
    if (STATE_DIR / f"{session}.json").exists():
        noted = tracking("note", prompt, "--session", session)
        if not noted:
            quiet()
        emit({
            "systemMessage": f"Demande rattachée au ticket #{noted['issue']}.",
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context(noted["issue"], noted.get("url", "")),
            },
        })

    opened = tracking("open", prompt, "--session", session)
    if not opened:
        # gh absent, non authentifié, hors ligne : la traçabilité ne doit jamais
        # bloquer le travail.
        emit({
            "systemMessage": "Traçabilité GitHub indisponible — ticket non créé.",
            "suppressOutput": True,
        })

    number, url = opened["issue"], opened.get("url", "")
    classement = opened.get("classement", {})
    resume = (f"{opened.get('milestone') or 'sans jalon'} · "
              f"{classement.get('workstream')} · {classement.get('module')} · "
              f"{classement.get('type')} · {classement.get('priority')}")
    board = "" if opened.get("project") else " (carte Project non posée)"

    # Le classement vient d'une heuristique de mots-clés ; Claude, lui, a lu la
    # demande. Lui donner le moyen de corriger, sinon le board ment.
    extra = ""
    if opened.get("auto"):
        extra = (
            f" Classement automatique du ticket — {resume} — déduit de mots-clés, "
            f"donc faillible : s'il ne correspond pas à la demande, corrige-le "
            f"avec `python scripts/tracking.py classify {number} --module <m> "
            f"--workstream <w> --type <t> --priority <p>` (champs déjà justes : "
            f"les omettre)."
        )

    emit({
        "systemMessage": f"Ticket de traçabilité #{number} — {resume}{board}\n{url}",
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context(number, url, extra),
        },
    })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Un hook qui plante ne doit jamais empêcher la demande d'aboutir.
        sys.exit(0)
