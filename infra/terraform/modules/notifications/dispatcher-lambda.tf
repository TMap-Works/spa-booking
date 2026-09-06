# Lambda d'envoi — le consommateur de la file de découplage.
#
# Le code vit dans `lambda/dispatcher/`, en clair et sans dépendance à
# installer : le SDK AWS v3 est fourni par le runtime `nodejs20.x`, et `fetch`
# est natif depuis Node 18. C'est ce qui permet d'empaqueter la fonction avec un
# simple `archive_file`, sans étape de construction en CI — donc sans qu'un
# `terraform apply` dépende d'un artefact produit ailleurs.

# --- Empaquetage --------------------------------------------------------------

# Écrit sous `.terraform/` de la racine appelante, répertoire déjà ignoré par
# Git : une archive régénérée à chaque plan n'a rien à faire dans le dépôt, et
# son horodatage ferait apparaître un diff à chaque exécution.
data "archive_file" "dispatcher" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/dispatcher"
  output_path = "${path.root}/.terraform/${local.name_prefix}-notification-dispatcher.zip"
}

# --- Journaux -----------------------------------------------------------------

# Créé explicitement plutôt que laissé à Lambda. Le groupe que Lambda crée de
# lui-même n'a **aucune rétention** : les journaux s'y accumulent indéfiniment,
# et la facture CloudWatch grossit sans que rien ne le dise (skill aws-infra §8).
# Le nom est imposé — c'est celui que le service utilise.
#
# Sans clé gérée par le client, comme les groupes de journaux du module `cache` et
# pour la même raison : CloudWatch Logs exige que la politique de la clé nomme
# `logs.{région}.amazonaws.com`, ce que la politique de la clé d'événements ne
# fait pas — et ne peut pas faire quand l'environnement fournit sa propre clé. Le
# contenu journalisé est de toute façon fait d'identifiants : ni adresse, ni nom,
# ni contenu de message (CDC §5.1).
resource "aws_cloudwatch_log_group" "dispatcher" {
  name              = "/aws/lambda/${local.dispatcher_function_name}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "/aws/lambda/${local.dispatcher_function_name}"
  }
}

# --- Rôle d'exécution ---------------------------------------------------------

data "aws_iam_policy_document" "dispatcher_assume" {
  statement {
    sid     = "LambdaAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dispatcher" {
  name               = "${local.name_prefix}-notification-dispatcher"
  description        = "Rôle de la Lambda d'envoi des notifications ${var.environment}."
  assume_role_policy = data.aws_iam_policy_document.dispatcher_assume.json

  tags = {
    Name = "${local.name_prefix}-notification-dispatcher"
  }
}

# Au moindre privilège, ARN par ARN (skill aws-infra §5). Rien de gérée par AWS
# ici : `AWSLambdaBasicExecutionRole` autoriserait l'écriture dans *tout* groupe
# de journaux du compte, et `AWSLambdaSQSQueueExecutionRole` la consommation de
# *toute* file.
data "aws_iam_policy_document" "dispatcher" {
  # Le poller de la source d'événements consomme sous l'identité de ce rôle.
  # `ChangeMessageVisibility` n'est pas décoratif : c'est par lui que Lambda rend
  # immédiatement les enregistrements d'un `batchItemFailures` au lieu d'attendre
  # la fin du délai de visibilité.
  statement {
    sid    = "ConsumeDispatchQueue"
    effect = "Allow"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]

    resources = [aws_sqs_queue.dispatch.arn]
  }

  # Sans `kms:Decrypt`, la fonction reçoit des messages qu'elle ne sait pas lire —
  # panne silencieuse, et la plus longue à diagnostiquer de cette chaîne.
  statement {
    sid       = "DecryptDispatchQueue"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [local.kms_key_arn]
  }

  # Le seul groupe de journaux de cette fonction. Pas de `logs:CreateLogGroup` :
  # il existe déjà, et l'accorder laisserait la fonction en créer d'autres, sans
  # rétention.
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # ARN reconstruit plutôt que lu sur la ressource, pour la raison qu'explique
    # le module `ecs-service` : l'attribut `arn` d'un groupe porte déjà un
    # suffixe `:*`, et le concaténer deux fois produit une politique qui
    # n'autorise rien.
    resources = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${aws_cloudwatch_log_group.dispatcher.name}:*"]
  }

  # Le jeton d'appel de l'API, quand il y en a un. Un seul secret nommé, jamais
  # `*` : c'est la différence entre une fonction qui lit son jeton et une
  # fonction qui lit tous les secrets de l'environnement, dont les identifiants
  # de la base.
  dynamic "statement" {
    for_each = var.dispatch_token_secret_arn == null ? [] : [var.dispatch_token_secret_arn]

    content {
      sid       = "ReadDispatchToken"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "dispatcher" {
  name   = "${local.name_prefix}-notification-dispatcher"
  role   = aws_iam_role.dispatcher.id
  policy = data.aws_iam_policy_document.dispatcher.json
}

# --- Fonction -----------------------------------------------------------------

# Sans traçage X-Ray, délibérément. Un trace n'a d'intérêt qu'à relier plusieurs
# maillons d'un même appel — or l'API, qui est le maillon suivant, n'en émet pas.
# Un traçage qui s'arrête à la frontière de la fonction ne dirait rien que les
# journaux structurés et les métriques EMF ne disent déjà, pour un coût par
# invocation et un droit IAM de plus. À reprendre le jour où l'API tracera aussi.
resource "aws_lambda_function" "dispatcher" {
  function_name = local.dispatcher_function_name
  description   = "Consomme ${aws_sqs_queue.dispatch.name} et fait envoyer les notifications par l'API."
  role          = aws_iam_role.dispatcher.arn

  # Runtime figé, et non pris en variable : le code utilise `fetch` natif et le
  # SDK v3 fourni par le runtime. Le faire varier depuis un environnement ferait
  # tourner le même fichier sur un socle qui ne porte ni l'un ni l'autre.
  runtime = "nodejs20.x"
  handler = "index.handler"

  # Graviton : environ 20 % moins cher à durée égale, et cette fonction ne
  # dépend d'aucun binaire natif (skill aws-infra §9).
  architectures = ["arm64"]

  filename         = data.archive_file.dispatcher.output_path
  source_code_hash = data.archive_file.dispatcher.output_base64sha256

  timeout     = var.dispatcher_timeout_seconds
  memory_size = var.dispatcher_memory_mb

  # Hors VPC, délibérément. La fonction n'appelle que l'API par son URL publique
  # et CloudWatch : la placer dans les sous-réseaux applicatifs lui imposerait
  # des interfaces réseau, une sortie par la NAT Gateway — facturée au
  # gigaoctet — ou des endpoints supplémentaires, pour aucun accès qu'elle n'ait
  # déjà. Le jour où elle devra joindre RDS directement, la question se reposera
  # avec sa réponse.

  environment {
    variables = {
      ENVIRONMENT               = var.environment
      DISPATCH_URL              = var.dispatch_url == null ? "" : var.dispatch_url
      DISPATCH_TOKEN_SECRET_ARN = var.dispatch_token_secret_arn == null ? "" : var.dispatch_token_secret_arn
      DISPATCH_TIMEOUT_MS       = tostring(var.dispatch_timeout_ms)
      METRIC_NAMESPACE          = var.metric_namespace
    }
  }

  # Le lot entier doit tenir dans le temps imparti, sinon la fonction est tuée en
  # vol : les enregistrements non traités reviennent après le délai de
  # visibilité, sans trace de ce qui s'est passé. Le code garde une marge de son
  # côté ; cette précondition arrête un réglage qui la rendrait inatteignable dès
  # le plan, plutôt qu'en production.
  lifecycle {
    precondition {
      condition     = var.dispatcher_batch_size * var.dispatch_timeout_ms <= (var.dispatcher_timeout_seconds - 2) * 1000
      error_message = "dispatcher_batch_size × dispatch_timeout_ms doit tenir dans dispatcher_timeout_seconds moins deux secondes de marge : un lot qui ne tient pas fait tuer la fonction en cours d'appel."
    }
  }

  # Sans cette arête, Terraform peut créer la fonction avant son groupe de
  # journaux ; Lambda le crée alors lui-même, sans rétention, et la ressource
  # suivante échoue sur un groupe déjà existant.
  depends_on = [aws_cloudwatch_log_group.dispatcher]

  tags = {
    Name = local.dispatcher_function_name
  }
}

# --- Source d'événements ------------------------------------------------------

resource "aws_lambda_event_source_mapping" "dispatch" {
  event_source_arn = aws_sqs_queue.dispatch.arn
  function_name    = aws_lambda_function.dispatcher.arn
  batch_size       = var.dispatcher_batch_size
  enabled          = true

  # Le réglage qui porte les deux critères de reprise de #67.
  #
  # Sans lui, une seule erreur dans un lot de cinq fait rejouer les cinq : quatre
  # messages déjà envoyés repartent chez l'API, qui les reconnaît grâce à
  # l'idempotence de #68 — mais au prix de quatre appels inutiles, et surtout
  # d'un compteur de réception qui avance pour des messages sains. Ils
  # finiraient en DLQ sans avoir jamais échoué.
  #
  # Avec lui, la fonction rend la liste des seuls enregistrements à rejouer ;
  # tous les autres — y compris les échecs **permanents**, qu'aucune reprise ne
  # sauverait — sont supprimés de la file.
  function_response_types = ["ReportBatchItemFailures"]

  # Borne le nombre d'invocations simultanées de cette source. C'est la seule
  # protection de l'API en aval : sans elle, Lambda monte jusqu'à la concurrence
  # du compte entier sur un pic de réservations, et la file de découplage
  # deviendrait un amplificateur au lieu d'un amortisseur.
  scaling_config {
    maximum_concurrency = var.dispatcher_maximum_concurrency
  }

  # Lambda vérifie, à la création de la source, qu'il peut réellement lire la
  # file avec ce rôle. Sans cette arête, Terraform peut créer la source avant la
  # politique en ligne et l'`apply` échoue sur un « Cannot access the SQS queue »
  # qui disparaît au second passage — le pire des échecs, celui qui se répare
  # tout seul et qu'on ne comprend jamais.
  depends_on = [aws_iam_role_policy.dispatcher]
}
