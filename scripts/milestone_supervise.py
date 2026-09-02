#!/usr/bin/env python3
"""Déroule un jalon jusqu'au bout, tout seul — quota, plantages et reboots compris.

**Rien à lancer à la main.** `milestone_run.py start` — donc `/milestone` — arme
ce fichier au moment où le run s'ouvre. Les commandes ci-dessous ne servent qu'à
regarder ou à débrancher :

    python scripts/milestone_supervise.py --state       # qui veille, sur quoi
    python scripts/milestone_supervise.py --disarm      # tout débrancher
    python scripts/milestone_supervise.py --dry-run     # l'appel qui serait fait

## Deux boucles, parce qu'une seule ne suffit pas

**La boucle courte — le superviseur.** Elle demande au run s'il peut continuer
(`milestone_run.py gate`), lance `claude -p "/milestone … --waves 1"` — une
vague, pas le jalon entier : chaque vague est un point d'arrêt net, et un appel
neuf repart d'un contexte vide — puis lit le flux `stream-json` de cet appel.

Claude Code y émet un événement `rate_limit_event` portant `status`,
`rateLimitType` et surtout `resetsAt` : **l'instant exact où les jetons
reviennent**. Sur `rejected`, on inscrit la retenue, on dort jusqu'à cette
seconde-là, et on relance. Pas de sondage, pas d'estimation.

**La boucle longue — le chien de garde.** La boucle courte ne protège que d'une
chose : la fenêtre de quota. Elle ne survit ni à un plantage, ni à un terminal
fermé, ni à un redémarrage — et elle n'existe pas du tout quand la limite tombe
au milieu d'un `/milestone` lancé à la main. D'où une tâche planifiée Windows,
enregistrée à l'ouverture du run, qui se réveille toutes les cinq minutes et
pose trois questions : reste-t-il du travail ? un superviseur bat-il encore ?
le quota est-il revenu ? Si oui, non, oui — elle relance un superviseur détaché.

Ensemble : la coupure est encaissée à la seconde près par la boucle courte, et
tout ce qui pourrait tuer la boucle courte est rattrapé en cinq minutes par la
longue.

**Et un battement, parce qu'un run muet ne se lit pas.** Entre deux vagues,
personne n'écrit dans le journal du run — l'orchestrateur vérifie `develop`, puis
lit les issues et revoit son plan. Quinze à vingt-cinq minutes pendant lesquelles
un run au travail et un run mort se ressemblent trait pour trait (#186). Tant
qu'une étape est en vol, la boucle courte pose donc une ligne toutes les cinq
minutes **dans le journal du run**, mais seulement quand il est réellement muet :
elle dit l'âge du silence et l'échéance de la coupure. Le guetteur, lui, ne compte
pas ces lignes — sans quoi il ne couperait plus jamais une étape morte debout.

**La troisième — l'arbitre.** Les deux premières savent faire repartir un run ;
aucune ne sait **décider**. Au premier ticket tombé, à la première PR verte
laissée ouverte, à la première étape coupée au temps, le superviseur rendait la
main et attendait quelqu'un — si bien qu'un jalon lancé le soir s'arrêtait sur la
première question posée, et que la nuit était perdue.

À chacun de ces points d'arrêt, on appelle donc `claude -p /milestone-arbitrate`
sur Opus 5. Cet appel lit le dossier du run — journal, logs par ticket, flux de
la dernière étape, PR et verdict de la barrière — puis tranche : relancer un
ticket, corriger une branche, merger une PR, écarter un ticket avec une issue de
suivi. Ce qu'il a le droit de faire est écrit dans
`.claude/commands/milestone-arbitrate.md` ; ce qu'il ne peut pas dépasser —
budget, échelle d'escalade — est tenu par `milestone_arbiter.py`.

Deux garde-fous, parce qu'un arbitre qui se trompe coûte plus cher qu'une étape
perdue : il n'est appelé que si le dossier montre un motif (une étape saine n'en
déclenche aucun), et son dernier cran est l'**écartement d'un ticket**, jamais
l'arrêt du jalon. `--no-arbiter` rend au superviseur son comportement d'avant.

## La règle d'autorisation

**Tant qu'un run est ouvert, la relance automatique a le droit de s'exécuter.
Dès qu'il n'y en a plus, elle n'a plus rien à faire et se supprime.** C'est la
seule autorisation du dispositif, elle est vérifiée à chaque réveil par
`authorised()`, et son marqueur est le run lui-même — `current` pointant sur un
dossier de run existant — non le terminal qui l'a ouvert : un run doit survivre
à la fermeture d'une fenêtre et à un redémarrage, sinon la reprise après quota
ne servirait à rien.

Quatre choses retirent donc l'autorisation, et chacune fait que la tâche
planifiée se supprime au réveil suivant : jalon déroulé, `stop` ou `pause`
demandé dans le run, run effacé, et — garde-fou de dernier recours — intention
vieille de plus de quinze jours.

## Où reprendre

Nulle part ici. `milestone_run.py start` reprend de lui-même le run inachevé, et
`reconcile` réaligne le journal sur l'état réel du dépôt avant chaque reprise.
Le superviseur ne garde donc aucun état : on peut le tuer à tout moment.

## Il se recharge tout seul

Il est le seul processus long du dispositif : la boucle des étapes vit en
mémoire, et les fonctions qui mesurent la production d'une étape sont celles de
*ce* module-là, chargées une fois au démarrage. Les sous-processus
(`milestone_run.py`, `milestone_arbiter.py`, `pr_gate.py`) n'ont pas ce défaut —
ils repartent neufs à chaque appel. Un correctif que le run merge lui-même sur
`develop` restait donc inerte pour le run qui venait de le merger, et c'est
d'abord un faux signal : l'étape qui a mergé la correction du compteur se voyait
compter par le compteur d'avant, se déclarait stérile, et faisait convoquer
l'arbitre. Sept arbitrages sur douze sur le run du 1er septembre, alors que neuf
tickets y avaient abouti — et le budget épuisé arrête le run.

L'empreinte de la source est donc retenue au démarrage, relue en fin d'étape, et
l'écart déclenche un `os.execv()` : le processus se remplace par un superviseur
qui exécute le code d'aujourd'hui, sur la même intention (#373). Entre deux
étapes seulement, jamais avec un `claude -p` en vol — le superviseur en est le
parent. `--max-legs` est décompté dans l'intention, faute de quoi le
rechargement rendrait au run un budget d'étapes entier. `--no-reload` débranche
l'acte et rend au dispositif le simple `WARN` de #369.

## Ce qu'il ne fait pas

Lui-même ne relit aucun code. Sauf `--no-merge`, il enchaîne des merges
automatiques sur `develop` sans relecture humaine — c'est le prix du « sans
intervention ». Ce que l'arbitre y ajoute est une relecture *par un modèle*, pas
par quelqu'un : elle est publiée sur la PR avant le merge, et c'est tout ce qui
en tient lieu.

Une exception, et elle est mécanique plutôt que consignée : sur un périmètre
sensible — `mod:payments`, le label `security`, une migration Prisma,
`infra/terraform` — `pr_gate.py` refuse le merge et laisse la PR ouverte.

Ce refus se lève périmètre par périmètre, et seulement à l'armement :

    --merge-sensitive infra/terraform,prisma

L'absence de l'opérateur ne vaut plus interdiction (#156) — elle ne l'a jamais
valu, c'est même quand il est absent que ce dispositif doit travailler. Ce qui
interdit, c'est l'absence d'un accord donné à l'avance. Les deux voyagent
séparément vers les vagues : `SPA_UNATTENDED` dit que personne ne peut répondre,
`SPA_MERGE_SENSITIVE` dit ce qui a déjà été répondu. Le choix est inscrit dans
`supervisor.json` et rejoué à chaque reprise, comme l'est `--no-merge`.

Pour un jalon sensible de bout en bout, armer plutôt avec `--no-merge`.

L'arbitre peut lever ce refus lui-même, PR par PR et périmètre par périmètre,
après avoir lu le diff et publié sa revue — c'est le mandat que l'opérateur lui a
donné. Il ne peut pas le lever globalement : `SPA_MERGE_SENSITIVE` reste posée
par l'appel, jamais exportée, et `all` lui est interdit.
"""
import argparse
import atexit
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

# Les périmètres sensibles sont définis — et appliqués — par `pr_gate.py`. Les
# relire chez lui plutôt que d'en recopier la liste évite que l'annonce faite à
# l'opérateur finisse par décrire autre chose que ce que la barrière refuse. Et
# c'est justement le message qu'il ne peut pas vérifier : il est lu à l'instant
# où il cesse de regarder.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from pr_gate import ALL_SCOPES, AUTHORISED_ENV, SCOPE_KEYS, SENSITIVE_SCOPES
    SCOPES_KNOWN = True
except Exception:  # noqa: BLE001 — un pr_gate.py à demi écrit ne doit pas
    # emporter avec lui `--state`, `--disarm` et le réveil de la veille : ce
    # sont précisément les commandes qui servent à reprendre la main.
    SENSITIVE_SCOPES = "voir SENSITIVE_LABELS / SENSITIVE_PREFIXES dans pr_gate.py"
    # Un registre vide ne pré-autorise rien : sans la liste qui fait foi, on
    # n'ouvre aucun périmètre. `--merge-sensitive` refusera alors toute clé, ce
    # qui est le bon sens de l'échec — mieux vaut un armement qui râle qu'un
    # armement qui merge du paiement parce que le fichier d'en face est cassé.
    ALL_SCOPES, SCOPE_KEYS = "all", frozenset()
    AUTHORISED_ENV = "SPA_MERGE_SENSITIVE"
    # Et le registre est *su* indisponible, pas simplement vide. La nuance porte
    # tout le reste : sans elle, une clé parfaitement valide devient « inconnue »
    # et fait échouer l'armement — y compris celui d'un superviseur ressuscité
    # par la veille, qui rejoue `--merge-sensitive` depuis `supervisor.json` et
    # n'a personne pour corriger. Il mourrait à chaque relance, toutes les cinq
    # minutes, et le jalon s'arrêterait là.
    SCOPES_KNOWN = False

ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = ROOT / ".claude" / ".milestone"
CURRENT = RUNS_DIR / "current"
LEGS_DIR = RUNS_DIR / "legs"
SUPERVISOR_LOG = RUNS_DIR / "supervisor.log"
RUNNER = ROOT / "scripts" / "milestone_run.py"
ARBITER = ROOT / "scripts" / "milestone_arbiter.py"

# L'arbitre — la couche qui manquait. Tout ce que ce fichier savait faire jusqu'à
# présent était mécanique : attendre le quota, survivre à un plantage, couper une
# étape morte. Aucune de ces protections ne *décide*, et c'est pourquoi un jalon
# lancé le soir s'arrêtait sur la première question posée. À chaque point d'arrêt,
# on appelle donc un modèle qui tranche, et le run repart.
#
# Opus 5 et pas le modèle des vagues : l'arbitre ne code presque rien, il juge —
# une PR de paiement à merger ou non, un ticket à relancer ou à écarter, une
# anomalie à porter en issue. C'est le seul endroit du dispositif où se tromper
# coûte plus cher qu'un tour de modèle.
ARBITER_MODEL = "claude-opus-5"
# Un arbitrage lit un dossier, corrige parfois une branche, publie une revue :
# beaucoup moins qu'une vague, mais pas rien. Au-delà, il tourne en rond.
ARBITER_TIMEOUT = 45
# Douze pour tout le run — le même plafond que `milestone_arbiter.PER_RUN`, redit
# ici parce que c'est cette valeur-là que la ligne de commande expose.
ARBITER_BUDGET = 12
# Le silence qui dit qu'une étape est morte debout. Une phase de ticket dure
# quelques minutes ; un journal muet depuis vingt-cinq minutes, alors que des
# agents sont censés y écrire, signifie qu'ils attendent tous quelque chose que
# personne ne leur donnera. La coupure au temps (`--leg-timeout`, deux heures)
# finirait par les libérer — mais deux heures plus tard.
STALL_MINUTES = 25

# Ce que le chien de garde doit relancer, et avec quels réglages. Écrit une fois
# à l'armement ; c'est la mémoire du dispositif entre deux vies du superviseur.
INTENT = RUNS_DIR / "supervisor.json"
# Un battement daté plutôt qu'un PID : un PID est recyclé par le système, et un
# superviseur bloqué garderait le sien. Un battement qui vieillit ne ment pas.
HEARTBEAT = RUNS_DIR / "supervisor.alive"
HEARTBEAT_EVERY = 30
HEARTBEAT_STALE = 210
WATCHDOG_CMD = RUNS_DIR / "watchdog.cmd"
TASK_NAME = "SpaBooking-Milestone-Watchdog"
# Une panne qui n'est pas le quota — session `gh` expirée, dépôt inaccessible —
# ne doit pas faire relancer un superviseur toutes les cinq minutes pour rien.
# On repousse le prochain réveil sans désarmer : la panne peut se réparer seule.
BACKOFF = RUNS_DIR / "supervisor.backoff"
BACKOFF_SECONDS = 1800
# Garde-fou de dernier recours : une intention oubliée ne doit pas autoriser une
# relance des mois plus tard. Le désarmement normal vient de la fin du run.
INTENT_TTL = 14 * 86400

# Les branches d'intégration ne portent pas de travail de ticket. `develop`
# avance à chaque merge sans qu'un agent y soit pour rien : la compter ferait
# passer un leg stérile pour un leg productif. Les merges que le run s'impute,
# eux, se lisent dans son journal (`merged_tickets`) et non sur `develop`.
INTEGRATION_BRANCHES = {"develop", "staging", "main"}
# Deux legs de suite sans un commit ni un merge de plus, c'est la signature de
# #138 : la boucle rend la main avant la phase de commit, le leg suivant refait
# le même travail, et rien ne devient jamais durable. Deux et pas trois — chaque
# leg stérile coûte une dizaine de dollars, et le troisième n'apprend rien de
# plus que le deuxième.
DRY_LEGS_LIMIT = 2
# Au-delà de ce silence dans le journal du run, plus personne ne l'orchestre.
# Une phase de ticket dure quelques minutes, jamais dix : un journal muet depuis
# dix minutes signifie que l'orchestrateur est parti, pas qu'il réfléchit.
ORCHESTRATOR_QUIET = 600
# Le battement du superviseur dans le journal du **run** — à ne pas confondre
# avec `HEARTBEAT`, qui ne sert qu'à la veille et que personne ne lit.
#
# Entre deux vagues, plus personne n'écrit dans le journal : l'orchestrateur
# vérifie `develop` (~8 min), puis lit les issues et revoit le plan (5 à 15 min).
# Quinze à vingt-cinq minutes pendant lesquelles un run au travail et un run mort
# se ressemblent trait pour trait — c'est ce qui a rendu la nuit du 25/08
# illisible (#186). L'orchestrateur journalise désormais ces étapes lui-même
# (`milestone_run.py step`) ; ce battement-ci couvre ce qui reste, y compris le
# cas où c'est justement l'orchestrateur qui est mort.
#
# Cinq minutes : assez pour qu'aucun silence ne dépasse le quart du seuil de
# coupure, assez peu pour qu'une nuit entière n'ajoute qu'une centaine de lignes.
# Et seulement quand le silence est réel : une vague qui journalise ses phases
# n'a pas besoin qu'on la double.
JOURNAL_BEAT = 300
# Ce que dit le `subtype` du message `result` de Claude Code, en clair. « success »
# ne signifie pas « la vague est terminée » : il dit seulement que l'appel s'est
# achevé sans erreur — y compris lorsque la boucle a rendu la main alors que ses
# agents travaillaient encore. Le journal doit nommer cela, sans quoi cinq legs
# stériles se lisent comme cinq succès.
END_REASONS = {
    "success": "rendu la main de lui-même",
    "error_max_turns": "limite de tours atteinte",
    "error_during_execution": "erreur pendant l'exécution",
}

GO, PAUSE, STOP, NO_RUN, QUOTA = 0, 1, 2, 3, 4

# Une fenêtre de quota dure cinq heures : c'est la seule attente à tenir quand
# l'API n'a pas dit quand elle se rouvrirait.
FALLBACK_WINDOW = 5 * 3600
# Le mot du serveur, pas le nôtre : ces motifs ne servent que si le flux s'est
# interrompu avant l'événement structuré.
# `429` seul se retrouve dans un numéro de ligne, un port ou un compte de tests :
# le motif exige donc un contexte HTTP. Ce filet ne sert que si le flux s'est
# interrompu avant l'événement structuré, qui reste la source de vérité.
LIMIT_TEXT = re.compile(
    r"usage limit reached|rate[ _-]?limit|limite d'utilisation"
    r"|quota (?:épuisé|exceeded)|too many requests"
    r"|(?:status|http|code)\s*[:= ]?\s*429", re.I)


def resolve_binary(name):
    """Le chemin complet de l'exécutable, ou son nom si on ne le trouve pas.

    Indispensable sous Windows : Claude Code s'installe en `claude.CMD`, que
    `Popen` sans shell ne résout pas — il lève `FileNotFoundError`. Le préflight
    passait pourtant, parce qu'il interroge `shutil.which` sans réinjecter ce
    qu'il trouve dans la commande.
    """
    return shutil.which(name) or name


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hm(epoch):
    return datetime.fromtimestamp(float(epoch)).strftime("%H:%M")


def human_delta(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02d}"
    return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}"


def say(message, level="INFO"):
    line = f"{datetime.now().strftime('%H:%M:%S')}  {level:<5}  {message}"
    print(line, flush=True)
    try:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        with open(SUPERVISOR_LOG, "a", encoding="utf-8") as handle:
            handle.write(f"{now()}  {level:<5}  {message}\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Dialogue avec le run
# --------------------------------------------------------------------------- #

def runner(*args, capture=True):
    return subprocess.run([sys.executable, str(RUNNER), *args], cwd=ROOT,
                          capture_output=capture, text=True,
                          encoding="utf-8", errors="replace")


def current_run():
    if CURRENT.exists():
        candidate = CURRENT.read_text(encoding="utf-8").strip()
        if candidate and (RUNS_DIR / candidate).exists():
            return candidate
    return None


def quota_file_hold():
    """La retenue en cours telle qu'elle est sur le disque, ou None.

    Lue à chaque tour de l'attente : un `quota clear` passé à la main depuis
    `milestone_run.py shell` doit réveiller le superviseur tout de suite.
    """
    run_id = current_run()
    if not run_id:
        return None
    path = RUNS_DIR / run_id / "quota.json"
    if not path.exists():
        return None
    try:
        quota = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if quota.get("status") != "held":
        return None
    if quota.get("until") is None or time.time() >= float(quota["until"]):
        return None
    return quota


def parse_scopes(value):
    """`--merge-sensitive` : la liste de périmètres pré-autorisés, validée.

    Rend (clés, inconnues). Une clé inconnue est **rendue**, pas ignorée : c'est
    à l'armement qu'un humain est encore là pour corriger sa faute de frappe.
    Plus tard, dans `pr_gate.py`, la même faute sera muette et inerte — elle
    n'ouvrira simplement rien, ce qui est sans danger mais indébogable.
    """
    tokens = [token.strip().lower()
              for token in (value or "").replace(",", " ").split()
              if token.strip()]
    # Relevées avant tout raccourci : `all,prsima` ouvrirait tout *et* tairait la
    # faute, c'est-à-dire le seul sens dans lequel une mauvaise saisie ne doit
    # jamais jouer. L'opérateur doit apprendre ici que sa liste est fautive, même
    # quand ce qu'il a tapé par ailleurs suffit à tout ouvrir.
    unknown = [token for token in tokens
               if token not in SCOPE_KEYS and token != ALL_SCOPES]
    if ALL_SCOPES in tokens:
        return set(SCOPE_KEYS), unknown
    return ({token for token in tokens if token in SCOPE_KEYS}, unknown)


def describe_scopes(intent):
    """Ce que `--state` doit dire d'une intention : quoi, et rien de vague."""
    scopes = sorted((intent or {}).get("merge_sensitive") or [])
    if (intent or {}).get("no_merge"):
        return "sans objet — armé en --no-merge, rien n'est mergé"
    if not scopes:
        return "aucun pré-autorisé — tout périmètre sensible reste sous relecture"
    return "pré-autorisés : " + ", ".join(scopes)


def intent_of(args):
    """L'intention que porte ce Namespace, sous la forme écrite sur le disque.

    Détachée de `save_intent` parce qu'un rechargement (#373) a besoin de la
    **composer** sans forcément l'écrire : un superviseur lancé `--no-watchdog`
    n'a pas d'intention sur le disque, et se remplacer ne doit pas lui en armer
    une. Une seule description des réglages qui survivent, quel qu'en soit
    l'usage — deux copies finiraient par ne plus rejouer les mêmes.
    """
    return {
        "milestone": args.milestone, "width": args.width,
        # La nature se rejoue comme la largeur : un superviseur ressuscité par la
        # veille sur un run d'outillage repartirait sinon sur le produit, c'est-à-
        # dire sur un tout autre plan que celui qu'il est censé reprendre.
        "nature": getattr(args, "nature", "projet"),
        "waves_per_leg": args.waves_per_leg, "no_merge": args.no_merge,
        "merge_sensitive": sorted(args.merge_sensitive),
        "permission_mode": args.permission_mode, "model": args.model,
        "margin": args.margin, "patience": args.patience,
        # `getattr` et pas `args.leg_timeout` : une intention écrite par une
        # version antérieure, ou un Namespace composé ailleurs, n'a pas ce
        # champ — et l'armement ne doit pas mourir sur un réglage ajouté après
        # coup, sous peine d'emporter toute la reprise automatique.
        "max_legs": args.max_legs,
        "leg_timeout": getattr(args, "leg_timeout", 120),
        # L'arbitrage se rejoue comme le reste : un superviseur ressuscité par la
        # veille doit trancher comme celui qu'il remplace. L'oublier ferait qu'un
        # run armé perde sa capacité de décision au premier redémarrage — c'est
        # précisément le moment où elle sert.
        "no_arbiter": getattr(args, "no_arbiter", False),
        # Débrancher le rechargement se rejoue comme le débranchement de
        # l'arbitrage : c'est une consigne de l'opérateur, pas un détail du
        # processus. Un superviseur ressuscité par la veille qui la perdrait se
        # remettrait à se remplacer tout seul, sans que rien ne le dise.
        "no_reload": getattr(args, "no_reload", False),
        "arbiter_model": getattr(args, "arbiter_model", ARBITER_MODEL),
        "arbiter_budget": getattr(args, "arbiter_budget", ARBITER_BUDGET),
        "arbiter_timeout": getattr(args, "arbiter_timeout", ARBITER_TIMEOUT),
        "stall_minutes": getattr(args, "stall_minutes", STALL_MINUTES),
        "claude": args.claude, "armed": now(),
        "expires": time.time() + INTENT_TTL,
    }


def write_intent(intent):
    INTENT.parent.mkdir(parents=True, exist_ok=True)
    INTENT.write_text(json.dumps(intent, ensure_ascii=False, indent=2),
                      encoding="utf-8")


def save_intent(args):
    write_intent(intent_of(args))


def nature_relayed(previous, wanted):
    """L'avertissement à dire quand l'armement change de nature — ou None.

    Il n'y a qu'une intention sur le disque, donc **qu'une nature armée à la
    fois** : ouvrir un run d'outillage remplace l'armement du run produit, dont
    la reprise automatique s'arrête là. C'est tenable — les deux files ne se
    déroulent pas ensemble — mais le taire ferait croire à un run produit qui
    repart tout seul alors que plus rien ne le relance.
    """
    if not previous:
        return None
    armed = previous.get("nature") or "projet"
    if armed == wanted:
        return None
    return (f"la veille était armée en nature {armed} sur "
            f"« {previous.get('milestone') or 'le plus proche'} » : elle passe "
            f"en {wanted}. La reprise automatique de l'autre file s'arrête — "
            "la relancer, c'est rouvrir son run.")


def load_intent():
    if not INTENT.exists():
        return None
    try:
        return json.loads(INTENT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def authorised():
    """L'autorisation du dispositif, et rien d'autre : un run ouvert.

    C'est la règle posée par l'utilisateur, et elle est vérifiée ici plutôt que
    supposée ailleurs : **tant qu'un run est en cours, la relance automatique a
    le droit de s'exécuter ; dès qu'il n'y en a plus, elle n'a plus rien à
    faire et se supprime.** Le marqueur est le run lui-même — `current` pointant
    sur un dossier de run existant — et non le terminal qui l'a ouvert : un run
    doit survivre à la fermeture d'une fenêtre et à un redémarrage, sans quoi la
    reprise après quota ne servirait à rien.

    Rend (autorisé, motif du refus).
    """
    intent = load_intent()
    if intent is None:
        return False, "aucune intention armée"
    if current_run() is None:
        return False, "aucun run ouvert"
    expires = intent.get("expires")
    if expires is not None and time.time() >= float(expires):
        return False, "intention périmée"
    return True, None


def intent_argv(intent):
    """L'intention, retraduite en ligne de commande pour un superviseur neuf."""
    argv = []
    if intent.get("milestone"):
        argv.append(intent["milestone"])
    # `--yes` est inconditionnel, et c'est assumé : un superviseur ressuscité
    # par la tâche planifiée n'a aucun terminal, et une vague tourne en
    # `claude -p` où aucune question ne peut recevoir de réponse. Demander un
    # arbitrage ici bloquerait le jalon sans personne pour le débloquer. La
    # protection des périmètres sensibles ne passe donc pas par une question,
    # mais par `pr_gate.py`, qui refuse de les merger sans surveillance.
    argv += ["--width", str(intent.get("width", 3)),
             "--nature", intent.get("nature") or "projet",
             "--waves-per-leg", str(intent.get("waves_per_leg", 1)),
             "--permission-mode", intent.get("permission_mode", "acceptEdits"),
             "--margin", str(intent.get("margin", 90)),
             "--patience", str(intent.get("patience", 2)),
             "--max-legs", str(intent.get("max_legs", 40)),
             "--leg-timeout", str(intent.get("leg_timeout", 120)),
             "--arbiter-model", intent.get("arbiter_model") or ARBITER_MODEL,
             "--arbiter-budget", str(intent.get("arbiter_budget", ARBITER_BUDGET)),
             "--arbiter-timeout", str(intent.get("arbiter_timeout", ARBITER_TIMEOUT)),
             "--stall-minutes", str(intent.get("stall_minutes", STALL_MINUTES)),
             "--claude", intent.get("claude", "claude"), "--yes"]
    if intent.get("no_merge"):
        argv.append("--no-merge")
    if intent.get("no_arbiter"):
        argv.append("--no-arbiter")
    if intent.get("no_reload"):
        argv.append("--no-reload")
    # La pré-autorisation se rejoue comme `no_merge`, et pour la même raison :
    # un superviseur ressuscité par la tâche planifiée n'a personne à qui la
    # redemander. L'oublier ferait qu'un run armé cesse de merger au premier
    # redémarrage, sans que rien ne le dise — le dispositif s'arrêterait de
    # travailler exactement là où il est censé prendre le relais.
    scopes = intent.get("merge_sensitive") or []
    if scopes:
        argv += ["--merge-sensitive", ",".join(scopes)]
    if intent.get("model"):
        argv += ["--model", intent["model"]]
    return argv


def hold_off(seconds, why):
    """Repousse le prochain réveil de la veille, sans la désarmer."""
    until = time.time() + seconds
    try:
        BACKOFF.parent.mkdir(parents=True, exist_ok=True)
        BACKOFF.write_text(json.dumps({"until": until, "why": why,
                                       "iso": now()}), encoding="utf-8")
    except OSError:
        return
    say(f"veille repoussée à {hm(until)} — {why}", "WARN")


def held_off():
    if not BACKOFF.exists():
        return False
    try:
        until = json.loads(BACKOFF.read_text(encoding="utf-8"))["until"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return False
    if time.time() >= float(until):
        try:
            BACKOFF.unlink()
        except OSError:
            pass
        return False
    return True


def beat():
    try:
        HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT.write_text(json.dumps({"pid": os.getpid(), "at": time.time(),
                                         "iso": now()}), encoding="utf-8")
    except OSError:
        pass


def heartbeat_age():
    """Âge du dernier battement, ou None si personne ne bat."""
    if not HEARTBEAT.exists():
        return None
    try:
        beaten = json.loads(HEARTBEAT.read_text(encoding="utf-8"))["at"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return None
    return time.time() - float(beaten)


def supervisor_alive():
    age = heartbeat_age()
    return age is not None and age < HEARTBEAT_STALE


def start_beating():
    """Bat tant que le processus vit, et rend de quoi l'arrêter à la toute fin.

    Il faut un fil : la boucle principale passe des heures bloquée sur la
    lecture d'un flux ou sur une attente de quota, et un battement posé au fil
    des tours vieillirait assez pour que le chien de garde croie le superviseur
    mort et en lance un second.

    Son signal lui est propre — surtout pas celui de l'arrêt demandé. Un Ctrl-C
    ne coupe pas la vague en cours : elle tourne encore des dizaines de minutes.
    Faire cesser le battement à cet instant, c'est se déclarer mort en
    travaillant, et voir la veille lancer un second superviseur qui mènera une
    seconde vague et une seconde série de merges sur le même `develop`.
    """
    silence = threading.Event()

    def loop():
        while not silence.wait(HEARTBEAT_EVERY):
            beat()

    def stop():
        # Le battement s'éteint avec le processus, et le fichier disparaît avec
        # lui : sinon la veille attendrait trois minutes de plus avant de
        # constater une mort déjà consommée.
        silence.set()
        try:
            HEARTBEAT.unlink()
        except OSError:
            pass

    beat()
    threading.Thread(target=loop, daemon=True).start()
    atexit.register(stop)
    return silence


def progress_count(no_merge=False):
    """Combien de tickets ont abouti depuis l'ouverture du run.

    Délégué à `milestone_run.py progress`, qui compte dans le journal et non
    dans le plan. La distinction décide du sort du dispositif : chaque vague se
    termine par un `replan`, qui retire du plan les issues closes. Un décompte
    pris sur le plan retomberait donc à zéro après chaque vague **réussie**, le
    détecteur d'enlisement conclurait que rien n'avance, et le superviseur se
    débrancherait au bout de trois vagues — précisément quand tout va bien.

    En `--no-merge` c'est pire encore : rien ne se ferme jamais, le compte reste
    à zéro dès la première vague. D'où `--pr-open`, qui compte alors les tickets
    arrivés en PR — le seul avancement observable dans ce mode.
    """
    proc = runner("progress", *(["--pr-open"] if no_merge else []))
    if proc.returncode not in (GO, QUOTA) or not proc.stdout.strip():
        return None
    try:
        return int(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None


def git_lines(*argv):
    """Sortie de `git`, ligne à ligne ; liste vide si l'appel échoue.

    Le superviseur ne doit jamais mourir d'un appel git. Un dépôt momentanément
    verrouillé par un agent doit se lire « rien de neuf », pas « plantage » —
    sans quoi la veille relancerait toutes les cinq minutes un superviseur qui
    remourrait de la même façon.
    """
    try:
        proc = subprocess.run(["git", *argv], cwd=ROOT, capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def work_commits():
    """Les empreintes des commits de travail, toutes branches de tickets confondues.

    On rend un **ensemble d'empreintes**, jamais un décompte, et c'est délibéré :
    une branche mergée disparaît, et un décompte retomberait — le même piège que
    `progress_count` documente au-dessus. L'appelant accumule les empreintes
    vues, si bien qu'un merge ne peut pas faire passer un leg productif pour un
    leg stérile.

    Les branches d'intégration sont exclues : elles ne portent pas de travail de
    ticket, et `develop` avance à chaque merge sans qu'un agent y soit pour rien.

    Cette mesure ne voit donc que le travail **inachevé** : un ticket mené
    jusqu'au merge n'a plus de branche, et son contenu ne vit plus que dans le
    commit de squash sur `develop`, exclu ici. Le complément est
    `merged_tickets()` — les deux ensemble font la production d'une étape
    (`leg_production`).
    """
    shas = set()
    for ref in git_lines("for-each-ref", "--format=%(refname:short)", "refs/heads"):
        if ref in INTEGRATION_BRANCHES:
            continue
        shas.update(git_lines("rev-list", f"origin/develop..{ref}"))
    return shas


def merged_tickets():
    """Les tickets que **ce run** a inscrits comme mergés dans son journal.

    L'autre moitié de la production d'une étape, et celle qui manquait (#278) :
    l'étape la plus productive — celle qui porte un ticket de la recevabilité au
    merge — ne laisse rien sur `refs/heads`, puisque la barrière squashe puis
    supprime la branche. `work_commits()` la mesurait à zéro, et deux étapes
    pleinement réussies de suite déclenchaient `leg_sterile`.

    On lit le journal du run, et non `develop` : l'exclusion que documente
    `work_commits()` reste juste pour une poussée venue de l'extérieur du run.
    Elle ne vaut pas pour un merge que le run vient lui-même de faire — c'est
    précisément sa production, et lui seul sait l'imputer à un ticket.

    Rend un **ensemble de numéros**, jamais un décompte, pour la même raison que
    `work_commits()` : l'appelant accumule ce qu'il a vu, et le statut `merged`
    étant terminal, un ticket n'y entre qu'une fois. Ensemble vide si aucun run
    n'est ouvert ou si le journal est illisible — le superviseur ne doit jamais
    mourir d'une mesure.
    """
    directory = current_run_dir()
    if directory is None:
        return set()
    return {event["ticket"] for event in journal_events(directory)
            if event.get("status") == "merged" and event.get("ticket") is not None}


def leg_production(seen_commits, seen_merges):
    """Ce qu'une étape vient de rendre durable — (commits neufs, merges neufs).

    Mesuré sur le dépôt et sur le journal du run, jamais sur le compte rendu de
    l'étape : un leg qui se termine « success » sans rien produire n'a rien
    laissé qu'un `reconcile` ne puisse effacer.

    Les deux moitiés sont rendues séparément parce qu'elles ne se disent pas de
    la même façon en fin d'étape, et qu'elles se comptent dans des unités
    différentes — des empreintes d'un côté, des numéros de ticket de l'autre.
    """
    return work_commits() - seen_commits, merged_tickets() - seen_merges


def production_note(commits, merges):
    """Ce que l'étape a produit, en une poignée de mots pour le journal.

    Les deux moitiés sont dites, et les merges nommément : « 0 commit(s) » seul
    laissait croire à une étape stérile celle qui venait de mener un ticket
    jusqu'au bout, et c'est ce que lisait l'humain venu comprendre pourquoi le
    dispositif s'était arrêté (#278).
    """
    return f"{len(commits)} commit(s), {len(merges)} merge(s)"


def current_run_dir():
    """Le dossier du run courant, ou None si aucun n'est ouvert."""
    try:
        run_id = (RUNS_DIR / "current").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not run_id:
        return None
    path = RUNS_DIR / run_id
    return path if path.is_dir() else None


def journal_events(directory):
    """Les événements du journal d'un run, dans l'ordre — liste vide si illisible.

    Deux mesures le relisent : « qu'a rendu durable cette étape ? »
    (`merged_tickets`) et « depuis quand ce run se tait-il ? »
    (`journal_activity`). Une seule lecture pour les deux, parce que les deux
    doivent tolérer exactement les mêmes accidents : un journal absent, et une
    ligne tronquée par une écriture concurrente — le fichier s'écrit en ajout, à
    plusieurs, sans verrou. Les lignes qui ne portent pas un objet JSON sont
    écartées ici, faute de quoi un `event.get(...)` chez l'appelant ferait mourir
    le superviseur sur une ligne malformée.
    """
    try:
        lines = (directory / "journal.ndjson").read_text(
            encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    events = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue          # ligne tronquée par une écriture concurrente
        if isinstance(event, dict):
            events.append(event)
    return events


def current_run_milestone():
    """Le jalon du run ouvert, ou None.

    Un run ouvert **désigne déjà son jalon**. Sans cela, un superviseur lancé
    sans argument redevine « le jalon dont l'échéance est la plus proche » et
    peut ouvrir un run neuf sur un autre jalon, en abandonnant celui qui était
    en cours — c'est arrivé, et le run S1 a perdu la main au profit d'un S3
    parasite (#130).
    """
    directory = current_run_dir()
    if directory is None:
        return None
    try:
        return (json.loads((directory / "run.json").read_text(encoding="utf-8"))
                .get("milestone")) or None
    except (OSError, json.JSONDecodeError, AttributeError):
        return None


def journal_activity():
    """Instant du dernier événement du journal qui ne soit **pas** un battement.

    Deux mesures reposent sur le journal — « quelqu'un orchestre-t-il ? » et
    « cette étape avance-t-elle encore ? » — et les deux comptent le travail des
    autres, pas la présence du superviseur. Depuis qu'il y écrit un battement
    (#186), un `st_mtime` ne répond plus à ces questions : il resterait
    éternellement frais, le guetteur des vingt-cinq minutes ne couperait plus
    jamais une étape morte debout, et l'on aurait remplacé un silence illisible
    par un silence invisible — le pire des deux.

    D'où cette lecture du contenu : on remonte le journal jusqu'au dernier
    événement dépourvu de `beat`. Le fichier est en ajout seul et reste petit —
    quelques centaines de lignes pour un jalon entier.

    Rend un epoch, ou None si aucun run n'est ouvert ou si le journal n'existe
    pas encore. Le `st_mtime` reste le repli chaque fois que le contenu ne dit
    rien d'exploitable : un journal sans horodatage vaut mieux qu'aucune mesure.
    """
    directory = current_run_dir()
    if directory is None:
        return None
    path = directory / "journal.ndjson"
    try:
        touched = path.stat().st_mtime
    except OSError:
        return None
    for event in reversed(journal_events(directory)):
        if event.get("beat"):
            continue
        try:
            return datetime.fromisoformat(event["ts"]).timestamp()
        except (KeyError, TypeError, ValueError):
            break             # journal sans horodatage lisible : le mtime fait foi
    return touched


def orchestrator_active():
    """Quelqu'un orchestre-t-il déjà ce run, superviseur ou non ?

    `supervisor_alive()` ne voit qu'un superviseur, parce que lui seul écrit un
    battement. Une session Claude Code qui déroule `/milestone` à la main
    orchestre pourtant tout autant — et lui était invisible : la veille lançait
    un second orchestrateur sur le même run, dont la réconciliation prenait les
    worktrees du premier pour des vestiges et les supprimait (#130).

    Le journal du run fait office de battement : agents et orchestrateur y
    écrivent à chaque phase. Un journal actif depuis moins de
    `ORCHESTRATOR_QUIET` secondes signifie que quelqu'un travaille, et la veille
    n'a alors rien à faire. Le battement du superviseur ne compte pas pour cette
    activité-là : il prouverait sa propre présence, ce que `supervisor_alive()`
    dit déjà mieux, et retarderait de dix minutes la relance d'un superviseur
    tué juste après avoir battu.
    """
    activity = journal_activity()
    return activity is not None and time.time() - activity < ORCHESTRATOR_QUIET


def sterile_streak(previous, produced, issue):
    """Combien de legs de suite n'ont rien rendu durable, celui-ci compris.

    Un leg est stérile quand il n'a produit **ni commit ni merge** — quoi qu'en
    dise son propre compte rendu. Les deux comptent, et pas seulement le commit :
    une étape qui mène un ticket jusqu'au merge ne laisse aucune branche
    derrière elle, et la compter sur le seul `work_commits()` faisait passer la
    plus productive des étapes pour la plus stérile (#278).

    Le quota fait exception : un leg coupé par l'API n'a pas démérité, il n'a pas
    eu le temps, et le compter stérile désarmerait le dispositif pour la seule
    raison que la fenêtre s'est refermée.

    Toute autre panne compte, elle : un leg qui échoue sans rien rendre durable
    laisse exactement le même dépôt qu'un leg qui rend la main trop tôt.
    """
    if issue == "quota":
        return previous
    return 0 if produced else previous + 1


def journal(status, message, level=None, beat=False):
    args = ["event", "--actor", "superviseur", "--message", message, "--quiet"]
    if status:
        args += ["--status", status]
    if level:
        args += ["--level", level]
    if beat:
        # Marquée comme battement, la ligne se lit sans se compter : elle prouve
        # une présence, elle ne prétend pas qu'un travail a eu lieu.
        args.append("--beat")
    runner(*args)


# --------------------------------------------------------------------------- #
# Le chien de garde — ce qui survit au superviseur
# --------------------------------------------------------------------------- #

def pythonw():
    """L'interpréteur sans console : la veille ne doit ouvrir aucune fenêtre."""
    candidate = Path(sys.executable).with_name("pythonw.exe")
    return str(candidate) if candidate.exists() else sys.executable


def write_watchdog_cmd():
    """Un .cmd d'une ligne plutôt que des arguments dans la tâche.

    `schtasks /TR` cite ses arguments d'une façon qui varie avec la version de
    Windows et se casse sur un chemin contenant une espace — et celui de ce
    dépôt en contient une. Un fichier .cmd ramène la tâche à un simple chemin.
    """
    WATCHDOG_CMD.parent.mkdir(parents=True, exist_ok=True)
    WATCHDOG_CMD.write_text(
        "@echo off\r\n"
        f'cd /d "{ROOT}"\r\n'
        f'"{pythonw()}" "{Path(__file__).resolve()}" --watchdog\r\n',
        encoding="utf-8")


def schtasks(*args):
    try:
        return subprocess.run(["schtasks", *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(args, 1, "", str(exc))


def watchdog_armed():
    return os.name == "nt" and schtasks("/Query", "/TN", TASK_NAME).returncode == 0


def arm_watchdog(every):
    """Enregistre la veille — idempotent, et sans droits d'administrateur.

    C'est ce qui rend la reprise vraie : le superviseur peut mourir de n'importe
    quoi, la tâche le rappellera dans les `every` minutes.
    """
    if os.name != "nt":
        say("veille automatique non gérée hors Windows — laisser "
            "`milestone_supervise.py` tourner dans un terminal", "WARN")
        return False
    write_watchdog_cmd()
    # Les guillemets sont indispensables et invisibles : sans eux `schtasks`
    # coupe le chemin à la première espace, rend malgré tout 0, et la tâche ne
    # s'exécute jamais. Vérifié — création réussie, exécution muette.
    proc = schtasks("/Create", "/TN", TASK_NAME, "/TR", f'"{WATCHDOG_CMD}"',
                    "/SC", "MINUTE", "/MO", str(every), "/F")
    if proc.returncode != 0:
        say("la tâche de veille n'a pas pu être enregistrée : "
            + (proc.stderr or proc.stdout).strip()[:200], "ERROR")
        return False
    say(f"veille armée · réveil toutes les {every} min · tâche « {TASK_NAME} »")
    return True


def disarm_watchdog(quiet=False):
    if os.name != "nt":
        return True
    proc = schtasks("/Delete", "/TN", TASK_NAME, "/F")
    if not quiet:
        say("veille désarmée" if proc.returncode == 0
            else "aucune veille à désarmer")
    try:
        WATCHDOG_CMD.unlink()
    except OSError:
        pass
    return proc.returncode == 0


def spawn_supervisor(intent):
    """Relance un superviseur détaché — il survivra à la tâche qui l'a lancé."""
    command = [resolve_binary(pythonw()), str(Path(__file__).resolve()),
               *intent_argv(intent)]
    flags = 0
    if os.name == "nt":
        flags = (getattr(subprocess, "DETACHED_PROCESS", 0)
                 | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    with open(SUPERVISOR_LOG, "a", encoding="utf-8") as log:
        subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT,
                         creationflags=flags, close_fds=True)
    say("veille : superviseur relancé · " + " ".join(intent_argv(intent)))


def cmd_watchdog(args):
    """Un réveil de la tâche planifiée : trois questions, aucune action inutile.

    Ce tour se produit toutes les cinq minutes pendant des jours : il n'écrit
    donc dans le journal que lorsqu'il agit, jamais pour dire qu'il n'a rien
    fait.
    """
    # Un superviseur qui bat passe avant tout contrôle : au tout premier appel,
    # le run n'existe pas encore — c'est la première vague qui l'ouvre — et le
    # désarmer ici tuerait le dispositif au moment précis où il démarre.
    if supervisor_alive():
        return 0

    # Un orchestrateur qui n'est pas un superviseur en est un quand même. Une
    # session Claude Code déroulant `/milestone` à la main n'écrit aucun
    # battement : sans ce contrôle, la veille lui lance un concurrent sur le
    # même run, et le second prend les worktrees du premier pour des vestiges.
    if orchestrator_active():
        return 0

    # L'autorisation ensuite, avant toute relance : sans run ouvert, la veille
    # n'a plus de raison d'être et se supprime elle-même.
    allowed, refusal = authorised()
    if not allowed:
        if watchdog_armed():
            say(f"veille : {refusal} — désarmement")
            retire(refusal)
        return 0

    intent = load_intent()

    if quota_file_hold() is not None:
        return 0                    # quota encore fermé : ne pas brûler un appel

    if held_off():
        return 0                    # panne récente, on laisse le temps passer

    verdict = runner("gate").returncode
    if verdict in (STOP, PAUSE):
        say("veille : pause ou arrêt demandé dans le run — désarmement", "WARN")
        disarm_watchdog(quiet=True)
        return 0
    if verdict == NO_RUN:
        say("veille : plus rien à traiter — jalon déroulé, désarmement")
        disarm_watchdog(quiet=True)
        try:
            INTENT.unlink()
        except OSError:
            pass
        return 0
    if verdict == QUOTA:
        return 0                    # une retenue vient d'être posée

    say("veille : du travail reste et aucun superviseur ne bat — relance")
    spawn_supervisor(intent)
    return 0


def cmd_state(args):
    intent = load_intent()
    age = heartbeat_age()
    allowed, refusal = authorised()
    print(f"veille planifiée   : {'armée' if watchdog_armed() else 'absente'}"
          f"  ({TASK_NAME})")
    print("autorisation       : "
          + (f"accordée — run {current_run()} ouvert" if allowed
             else f"retirée — {refusal}"))
    print("superviseur        : "
          + (f"vivant, dernier battement il y a {human_delta(age)}"
             if supervisor_alive()
             else (f"éteint — dernier battement il y a {human_delta(age)}"
                   if age is not None else "éteint")))
    if intent:
        print(f"jalon armé         : {intent.get('milestone') or '(le plus proche)'}"
              f" · nature {intent.get('nature') or 'projet'}"
              f" · largeur {intent.get('width')} · "
              f"{'PR seules' if intent.get('no_merge') else 'merge automatique'}")
        print("périmètres armés   : " + describe_scopes(intent))
        print(f"armé le            : {intent.get('armed')}")
    else:
        print("jalon armé         : aucun")
    hold = quota_file_hold()
    print("quota              : "
          + (f"épuisé, reprise à {hm(hold['until'])} dans "
             f"{human_delta(float(hold['until']) - time.time())}"
             if hold else "disponible"))
    print(f"journal            : {SUPERVISOR_LOG}")
    return 0


# --------------------------------------------------------------------------- #
# Préflight — ce qui rendrait l'attente inutile
# --------------------------------------------------------------------------- #

def workspace_trusted():
    """Claude Code ignore l'allowlist d'un dossier non approuvé.

    En mode `-p`, aucune demande de permission ne peut être répondue : les
    outils refusés font échouer les agents en silence. Autant le dire avant de
    lancer un run de plusieurs heures.
    """
    path = Path.home() / ".claude.json"
    if not path.exists():
        return None
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    for key, project in (config.get("projects") or {}).items():
        if Path(key).resolve() == ROOT.resolve():
            return bool(project.get("hasTrustDialogAccepted"))
    return False


def announce_merge_policy(args):
    """Dit, à l'armement, ce que le dispositif mergera tout seul.

    Ce n'est pas une invite, et ce n'est pas un oubli : `arm_supervision()`
    appelle ce script en `subprocess.run(capture_output=True)`, donc sans
    terminal ni entrée standard. Un `input()` ici n'aurait personne pour y
    répondre — il ferait échouer l'armement au lieu de le protéger. L'opérateur
    est donc informé par la sortie, que l'appelant recopie ligne à ligne.
    """
    if args.no_merge:
        say("armé en --no-merge : les vagues s'arrêteront aux PR, aucune ne "
            "sera mergée.")
        return
    say("armé SANS --no-merge : toute PR verte sera mergée sur develop sans "
        "relecture humaine, y compris après une coupure de quota et hors de "
        "toute session.", "WARN")

    # Nommer un par un ce qui est pré-autorisé, et pas seulement compter : la
    # question à laquelle ces lignes doivent répondre après coup est « qui a
    # autorisé quoi, et quand », et « 2 périmètres » n'y répond pas. Le niveau
    # WARN les fait ressortir du journal du superviseur, où l'armement est la
    # seule trace qu'un humain ait donné son accord.
    allowed = sorted(args.merge_sensitive)
    if allowed:
        say("pré-autorisés à l'armement — ces périmètres SERONT mergés sans "
            "relecture : {}.".format(", ".join(allowed)), "WARN")
    refused = sorted(SCOPE_KEYS - set(allowed))
    if refused:
        say("laissés sous relecture — ces PR ne seront pas mergées : {}."
            .format(", ".join(refused)), "WARN")
    else:
        say("aucun périmètre sensible ne reste sous relecture.", "WARN")
    say("liste complète des périmètres sensibles : {}".format(SENSITIVE_SCOPES),
        "DEBUG")
    say("tout débrancher : python scripts/milestone_supervise.py --disarm")


def preflight(args):
    problems, warnings = [], []

    if shutil.which(args.claude) is None:
        problems.append(f"« {args.claude} » introuvable dans le PATH")
    if shutil.which("gh") is None:
        problems.append("« gh » introuvable — le plan ne peut pas être calculé")
    else:
        # Le délai est indispensable — ce contrôle est sur le chemin critique de
        # `/milestone start` — mais il lève, et l'exception tuerait le
        # superviseur que la veille relancerait pour qu'il remeure pareil.
        try:
            proc = subprocess.run(["gh", "auth", "status"], capture_output=True,
                                  text=True, encoding="utf-8",
                                  errors="replace", timeout=30)
            failed = proc.returncode != 0
        except subprocess.SubprocessError:
            failed = True
        if failed:
            problems.append("`gh auth status` en échec — session GitHub expirée")
    if not (ROOT / ".git").exists():
        problems.append(f"{ROOT} n'est pas un dépôt git")

    trusted = workspace_trusted()
    if trusted is False:
        warnings.append(
            "ce dossier n'est pas approuvé : Claude Code ignorera les "
            "permissions de .claude/settings.json et les agents seront bloqués. "
            "Ouvrir Claude Code une fois ici et accepter la boîte de confiance, "
            "ou lancer avec --permission-mode bypassPermissions.")
    if args.permission_mode == "bypassPermissions":
        warnings.append("--permission-mode bypassPermissions : aucune commande "
                        "ne sera soumise à autorisation pendant tout le run.")

    for problem in problems:
        say(problem, "ERROR")
    for warning in warnings:
        say(warning, "WARN")
    return not problems


# --------------------------------------------------------------------------- #
# Une étape : un appel à Claude Code, une vague
# --------------------------------------------------------------------------- #

def leg_prompt(args):
    parts = ["/milestone"]
    if args.milestone:
        parts.append(args.milestone)
    parts += ["--width", str(args.width), "--waves", str(args.waves_per_leg)]
    # Sans cela, la vague relancée par le superviseur repartirait sur le produit
    # et ouvrirait un second run à côté de celui qu'elle est censée poursuivre.
    nature = getattr(args, "nature", "projet")
    if nature != "projet":
        parts += ["--nature", nature]
    if args.no_merge:
        parts.append("--no-merge")
    if args.yes:
        parts.append("--yes")
    return " ".join(parts)


def drain(stream, sink):
    for line in iter(stream.readline, ""):
        sink.append(line)
    try:
        stream.close()
    except OSError:
        pass


def call_env(args, leg_start):
    """L'environnement d'un appel `claude -p` — étape comme arbitrage.

    Sans surveillance, aucun arbitrage humain ne peut être posé : `pr_gate.py`
    lit `SPA_UNATTENDED` et refuse alors de merger les PR de périmètre sensible,
    qui restent ouvertes. Passer par l'environnement plutôt que par un drapeau du
    prompt est ce qui rend la règle vraie même si l'appelant l'oublie — tout
    `pr_gate.py` lancé dans l'appel en hérite sans avoir à y penser.
    """
    env = dict(os.environ)
    # Le démarrage d'une étape, dit explicitement : les agents de l'étape
    # précédente sont morts avec leur `claude -p`, et `reconcile` doit pouvoir
    # requeuer les tickets restés `running`. Séparée de `SPA_UNATTENDED`, qui ne
    # parle que des merges et disparaît sous `--no-merge` — s'y adosser rendait le
    # requeue inerte précisément dans le mode recommandé pour un jalon sensible,
    # et y ramenait la vague figée de #180.
    #
    # Un arbitrage ne la pose pas : il n'ouvre aucune vague, et requeuer les
    # `running` sous ses pieds lui retirerait ce qu'il est venu examiner.
    if leg_start:
        env["SPA_LEG_START"] = "1"
    if not args.no_merge:
        env["SPA_UNATTENDED"] = "1"
    # Et, à côté, ce que l'opérateur a autorisé d'avance. Les deux voyagent
    # ensemble mais ne disent pas la même chose : la première dit que personne ne
    # peut répondre, la seconde ce qui a déjà été répondu.
    #
    # Posée hors du `if`, et toujours — vide sous `--no-merge`, où il n'y a rien
    # de pré-autorisé. Ne la poser que sur une branche laisserait passer telle
    # quelle une variable héritée de l'environnement de l'appelant : un run armé
    # sans rien ouvrir hériterait alors des autorisations d'un autre.
    env[AUTHORISED_ENV] = ",".join(sorted(args.merge_sensitive))
    return env


def journal_quiet(since=None):
    """Depuis combien de secondes plus personne n'écrit dans le journal du run.

    Agents et orchestrateur y écrivent à chaque phase : c'est le seul battement
    qu'on ait de l'intérieur d'une étape. `since` borne la mesure au démarrage de
    l'appel — sans quoi une étape qui n'a jamais rien écrit hériterait du silence
    de la précédente et serait coupée dans la minute.

    Le battement du superviseur en est exclu (`journal_activity`) : il couvre le
    silence pour l'humain, il ne le comble pas pour le guetteur.
    """
    activity = journal_activity()
    if activity is None:
        return None
    return time.time() - max(activity, since or 0)


def stall_watch(args):
    """Le guetteur qui coupe une étape morte debout, sans attendre l'heure.

    La coupure au temps borne l'attente à deux heures. C'est ce qu'il faut pour
    une étape qui travaille — un ticket complet demande 25 à 40 minutes, trois
    en parallèle davantage — mais c'est deux heures perdues quand les agents sont
    tous arrêtés sur la même invite de permission à laquelle personne ne peut
    répondre. Le journal muet le dit bien avant, et le dit sans se tromper : une
    phase de ticket dure quelques minutes, jamais vingt-cinq.
    """
    minutes = getattr(args, "stall_minutes", STALL_MINUTES)
    if not minutes:
        return None
    started = time.time()

    def look():
        quiet = journal_quiet(started)
        if quiet is None or quiet < minutes * 60:
            return None
        return (f"journal muet depuis {human_delta(quiet)} — l'étape n'avance "
                f"plus, arrêt de l'appel pour la faire arbitrer")
    return look


def beat_watch(label, started, stall_minutes=None):
    """Ce qui inscrit la présence du superviseur dans le journal du run.

    Le guetteur ci-dessus lit le silence pour couper une étape morte ; celui-ci
    lit le même silence pour le **rendre lisible** — c'est le second volet de
    #186, et il vaut surtout quand rien ne va mal : une étape saine reste muette
    quinze à vingt-cinq minutes entre deux vagues, et personne ne peut alors la
    distinguer d'un run mort ni dans le journal ni dans `watch`.

    Deux règles, pour que la ligne ne devienne pas du bruit :

    - **on ne double personne.** Tant que les agents journalisent leurs phases,
      le battement se tait. Il ne parle que du silence ;
    - **il dit l'âge du silence et l'échéance de la coupure.** C'est ce qu'on
      vient chercher dans le journal quand plus rien n'y bouge : depuis combien
      de temps, et combien il reste avant que le dispositif tranche.

    Rend l'appelable à jouer à chaque tour de minute.
    """
    last = [started]

    def tick():
        quiet = journal_quiet(started)
        if quiet is None or quiet < JOURNAL_BEAT:
            return
        if time.time() - last[0] < JOURNAL_BEAT:
            return
        last[0] = time.time()
        message = (f"{label} en vol depuis {human_delta(time.time() - started)}"
                   f" — journal muet depuis {human_delta(quiet)}")
        if stall_minutes:
            message += f", coupure à {stall_minutes} min"
        journal(None, message, level="DEBUG", beat=True)
    return tick


def run_leg(args, index):
    """Un appel `claude -p` sur une vague, lu au fil de l'eau.

    Rend (issue, info_quota, résumé). `issue` vaut « quota » dès que le serveur
    a refusé la requête : le reste du flux n'a plus d'intérêt, l'appel est mort.
    """
    prompt = leg_prompt(args)
    command = [resolve_binary(args.claude), "-p", prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", args.permission_mode]
    if args.model:
        command += ["--model", args.model]

    say(f"vague {index} · claude -p \"{prompt}\"")
    if args.dry_run:
        return None, None, "simulation — rien lancé"

    LEGS_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = LEGS_DIR / f"leg-{index:03d}-{datetime.now():%Y%m%d-%H%M%S}.ndjson"
    return stream_call(args, command, raw_path, call_env(args, leg_start=True),
                       args.leg_timeout, "étape", stall=stall_watch(args))


# Les appels `claude -p` lancés par ce superviseur, tant qu'ils vivent. Un
# registre plutôt qu'un booléen : une étape et un arbitrage ne se recouvrent pas
# aujourd'hui, mais rien dans la boucle ne l'interdit, et le seul lecteur de ce
# registre — le rechargement de #373 — remplace le processus. Se tromper dans ce
# sens-là, c'est tuer un enfant vivant en écrivant dans son tube.
_IN_FLIGHT = set()
_IN_FLIGHT_LOCK = threading.Lock()


def track_call(process):
    with _IN_FLIGHT_LOCK:
        _IN_FLIGHT.add(process)


def untrack_call(process):
    with _IN_FLIGHT_LOCK:
        _IN_FLIGHT.discard(process)


def calls_in_flight():
    """Reste-t-il un `claude -p` vivant, lancé par ce superviseur ?

    C'est `poll()` qui fait foi, pas l'appartenance au registre : une inscription
    oubliée — exception entre le `Popen` et la fin de la lecture du flux — se
    résorbe d'elle-même dès que le processus meurt, alors qu'un registre tenu
    pour la vérité laisserait le superviseur refuser de se recharger jusqu'à la
    fin du run. Les morts sont retirés au passage, pour que le registre ne grossisse
    pas d'une entrée par étape sur un run de quarante.
    """
    with _IN_FLIGHT_LOCK:
        done = {process for process in _IN_FLIGHT if process.poll() is not None}
        _IN_FLIGHT.difference_update(done)
        return bool(_IN_FLIGHT)


def stream_call(args, command, raw_path, env, timeout_min, label, stall=None):
    """Lance l'appel et lit son flux `stream-json` — le corps commun.

    Une étape et un arbitrage n'ont ni le même prompt, ni le même modèle, ni le
    même délai ; ils ont exactement la même façon de mourir. Le quota refusé, le
    binaire introuvable, le processus qui ne rend jamais la main : dupliquer ce
    traitement, c'est accepter qu'une des deux copies finisse par ne plus
    reconnaître une fenêtre de quota qui se referme — et que le dispositif
    s'arrête là où il devait attendre.

    Rend (issue, info_quota, résumé).
    """
    try:
        process = subprocess.Popen(
            command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
    except (OSError, ValueError) as exc:
        # Sans cela, l'exception remonte, le superviseur meurt, et la veille le
        # relance toutes les cinq minutes pour qu'il remeure de la même façon.
        say(f"impossible de lancer « {command[0]} » : {exc}", "ERROR")
        return "lancement", None, f"{type(exc).__name__} : {exc}"

    track_call(process)
    errors = []
    pump = threading.Thread(target=drain, args=(process.stderr, errors), daemon=True)
    pump.start()

    # Une étape n'a plus de fin naturelle depuis que l'orchestrateur attend ses
    # agents (#180) : c'est ce qui permet à un ticket d'aller à son terme, mais
    # c'est aussi ce qui fait qu'un seul agent coincé — invite de permission sans
    # personne pour y répondre, commande qui ne rend jamais la main — retiendrait
    # le superviseur pour toujours. Et la veille, qui le voit battre, ne le
    # relancerait pas : le run serait mort en paraissant vivant.
    #
    # D'où cette coupure au temps. Elle ne juge pas le travail, elle borne
    # l'attente : les tickets déjà avancés gardent leur worktree, et l'étape
    # suivante les reprend là où ils en sont.
    expired = threading.Event()
    stalled = threading.Event()
    finished = threading.Event()

    def kill(why, flag):
        flag.set()
        say(why, "ERROR")
        try:
            process.terminate()
        except OSError:
            pass

    def cutoff():
        kill(f"{label} sans réponse depuis {timeout_min} min — arrêt de l'appel ; "
             f"les tickets engagés seront repris à l'étape suivante", expired)

    timer = threading.Timer(timeout_min * 60, cutoff)
    timer.daemon = True
    timer.start()

    # Le tour de minute, qui porte deux réponses au même fait — le journal ne dit
    # plus rien. Le guetteur, quand il y en a un, ne juge pas davantage que la
    # coupure au temps : il constate qu'il ne se passe plus rien et rend la main
    # au superviseur, qui fera arbitrer. Le battement, lui, écrit ce silence dans
    # le journal du run pour qu'on puisse le lire de l'extérieur (#186) — il n'a
    # pas de seuil et ne coupe rien, il est là surtout quand tout va bien.
    heartbeat = beat_watch(label, time.time(),
                           getattr(args, "stall_minutes", None) if stall else None)

    def watching():
        while not finished.wait(60):
            heartbeat()
            if stall:
                why = stall()
                if why:
                    kill(why, stalled)
                    return
    threading.Thread(target=watching, daemon=True).start()

    limit_info, summary, issue = None, None, None
    with open(raw_path, "w", encoding="utf-8") as raw:
        for line in process.stdout:
            raw.write(line)
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = message.get("type")
            if kind == "rate_limit_event":
                info = message.get("rate_limit_info") or {}
                status = info.get("status")
                if status == "rejected":
                    limit_info, issue = info, "quota"
                    say(f"quota {info.get('rateLimitType') or 'inconnu'} refusé "
                        f"par le serveur", "WARN")
                    break
                if status == "allowed_warning":
                    used = info.get("utilization")
                    say(f"quota {info.get('rateLimitType') or ''} à "
                        f"{int((used or 0) * 100)}%"
                        + (f", fenêtre jusqu'à {hm(info['resetsAt'])}"
                           if info.get("resetsAt") else ""), "WARN")
                    limit_info = info
                elif info.get("resetsAt"):
                    limit_info = info

            elif kind == "assistant" and args.echo:
                for block in (message.get("message") or {}).get("content") or []:
                    text = (block.get("text") or "").strip()
                    if text:
                        say("  claude · " + text.splitlines()[0][:140], "DEBUG")

            elif kind == "result":
                summary = message
                if message.get("is_error") and LIMIT_TEXT.search(
                        str(message.get("result") or "")):
                    issue = issue or "quota"

    finished.set()
    timer.cancel()
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
    pump.join(timeout=5)
    untrack_call(process)

    stderr = "".join(errors)
    if issue == "quota":
        # Une fenêtre qui se referme prime sur la façon dont l'appel est mort :
        # c'est la seule panne qu'on attend au lieu de la compter.
        pass
    elif stalled.is_set():
        # Distinguée du délai, et ce n'est pas une nuance : un appel coupé au
        # temps a peut-être travaillé jusqu'au bout de ses deux heures, tandis
        # qu'un appel coupé sur le silence n'écrivait plus rien depuis vingt-cinq
        # minutes. Le second est un motif d'arbitrage à lui seul ; le premier ne
        # l'est que parce qu'il laisse des tickets en plan.
        #
        # Le quota se relit malgré tout dans stderr : un `claude -p` qui attend
        # la réouverture de sa fenêtre est muet, donc coupé par le guetteur. Le
        # dire « stérile » ferait s'arrêter et se désarmer le dispositif après
        # deux étapes — au moment précis où il devait attendre.
        issue = "quota" if LIMIT_TEXT.search(stderr) else "silence"
    elif expired.is_set():
        # Nommer la panne, et ne pas la confondre avec un échec de l'appel : une
        # étape coupée au temps n'a pas démérité, elle a été retenue. Le compteur
        # de stérilité la compte comme les autres — trois de suite disent bien
        # que quelque chose ne passe plus.
        issue = "délai"
    elif issue is None and process.returncode not in (0, None):
        issue = "quota" if LIMIT_TEXT.search(stderr) else "échec"

    note = "terminée"
    if summary:
        cost = summary.get("total_cost_usd")
        subtype = summary.get("subtype") or "?"
        note = (f"{END_REASONS.get(subtype, subtype)} · "
                f"{summary.get('num_turns', '?')} tours"
                + (f" · {cost:.2f} $" if isinstance(cost, (int, float)) else ""))
    elif stderr.strip():
        note = stderr.strip().splitlines()[-1][:160]

    return issue, limit_info, note


# --------------------------------------------------------------------------- #
# L'arbitrage — le modèle qui tranche à la place de l'humain
# --------------------------------------------------------------------------- #

def arbiter_should(args, reasons):
    """Ce que le dossier répond : le motif, ou rien.

    On demande avant de dépenser. `milestone_arbiter.py should` regarde ce qui
    est gratuit — verdict du gate, statut des tickets, budget déjà consommé — et
    ne rend 0 que s'il y a matière. Une étape saine ne coûte donc aucun tour
    d'Opus 5, ce qui est la condition pour que l'arbitrage puisse rester armé en
    permanence sans ruiner personne.
    """
    if args.no_arbiter:
        return None
    argv = [sys.executable, str(ARBITER), "should",
            "--per-run", str(args.arbiter_budget)]
    for name in reasons:
        argv += ["--reason", name]
    try:
        proc = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=300)
    except (OSError, subprocess.SubprocessError) as exc:
        # Un dossier qu'on ne sait pas constituer ne doit pas arrêter le run : on
        # le dit, et le superviseur retombe sur son comportement d'avant.
        say(f"dossier d'arbitrage indisponible : {exc}", "WARN")
        return None
    lines = [line for line in (proc.stdout or "").strip().splitlines() if line.strip()]
    if proc.returncode != 0:
        if lines:
            say("  arbitre · " + lines[-1], "DEBUG")
        return None
    return lines[-1] if lines else "motif non nommé"


def run_arbiter(args, reasons, index):
    """Un appel d'arbitrage — Opus 5 sur le dossier du run.

    Le prompt est une commande, pas un cahier des charges : tout ce que l'arbitre
    doit savoir et respecter vit dans
    `.claude/commands/milestone-arbitrate.md`, versionné et relisible. Le passer
    ici ligne à ligne le rendrait invisible en revue et impossible à corriger
    sans toucher au superviseur.
    """
    motifs = ",".join(reasons)
    prompt = "/milestone-arbitrate" + (f" {motifs}" if motifs else "")
    command = [resolve_binary(args.claude), "-p", prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", args.permission_mode,
               "--model", args.arbiter_model]

    say(f"arbitrage {index} · claude -p \"{prompt}\" · {args.arbiter_model}", "WARN")
    if args.dry_run:
        return None, None, "simulation — aucun arbitrage lancé"

    LEGS_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = (LEGS_DIR /
                f"arbitrage-{index:03d}-{datetime.now():%Y%m%d-%H%M%S}.ndjson")
    # Pas de guetteur de silence sur un arbitrage : il passe l'essentiel de son
    # temps à lire des logs et des diffs sans rien journaliser, et le couper pour
    # cela reviendrait à interdire précisément le travail qu'on lui demande. Sa
    # borne est le délai, plus court que celui d'une étape.
    return stream_call(args, command, raw_path, call_env(args, leg_start=False),
                       args.arbiter_timeout, "arbitrage")


def arbitrate(args, reasons, index):
    """Un tour d'arbitrage, si le dossier en montre le besoin.

    Rend (lancé, issue, info_quota). `lancé` est faux quand il n'y avait rien à
    trancher, quand le budget est épuisé, ou quand l'arbitrage est débranché —
    trois cas où le superviseur doit reprendre son comportement d'avant plutôt
    que d'attendre un secours qui ne viendra pas.
    """
    why = arbiter_should(args, reasons)
    if why is None:
        return False, None, None

    say(f"arbitrage demandé — {why}", "WARN")
    journal("arbitrage", f"arbitrage {index} ouvert — {why}")
    issue, info, note = run_arbiter(args, reasons, index)
    say(f"arbitrage {index} rendu · {note}", "ERROR" if issue else "INFO")
    journal("arbitrage", f"arbitrage {index} rendu — {note}"
                         + (f" (interrompu : {issue})" if issue else ""))
    return True, issue, info


# --------------------------------------------------------------------------- #
# L'attente
# --------------------------------------------------------------------------- #

def wait_for_quota(args, info, stop_flag, source=None):
    """Inscrit la retenue, dort jusqu'au rafraîchissement, puis la lève.

    L'échéance vient du serveur (`resetsAt`) quand il l'a donnée ; sinon on
    prend la fenêtre pleine, quitte à attendre trop — se réveiller trop tôt
    coûterait un appel refusé de plus, et la même attente derrière.
    """
    until = info.get("resetsAt") if info else None
    kind = (info or {}).get("rateLimitType") or "five_hour"
    if until:
        until = float(until) + args.margin
        source = source or "annoncé par le serveur"
    else:
        until = time.time() + FALLBACK_WINDOW + args.margin
        source = source or "fenêtre de 5 h par défaut, le serveur n'a rien annoncé"

    runner("quota", "hold", "--until", str(until), "--kind", kind,
           "--reason", source,
           *(["--utilization", str(info["utilization"])]
             if info and info.get("utilization") is not None else []))
    say(f"quota épuisé — reprise à {hm(until)} "
        f"(dans {human_delta(until - time.time())}, {source})", "WARN")

    last_shown = 0
    while time.time() < until:
        if stop_flag.is_set():
            say("interruption pendant l'attente — la retenue reste inscrite", "WARN")
            return False
        # Un `quota clear` passé à la main depuis le shell doit réveiller tout
        # de suite : on relit le fichier plutôt que de dormir en aveugle.
        if quota_file_hold() is None:
            say("retenue levée à la main — reprise immédiate")
            return True
        left = until - time.time()
        if time.time() - last_shown >= args.tick:
            say(f"attente du quota · encore {human_delta(left)} "
                f"· reprise à {hm(until)}", "DEBUG")
            last_shown = time.time()
        time.sleep(min(15, max(1, left)))

    runner("quota", "clear")
    say("quota reconstitué — reprise du run")
    return True


# --------------------------------------------------------------------------- #
# Le code du superviseur lui-même
# --------------------------------------------------------------------------- #
#
# Un run d'outillage corrige souvent, précisément, ce fichier-ci — et le
# correctif reste inerte pour le run qui vient de le merger : le processus
# vivant garde le module qu'il a chargé au démarrage. C'est ainsi que #278, dont
# le mérite était de ne plus compter stérile une étape qui merge, s'est fait
# déclarer stérile par l'étape même qui l'avait mergé, neuf minutes plus tard.
#
# #369 en a livré la moitié la moins engageante : **voir**. Elle n'a servi à
# personne — aucun run ne lit ce `WARN`, et son seul lecteur possible est
# l'arbitre, qui n'arrive que sur un motif, `leg_sterile`, c'est-à-dire sur le
# faux signal que la source périmée produit. Le dispositif savait dire qu'il
# était périmé, mais uniquement à quelqu'un qui n'était là que parce qu'il
# l'était déjà. Trois fois de suite sur le run du 1er septembre, sept arbitrages
# sur douze consommés — et le budget épuisé appelle `retire()` : le jalon meurt
# d'un compteur faux.
#
# #373 pose donc l'acte : un `os.execv()` entre deux étapes. Ce qu'il exige, et
# qui est vérifié plus bas point par point — aucun `claude -p` en vol, le
# superviseur étant le parent de l'enfant qu'il tuerait en se remplaçant ; le
# battement réarmé, faute de quoi la veille lancerait un second superviseur
# pendant la seconde de flottement ; l'intention rejouée telle quelle, moins les
# étapes déjà faites.
#
# Ce qu'il coûte, assumé plutôt que découvert : `execv` remet à zéro `legs`,
# `dry_legs`, `barren`, `rescued`, `seen_commits` et `seen_merges`. Les deux
# derniers sont rebasés sur l'état réel du dépôt au redémarrage — ils en sont
# donc plus justes, pas moins. Les trois du milieu comptaient un enlisement
# mesuré avec le code périmé : les perdre, c'est perdre exactement ce que le
# correctif vient corriger. Seul `legs` porte à conséquence, et c'est pourquoi
# `--max-legs` voyage dans l'intention.
#
# `arbitrages` repart lui aussi à zéro, et il n'est pas reporté : ce compteur-là
# n'est que le second verrou du budget d'arbitrage, celui qui tient même quand
# l'arbitre meurt avant d'inscrire sa décision. Le premier — `--per-run`, compté
# par `milestone_arbiter.py should` sur le dossier du run — survit à l'`execv` et
# continue de borner la dépense. Le reporter demanderait de le faire voyager par
# la ligne de commande, où il se confondrait avec `--arbiter-budget` que
# l'opérateur pose ; la borne du dossier suffit.

SOURCE = Path(__file__).resolve()
SOURCE_DRIFT_NOTE = (
    "le code du superviseur a changé depuis son démarrage "
    "(scripts/milestone_supervise.py) — le processus vivant exécute toujours "
    "l'ancien : redémarrer le superviseur pour que le correctif prenne effet"
)


def source_fingerprint(path=None):
    """L'empreinte de la source du superviseur, ou None si elle est illisible.

    Un hachage du contenu plutôt que le couple (mtime, taille) : `git pull` et
    `git checkout` réécrivent les fichiers qu'ils traversent, y compris pour y
    remettre le même contenu — une empreinte fondée sur la date d'écriture
    annoncerait alors un correctif qui n'existe pas, et le premier `WARN` de
    trop est celui qui fait cesser de les lire. Une centaine de kilo-octets
    relus une fois par étape ne coûtent rien.
    """
    try:
        return hashlib.sha256(Path(path or SOURCE).read_bytes()).hexdigest()
    except OSError:
        return None


def source_drifted(before, after):
    """La source a-t-elle changé entre ces deux empreintes ?

    L'inconnu ne déclenche rien : une empreinte manquante — fichier illisible au
    démarrage, ou au moment de la comparaison — ne prouve aucun changement, et
    un faux positif enverrait chercher un correctif qui n'a jamais été mergé.
    """
    if before is None or after is None:
        return False
    return before != after


def announce_source_drift(before):
    """Dire, en fin d'étape, que le code du superviseur a changé sous lui.

    Dit à **chaque** étape tant que l'écart dure, et non une seule fois : la
    phrase reste vraie jusqu'au redémarrage, et l'humain qui vient lire le
    journal arrive rarement à l'étape où l'écart est apparu. Une ligne toutes
    les quarante minutes n'est pas du bruit — c'est exactement ce qui manquait à
    celui qui cherchait pourquoi le dispositif s'entêtait sur une panne déjà
    corrigée.

    Dans les deux journaux, parce qu'ils n'ont pas les mêmes lecteurs : celui du
    superviseur pour qui regarde le dispositif, celui du run pour qui regarde le
    jalon. Aucun statut : ce n'est pas un état du run qui change.

    Rend True si l'écart a été annoncé.
    """
    if not source_drifted(before, source_fingerprint()):
        return False
    say(SOURCE_DRIFT_NOTE, "WARN")
    journal(None, SOURCE_DRIFT_NOTE, level="WARN")
    return True


def why_not_reload(args, before, after, legs, halting=False):
    """Ce qui empêche de se recharger maintenant — ou None s'il faut le faire.

    Séparée de l'acte, parce que c'est la moitié qui se teste : `execv` remplace
    le processus, et un banc d'essai qui l'appelle pour de vrai ne rend jamais
    son verdict. Toutes les conditions se lisent ici, dans l'ordre du moins cher
    au plus cher, et le cas ordinaire — la source n'a pas bougé — est le premier.
    """
    if not source_drifted(before, after):
        return "source inchangée"
    if getattr(args, "no_reload", False):
        return "rechargement débranché (--no-reload)"
    if getattr(args, "dry_run", False):
        # `--dry-run` montre l'appel qui serait fait ; se remplacer par un autre
        # processus n'est pas montrer, c'est faire.
        return "--dry-run"
    if halting:
        # Un Ctrl-C ne survit pas à `execv` : se recharger ici ressusciterait un
        # superviseur dont on vient de demander l'arrêt, et rien ne le redirait.
        return "arrêt demandé"
    if calls_in_flight():
        # La condition qui compte. Le superviseur est le parent du `claude -p` :
        # se remplacer pendant qu'un enfant écrit dans son tube le tue, avec
        # l'étape et les tickets qu'il portait.
        return "un appel claude -p est encore en vol"
    if legs >= getattr(args, "max_legs", 0):
        # Plus une étape à donner : le processus neuf s'arrêterait au premier
        # tour de boucle. Recharger pour cela coûterait la relance et écrirait
        # dans le journal un rechargement qui n'a servi à rien.
        return "plus d'étape autorisée (--max-legs)"
    return None


def reload_intent(args, legs):
    """L'intention à rejouer après un rechargement — celle-ci, moins ce qui a servi.

    `execv` repart à `legs = 0`. Sans report, chaque rechargement rendrait au run
    un budget d'étapes entier : `--max-legs 40` ne bornerait plus le run mais la
    vie d'un processus, et un jalon qui se recharge à chaque étape tournerait
    sans borne. Le budget voyage donc dans l'intention, décompté de ce que ce
    processus-ci a déjà consommé — et il repart aussi par la ligne de commande,
    l'intention n'étant pas toujours sur le disque.

    Le reste est l'intention de ce processus, telle quelle : `armed` et
    `expires` sont refaits comme à n'importe quel démarrage, ce qu'un
    rechargement est. La péremption à quinze jours protège d'une intention
    *oubliée* ; ici, le superviseur vient de terminer une étape.
    """
    intent = dict(intent_of(args))
    intent["max_legs"] = max(int(args.max_legs) - int(legs), 1)
    return intent


def exec_replace(argv):
    """Remplacer ce processus par `argv`. Ne rend jamais la main, sauf échec.

    Le détour par la citation n'est pas une précaution : sur Windows, `os.execv`
    passe par `_wexecv`, qui **concatène les arguments séparés par des espaces
    sans les citer**. Le chemin de ce dépôt en contient deux — et une esperluette
    — si bien que le processus neuf mourrait sur

        can't open file 'D:\\spyle\\Spa': [Errno 2] No such file or directory

    et que le jalon « S1 — Fondations » arriverait découpé en deux arguments. Le
    rechargement serait alors inerte de la façon la plus retorse qui soit : le
    superviseur disparaîtrait à chaque correctif de sa source, et la veille le
    relancerait cinq à onze minutes plus tard — c'est-à-dire exactement le
    contournement manuel que ce ticket devait supprimer.

    On cite donc chaque argument à l'avance, avec les règles de
    `CommandLineToArgvW` que `list2cmdline` connaît : leur concaténation par le
    CRT redonne la ligne attendue. Sur POSIX, `execv` reçoit un vrai tableau et
    citer ferait entrer les guillemets dans la valeur.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    if os.name == "nt":
        argv = [subprocess.list2cmdline([word]) for word in argv]
    os.execv(sys.executable, argv)


def reload_source(args, before, legs, halting=False):
    """Se remplacer par un superviseur qui exécute la source d'aujourd'hui.

    Rend False si le rechargement n'a pas eu lieu — un `execv` réussi, lui, ne
    rend jamais la main, et tout ce qui suit son appel n'existe que pour le cas
    où il échoue.
    """
    after = source_fingerprint()
    why = why_not_reload(args, before, after, legs, halting)
    if why is not None:
        # Dit seulement quand l'écart est réel : sur une source stable, c'est le
        # cas ordinaire de chaque étape et cela n'apprendrait rien. Sur un écart
        # réel, en revanche, c'est la ligne qui explique pourquoi le dispositif
        # n'a pas fait ce qu'il annonce savoir faire.
        if source_drifted(before, after):
            say(f"rechargement différé — {why}", "DEBUG")
        return False

    intent = reload_intent(args, legs)
    # Réécrite seulement si elle existait déjà : un superviseur lancé
    # `--no-watchdog` n'a rien armé, et lui poser une intention en se rechargeant
    # lui donnerait une reprise automatique que personne n'a demandée. Le
    # nouveau processus la reçoit de toute façon par sa ligne de commande — mais
    # la veille peut se réveiller dans la seconde de flottement, et elle ne lit
    # que le disque : sans cette écriture, elle y trouverait le budget d'étapes
    # d'avant.
    if INTENT.exists():
        try:
            write_intent(intent)
        except OSError as exc:
            # Un disque qui refuse l'écriture ne doit pas empêcher le
            # rechargement : l'intention reste celle d'avant, `--max-legs` n'y
            # est pas décompté, et c'est la seule conséquence.
            say(f"intention non réécrite avant rechargement : {exc}", "WARN")

    note = ("le code du superviseur a changé — rechargement de "
            f"scripts/milestone_supervise.py : {before[:12]} → {after[:12]} "
            f"· {legs} étape(s) faites, {intent['max_legs']} restante(s)")
    say(note, "WARN")
    journal(None, note, level="WARN")

    # Le battement est réarmé **avant** de partir. `execv` n'exécute aucun
    # `atexit` : le fil qui bat meurt avec l'image sans effacer le fichier — ce
    # qui est voulu, la veille ne doit pas croire le superviseur mort — mais le
    # processus neuf met une ou deux secondes à reprendre le battement. Un
    # battement frais couvre cet intervalle.
    beat()

    # `--reloaded` n'est pas décoratif : sans lui, le processus neuf trouve le
    # battement qu'on vient de rafraîchir et la ligne qu'on vient d'écrire dans
    # le journal du run, se croit en double, et rend la main. Le rechargement
    # tuerait alors le run à chaque correctif — la panne même qu'il corrige.
    argv = [sys.executable, str(SOURCE), *intent_argv(intent), "--reloaded"]
    # Ce qui est un choix de *ce* processus et ne vit pas dans l'intention : le
    # perdre ferait qu'un superviseur lancé sans veille s'en arme une au premier
    # rechargement, et qu'un `--echo` demandé pour regarder travailler se taise
    # au moment où l'on regarde.
    if getattr(args, "no_watchdog", False):
        argv.append("--no-watchdog")
    if getattr(args, "echo", False):
        argv.append("--echo")
    if getattr(args, "force", False):
        # Le préflight que l'opérateur a explicitement décidé d'outrepasser —
        # `gh auth status` en échec, `claude` hors du PATH d'un service. Le
        # perdre ferait mourir le processus neuf là même où le premier avait
        # reçu l'ordre de passer outre : `hold_off` de trente minutes, code 2, et
        # un rechargement qui tue le run qu'il devait sauver. Le double
        # superviseur, lui, reste couvert par `--reloaded`.
        argv.append("--force")
    if getattr(args, "max_hours", None):
        # Le garde-fou de durée est compté depuis `START`, que `execv` remet à
        # l'instant du redémarrage : le report exact demanderait de le persister
        # aussi. On rejoue la borne telle quelle — elle reste une borne, moins
        # serrée qu'annoncée, plutôt que de disparaître.
        argv += ["--max-hours", str(args.max_hours)]

    try:
        exec_replace(argv)
    except OSError as exc:
        # `execv` qui échoue laisse le processus intact. On le dit et on
        # poursuit avec l'ancien code : c'est exactement l'état d'avant ce
        # correctif, pas une panne de plus.
        say(f"rechargement impossible : {exc}", "ERROR")
        return False
    return True  # inatteignable — `execv` ne revient pas


# --------------------------------------------------------------------------- #

def retire(why):
    """Débranche le dispositif : plus de veille, plus d'intention à relancer.

    Appelé quand il n'y a plus rien à reprendre — jalon déroulé, arrêt demandé,
    run bloqué. Sans cela, la tâche planifiée ressusciterait un superviseur
    toutes les cinq minutes pour lui faire constater la même chose.
    """
    say(f"dispositif débranché — {why}")
    disarm_watchdog(quiet=True)
    for path in (INTENT, HEARTBEAT, BACKOFF):
        try:
            path.unlink()
        except OSError:
            pass


def supervise(args):
    stop_flag = threading.Event()

    def interrupt(signum, frame):
        stop_flag.set()
        say("arrêt demandé (Ctrl-C) — fin après l'étape en cours", "WARN")

    signal.signal(signal.SIGINT, interrupt)
    start_beating()

    say(f"superviseur ouvert · jalon {args.milestone or '(le plus proche)'} "
        f"· nature {getattr(args, 'nature', 'projet')} · largeur {args.width} "
        f"· {'PR seules' if args.no_merge else 'merge automatique'}")
    say(f"journal du superviseur : {SUPERVISOR_LOG}")
    say("suivre le run : python scripts/milestone_run.py watch")

    # S'armer soi-même : un superviseur lancé à la main doit laisser derrière lui
    # de quoi le ressusciter. C'est idempotent, donc sans effet s'il l'est déjà.
    if not args.dry_run and not args.no_watchdog:
        save_intent(args)
        if not watchdog_armed():
            arm_watchdog(args.every)

    # Une retenue héritée d'un plantage précédent : on la purge avant de juger.
    held = quota_file_hold()
    if held:
        say("retenue de quota trouvée en arrivant", "WARN")
        if not wait_for_quota(args, {"resetsAt": float(held["until"]) - args.margin,
                                     "rateLimitType": held.get("kind")}, stop_flag,
                              source="retenue déjà inscrite dans le run"):
            return 1

    legs, barren, dry_legs, arbitrages = 0, 0, 0, 0
    # Un secours ne se redonne pas deux fois de suite sans que rien n'ait bougé
    # entre-temps. Sans ce verrou, un run que l'arbitre ne sait pas débloquer
    # ferait relancer un arbitrage par étape jusqu'à épuisement du budget, pour
    # le même verdict à chaque fois. Il retombe dès qu'un ticket avance.
    rescued = False
    # Les commits et les merges déjà là en arrivant ne sont l'œuvre d'aucun leg
    # de ce superviseur : on les tient pour vus, faute de quoi le premier leg
    # passerait pour productif sans avoir rien produit.
    seen_commits, seen_merges = work_commits(), merged_tickets()
    # Le code que ce processus exécute, tel qu'il était à l'instant du
    # chargement. Retenu une fois et jamais rafraîchi : c'est l'écart avec le
    # **démarrage** qui compte, puisque c'est le module de ce démarrage-là qui
    # tourne encore.
    source_seen = source_fingerprint()

    def rescue(reasons):
        """Faire arbitrer, si le budget le permet — (lancé, panne, info_quota).

        Le budget est compté ici **en plus** du compteur tenu par le dossier :
        celui-ci ne s'incrémente que si l'arbitre inscrit sa décision, et un
        arbitre mort avant d'avoir rien écrit laisserait le sien à zéro. Deux
        compteurs pour une seule borne, parce que celui qui protège du gaspillage
        doit être celui qui ne dépend de personne.
        """
        nonlocal arbitrages
        if arbitrages >= args.arbiter_budget:
            return False, None, None
        ran, issue, info = arbitrate(args, reasons, arbitrages + 1)
        if ran:
            arbitrages += 1
        return ran, issue, info

    while not stop_flag.is_set():
        if legs >= args.max_legs:
            say(f"{legs} étapes atteintes (--max-legs) — arrêt", "WARN")
            return 1

        gate = runner("gate")
        verdict = gate.returncode
        for line in (gate.stdout or "").strip().splitlines():
            say("  gate · " + line, "DEBUG")

        if verdict == NO_RUN and legs > 0:
            say("plus rien à traiter — jalon déroulé")
            # Un dernier tour, et il n'a rien de cérémonial : les anomalies d'un
            # run ne se lisent qu'une fois le jalon déroulé, quand on peut
            # comparer ce qui a coincé d'un ticket à l'autre. C'est là que
            # l'arbitre ouvre les issues d'amélioration ; passé cet instant,
            # personne ne relira ces logs.
            rescue(["fin_de_run"])
            retire("jalon déroulé")
            return 0
        if verdict == STOP:
            # Le seul ordre que l'arbitrage ne discute pas. `stop` est posé à la
            # main, par quelqu'un qui a décidé que ce run devait cesser : le faire
            # arbitrer reviendrait à le lui reprendre.
            say("arrêt demandé dans le run — le superviseur s'efface", "WARN")
            retire("arrêt demandé dans le run")
            return 0
        if verdict == PAUSE:
            # Le verrou se lit **avant** de dépenser : un secours déjà donné sans
            # que rien n'ait bougé depuis ne sera pas relu, et l'appeler quand
            # même reviendrait à payer un tour d'Opus 5 pour jeter sa décision
            # une ligne plus bas, juste avant de s'effacer.
            if not rescued:
                ran, arb_issue, arb_info = rescue(["gate_pause"])
                if arb_issue == "quota":
                    if not wait_for_quota(args, arb_info or {}, stop_flag):
                        return 1
                    continue
                if ran:
                    # L'arbitre a tranché ce qui retenait le gate — un ticket
                    # tombé relancé, écarté, ou sa PR débloquée. On relit le
                    # verdict plutôt que de s'effacer : c'est exactement le point
                    # où le dispositif rendait la main et perdait la nuit.
                    rescued = True
                    say("le gate est relu après arbitrage", "WARN")
                    continue
            say("pause demandée dans le run — le superviseur s'efface. "
                "`milestone_run.py go`, puis relancer `/milestone`, pour "
                "repartir", "WARN")
            retire("pause demandée dans le run")
            return 0
        if verdict == QUOTA:
            held = quota_file_hold()
            if held and not wait_for_quota(
                    args, {"resetsAt": float(held["until"]) - args.margin,
                           "rateLimitType": held.get("kind")}, stop_flag,
                    source="retenue déjà inscrite dans le run"):
                return 1
            continue

        before = progress_count(args.no_merge)
        legs += 1
        started = time.time()
        journal("leg_started", f"étape {legs} — une vague, largeur {args.width}")

        issue, info, note = run_leg(args, legs)
        elapsed = human_delta(time.time() - started)

        # Ce que le leg a rendu durable — commits sur les branches de tickets
        # **et** merges que le run s'est imputés. Les deux, parce qu'une étape
        # qui va jusqu'au merge ne laisse plus de branche : ne compter que les
        # commits ferait passer la plus productive des étapes pour la plus
        # stérile (#278).
        if args.dry_run:
            fresh, merged = set(), set()
        else:
            fresh, merged = leg_production(seen_commits, seen_merges)
            seen_commits |= fresh
            seen_merges |= merged
            note = f"{note} · {production_note(fresh, merged)}"

        sterile = not args.dry_run and issue is None and not fresh and not merged
        journal("leg_ended", f"étape {legs} en {elapsed} — {note}",
                level="WARN" if issue or sterile else "INFO")
        say(f"vague {legs} rendue en {elapsed} · {note}",
            "WARN" if issue or sterile else "INFO")

        # L'étape vient peut-être de merger un correctif de ce fichier-ci. Le
        # point du cycle est celui-là et pas un autre : l'appel de l'étape est
        # terminé, celui de l'arbitrage n'a pas commencé, aucun `claude -p` n'est
        # en vol. On se recharge donc ici (#373) — et `reload_source` ne rend la
        # main que s'il a refusé, auquel cas il reste à le dire à l'humain, ce
        # que #369 avait posé.
        #
        # Sauf sur une étape coupée par le quota : la retenue n'est inscrite que
        # plus bas, par `wait_for_quota`, et l'`info` qui porte `resetsAt` ne
        # survit pas à l'`execv`. Se recharger ici ferait démarrer le processus
        # neuf sans `quota.json` : il ne trouverait aucune retenue à respecter et
        # brûlerait aussitôt une étape de son budget dans une fenêtre encore
        # fermée. On inscrit la retenue et on attend d'abord ; on se recharge
        # ensuite, juste avant l'étape suivante.
        if issue != "quota":
            if not reload_source(args, source_seen, legs,
                                 halting=stop_flag.is_set()):
                announce_source_drift(source_seen)

        if args.dry_run:
            say("--dry-run : une seule étape simulée")
            return 0

        if issue == "quota":
            # Un leg coupé par le quota n'a pas démérité : il n'a pas eu le temps.
            # Le compter stérile désarmerait le dispositif pour la seule raison
            # que l'API s'est refermée.
            if not wait_for_quota(args, info or {}, stop_flag):
                return 1
            # La fenêtre est rouverte, la retenue levée, et l'étape suivante n'a
            # pas commencé : c'est ici que se prend le correctif que cette
            # étape-ci avait mergé avant de manquer de quota.
            if not reload_source(args, source_seen, legs,
                                 halting=stop_flag.is_set()):
                announce_source_drift(source_seen)
            continue

        dry_legs = sterile_streak(dry_legs, fresh or merged, issue)
        after = progress_count(args.no_merge)
        progressed = before is None or after is None or after > before
        barren = 0 if progressed else barren + 1
        if progressed and after is not None:
            say(f"{after} ticket(s) aboutis sur le jalon")
            # Quelque chose a abouti : le secours précédent a servi, et le
            # suivant redevient légitime.
            rescued = False

        # Ce que l'étape laisse derrière elle, dit dans les termes du dossier.
        # Le reste — tickets tombés, PR verte non mergée, gate qui retient — est
        # relu par `milestone_arbiter.py should`, qui voit le run tel qu'il est
        # plutôt que tel que cette boucle s'en souvient.
        reasons = []
        if issue in ("délai", "silence"):
            reasons.append("leg_delai")
        if dry_legs >= DRY_LEGS_LIMIT:
            reasons.append("leg_sterile")
        if barren >= args.patience:
            reasons.append("patience")

        # Un enlisement déjà arbitré sans que rien n'ait bougé depuis ne sera pas
        # relu : les compteurs resteront tels quels et la boucle s'arrêtera juste
        # en dessous. Appeler l'arbitre à cet instant, ce serait payer un tour
        # d'Opus 5 pour jeter sa décision. Les motifs que seul le dossier voit —
        # un ticket tombé, une PR en souffrance — n'ont pas ce verrou : ils ne
        # remettent aucun compteur à zéro.
        if reasons and rescued:
            ran, arb_issue, arb_info = False, None, None
        else:
            ran, arb_issue, arb_info = rescue(reasons)
        if arb_issue == "quota":
            if not wait_for_quota(args, arb_info or {}, stop_flag):
                return 1
            continue
        if ran and reasons:
            # L'enlisement vient d'être traité par quelqu'un : les compteurs
            # comptaient une situation qui n'a plus cours. Les laisser courir
            # ferait s'arrêter le dispositif à l'étape suivante pour une cause
            # déjà levée — et un seul secours par situation, faute de quoi un
            # arbitre impuissant relancerait la boucle indéfiniment.
            rescued, dry_legs, barren = True, 0, 0
            say("enlisement arbitré — compteurs remis à zéro, on repart", "WARN")

        if dry_legs >= DRY_LEGS_LIMIT:
            # Le travail existe peut-être dans les worktrees, mais il n'est ni
            # commité ni mergé : le leg suivant le refera à l'identique, pour le
            # même prix. On s'arrête et on dit où regarder.
            say(f"{dry_legs} legs de suite sans un commit ni un merge de plus. "
                "Le travail n'atteint pas la phase de commit — il ne survivra "
                "pas au prochain `reconcile`. Arrêt et désarmement : regarder "
                "les worktrees de `git worktree list`, commiter ce qui s'y "
                "trouve, puis relancer. Voir #138.", "ERROR")
            journal("blocked", f"{dry_legs} legs sans commit ni merge — "
                               "superviseur arrêté (#138)")
            retire(f"{dry_legs} legs sans commit ni merge")
            return 1

        if barren >= args.patience:
            # Ce n'est plus une question de quota : relancer indéfiniment un run
            # qui n'avance pas brûlerait des jetons pour rien. On débranche tout,
            # en le disant — c'est le seul cas où l'humain doit revenir.
            say(f"{barren} étapes de suite sans un ticket de plus — ce n'est pas "
                "une malchance. Arrêt et désarmement : lire "
                "`python scripts/milestone_run.py log --level WARN`, puis "
                "relancer `/milestone` une fois la cause levée.", "ERROR")
            journal("blocked", f"{barren} étapes sans avancement — superviseur arrêté")
            retire(f"{barren} étapes sans avancement")
            return 1

        if args.max_hours and (time.time() - START) > args.max_hours * 3600:
            say(f"--max-hours {args.max_hours} atteint — la veille prendra le relais",
                "WARN")
            return 0

    return 0


START = time.time()


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("milestone", nargs="?",
                        help="jalon à dérouler (défaut : l'ouvert le plus proche)")
    parser.add_argument("--width", type=int, default=3,
                        help="agents simultanés dans une vague")
    parser.add_argument("--nature", default="projet",
                        choices=("projet", "outillage", "toutes"),
                        help="ce que le run déroule : le produit (défaut), "
                             "l'outillage — scripts/, .claude/ —, ou les deux")
    parser.add_argument("--waves-per-leg", type=int, default=1,
                        help="vagues traitées par appel à Claude Code")
    parser.add_argument("--no-merge", action="store_true",
                        help="tout mener jusqu'à la PR, sans rien merger")
    parser.add_argument("--merge-sensitive", default="", metavar="PÉRIMÈTRES",
                        help="pré-autorise le merge de ces périmètres sensibles, "
                             "séparés par des virgules ({}, ou « {} »). "
                             "Absente, aucun n'est mergé sans relecture."
                             .format(", ".join(sorted(SCOPE_KEYS)), ALL_SCOPES))
    parser.add_argument("--yes", action="store_true",
                        help="ne demander aucun arbitrage — indispensable sans surveillance")
    parser.add_argument("--model", help="modèle passé à claude -p")
    parser.add_argument("--claude", default="claude", help="binaire Claude Code")
    parser.add_argument("--permission-mode", default="acceptEdits",
                        choices=["acceptEdits", "auto", "bypassPermissions",
                                 "dontAsk", "manual", "plan"])
    parser.add_argument("--margin", type=int, default=90,
                        help="secondes d'attente en plus après le rafraîchissement")
    parser.add_argument("--tick", type=int, default=300,
                        help="secondes entre deux lignes de compte à rebours")
    parser.add_argument("--max-legs", type=int, default=40,
                        help="garde-fou : nombre d'appels à Claude Code")
    parser.add_argument("--max-hours", type=float,
                        help="garde-fou : durée totale du superviseur")
    parser.add_argument("--leg-timeout", type=float, default=120,
                        metavar="MINUTES",
                        help="au-delà, l'appel d'une étape est coupé et ses "
                             "tickets repris à l'étape suivante (défaut 120)")
    parser.add_argument("--patience", type=int, default=3,
                        help="étapes sans avancement tolérées avant l'arrêt")
    parser.add_argument("--echo", action="store_true",
                        help="recopier ce que dit Claude, ligne par ligne")
    parser.add_argument("--dry-run", action="store_true",
                        help="montrer l'appel qui serait fait, et s'arrêter")
    parser.add_argument("--force", action="store_true",
                        help="passer outre le préflight, ou un superviseur déjà vivant")
    parser.add_argument("--no-reload", action="store_true",
                        help="ne pas se recharger quand scripts/milestone_supervise.py "
                             "change sous le processus — l'écart est alors seulement "
                             "signalé, et la reprise du correctif redevient manuelle")
    parser.add_argument("--reloaded", action="store_true",
                        help="ce superviseur en remplace un autre par execv — "
                             "usage interne, il ne se croit pas en double du "
                             "processus dont il prend la place")

    arbitre = parser.add_argument_group(
        "arbitrage", "le modèle qui tranche à la place de l'humain")
    arbitre.add_argument("--no-arbiter", action="store_true",
                         help="ne faire arbitrer aucun blocage — le superviseur "
                              "retrouve son comportement d'avant : au premier "
                              "ticket tombé, il rend la main")
    arbitre.add_argument("--arbiter-model", default=ARBITER_MODEL,
                         help=f"modèle de l'arbitre (défaut : {ARBITER_MODEL})")
    arbitre.add_argument("--arbiter-budget", type=int, default=ARBITER_BUDGET,
                         help="arbitrages autorisés sur tout le run "
                              f"(défaut {ARBITER_BUDGET})")
    arbitre.add_argument("--arbiter-timeout", type=float, default=ARBITER_TIMEOUT,
                         metavar="MINUTES",
                         help="au-delà, l'appel d'arbitrage est coupé "
                              f"(défaut {ARBITER_TIMEOUT})")
    arbitre.add_argument("--stall-minutes", type=float, default=STALL_MINUTES,
                         metavar="MINUTES",
                         help="journal du run muet plus longtemps que cela : "
                              "l'étape est coupée et portée à l'arbitrage sans "
                              f"attendre --leg-timeout (défaut {STALL_MINUTES}, "
                              "0 pour débrancher)")

    veille = parser.add_argument_group(
        "veille", "la tâche planifiée qui ressuscite le superviseur")
    veille.add_argument("--arm", action="store_true",
                        help="armer la veille et rendre la main (appelé par `start`)")
    veille.add_argument("--disarm", action="store_true",
                        help="tout débrancher : plus aucune reprise automatique")
    veille.add_argument("--watchdog", action="store_true",
                        help="un réveil de la tâche planifiée — usage interne")
    veille.add_argument("--state", action="store_true",
                        help="qui veille, sur quoi, et où en est le quota")
    veille.add_argument("--every", type=int, default=5,
                        help="minutes entre deux réveils de la veille")
    veille.add_argument("--no-watchdog", action="store_true",
                        help="ne pas armer la veille — la reprise redevient manuelle")
    args = parser.parse_args()

    # Une pré-autorisation mal orthographiée ne doit pas se découvrir en lisant
    # un journal, des heures plus tard, sur une PR restée ouverte : c'est ici, et
    # seulement ici, qu'un humain est encore devant le terminal.
    scopes, unknown = parse_scopes(args.merge_sensitive)
    if unknown and SCOPES_KNOWN:
        parser.error("périmètre inconnu : {} — attendus : {}, ou « {} »".format(
            ", ".join(unknown), ", ".join(sorted(SCOPE_KEYS)), ALL_SCOPES))
    if not SCOPES_KNOWN and args.merge_sensitive.strip():
        # Registre illisible : ce n'est pas la liste de l'opérateur qui est
        # fautive, c'est `pr_gate.py`. Refuser de démarrer punirait la reprise
        # automatique d'une panne qui la concerne à peine — elle n'a alors qu'à
        # ne rien pré-autoriser, ce que `parse_scopes()` a déjà fait.
        #
        # Sur toute la valeur, et pas seulement sur `unknown` : sans le registre,
        # « all » est syntaxiquement reconnu et n'ouvre pourtant rien. Ne rien
        # dire dans ce cas-là serait taire précisément l'armement le plus large
        # que l'opérateur ait cru poser.
        say("registre des périmètres illisible (pr_gate.py) : « {} » n'ouvre "
            "rien. Aucun périmètre sensible ne sera mergé sans relecture."
            .format(args.merge_sensitive.strip()), "WARN")
    if scopes and args.no_merge:
        # Deux consignes qui se contredisent : l'une dit de ne rien merger,
        # l'autre nomme ce qui doit l'être. En appliquer une en silence, c'est
        # choisir à la place de l'opérateur sur le seul réglage qu'il ait voulu
        # poser lui-même.
        parser.error("--merge-sensitive et --no-merge se contredisent : "
                     "--no-merge ne merge rien, il n'y a rien à pré-autoriser")
    args.merge_sensitive = scopes

    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    # Les modes qui ne lancent aucun agent, avant tout le reste : la veille se
    # réveille toutes les cinq minutes et n'a rien à faire d'un préflight.
    if args.watchdog:
        return cmd_watchdog(args)
    if args.state:
        return cmd_state(args)
    if args.disarm:
        retire("désarmement demandé")
        return 0
    if args.arm:
        # Le préflight et l'annonce de la politique de merge étaient jusqu'ici
        # hors d'atteinte de ce chemin : `--arm` rendait la main avant eux,
        # alors que c'est précisément lui qu'appelle `/milestone`. Armer était
        # donc silencieux, et un dossier de travail non approuvé n'était
        # découvert qu'au premier réveil de la veille — des heures plus tard,
        # après que les agents eurent échoué en silence faute de permissions.
        if not preflight(args) and not args.force:
            say("préflight en échec — rien n'a été armé (`--force` pour passer "
                "outre)", "ERROR")
            # Ne rien armer ne veut pas dire que rien n'est armé : une veille
            # d'un run précédent survivrait, et continuerait de ressusciter un
            # superviseur sur l'ancienne intention. Le taire laisserait
            # l'opérateur croire le dispositif à l'arrêt.
            if watchdog_armed():
                say("une veille d'un run précédent est toujours enregistrée et "
                    "continuera de tourner sur l'ancienne intention — "
                    "`--disarm` pour la retirer.", "WARN")
            return 2
        announce_merge_policy(args)
        # Armer écrase l'intention précédente : si elle portait une autre
        # nature, une file cesse d'être reprise, et il faut le dire.
        relais = nature_relayed(load_intent(), getattr(args, "nature", "projet"))
        if relais:
            say(relais, "WARN")
        save_intent(args)
        # `--no-watchdog` était accepté puis ignoré sur ce chemin : l'intention
        # était inscrite et la veille armée quand même. Seul `arm_supervision()`
        # filtrait, côté appelant — un garde-fou que l'appelant doit penser à
        # demander, c'est-à-dire celui qui ne se déclenche pas.
        if args.no_watchdog:
            say("veille non armée (--no-watchdog) : la reprise après une "
                "coupure devra être relancée à la main", "WARN")
            return 0
        return 0 if arm_watchdog(args.every) else 2

    # Un rechargement (#373) n'est pas un second superviseur : c'est le même,
    # avec le code d'aujourd'hui. Le battement qu'il trouve est le sien —
    # rafraîchi juste avant l'`execv` pour que la veille ne le croie pas mort —
    # et la dernière ligne du journal du run est celle qu'il vient d'y écrire.
    # Lui opposer ces deux contrôles le ferait rendre la main à chaque
    # correctif : le rechargement tuerait le run là où il devait le sauver.
    if not args.reloaded:
        # Deux superviseurs sur le même run se marcheraient dessus : deux vagues
        # lancées en même temps sur le même `develop`, et des merges concurrents.
        if supervisor_alive() and not args.force:
            say(f"un superviseur bat déjà (il y a {human_delta(heartbeat_age())}) "
                "— rien à faire. `--state` pour le voir, `--force` pour passer "
                "outre.")
            return 0

        # Même règle pour un orchestrateur qui n'est pas un superviseur : deux
        # orchestrateurs sur un run, c'est deux vagues sur le même `develop`.
        if orchestrator_active() and not args.force:
            say("le journal du run vient d'être écrit : quelqu'un orchestre déjà "
                "ce run — rien à faire. `milestone_run.py watch` pour le voir, "
                "`--force` pour passer outre.")
            return 0

    # Un run ouvert désigne son jalon ; le redeviner peut en ouvrir un autre et
    # abandonner celui qui était en cours.
    if not args.milestone:
        args.milestone = current_run_milestone()
        if args.milestone:
            say(f"jalon repris du run ouvert : {args.milestone}")

    if not preflight(args) and not args.force:
        say("préflight en échec — rien n'a été lancé (`--force` pour passer outre)",
            "ERROR")
        hold_off(BACKOFF_SECONDS, "préflight en échec")
        return 2

    if not args.no_merge and not args.yes and not args.dry_run:
        # Le même texte qu'à l'armement, et pour la même raison : deux
        # descriptions du même dispositif finiraient par diverger, et c'est
        # celle-ci que l'opérateur confirme.
        announce_merge_policy(args)
        try:
            if input("Confirmer ? [o/N] ").strip().lower() not in {"o", "oui", "y"}:
                say("abandon")
                return 1
        except EOFError:
            say("pas de terminal pour confirmer — relancer avec --yes ou --no-merge",
                "ERROR")
            return 2
        args.yes = True

    return supervise(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
