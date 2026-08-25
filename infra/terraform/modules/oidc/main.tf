# Fournisseur d'identité OIDC GitHub Actions et rôles assumables par les workflows.
#
# L'alternative à ce module est une paire `AWS_ACCESS_KEY_ID` /
# `AWS_SECRET_ACCESS_KEY` dans les secrets du dépôt : un identifiant permanent,
# copiable, qui ne laisse aucune trace lorsqu'il fuite et qu'aucune rotation ne
# rattrape vraiment. Ici, GitHub signe un jeton valable quelques minutes, AWS le
# vérifie auprès de l'émetteur et n'accorde une session que si le sujet du jeton
# figure dans la politique de confiance. Il n'y a rien à stocker, donc rien à
# perdre.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  oidc_provider_arn = (
    var.existing_oidc_provider_arn != null
    ? var.existing_oidc_provider_arn
    : aws_iam_openid_connect_provider.github[0].arn
  )

  # Sujets (`sub`) que GitHub inscrit dans le jeton, selon le déclencheur du job.
  # Un job qui déclare `environment: X` porte `environment:X` ; sans environnement,
  # il porte `ref:refs/heads/<branche>` sur un push et `pull_request` sur une PR.
  # Les trois formes sont donc distinctes, et chaque rôle n'accepte que celles dont
  # ses workflows ont besoin.
  environment_subjects = [
    for env in var.deployment_environments :
    "repo:${var.github_repository}:environment:${env}"
  ]

  branch_subjects = [
    for branch in var.deployment_branches :
    "repo:${var.github_repository}:ref:refs/heads/${branch}"
  ]

  pull_request_subject = "repo:${var.github_repository}:pull_request"

  deploy_subjects          = concat(local.environment_subjects, local.branch_subjects)
  terraform_apply_subjects = local.environment_subjects
  terraform_plan_subjects  = [local.pull_request_subject]

  # ARN exacts des ressources que les workflows `deploy-*` manipulent. Les
  # construire ici est ce qui permet au rôle de déploiement de se passer de
  # `Resource: "*"` sur l'essentiel de sa politique.
  ecr_repository_arns = sort(flatten([
    for env in var.deployment_environments : [
      for service in var.container_services :
      "arn:${local.partition}:ecr:${local.region}:${local.account_id}:repository/spa-${env}-${service}"
    ]
  ]))

  ecs_cluster_arns = sort([
    for env in var.deployment_environments :
    "arn:${local.partition}:ecs:${local.region}:${local.account_id}:cluster/spa-${env}"
  ])

  ecs_service_arns = sort(flatten([
    for env in var.deployment_environments : [
      for service in var.container_services :
      "arn:${local.partition}:ecs:${local.region}:${local.account_id}:service/spa-${env}/spa-${env}-${service}"
    ]
  ]))

  # Les définitions de tâche s'adressent par révision : le suffixe `:*` désigne
  # « toute révision de cette famille », pas « toute définition de tâche ».
  ecs_migrate_task_definition_arns = sort([
    for env in var.deployment_environments :
    "arn:${local.partition}:ecs:${local.region}:${local.account_id}:task-definition/spa-${env}-migrate:*"
  ])

  ecs_task_arns = sort([
    for env in var.deployment_environments :
    "arn:${local.partition}:ecs:${local.region}:${local.account_id}:task/spa-${env}/*"
  ])

  ecs_task_role_arns = sort([
    for env in var.deployment_environments :
    "arn:${local.partition}:iam::${local.account_id}:role/spa-${env}-*"
  ])

  deploys_production = contains(tolist(var.deployment_environments), var.production_environment)

  rds_snapshot_arns = local.deploys_production ? [
    "arn:${local.partition}:rds:${local.region}:${local.account_id}:db:spa-${var.production_environment}-rds",
    "arn:${local.partition}:rds:${local.region}:${local.account_id}:snapshot:spa-${var.production_environment}-predeploy-*",
  ] : []

  state_bucket_arns = sort(flatten([
    for env in var.deployment_environments : [
      "arn:${local.partition}:s3:::${var.state_bucket_prefix}-${env}-tfstate",
      "arn:${local.partition}:s3:::${var.state_bucket_prefix}-${env}-tfstate/*",
    ]
  ]))

  lock_table_arns = sort([
    for env in var.deployment_environments :
    "arn:${local.partition}:dynamodb:${local.region}:${local.account_id}:table/${var.lock_table_prefix}-${env}-tflock"
  ])

  # `bootstrap` crée une clé par environnement pour que le rôle qui déchiffre l'état
  # de dev ne puisse rien lire de celui de production, et laisse la politique de clé
  # par défaut — c'est donc à la politique IAM de tenir cette frontière. Un
  # `kms:Decrypt` sur `*`, même borné par `kms:ViaService`, les traverse toutes et
  # rend en prime déchiffrable tout objet S3 chiffré par une clé du compte.
  #
  # Tant que les ARN exacts ne sont pas connus (ils n'existent qu'après l'amorçage),
  # le repli reste `*` mais se restreint aux clés portant l'alias posé par
  # `bootstrap` — `kms:ResourceAliases` compare l'alias de la clé effectivement
  # utilisée, ce qui donne la même frontière sans avoir à écrire d'ARN.
  state_kms_scoped_by_arn = length(var.state_kms_key_arns) > 0

  state_kms_key_arns = local.state_kms_scoped_by_arn ? var.state_kms_key_arns : ["*"]

  state_kms_key_aliases = sort([
    for env in var.deployment_environments :
    "alias/${var.state_kms_alias_prefix}-${env}-tfstate"
  ])
}

# Un seul fournisseur par URL d'émetteur et par compte : `existing_oidc_provider_arn`
# permet de se raccorder à celui qu'un autre projet aurait déjà créé.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.existing_oidc_provider_arn == null ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.oidc_thumbprints

  tags = merge(var.tags, {
    Name = "${var.role_prefix}-oidc"
  })
}
