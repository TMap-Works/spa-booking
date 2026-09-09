# Chaîne de traitement des rebonds et des plaintes — #73, CDC §6.
#
# ```
# SES ──► aws_sns_topic.events ──► cette file ──► cette Lambda ──► POST …/notifications/delivery-events
#  (Bounce, Complaint,             (+ sa DLQ)
#   Reject, Rendering Failure)
# ```
#
# `events-topic.tf` a posé le topic en annonçant précisément ceci : « le
# traitement applicatif (#73) s'y abonnera par une file SQS ». C'est ce que ce
# fichier fait, et rien de plus — le jeu de configuration n'est pas touché,
# l'identité SES non plus.
#
# ## Pourquoi une file entre le topic et la fonction
#
# Un abonnement Lambda **direct** sur SNS existe et serait plus court à écrire.
# Il n'a ni file d'attente morte utilisable, ni compteur de réception, ni
# rétention : un échec de l'API pendant un déploiement ferait perdre les rebonds
# de la fenêtre, définitivement et sans trace. La file donne les trois d'un coup,
# et c'est la conduite qu'a déjà `dispatch-queue.tf` pour la même raison.
#
# ## Remise brute, et ce qu'elle change
#
# `raw_message_delivery = true` : la fonction reçoit le JSON de SES tel quel,
# sans l'enveloppe SNS. Sans elle, il faudrait extraire `Message` — une chaîne
# JSON dans un objet JSON — et le désérialiser une seconde fois, à un endroit de
# plus où se tromper. C'est aussi ce que le contrat de `delivery-event.ts`
# suppose : « le corps est alors exactement le JSON de SES ».

# --- File d'attente morte -----------------------------------------------------

# Déclarée avant la file principale : c'est elle qui est référencée par la
# politique de redrive, pas l'inverse. Rétention au maximum, pour la raison
# qu'expose `dispatch-queue.tf` — un message n'arrive ici qu'après avoir épuisé
# ses tentatives, il est la preuve d'une panne, et cette preuve doit survivre au
# week-end.
resource "aws_sqs_queue" "delivery_events_dlq" {
  name                       = "${local.name_prefix}-ses-events-dlq"
  message_retention_seconds  = var.dlq_message_retention_seconds
  visibility_timeout_seconds = local.delivery_events_visibility_timeout_seconds

  # Même clé que le topic, et ici ce n'est pas une économie : le message **est**
  # celui du topic, il porte l'adresse du destinataire, et `events-topic.tf` a
  # justifié la dépense d'une clé gérée par le client précisément pour cela
  # (CDC §5.1).
  kms_master_key_id                 = local.kms_key_arn
  kms_data_key_reuse_period_seconds = var.kms_data_key_reuse_period_seconds

  tags = {
    Name = "${local.name_prefix}-ses-events-dlq"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "delivery_events_dlq" {
  queue_url = aws_sqs_queue.delivery_events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.delivery_events.arn]
  })
}

# --- File principale ----------------------------------------------------------

resource "aws_sqs_queue" "delivery_events" {
  name = "${local.name_prefix}-ses-events"

  visibility_timeout_seconds = local.delivery_events_visibility_timeout_seconds
  message_retention_seconds  = var.dispatch_message_retention_seconds

  # Interrogation longue, comme la file d'envoi : un événement de remise est
  # rare hors incident, et vingt secondes d'attente divisent par vingt le nombre
  # de requêtes facturées sur une file au repos.
  receive_wait_time_seconds = 20

  kms_master_key_id                 = local.kms_key_arn
  kms_data_key_reuse_period_seconds = var.kms_data_key_reuse_period_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.delivery_events_dlq.arn
    maxReceiveCount     = var.dispatch_max_receive_count
  })

  tags = {
    Name = "${local.name_prefix}-ses-events"
  }
}

# --- Droit de publier, et transport chiffré exigé -----------------------------

# Deux énoncés dans une seule politique de file, parce qu'une file n'en accepte
# qu'une : celui qui laisse SNS déposer, et celui qui refuse tout appel en clair.
#
# Le caractère générique sur l'action du `Deny` est la forme **correcte** pour
# une garde de transport : elle doit couvrir toute action présente et à venir.
# Le restreindre à une liste laisserait passer en clair celles qu'on aurait
# oublié d'y écrire — l'inverse exact du risque couvert.
data "aws_iam_policy_document" "delivery_events_queue" {
  statement {
    sid    = "AllowEventsTopicToEnqueue"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.delivery_events.arn]

    # Le topic **nommé**, et lui seul. Sans cette condition, n'importe quel topic
    # du compte — ou d'un autre — pourrait déposer dans cette file, et la Lambda
    # traiterait comme un rebond SES ce qu'un tout autre service y aurait écrit.
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["sqs:*"]

    resources = [
      aws_sqs_queue.delivery_events.arn,
      aws_sqs_queue.delivery_events_dlq.arn,
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "delivery_events" {
  queue_url = aws_sqs_queue.delivery_events.id
  policy    = data.aws_iam_policy_document.delivery_events_queue.json
}

# La DLQ n'a pas de producteur légitime autre que le service de redrive : sa
# politique se réduit donc à la garde de transport, réécrite ici parce qu'une
# politique de file porte sur les ressources qu'elle nomme.
data "aws_iam_policy_document" "delivery_events_dlq_tls" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.delivery_events_dlq.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "delivery_events_dlq" {
  queue_url = aws_sqs_queue.delivery_events_dlq.id
  policy    = data.aws_iam_policy_document.delivery_events_dlq_tls.json
}

# --- Abonnement ---------------------------------------------------------------

resource "aws_sns_topic_subscription" "delivery_events" {
  topic_arn = aws_sns_topic.events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.delivery_events.arn

  # Voir l'en-tête : la fonction reçoit le JSON de SES sans l'enveloppe SNS,
  # ce qui est le contrat que `delivery-event.ts` suppose.
  raw_message_delivery = true

  # SNS vérifie, à la création de l'abonnement, qu'il peut réellement déposer
  # dans la file. Sans cette arête, Terraform peut créer l'abonnement avant la
  # politique et l'`apply` échoue sur un refus qui disparaît au second passage —
  # le pire des échecs, celui qui se répare tout seul et qu'on ne comprend
  # jamais.
  depends_on = [aws_sqs_queue_policy.delivery_events]
}

# --- Empaquetage de la fonction -----------------------------------------------

data "archive_file" "delivery_events" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/delivery-events"
  output_path = "${path.root}/.terraform/${local.name_prefix}-delivery-events.zip"
}

# --- Journaux -----------------------------------------------------------------

# Créé explicitement plutôt que laissé à Lambda : le groupe que Lambda crée de
# lui-même n'a aucune rétention, et la facture CloudWatch grossit sans que rien
# ne le dise (aws-infra §8).
#
# Sans clé gérée par le client, comme celui de la Lambda d'envoi et pour la même
# raison : CloudWatch Logs exige que la politique de la clé nomme
# `logs.{région}.amazonaws.com`, ce que celle des événements ne fait pas. Le
# contenu journalisé est de toute façon fait de compteurs et de l'accusé opaque
# de SES — **jamais une adresse**, ce que la fonction garantit de son côté.
resource "aws_cloudwatch_log_group" "delivery_events" {
  name              = "/aws/lambda/${local.delivery_events_function_name}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "/aws/lambda/${local.delivery_events_function_name}"
  }
}

# --- Rôle d'exécution ---------------------------------------------------------

resource "aws_iam_role" "delivery_events" {
  name               = local.delivery_events_function_name
  description        = "Rôle de la Lambda de traitement des rebonds SES ${var.environment}."
  assume_role_policy = data.aws_iam_policy_document.dispatcher_assume.json

  tags = {
    Name = local.delivery_events_function_name
  }
}

# Au moindre privilège, ARN par ARN (aws-infra §5). Rien de géré par AWS ici :
# `AWSLambdaSQSQueueExecutionRole` autoriserait la consommation de *toute* file
# du compte.
data "aws_iam_policy_document" "delivery_events" {
  statement {
    sid    = "ConsumeDeliveryEventsQueue"
    effect = "Allow"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]

    resources = [aws_sqs_queue.delivery_events.arn]
  }

  # Sans `kms:Decrypt`, la fonction reçoit des messages qu'elle ne sait pas lire —
  # panne silencieuse, et la plus longue à diagnostiquer de cette chaîne.
  statement {
    sid       = "DecryptDeliveryEventsQueue"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [local.kms_key_arn]
  }

  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # ARN reconstruit plutôt que lu sur la ressource : l'attribut `arn` d'un
    # groupe porte déjà un suffixe `:*`, et le concaténer deux fois produit une
    # politique qui n'autorise rien.
    resources = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${aws_cloudwatch_log_group.delivery_events.name}:*"]
  }

  # Le jeton d'appel de l'API, quand il y en a un — le **même** que celui du
  # balayage et de l'envoi : une seule frontière de confiance, un seul secret à
  # faire tourner. Un ARN nommé, jamais `*`.
  dynamic "statement" {
    for_each = var.dispatch_token_secret_arn == null ? [] : [var.dispatch_token_secret_arn]

    content {
      sid       = "ReadInternalToken"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "delivery_events" {
  name   = local.delivery_events_function_name
  role   = aws_iam_role.delivery_events.id
  policy = data.aws_iam_policy_document.delivery_events.json
}

# --- Fonction -----------------------------------------------------------------

resource "aws_lambda_function" "delivery_events" {
  function_name = local.delivery_events_function_name
  description   = "Consomme ${aws_sqs_queue.delivery_events.name} et fait traiter les rebonds et plaintes par l'API."
  role          = aws_iam_role.delivery_events.arn

  # Runtime figé, et non pris en variable : le code utilise `fetch` natif et le
  # SDK v3 fourni par le runtime. Même version que la Lambda d'envoi, et pour la
  # même raison qu'elle documente : `nodejs20.x` est déprécié depuis le
  # 30 avril 2026 (#577).
  runtime = "nodejs22.x"
  handler = "index.handler"

  # Graviton : environ 20 % moins cher à durée égale, et cette fonction ne dépend
  # d'aucun binaire natif (aws-infra §9).
  architectures = ["arm64"]

  filename         = data.archive_file.delivery_events.output_path
  source_code_hash = data.archive_file.delivery_events.output_base64sha256

  timeout     = var.delivery_events_timeout_seconds
  memory_size = var.delivery_events_memory_mb

  # Hors VPC, comme la Lambda d'envoi : elle n'appelle que l'API par son URL
  # publique et CloudWatch.

  environment {
    variables = {
      ENVIRONMENT                = var.environment
      DELIVERY_EVENTS_URL        = var.delivery_events_url == null ? "" : var.delivery_events_url
      DISPATCH_TOKEN_SECRET_ARN  = var.dispatch_token_secret_arn == null ? "" : var.dispatch_token_secret_arn
      DELIVERY_EVENTS_TIMEOUT_MS = tostring(var.dispatch_timeout_ms)
      METRIC_NAMESPACE           = var.metric_namespace
    }
  }

  # Le lot entier doit tenir dans le temps imparti, sinon la fonction est tuée en
  # vol : les enregistrements non traités reviennent après le délai de visibilité,
  # sans trace de ce qui s'est passé. Cette précondition arrête au plan un
  # réglage qui la rendrait inatteignable, plutôt qu'en production.
  lifecycle {
    precondition {
      condition     = var.delivery_events_batch_size * var.dispatch_timeout_ms <= (var.delivery_events_timeout_seconds - 2) * 1000
      error_message = "delivery_events_batch_size × dispatch_timeout_ms doit tenir dans delivery_events_timeout_seconds moins deux secondes de marge : un lot qui ne tient pas fait tuer la fonction en cours d'appel."
    }
  }

  # Sans cette arête, Terraform peut créer la fonction avant son groupe de
  # journaux ; Lambda le crée alors lui-même, sans rétention, et la ressource
  # suivante échoue sur un groupe déjà existant.
  depends_on = [aws_cloudwatch_log_group.delivery_events]

  tags = {
    Name = local.delivery_events_function_name
  }
}

# --- Source d'événements ------------------------------------------------------

resource "aws_lambda_event_source_mapping" "delivery_events" {
  event_source_arn = aws_sqs_queue.delivery_events.arn
  function_name    = aws_lambda_function.delivery_events.arn
  batch_size       = var.delivery_events_batch_size
  enabled          = true

  # Sans lui, une seule erreur dans un lot fait rejouer le lot entier : des
  # rebonds déjà traités repartent chez l'API — qui les reconnaît, l'écriture
  # étant idempotente — mais au prix d'un compteur de réception qui avance pour
  # des messages sains. Ils finiraient en DLQ sans avoir jamais échoué.
  function_response_types = ["ReportBatchItemFailures"]

  # Borne la concurrence, comme pour la file d'envoi : c'est la seule protection
  # de l'API en aval. Un incident de délivrabilité produit des rebonds par
  # milliers, et cette file deviendrait sinon un amplificateur au moment précis
  # où l'API a le plus besoin d'air.
  scaling_config {
    maximum_concurrency = var.delivery_events_maximum_concurrency
  }

  # Lambda vérifie, à la création de la source, qu'il peut réellement lire la
  # file avec ce rôle. Sans cette arête, l'`apply` échoue sur un « Cannot access
  # the SQS queue » qui disparaît au second passage.
  depends_on = [aws_iam_role_policy.delivery_events]
}
