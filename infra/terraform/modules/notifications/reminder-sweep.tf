# Rappel J-1 — le déclencheur horaire et son producteur (#71).
#
# ```
# EventBridge Scheduler ──► Lambda de balayage ──► API ──► enveloppes
#   cron(0 * * * ? *) UTC          │                          │
#                                  └──► SendMessageBatch ─────┘
#                                            │
#                                            ▼
#                                  file de notifications (#67)
# ```
#
# Le CDC §4.8 et la skill notifications §1 décrivent exactement cette chaîne :
# « une règle EventBridge s'exécute toutes les heures, sélectionne les rendez-vous
# qui commencent dans 24 à 25 h et dont le rappel n'est pas encore envoyé, et
# publie un message SQS par rendez-vous ».
#
# ## Pourquoi une fonction entre le planificateur et la file
#
# EventBridge Scheduler sait appeler une API AWS ; il ne sait pas interroger une
# base. Or la sélection a besoin du schéma, du client Prisma scopé et de la
# définition de « rendez-vous vivant » — tout cela vit dans l'API, et le
# réécrire en JavaScript donnerait deux implémentations de la même règle. La
# fonction est donc le **transport** : elle demande, elle publie. C'est la même
# division du travail que pour la Lambda d'envoi de #67.
#
# ## Pourquoi le rôle du planificateur n'invoque que la fonction
#
# `dispatch-queue.tf` prévoyait que « le même ARN servira au rôle qu'EventBridge
# Scheduler endossera pour le rappel J-1 ». C'est bien la politique de production
# `dispatch_producer` qui est attachée ici — mais au rôle de la **fonction**, qui
# est ce qui publie réellement. Le rôle du planificateur, lui, ne peut qu'appeler
# la fonction : lui donner `SendMessage` serait lui donner un droit dont il ne se
# sert pas.

# --- Empaquetage --------------------------------------------------------------

data "archive_file" "reminder_sweeper" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/reminder-sweeper"
  output_path = "${path.root}/.terraform/${local.name_prefix}-reminder-sweeper.zip"
}

# --- Journaux -----------------------------------------------------------------

# Créé explicitement, comme celui de la Lambda d'envoi : le groupe que Lambda
# crée de lui-même n'a **aucune rétention**, et la facture CloudWatch grossit
# sans que rien ne le dise (skill aws-infra §8).
resource "aws_cloudwatch_log_group" "reminder_sweeper" {
  name              = "/aws/lambda/${local.reminder_sweeper_function_name}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "/aws/lambda/${local.reminder_sweeper_function_name}"
  }
}

# --- Rôle d'exécution de la fonction ------------------------------------------

resource "aws_iam_role" "reminder_sweeper" {
  name               = local.reminder_sweeper_function_name
  description        = "Rôle de la Lambda de balayage des rappels J-1 ${var.environment}."
  assume_role_policy = data.aws_iam_policy_document.dispatcher_assume.json

  tags = {
    Name = local.reminder_sweeper_function_name
  }
}

# Le droit de **publier**, et rien d'autre — la politique gérée que
# `dispatch-queue.tf` crée pour tous les producteurs de la file. Elle accorde
# `SendMessage` et le chiffrement, jamais `ReceiveMessage` : un producteur qui
# pourrait dépiler pourrait faire disparaître un rappel.
resource "aws_iam_role_policy_attachment" "reminder_sweeper_producer" {
  role       = aws_iam_role.reminder_sweeper.name
  policy_arn = aws_iam_policy.dispatch_producer.arn
}

data "aws_iam_policy_document" "reminder_sweeper" {
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

    # ARN reconstruit plutôt que lu sur la ressource : l'attribut `arn` d'un
    # groupe porte déjà un suffixe `:*`, et le concaténer deux fois produit une
    # politique qui n'autorise rien.
    resources = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${aws_cloudwatch_log_group.reminder_sweeper.name}:*"]
  }

  # Le même jeton que la Lambda d'envoi présente à la même API : un seul secret
  # pour une seule frontière de confiance. En créer un second aurait voulu dire
  # deux rotations à tenir d'accord, pour la même porte.
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

resource "aws_iam_role_policy" "reminder_sweeper" {
  name   = local.reminder_sweeper_function_name
  role   = aws_iam_role.reminder_sweeper.id
  policy = data.aws_iam_policy_document.reminder_sweeper.json
}

# --- Fonction -----------------------------------------------------------------

resource "aws_lambda_function" "reminder_sweeper" {
  function_name = local.reminder_sweeper_function_name
  description   = "Sélectionne les rappels J-1 auprès de l'API et les publie sur ${aws_sqs_queue.dispatch.name}."
  role          = aws_iam_role.reminder_sweeper.arn

  # Runtime figé et non pris en variable, pour la raison qui vaut chez la Lambda
  # d'envoi : le code utilise `fetch` natif et le SDK v3 fourni par le runtime.
  # Même version qu'elle, et pour la même raison qu'elle documente : `nodejs20.x`
  # est déprécié depuis le 30 avril 2026 (#577).
  runtime = "nodejs22.x"
  handler = "index.handler"

  # Graviton : environ 20 % moins cher à durée égale, et cette fonction ne dépend
  # d'aucun binaire natif (skill aws-infra §9).
  architectures = ["arm64"]

  filename         = data.archive_file.reminder_sweeper.output_path
  source_code_hash = data.archive_file.reminder_sweeper.output_base64sha256

  timeout     = var.reminder_sweeper_timeout_seconds
  memory_size = var.reminder_sweeper_memory_mb

  # Hors VPC, comme la Lambda d'envoi : elle n'appelle que l'API par son URL
  # publique, SQS et CloudWatch.

  environment {
    variables = {
      ENVIRONMENT            = var.environment
      SWEEP_URL              = var.reminder_sweep_url == null ? "" : var.reminder_sweep_url
      QUEUE_URL              = aws_sqs_queue.dispatch.url
      SWEEP_TOKEN_SECRET_ARN = var.dispatch_token_secret_arn == null ? "" : var.dispatch_token_secret_arn
      SWEEP_TIMEOUT_MS       = tostring(var.reminder_sweep_timeout_ms)
      METRIC_NAMESPACE       = var.metric_namespace
    }
  }

  # L'appel à l'API doit tenir dans le temps imparti, publication comprise. La
  # précondition arrête un réglage inatteignable dès le plan, plutôt qu'en
  # production — où la fonction serait tuée en plein appel et où le balayage de
  # l'heure serait perdu sans laisser de trace exploitable.
  lifecycle {
    precondition {
      condition     = var.reminder_sweep_timeout_ms <= (var.reminder_sweeper_timeout_seconds - 5) * 1000
      error_message = "reminder_sweep_timeout_ms doit tenir dans reminder_sweeper_timeout_seconds moins cinq secondes : la fonction doit encore avoir le temps de publier ce que l'API vient de lui rendre."
    }
  }

  depends_on = [aws_cloudwatch_log_group.reminder_sweeper]

  tags = {
    Name = local.reminder_sweeper_function_name
  }
}

# --- Rôle du planificateur ----------------------------------------------------

data "aws_iam_policy_document" "reminder_schedule_assume" {
  statement {
    sid     = "SchedulerAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    # Le confus adjoint : sans cette condition, n'importe quel planning d'un
    # autre compte pourrait endosser ce rôle si son ARN venait à être connu.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "reminder_schedule" {
  name               = "${local.name_prefix}-reminder-schedule"
  description        = "Rôle qu'EventBridge Scheduler endosse pour déclencher le balayage des rappels J-1 ${var.environment}."
  assume_role_policy = data.aws_iam_policy_document.reminder_schedule_assume.json

  tags = {
    Name = "${local.name_prefix}-reminder-schedule"
  }
}

# Une seule action, sur une seule fonction. EventBridge Scheduler appelle sous
# l'identité de ce rôle : il n'y a donc **pas** de `aws_lambda_permission` à
# poser, contrairement à ce qu'exigent les règles EventBridge classiques, qui
# invoquent au nom du service.
data "aws_iam_policy_document" "reminder_schedule" {
  statement {
    sid       = "InvokeReminderSweeper"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.reminder_sweeper.arn]
  }
}

resource "aws_iam_role_policy" "reminder_schedule" {
  name   = "${local.name_prefix}-reminder-schedule"
  role   = aws_iam_role.reminder_schedule.id
  policy = data.aws_iam_policy_document.reminder_schedule.json
}

# --- Planification ------------------------------------------------------------

resource "aws_scheduler_schedule" "reminder" {
  name        = "${local.name_prefix}-reminder-sweep"
  description = "Balayage horaire des rappels J-1 ${var.environment} — sélectionne les rendez-vous à 24-25 h et publie leurs rappels."

  # Désactivé tant que la chaîne n'est pas branchée. Le planning existe — il est
  # écrit en IaC, pas créé à la main le jour du go-live —, mais il ne déclenche
  # rien : sans `reminder_sweep_url`, la fonction lèverait à chaque heure et son
  # alarme d'erreurs sonnerait indéfiniment sur un environnement où il n'y a
  # rien à rappeler. La sortie `reminder_sweep_configured` le dit sans détour.
  state = var.reminder_sweep_url == null ? "DISABLED" : "ENABLED"

  # Aucune fenêtre de souplesse : EventBridge Scheduler répartirait sinon les
  # déclenchements dans un intervalle, et le pavage des fenêtres de sélection
  # — `[T+24h, T+25h)`, puis `[T+25h, T+26h)` — perdrait son alignement. Un
  # décalage de dix minutes suffirait à laisser dix minutes de rendez-vous sans
  # rappel, ou à en sélectionner deux fois.
  flexible_time_window {
    mode = "OFF"
  }

  # `cron` et non `rate(1 hour)`, et la différence n'est pas cosmétique : `rate`
  # compte à partir de la **création** du planning, si bien qu'un redéploiement
  # décale sa phase — et le décalage se paie en rendez-vous non rappelés, faute
  # de pavage. `cron(0 * * * ? *)` déclenche à la minute zéro de chaque heure,
  # quoi qu'il arrive au planning.
  schedule_expression = var.reminder_schedule_expression

  # Le même fuseau que la sélection. La skill notifications §3 est explicite —
  # « le rappel est calculé dans le fuseau du tenant pour l'affichage de l'heure,
  # mais la sélection se fait en UTC » — et un planning en heure locale se
  # décalerait deux fois par an, emportant une heure de rendez-vous à chaque
  # changement.
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_lambda_function.reminder_sweeper.arn
    role_arn = aws_iam_role.reminder_schedule.arn

    # Les reprises, bornées par la fenêtre elle-même. Au-delà d'une heure, le
    # balayage de cette heure-ci n'a plus d'objet : ses rendez-vous sont sortis
    # de la fenêtre, et le rappel serait « en retard » — ce que l'API refuse
    # d'envoyer de toute façon (`reminderTiming`). Réessayer plus longtemps
    # consommerait des invocations pour produire des messages qui seraient
    # écartés à l'arrivée.
    #
    # Le défaut du service — 185 tentatives sur 24 heures — est le pire réglage
    # possible ici : il ferait rejouer pendant une journée entière un balayage
    # dont la fenêtre est morte depuis longtemps.
    retry_policy {
      maximum_retry_attempts       = var.reminder_max_retry_attempts
      maximum_event_age_in_seconds = var.reminder_max_event_age_seconds
    }

    # Pas de file d'attente morte sur cette cible, délibérément. La seule
    # candidate serait la DLQ des notifications — or un événement de
    # planification n'est pas une enveloppe de notification : un opérateur qui
    # rejouerait la DLQ vers la file d'envoi y déverserait une charge utile que
    # la Lambda d'envoi rejetterait, et la profondeur de DLQ cesserait de
    # vouloir dire « des rappels n'ont pas été remis ». L'échec du balayage se
    # voit à sa place, sur la métrique `Errors` de la fonction, qui porte son
    # alarme.
  }
}
