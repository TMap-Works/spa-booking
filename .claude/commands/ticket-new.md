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
(anatomie d'une issue) et §12 (traçabilité des demandes).

## Pourquoi cette commande existe

L'objectif est d'avoir dans GitHub l'historique de ce qui a été **demandé** à
Claude Code, et pas seulement de ce qui a été commité.

Cette ouverture est **délibérée** : c'est l'utilisateur qui décide qu'une demande
mérite un ticket, pas une heuristique de mots-clés déclenchée à chaque message.
Un historique noyé sous des tickets « ok, continue » ne documente rien.

Un ticket ouvert ici se referme avec **`/ticket-close`**, qui y publie le résumé
des changements. Les deux vont par paire : un ticket laissé ouvert fausse le
suivi du sprint.

## Phase 1 — Y a-t-il déjà un ticket ouvert ?

```bash
python scripts/tracking.py status
```

- **Sortie `{}`** → aucun ticket ouvert : aller en phase 2, puis 3 (créer).
- **Sortie avec un `issue`** → un ticket existe déjà. Ne **jamais** en créer un
  second : aller en phase 4 (compléter ou corriger).

## Phase 2 — Classer la demande

Décider les quatre attributs, d'après le contenu réel de la demande et non
d'après ses mots :

| Attribut | Valeurs |
|---|---|
| `--module` | `identity` `catalog` `availability` `appointments` `crm` `payments` `notifications` `reporting` `infra` |
| `--workstream` | `Backend` `Frontend` `DevOps` `Design` `QA` |
| `--type` | `feature` `bug` `chore` `docs` `spike` `epic` |
| `--priority` | `P0` bloquant · `P1` requis pour le MVP · `P2` souhaitable |

Toujours passer les quatre options : ce qui n'est pas fourni retombe sur une
déduction par mots-clés, souvent fausse, et un board qui ment ne sert à rien.

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

Une fois le ticket ouvert, ajouter `Refs #N` aux commits produits pour cette
demande : c'est ce qui relie le ticket et le code dans les deux sens.

## Phase 4 — Compléter ou corriger un ticket existant

La demande en cours est **nouvelle mais relève du même travail** — la rattacher
au ticket ouvert plutôt que d'en ouvrir un second :

```bash
python scripts/tracking.py note --prompt "<la demande complémentaire>"
```

Le **classement du ticket est faux** — le corriger :

```bash
python scripts/tracking.py classify <N> --module <m> --workstream <w> \
  --type <t> --priority <p>
```

Les attributs déjà justes s'omettent — ce qui n'est pas passé est conservé. La
commande remplace les labels de la même famille, pose le jalon s'il manque et
met la carte du Project à jour.

La demande en cours **n'a rien à voir** avec le ticket ouvert : refermer d'abord
l'ancien avec `/ticket-close`, puis reprendre en phase 2.

## Phase 5 — Rendre compte

Une ligne, pas un rapport : numéro et URL du ticket, jalon, les quatre labels,
et l'état de la carte. Si `"project": false` apparaît dans la sortie, le dire
franchement avec la raison — un ticket hors board ne remplit pas son office.

Rappeler la suite : `/ticket-close` en fin de travail.

## Ce que cette commande n'est pas

Un ticket de traçabilité **n'est pas une issue du backlog**. Il documente ce qui
a été demandé à Claude Code ; il ne pilote pas l'avancement du MVP. Pour un vrai
lot de travail, créer l'issue avec `gh issue create` puis `/feature-start` ou
`/ticket`.
