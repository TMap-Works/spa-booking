# Supervision de la chaîne d'envoi.
#
# Le critère « une notification non envoyée est visible en supervision » ne se
# satisfait pas d'une seule alarme : entre le message publié et le message remis,
# il y a quatre façons distinctes de ne rien envoyer, et chacune a sa métrique.
#
# | Ce qui se passe | Ce qui le dit |
# |---|---|
# | Le message a échoué cinq fois, il est en bout de course | profondeur de la DLQ |
# | La fonction plante avant même de décider | erreurs Lambda |
# | Plus personne ne consomme, ou l'API ne répond plus | âge du plus vieux message |
# | Le message a été refusé pour de bon — adresse morte, désinscription | échecs permanents |
#
# La quatrième est la moins évidente et la plus importante : un échec permanent
# est **acquitté**, donc il ne remplit ni la file ni la DLQ. Sans compteur
# dédié, une adresse invalide serait rigoureusement invisible — la file resterait
# vide, et personne ne saurait que la cliente n'a rien reçu.

locals {
  # Un préfixe commun rend les quatre alarmes triables ensemble dans la console,
  # et repérables d'un coup d'œil dans une liste qui porte celles de tous les
  # modules.
  alarm_prefix = "${local.name_prefix}-notifications"
}

# --- 1. Profondeur de la file d'attente morte ---------------------------------

# Seuil à zéro : **tout** message en DLQ est une anomalie. Un rappel non envoyé
# se traduit en no-show, donc en perte de chiffre d'affaires (skill notifications
# §4) — il n'y a pas de niveau « acceptable » à définir.
#
# `Maximum` et non `Sum` : la métrique est une profondeur instantanée, pas un
# débit ; les additionner sur la période compterait plusieurs fois le même
# message.
resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name        = "${local.alarm_prefix}-dlq-depth"
  alarm_description = "Au moins un message de notification est en file d'attente morte (${aws_sqs_queue.dispatch_dlq.name}) : il a épuisé ses ${var.dispatch_max_receive_count} tentatives et ne sera pas rejoué sans intervention."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.dispatch_dlq.name
  }

  statistic           = "Maximum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  # SQS ne publie pas de point quand la file est restée vide toute la période.
  # Sans cette valeur, l'alarme passerait son temps en `INSUFFICIENT_DATA` —
  # c'est-à-dire ni verte ni rouge, donc ignorée au bout d'une semaine.
  treat_missing_data = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-dlq-depth"
  }
}

# --- 2. Erreurs de la fonction ------------------------------------------------

# Une erreur ici, c'est la fonction qui lève au lieu de décider — un lot rejoué
# en entier, et un compteur de réception qui avance pour des messages sains.
resource "aws_cloudwatch_metric_alarm" "dispatcher_errors" {
  alarm_name        = "${local.alarm_prefix}-dispatcher-errors"
  alarm_description = "La Lambda ${local.dispatcher_function_name} a levé au moins une fois : le lot concerné est rejoué en entier, et ses messages se rapprochent de la DLQ sans avoir été refusés."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.dispatcher.function_name
  }

  statistic           = "Sum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-dispatcher-errors"
  }
}

# --- 3. Âge du plus vieux message ---------------------------------------------

# La seule alarme qui voie une chaîne **arrêtée**. La profondeur de file ne suffit
# pas : dix messages qui attendent trois heures et dix messages qui passent en
# trois secondes donnent la même profondeur moyenne.
#
# Le seuil par défaut vaut une heure, la période du balayage du rappel J-1
# (skill notifications §1) : au-delà, le retard n'est plus rattrapable dans la
# fenêtre du rappel.
resource "aws_cloudwatch_metric_alarm" "backlog_age" {
  alarm_name        = "${local.alarm_prefix}-backlog-age"
  alarm_description = "Le plus vieux message de ${aws_sqs_queue.dispatch.name} attend depuis plus de ${var.backlog_age_alarm_seconds} s : la consommation est arrêtée ou l'API ne répond plus."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage"
  dimensions = {
    QueueName = aws_sqs_queue.dispatch.name
  }

  statistic           = "Maximum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = var.backlog_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-backlog-age"
  }
}

# --- 4. Échecs permanents -----------------------------------------------------

# La métrique est produite par la fonction elle-même, au format EMF : CloudWatch
# l'extrait du journal, sans que la fonction ait à appeler `PutMetricData` dans
# le chemin d'envoi.
#
# `treat_missing_data = "notBreaching"` reste utile bien que la fonction publie
# un zéro à chaque invocation : une période sans aucune invocation ne produit
# aucun point.
resource "aws_cloudwatch_metric_alarm" "permanent_failures" {
  alarm_name        = "${local.alarm_prefix}-permanent-failures"
  alarm_description = "Au moins une notification a été refusée définitivement — adresse invalide, destinataire désinscrit, enveloppe illisible. Elle n'est pas rejouée et n'apparaîtra donc jamais en DLQ : c'est ici, et nulle part ailleurs, qu'elle se voit."

  namespace   = var.metric_namespace
  metric_name = "PermanentFailures"
  dimensions = {
    Environment = var.environment
  }

  statistic           = "Sum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-permanent-failures"
  }
}

# --- Tableau de bord ----------------------------------------------------------

# Ce que les alarmes ne donnent pas : la vue d'ensemble. Une alarme dit qu'un
# seuil est franchi ; elle ne dit pas si le débit d'envoi s'est effondré la
# semaine dernière, ni si les refus permanents montent lentement — la forme même
# d'une réputation d'envoi qui se dégrade.
#
# Trois tableaux de bord au plus par compte sont gratuits, soit exactement un par
# environnement. `create_dashboard` permet d'y renoncer si un tableau de bord
# transverse (#78) prend le relais.
resource "aws_cloudwatch_dashboard" "notifications" {
  count = var.create_dashboard ? 1 : 0

  dashboard_name = local.alarm_prefix

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Issue des livraisons"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "Sum"
          metrics = [
            [var.metric_namespace, "Sent", "Environment", var.environment],
            [".", "Skipped", ".", "."],
            [".", "TransientFailures", ".", "."],
            [".", "PermanentFailures", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Files — en attente et sans issue"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "Maximum"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.dispatch.name],
            ["...", aws_sqs_queue.dispatch_dlq.name],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.dispatch.name],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Fonction d'envoi"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "Sum"
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.dispatcher.function_name],
            [".", "Errors", ".", "."],
            [".", "Throttles", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Durée d'envoi (p99)"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "p99"
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.dispatcher.function_name],
          ]
        }
      },
    ]
  })
}
