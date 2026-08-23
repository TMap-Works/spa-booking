# Contribuer

## Prérequis

- Node.js 20 LTS, npm 10
- Docker (Postgres + Redis en local)
- AWS CLI et Terraform (pour l'infrastructure)
- GitHub CLI (`gh`), authentifié sur l'organisation TMap-Works

## Démarrage

```bash
npm install
cp .env.example .env.local        # renseigner les valeurs locales
docker compose up -d              # Postgres + Redis
npm run db:migrate
npm run dev                       # api + web en parallèle
```

## Règle n°1 : rien ne se code sans issue

L'issue rattache le travail à son sprint, son workstream et son module. Une PR
sans issue liée ne peut pas être suivie dans le GitHub Project et sera refusée.

Toute issue porte : un **milestone** (`S1` à `S4`), un label `ws:*`, un label
`mod:*`, un label `type:*` et une priorité (`P0`/`P1`/`P2`).

Une demande hors du périmètre MVP (voir [CLAUDE.md](CLAUDE.md) et le CDC §1.4)
reçoit le label `post-mvp`, aucun milestone, et n'est pas travaillée.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), validés par
commitlint en CI.

```
<type>(<scope>): <sujet à l'impératif, ≤ 100 caractères, sans point final>
```

Types : `feat` `fix` `docs` `ci` `chore` `security` `perf` `hotfix` `test` `refactor`
Scope : le module métier concerné (`availability`, `payments`…) ou `infra`, `web`, `ci`.

```
feat(availability): calcul des créneaux avec buffers avant/après
fix(notifications): ne pas envoyer le rappel d'un RDV annulé
security(payments): vérifier la signature des webhooks sur le corps brut
```

## Pull requests

- Cible `develop` (ou `main` pour un `hotfix/*`).
- Titre en Conventional Commits — il devient le message de merge.
- Corps contenant **`Closes #<numéro>`** : c'est ce qui ferme l'issue et déplace
  la carte du Project en `Done`.
- Une PR = une issue.
- CI verte obligatoire : lint, types, tests, commitlint, scan de sécurité.

## Definition of Done

- [ ] Code revu et approuvé
- [ ] Tests unitaires et d'intégration passants
- [ ] Test d'isolation inter-tenant pour tout endpoint nouveau
- [ ] Déployé et vérifié en recette (`staging`)
- [ ] Documenté (README de module, ADR si décision structurante)
- [ ] Critères d'acceptation de l'issue cochés

## Travailler avec Claude Code

Le dépôt embarque un environnement Claude Code complet dans [.claude/](.claude/) :

**Skills** — chargées automatiquement selon le contexte, ou explicitement :

| Skill | Quand |
|---|---|
| `booking-engine` | Créneaux, disponibilité, RDV, concurrence |
| `tenant-isolation` | Toute écriture de requête, migration ou endpoint |
| `api-module` | Tout travail dans `apps/api` |
| `web-frontend` | Tout travail dans `apps/web` |
| `payments-stripe` | Paiement, Stripe, encaissement, PCI |
| `notifications` | E-mail, SMS, rappels, SES/SNS |
| `aws-infra` | Terraform, AWS, déploiement |
| `project-flow` | Issues, branches, PR, Project |

**Commandes** : `/feature-start <issue>`, `/pr-open`, `/sprint-status [S1-S4]`,
`/adr-new <titre>`

**Agents** : `tenant-leak-auditor` (audit d'isolation multi-tenant),
`mvp-scope-guard` (verdict dans/hors périmètre MVP)

**Traçabilité automatique** : chaque demande substantielle faite à Claude Code
ouvre un ticket GitHub (label `tracking`), refermé en fin de tour avec le résumé
des changements produits. Ces tickets historisent la collaboration ; ils sont
exclus du board de suivi du MVP et ne remplacent pas les issues du backlog.
Détail et réglages dans [.claude/hooks/README.md](.claude/hooks/README.md).
