# oidc — GitHub Actions vers AWS, sans clé statique

Ce module donne à la CI le droit d'agir sur le compte AWS **sans qu'aucun
identifiant ne soit stocké nulle part**. GitHub signe un jeton OIDC valable
quelques minutes, AWS le vérifie auprès de l'émetteur, et n'ouvre une session que
si le sujet du jeton figure dans la politique de confiance du rôle demandé.

L'alternative — une paire `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` dans les
secrets du dépôt — est un identifiant permanent que rien n'expire, qui se copie
sans laisser de trace et dont la fuite ne se détecte qu'après coup. Le CLAUDE.md
l'interdit ; ce module est ce qui rend l'interdiction tenable.

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Fournisseur OIDC | `token.actions.githubusercontent.com` | Émetteur de confiance, audience `sts.amazonaws.com` |
| Rôle IAM | `spa-github-deploy` | Pousser les images, jouer la migration, dérouler les services ECS |
| Rôle IAM | `spa-github-terraform` | `terraform apply` — administration du compte |
| Rôle IAM | `spa-github-terraform-plan` | `terraform plan` sur pull request — lecture seule |

Ces rôles ne portent pas d'environnement dans leur nom, contrairement à la
convention `spa-{env}-{composant}` : ils sont uniques pour le compte et servent
les trois environnements, comme `bootstrap`.

## Pourquoi trois rôles et non deux

Le ticket demande « un rôle par usage : déploiement applicatif et Terraform ».
Terraform en compte deux, et les confondre serait un trou :

- le job `apply` se déclenche à la main (`workflow_dispatch`) sur du code déjà
  mergé, à travers un environnement GitHub — donc avec approbation manuelle sur
  `prod` ;
- le job `plan` se déclenche sur **pull request**, donc sur du code que personne
  n'a encore relu. Or un `plan` n'est pas inerte : un `provisioner local-exec` ou
  une source de données `external` ajoutés dans la PR s'exécutent. Lui donner le
  rôle d'`apply` reviendrait à donner l'administration du compte à quiconque ouvre
  une pull request.

D'où un rôle de `plan` en lecture seule, avec juste ce qu'il faut pour lire l'état
distant et poser le verrou DynamoDB.

## La politique de confiance

Deux conditions sur chaque rôle, toutes deux en `StringEquals` — jamais
`StringLike`, un `*` dans un sujet ouvrant le compte à toutes les branches voire à
tous les dépôts :

```
token.actions.githubusercontent.com:aud = sts.amazonaws.com
token.actions.githubusercontent.com:sub ∈ <liste exacte>
```

Les sujets acceptés diffèrent d'un rôle à l'autre parce que **le sujet dépend du
déclencheur du job, pas du rôle demandé** :

| Job | Déclencheur | Sujet présenté | Rôle |
|---|---|---|---|
| `deploy-dev` | push `develop`, `environment: dev` | `repo:…:environment:dev` | `deploy` |
| `deploy-staging` | push `staging`, `environment: staging` | `repo:…:environment:staging` | `deploy` |
| `deploy-production` | push `main`, `environment: prod` | `repo:…:environment:prod` | `deploy` |
| `terraform` — plan | `pull_request` | `repo:…:pull_request` | `terraform-plan` |
| `terraform` — apply | `workflow_dispatch`, `environment: <env>` | `repo:…:environment:<env>` | `terraform` |

Un job qui déclare `environment:` porte `environment:<nom>` et **pas** la branche.
Les trois workflows `deploy-*` en déclarent un : **aucun sujet de branche n'est
accepté**, et `deployment_branches` vaut `[]` par défaut.

Ce vide est délibéré. Le rôle de déploiement est unique pour les trois
environnements — il pousse dans l'ECR de production, déroule `spa-prod-api` et
`spa-prod-web`, prend l'instantané RDS. Accepter `ref:refs/heads/<branche>`
donnerait donc les pleins droits de déploiement en production à n'importe quel job
poussé sur cette branche **sans** bloc `environment:`, c'est-à-dire sans
l'approbation manuelle de `prod` : écarter `ref:refs/heads/main` tout en acceptant
`ref:refs/heads/develop` ne fermerait rien, puisque c'est le même rôle.

Renseigner `deployment_branches` n'a de sens que pour un workflow de déploiement
qui n'aurait pas d'environnement GitHub — et cela rouvre exactement ce
contournement.

### La restriction par branche que le module ne peut pas poser

Puisqu'un sujet `environment:prod` ne dit rien de la branche, c'est la **politique
de branches de déploiement** de l'environnement GitHub qui restreint `prod` à
`main`. Le module l'expose en sortie (`expected_deployment_branch_policies`) mais
ne peut pas la configurer : elle vit côté GitHub. À poser une fois :

```bash
gh api -X PUT repos/TMap-Works/spa-booking/environments/prod \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/TMap-Works/spa-booking/environments/prod/deployment-branch-policies \
  -f name=main
```

Sans elle, un workflow sur n'importe quelle branche déclarant `environment: prod`
obtiendrait le rôle de déploiement — l'approbation manuelle resterait, mais la
branche ne serait plus contrainte.

## Le garde-fou sur le rôle Terraform

`protect_oidc_resources` (activé par défaut) attache au rôle d'`apply` un `Deny`
explicite sur le fournisseur d'identité et sur les trois rôles. Un `Deny` l'emporte
sur n'importe quel `Allow`, `AdministratorAccess` compris.

Sans lui, un `apply` détourné — module tiers compromis, pull request appliquée par
erreur — pourrait élargir sa propre politique de confiance à `*` et s'ouvrir un
accès permanent qu'aucune rotation de jeton ne rattraperait.

Ce que le garde-fou ne fait **pas** : il protège ces quatre ressources-là, pas le
compte. Un `apply` détourné porte `AdministratorAccess` — il peut créer un rôle
*neuf* avec la politique de confiance de son choix. Ce `Deny` empêche la porte
existante d'être élargie sans qu'on le voie ; il ne remplace pas la surveillance de
`iam:CreateRole` et `iam:CreateOpenIDConnectProvider` dans CloudTrail.

**Conséquence à connaître : ce module s'applique avec une identité
d'administrateur, jamais depuis la CI.** C'est cohérent avec sa nature — comme
`bootstrap`, il fabrique ce dont le reste dépend.

## Instanciation

Le module est à composer depuis une racine appliquée **une fois**, par un
administrateur, au même titre que `bootstrap` — pas depuis `envs/<env>`, dont
l'état est propre à un environnement alors que ces rôles sont uniques pour le
compte.

```hcl
module "github_oidc" {
  source = "../modules/oidc"

  github_repository = "TMap-Works/spa-booking"

  # Une fois l'amorçage appliqué, relever les identifiants dans sa sortie
  # `state_kms_key_ids` et les composer en ARN — une politique IAM refuse un UUID
  # nu en `Resource` :
  #
  #   arn:aws:kms:eu-west-3:<compte>:key/<uuid>
  #
  # Laissé vide, le repli reste borné aux clés portant l'alias `spa-<env>-tfstate`
  # (`kms:ResourceAliases`) et aux appels passant par S3 ou DynamoDB
  # (`kms:ViaService`).
  state_kms_key_arns = []
}

output "github_repository_variables" {
  value = module.github_oidc.github_repository_variables
}
```

Puis reporter les ARN dans les **variables** du dépôt — pas dans ses secrets :

```bash
terraform output -json github_repository_variables | jq -r 'to_entries[] | [.key, .value] | @tsv' \
  | while IFS=$'\t' read -r name value; do
      gh variable set "$name" --repo TMap-Works/spa-booking --body "$value"
    done

gh variable set AWS_REGION --repo TMap-Works/spa-booking --body eu-west-3
```

Un ARN de rôle n'est pas un secret : il ne donne rien à qui ne possède pas de
jeton OIDC signé pour le bon dépôt. Le garder en `vars` a un intérêt concret —
la liste des secrets du dépôt reste vide de tout ce qui touche à AWS, et le
constater est immédiat :

```bash
gh secret list --repo TMap-Works/spa-booking   # aucune entrée AWS_*
```

Le job **« Aucune clé AWS statique »** de `security-scan.yml` vérifie la même
chose à chaque pull request, côté code : aucun workflow ne peut réintroduire
`AWS_ACCESS_KEY_ID` ni un `secrets.AWS_*` sans faire rougir la CI.

## Vérifier une session

Une fois les variables posées, le premier workflow qui s'authentifie doit apparaître
dans CloudTrail sous `AssumeRoleWithWebIdentity`. En cas de refus, l'erreur
`Not authorized to perform sts:AssumeRoleWithWebIdentity` ne dit jamais pourquoi :
dans la quasi-totalité des cas, le sujet présenté n'a pas la forme attendue. Le
relever tel quel dans le jeton plutôt que de le deviner —
`actions/github-script` avec `core.getIDToken()` suffit à l'afficher — et le
comparer à la sortie `trusted_subjects`.

## Variables principales

| Variable | Défaut | Rôle |
|---|---|---|
| `github_repository` | `TMap-Works/spa-booking` | Seul dépôt autorisé |
| `deployment_environments` | `["dev","staging","prod"]` | Environnements GitHub acceptés |
| `deployment_branches` | `[]` | Branches acceptées sans environnement — rouvre le contournement de l'approbation `prod` |
| `existing_oidc_provider_arn` | `null` | Se raccorder à un fournisseur déjà créé |
| `terraform_managed_policy_arns` | `AdministratorAccess` | Droits du rôle d'`apply` |
| `terraform_plan_managed_policy_arns` | `ReadOnlyAccess` | Droits du rôle de `plan` |
| `state_kms_key_arns` | `[]` | ARN des clés de l'état ; vide ⇒ repli borné par `kms:ViaService` **et** `kms:ResourceAliases` |
| `protect_oidc_resources` | `true` | `Deny` protégeant le fournisseur et les rôles |

Liste complète et justifications dans `variables.tf`.

## Limites connues

- Le rôle d'`apply` porte `AdministratorAccess`. C'est assumé : Terraform crée ici
  des rôles IAM, des clés KMS, des bases RDS et des VPC, et toute politique plus
  étroite se traduirait par un `apply` qui échoue à mi-parcours en laissant
  l'infrastructure à moitié posée. Le confinement vient de la politique de
  confiance et de l'approbation manuelle sur `prod`, pas de l'étendue des droits.
- Les ARN de ressources du rôle de déploiement sont construits par convention de
  nommage (`spa-{env}-api`, `spa-{env}`, …). Un module qui s'écarterait de cette
  convention obtiendrait un `AccessDenied` au déploiement, pas une faille — mais
  le message ne le dira pas clairement.
