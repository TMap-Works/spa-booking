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

# --- 2 bis. Le balayage du rappel J-1 ne s'est pas fait -----------------------

# La seule alarme qui voie un rappel **jamais publié** (#71).
#
# Les quatre autres surveillent ce qui se passe *après* la publication : la file,
# la fonction d'envoi, la DLQ. Aucune ne dirait rien d'un balayage qui n'a pas
# eu lieu — la file resterait simplement vide, ce qui est indiscernable d'une
# heure sans rendez-vous. Et un rappel non envoyé se traduit en no-show, donc en
# perte de chiffre d'affaires (skill notifications §4).
#
# Seuil à zéro : le balayage a lieu une fois par heure et n'a aucune raison de
# lever. La fonction ne boucle pas et ne rattrape rien — elle lève, EventBridge
# Scheduler réessaie selon `reminder_max_retry_attempts`, et cette alarme le dit.
#
# `notBreaching` sur la donnée absente : le planning est **désactivé** tant que
# `reminder_sweep_url` n'est pas renseignée, et une alarme en `INSUFFICIENT_DATA`
# permanente sur les environnements non branchés apprendrait à l'équipe à ne plus
# la regarder.
resource "aws_cloudwatch_metric_alarm" "reminder_sweeper_errors" {
  alarm_name        = "${local.alarm_prefix}-reminder-sweeper-errors"
  alarm_description = "Le balayage des rappels J-1 (${local.reminder_sweeper_function_name}) a levé : aucun rappel n'a été publié pour l'heure concernée, et la fenêtre `[+24 h, +25 h)` ne repassera pas."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.reminder_sweeper.function_name
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
    Name = "${local.alarm_prefix}-reminder-sweeper-errors"
  }
}

# --- 2 ter. Le balayage s'est fait, mais incomplet ----------------------------

# Le plafond serveur a arrêté la sélection avant la fin (#71).
#
# L'alarme précédente ne voit **que** les invocations en échec : la métrique
# `AWS/Lambda Errors` ne compte pas une ligne de journal, fût-elle de niveau
# `error`. Or un balayage tronqué réussit — il rend un lot, le publie, et sort
# en 200. Sans cette alarme-ci, le plafond serait exactement ce que
# `reminder-sweep.service.ts` dit vouloir éviter : « un plafond qu'on atteint
# sans le savoir ».
#
# Ce qui se perd alors ne se rattrape pas : la fenêtre `[+24 h, +25 h)` avance
# d'une heure au balayage suivant, et les rendez-vous laissés de côté n'y sont
# plus. Chacun est un rappel jamais envoyé, donc un no-show probable (CDC §1.4).
#
# `notBreaching` sur la donnée absente, pour la même raison que l'alarme
# d'erreurs : le planning est désactivé tant que `reminder_sweep_url` est nulle,
# et une alarme en `INSUFFICIENT_DATA` permanente s'apprend à ne plus se
# regarder.
resource "aws_cloudwatch_metric_alarm" "reminder_sweep_truncated" {
  alarm_name        = "${local.alarm_prefix}-reminder-sweep-truncated"
  alarm_description = "Le balayage des rappels J-1 a atteint son plafond : des rendez-vous de la fenêtre `[+24 h, +25 h)` n'ont pas été sélectionnés, et cette fenêtre ne repassera pas."

  namespace   = var.metric_namespace
  metric_name = "SweepTruncated"
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
    Name = "${local.alarm_prefix}-reminder-sweep-truncated"
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

# --- 5. La chaîne des rebonds ne traite plus rien (#73) -----------------------

# Deux alarmes, et elles ne disent pas la même chose.
#
# La première est la profondeur de la file d'attente morte des **événements de
# remise**. Un rebond bloqué là est plus insidieux qu'une notification bloquée :
# rien n'a échoué du point de vue de la cliente — les messages continuent de
# partir — mais l'adresse morte n'a jamais été supprimée, et le domaine continue
# donc d'écrire à une boîte inexistante. C'est le mécanisme même que le ticket
# cherche à arrêter, arrêté à son tour, et sans cette alarme rien ne le dirait.
resource "aws_cloudwatch_metric_alarm" "delivery_events_dlq_depth" {
  alarm_name        = "${local.alarm_prefix}-delivery-events-dlq-depth"
  alarm_description = "Au moins un événement de remise SES est en file d'attente morte (${aws_sqs_queue.delivery_events_dlq.name}) : le rebond ou la plainte n'a pas été traité, et l'adresse concernée reste sollicitée — c'est la réputation d'envoi du domaine entier qui se dégrade."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.delivery_events_dlq.name
  }

  statistic           = "Maximum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  # SQS ne publie pas de point quand la file est restée vide toute la période.
  treat_missing_data = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-delivery-events-dlq-depth"
  }
}

# La seconde est l'échec de la fonction elle-même. Elle se distingue de la
# précédente par le moment : ici le message est encore dans la file et sera
# rejoué, là il ne le sera plus. Les deux méritent d'être vues, et la première
# à sonner est presque toujours celle-ci.
resource "aws_cloudwatch_metric_alarm" "delivery_events_errors" {
  alarm_name        = "${local.alarm_prefix}-delivery-events-errors"
  alarm_description = "La Lambda ${local.delivery_events_function_name} a levé au moins une fois : le lot concerné est rejoué en entier, et ses événements de remise se rapprochent de la DLQ sans avoir été refusés."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.delivery_events.function_name
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
    Name = "${local.alarm_prefix}-delivery-events-errors"
  }
}

# Pas d'alarme sur `Suppressions`, délibérément.
#
# Un seuil y serait arbitraire — combien d'adresses mortes par heure est-il
# « normal » pour une plateforme dont le volume varie avec les saisons ? — et une
# alarme qu'on ne sait pas régler finit désactivée. La métrique existe, elle est
# au tableau de bord, et c'est sa **forme** qui parle : une montée lente est une
# base client qui vieillit, un pic est un incident d'envoi. Ni l'une ni l'autre
# ne se lit sur un franchissement de seuil.

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
      # Le balayage du rappel J-1 (#71) — l'amont de toute la chaîne. Une courbe
      # plate à zéro sur `RemindersPublished` pendant que les autres bougent est
      # le signe qu'aucun rappel n'est produit, ce qu'aucun autre panneau ne
      # dirait : la file resterait simplement vide.
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Balayage du rappel J-1"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "Sum"
          metrics = [
            [var.metric_namespace, "RemindersSelected", "Environment", var.environment],
            [".", "RemindersPublished", ".", "."],
            [".", "RemindersRejected", ".", "."],
            [".", "SweepTruncated", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Fonction de balayage"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "Sum"
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.reminder_sweeper.function_name],
            [".", "Errors", ".", "."],
            [".", "Throttles", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          # La courbe que personne ne regarde tant qu'elle est plate, et qui dit
          # tout quand elle ne l'est plus : une montée lente est une base client
          # qui vieillit, un pic est un incident d'envoi. Aucune alarme dessus —
          # voir le commentaire de la section 5.
          title  = "Rebonds et plaintes"
          region = data.aws_region.current.name
          view   = "timeSeries"
          period = var.alarm_period_seconds
          stat   = "Sum"
          metrics = [
            [var.metric_namespace, "Suppressions", "Environment", var.environment],
            [".", "DeliveryEventsProcessed", ".", "."],
            [".", "DeliveryEventsUnreadable", ".", "."],
            [".", "DeliveryEventsTransientFailures", ".", "."],
          ]
        }
      },
    ]
  })
}
