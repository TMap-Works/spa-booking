# Configuration GitHub du projet

État de la mise en place, et ce qui reste à faire manuellement.

## En place

| Élément | Détail |
|---|---|
| Dépôt | [TMap-Works/spa-booking](https://github.com/TMap-Works/spa-booking) — privé |
| Branches | `main` (production), `staging` (recette), `develop` (intégration, branche par défaut) |
| Project | [Spa & Salon Booking — MVP](https://github.com/orgs/TMap-Works/projects/2) — org, n°2, lié au dépôt |
| Champs du Project | Status, Sprint, Workstream, Module, Priority, Estimate |
| Milestones | S1 à S4, avec échéances hebdomadaires du 28/08 au 18/09/2026 |
| Labels | 27 — workstream, module, type, priorité, transverses |
| Backlog | 9 epics et 74 issues, rattachées en sous-issues, toutes dans le Project |
| Modèles | Issues (fonctionnalité, bug, tâche, post-MVP) et pull request |
| CODEOWNERS | Revue obligatoire sur `infra/`, workflows, paiements, disponibilité, rendez-vous, migrations, `.claude/` |
| Merge | Squash uniquement, suppression automatique de la branche, titre de PR comme message |
| Environnements | `dev`, `staging`, `prod` |
| Traçabilité | Hooks Claude Code : un ticket `tracking` par demande, clôturé avec le résumé des changements |

## Workflows

| Workflow | Déclencheur | Rôle |
|---|---|---|
| `ci.yml` | PR et push sur `develop` | Lint, types, tests unitaires, intégration, **concurrence**, build |
| `commitlint.yml` | PR | Conventional Commits sur les commits et le titre de PR |
| `pr-governance.yml` | PR | Nom de branche, branche cible, présence de `Closes #`, rappels de revue ciblés |
| `security-scan.yml` | PR, hebdomadaire | gitleaks, Trivy, tfsec, CodeQL |
| `project-automation.yml` | Issues et PR | Statut, Sprint, Workstream, Module, Priority de la carte |
| `terraform.yml` | PR sur `infra/`, manuel | `fmt`, `validate`, `plan` commenté sur la PR ; `apply` manuel |
| `deploy-dev.yml` | Push sur `develop` | Build, push ECR, migrations, déploiement ECS |
| `deploy-staging.yml` | Push sur `staging` | Idem sur staging |
| `deploy-production.yml` | Push sur `main` | Snapshot RDS, déploiement, health check, tag, **rollback automatique** |
| `changelog.yml` | Push sur `main` | CHANGELOG depuis les commits conventionnels |

## Labels particuliers

- `tracking` — ticket ouvert automatiquement par les hooks Claude Code pour
  historiser une demande. Sans milestone, exclu du Project. Voir
  [.claude/hooks/README.md](../.claude/hooks/README.md).
- `post-mvp` — hors périmètre, sans milestone, non travaillé pendant le MVP.

## À faire manuellement

### 1. Secret `PROJECT_TOKEN` — requis pour l'automatisation du Project

`GITHUB_TOKEN` ne peut pas écrire dans un projet d'organisation : c'est une
limite de GitHub, pas un choix de configuration. Sans ce secret,
`project-automation.yml` ne s'exécute pas et les cartes doivent être déplacées à
la main.

1. Créer un **personal access token (classic)** sur
   <https://github.com/settings/tokens> avec les scopes `project` et `repo`.
2. L'enregistrer :

```bash
gh secret set PROJECT_TOKEN --repo TMap-Works/spa-booking
```

### 2. Protection des branches — nécessite une montée de plan

L'organisation est sur le plan **Free** : les rulesets et la protection de
branche sur dépôt privé exigent GitHub Pro, Team ou Enterprise. L'API renvoie
403 aujourd'hui.

Conséquence à connaître : **rien n'empêche techniquement un push direct sur
`main`**. `pr-governance.yml` fait respecter les conventions de PR (nom de
branche, branche cible, référence à l'issue) mais ne peut pas bloquer un push
qui contourne la PR.

Une fois le plan relevé :

```bash
bash scripts/setup-branch-protection.sh
```

Le script applique 2 approbations et revue CODEOWNERS sur `main`, 1 approbation
sur `staging` et `develop`, les contrôles de statut obligatoires, et interdit
suppression et force-push.

Même limite sur les **approbations manuelles d'environnement** : la règle
« required reviewers » sur `prod` n'est pas disponible en Free. En attendant,
`deploy-production.yml` ne se déclenche que sur `main`, et `terraform apply` en
production reste un déclenchement manuel.

### 3. Secrets et variables AWS

À renseigner quand le compte AWS et les rôles OIDC existent (issue #14) :

```bash
gh secret   set AWS_DEPLOY_ROLE_ARN    --repo TMap-Works/spa-booking
gh secret   set AWS_TERRAFORM_ROLE_ARN --repo TMap-Works/spa-booking
gh variable set AWS_REGION             --repo TMap-Works/spa-booking --body "eu-west-3"
gh variable set APP_URL       --env dev --repo TMap-Works/spa-booking --body "https://dev.example.com"
gh variable set ECS_NETWORK_CONFIG --env dev --repo TMap-Works/spa-booking --body "awsvpcConfiguration={...}"
```

Aucune clé d'accès AWS statique : l'authentification passe par OIDC.

### 4. Secrets Stripe

Clés de **test** en dev et staging, clés live en production uniquement. En
déployé, la source est AWS Secrets Manager ; ces secrets GitHub ne servent
qu'aux tests d'intégration en CI.

## Rappels de fonctionnement

- La branche par défaut est **`develop`** : une PR créée sans préciser la base
  cible `develop`, ce qui est le cas courant. Une PR vers `main` qui ne vient ni
  de `staging` ni d'un `hotfix/*` est rejetée par `pr-governance.yml`.
- Le nom de branche **doit** contenir le numéro d'issue
  (`feature/42-moteur-disponibilite`) : c'est ce qui relie la branche à sa carte.
- Le corps de PR **doit** contenir `Closes #42` : c'est ce qui ferme l'issue et
  déplace la carte en `Done`.
