#!/usr/bin/env python3
"""Dit à un agent de vague s'il a réellement reçu son worktree isolé — bruyamment.

    python scripts/isolation_guard.py check     # barrière : 0 isolé · 2 dépôt principal
    python scripts/isolation_guard.py report    # le détail, pour diagnostiquer

`check` est une **barrière**, faite pour porter un commit :

    python scripts/isolation_guard.py check && git add -A && git commit -m "..."

Codes de sortie : `0` le répertoire courant est un worktree lié — l'isolation a
été obtenue · `2` c'est l'arbre de travail du dépôt principal, l'isolation n'a
pas été obtenue · `4` erreur d'appel ou d'environnement.

Pourquoi ce script existe (#427)
--------------------------------

Vague 2 du run `s3-back-office-paiements-outillage-20260905-054941`, le
05/09/2026. L'agent de #414 a été lancé avec `isolation: "worktree"`, comme le
prescrit la phase 3 de `.claude/commands/milestone.md`. **Il n'a pas reçu de
worktree** : son répertoire courant était l'arbre de travail du dépôt principal,
sorti sur `develop`. Il l'a découvert par lui-même, au `git worktree list` de la
phase 1, et a improvisé — `git checkout -b` au lieu du `git branch -m` que le
prompt prescrit sans réserve, et qui aurait renommé `develop`.

Le défaut n'était pas silencieux par manque de signal : il l'était par manque de
regard. **Le journal du run portait déjà la réponse**, quatorze fois de suite.
`milestone_run.py event` inscrit dans chaque ligne le worktree d'où l'agent
parle (`agent_worktree()`, #175) ; les quatorze lignes de #414 portent
`worktree: null`, quand celles de #422 et #423 — mêmes vague, même run — nomment
le leur. Personne ne lisait ce champ pour ce qu'il dit aussi : *l'isolation n'a
pas eu lieu*.

Ce script est ce regard, et `milestone_run.py` l'appelle pour l'agent, à chaque
ligne de journal portant un ticket : l'agent n'a plus à y penser, et le constat
arrive dès la phase `recevabilite` — avant la première écriture, pas au moment
de commiter.

Ce que le défaut coûte, et pourquoi la conduite dépend de la largeur
--------------------------------------------------------------------

À largeur 1 il est survivable : un seul agent, un seul arbre de travail, et
#414 est allé à son terme. À largeur 3 — le régime par défaut d'un run
`nature:projet` — c'est une perte de travail garantie : trois agents partageant
le même arbre se renommeraient la branche l'un sous l'autre, commiteraient les
fichiers des autres, et le `git checkout -b` du second emporterait les
modifications non commitées du premier.

D'où le second verdict que rend `check` : le nombre de **worktrees d'agent
vivants** à côté. Il se lit sur `git worktree list` seul, sans rien savoir du
run, et il tranche la conduite :

  - aucun autre agent — poursuivre est tenable, avec les précautions ci-dessous ;
  - un ou plusieurs — **refuser de commiter**, journaliser `--status blocked` et
    rendre la main. Ces agents-là sont bien isolés, mais ils rebasent tous sur la
    branche sortie du dépôt principal, celle sur laquelle l'orchestrateur merge
    la vague : y poser un commit depuis un arbre qu'aucun ticket ne revendique
    fait partir la suite de la vague d'un état que personne n'a validé.

Les trois précautions que #414 a dû retrouver seul
--------------------------------------------------

Elles sont dans le message d'échec, pour que le prochain agent ne les redécouvre
pas :

1. **Ne jamais `git branch -m`.** La phase 1 de `ticket.md` le prescrit pour
   renommer la branche que `EnterWorktree` a créée. Dans le dépôt principal, il
   renomme la branche sortie — `develop`, neuf fois sur dix.
2. **`review_guard.py` est inactif ici** et sort en `0` en le disant : hors
   worktree il n'a rien à protéger. La revue de la phase 5 n'est donc encadrée
   par rien, et un `--fix` qui désignerait une cible salirait le dépôt principal
   sans qu'aucune post-condition ne le voie (#167).
3. **Rendre le dépôt principal à `develop`** avant de rendre la main : la
   phase 4 de `/milestone` y lance `git pull` puis `npm run verify`, et sur une
   branche de ticket elle ne mesure pas ce qu'elle croit mesurer.

Ce que ce script ne fait pas
----------------------------

Il ne crée pas de worktree et n'en répare aucun : l'isolation est accordée par
le harnais, en amont de tout ce que ce dépôt contrôle. Il constate, il nomme, il
sort en échec. La correction du prompt de vague — faire de « Tu es déjà dans un
worktree isolé » une vérification plutôt qu'une affirmation — vit dans
`.claude/commands/milestone.md`, hors de portée d'un agent non interactif.

Aucune dépendance : bibliothèque standard seule, comme les autres scripts.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un accent dans un chemin
# ferait planter le script au moment même où il a quelque chose à dire.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

OK = 0
NOT_ISOLATED = 2
USAGE = 4

# Les worktrees que l'outil `Agent` crée pour les agents d'une vague. Leur nom
# est `agent-<aléa>` et il ne porte aucun numéro d'issue — c'est le journal qui
# les rattache à leur ticket (#175). Ce préfixe suffit pourtant à les distinguer
# d'un worktree ouvert à la main par un humain, qui, lui, ne compte pas comme un
# agent concurrent.
AGENT_WORKTREE_PREFIX = "agent-"

# Au-delà, la liste des fichiers sales du dépôt principal est tronquée : elle
# sert à qualifier l'état de l'arbre, pas à le recenser.
MAX_LISTED = 20


class GuardError(Exception):
    """Erreur d'environnement — pas un dépôt git, `git` absent, etc."""


def git(*args, cwd=None, binary=False):
    """Lance git et rend sa sortie. Lève GuardError sur échec."""
    try:
        done = subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        # `git` absent du PATH, ou `cwd` qui n'existe pas — les deux remontent en
        # OSError et se lisent pareil : l'appel n'a pas eu lieu. Les distinguer
        # n'apporterait rien, les confondre sous « git introuvable » enverrait
        # sur une fausse piste celui dont c'est le répertoire qui manque.
        raise GuardError(f"git non lançable ({' '.join(args)}) : {exc}") from exc
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip()
        raise GuardError(f"git {' '.join(args)} : {detail or 'échec'}")
    if binary:
        return done.stdout
    return done.stdout.decode("utf-8", "replace").strip()


def head_branch(root):
    """Nom de la branche sortie dans `root`, ou None en HEAD détaché.

    `--quiet` évite le code de sortie 1 que `--abbrev-ref HEAD` rend sur un
    dépôt sans commit : une absence de branche est une réponse, pas une panne.
    """
    try:
        name = git("symbolic-ref", "--quiet", "--short", "HEAD", cwd=root)
    except GuardError:
        return None
    return name or None


def worktrees(cwd):
    """Tous les arbres de travail du dépôt, principal en tête.

    `git worktree list --porcelain` énumère toujours le worktree principal en
    premier : c'est ce qui le distingue d'un worktree lié sans avoir à deviner à
    partir du chemin de `.git`. Même lecture que `review_guard.py`.
    """
    entries, current = [], None
    for line in git("worktree", "list", "--porcelain", cwd=cwd).splitlines():
        if line.startswith("worktree "):
            if current is not None:
                entries.append(current)
            current = {"path": Path(line[len("worktree "):]).resolve(),
                       "branch": None, "detached": False, "prunable": False}
        elif current is None:
            continue
        elif line.startswith("prunable"):
            # L'entrée survit à son répertoire : `git worktree list` la montre
            # jusqu'au prochain `git worktree prune`, que `worktree_gc.py` ne
            # lance qu'en fin de vague. La compter comme un agent vivant ferait
            # refuser un commit au nom d'un worktree qui n'existe plus.
            current["prunable"] = True
        elif line.startswith("branch "):
            # `branch refs/heads/bugfix/427-…` — seul le préfixe `refs/heads/`
            # se retire. Découper sur le dernier « / » amputerait les branches
            # de ticket de leur type (`bugfix/427-…` deviendrait `427-…`), et
            # c'est justement ce nom-là que le message d'échec doit donner juste.
            ref = line[len("branch "):].strip()
            if ref.startswith("refs/heads/"):
                ref = ref[len("refs/heads/"):]
            current["branch"] = ref or None
        elif line.strip() == "detached":
            current["detached"] = True
    if current is not None:
        entries.append(current)
    if not entries:
        raise GuardError("git worktree list n'a renvoyé aucun worktree")
    return entries


def dirty_paths(root):
    """Chemins signalés par `git status` dans `root`, en relatif POSIX.

    `-z` évite les guillemets et les échappements que `--porcelain` applique aux
    chemins accentués ou espacés — le dépôt vit sous « Spa & Booking ».
    Les fichiers ignorés restent exclus : c'est ce qui écarte `node_modules/`,
    `.claude/worktrees/` et `.claude/.milestone/`, que tous les agents écrivent
    en permanence.
    """
    raw = git("status", "--porcelain=v1", "-z", "--untracked-files=all",
              "--no-renames", "--ignore-submodules=all", cwd=root, binary=True)
    paths = []
    for record in raw.split(b"\0"):
        if len(record) < 4:               # "XY " + au moins un caractère
            continue
        paths.append(record[3:].decode("utf-8", "replace"))
    return sorted(paths)


def survey(cwd):
    """Tout ce qu'il y a à savoir sur l'isolation, en une lecture du dépôt.

    Rendu commun à `check` et à `report` : les deux commandes disent la même
    chose, l'une en verdict, l'autre en détail. Deux lectures divergentes du même
    état finiraient par se contredire.
    """
    current = Path(git("rev-parse", "--show-toplevel", cwd=cwd)).resolve()
    trees = worktrees(cwd)
    main = trees[0]["path"]
    isolated = current != main

    # Les worktrees d'agent vivants, le principal et le nôtre exclus : c'est le
    # nombre d'agents de vague qui travaillent en même temps que nous, et donc ce
    # qui décide de la conduite à tenir. Une entrée `prunable` ne compte pas :
    # son agent est parti, son répertoire n'existe plus.
    siblings = [tree for tree in trees[1:]
                if tree["path"] != current
                and not tree["prunable"]
                and tree["path"].name.startswith(AGENT_WORKTREE_PREFIX)]

    return {
        "cwd": str(Path(cwd).resolve()),
        "current": str(current),
        "main": str(main),
        "isolated": isolated,
        "branch": head_branch(current),
        "main_branch": trees[0]["branch"],
        "main_dirty": dirty_paths(main),
        "siblings": [{"path": str(tree["path"]), "branch": tree["branch"]}
                     for tree in siblings],
    }


def alert(state, ticket=None):
    """Le constat d'isolation manquée, en une ligne dense — ou None si tout va bien.

    Une seule ligne, parce que c'est ce que `milestone_run.py` inscrit au journal
    et ce qu'un tableau de bord affiche : elle doit tenir sans être tronquée tout
    en nommant l'arbre, sa branche et le nombre d'agents concurrents.
    """
    if state["isolated"]:
        return None
    concurrent = len(state["siblings"])
    who = f"#{ticket} " if ticket is not None else ""
    conduct = ("REFUSER DE COMMITER — journaliser --status blocked et rendre la "
               f"main : {concurrent} autre(s) agent(s) de vague travaillent en "
               "parallèle, et commiter ici salit la branche sur laquelle ils "
               "rebasent et que l'orchestrateur merge"
               if concurrent else
               "aucun autre agent de vague en cours : poursuivre est tenable, "
               "sans jamais `git branch -m`")
    return (f"isolation NON obtenue : l'agent {who}écrit dans le dépôt PRINCIPAL "
            f"{state['main']} (branche {state['main_branch'] or 'détachée'}), pas "
            f"dans un worktree isolé (#427). {conduct}. "
            f"`python scripts/isolation_guard.py report` pour le détail")


def print_failure(state):
    """Le bloc d'échec de `check` — le constat, puis ce qu'il faut en faire."""
    concurrent = state["siblings"]
    print("ÉCHEC : isolation NON obtenue — ce répertoire est l'arbre de travail "
          "du dépôt PRINCIPAL, pas un worktree isolé (#427).", file=sys.stderr)
    print(f"  dépôt principal  {state['main']}", file=sys.stderr)
    print(f"  branche sortie   {state['main_branch'] or 'HEAD détachée'}",
          file=sys.stderr)
    print(f"  arbre sale       {len(state['main_dirty'])} fichier(s)",
          file=sys.stderr)
    for path in state["main_dirty"][:MAX_LISTED]:
        print(f"                   {path}", file=sys.stderr)
    if len(state["main_dirty"]) > MAX_LISTED:
        print(f"                   … et {len(state['main_dirty']) - MAX_LISTED} "
              f"autre(s)", file=sys.stderr)
    print("", file=sys.stderr)

    if concurrent:
        print(f"REFUSER DE COMMITER : {len(concurrent)} worktree(s) d'agent "
              f"vivant(s) à côté — commiter ici pose un commit sur la branche "
              f"sortie du dépôt principal, celle-là même dont ils partent au "
              f"rebase et sur laquelle l'orchestrateur merge la vague.",
              file=sys.stderr)
        for tree in concurrent:
            print(f"  {tree['path']}  [{tree['branch'] or 'détachée'}]",
                  file=sys.stderr)
        print("Journaliser `--status blocked` avec ce constat, ne rien commiter, "
              "rendre la main.", file=sys.stderr)
    else:
        print("Aucun autre agent n'écrit dans cet arbre : poursuivre est tenable, "
              "à trois conditions.", file=sys.stderr)
    print("", file=sys.stderr)
    print("Dans tous les cas :", file=sys.stderr)
    print("  1. NE JAMAIS `git branch -m` — ici il renomme la branche sortie du "
          f"dépôt principal ({state['main_branch'] or 'HEAD détachée'}). "
          "Créer la branche par `git checkout -b <type>/<issue>-<slug>`.",
          file=sys.stderr)
    print("  2. `review_guard.py` sort en 0 en se déclarant inactif : la revue de "
          "la phase 5 n'est encadrée par rien. Ne passer aucune cible à "
          "`code-review` (#167).", file=sys.stderr)
    print("  3. Rendre le dépôt principal à `develop` avant de rendre la main : "
          "la phase 4 de /milestone y lance `git pull` puis `npm run verify`.",
          file=sys.stderr)


def do_check(state, allow_main):
    if state["isolated"]:
        print(f"isolation ok : worktree lié {state['current']} "
              f"(branche {state['branch'] or 'détachée'}), "
              f"dépôt principal {state['main']}")
        return OK
    if allow_main:
        # `/ticket --no-worktree` travaille délibérément dans l'arbre commun :
        # le dire reste utile, en faire un échec ne l'est pas.
        print(f"dépôt principal {state['main']} "
              f"(branche {state['main_branch'] or 'détachée'}) — attendu, "
              f"--allow-main. Ne pas `git branch -m`.")
        return OK
    print_failure(state)
    return NOT_ISOLATED


def do_report(state):
    print(f"répertoire courant  {state['cwd']}")
    print(f"racine git          {state['current']}")
    print(f"branche             {state['branch'] or 'HEAD détachée'}")
    print(f"dépôt principal     {state['main']} "
          f"[{state['main_branch'] or 'HEAD détachée'}]")
    verdict = ("worktree lié — isolation obtenue" if state["isolated"]
               else "DÉPÔT PRINCIPAL — isolation NON obtenue (#427)")
    print(f"verdict             {verdict}")
    print(f"arbre principal     {len(state['main_dirty'])} fichier(s) non commité(s)")
    for path in state["main_dirty"][:MAX_LISTED]:
        print(f"                    {path}")
    if len(state["main_dirty"]) > MAX_LISTED:
        print(f"                    … et {len(state['main_dirty']) - MAX_LISTED} autre(s)")
    print(f"agents concurrents  {len(state['siblings'])}")
    for tree in state["siblings"]:
        print(f"                    {tree['path']}  [{tree['branch'] or 'détachée'}]")
    return OK


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Dit si l'agent courant a reçu son worktree isolé (#427).")
    parser.add_argument("action", nargs="?", default="check",
                        choices=("check", "report"),
                        help="check : barrière, code de sortie 2 hors worktree · "
                             "report : le détail, pour diagnostiquer")
    parser.add_argument("--allow-main", action="store_true",
                        help="le dépôt principal est attendu (/ticket --no-worktree) : "
                             "constater sans échouer")
    parser.add_argument("--json", action="store_true",
                        help="rendre l'état brut, pour un appel programmatique")
    args = parser.parse_args(argv)

    try:
        state = survey(Path.cwd())
    except GuardError as exc:
        print(f"ÉCHEC : {exc}", file=sys.stderr)
        return USAGE

    if args.json:
        print(json.dumps(state, ensure_ascii=False, indent=2))
        # Même verdict qu'en clair : `--json` change la forme, pas la barrière.
        return OK if (state["isolated"] or args.allow_main
                      or args.action == "report") else NOT_ISOLATED
    if args.action == "report":
        return do_report(state)
    return do_check(state, args.allow_main)


if __name__ == "__main__":
    sys.exit(main())
