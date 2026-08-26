#!/usr/bin/env python3
"""Tickets de traçabilité des demandes Claude Code — ouverture, qualification, clôture.

    python scripts/tracking.py open --prompt "..." --module payments --type feature
    python scripts/tracking.py classify 90 --module infra --workstream DevOps --priority P1
    python scripts/tracking.py note --prompt "demande complémentaire"
    python scripts/tracking.py close
    python scripts/tracking.py status
    python scripts/tracking.py sweep --dry-run

Les commandes `/ticket-new` et `/ticket-close` décident *quand* ouvrir et
fermer ; ce script décide *quoi* écrire dans GitHub. Ouvrir un ticket est une
décision prise à la demande, pas un effet de bord d'un hook : ce qui mérite
d'être historisé se juge en lisant la demande, ce qu'aucune heuristique de
mots-clés ne sait faire.

Un ticket de traçabilité est une issue comme les autres : il porte un milestone
de sprint, un label workstream, un label module, un label type, une priorité,
un label nature, et une carte sur le GitHub Project — exactement l'anatomie
exigée par `.claude/skills/project-flow/SKILL.md` §2. Sans ce rattachement, le
ticket n'apparaît dans aucun suivi et ne documente donc rien.

`nature:` dit qui traite le ticket : `projet` pour le produit MVP, que le run de
jalon dispatche, `outillage` pour le dispositif de collaboration, qu'un humain
prend une session à la fois. Un ticket de traçabilité, lui, n'est de toute façon
jamais dispatché — sa nature ne sert qu'à savoir, en fin de sprint, où est passé
le temps.

Sans `--session`, chaque sous-commande travaille sur le ticket ouvert le plus
récent : une commande slash n'a pas d'identifiant de session à passer.

Le classement déduit par défaut n'est qu'une heuristique de mots-clés. Les
options `--module`, `--workstream`, `--type`, `--priority` et `--nature` la
court-circuitent, et c'est le chemin normal depuis `/ticket-new`, qui a lu la
demande ; `classify` corrige après coup.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un accent dans un message de
# sortie fait planter le script APRÈS une écriture déjà appliquée dans GitHub.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")
ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / ".claude" / ".tracking"
PROJECT_STATUS = ROOT / "scripts" / "project_status.py"
TRACKING_LABEL = "tracking"
MAX_LINES = 40
# Sans identifiant de session — le cas courant, `/ticket-new` n'en connaît pas —
# l'état du ticket est rangé sous ce nom. `--session` reste utile aux runs de
# jalon, qui font vivre plusieurs tickets en parallèle sans les confondre.
MANUAL_SESSION = "manual"
SWEEP_HOURS = float(os.environ.get("SPA_TRACKING_SWEEP_HOURS", "6"))

WORKSTREAMS = {
    "DevOps": "ws:devops", "Backend": "ws:backend", "Frontend": "ws:frontend",
    "Design": "ws:design", "QA": "ws:qa",
}
MODULES = ["identity", "catalog", "availability", "appointments", "crm",
           "payments", "notifications", "reporting", "infra"]
TYPES = ["feature", "bug", "chore", "docs", "spike", "epic"]
PRIORITIES = ["P0", "P1", "P2"]
NATURES = ["projet", "outillage"]

# Heuristiques de classement, dans l'ordre : la première qui accroche gagne.
MODULE_HINTS = [
    ("payments", r"paiement|stripe|encaiss|rembours|carte bancaire|\bpos\b|factur|checkout"),
    ("notifications", r"notification|rappel|e-?mail|courriel|\bsms\b|\bses\b|\bsns\b|eventbridge"),
    ("availability", r"cr[ée]neau|disponibilit|horaire|planning|buffer|plage"),
    ("appointments", r"rendez-?vous|r[ée]servation|booking|annulation|no-?show|agenda"),
    ("identity", r"authentif|\bauth\b|connexion|login|r[ôo]le|permission|tenant|\bjwt\b|mot de passe"),
    ("catalog", r"catalogue|prestation|cat[ée]gorie|tarif|\bprix\b"),
    ("crm", r"\bcrm\b|fiche client|profil client|historique client"),
    ("reporting", r"reporting|rapport d|statistique|\bkpi\b|tableau de bord|m[ée]trique"),
    ("infra", r"terraform|\baws\b|\bci\b|\bcd\b|docker|workflow|\bhooks?\b|github|pipeline|"
              r"d[ée]ploiement|script|worktree|ticket"),
]
WORKSTREAM_HINTS = [
    ("QA", r"\btests?\b|recette|\bqa\b|couverture|\be2e\b|playwright|vitest|jest"),
    ("Design", r"\bdesign\b|maquette|\bux\b|charte|figma"),
    ("Frontend", r"\bfront\b|next\.?js|react|composant|formulaire|\bcss\b|tailwind"),
    ("Backend", r"\bapi\b|nest|prisma|endpoint|migration|base de donn[ée]es|\bsql\b|\bdto\b"),
    ("DevOps", r"terraform|\baws\b|\bci\b|docker|workflow|\bhooks?\b|pipeline|d[ée]ploiement|"
               r"github|script"),
]
TYPE_HINTS = [
    ("bug", r"\bbug\b|erreur|plante|casse|corrig|r[ée]par|ne (?:fonctionne|marche|va) pas|"
            r"[ée]chou|rejett|refus[eé]|plus aucun|ne .{0,20}plus\b|"
            r"pas comme pr[ée]vu|r[ée]gression|probl[èe]me"),
    ("docs", r"documentation|\breadme\b|\badr\b|r[ée]dige|document[eé]"),
    ("spike", r"explorer|[ée]tudier|comparer|investiguer|spike|faisabilit"),
    ("feature", r"ajout|cr[ée]e|impl[ée]ment|nouvelle?\b|permettre|support"),
]
PRIORITY_HINTS = [
    ("P0", r"bloquant|urgent|critique|cass[ée]|production"),
    ("P1", r"imp[ée]rativ|important|prioritaire|indispensable|\bmvp\b"),
]
# `nature` sépare ce que le run de jalon dispatche de ce qu'un humain traite à la
# main. Outillage : le dispositif de collaboration lui-même — `scripts/`,
# `.claude/`, le harnais qui les teste, les workflows qui les servent. Produit :
# tout ce que le MVP livre, `infra/terraform` et sa CI de déploiement comprises.
# Le doute penche vers `projet` : c'est le sens qui laisse le ticket sous les
# yeux du run, au lieu de l'en sortir sans que personne ne le voie.
#
# Chaque motif doit donc être propre au dispositif. « permission », « hook »,
# « jalon », « milestone » et « slash » ne le sont pas : rôles et permissions du
# back-office, hook React, « pour le jalon S2 » — c'est du vocabulaire produit
# courant, et les laisser accrocher ferait sortir du sprint un vrai ticket MVP
# sans que rien ne le signale.
NATURE_HINTS = [
    ("outillage", r"outillage|\bscripts?/|\.claude|worktree|arbitr|"
                  r"/ticket|/milestone|milestone_\w+\.py|tracking\.py|"
                  r"(run|plan|arbitrage) de jalon|commande slash|"
                  r"hooks? claude|allowlist|permission_watch|"
                  r"journal de permissions|ticket de tra[çc]abilit|"
                  r"superviseur|orchestrateur"),
]


def run(args, **kw):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def first_match(hints, text, default):
    for value, pattern in hints:
        if re.search(pattern, text, re.IGNORECASE):
            return value
    return default


def classify_prompt(prompt):
    """Devine le classement d'une demande. Faux parfois — corrigeable toujours."""
    module = first_match(MODULE_HINTS, prompt, "infra")
    # Faute de signal explicite, le module décide : une demande sur un module
    # métier est du backend, pas du DevOps.
    return {
        "module": module,
        "workstream": first_match(WORKSTREAM_HINTS, prompt,
                                  "DevOps" if module == "infra" else "Backend"),
        "type": first_match(TYPE_HINTS, prompt, "chore"),
        "priority": first_match(PRIORITY_HINTS, prompt, "P2"),
        "nature": first_match(NATURE_HINTS, prompt, "projet"),
    }


def current_milestone():
    """Le sprint en cours : le premier jalon ouvert dont l'échéance n'est pas passée."""
    proc = run(["gh", "api", f"repos/{REPO}/milestones",
                "--jq", ".[] | [.title, .due_on] | @tsv"])
    if proc.returncode != 0:
        return None
    rows = []
    for line in proc.stdout.strip().splitlines():
        title, _, due = line.partition("\t")
        if title.strip():
            rows.append((title.strip(), due.strip()))
    if not rows:
        return None
    today = datetime.now(timezone.utc).isoformat()
    dated = sorted((r for r in rows if r[1]), key=lambda r: r[1])
    for title, due in dated:
        if due >= today:
            return title
    return (dated or rows)[-1][0]


def sprint_code(milestone):
    match = re.match(r"\s*(S\d)", milestone or "")
    return match.group(1) if match else None


def sync_project(number, status, fields):
    """Pose la carte sur le Project et renseigne ses champs. Jamais bloquant."""
    args = [sys.executable, str(PROJECT_STATUS), str(number), status]
    for name, value in fields.items():
        if value:
            args += ["--field", f"{name}={value}"]
    proc = run(args)
    return proc.returncode == 0, (proc.stderr or proc.stdout).strip()


def labels_for(classement):
    return [
        TRACKING_LABEL,
        f"type:{classement['type']}",
        WORKSTREAMS[classement["workstream"]],
        f"mod:{classement['module']}",
        classement["priority"],
        f"nature:{classement['nature']}",
    ]


def project_fields(classement, milestone):
    return {
        "Sprint": sprint_code(milestone),
        "Workstream": classement["workstream"],
        "Module": classement["module"],
        "Priority": classement["priority"],
    }


def state_path(session):
    return STATE_DIR / f"{session}.json"


def read_state(session):
    path = state_path(session)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        path.unlink(missing_ok=True)
        return None


def latest_session():
    """La session du ticket ouvert le plus récent — le ticket courant, à défaut de mieux."""
    dated = []
    for path in STATE_DIR.glob("*.json") if STATE_DIR.exists() else []:
        state = read_state(path.stem)
        if state:
            dated.append((state.get("opened_at", ""), path.stem))
    return max(dated)[1] if dated else None


def block(title, content, lang=""):
    if not content.strip():
        return ""
    lines = content.strip().splitlines()
    shown = "\n".join(lines[:MAX_LINES])
    suffix = f"\n… et {len(lines) - MAX_LINES} ligne(s) de plus" if len(lines) > MAX_LINES else ""
    return f"**{title}**\n\n```{lang}\n{shown}{suffix}\n```\n\n"


def quote(text):
    return "\n".join("> " + line for line in text.splitlines())


def read_prompt(args):
    if args.prompt is not None:
        return args.prompt
    if args.prompt_file == "-":
        # Sous Windows, sys.stdin décode en cp1252 : lire les octets et décoder
        # en UTF-8, sinon les accents de la demande sont doublement encodés.
        return sys.stdin.buffer.read().decode("utf-8", "replace")
    return Path(args.prompt_file).read_text(encoding="utf-8")


# --------------------------------------------------------------------------- open

def cmd_open(args):
    prompt = read_prompt(args).strip()
    if not prompt:
        sys.exit("aucune demande à historiser (--prompt / --prompt-file vide)")

    guessed = classify_prompt(prompt)
    classement = dict(guessed)
    for key in ("module", "workstream", "type", "priority", "nature"):
        if getattr(args, key):
            classement[key] = getattr(args, key)
    auto = [k for k, v in guessed.items() if classement[k] == v]

    milestone = args.milestone or current_milestone()
    labels = labels_for(classement)

    first_line = prompt.splitlines()[0].strip()
    title = args.title or (first_line if len(first_line) <= 72
                           else first_line[:69].rstrip() + "…")

    head = run(["git", "rev-parse", "HEAD"])
    base = head.stdout.strip() if head.returncode == 0 else ""
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    now = datetime.now(timezone.utc).astimezone()

    body = (
        "## Demande\n\n" + quote(prompt) + "\n\n"
        "## Classement\n\n"
        f"- Jalon : `{milestone or 'aucun jalon résolu'}`\n"
        f"- Workstream : `{classement['workstream']}` · Module : "
        f"`{classement['module']}` · Type : `{classement['type']}` · "
        f"Priorité : `{classement['priority']}` · "
        f"Nature : `{classement['nature']}`\n"
        + ("- Déduit des mots-clés de la demande, donc faillible — corriger avec "
           "`python scripts/tracking.py classify`.\n" if auto else "")
        + "\n## Contexte\n\n"
        f"- Ouvert le {now.strftime('%d/%m/%Y à %H:%M %Z')}\n"
        f"- Branche : `{branch or 'inconnue'}`\n"
        + (f"- Commit de départ : `{base[:8]}`\n" if base else "")
        + (f"- Session Claude Code : `{args.session[:8]}`\n" if args.session else "")
        + "\n---\n\n"
        "_Ticket de traçabilité. `/ticket-close` publie le résumé des "
        "changements en commentaire, puis referme le ticket._"
    )

    if args.dry_run:
        print(json.dumps({"title": title, "labels": labels, "milestone": milestone,
                          "classement": classement, "auto": sorted(auto),
                          "body": body}, ensure_ascii=False, indent=2))
        return 0

    create = ["gh", "issue", "create", "--repo", REPO,
              "--title", title, "--body-file", "-"]
    for label in labels:
        create += ["--label", label]
    created = run(create + (["--milestone", milestone] if milestone else []),
                  input=body)
    if created.returncode != 0 and milestone:
        # Un jalon refusé ne doit pas coûter le ticket : réessayer sans lui.
        created, milestone = run(create, input=body), None
    if created.returncode != 0:
        sys.exit(f"création du ticket impossible : {created.stderr.strip()}")

    url = created.stdout.strip().splitlines()[-1] if created.stdout.strip() else ""
    number = url.rstrip("/").rsplit("/", 1)[-1]
    if not number.isdigit():
        sys.exit(f"numéro de ticket illisible dans la sortie de gh : {created.stdout!r}")

    on_board, detail = sync_project(int(number), "In progress",
                                    project_fields(classement, milestone))

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path(args.session or MANUAL_SESSION).write_text(json.dumps({
        "issue": int(number), "url": url, "base": base, "branch": branch,
        "opened_at": now.isoformat(), "title": title,
        "classement": classement, "milestone": milestone,
        "on_board": on_board,
    }, ensure_ascii=False), encoding="utf-8")

    print(json.dumps({
        "issue": int(number), "url": url, "title": title, "labels": labels,
        "milestone": milestone, "classement": classement, "auto": sorted(auto),
        "project": on_board, "project_error": "" if on_board else detail,
    }, ensure_ascii=False))
    return 0


# ----------------------------------------------------------------------- classify

def cmd_classify(args):
    """Corrige le classement d'un ticket existant — labels, jalon, carte."""
    view = run(["gh", "issue", "view", str(args.issue), "--repo", REPO,
                "--json", "labels,milestone,url"])
    if view.returncode != 0:
        sys.exit(f"issue #{args.issue} illisible : {view.stderr.strip()}")
    data = json.loads(view.stdout)
    current = [label["name"] for label in data.get("labels", [])]
    had_milestone = (data.get("milestone") or {}).get("title")
    milestone = args.milestone or had_milestone

    classement = {
        "module": args.module or next(
            (n.split(":", 1)[1] for n in current if n.startswith("mod:")), None),
        "workstream": args.workstream or next(
            (k for k, v in WORKSTREAMS.items() if v in current), None),
        "type": args.type or next(
            (n.split(":", 1)[1] for n in current if n.startswith("type:")), None),
        "priority": args.priority or next(
            (n for n in current if n in PRIORITIES), None),
        "nature": args.nature or next(
            (n.split(":", 1)[1] for n in current if n.startswith("nature:")), None),
    }
    missing = [k for k, v in classement.items() if not v]
    if missing:
        sys.exit("classement incomplet, préciser : "
                 + ", ".join(f"--{k}" for k in missing))
    if not milestone:
        milestone = current_milestone()

    wanted = labels_for(classement)
    add = [n for n in wanted if n not in current]
    stale = [n for n in current
             if (n.startswith(("type:", "mod:", "ws:", "nature:")) or n in PRIORITIES)
             and n not in wanted]

    if args.dry_run:
        print(json.dumps({"add": add, "remove": stale, "milestone": milestone,
                          "classement": classement}, ensure_ascii=False, indent=2))
        return 0

    edit = ["gh", "issue", "edit", str(args.issue), "--repo", REPO]
    for label in add:
        edit += ["--add-label", label]
    for label in stale:
        edit += ["--remove-label", label]
    if milestone and milestone != had_milestone:
        edit += ["--milestone", milestone]
    if len(edit) > 6:
        edited = run(edit)
        if edited.returncode != 0:
            sys.exit(f"édition impossible : {edited.stderr.strip()}")

    on_board, detail = sync_project(args.issue, args.status,
                                    project_fields(classement, milestone))
    print(json.dumps({
        "issue": args.issue, "url": data.get("url", ""), "added": add,
        "removed": stale, "milestone": milestone, "classement": classement,
        "project": on_board, "project_error": "" if on_board else detail,
    }, ensure_ascii=False))
    return 0


# --------------------------------------------------------------------------- note

def cmd_note(args):
    """Rattache une demande complémentaire au ticket déjà ouvert.

    Deux demandes qui relèvent du même travail ne justifient pas deux tickets :
    le second resterait ouvert, ou fermerait sur un résumé vide. La demande est
    donc publiée en commentaire sur le ticket en cours, qui les couvre toutes.
    """
    session = args.session or latest_session()
    state = read_state(session) if session else None
    if state is None:
        sys.exit("aucun ticket de traçabilité ouvert — rien à compléter")
    text = read_prompt(args).strip()
    if not text:
        sys.exit("aucune demande à rattacher (--prompt / --prompt-file vide)")
    now = datetime.now(timezone.utc).astimezone()
    body = ("## Demande complémentaire\n\n" + quote(text)
            + f"\n\n_Enchaînée dans le même tour, le "
              f"{now.strftime('%d/%m/%Y à %H:%M %Z')}._")
    posted = run(["gh", "issue", "comment", str(state["issue"]), "--repo", REPO,
                  "--body-file", "-"], input=body)
    if posted.returncode != 0:
        return 1
    print(json.dumps({"issue": state["issue"], "url": state.get("url", ""),
                      "noted": True}, ensure_ascii=False))
    return 0


# -------------------------------------------------------------------------- close

def cmd_close(args):
    session = args.session or (None if args.issue else latest_session())
    state = read_state(session) if session else None
    if state is None and not args.issue:
        sys.exit("aucun ticket de traçabilité ouvert — rien à clôturer")
    number = args.issue or state["issue"]
    base = (state or {}).get("base") or args.base or ""

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
    if args.interrupted:
        parts.append("> Ticket resté ouvert : clôturé par le balayage "
                     "`tracking.py sweep`, faute d'un `/ticket-close` en fin de "
                     "travail.\n\n")
    parts.append(f"---\n\nClôturé le {now.strftime('%d/%m/%Y à %H:%M %Z')} · "
                 f"branche `{branch or 'inconnue'}`")
    comment = "".join(parts)

    if args.dry_run:
        print(comment)
        return 0

    commented = run(["gh", "issue", "comment", str(number), "--repo", REPO,
                     "--body-file", "-"], input=comment)
    if commented.returncode == 0:
        run(["gh", "issue", "close", str(number), "--repo", REPO,
             "--reason", "completed"])
        sync_project(number, "Done", {})

    if session:
        state_path(session).unlink(missing_ok=True)
    if not getattr(args, "quiet", False):
        print(json.dumps({"issue": number, "closed": commented.returncode == 0},
                         ensure_ascii=False))
    return 0


# ------------------------------------------------------------------ sweep, status

def cmd_sweep(args):
    """Referme les tickets qu'un travail terminé sans `/ticket-close` a laissés ouverts.

    Filet de rattrapage, à passer à la main : un ticket oublié reste ouvert
    indéfiniment et fausse le suivi du sprint. Le seuil d'âge épargne les tickets
    d'un travail encore en cours, ici ou dans une session parallèle.
    """
    swept = []
    for path in sorted(STATE_DIR.glob("*.json")) if STATE_DIR.exists() else []:
        session = path.stem
        if session == args.session:
            continue
        state = read_state(session)
        if state is None:
            continue
        try:
            age = (datetime.now(timezone.utc)
                   - datetime.fromisoformat(state["opened_at"])).total_seconds() / 3600
        except Exception:
            age = SWEEP_HOURS + 1
        if age < args.older_than:
            continue
        if args.dry_run:
            swept.append(state["issue"])
            continue
        cmd_close(argparse.Namespace(
            session=session, issue=None, base=None, interrupted=True,
            dry_run=False, quiet=True))
        swept.append(state["issue"])
    # Appelé à la main, ce balayage rend toujours compte — y compris de n'avoir
    # rien eu à fermer, qui est la réponse attendue à « reste-t-il des oublis ? ».
    numbers = ", ".join(f"#{number}" for number in swept)
    print(f"Tickets de traçabilité clôturés : {numbers}" if swept
          else "Aucun ticket de traçabilité en souffrance.")
    return 0


def cmd_status(args):
    """L'état du ticket ouvert le plus récent — ce que /ticket-new interroge."""
    session = latest_session()
    state = read_state(session) if session else None
    print(json.dumps(dict(state, session=session) if state else {},
                     ensure_ascii=False, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_classement(target):
        target.add_argument("--module", choices=MODULES)
        target.add_argument("--workstream", choices=list(WORKSTREAMS))
        target.add_argument("--type", choices=TYPES)
        target.add_argument("--priority", choices=PRIORITIES)
        target.add_argument("--nature", choices=NATURES,
                            help="produit MVP (projet) ou dispositif de "
                                 "collaboration (outillage) — ce second n'est "
                                 "jamais dispatché par un run de jalon")
        target.add_argument("--milestone", metavar="TITRE",
                            help="titre du jalon, ex. « S1 — Fondations »")
        target.add_argument("--dry-run", action="store_true")

    opener = sub.add_parser("open", help="ouvre un ticket de traçabilité qualifié")
    opener.add_argument("--session", help="isole l'état du ticket, pour les runs parallèles")
    opener.add_argument("--prompt")
    opener.add_argument("--prompt-file", default="-")
    opener.add_argument("--title")
    add_classement(opener)
    opener.set_defaults(func=cmd_open)

    fixer = sub.add_parser("classify", help="corrige le classement d'un ticket existant")
    fixer.add_argument("issue", type=int)
    fixer.add_argument("--status", default="In progress")
    add_classement(fixer)
    fixer.set_defaults(func=cmd_classify)

    noter = sub.add_parser("note", help="rattache une demande complémentaire au ticket ouvert")
    noter.add_argument("--session", help="défaut : le ticket ouvert le plus récent")
    noter.add_argument("--prompt")
    noter.add_argument("--prompt-file", default="-")
    noter.set_defaults(func=cmd_note)

    closer = sub.add_parser("close", help="publie le résumé des changements et clôture")
    closer.add_argument("--session", help="défaut : le ticket ouvert le plus récent")
    closer.add_argument("--issue", type=int)
    closer.add_argument("--base", help="commit de départ si l'état de session est perdu")
    closer.add_argument("--interrupted", action="store_true")
    closer.add_argument("--dry-run", action="store_true")
    closer.set_defaults(func=cmd_close)

    sweeper = sub.add_parser("sweep", help="referme les tickets restés ouverts")
    sweeper.add_argument("--session", help="ticket à épargner du balayage")
    sweeper.add_argument("--older-than", type=float, default=SWEEP_HOURS,
                         metavar="HEURES")
    sweeper.add_argument("--dry-run", action="store_true")
    sweeper.set_defaults(func=cmd_sweep)

    viewer = sub.add_parser("status", help="état du ticket ouvert le plus récent")
    viewer.set_defaults(func=cmd_status)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
