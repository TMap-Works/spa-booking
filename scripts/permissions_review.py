#!/usr/bin/env python3
"""Transforme les demandes de permission répétées en règles d'allowlist.

    python scripts/permissions_review.py                      # ce qui a bloqué, et combien de fois
    python scripts/permissions_review.py --run <id>           # pendant ce run de jalon seulement
    python scripts/permissions_review.py --apply              # autorise les motifs répétés
    python scripts/permissions_review.py --apply --pattern "npm run verify"
    python scripts/permissions_review.py --forget             # repart de zéro

Les observations viennent du hook
[`.claude/hooks/permission_watch.py`](../.claude/hooks/permission_watch.py), qui
consigne chaque commande Bash qu'aucune règle `allow` ne couvre. Ce script en
fait le bilan et, **sur accord explicite**, ajoute les motifs à
`.claude/settings.json`.

## Ce qui n'est jamais autorisé automatiquement

Élargir une allowlist, c'est réduire ce sur quoi on sera consulté. Quatre
garde-fous, qu'aucun `--yes` ne lève :

  - un motif couvert par une règle `deny` n'est jamais proposé ;
  - un motif dont la portée est bornée par ses **arguments** et non par la
    commande — `head`, `cat`, `grep`, `sed`, `echo`, `tee`… — exige
    `--include-file-tools` **et** d'être nommé avec `--pattern` ;
  - `network` et `destructive` exigent leur drapeau `--include-*` **et** d'être
    nommés un par un avec `--pattern` ;
  - le motif proposé est le plus étroit qui couvre les commandes observées,
    jamais `git:*` là où `git status:*` suffit.

**Une règle `deny` protège un outil, jamais un chemin.** Les permissions sont
indexées par outil : `Read(./**/.env.production)` interdit à l'outil `Read`
d'ouvrir ce fichier, et ne dit rien de ce que `Bash` peut en faire. Autoriser
`Bash(head:*)` rend donc lisible tout ce que les `deny` de `Read` mettent à
l'abri, sans qu'aucune règle ne soit enfreinte — c'est ce qu'a montré #117. Le
garde-fou correspondant ne se déduit pas du bloc `deny` : il tient même vide.

Le seuil de répétition (`--threshold`, 2 par défaut) traduit la demande d'origine :
ce qui n'a bloqué qu'une fois n'a pas fait ses preuves.
"""
import argparse
import json
import os
import sys
from collections import defaultdict, namedtuple
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = Path(__file__).resolve().parents[1]
OBSERVED = Path(os.environ.get("SPA_PERMISSION_LOG",
                               ROOT / ".claude" / ".permissions" / "observed.ndjson"))
SETTINGS = ROOT / ".claude" / "settings.json"

SAFE_BY_DEFAULT = {"read", "write"}
RISK_ORDER = {"read": 0, "write": 1, "network": 2, "destructive": 3}
RISK_LABEL = {"read": "lecture", "write": "écriture",
              "network": "réseau", "destructive": "destructif"}

# Utilitaires dont la portée n'est pas bornée par la commande mais par ses
# arguments. `Bash(git status:*)` ne peut faire que ce que `git status` fait ;
# `Bash(head:*)` peut rendre le contenu de n'importe quel fichier du dépôt, et
# `Bash(echo:*)` en écrire n'importe lequel — `.claude/settings.json` compris,
# ce qui laisserait l'allowlist s'élargir toute seule.
#
# Ces deux ensembles ne remplacent pas le classement par risque de
# `.claude/hooks/permission_watch.py` : ils s'y ajoutent. `head` reste une
# lecture pour le système de fichiers ; ce qui se refuse ici, c'est la
# *largeur du motif*, pas ce que la commande observée a fait.
#
# Volontairement conservateurs : mieux vaut un drapeau de trop qu'un motif qui
# ouvre le dépôt. La liste s'allonge sans risque, elle ne peut que refuser plus.
FILE_READERS = {
    "cat", "tac", "nl", "head", "tail", "sed", "awk", "grep", "egrep", "fgrep",
    "rg", "ag", "ack", "less", "more", "strings", "xxd", "od", "hexdump",
    "cut", "sort", "uniq", "jq", "yq", "diff", "base64", "xargs",
}
FILE_WRITERS = {
    "echo", "printf", "tee", "sed", "cp", "mv", "dd", "install", "ln",
    "truncate", "touch", "chmod", "chown",
}

# Les paramètres d'une revue, réunis pour ne pas les faire circuler un par un.
Policy = namedtuple("Policy", "allow read_denies threshold classes file_tools")


def arbitrary_file_tool(pattern):
    """La portée de ce motif dépend-elle de ses arguments ? `"read"`, `"write"` ou `None`.

    `sed` figure dans les deux ensembles : il lit, et `sed -i` réécrit. La
    réponse la plus forte l'emporte — refuser au titre de l'écriture dit la
    chose la plus grave que le motif autoriserait.
    """
    head = pattern.split()[0] if pattern else ""
    if head in FILE_WRITERS:
        return "write"
    if head in FILE_READERS:
        return "read"
    return None


def file_tool_reason(kind, read_denies):
    """Pourquoi ce motif exige un drapeau — en nommant ce qu'il contournerait."""
    if kind == "write":
        return ("écrit un fichier quelconque, .claude/settings.json compris — "
                "exige --include-file-tools et --pattern")
    if read_denies:
        return (f"lit un fichier quelconque, dont les {len(read_denies)} chemins "
                "protégés par un deny Read — exige --include-file-tools et --pattern")
    return ("lit un fichier quelconque — exige --include-file-tools et --pattern")


def load_observations(run=None, session=None):
    if not OBSERVED.exists():
        return []
    records = []
    for line in OBSERVED.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if run and record.get("run") != run:
            continue
        if session and record.get("session") != session:
            continue
        records.append(record)
    return records


def aggregate(records):
    # Plancher au risque le plus faible : l'agrégat ne fait ensuite que monter.
    grouped = defaultdict(lambda: {"count": 0, "examples": [], "risk": "read",
                                   "denied": False, "runs": set(), "first": None,
                                   "last": None})
    for record in records:
        entry = grouped[record["pattern"]]
        entry["count"] += 1
        # Le plus élevé l'emporte, jamais le dernier vu : `git reset --hard`
        # (destructif) et `git reset HEAD~1` (écriture) se réduisent au même
        # motif `git reset`. Retenir le dernier observé ferait passer le motif
        # pour anodin et autoriserait `--hard` sans jamais demander le drapeau.
        seen = record.get("risk", "write")
        if RISK_ORDER.get(seen, 1) > RISK_ORDER.get(entry["risk"], 1):
            entry["risk"] = seen
        entry["denied"] = entry["denied"] or bool(record.get("denied"))
        if record.get("run"):
            entry["runs"].add(record["run"])
        entry["first"] = entry["first"] or record.get("ts")
        entry["last"] = record.get("ts")
        example = record.get("example")
        if example and example not in entry["examples"] and len(entry["examples"]) < 3:
            entry["examples"].append(example)
    return grouped


def current_rules():
    """Les blocs `allow` et `deny` du fichier de réglages, tels quels."""
    if not SETTINGS.exists():
        return [], []
    permissions = (json.loads(SETTINGS.read_text(encoding="utf-8"))
                   .get("permissions") or {})
    return permissions.get("allow") or [], permissions.get("deny") or []


def read_denies(deny):
    """Les règles `deny` posées sur l'outil `Read`.

    Le hook d'observation ne confronte les commandes qu'aux `deny` **Bash** —
    seuls ceux-là peuvent l'empêcher de s'exécuter. Ces règles-ci n'arrêteront
    donc jamais une commande Bash : elles servent ici à *nommer* ce qu'un motif
    trop large rendrait accessible malgré elles.
    """
    return [rule for rule in deny
            if isinstance(rule, str) and rule.startswith("Read(")]


def already_covered(pattern, allow):
    """Une règle existante couvre-t-elle déjà ce motif ?"""
    for rule in allow:
        if not isinstance(rule, str) or not rule.startswith("Bash("):
            continue
        inner = rule[5:-1]
        prefix = inner[:-2] if inner.endswith(":*") else inner
        if pattern == prefix or pattern.startswith(prefix + " ") or prefix == "":
            return True
    return False


def eligible(pattern, entry, policy):
    if entry["denied"]:
        return False, "couvert par une règle deny"
    if already_covered(pattern, policy.allow):
        return False, "déjà autorisé"
    if entry["count"] < policy.threshold:
        return False, f"vu {entry['count']}× (seuil {policy.threshold})"
    if entry["risk"] not in policy.classes:
        return False, f"{RISK_LABEL[entry['risk']]} — exige --include-{entry['risk']}"
    # Après le rang de risque, et non avant : un `rm` reste refusé au titre du
    # destructif, qui est l'objection la plus forte.
    kind = arbitrary_file_tool(pattern)
    if kind and not policy.file_tools:
        return False, file_tool_reason(kind, policy.read_denies)
    return True, None


def show(grouped, policy, as_json):
    if not grouped:
        print("aucune commande n'a demandé de permission depuis la dernière revue")
        return 0

    rows = []
    for pattern, entry in grouped.items():
        ok, why = eligible(pattern, entry, policy)
        rows.append((pattern, entry, ok, why))
    rows.sort(key=lambda r: (-r[1]["count"], RISK_ORDER.get(r[1]["risk"], 9), r[0]))

    if as_json:
        print(json.dumps([{"pattern": p, "count": e["count"], "risk": e["risk"],
                           "eligible": ok, "reason": why, "examples": e["examples"],
                           "runs": sorted(e["runs"])}
                          for p, e, ok, why in rows], ensure_ascii=False, indent=2))
        return 0

    retenus = [r for r in rows if r[2]]
    print(f"{len(rows)} motif(s) observé(s) · {len(retenus)} éligible(s) à l'allowlist\n")
    for pattern, entry, ok, why in rows:
        mark = "+" if ok else " "
        note = "" if ok else f"  ({why})"
        print(f"{mark} {entry['count']:>3}×  {RISK_LABEL[entry['risk']]:<10} "
              f"Bash({pattern}:*){note}")
        for example in entry["examples"][:2]:
            print(f"            {example[:88]}")
    print()

    if retenus:
        print("Pour les autoriser durablement :")
        print("  python scripts/permissions_review.py --apply")
    return 0


def apply(grouped, policy, wanted, assume_yes):
    chosen = []
    for pattern, entry in grouped.items():
        if wanted and pattern not in wanted:
            continue
        ok, why = eligible(pattern, entry, policy)
        if not ok:
            if wanted:
                print(f"refusé · Bash({pattern}:*) — {why}")
            continue
        # Un drapeau `--include-*` ne suffit jamais à lui seul : ce qu'il ouvre
        # se nomme, motif par motif. Sans cela, `--include-file-tools` lâcherait
        # d'un coup tout ce que la campagne d'observation a croisé.
        if pattern not in (wanted or set()):
            if entry["risk"] in {"network", "destructive"}:
                print(f"ignoré · Bash({pattern}:*) — {RISK_LABEL[entry['risk']]}, "
                      f"à nommer explicitement avec --pattern")
                continue
            if arbitrary_file_tool(pattern):
                print(f"ignoré · Bash({pattern}:*) — portée bornée par ses arguments, "
                      f"à nommer explicitement avec --pattern")
                continue
        chosen.append((pattern, entry))

    if not chosen:
        print("rien à ajouter")
        return 1

    chosen.sort(key=lambda item: -item[1]["count"])
    print("À ajouter dans .claude/settings.json :\n")
    for pattern, entry in chosen:
        print(f"  Bash({pattern}:*)     {entry['count']}× · {RISK_LABEL[entry['risk']]}")
    print()

    if not assume_yes:
        try:
            answer = input("Confirmer l'ajout ? [o/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return 1
        if answer not in {"o", "oui", "y", "yes"}:
            print("abandonné — rien n'a été modifié")
            return 1

    data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    permissions = data.setdefault("permissions", {})
    rules = permissions.setdefault("allow", [])
    for pattern, _ in chosen:
        rule = f"Bash({pattern}:*)"
        if rule not in rules:
            rules.append(rule)
    SETTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print(f"{len(chosen)} règle(s) ajoutée(s) à {SETTINGS.relative_to(ROOT)}")

    forget({pattern for pattern, _ in chosen})
    print("observations correspondantes purgées")
    print("\nLes règles d'un fichier de réglages ne sont relues qu'au démarrage : "
          "relancer Claude Code, ou les rejouer via /permissions.")
    return 0


def forget(patterns=None):
    """Retire des observations les motifs traités — le reste est conservé."""
    if not OBSERVED.exists():
        return
    if patterns is None:
        OBSERVED.unlink()
        return
    kept = []
    for line in OBSERVED.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("pattern") not in patterns:
            kept.append(line)
    OBSERVED.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", help="ne regarder que les observations d'un run de jalon")
    parser.add_argument("--session", help="ne regarder qu'une session Claude Code")
    parser.add_argument("--threshold", type=int, default=2,
                        help="nombre de répétitions à partir duquel un motif est proposé")
    parser.add_argument("--apply", action="store_true", help="ajouter à l'allowlist")
    parser.add_argument("--pattern", action="append", default=[],
                        help="ne traiter que ce motif (répétable)")
    parser.add_argument("--include-network", action="store_true")
    parser.add_argument("--include-destructive", action="store_true")
    parser.add_argument("--include-file-tools", action="store_true",
                        help="autoriser les motifs dont la portée dépend de leurs "
                             "arguments (head, cat, grep, sed, echo, tee…) — "
                             "à combiner avec --pattern")
    parser.add_argument("--yes", action="store_true", help="ne pas demander confirmation")
    parser.add_argument("--forget", action="store_true",
                        help="effacer les observations et repartir de zéro")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.forget:
        forget(set(args.pattern) or None)
        print("observations effacées")
        return 0

    classes = set(SAFE_BY_DEFAULT)
    if args.include_network:
        classes.add("network")
    if args.include_destructive:
        classes.add("destructive")
        print("attention : --include-destructive autorise des commandes irréversibles\n")
    if args.include_file_tools:
        print("attention : --include-file-tools autorise des motifs qui atteignent "
              "n'importe quel chemin, y compris ceux qu'un deny Read protège\n")

    records = load_observations(args.run, args.session)
    grouped = aggregate(records)
    allow, deny = current_rules()
    policy = Policy(allow=allow, read_denies=read_denies(deny),
                    threshold=args.threshold, classes=classes,
                    file_tools=args.include_file_tools)

    if args.apply:
        return apply(grouped, policy, set(args.pattern), args.yes)
    return show(grouped, policy, args.json)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
