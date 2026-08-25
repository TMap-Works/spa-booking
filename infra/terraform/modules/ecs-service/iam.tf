# Deux rôles par service, jamais un seul (skill aws-infra §5) :
#
#   exécution  ce que fait l'agent ECS *avant* que le conteneur ne démarre —
#              tirer l'image, résoudre les secrets, ouvrir le flux de journaux.
#   tâche      ce que fait l'application une fois démarrée.
#
# Les confondre donne au code applicatif le droit de lire tous les secrets du
# service et de tirer n'importe quelle image : exactement ce qu'un attaquant
# ayant obtenu une exécution de code dans le conteneur cherche. Ici le rôle de
# tâche est vide par défaut — une application qui n'appelle aucune API AWS n'a
# besoin d'aucun droit.

data "aws_iam_policy_document" "task_assume" {
  statement {
    sid     = "EcsTasksAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Garde-fou du député confus : sans ces conditions, le service ECS de
    # n'importe quel compte AWS peut demander l'endossement de ce rôle.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# --- Rôle d'exécution ---------------------------------------------------------

resource "aws_iam_role" "execution" {
  for_each = var.services

  name               = "${local.name_prefix}-${each.key}-exec"
  description        = "Rôle d'exécution ECS de ${each.key} — tirage d'image, secrets, journaux."
  assume_role_policy = data.aws_iam_policy_document.task_assume.json

  tags = {
    Name = "${local.name_prefix}-${each.key}-exec"
  }
}

data "aws_iam_policy_document" "execution" {
  for_each = var.services

  # `AmazonECSTaskExecutionRolePolicy`, la politique gérée que tout le monde
  # attache ici, autorise le tirage de *tout* dépôt ECR du compte et l'écriture
  # dans *tout* groupe de journaux. Cette politique-ci cible le dépôt du service
  # et son seul groupe de journaux.

  statement {
    sid     = "EcrAuthorizationToken"
    effect  = "Allow"
    actions = ["ecr:GetAuthorizationToken"]

    # `Resource: "*"` assumé : cette action ne porte sur aucune ressource
    # nommable — elle échange l'identité de l'appelant contre un jeton de
    # registre. La restriction utile est celle de l'action suivante.
    resources = ["*"]
  }

  statement {
    sid    = "EcrPullImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]

    resources = [each.value.ecr_repository_arn]
  }

  statement {
    sid    = "CloudWatchLogsWrite"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # ARN reconstruit plutôt que lu sur la ressource : l'attribut `arn` d'un
    # groupe de journaux porte déjà un suffixe `:*`, et le concaténer une
    # seconde fois produit une politique qui n'autorise rien.
    resources = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${aws_cloudwatch_log_group.service[each.key].name}:*"]
  }

  # Lecture des seuls secrets injectés dans ce service, ni un de plus.
  #
  # La garde compte les clés de `secret_arns`, pas les ARN calculés : les
  # secrets sont presque toujours créés dans le même apply, leurs ARN sont donc
  # inconnus au plan, et `distinct()` rend toute sa liste inconnue dès qu'un
  # seul élément l'est. Un `length()` inconnu ici ferait échouer le `for_each`
  # du bloc dynamique. Le nombre de clés d'une map de variables, lui, est connu.
  dynamic "statement" {
    for_each = length(each.value.secret_arns) > 0 ? [1] : []

    content {
      sid       = "SecretsManagerRead"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns_by_service[each.key]
    }
  }

  # Déchiffrement des secrets et des journaux quand une clé gérée par le client
  # est fournie. Sans clé, KMS n'entre pas dans le chemin d'appel.
  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]

    content {
      sid       = "KmsDecrypt"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = var.services

  name   = "${local.name_prefix}-${each.key}-exec"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}

# --- Rôle de tâche ------------------------------------------------------------

resource "aws_iam_role" "task" {
  for_each = var.services

  name               = "${local.name_prefix}-${each.key}-task"
  description        = "Rôle applicatif de ${each.key} — ce que le conteneur peut appeler une fois démarré."
  assume_role_policy = data.aws_iam_policy_document.task_assume.json

  tags = {
    Name = "${local.name_prefix}-${each.key}-task"
  }
}

# Aucune politique en ligne : les droits applicatifs sont apportés par
# l'environnement, sous forme de politiques gérées qu'il a lui-même écrites. Ce
# qui n'est pas demandé n'est pas accordé.
#
# La clé est « {service}:{rang} » et non « {service}:{arn} ». C'est ce qui rend
# le module utilisable dans son cas d'usage normal : l'environnement passe une
# politique qu'il crée lui-même — `[aws_iam_policy.api.arn]` — dont l'ARN est
# inconnu au plan. Une clé de `for_each` construite dessus arrête Terraform sur
# « the for_each map includes keys derived from resource attributes that cannot
# be determined until apply », avant même d'avoir planifié quoi que ce soit. Le
# rang, lui, est connu ; le prix est qu'insérer une politique en tête de liste
# redétache et rattache les suivantes, ce qui ne coupe rien.
resource "aws_iam_role_policy_attachment" "task" {
  for_each = merge([
    for name, service in var.services : {
      for index, policy_arn in service.task_role_policy_arns :
      "${name}:${index}" => {
        service    = name
        policy_arn = policy_arn
      }
    }
  ]...)

  role       = aws_iam_role.task[each.value.service].name
  policy_arn = each.value.policy_arn
}
