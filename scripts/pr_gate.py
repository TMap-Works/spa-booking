#!/usr/bin/env python3
"""Barrière de merge : n'autorise une PR que si toute la CI est verte.

    python scripts/pr_gate.py 42                  # attend la CI, rend un verdict
    python scripts/pr_gate.py 42 --request-merge  # demande le merge à la CI, attend qu'il ait lieu
    python scripts/pr_gate.py 42 --merge          # merge ici même, en squash
    python scripts/pr_gate.py 42 --no-wait        # verdict immédiat, sans attendre

Deux façons de merger, et elles ne se valent pas. `--request-merge` pose le
label `merge-when-green` et laisse [auto-merge.yml](../.github/workflows/auto-merge.yml)
faire le merge côté GitHub — c'est le mode normal, le seul qui fonctionne depuis
une vague `claude -p` où aucune demande de permission ne peut être répondue.
`--merge` merge depuis la machine appelante ; il reste pour le dépannage.

Le dépôt est sur un plan GitHub Free : ni protection de branche, ni check
obligatoire. GitHub laisserait donc merger une PR dont la CI est rouge — c'est
ce script qui tient le rôle, côté client, et il le tient par un code de sortie
plutôt que par une consigne en prose.

Un check ne passe que s'il conclut sur SUCCESS, SKIPPED ou NEUTRAL. Tout le
reste bloque. Une PR sans aucun check bloque aussi : cela signifie qu'aucun
workflow ne s'est déclenché, pas que tout va bien.

Le workflow d'auto-merge fait seul exception : il n'est pas un check mais
l'actionneur du merge. La barrière l'écarte du rollup, sans quoi elle
s'attendrait elle-même et cette attente condamnerait la PR — voir
`without_merge_workflow`.

Sur un périmètre où une relecture humaine compte — `mod:payments`, le label
`security`, un schéma ou une migration Prisma, `infra/terraform`, le module
`payments` — le merge est refusé et la PR reste ouverte. C'est ce qui remplace
l'arbitrage que personne ne pourrait poser sous `claude -p`.

Deux conditions, et il a fallu #156 pour cesser de les confondre. `SPA_UNATTENDED`
dit que **personne ne peut répondre maintenant** ; `SPA_MERGE_SENSITIVE` dit ce
qui a **déjà été répondu**, à l'armement du run, périmètre par périmètre. Le
refus ne tombe que sur ce qui n'a pas été pré-autorisé. Déduire l'interdiction de
l'absence de l'opérateur revenait à interdire précisément quand la reprise
automatique doit travailler — c'est-à-dire à ne jamais s'en servir.

Les deux labels sont lus sur **l'issue que la PR referme**, pas sur la PR : nos
PR n'en portent aucun (`gh pr create` est appelé sans `--label`, et
`tracking.py` n'étiquette que des issues). Les lire sur la PR seule laisserait
`mod:payments` et `security` sans garde-fou. Les chemins, eux, sont lus par
l'API paginée des fichiers — `--json files` s'arrête à une centaine d'entrées et
laisserait passer le fichier sensible d'une grosse PR.

Le refus **ne retire pas** le label `merge-when-green`. Poser ce label est un
geste humain explicite, et c'est l'autorisation que reconnaît auto-merge.yml : la
barrière refuse de merger *elle-même* une PR sensible, elle ne révoque pas la
décision de quelqu'un d'autre. Elle ne peut d'ailleurs pas l'avoir posé sur une
telle PR, le refus étant évalué avant la pose.

Codes de sortie — 0 vert · 1 en attente ou délai dépassé · 2 check en échec ·
3 PR inapte au merge (brouillon, conflit, mauvaise base) · 4 erreur d'appel ·
5 périmètre sensible non pré-autorisé, PR laissée ouverte pour relecture humaine.
"""
import argparse
import json
import os
import re
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
# Le label est une demande de merge, pas un ordre : auto-merge.yml rejoue cette
# barrière avant d'agir, et ne merge que si le verdict est encore vert.
MERGE_LABEL = os.environ.get("SPA_MERGE_LABEL", "merge-when-green")
# Le nom du workflow qui merge, tel qu'il s'annonce dans les checks de la PR.
# Pas de variable d'environnement ici : ce nom est écrit dans auto-merge.yml et
# nulle part ailleurs, et un test le relit dans le fichier pour que la constante
# ne puisse pas dériver du workflow qu'elle désigne.
MERGE_WORKFLOW = "Auto-merge"
ROOT = Path(__file__).resolve().parents[1]

# Un workflow filtré par chemin (terraform.yml) ou sorti volontairement
# (project-automation.yml sans PROJECT_TOKEN) conclut SKIPPED ou NEUTRAL :
# l'exiger vert bloquerait tous les merges.
PASSING = {"SUCCESS", "SKIPPED", "NEUTRAL"}
PENDING_STATUS = {"QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"}

FIELDS = ("number,state,isDraft,baseRefName,headRefName,mergeable,"
          "mergeStateStatus,statusCheckRollup,url,title,labels,body")

GREEN, PENDING, FAILED, UNFIT, USAGE, SENSITIVE = 0, 1, 2, 3, 4, 5

# Les périmètres où une relecture humaine compte, nommés comme /ticket et
# /milestone les nomment. Les labels se lisent sur l'issue refermée, les chemins
# sur les fichiers de la PR.
SENSITIVE_LABELS = {"mod:payments", "security"}
# `apps/api/src/modules/payments/` est l'arborescence qu'impose le CDC §2.3 : une
# PR de paiement n'y échappe pas, même quand l'issue a perdu son label.
SENSITIVE_PREFIXES = ("infra/terraform/", "apps/api/src/modules/payments/")
# Le schéma autant que les migrations : changer `schema.prisma` porte le même
# risque, et la migration n'est pas toujours commitée dans la même PR.
PRISMA = re.compile(r"(^|/)prisma/(migrations/|schema\.prisma$)")
# Les neuf mots-clés que GitHub reconnaît. N'en lire que trois laissait « Fixed
# #42 » — pourtant fermant — sans aucune lecture de labels, donc sans garde-fou.
CLOSES = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", re.IGNORECASE)

# Ce que l'armement annonce à l'opérateur, **dérivé** des règles ci-dessus et non
# recopié : une liste écrite à la main finit par décrire autre chose que ce que
# la barrière refuse, et c'est le message que l'opérateur ne peut pas vérifier —
# il est lu à l'instant où il cesse de regarder.
PRISMA_SCOPE = "schéma ou migration Prisma"
SENSITIVE_SCOPES = ", ".join(
    ["label " + name for name in sorted(SENSITIVE_LABELS)]
    + [prefix.rstrip("/") for prefix in SENSITIVE_PREFIXES]
    + [PRISMA_SCOPE])

# La clé sous laquelle un périmètre se pré-autorise, pour chaque motif que
# `sensitive()` sait produire. Dérivée des règles ci-dessus, elle aussi : une
# table écrite à la main finirait par ouvrir autre chose que ce qu'elle nomme.
#
# Un motif qui n'y figure pas ne se pré-autorise pas — c'est le cas des deux
# motifs d'ignorance (« liste des fichiers indisponible », « labels de l'issue
# indisponibles »). Ne pas savoir ce que la PR touche ne peut pas se couvrir par
# une autorisation donnée à l'avance : l'opérateur aurait autorisé un périmètre
# nommé, pas un périmètre inconnu.
SENSITIVE_KEYS = dict(
    [("label " + name, name) for name in SENSITIVE_LABELS]
    + [(prefix.rstrip("/"), prefix.rstrip("/")) for prefix in SENSITIVE_PREFIXES]
    + [(PRISMA_SCOPE, "prisma")])
# Ce qu'un opérateur peut taper derrière `--merge-sensitive`.
SCOPE_KEYS = frozenset(SENSITIVE_KEYS.values())
# Le raccourci qui les prend toutes. Nommé plutôt qu'implicite : une liste vide
# doit valoir « aucune », jamais « toutes ».
ALL_SCOPES = "all"

# Posé par le superviseur dans l'environnement de `claude -p`. Le lire dans
# l'environnement plutôt que d'attendre un drapeau est délibéré : tout
# `pr_gate.py` lancé dans la vague en hérite, y compris ceux que l'orchestrateur
# lance sans y penser. Un garde-fou qui dépend de la mémoire de celui qui
# l'appelle n'en est pas un — c'est le défaut que ce script corrige, il ne va
# pas le réintroduire.
UNATTENDED_ENV = "SPA_UNATTENDED"
# L'autorisation, elle, est un geste humain donné à l'avance : l'opérateur arme
# le run en nommant les périmètres qu'il accepte de voir merger sans lui. Elle
# voyage par l'environnement pour la même raison que `SPA_UNATTENDED` — tout
# `pr_gate.py` lancé dans la vague en hérite, y compris ceux que l'orchestrateur
# invoque sans y penser.
#
# Les deux variables disaient jusqu'ici la même chose, et c'était le défaut
# (#156) : l'absence d'opérateur valait interdiction, alors que c'est justement
# quand il est absent que la reprise automatique doit travailler. `SPA_UNATTENDED`
# dit « personne ne peut répondre » ; celle-ci dit « voici ce qui a déjà été
# répondu ».
AUTHORISED_ENV = "SPA_MERGE_SENSITIVE"


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


def without_merge_workflow(rollup):
    """Écarte du rollup le workflow d'auto-merge — l'actionneur, pas un check.

    `auto-merge.yml` se déclenche sur `pull_request_target` : son run est
    rattaché à la PR et s'inscrit dans ses checks. La barrière, appelée depuis
    ce job, s'y voyait donc elle-même « en cours » et rendait 1 — le seul code
    que ce workflow sait absorber sans rougir, et précisément celui qui le
    tuait, faute de garde autour de l'appel.

    Ce rouge-là ne s'efface jamais. Les réveils suivants viennent de
    `workflow_run`, dont les runs sont rattachés à la branche par défaut et non
    à la PR : `latest_only` n'a rien de plus frais à opposer à l'entrée en
    échec, et la PR reste inmergeable à vie, y compris à la main. Voir #147, et
    #125 pour le même mode de défaillance par une autre cause.

    L'écarter ne masque aucun signal sur la santé de la PR : ce job ne teste
    rien, il agit. Ce qu'il diagnostique reste lisible dans les annotations et
    le résumé de son propre run.
    """
    kept = []
    for item in rollup or []:
        # Un statut externe ne vient d'aucun workflow : ce n'est pas celui-ci,
        # même s'il en porte le nom.
        if item.get("__typename") == "StatusContext":
            kept.append(item)
            continue
        # `workflowName` est le champ normal ; `name` ne sert de repli que
        # lorsque le rollup ne développe pas du tout le champ. Un check run
        # posé par une application GitHub, lui, porte un `workflowName` *vide* :
        # s'y rabattre sur `name` rouvrirait pour ces checks-là le trou que le
        # cas `StatusContext` ci-dessus vient de fermer — un rouge étranger
        # homonyme serait écarté en silence.
        workflow = item["workflowName"] if "workflowName" in item else item.get("name")
        if (workflow or "") != MERGE_WORKFLOW:
            kept.append(item)
    return kept


def latest_only(rollup):
    """Ne garde, pour un même check, que son passage le plus récent.

    Un workflow rejoué — titre de PR corrigé, `gh run rerun`, PR rouverte —
    attache au même commit un check run **de plus**, sans retirer le précédent.
    Le rollup porte alors les deux, et compter l'ancien condamnerait la PR :
    rien de ce qu'on pousse ensuite ne détache un échec déjà inscrit. La seule
    issue serait de réécrire l'historique pour obtenir un SHA neuf, c'est-à-dire
    de tordre le dépôt pour satisfaire la barrière.

    Deux passages d'un même workflow ne peuvent pas coexister dans un même run :
    dédupliquer sur (workflow, nom de job) ne masque donc jamais un vrai échec —
    un job matriciel porte ses paramètres dans son nom.

    **Un passage en cours l'emporte toujours sur un passage terminé**, quelles que
    soient les dates. Un check run encore en file n'a pas forcément de `startedAt`
    exploitable, et le comparer à l'ancien ferait gagner l'ancien : la barrière
    déclarerait vert sur un résultat périmé pendant que la nouvelle exécution
    tourne encore. Attendre est le seul comportement sûr.
    """
    freshest = {}
    for item in rollup or []:
        if item.get("__typename") == "StatusContext":
            key = ("status", item.get("context") or "")
            running = (item.get("state") or "").upper() in {"PENDING", "EXPECTED"}
        else:
            key = ("check", item.get("workflowName") or "", item.get("name") or "")
            status = (item.get("status") or "").upper()
            running = status != "COMPLETED" or not item.get("conclusion")
        # ISO 8601 en UTC : l'ordre lexicographique est l'ordre chronologique.
        # `completedAt` départage deux passages lancés dans la même seconde.
        rank = (1 if running else 0,
                item.get("startedAt") or "",
                item.get("completedAt") or "")
        kept = freshest.get(key)
        if kept is None or rank > kept[0]:
            freshest[key] = (rank, item)
    return [item for _, item in freshest.values()]


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


def unattended():
    """Vrai quand la vague tourne sans personne pour répondre à un arbitrage.

    Cette absence ne vaut pas interdiction : elle dit seulement qu'aucun
    arbitrage ne peut être posé maintenant. Ce qui autorise, c'est
    `authorised_scopes()` — un arbitrage posé avant.
    """
    return os.environ.get(UNATTENDED_ENV, "").strip().lower() not in (
        "", "0", "false", "no")


def authorised_scopes():
    """Les périmètres que l'opérateur a pré-autorisés en armant le run.

    `SPA_MERGE_SENSITIVE=infra/terraform,prisma` — une liste de clés séparées
    par des virgules ou des espaces, ou `all` pour les prendre toutes. Vide,
    absente, illisible : aucun périmètre autorisé, ce qui est le comportement
    d'avant #156.

    Une clé inconnue n'est pas rejetée ici, elle est simplement inerte : elle ne
    correspond à aucun motif, donc elle n'ouvre rien. C'est le bon sens de
    l'échec — une faute de frappe rend la barrière plus stricte, jamais plus
    permissive. Le refus franc d'une clé inconnue se fait à l'armement, là où
    quelqu'un est encore là pour la corriger.
    """
    raw = os.environ.get(AUTHORISED_ENV, "")
    tokens = {token.strip().lower()
              for token in raw.replace(",", " ").split() if token.strip()}
    if ALL_SCOPES in tokens:
        return set(SCOPE_KEYS)
    return tokens


def blocking(reasons, allowed):
    """Ce qui reste à faire relire une fois les pré-autorisations défalquées.

    Un motif sans clé — l'ignorance — ne se défalque jamais : voir
    `SENSITIVE_KEYS`.
    """
    return [reason for reason in reasons
            if SENSITIVE_KEYS.get(reason) not in allowed]


def changed_paths(number):
    """Les chemins touchés par la PR — pagination comprise. None si indisponible.

    `--json files` s'arrête à une centaine d'entrées : le fichier sensible d'une
    grosse PR y passait inaperçu. La liste n'est demandée qu'au moment de
    décider, et non à chaque sondage de la CI.
    """
    # `per_page=100` plutôt que les 30 par défaut : trois fois moins d'allers-
    # retours, donc trois fois moins de chances d'atteindre le délai — qui vaut
    # refus et bloquerait une grosse PR pourtant anodine.
    proc = run(["gh", "api", "--paginate",
                "repos/{}/pulls/{}/files?per_page=100".format(REPO, number),
                "--jq", ".[].filename"], timeout=120)
    if proc.returncode != 0:
        return None
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def issue_labels(pr):
    """Les labels des issues que la PR referme — la PR, elle, n'en porte pas.

    `mod:payments` et `security` vivent sur l'issue : `/ticket` ouvre ses PR sans
    `--label` et `tracking.py` n'étiquette que des issues. Les chercher sur la PR
    laissait ces deux périmètres sans aucun garde-fou.

    Rend `None` si une issue n'a pas pu être lue. Comme pour les chemins, ne pas
    savoir vaut refus : un `gh` en limite de débit rendait sinon le garde-fou
    muet précisément quand la charge est forte.
    """
    labels = set()
    for number in sorted(set(CLOSES.findall(pr.get("body") or ""))):
        proc = run(["gh", "issue", "view", number, "--repo", REPO,
                    "--json", "labels", "--jq", ".labels[].name"])
        if proc.returncode != 0:
            return None
        labels.update(n.strip() for n in proc.stdout.splitlines() if n.strip())
    return labels


def sensitive(pr, paths):
    """Ce qui, dans cette PR, appelle une relecture humaine — vide s'il n'y a rien."""
    reasons = []
    labels = {(label.get("name") or "") for label in pr.get("labels") or []}
    from_issue = issue_labels(pr)
    if from_issue is None:
        reasons.append("labels de l'issue indisponibles")
    else:
        labels |= from_issue
    reasons.extend("label " + name for name in sorted(SENSITIVE_LABELS & labels))

    # Ne pas savoir ce que la PR touche vaut refus : un garde-fou qui s'ouvre
    # quand il ne voit plus rien ne protège que les jours où tout va bien.
    if paths is None:
        reasons.append("liste des fichiers indisponible")
        return reasons

    reasons.extend(prefix.rstrip("/") for prefix in SENSITIVE_PREFIXES
                   if any(path.startswith(prefix) for path in paths))
    if any(PRISMA.search(path) for path in paths):
        reasons.append(PRISMA_SCOPE)
    return reasons


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

    rollup = without_merge_workflow(pr.get("statusCheckRollup"))
    checks = list(check_entries(latest_only(rollup)))
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
    # Dans un runner, le checkout est jetable : aucun worktree à ramasser, aucune
    # branche locale à supprimer. Y faire tourner le ramasse-miettes du poste de
    # travail ne servirait qu'à dépenser du temps avec un jeton en écriture.
    if os.environ.get("CI"):
        return ""
    run(["git", "fetch", "--prune", "--quiet", "origin"], timeout=60)

    # worktree_gc voit la PR mergée et supprime worktree comme branche locale ;
    # lui déléguer évite de dupliquer ici ses garde-fous (worktree sale, etc.).
    # Il est appelé sans condition sur le distant : quand le merge vient de la
    # CI, la suppression de la branche distante est un appel d'API postérieur au
    # basculement en MERGED, et s'arrêter là laisserait le worktree derrière.
    gc = ROOT / "scripts" / "worktree_gc.py"
    if gc.exists():
        run([sys.executable, str(gc), "--quiet", "--no-fetch"], timeout=120)

    remote = run(["git", "ls-remote", "--heads", "origin", head], timeout=60)
    if remote.returncode == 0 and remote.stdout.strip():
        return "Branche distante {} toujours présente — à supprimer à la main.".format(head)
    still_local = run(["git", "branch", "--list", head])
    if still_local.returncode == 0 and still_local.stdout.strip():
        return ("Branche distante supprimée ; la locale {} subsiste "
                "(worktree sale ou commits non poussés).".format(head))
    return "Branche {} supprimée, distante et locale.".format(head)


def request_merge(number, pr, args):
    """Demande le merge à la CI en posant le label, puis attend qu'il ait lieu.

    Le merge lui-même est fait par `.github/workflows/auto-merge.yml`, qui
    rejoue cette même barrière côté GitHub. Poser le label ne court-circuite donc
    rien : une PR rouge étiquetée reste non mergée.

    Attendre plutôt que rendre la main tout de suite est délibéré — un jalon
    merge ses PR en séquence, et la suivante doit partir d'un `develop` qui porte
    déjà la précédente.
    """
    # Le workflow ne ramasse que les PR ouvertes vers develop. Étiqueter une PR
    # visant staging ou main poserait un label que personne ne regarde, et
    # laisserait attendre jusqu'au délai un merge qui n'arriverait jamais.
    if args.base != "develop":
        return UNFIT, ("--request-merge ne vaut que pour une PR vers develop ; "
                       "celle-ci cible {}. Utiliser --merge.".format(args.base))

    already = MERGE_LABEL in [label.get("name") for label in pr.get("labels") or []]
    proc = run(["gh", "pr", "edit", str(number), "--repo", REPO,
                "--add-label", MERGE_LABEL])
    if proc.returncode != 0:
        return USAGE, "label {} non posé : {}".format(
            MERGE_LABEL, (proc.stderr or proc.stdout).strip())

    # Reposer un label déjà présent n'émet aucun événement : sur une PR verte,
    # plus aucun workflow ne conclura, donc plus rien ne réveillerait la CI. On
    # la déclenche explicitement — le cas se produit dès qu'un premier
    # --request-merge a dépassé son délai en laissant le label derrière lui.
    if already:
        dispatch = run(["gh", "workflow", "run", "auto-merge.yml", "--repo", REPO])
        if dispatch.returncode != 0 and not args.quiet:
            print("label déjà posé et relance du workflow impossible : "
                  + (dispatch.stderr or dispatch.stdout).strip(), file=sys.stderr)

    if args.no_await:
        return GREEN, "label {} posé — la CI mergera #{}.".format(MERGE_LABEL, number)

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        time.sleep(args.interval)
        fresh, _ = fetch_pr(number)
        if fresh is None:
            continue
        state = (fresh.get("state") or "").upper()
        if state == "MERGED":
            lines = ["PR #{} mergée par la CI.".format(number)]
            if not args.no_delete_branch:
                lines.append(branch_cleanup(
                    fresh.get("headRefName") or pr.get("headRefName")))
            return GREEN, " ".join(part for part in lines if part)
        if state == "CLOSED":
            return UNFIT, "PR #{} fermée sans avoir été mergée.".format(number)
    return PENDING, ("délai dépassé — le label {} reste posé, le merge se fera à "
                     "la prochaine conclusion de workflow.".format(MERGE_LABEL))


def parse_args():
    parser = argparse.ArgumentParser(
        description="N'autorise le merge d'une PR que si toute la CI est verte.")
    parser.add_argument("pr", type=int, help="numéro de la pull request")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--merge", action="store_true",
                      help="merge en squash ici même, si et seulement si tout est vert")
    mode.add_argument("--request-merge", action="store_true",
                      help="pose le label {} et laisse la CI merger".format(MERGE_LABEL))
    parser.add_argument("--no-await", action="store_true",
                        help="avec --request-merge : ne pas attendre que le merge ait lieu")
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
    args = parser.parse_args()
    # Un drapeau accepté puis ignoré en silence laisse croire à un effet qui
    # n'existe pas — ici, à un appel qui rend la main alors qu'il attend.
    if args.no_await and not args.request_merge:
        parser.error("--no-await ne s'utilise qu'avec --request-merge")
    return args


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

    # Évalué avant de savoir si l'on merge : `/ticket` documente ce code de
    # sortie sur l'appel de verdict seul, et un agent qui lirait « VERT » sur une
    # PR sensible en conclurait qu'il peut la merger lui-même.
    if unattended():
        reasons = sensitive(pr, changed_paths(args.pr))
        allowed = authorised_scopes()
        refused = blocking(reasons, allowed)
        if refused:
            print("BLOQUÉ : périmètre sensible ({}) sans autorisation préalable — "
                  "PR #{} laissée ouverte pour relecture humaine."
                  .format(", ".join(refused), args.pr), file=sys.stderr)
            return SENSITIVE
        # Ce qui a été mergé sur une pré-autorisation doit se lire après coup :
        # « qui a autorisé quoi, et quand » se répond depuis le journal du
        # superviseur, mais encore faut-il que la trace existe des deux côtés.
        waived = [reason for reason in reasons if reason not in refused]
        if waived and not args.quiet:
            print("périmètre sensible ({}) pré-autorisé à l'armement du run — "
                  "merge poursuivi.".format(", ".join(waived)))

    print("VERT : {}".format(message))
    if not (args.merge or args.request_merge):
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

    code, message = (request_merge if args.request_merge else merge)(
        args.pr, fresh, args)
    print(message if code == GREEN else "BLOQUÉ : " + message,
          file=sys.stdout if code == GREEN else sys.stderr)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(USAGE)
