# Supervision des traitements asynchrones.
#
# Ce qui se passe hors du chemin de requête HTTP ne se voit ni dans les 5xx de
# l'ALB, ni dans le CPU des tâches : un message qui ne part pas ne fait échouer
# aucune requête. Ces deux familles d'alarmes sont le seul endroit où cela se
# sait.
#
# Les deux `for_each` sont vides tant que la seule chaîne asynchrone du projet
# est celle des notifications, qui pose ses propres alarmes (#67). Elles sont ici
# pour la file et la fonction suivantes, celles qui n'auront pas de module à
# elles — et pour que le tableau des sept alarmes du CDC §4.11 soit couvert par
# un seul module.

# --- 1. Profondeur des files d'attente mortes ---------------------------------

# Seuil à zéro : **tout** message en DLQ est une anomalie. Il a épuisé ses
# tentatives, il ne sera pas rejoué sans intervention, et il n'y a donc pas de
# profondeur « acceptable » à définir.
resource "aws_cloudwatch_metric_alarm" "dead_letter_queue_depth" {
  for_each = var.dead_letter_queues

  alarm_name        = "${local.name_prefix}-${each.key}-dlq-depth"
  alarm_description = "Au moins un message est en file d'attente morte (${each.value}) : il a épuisé ses tentatives et ne repartira pas sans intervention."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = each.value
  }

  # `Maximum` et non `Sum` : la métrique est une profondeur instantanée, pas un
  # débit ; les additionner sur la période compterait plusieurs fois le même
  # message.
  statistic = "Maximum"

  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  # SQS ne publie pas de point quand la file est restée vide toute la période.
  treat_missing_data = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.name_prefix}-${each.key}-dlq-depth"
  }
}

# --- 2. Erreurs de fonction ---------------------------------------------------

# Une erreur Lambda, c'est la fonction qui lève au lieu de décider : le lot est
# rejoué en entier, et des messages sains voient leur compteur de réception
# avancer vers la DLQ sans avoir jamais été refusés.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.lambda_functions

  alarm_name        = "${local.name_prefix}-${each.key}-errors"
  alarm_description = "La fonction ${each.value} a levé au moins une fois sur la période. Le lot concerné est rejoué en entier."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = each.value
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
    Name = "${local.name_prefix}-${each.key}-errors"
  }
}
