---
description: Ouvre — ou corrige — le ticket de traçabilité de la demande en cours, rattaché à son jalon, ses labels et au GitHub Project
argument-hint: [description de la demande] [--module m] [--type t] [--priority P1]
allowed-tools: Bash, Read, Skill
---

Ouvre le ticket de traçabilité de la demande en cours, **correctement rattaché** :
jalon de sprint, label workstream, label module, label type, priorité, et carte
sur le GitHub Project.

Demande à historiser : **$ARGUMENTS** — si l'argument est vide, prendre la
dernière demande de l'utilisateur dans cette conversation.

Conventions de référence : [.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md) §2
(anatomie d'une issue) et [.claude/hooks/README.md](.claude/hooks/README.md).

## Pourquoi cette commande existe

Le hook `UserPromptSubmit` ouvre un ticket tout seul, mais il se tait dans trois
cas : commande slash, relance triviale, demande de moins de 30 caractères. Et
son classement n'est qu'une heuristique de mots-clés, alors que toi tu as lu la
demande. Cette commande couvre les deux manques — le trou et l'erreur.

## Phase 1 — Y a-t-il déjà un ticket pour ce tour ?

```bash
python scripts/tracking.py status
```

- **Sortie `{}`** → aucun ticket ouvert : aller en phase 3 (créer).
- **Sortie avec un `issue`** → un ticket existe déjà pour cette session. Ne
  **jamais** en créer un second : aller en phase 4 (corriger).

## Phase 2 — Classer la demande

Décider les quatre attributs, d'après le contenu réel de la demande et non
d'après ses mots :

| Attribut | Valeurs |
|---|---|
| `--module` | `identity` `catalog` `availability` `appointments` `crm` `payments` `notifications` `reporting` `infra` |
| `--workstream` | `Backend` `Frontend` `DevOps` `Design` `QA` |
| `--type` | `feature` `bug` `chore` `docs` `spike` `epic` |
| `--priority` | `P0` bloquant · `P1` requis pour le MVP · `P2` souhaitable |

Le jalon est celui du sprint en cours, résolu automatiquement — ne passer
`--milestone` que pour rattacher la demande à un autre sprint.

Une demande manifestement **hors périmètre MVP** (CDC §1.4) se classe quand même
ici — le ticket documente qu'elle a été faite — mais le dire à l'utilisateur et
proposer une issue `post-mvp` plutôt qu'une implémentation. En cas de doute,
charger l'agent `mvp-scope-guard`.

## Phase 3 — Créer

```bash
python scripts/tracking.py open \
  --prompt "<la demande, telle que formulée>" \
  --module <m> --workstream <w> --type <t> --priority <p>
```

Vérifier d'abord avec `--dry-run` si le classement mérite d'être confirmé par
l'utilisateur.

Le ticket est enregistré sous l'état `manual` : le hook `Stop` le refermera en
fin de tour avec le résumé des changements, exactement comme un ticket
automatique. Ajouter `Refs #N` aux commits produits pour cette demande.

## Phase 4 — Corriger un ticket existant

```bash
python scripts/tracking.py classify <N> --module <m> --workstream <w> \
  --type <t> --priority <p>
```

Les attributs déjà justes s'omettent — ce qui n'est pas passé est conservé. La
commande remplace les labels de la même famille, pose le jalon s'il manque et
met la carte du Project à jour.

## Phase 5 — Rendre compte

Une ligne, pas un rapport : numéro et URL du ticket, jalon, les quatre labels,
et l'état de la carte. Si `"project": false` apparaît dans la sortie, le dire
franchement avec la raison — un ticket hors board ne remplit pas son office.

## Ce que cette commande n'est pas

Un ticket de traçabilité **n'est pas une issue du backlog**. Il documente ce qui
a été demandé à Claude Code ; il ne pilote pas l'avancement du MVP. Pour un vrai
lot de travail, créer l'issue avec `gh issue create` puis `/feature-start` ou
`/ticket`.
