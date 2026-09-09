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
| Labels | 29 — workstream, module, type, nature, priorité, transverses |
| Backlog | 9 epics et 74 issues, rattachées en sous-issues, toutes dans le Project |
| Modèles | Issues (fonctionnalité, bug, tâche, post-MVP) et pull request |
| CODEOWNERS | Revue obligatoire sur `infra/`, workflows, paiements, disponibilité, rendez-vous, migrations, `.claude/` |
| Merge | Squash uniquement, suppression automatique de la branche, titre de PR comme message |
| Environnements | `dev`, `staging`, `prod` |
| Traçabilité | Hooks Claude Code : un ticket `tracking` par demande — jalon, labels, carte Project — clôturé avec le résumé des changements |

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

- `tracking` — ticket ouvert par `/ticket-new` pour historiser une demande faite
  à Claude Code, refermé par `/ticket-close`. Rattaché au jalon du sprint et au
  Project comme n'importe quelle issue ; ce label est ce qui permet de l'en
  filtrer. Voir
  [project-flow §12](../.claude/skills/project-flow/SKILL.md).
- `post-mvp` — hors périmètre, sans milestone, non travaillé pendant le MVP.
- `nature:projet` / `nature:outillage` — quelle file déroule le ticket. Un run
  de jalon n'en déroule qu'une, `nature:projet` par défaut et `nature:outillage`
  sur `--nature outillage` ; l'outillage — `scripts/`, `.claude/`, le
  harnais qui les teste — attend une session humaine, un ticket à la fois. Toute
  issue en porte un : sans lui, le plan l'écarte pour classement incomplet. Voir
  [project-flow §2](../.claude/skills/project-flow/SKILL.md).

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
« required reviewers » sur `prod` n'est pas disponible en Free.

Le mécanisme, lui, est en place depuis #77 : les jobs `deploy` et
`rollback-on-failure` de `deploy-production.yml`, comme le job `apply` de
`terraform.yml`, déclarent `environment: prod`. Dès que la règle sera posée, ils
attendront l'accord d'un relecteur **avant leur première étape** — donc avant
l'instantané RDS, avant les images, avant les migrations.

Tant qu'elle ne l'est pas, ce bloc ne retient personne : il résout les variables
de l'environnement et présente le sujet OIDC attendu, rien de plus. Ce qui tient
lieu de barrière en attendant est plus faible et il faut le savoir : le workflow
ne se déclenche que sur `main` ou sur un `workflow_dispatch` explicite, et le
parcours critique de bout en bout doit être vert avant que `deploy` ne démarre.

**Ne pas retirer ces blocs `environment:` en attendant.** La politique de
confiance des rôles OIDC n'accepte que `repo:<dépôt>:environment:prod` et refuse
`ref:refs/heads/main` : un job qui ne le déclare pas n'obtient aucun rôle. Les
retirer ne contournerait pas l'approbation, cela couperait le déploiement.

Une fois le plan relevé :

```bash
gh api -X PUT repos/TMap-Works/spa-booking/environments/prod \
  -f 'reviewers[][type]=User' -F 'reviewers[][id]=<identifiant du relecteur>'
```

### 3. Secrets et variables AWS

À renseigner quand le compte AWS et les rôles OIDC existent (issue #14).

**Des `variable` et non des `secret`**, y compris pour les ARN de rôle : un ARN
de rôle n'est pas un secret, et le tenir hors des secrets rend visible d'un coup
d'œil qu'aucun identifiant AWS n'est stocké ici. Aucune clé d'accès AWS statique
n'existe nulle part — l'authentification passe par OIDC.

**Au niveau du dépôt**, jamais au niveau d'un environnement :

```bash
gh variable set AWS_REGION                 --repo TMap-Works/spa-booking --body "eu-west-3"
gh variable set AWS_DEPLOY_ROLE_ARN        --repo TMap-Works/spa-booking --body "arn:aws:iam::…:role/spa-github-deploy"
gh variable set AWS_TERRAFORM_ROLE_ARN     --repo TMap-Works/spa-booking --body "arn:aws:iam::…:role/spa-github-terraform"
gh variable set AWS_TERRAFORM_PLAN_ROLE_ARN --repo TMap-Works/spa-booking --body "arn:aws:iam::…:role/spa-github-terraform-plan"
```

Ce niveau n'est pas une commodité. `deploy-production.yml` porte deux gardes qui
**doivent** rester identiques — celle du job `e2e`, qui ne déclare pas
`environment:` pour ne pas soumettre le parcours critique à l'approbation
manuelle, et celle du job `deploy`, qui la déclare. Porter ces trois variables au
niveau d'un environnement désaccorderait les deux : `e2e` ne les verrait pas,
serait ignoré, `deploy` le serait à son tour par `needs`, et **plus rien ne
partirait en production sur un run vert**.

**Par environnement**, après le premier `terraform apply` :

```bash
gh variable set APP_URL --env prod --repo TMap-Works/spa-booking \
  --body "$(terraform -chdir=infra/terraform/envs/prod output -raw app_url)"
```

`APP_URL` est l'origine **publique** — celle de la distribution CloudFront en
production, pas celle de l'ALB. C'est ce qui fait que la sonde de santé
post-déploiement éprouve aussi le certificat de bord, la Web ACL de bord et la
résolution DNS du nom public.

**Le contenu du `.tfvars` de chaque environnement déployé**, en variable de
dépôt : `STAGING_TFVARS` et `PROD_TFVARS`. `.gitignore` écarte `*.tfvars`, le
checkout de la CI n'en porte aucun, et un `terraform apply` qui ne passe que
`-var image_tag` ramène **toutes les autres variables à leur défaut**.

Sur la production, ce n'est pas une dégradation mais une destruction :
`public_domain_name` redevenant nul, l'`apply` détruit la distribution
CloudFront, sa Web ACL de bord et les deux certificats ACM, et remplace le
certificat du listener 443 par un repli auto-signé. `deploy-production.yml`
**échoue** donc quand `PROD_TFVARS` est absente, là où `deploy-staging.yml` se
contente d'un avertissement. Voir
[runbooks/mise-en-production.md](runbooks/mise-en-production.md).

`terraform.yml` les lit aussi — dans son job `plan` comme dans son job `apply`,
et `DEV_TFVARS` s'y ajoute pour l'environnement de développement. Un `apply`
manuel sur `prod` **échoue** sans `PROD_TFVARS`, pour la même raison que
`deploy-production.yml` ; un plan sans elle porte sur les défauts, et les
destructions qu'il affiche sont un artefact de la CI, pas une intention.

Ces variables doivent porter `image_tag`, à côté du reste : `terraform.yml`
n'en passe aucun en ligne de commande, et son défaut d'amorçage ferait viser une
image inexistante aux services. Les workflows de déploiement, eux, posent
`-var image_tag=<sha>`, qui l'emporte sur un `*.auto.tfvars`.

Ces variables portent des noms de domaine et des ARN de certificat, pas des
secrets : ce qui est sensible — mot de passe, jeton — passe par AWS Secrets
Manager et n'apparaît jamais ici.

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

### Prérequis local pour `/ticket`

`EnterWorktree` branche depuis `origin/<branche par défaut>`, résolue via
`origin/HEAD`. Sur un clone où cette référence n'est pas posée, le worktree part
d'`origin/main` — la production — au lieu de `develop`. À faire une fois par
clone :

```bash
git remote set-head origin develop
git symbolic-ref refs/remotes/origin/HEAD   # doit afficher refs/remotes/origin/develop
```

Un clone frais de GitHub hérite déjà de `develop`, puisque c'est la branche par
défaut du dépôt ; la correction ne concerne que les clones antérieurs.
