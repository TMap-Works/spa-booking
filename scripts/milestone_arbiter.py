#!/usr/bin/env python3
"""Ce que l'arbitre du run lit, et les bornes qu'il ne dépasse pas.

    python scripts/milestone_arbiter.py diagnose --json   # le dossier d'arbitrage
    python scripts/milestone_arbiter.py should            # y a-t-il matière ?
    python scripts/milestone_arbiter.py escalation 42     # quel cran pour #42
    python scripts/milestone_arbiter.py record …          # ce qui a été décidé
    python scripts/milestone_arbiter.py state             # ce qui a déjà été arbitré

## Pourquoi ce fichier existe

`milestone_supervise.py` sait relancer un jalon après une coupure de quota, un
plantage ou un redémarrage. Ce qu'il n'a jamais su faire, c'est **décider**. Au
premier ticket tombé, à la première PR verte laissée ouverte, à la première
étape coupée au temps, il rendait la main et attendait quelqu'un. Un jalon lancé
le soir s'arrêtait donc sur la première question posée, et la nuit était perdue.

L'arbitre est la réponse : un appel `claude -p --model claude-opus-5` lancé aux
points d'arrêt du run, qui tranche à la place de l'humain en se fondant sur le
CDC, les ADR et les skills du dépôt. Son jugement vit dans
[.claude/commands/milestone-arbitrate.md](../.claude/commands/milestone-arbitrate.md).

**Ce fichier-ci ne juge rien.** Il fait trois choses, volontairement mécaniques.

**Il constitue le dossier.** `diagnose` rassemble en une commande tout ce qu'il
faut pour juger — verdict du `gate`, état de chaque ticket, cause exacte de ceux
qui sont tombés, queue de leur log, résumé de la dernière étape, PR du jalon avec
le verdict de la barrière, état de `develop`, worktrees vivants. Sans lui,
l'arbitre passerait ses premiers tours à chercher où regarder ; un tour d'Opus 5
coûte trop cher pour être dépensé en fouille.

**Il dit s'il y a matière.** `should` ne rend 0 que si un motif est constitué —
et, depuis #262, seulement si le dossier a bougé depuis la dernière décision.
Une étape saine n'en déclenche aucun ; un dossier déjà jugé n'en rouvre pas :
l'arbitrage est un recours, pas une routine, et chaque appel se paie. Une pause
posée par un humain n'est pas davantage un motif — l'arbitre n'a pas le droit de
la lever, et l'ouvrir revenait à payer un tour d'Opus 5 pour s'entendre dire
qu'il n'y avait rien à faire, douze fois de suite.

**Il tient les bornes.** Un arbitre sans limite retenterait le même ticket
jusqu'à épuisement du quota. `escalation` donne le cran à appliquer — relancer,
corriger, écarter — et le budget d'un run comme celui d'un ticket est compté. Le
dernier cran n'est **jamais** l'arrêt du jalon : c'est l'écartement du ticket
avec une issue de suivi, parce qu'un ticket pourri ne doit pas figer les vingt
autres. Le cran se décide sur l'antériorité **de la cause**, pas sur celle du
run : une cause déterministe déjà conclue ailleurs ne repart pas de « on
relance » sous prétexte que le run est neuf (#359), ni sous prétexte que c'est
un autre ticket qu'elle frappe cette fois-ci (#366) — un voisin pesant alors un
cran là où une récidive en pèse deux.

## Ce qu'il ne fait pas

Il ne parle pas à Claude, il ne merge rien, il ne corrige aucun code. Tout ce
qui demande un jugement appartient à la commande d'arbitrage ; tout ce qui
demande une action sur le dépôt appartient à `pr_gate.py`, `milestone_run.py` et
à l'arbitre lui-même. Ce fichier est la mémoire et le compteur, rien de plus —
c'est ce qui permet de le tester sans réseau et sans modèle.
"""
import argparse
import calendar
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

# `scripts/` est un dossier d'exécutables, pas un paquet : on l'ajoute au chemin
# plutôt que d'y semer des `__init__.py`. Même geste que dans les tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import milestone_run as run_mod            # noqa: E402 — l'insertion le précède

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts" / "milestone_run.py"
BARRIER = ROOT / "scripts" / "pr_gate.py"
# Le dossier des legs est écrit par le superviseur ; on n'y touche qu'en lecture.
LEGS_DIR = run_mod.RUNS_DIR / "legs"
# Le nom du NDJSON des décisions — défini une fois, dans le module qui le lit
# aussi pour `status`.
ARBITRATIONS = run_mod.ARBITRATIONS

REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")

# Les trois crans, dans l'ordre où on les monte. Aucun ne s'appelle « arrêter » :
# arrêter le jalon n'est pas une décision d'arbitrage mais un aveu d'échec du
# dispositif, et il appartient au superviseur quand plus rien n'avance du tout.
LADDER = ["retry", "fix", "skip"]
RUNGS = {
    "retry": "remettre le ticket en file — l'agent suivant reprend son worktree",
    "fix": "intervenir soi-même sur la branche, puis rappeler la barrière",
    "skip": "écarter le ticket, ouvrir une issue de suivi, poursuivre le jalon",
}

# Deux arbitrages par ticket : le premier relance, le second corrige. Au
# troisième, une quatrième tentative n'apprendrait rien de plus — on écarte et on
# avance. Douze pour le run entier : au-delà, ce n'est plus un ticket qui résiste,
# c'est le jalon qui ne tient pas, et c'est un humain qu'il faut.
PER_TICKET = 2
PER_RUN = 12

# Le voisinage : la même cause, déjà conclue sur **d'autres** tickets que celui
# qu'on arbitre. Deux réglages, et ils disent tous les deux la même prudence.
#
# `KIN_TICKETS` — combien d'autres tickets il faut pour que la concordance
# compte. Un seul suffit, et c'est la mesure qui le permet : sur les six runs
# déjà déroulés, 30 arbitrages inscrits, 19 portent une signature, et ces 19
# signatures sont **toutes distinctes**. Aucune ne se répète, même sur un seul
# ticket. Une empreinte partagée n'est donc pas un hasard statistique qu'il
# faudrait confirmer par un second témoin : c'est un événement qui ne s'est
# jamais produit, et qui ne se produira que sur une cause franchement identique.
#
# `KIN_RUNG` — jusqu'où le voisinage a le droit de porter, et c'est là qu'est la
# vraie borne. Il **décolle** du `retry`, il ne va pas au-delà : le cran maximal
# étant l'écartement, une fausse concordance coûterait sinon un ticket sain
# écarté sur la foi de la panne d'un voisin. Plafonné ici, elle coûte une
# tentative de correction — un geste qu'on aurait de toute façon posé au tour
# suivant. C'est ce que demande #366 : un cran, pas deux.
KIN_TICKETS = 1
KIN_RUNG = "fix"

# Un motif est ce qui justifie de dépenser un tour d'Opus 5. Ceux que le run porte
# lui-même se lisent dans le dossier ; ceux que seul le superviseur connaît — il a
# vu l'étape mourir — lui sont passés par `--reason`.
MOTIFS = {
    # Une pause posée par un humain n'entre pas ici : elle rend le même code de
    # sortie, mais l'arbitre n'a pas le droit de la lever, et l'ouvrir comme
    # motif ne faisait que boucler (#262).
    "gate_pause": "le gate retient le run sans main humaine (pause sur erreur, "
                  "ou pause posée par le dispositif)",
    "tickets_tombes": "un ou plusieurs tickets sont failed/blocked",
    "pr_en_souffrance": "une PR est ouverte sur un ticket qui n'avance plus",
    "leg_delai": "l'étape a été coupée au temps sans rendre la main",
    # Les deux moitiés, et pas seulement le commit : depuis #278 le détecteur ne
    # lève ce motif que si l'étape n'a rendu ni l'un ni l'autre. Une étape qui
    # mène un ticket jusqu'au merge ne laisse aucune branche derrière elle, et la
    # dire « sans commit » briefait l'arbitre à chercher ce qui n'a jamais manqué.
    "leg_sterile": "l'étape s'est terminée sans rien rendre durable — ni commit "
                   "sur une branche de ticket, ni merge imputé au run",
    "patience": "plusieurs étapes de suite sans un ticket de plus",
    "verify_rouge": "npm run verify est rouge sur develop",
    "fin_de_run": "le jalon est déroulé — passe d'anomalies",
}
# Ceux-là ne se déduisent d'aucun fichier : ils ne valent que dits.
SUPERVISOR_MOTIFS = {"leg_delai", "leg_sterile", "patience", "verify_rouge"}

# Au-delà, une PR ouverte sur un ticket qui ne bouge plus n'attend plus la CI :
# elle attend quelqu'un. Un cycle complet de nos workflows tient en un quart
# d'heure ; le double laisse de la marge sans laisser dormir une PR verte.
PR_STALE = 30 * 60

# Ce qui, dans un `blocked` de run, désigne une barrière rouge sur `develop` —
# par opposition aux `blocked` que le superviseur pose pour son propre
# enlisement. La phase 4 de `/milestone` impose la formule.
#
# L'assertion, jamais le mot seul. `verify` en alternative isolée levait le motif
# sur cette ligne-ci, journalisée le 25/08 sur le run S1 :
#
#     « vague 1 close : #19 et #14 mergees, develop vert (npm run verify exit 0) »
#
# — c'est-à-dire un arbitrage Opus 5 dépensé pour annoncer que tout va bien, et
# redépensé à chaque étape puisque rien dans le journal ne cesse d'être vrai.
BROKEN_RE = re.compile(
    r"verify\s+rouge|develop\s+rouge|build\s+rouge|tests?\s+rouges?"
    r"|rouge\s+(?:sur\s+)?develop", re.I)


# --------------------------------------------------------------------------- #
# Outils
# --------------------------------------------------------------------------- #

def shell(argv, timeout=180):
    """Un appel externe qui ne peut pas faire tomber le dossier.

    Tout ce qu'on interroge ici — git, gh, la barrière — peut être lent, absent
    ou fâché. Un dossier partiel reste utile à l'arbitre ; une exception le
    priverait de tout, y compris de ce qui avait déjà été lu.
    """
    try:
        proc = subprocess.run(argv, cwd=str(ROOT), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, "", f"{type(exc).__name__} : {exc}"
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def signature(text):
    """Une empreinte stable d'une cause d'échec.

    Deux blocages sont « le même » quand ils ne diffèrent que par un numéro de
    ligne, un chemin ou un horodatage. C'est cette égalité-là qui doit faire
    monter d'un cran : réessayer à l'identique une panne déjà rencontrée est le
    seul comportement qu'un arbitre ne doit jamais avoir.
    """
    core = (text or "").lower()
    core = re.sub(r"[a-z]:[\\/][^\s\"']+", "<chemin>", core)
    core = re.sub(r"[\w.+-]*/[\w.+-]+", "<chemin>", core)
    core = re.sub(r"\d+", "#", core)
    core = re.sub(r"\s+", " ", core).strip()
    return hashlib.sha1(core[:240].encode("utf-8")).hexdigest()[:12]


def tail_lines(path, count):
    if count <= 0 or not path.exists():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-count:]
    except OSError:
        return []


# --------------------------------------------------------------------------- #
# Le dossier
# --------------------------------------------------------------------------- #

def gate_verdict():
    """Le verdict du gate, code et lignes — ce que l'orchestrateur verrait."""
    code, stdout, stderr = shell([sys.executable, str(RUNNER), "gate"])
    lines = [line for line in (stdout + stderr).splitlines() if line.strip()]
    return {"code": code, "lignes": lines,
            "sens": {run_mod.GO: "continuer", run_mod.PAUSE: "pause demandée",
                     run_mod.STOP: "arrêt demandé", run_mod.NO_RUN: "plus rien à faire",
                     run_mod.QUOTA: "quota épuisé"}.get(code, "inconnu")}


def latest_leg():
    """Le dernier flux `stream-json` d'étape écrit par le superviseur."""
    if not LEGS_DIR.exists():
        return None
    files = sorted((p for p in LEGS_DIR.glob("leg-*.ndjson") if p.is_file()),
                   key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def leg_digest(path, errors=6):
    """Ce que la dernière étape a dit d'elle-même.

    Le flux d'une étape pèse plusieurs mégaoctets : le donner tel quel à
    l'arbitre reviendrait à lui faire lire un transcript entier pour y trouver
    trois lignes. On en extrait ce qui explique une étape ratée — les erreurs
    d'outil, les refus de permission, la raison de fin et le coût.
    """
    if path is None or not path.exists():
        return None
    digest = {"fichier": str(path), "tours": None, "cout": None, "fin": None,
              "erreurs": [], "permissions": [], "dernier_mot": None}
    seen = set()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = message.get("type")
                if kind == "result":
                    digest["fin"] = message.get("subtype")
                    digest["tours"] = message.get("num_turns")
                    digest["cout"] = message.get("total_cost_usd")
                    text = str(message.get("result") or "").strip()
                    if text:
                        digest["dernier_mot"] = text[:600]
                elif kind == "assistant":
                    for block in (message.get("message") or {}).get("content") or []:
                        text = (block.get("text") or "").strip()
                        if text:
                            digest["dernier_mot"] = text[:600]
                elif kind == "user":
                    for block in (message.get("message") or {}).get("content") or []:
                        if not block.get("is_error"):
                            continue
                        content = block.get("content")
                        if isinstance(content, list):
                            content = " ".join(part.get("text", "")
                                               for part in content
                                               if isinstance(part, dict))
                        text = str(content or "").strip()[:400]
                        if not text:
                            continue
                        key = signature(text)
                        # Une même erreur répétée trente fois — c'est le cas
                        # courant d'une boucle de correction — n'apprend rien de
                        # plus la trentième fois, et noierait les autres.
                        if key in seen:
                            continue
                        seen.add(key)
                        bucket = ("permissions"
                                  if re.search(r"permission|approval|refus",
                                               text, re.I)
                                  else "erreurs")
                        if len(digest[bucket]) < errors:
                            digest[bucket].append(text)
    except OSError as exc:
        digest["erreurs"].append(f"lecture impossible : {exc}")
    return digest


def milestone_prs(numbers):
    """Les PR ouvertes qui referment un ticket du run, avec l'état de leur CI."""
    code, stdout, _ = shell([
        "gh", "pr", "list", "--repo", REPO, "--state", "open", "--limit", "60",
        "--json", "number,title,headRefName,isDraft,mergeable,body,labels,"
                  "updatedAt,statusCheckRollup"])
    if code != 0:
        return []
    try:
        rows = json.loads(stdout or "[]")
    except json.JSONDecodeError:
        return []

    wanted = set(numbers)
    found = []
    for row in rows:
        issues = {int(m) for m in run_mod.CLOSES_RE.findall(row.get("body") or "")}
        branch = run_mod.BRANCH_RE.match(row.get("headRefName") or "")
        if branch:
            issues.add(int(branch.group(1)))
        touched = sorted(issues & wanted)
        if not touched:
            continue
        checks = row.get("statusCheckRollup") or []
        verdicts = [c.get("conclusion") or c.get("state") or "" for c in checks]
        found.append({
            "pr": row.get("number"), "titre": row.get("title"),
            "branche": row.get("headRefName"), "tickets": touched,
            "brouillon": row.get("isDraft"), "mergeable": row.get("mergeable"),
            "labels": [label.get("name") for label in row.get("labels") or []],
            "maj": row.get("updatedAt"),
            "checks": {"total": len(checks),
                       "verts": sum(1 for v in verdicts
                                    if v in ("SUCCESS", "SKIPPED", "NEUTRAL")),
                       "rouges": sorted({c.get("name") or c.get("context") or "?"
                                         for c in checks
                                         if (c.get("conclusion") or c.get("state"))
                                         not in ("SUCCESS", "SKIPPED", "NEUTRAL")})},
        })
    return found


def barrier_verdict(pr):
    """Le verdict de `pr_gate.py`, sans attendre la CI — 0 vert, 5 sensible…

    C'est la seule autorité sur « cette PR peut-elle être mergée ». La recopier
    ici, même approximativement, ferait dire à l'arbitre autre chose que ce que
    la barrière refusera de toute façon.
    """
    code, stdout, stderr = shell(
        [sys.executable, str(BARRIER), str(pr), "--no-wait", "--quiet"], timeout=180)
    lines = [line for line in (stdout + stderr).splitlines() if line.strip()]
    return {"code": code, "verdict": lines[-1][:300] if lines else None,
            "sens": {0: "vert", 1: "en attente", 2: "check en échec",
                     3: "inapte au merge", 4: "erreur d'appel",
                     5: "périmètre sensible non pré-autorisé"}.get(code, "inconnu")}


def develop_state():
    """Où en est `develop` dans le dépôt principal, et s'il est propre."""
    root = str(run_mod.STATE_ROOT)
    _, head, _ = shell(["git", "-C", root, "log", "--oneline", "-1", "origin/develop"])
    _, local, _ = shell(["git", "-C", root, "log", "--oneline", "-1", "develop"])
    _, dirty, _ = shell(["git", "-C", root, "status", "--porcelain"])
    return {"origin": head.strip()[:120] or None, "local": local.strip()[:120] or None,
            "propre": not dirty.strip(),
            "non_commite": [line for line in dirty.splitlines()[:20] if line.strip()]}


def broken_develop(events, history):
    """Le dernier constat de `develop` cassé, s'il n'a pas déjà été arbitré.

    L'orchestrateur le journalise au niveau du run — sans ticket, `status`
    `blocked` — quand `npm run verify` est rouge après une vague verte (phase 4
    de `/milestone`). Le rapprocher du dernier arbitrage est ce qui évite qu'un
    constat traité une fois relance un arbitrage à chaque étape jusqu'à
    épuisement du budget : un journal est en ajout seul, la ligne y reste pour
    toujours.
    """
    last = None
    for event in events:
        if event.get("ticket") is not None or event.get("status") != "blocked":
            continue
        # Le superviseur journalise lui aussi des `blocked` de run — legs
        # stériles, patience épuisée. Ce ne sont pas des `develop` cassés, et
        # les confondre ferait arbitrer une panne pour une autre. On ne retient
        # que ce qui nomme la barrière.
        if not BROKEN_RE.search(event.get("message") or ""):
            continue
        last = event
    if last is None:
        return None
    treated = max((row.get("ts") or "" for row in history
                   if row.get("motif") == "verify_rouge"), default="")
    if treated and treated >= (last.get("ts") or ""):
        return None
    return {"ts": last.get("ts"), "message": last.get("message")}


def dossier(run_id, reasons=(), tail=12, with_barrier=True, per_ticket=PER_TICKET,
            per_run=PER_RUN):
    """Tout ce qu'il faut pour juger, en une structure."""
    run = run_mod.load_run(run_id)
    control = run_mod.load_control(run_id)
    events = run_mod.read_journal(run_id)
    tickets = run_mod.replay(run, events, control)
    current, waves = run_mod.wave_state(run, tickets)

    rows = []
    for number in sorted(tickets):
        ticket = dict(tickets[number])
        ticket["log"] = tail_lines(run_mod.ticket_log_path(run_id, number), tail)
        ticket["signature"] = signature(ticket.get("note")) if ticket.get("note") else None
        rows.append(ticket)

    tombes = [t["number"] for t in rows if t["status"] in run_mod.BAD]
    prs = milestone_prs(list(tickets))
    if with_barrier:
        for row in prs:
            row["barriere"] = barrier_verdict(row["pr"])

    history = arbitrations(run_id)
    payload = {
        "run": {"id": run_id, "jalon": run.get("milestone"),
                "ouvert": run.get("created"), "largeur": run.get("width"),
                "no_merge": run.get("no_merge"),
                "merge_sensitive": run.get("merge_sensitive")},
        "gate": gate_verdict(),
        "signal": control.get("signal", "run"),
        "signal_acteur": control.get("signal_actor"),
        # Ce que le code de sortie du gate ne dit pas : une pause posée par un
        # humain et une pause sur erreur y rendent le même `PAUSE`, et l'arbitre
        # n'a le droit d'en lever qu'une des deux (#262).
        "pause_humaine": run_mod.human_pause(control),
        "pause_sur_erreur": bool(control.get("pause_on_error")),
        "ecartes": control.get("skip") or {},
        "a_relancer": control.get("retry") or [],
        "quota": run_mod.quota_hold(run_id),
        "vague": ({"index": current["index"], "tickets": current["numbers"]}
                  if current else None),
        "vagues": [{"index": w["index"], "achevee": w["done"],
                    "propre": w["clean"]} for w in waves],
        "tickets": rows,
        "tombes": tombes,
        "prs": prs,
        "develop": develop_state(),
        "develop_rouge": broken_develop(events, history),
        "worktrees": run_mod.live_worktrees(),
        "etape": leg_digest(latest_leg()),
        "arbitrages": summary(history, per_ticket=per_ticket, per_run=per_run),
    }
    payload["motifs"] = motifs(payload, reasons)
    return payload


# --------------------------------------------------------------------------- #
# Les motifs
# --------------------------------------------------------------------------- #

def motifs(payload, reasons=()):
    """Ce qui justifie un arbitrage, maintenant.

    Les motifs venus du superviseur sont retenus tels quels : lui seul a vu
    l'étape mourir, et rien dans les fichiers n'en garde trace exploitable.
    """
    found = [name for name in reasons if name in MOTIFS]

    code = (payload.get("gate") or {}).get("code")
    # Une pause posée à la main n'est pas un motif : la doctrine de l'arbitre lui
    # interdit de la lever (« c'est une décision qui n'est pas la tienne »), si
    # bien qu'il rendait la main sans rien changer — et se faisait rappeler
    # trente secondes plus tard sur le même dossier, jusqu'à consumer les douze
    # arbitrages du run (#262). Le retrait vaut aussi pour le motif **passé par
    # le superviseur** : c'est lui qui appelle `rescue(["gate_pause"])` sur le
    # seul code de sortie du gate, sans plus de discernement que l'arbitre n'en
    # avait ici.
    if payload.get("pause_humaine"):
        found = [name for name in found if name != "gate_pause"]
    elif code == run_mod.PAUSE and "gate_pause" not in found:
        found.append("gate_pause")
    if code == run_mod.NO_RUN and "fin_de_run" not in found:
        found.append("fin_de_run")
    if payload.get("tombes") and "tickets_tombes" not in found:
        found.append("tickets_tombes")
    # `develop` cassé après une vague verte, c'est-à-dire une interaction entre
    # deux tickets que le plan croyait indépendants. Personne ne peut le déduire
    # d'un fichier : c'est l'orchestrateur qui le constate, en phase 4 de
    # `/milestone`, et qui le journalise au niveau du run. Le lire ici est ce qui
    # transforme ce constat en arbitrage — sans quoi le motif resterait déclaré
    # et jamais levé, et un `develop` rouge dormirait jusqu'au matin.
    if payload.get("develop_rouge") and "verify_rouge" not in found:
        found.append("verify_rouge")

    stale = time.time() - PR_STALE
    for row in payload.get("prs") or []:
        verdict = (row.get("barriere") or {}).get("code")
        updated = row.get("maj")
        old = True
        if updated:
            try:
                # `updatedAt` de GitHub est en UTC. `time.mktime` lirait le
                # `struct_time` comme une heure **locale** : sur un poste à
                # UTC+2, une PR poussée il y a une minute paraîtrait vieille de
                # deux heures — et à UTC-5, une PR abandonnée depuis la veille
                # paraîtrait toujours fraîche. `timegm` est le pendant UTC.
                old = calendar.timegm(
                    time.strptime(updated[:19], "%Y-%m-%dT%H:%M:%S")) < stale
            except (ValueError, OverflowError):
                old = True
        if verdict is None:
            # `should` ne paie pas la barrière — un appel réseau par PR à chaque
            # étape, y compris quand la réponse est « rien à faire ». Sans ce
            # repli, le motif ne se lèverait donc **que** dans `diagnose`,
            # c'est-à-dire une fois l'arbitre déjà appelé pour autre chose : la
            # PR verte laissée ouverte, le cas même que l'arbitrage existe pour
            # lever, dormirait jusqu'au matin. On se rabat sur ce que la liste
            # des PR donne déjà — des checks présents, pas de brouillon, et plus
            # rien qui bouge depuis une demi-heure.
            checks = row.get("checks") or {}
            attention = ((checks.get("total") or 0) > 0
                         and not row.get("brouillon") and old)
        else:
            # Une PR verte non mergée, ou refusée pour périmètre sensible,
            # n'attend plus rien de mécanique.
            attention = verdict in (0, 3, 5) or (verdict == 2 and old)
        if attention:
            if "pr_en_souffrance" not in found:
                found.append("pr_en_souffrance")
            break

    return found


# --------------------------------------------------------------------------- #
# Les bornes
# --------------------------------------------------------------------------- #

def arbitrations(run_id):
    """L'historique des arbitrages de ce run, du plus ancien au plus récent.

    La lecture vit dans `milestone_run.py`, qui l'affiche aussi dans `status` et
    le tableau de bord : deux analyseurs pour un même fichier finiraient par ne
    plus sauter les mêmes lignes abîmées, et le compteur du budget ne dirait plus
    la même chose que celui de l'écran.
    """
    return run_mod.read_arbitrations(run_id)


def all_arbitrations():
    """Toutes les décisions inscrites, tous runs confondus, chacune datée de son run.

    Un seul parcours du disque pour les deux lectures qui suivent : `escalation`
    interroge l'antériorité du ticket *et* celle de la cause, et relire les mêmes
    NDJSON deux fois pour les filtrer différemment ne dirait rien de plus.
    """
    rows = []
    for directory in run_mod.run_dirs():
        for row in run_mod.read_arbitrations(directory.name):
            rows.append(dict(row, run=directory.name))
    rows.sort(key=lambda row: row.get("ts") or "")
    return rows


def prior_arbitrations(run_id, ticket=None, rows=None):
    """Ce que les **autres** runs ont déjà arbitré — l'antériorité d'un ticket.

    Un numéro d'issue est stable là où un run ne l'est pas : le même ticket
    traverse les runs, et sa cause d'échec avec lui. Borner l'escalade au run
    courant faisait donc repartir de « jamais arbitré » un ticket dont la panne
    avait déjà conclu quatre fois ailleurs — c'est #359, mesuré sur #226 : cran
    rendu `retry`, étape suivante stérile à 24 tours et 3 $, cause inchangée.

    Ce n'est pas un second compteur de budget : le budget reste celui du run, qui
    seul dit ce que *cette* nuit a le droit de dépenser. C'est une mémoire de
    cause, et elle ne sert qu'à `next_rung` et à ce que `escalation` donne à lire.

    On lit tous les runs sauf celui-ci, jamais le seul jalon courant : #226 a été
    arbitré sur des runs S1 **et** S2, et se restreindre au jalon aurait manqué
    précisément le cas qui a motivé le correctif.
    """
    rows = all_arbitrations() if rows is None else rows
    return [row for row in rows
            if row.get("run") != run_id
            and (ticket is None or row.get("ticket") == ticket)]


def kin_arbitrations(ticket, sign, rows=None):
    """Ce que la même cause a déjà **conclu sur d'autres tickets** — le voisinage.

    L'antériorité de `prior_arbitrations` est celle d'un numéro d'issue ; celle-ci
    est celle d'une panne. Une cause structurelle ne frappe pas un ticket, elle
    frappe tous ceux qui passent au même endroit : un classifieur qui refuse la
    même écriture, une dépendance absente de l'image, un service éteint. Bornée
    au ticket, l'escalade rendait donc `retry` à un ticket neuf sur une panne
    conclue six fois — première occurrence pour lui, septième pour le dispositif
    (#366).

    Trois restrictions, et chacune retire un faux rapprochement :

    - **le run courant compte**, contrairement à `prior_arbitrations`. Une cause
      structurelle frappe volontiers deux tickets de la même vague, et l'exclure
      aurait manqué le cas le plus fréquent au profit du plus rare ;
    - **un autre ticket que celui-ci**, sans quoi le voisinage compterait sa
      propre récidive une seconde fois et lui ferait sauter deux crans ;
    - **une décision, pas une écriture** : seules les lignes qui portent un cran
      de l'échelle. `record` en inscrit aussi qui n'en portent pas — la tenue de
      compte d'un motif traité ailleurs —, et l'issue demande une cause « déjà
      **conclue** », pas simplement rencontrée.

    Sans empreinte, pas de voisinage : une cause qu'on ne sait pas nommer ne
    prouve aucune concordance, et un `None` rapproché d'un autre `None` les
    rapprocherait tous.
    """
    if not sign:
        return []
    rows = all_arbitrations() if rows is None else rows
    return [row for row in rows
            if row.get("signature") == sign
            and row.get("ticket") is not None
            and row.get("ticket") != ticket
            and row.get("rung") in LADDER]


def elsewhere(prior, sign=None):
    """L'antériorité hors run, résumée — ce que `escalation` expose.

    Sans elle, l'arbitre découvrait l'antériorité en lisant les commentaires de
    l'issue, quand il y pensait. La donner à côté du cran est ce qui lui permet
    de juger sur pièces : combien de fois ailleurs, combien sur la même cause,
    et où cela s'était arrêté.

    « Où cela s'était arrêté », c'est la dernière décision qui **porte un cran** —
    pas la dernière ligne. Toutes n'en portent pas : `record` inscrit aussi la
    tenue de compte d'un motif traité ailleurs (`rung: null`), et sur #226 c'est
    précisément elle qui ferme le fichier, douze secondes après l'écartement.
    Prendre la dernière ligne telle quelle rendait donc `dernier_cran: null` sur
    un ticket qui venait d'être `skip` — l'arbitre lisait « jamais tranché » là où
    on avait tranché le plus fort.
    """
    same = [row for row in prior if sign and row.get("signature") == sign]
    decided = [row for row in prior if row.get("rung") in LADDER]
    last = decided[-1] if decided else {}
    return {
        "arbitrages": len(prior),
        "meme_cause": len(same),
        "dernier_cran": last.get("rung"),
        "dernier": last.get("ts"),
        "runs": sorted({row.get("run") for row in prior if row.get("run")}),
    }


def kinship(kin, kin_tickets=KIN_TICKETS):
    """Le voisinage, résumé — l'antériorité de la **cause**, à côté de celle du ticket.

    `escalation` expose les deux séparément parce qu'elles ne se valent pas et
    n'appellent pas la même conduite. « Ce ticket-ci a déjà échoué là-dessus »
    est une récidive et se paie deux crans ; « la même panne a été conclue sur
    #117 et #208 » est un renseignement, et ne se paie qu'un cran. Les fondre en
    un seul compteur ferait perdre à l'arbitre précisément ce qui distingue les
    deux cas — et c'est sur cette distinction que le troisième critère de #366
    porte.

    `retenu` dit si la concordance atteint le seuil et pèse donc sur le cran :
    l'arbitre a besoin de savoir qu'un voisinage existe *sans* compter, quand il
    reste sous le seuil, pour ne pas croire que le cran l'ignore par erreur.
    """
    tickets = sorted({row["ticket"] for row in kin if row.get("ticket") is not None})
    last = kin[-1] if kin else {}
    return {
        "tickets": tickets,
        "arbitrages": len(kin),
        "dernier_cran": last.get("rung"),
        "dernier": last.get("ts"),
        "runs": sorted({row.get("run") for row in kin if row.get("run")}),
        "seuil": kin_tickets,
        "retenu": bool(tickets) and len(tickets) >= kin_tickets,
        # Ce que le voisinage peut faire au plus, dit ici plutôt que déduit :
        # décoller du `retry`, jamais écarter.
        "plafond": KIN_RUNG,
    }


def movement(events):
    """Les événements du journal qui attestent qu'il s'est passé quelque chose.

    Deux écritures n'en sont pas, et les retirer est ce qui rend le filet
    ci-dessous opérant plutôt que décoratif :

    - **le battement du superviseur** (`beat`) — il prouve une présence, pas un
      travail. `milestone_supervise.journal_activity` l'écarte déjà pour la même
      raison ;
    - **sa tenue de compte d'arbitrage** (`status == "arbitrage"`) : « arbitrage
      N ouvert » puis « arbitrage N rendu », cette dernière écrite **après** que
      l'arbitre a inscrit sa décision. Comptée comme un mouvement, elle prouvait
      au tour suivant que le dossier avait bougé — alors qu'elle ne dit rien
      d'autre que « on vient de faire arbitrer ce dossier-là ». Le filet ne se
      serait jamais déclenché dans la boucle réelle (#262).
    """
    return [event for event in events
            if not event.get("beat") and event.get("status") != "arbitrage"]


def already_arbitrated(found, history, events):
    """Vrai si ces motifs ont déjà été instruits sur ce dossier-là, tel quel.

    Filet indépendant du discernement des motifs, et c'est sa raison d'être : il
    couvre tout motif susceptible de se représenter à l'identique, pas seulement
    celui qu'on a vu boucler (#262). Un arbitre rappelé sur un dossier qu'il
    vient de juger rendra la même décision — au prix d'un tour d'Opus 5 —, et
    recommencera jusqu'à ce que le budget du run soit vide. Le vrai coût n'est
    pas l'argent : c'est le motif suivant, réel celui-là, qui ne trouvera plus de
    quoi être arbitré.

    Deux conditions, et les deux :

    - **rien n'est entré au journal depuis la dernière décision.** Le journal du
      run est ce qui bouge quand quelque chose se passe — un agent qui avance,
      une étape qui se termine, un humain qui tranche. Ce qu'on ne compte pas,
      c'est l'arbitrage s'écrivant lui-même : la trace que `record` y laisse,
      reconnaissable à son horodatage — le même que celui de la décision, au
      caractère près, puisque `record` n'appelle `now()` qu'une fois pour les
      deux fichiers —, et la tenue de compte du superviseur autour de l'appel,
      que `movement()` écarte ;
    - **les motifs levés maintenant ont tous déjà été jugés** depuis ce
      dernier mouvement du journal. Un motif neuf — une PR qui vient de virer au
      vert, un ticket qui vient de tomber — rouvre l'arbitrage, même si rien
      d'autre n'a bougé.
    """
    if not found or not history:
        return False
    stamps = {row.get("ts") for row in history if row.get("ts")}
    if not stamps:
        return False
    events = movement(events)
    last = max(stamps)
    if any((event.get("ts") or "") > last for event in events):
        return False
    # Le dernier événement qui n'est pas la trace d'un arbitrage : c'est lui qui
    # date le dossier. Tous les arbitrages posés depuis ont jugé celui-là.
    floor = max((event.get("ts") or "" for event in events
                 if (event.get("ts") or "") not in stamps), default="")
    judged = {row.get("motif") for row in history if (row.get("ts") or "") > floor}
    return set(found) <= judged


def spent(history, ticket=None):
    if ticket is None:
        return len(history)
    return sum(1 for row in history if row.get("ticket") == ticket)


def next_rung(history, ticket, sign=None, per_ticket=PER_TICKET, prior=(), kin=(),
              kin_tickets=KIN_TICKETS):
    """Le cran à appliquer maintenant sur ce ticket.

    Quatre règles, et elles se lisent dans cet ordre :

    - le budget du ticket est épuisé → `skip`, sans discuter. C'est ce qui
      garantit qu'un ticket ne peut pas retenir le jalon indéfiniment ;
    - jamais arbitré, **nulle part**, et cause inconnue **ailleurs** → on relance,
      c'est le geste le moins cher et il suffit dans la plupart des cas (un agent
      tué par la fenêtre de quota reprend son worktree et finit son ticket) ;
    - sinon on monte d'un cran — et de **deux** si la cause est celle qu'on a
      déjà traitée sur ce ticket. Réessayer une panne à l'identique est le seul
      comportement qu'un arbitre ne doit jamais avoir ;
    - et le voisinage pose un plancher, sans jamais rien ajouter au-dessus.

    `prior` porte ce que les autres runs ont arbitré sur ce même ticket, et c'est
    tout l'objet de #359 : la règle ci-dessus était juste, sa portée ne l'était
    pas. Une cause déterministe — un classifieur de permissions qui refuse la
    même écriture, une dépendance absente de l'image — ne guérit pas d'un run à
    l'autre, et « jamais arbitré » y était faux tout en restant vrai du fichier
    qu'on lisait. Seule l'antériorité **de même cause** compte : un ticket tombé
    hier pour une autre raison mérite encore sa relance, c'est une panne neuve.

    `kin` porte la suite de ce raisonnement, et sa limite (#366). Une cause
    structurelle ne guérit pas davantage de changer de ticket que de changer de
    run : elle frappe tous ceux qui passent au même endroit. Mais l'inférence est
    plus faible d'un cran, et le mot est à prendre au pied de la lettre — le
    voisinage **relève le plancher à `KIN_RUNG`** et s'arrête là, il ne s'ajoute
    pas à ce que le ticket a déjà accumulé. Deux conséquences, voulues :

    - un ticket jamais arbitré dont la cause a conclu ailleurs se voit rendre
      `fix` et non `retry` — on ne rejoue pas à l'identique une panne connue ;
    - le voisinage **ne peut pas écarter**. C'est le risque que l'issue demande
      de ne pas prendre : le cran maximal étant `skip`, une signature trop
      grossière ferait perdre un ticket sain sur la panne d'un voisin. Plafonné,
      elle fait perdre une tentative de correction. On n'écarte un ticket que sur
      son propre dossier — son budget, ou sa propre récidive.

    Le budget, lui, reste celui du run : `history` seule le décompte. L'ancienneté
    d'une cause n'a pas à consommer les deux arbitrages que cette nuit peut
    dépenser — elle dit seulement par quel cran les dépenser.
    """
    mine = [row for row in history if row.get("ticket") == ticket]
    before = [row for row in prior
              if row.get("ticket") == ticket
              and bool(sign) and row.get("signature") == sign]
    if len(mine) >= per_ticket:
        return LADDER[-1]
    # Le plancher du voisinage, mesuré en tickets distincts et non en lignes :
    # une cause conclue trois fois sur le même voisin reste un seul témoignage.
    # Les mêmes restrictions que `kin_arbitrations`, redites ici parce que `kin`
    # est un argument : une ligne sans cran n'a rien conclu, et un arbitrage de
    # run (`ticket: null`) n'est le voisin de personne.
    neighbours = {row.get("ticket") for row in kin
                  if row.get("ticket") is not None
                  and row.get("ticket") != ticket
                  and row.get("rung") in LADDER}
    # `neighbours` doit être non vide : un seuil nul ou négatif ne doit pas
    # fabriquer un plancher là où aucune cause n'a jamais conclu ailleurs.
    floor = (LADDER.index(KIN_RUNG)
             if neighbours and len(neighbours) >= kin_tickets else -1)
    if not mine and not before:
        return LADDER[max(floor, 0)]
    highest = max((LADDER.index(row["rung"]) for row in mine + before
                   if row.get("rung") in LADDER), default=-1)
    repeated = bool(before) or (bool(sign)
                                and any(row.get("signature") == sign for row in mine))
    step = max(highest + (2 if repeated else 1), floor)
    return LADDER[min(step, len(LADDER) - 1)]


def summary(history, per_ticket=PER_TICKET, per_run=PER_RUN):
    par_ticket = {}
    for row in history:
        number = row.get("ticket")
        if number is not None:
            par_ticket[str(number)] = par_ticket.get(str(number), 0) + 1
    return {
        "total": len(history),
        "budget_run": per_run,
        "reste_run": max(0, per_run - len(history)),
        "budget_ticket": per_ticket,
        "par_ticket": par_ticket,
        "derniers": [{"ts": row.get("ts"), "motif": row.get("motif"),
                      "ticket": row.get("ticket"), "cran": row.get("rung"),
                      "message": row.get("message")}
                     for row in history[-5:]],
    }


def record(run_id, motif, message, ticket=None, rung=None, sign=None,
           action=None, actor="arbitre"):
    """Inscrit une décision — deux fois, et c'est délibéré.

    Dans `arbitrations.ndjson`, pour que le compteur et l'escalade s'appuient sur
    des faits plutôt que sur la mémoire d'un modèle qui repart d'un contexte
    vide à chaque appel. Et dans le journal du run, parce qu'une décision prise à
    la place de quelqu'un doit se lire là où il regarde — `watch`, `log`,
    `ticket N` — et pas dans un fichier qu'il faut savoir ouvrir.
    """
    entry = {"ts": run_mod.now(), "motif": motif, "ticket": ticket, "rung": rung,
             "signature": sign, "action": action, "message": message,
             "actor": actor}
    path = run_mod.run_dir(run_id) / ARBITRATIONS
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    label = f"arbitrage [{motif}]"
    if rung:
        label += f" · {rung}"
    run_mod.append_journal(run_id, {
        "ts": entry["ts"], "kind": "ticket" if ticket else "run",
        "ticket": ticket, "phase": "orchestration", "actor": actor,
        "level": "WARN", "message": f"{label} — {message}"})
    return entry


# --------------------------------------------------------------------------- #
# Commandes
# --------------------------------------------------------------------------- #

def render(payload):
    """Le dossier en clair — la même matière, lisible sans outil."""
    run = payload["run"]
    lines = [f"run {run['id']} · {run['jalon']} · largeur {run['largeur']}",
             f"gate {payload['gate']['code']} — {payload['gate']['sens']}",
             "motifs : " + (", ".join(payload["motifs"]) or "aucun")]
    if payload.get("signal") == "pause":
        lines.append(f"pause posée par {payload.get('signal_acteur') or 'acteur inconnu'}"
                     + (" — décision humaine, à ne pas lever"
                        if payload.get("pause_humaine") else ""))
    if payload["vague"]:
        lines.append(f"vague {payload['vague']['index']} : "
                     + ", ".join(f"#{n}" for n in payload["vague"]["tickets"]))
    for ticket in payload["tickets"]:
        if ticket["status"] in ("pending", "merged"):
            continue
        lines.append(f"  {run_mod.MARK.get(ticket['status'], '?')} #{ticket['number']} "
                     f"{ticket['status']:<8} {(ticket['phase'] or '?'):<15} "
                     f"{(ticket['note'] or 'sans détail')[:90]}")
    for row in payload["prs"]:
        verdict = (row.get("barriere") or {}).get("sens", "non interrogée")
        lines.append(f"  PR #{row['pr']} ({', '.join(f'#{n}' for n in row['tickets'])}) "
                     f"— {verdict} · {row['checks']['verts']}/{row['checks']['total']} verts")
    counts = payload["arbitrages"]
    lines.append(f"arbitrages : {counts['total']} — reste {counts['reste_run']} "
                 f"sur le run, {counts['budget_ticket']} par ticket")
    return "\n".join(lines)


def cmd_diagnose(args):
    run_id = run_mod.resolve(args.run)
    payload = dossier(run_id, reasons=args.reason, tail=args.tail,
                      with_barrier=not args.no_barrier,
                      per_ticket=args.per_ticket, per_run=args.per_run)
    print(json.dumps(payload, ensure_ascii=False, indent=2) if args.json
          else render(payload))
    return 0


def cmd_should(args):
    """0 s'il y a matière à arbitrer, 1 sinon — lu par le superviseur.

    Le dossier complet n'est pas constitué ici : interroger la barrière pour
    chaque PR coûterait plusieurs appels réseau à chaque étape, y compris quand
    la réponse est « rien à faire ». On regarde d'abord ce qui est gratuit.
    """
    run_id = run_mod.resolve(args.run, required=False)
    if run_id is None:
        print("aucun run en cours")
        return 1
    payload = dossier(run_id, reasons=args.reason, tail=0, with_barrier=False,
                      per_ticket=args.per_ticket, per_run=args.per_run)
    found = payload["motifs"]
    counts = payload["arbitrages"]
    if not found:
        print("rien à arbitrer")
        return 1
    history = arbitrations(run_id)
    if already_arbitrated(found, history, run_mod.read_journal(run_id)):
        rendered = (history[-1].get("ts") or "")[:19] or "la dernière décision"
        print(f"dossier inchangé depuis {rendered} — "
              f"{', '.join(found)} : déjà jugé, rien de neuf au journal")
        return 1
    if counts["reste_run"] <= 0:
        print(f"budget d'arbitrage épuisé ({counts['total']}/{counts['budget_run']}) "
              f"— motifs restants : {', '.join(found)}")
        return 1
    print("; ".join(f"{name} — {MOTIFS[name]}" for name in found))
    return 0


def cmd_escalation(args):
    run_id = run_mod.resolve(args.run)
    history = arbitrations(run_id)
    sign = args.signature or (signature(args.cause) if args.cause else None)
    # Un seul parcours du disque pour les deux antériorités — celle du ticket,
    # celle de la cause.
    rows = all_arbitrations()
    prior = prior_arbitrations(run_id, args.ticket, rows=rows)
    kin = kin_arbitrations(args.ticket, sign, rows=rows)
    rung = next_rung(history, args.ticket, sign, per_ticket=args.per_ticket,
                     prior=prior, kin=kin)
    outside = elsewhere(prior, sign)
    neighbourhood = kinship(kin)
    payload = {"ticket": args.ticket, "cran": rung, "conduite": RUNGS[rung],
               "signature": sign, "arbitrages": spent(history, args.ticket),
               "budget_ticket": args.per_ticket, "hors_run": outside,
               # L'antériorité de la **cause**, tenue à part de celle du ticket :
               # un voisin n'a pas le poids d'une récidive, et l'arbitre doit
               # pouvoir le voir sans le déduire (#366).
               "voisinage": neighbourhood}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    line = (f"#{args.ticket} · cran « {rung} » — {RUNGS[rung]} "
            f"({payload['arbitrages']}/{args.per_ticket} arbitrage(s) déjà posé(s))")
    if outside["arbitrages"]:
        line += (f" · {outside['arbitrages']} hors run"
                 f" — {outside['meme_cause']} sur la même cause,"
                 f" dernier cran « {outside['dernier_cran'] or '-'} »")
    if neighbourhood["arbitrages"]:
        line += (" · même cause sur "
                 + ", ".join(f"#{n}" for n in neighbourhood["tickets"])
                 + (f" — plancher « {KIN_RUNG} »" if neighbourhood["retenu"]
                    else f" — sous le seuil de {neighbourhood['seuil']}, sans effet"))
    print(line)
    return 0


def cmd_record(args):
    run_id = run_mod.resolve(args.run)
    sign = args.signature or (signature(args.cause) if args.cause else None)
    entry = record(run_id, args.motif, args.message, ticket=args.ticket,
                   rung=args.rung, sign=sign, action=args.action, actor=args.actor)
    print(json.dumps(entry, ensure_ascii=False) if args.json
          else f"arbitrage inscrit — {args.motif}"
               + (f" · #{args.ticket}" if args.ticket else "")
               + (f" · {args.rung}" if args.rung else ""))
    return 0


def cmd_state(args):
    run_id = run_mod.resolve(args.run, required=False)
    if run_id is None:
        print("{}" if args.json else "aucun run en cours")
        return 0
    counts = summary(arbitrations(run_id), per_ticket=args.per_ticket,
                     per_run=args.per_run)
    if args.json:
        print(json.dumps(counts, ensure_ascii=False, indent=2))
        return 0
    print(f"{counts['total']} arbitrage(s) · reste {counts['reste_run']} sur le run")
    for row in counts["derniers"]:
        who = f"#{row['ticket']}" if row["ticket"] else "run"
        print(f"  {(row['ts'] or '')[:19]}  {who:<6} {row['motif']:<18} "
              f"{row['cran'] or '-':<6} {(row['message'] or '')[:80]}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def common(node):
        node.add_argument("--run")
        node.add_argument("--json", action="store_true")
        node.add_argument("--per-ticket", type=int, default=PER_TICKET)
        node.add_argument("--per-run", type=int, default=PER_RUN)
        return node

    diag = common(sub.add_parser("diagnose", help="le dossier d'arbitrage"))
    diag.add_argument("--reason", action="append", default=[], choices=sorted(MOTIFS),
                      help="motif connu du superviseur seul (répétable)")
    diag.add_argument("--tail", type=int, default=12,
                      help="lignes de log conservées par ticket")
    diag.add_argument("--no-barrier", action="store_true",
                      help="ne pas interroger pr_gate.py pour chaque PR")

    should = common(sub.add_parser("should", help="y a-t-il matière à arbitrer ?"))
    should.add_argument("--reason", action="append", default=[], choices=sorted(MOTIFS))

    esc = common(sub.add_parser("escalation", help="le cran à appliquer sur un ticket"))
    esc.add_argument("ticket", type=int, metavar="N")
    esc.add_argument("--cause", help="la cause du blocage, d'où l'empreinte se déduit")
    esc.add_argument("--signature", help="l'empreinte, si elle est déjà connue")

    rec = common(sub.add_parser("record", help="inscrire une décision d'arbitrage"))
    rec.add_argument("--motif", required=True, choices=sorted(MOTIFS))
    rec.add_argument("--message", required=True,
                     help="ce qui a été décidé, et pourquoi — lu dans le journal")
    rec.add_argument("--ticket", type=int)
    rec.add_argument("--rung", choices=LADDER)
    rec.add_argument("--action", help="le geste posé : retry, skip, merge, issue…")
    rec.add_argument("--cause")
    rec.add_argument("--signature")
    rec.add_argument("--actor", default="arbitre")

    common(sub.add_parser("state", help="ce qui a déjà été arbitré"))

    args = parser.parse_args()
    handlers = {"diagnose": cmd_diagnose, "should": cmd_should,
                "escalation": cmd_escalation, "record": cmd_record,
                "state": cmd_state}
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
