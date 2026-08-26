#!/usr/bin/env python3
"""Vérifie qu'une revue lancée depuis un worktree n'a rien écrit dans le dépôt principal.

    python scripts/review_guard.py snapshot    # AVANT la revue de la phase 5
    python scripts/review_guard.py verify      # APRÈS la revue de la phase 5

Codes de sortie : `0` rien à signaler (ou garde-fou inactif) · `2` écriture
détectée hors du worktree · `3` `verify` sans instantané préalable · `4` erreur
d'appel ou d'environnement.

Pourquoi ce script existe (#167)
--------------------------------

Pendant le run `s1-fondations-20260825-093729`, deux agents ont vu leur revue de
phase 5 modifier des fichiers du **dépôt principal** au lieu de leur worktree :

  - l'agent de #13 a revu le commit `d77ba2b` — déjà mergé — et a sali
    `scripts/milestone_plan.py` et `scripts/tests/test_milestone_plan.py` ;
  - l'agent de #12 a revu la PR **#160**, celle d'un autre ticket, et a sali
    `.claude/milestone-rules.json`.

La cause n'est pas un répertoire courant erroné : les fichiers salis sont
**exactement** ceux de la cible revue. La phase 5 demandait la revue « sur le
diff local » en prose sans jamais donner l'invocation littérale ; l'agent
composait donc l'appel lui-même et désignait une cible — un SHA, un numéro de
PR — que `--fix` corrigeait fidèlement. Deux aggravants : il existe deux choses
nommées `code-review` sur ce poste, dont une commande de marketplace qui *exige*
une PR alors qu'à la phase 5 le ticket n'en a pas encore ; et les sous-agents
essaimés par la revue héritent bien du `cwd` du worktree mais **pas** du refus
d'isolation qui protège l'agent de ticket.

Les deux fois, l'incident n'a été rattrapé que parce que l'agent y a pensé. Ce
script remplace cette vigilance par une post-condition : on empreinte l'arbre de
travail du dépôt principal avant la revue, on recompare après, et on sort en
échec franc au moindre écart.

Ce que le garde-fou couvre, et ce qu'il ne couvre pas
----------------------------------------------------

Il surveille **le seul arbre de travail du dépôt principal**, et c'est délibéré :

  - c'est là qu'ont atterri les deux incidents, et c'est la surface partagée
    dangereuse — `scripts/`, `.claude/`, tout ce qui pilote le run en cours ;
  - `.gitignore` y exclut `node_modules/`, `.claude/worktrees/`,
    `.claude/.milestone/`, `dist/` : l'empreinte ignore donc nativement les
    dépendances, les worktrees frères et le journal de jalon, que tous les
    agents écrivent en permanence. Sans cette exclusion le garde-fou crierait
    à chaque ligne de journal.

Il ne surveille **pas** les worktrees frères : pendant une vague, jusqu'à trois
agents y travaillent légitimement en parallèle, et rien ne permettrait de
distinguer leur travail d'une écriture parasite. Il ne surveille pas non plus
l'extérieur du dépôt, qui n'a pas de borne.

Un `HEAD` qui bouge dans le dépôt principal est signalé mais **ne fait pas
échouer** à lui seul : c'est l'orchestrateur qui rebase ou récupère entre deux
vagues, pas une écriture de revue. S'il bouge *et* que des fichiers ont changé,
les deux sont dits, pour qu'un humain puisse trancher.

Hors worktree — `/ticket --no-worktree`, ou le script lancé depuis le dépôt
principal — il n'y a rien à protéger : les deux sous-commandes sortent en `0` en
le disant. Le garde-fou est inoffensif là où il n'a pas lieu d'être.

Aucune dépendance : bibliothèque standard seule, comme les autres scripts.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un accent dans un chemin
# ferait planter le script au moment même où il a quelque chose à dire.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

OK = 0
DIRTY = 2
NO_SNAPSHOT = 3
USAGE = 4

STATE_DIR = "spa-review-guard"
CHUNK = 1 << 20

# Un instantané ne vaut que pour la fenêtre de revue qu'il ouvre. Passé ce délai
# il vient forcément d'un run antérieur ayant réutilisé le même chemin de
# worktree (reprise de jalon, ticket rejoué) : le prendre pour argent comptant
# ferait passer `verify` alors que la phase 5 courante n'a rien encadré.
SNAPSHOT_TTL = 12 * 3600


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
    except FileNotFoundError as exc:      # git absent du PATH
        raise GuardError("git introuvable dans le PATH") from exc
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip()
        raise GuardError(f"git {' '.join(args)} : {detail or 'échec'}")
    if binary:
        return done.stdout
    return done.stdout.decode("utf-8", "replace").strip()


def git_ok(*args, cwd=None):
    """Vrai si git réussit — pour les questions dont l'échec est une réponse."""
    try:
        git(*args, cwd=cwd)
    except GuardError:
        return False
    return True


def worktree_roots(cwd):
    """Rend (worktree courant, arbre de travail principal).

    `git worktree list --porcelain` liste toujours le worktree principal en
    premier — c'est ce qui distingue le dépôt principal d'un worktree lié sans
    avoir à deviner à partir du chemin de `.git`.
    """
    current = Path(git("rev-parse", "--show-toplevel", cwd=cwd)).resolve()
    listing = git("worktree", "list", "--porcelain", cwd=cwd)
    main = None
    for line in listing.splitlines():
        if line.startswith("worktree "):
            main = Path(line[len("worktree "):]).resolve()
            break
    if main is None:
        raise GuardError("git worktree list n'a renvoyé aucun worktree")
    return current, main


def state_path(cwd, current):
    """Fichier d'instantané, rangé dans le `.git` commun.

    Ni dans le worktree ni dans l'arbre du dépôt principal : un fichier d'état
    posé dans l'un ou l'autre serait vu par `git status` — donc committé par
    mégarde côté worktree, ou compté comme une salissure côté dépôt principal.
    Le répertoire git commun n'appartient à aucun arbre de travail.
    """
    common = Path(git("rev-parse", "--git-common-dir", cwd=cwd))
    if not common.is_absolute():
        common = (Path(cwd) / common).resolve()
    slug = hashlib.sha256(str(current).encode("utf-8")).hexdigest()[:16]
    return common / STATE_DIR / f"{current.name}-{slug}.json"


def sha256_of(path):
    """Empreinte du contenu d'un fichier, ou None s'il n'est pas lisible.

    Un fichier listé par `git status` peut avoir disparu entre le listing et la
    lecture (suppression en cours) : None est alors une valeur d'empreinte
    légitime, et une transition None→hash se lit comme une apparition.
    """
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            while True:
                block = handle.read(CHUNK)
                if not block:
                    break
                digest.update(block)
        return digest.hexdigest()
    except (OSError, ValueError):
        return None


def dirty_paths(root):
    """Chemins signalés par `git status` dans `root`, chemins relatifs POSIX.

    `-z` évite les guillemets et les échappements que `--porcelain` applique aux
    chemins accentués ou espacés — le dépôt vit sous « Spa & Booking ».
    `--no-renames` garantit un seul chemin par enregistrement, ce qui rend le
    découpage trivial. Les fichiers ignorés sont exclus par défaut : c'est ce
    qui écarte `node_modules/`, `.claude/worktrees/` et `.claude/.milestone/`.
    """
    raw = git(
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--no-renames", "--ignore-submodules=all",
        cwd=root, binary=True,
    )
    paths = []
    for record in raw.split(b"\0"):
        if len(record) < 4:               # "XY " + au moins un caractère
            continue
        paths.append(record[3:].decode("utf-8", "replace"))
    return sorted(paths)


def fingerprint(root):
    """Empreinte de l'arbre de travail : HEAD, plus le contenu de ce qui est sale."""
    try:
        head = git("rev-parse", "HEAD", cwd=root)
    except GuardError:                    # dépôt sans commit
        head = ""
    files = {}
    for relative in dirty_paths(root):
        files[relative] = sha256_of(Path(root) / relative)
    return {"head": head, "files": files}


def describe(before, after):
    """Compare deux empreintes. Rend (chemins touchés, HEAD a bougé).

    Le verdict porte sur des *contenus* : un chemin est retenu dès que son
    empreinte diffère, y compris quand il entre ou sort de la liste de
    `git status`. Ce qui lui est arrivé se lit sur le dépôt (`classify`), pas
    sur cette liste — un fichier suivi et propre à l'instantané n'y figurait
    pas, et le déduire d'ici le ferait passer pour un fichier créé.
    """
    old, new = before["files"], after["files"]
    touched = [path for path in sorted(set(old) | set(new))
               if old.get(path, "absent") != new.get(path, "absent")]
    return touched, before["head"] != after["head"]


def classify(main, path):
    """Ce qui est arrivé à `path` dans le dépôt principal, d'après git lui-même.

    Distinguer « git ne suit pas ce chemin » de « ce chemin est suivi » est ce
    qui décide de la remédiation : `checkout` ne sait pas retirer un intrus non
    suivi, et `clean` détruirait un fichier suivi au lieu de le restaurer.
    """
    if not git_ok("cat-file", "-e", f"HEAD:{path}", cwd=main):
        return "apparu"
    if not (Path(main) / path).exists():
        return "disparu"
    return "modifié"


def remediation(main, path, kind):
    """Commande à donner à l'humain pour annuler l'écriture constatée."""
    if kind == "apparu":
        # Désindexer puis retirer : couvre l'intrus laissé non suivi comme celui
        # que la revue aurait déjà mis à l'index.
        return (f'git -C "{main}" rm -f --cached --ignore-unmatch -- "{path}" && '
                f'git -C "{main}" clean -f -- "{path}"')
    # `checkout HEAD --` et pas `checkout --` : si la revue a indexé son
    # écriture, restaurer depuis l'index remettrait précisément le contenu à
    # annuler.
    return f'git -C "{main}" checkout HEAD -- "{path}"'


def inactive(current):
    print(f"garde-fou inactif : {current} est le dépôt principal, pas un worktree lié")
    return OK


def do_snapshot(cwd):
    current, main = worktree_roots(cwd)
    if current == main:
        return inactive(current)
    target = state_path(cwd, current)
    target.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "worktree": str(current),
        "main": str(main),
        "created": time.time(),
        "fingerprint": fingerprint(main),
    }
    target.write_text(json.dumps(state, ensure_ascii=False, indent=2),
                      encoding="utf-8")
    count = len(state["fingerprint"]["files"])
    print(f"instantané du dépôt principal {main} : {count} fichier(s) déjà sale(s)")
    print(f"état : {target}")
    return OK


def do_verify(cwd):
    current, main = worktree_roots(cwd)
    if current == main:
        return inactive(current)
    source = state_path(cwd, current)
    if not source.exists():
        # Deux histoires mènent ici, et l'agent doit pouvoir les distinguer :
        # l'instantané n'a jamais été pris, ou un `verify` précédent l'a déjà
        # consommé. Un message qui n'accuserait que l'oubli enverrait sur une
        # fausse piste celui qui a simplement rejoué la commande.
        print("ÉCHEC : aucun instantané exploitable — soit `review_guard.py "
              "snapshot` n'a pas été lancé avant la revue, soit un `verify` "
              "précédent l'a déjà consommé. Un instantané ne vaut que pour la "
              "fenêtre de revue qu'il ouvre : reprendre à `snapshot`.",
              file=sys.stderr)
        print(f"attendu : {source}", file=sys.stderr)
        return NO_SNAPSHOT
    try:
        state = json.loads(source.read_text(encoding="utf-8"))
        before = state["fingerprint"]
        # Un instantané tronqué ou d'un format inattendu doit se lire comme une
        # absence d'instantané, pas comme une trace qu'on déréférence en aveugle.
        if not isinstance(before, dict) or not isinstance(before.get("files"), dict):
            raise ValueError("champ « fingerprint » incomplet")
        before.setdefault("head", "")
        created = float(state.get("created", 0.0))
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f"ÉCHEC : instantané illisible ({source}) : {exc}", file=sys.stderr)
        return NO_SNAPSHOT

    age = time.time() - created
    if age > SNAPSHOT_TTL:
        print(f"ÉCHEC : instantané périmé ({age / 3600:.1f} h) — il vient d'un run "
              f"antérieur au même emplacement, la revue de cette phase 5 n'a donc "
              f"pas été encadrée. Relancer `review_guard.py snapshot` avant la revue.",
              file=sys.stderr)
        print(f"périmé : {source}", file=sys.stderr)
        return NO_SNAPSHOT

    touched, head_moved = describe(before, fingerprint(main))
    findings = [(classify(main, path), path) for path in touched]
    already_dirty = set(before["files"])

    if not findings:
        # L'instantané a joué son rôle : le consommer évite qu'une phase 5
        # ultérieure au même emplacement croie être encadrée par celui-ci.
        try:
            source.unlink()
        except OSError:
            pass
        if head_moved:
            print("aucun fichier modifié hors du worktree — mais HEAD du dépôt "
                  "principal a bougé (a priori une récupération de l'orchestrateur) : "
                  "une écriture qui aurait été committée là n'est pas détectable.")
        else:
            print(f"aucune écriture hors du worktree : {main} est inchangé")
        return OK

    print(f"ÉCHEC : la revue a modifié {len(findings)} fichier(s) hors du "
          f"worktree courant, dans {main}", file=sys.stderr)
    for kind, path in findings:
        print(f"  {kind:8} {path}", file=sys.stderr)
    if head_moved:
        print("  (HEAD du dépôt principal a également bougé — vérifier s'il "
              "s'agit d'une récupération de l'orchestrateur)", file=sys.stderr)
    print("", file=sys.stderr)
    print("Ne pas restaurer et poursuivre en silence : c'est ce qui a masqué "
          "#167 deux fois.", file=sys.stderr)
    print("Journaliser `--status blocked` avec ces chemins, restaurer le dépôt "
          "principal, puis rendre la main :", file=sys.stderr)
    for kind, path in findings:
        print(f"  {remediation(main, path, kind)}", file=sys.stderr)
        if path in already_dirty:
            # Le fichier était déjà sale à l'instantané : la restauration
            # emporterait aussi la modification locale légitime qui l'y avait
            # mis. À dire, sinon la remédiation détruit du travail.
            print(f"    (attention : « {path} » était déjà modifié avant la "
                  f"revue — restaurer emporte aussi cette modification-là)",
                  file=sys.stderr)
    return DIRTY


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Vérifie qu'une revue lancée depuis un worktree n'écrit pas "
                    "dans le dépôt principal (#167).")
    parser.add_argument("action", choices=("snapshot", "verify"),
                        help="snapshot avant la revue, verify après")
    args = parser.parse_args(argv)
    cwd = Path.cwd()
    try:
        return do_snapshot(cwd) if args.action == "snapshot" else do_verify(cwd)
    except GuardError as exc:
        print(f"ÉCHEC : {exc}", file=sys.stderr)
        return USAGE


if __name__ == "__main__":
    sys.exit(main())
