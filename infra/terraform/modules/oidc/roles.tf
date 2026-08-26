# Un rôle par usage. Les fusionner reviendrait à donner à un `docker push` les
# droits de détruire une base de données, et à une pull request ceux de l'appliquer.

resource "aws_iam_role" "deploy" {
  name                 = "${var.role_prefix}-deploy"
  description          = "Déploiement applicatif depuis GitHub Actions (${var.github_repository})."
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = var.max_session_duration_seconds

  tags = merge(var.tags, {
    Name = "${var.role_prefix}-deploy"
  })
}

resource "aws_iam_role" "terraform" {
  name                 = "${var.role_prefix}-terraform"
  description          = "Application Terraform depuis GitHub Actions (${var.github_repository})."
  assume_role_policy   = data.aws_iam_policy_document.terraform_trust.json
  max_session_duration = var.max_session_duration_seconds

  tags = merge(var.tags, {
    Name = "${var.role_prefix}-terraform"
  })
}

resource "aws_iam_role" "terraform_plan" {
  name                 = "${var.role_prefix}-terraform-plan"
  description          = "Terraform plan en lecture seule depuis une pull request (${var.github_repository})."
  assume_role_policy   = data.aws_iam_policy_document.terraform_plan_trust.json
  max_session_duration = var.max_session_duration_seconds

  tags = merge(var.tags, {
    Name = "${var.role_prefix}-terraform-plan"
  })
}

# --------------------------------------------------------------------------- #
# Déploiement applicatif — droits calqués sur ce que font réellement les
# workflows deploy-*.yml : pousser deux images, jouer la tâche de migration,
# forcer un nouveau déploiement, attendre la stabilité.
# --------------------------------------------------------------------------- #

data "aws_iam_policy_document" "deploy_scoped" {
  statement {
    sid    = "PushContainerImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = local.ecr_repository_arns
  }

  statement {
    sid    = "RollOutServices"
    effect = "Allow"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
    ]
    resources = local.ecs_service_arns
  }
}

resource "aws_iam_role_policy" "deploy_scoped" {
  name   = "${var.role_prefix}-deploy-scoped"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_scoped.json

  # Une politique IAM qui nomme une ressource inexistante s'applique sans broncher
  # et ne se voit qu'au déploiement, sous la forme d'un `AccessDenied` qui accuse
  # les droits plutôt que le nom (#198). La seule occasion de le dire est donc le
  # plan. Le contrôle est posé ici, sur la première ressource qui consomme le nom
  # du cluster — `local.ecs_service_arns` en fait son premier segment — et il
  # suffit à arrêter le plan pour toutes les autres.
  lifecycle {
    precondition {
      condition     = length(local.ecs_environments_without_cluster) == 0
      error_message = "`ecs_cluster_names` ne nomme pas le cluster ECS de : ${join(", ", local.ecs_environments_without_cluster)}. Y reporter la sortie `cluster_name` du module `ecs-service` de chaque environnement de `deployment_environments` — sans elle, la politique du rôle de déploiement désignerait un cluster inexistant."
    }
  }
}

# Les actions regroupées ici ne peuvent pas être restreintes davantage :
#
#   ecr:GetAuthorizationToken   — l'API ne porte sur aucune ressource ; AWS n'accepte
#                                 que `*`. C'est l'appel que fait amazon-ecr-login ;
#   ecs:DescribeTaskDefinition  — même chose, pas de permission au niveau ressource ;
#   ecs:RunTask                 — s'adresse à une révision, d'où `:*` sur la famille
#                                 `spa-<env>-migrate`, et non sur toute définition ;
#   ecs:DescribeTasks           — l'identifiant de tâche est tiré au hasard au
#                                 lancement, il ne peut pas être écrit à l'avance ;
#   iam:PassRole                — les rôles de tâche et d'exécution sont créés par
#                                 d'autres modules ; le préfixe `spa-<env>-` et la
#                                 condition `iam:PassedToService` bornent la portée.
#
# Chacune est en outre conditionnée au cluster de l'environnement quand l'API le
# permet, ce qui vaut mieux qu'un ARN exact sur une ressource éphémère.
#tfsec:ignore:aws-iam-no-policy-wildcards
data "aws_iam_policy_document" "deploy_wildcard" {
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadTaskDefinitions"
    effect    = "Allow"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "RunMigrationTask"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = local.ecs_migrate_task_definition_arns

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = local.ecs_cluster_arns
    }
  }

  statement {
    sid       = "FollowRunningTasks"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks"]
    resources = local.ecs_task_arns

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = local.ecs_cluster_arns
    }
  }

  statement {
    sid       = "PassTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = local.ecs_task_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

#tfsec:ignore:aws-iam-no-policy-wildcards
resource "aws_iam_role_policy" "deploy_wildcard" {
  name   = "${var.role_prefix}-deploy-unscopable"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_wildcard.json
}

# Instantané RDS avant déploiement — production seulement. Les environnements
# dev et staging n'obtiennent pas ce droit : c'est ce qui empêche un workflow
# égaré de créer des instantanés facturés dans un environnement jetable.
#tfsec:ignore:aws-iam-no-policy-wildcards
data "aws_iam_policy_document" "deploy_production_snapshot" {
  count = local.deploys_production ? 1 : 0

  statement {
    sid       = "SnapshotBeforeDeploy"
    effect    = "Allow"
    actions   = ["rds:CreateDBSnapshot"]
    resources = local.rds_snapshot_arns
  }

  # `rds:Describe*` ne supporte pas la permission au niveau ressource.
  statement {
    sid    = "InspectDatabases"
    effect = "Allow"
    actions = [
      "rds:DescribeDBInstances",
      "rds:DescribeDBSnapshots",
    ]
    resources = ["*"]
  }
}

#tfsec:ignore:aws-iam-no-policy-wildcards
resource "aws_iam_role_policy" "deploy_production_snapshot" {
  count = local.deploys_production ? 1 : 0

  name   = "${var.role_prefix}-deploy-production-snapshot"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_production_snapshot[0].json
}

# --------------------------------------------------------------------------- #
# Terraform — apply
# --------------------------------------------------------------------------- #

resource "aws_iam_role_policy_attachment" "terraform" {
  for_each = toset(var.terraform_managed_policy_arns)

  role       = aws_iam_role.terraform.name
  policy_arn = each.value
}

# Garde-fou : le rôle qui applique l'infrastructure ne doit pas pouvoir réécrire
# la porte par laquelle il est entré. Sans ce refus, un `apply` détourné — un
# module tiers compromis, une pull request malveillante appliquée par erreur —
# élargirait sa propre politique de confiance à `*` et s'ouvrirait un accès
# permanent que la rotation des jetons ne rattraperait pas.
#
# Un `Deny` explicite l'emporte sur n'importe quel `Allow`, y compris
# AdministratorAccess. Corollaire : ce module s'applique avec une identité
# d'administrateur, jamais depuis la CI.
data "aws_iam_policy_document" "terraform_guardrail" {
  count = var.protect_oidc_resources ? 1 : 0

  statement {
    sid    = "ProtectGitHubRoles"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DeleteRole",
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    resources = [
      aws_iam_role.deploy.arn,
      aws_iam_role.terraform.arn,
      aws_iam_role.terraform_plan.arn,
    ]
  }

  statement {
    sid    = "ProtectIdentityProvider"
    effect = "Deny"
    actions = [
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
    ]
    resources = [local.oidc_provider_arn]
  }
}

resource "aws_iam_role_policy" "terraform_guardrail" {
  count = var.protect_oidc_resources ? 1 : 0

  name   = "${var.role_prefix}-terraform-guardrail"
  role   = aws_iam_role.terraform.id
  policy = data.aws_iam_policy_document.terraform_guardrail[0].json
}

# --------------------------------------------------------------------------- #
# Terraform — plan (lecture seule + verrou d'état)
# --------------------------------------------------------------------------- #

resource "aws_iam_role_policy_attachment" "terraform_plan" {
  for_each = toset(var.terraform_plan_managed_policy_arns)

  role       = aws_iam_role.terraform_plan.name
  policy_arn = each.value
}

# `terraform plan` pose le même verrou qu'`apply` : sans écriture dans la table
# DynamoDB, il échoue sur « Error acquiring the state lock ». La lecture seule
# s'arrête donc à l'infrastructure, pas au verrou.
data "aws_iam_policy_document" "terraform_plan_state" {
  statement {
    sid    = "ReadRemoteState"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
    ]
    resources = local.state_bucket_arns
  }

  statement {
    sid    = "HoldStateLock"
    effect = "Allow"
    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = local.lock_table_arns
  }
}

resource "aws_iam_role_policy" "terraform_plan_state" {
  name   = "${var.role_prefix}-terraform-plan-state"
  role   = aws_iam_role.terraform_plan.id
  policy = data.aws_iam_policy_document.terraform_plan_state.json
}

# L'état est chiffré par une clé gérée par le client, créée par le module
# `bootstrap` : son ARN n'existe qu'après l'amorçage. `state_kms_key_arns` laissé
# vide retombe sur `*`, doublement borné :
#
#   `kms:ViaService`      — seul ce qui transite par S3 ou DynamoDB, jamais une clé
#                           applicative appelée directement ;
#   `kms:ResourceAliases` — seules les clés portant l'alias `<prefix>-<env>-tfstate`
#                           posé par `bootstrap`.
#
# Sans la seconde, `*` traverserait la frontière que `bootstrap` établit en créant
# une clé par environnement, et rendrait déchiffrable tout objet S3 du compte
# chiffré par une clé gérée par le client — depuis un rôle assumé sur pull request.
# Renseigner les ARN exacts dès l'amorçage terminé supprime le repli.
#tfsec:ignore:aws-iam-no-policy-wildcards
data "aws_iam_policy_document" "terraform_plan_state_kms" {
  statement {
    sid    = "DecryptRemoteState"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
    ]
    resources = local.state_kms_key_arns

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "dynamodb.${local.region}.amazonaws.com",
        "s3.${local.region}.amazonaws.com",
      ]
    }

    dynamic "condition" {
      for_each = local.state_kms_scoped_by_arn ? [] : [1]

      content {
        test     = "ForAnyValue:StringEquals"
        variable = "kms:ResourceAliases"
        values   = local.state_kms_key_aliases
      }
    }
  }
}

#tfsec:ignore:aws-iam-no-policy-wildcards
resource "aws_iam_role_policy" "terraform_plan_state_kms" {
  name   = "${var.role_prefix}-terraform-plan-state-kms"
  role   = aws_iam_role.terraform_plan.id
  policy = data.aws_iam_policy_document.terraform_plan_state_kms.json
}
