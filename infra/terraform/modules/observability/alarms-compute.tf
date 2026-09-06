# Supervision du niveau applicatif.
#
# Une alarme par service et non une pour le cluster : la moyenne de deux services
# dont l'un sature et l'autre dort ne dépasse jamais le seuil, et c'est
# exactement la forme d'un incident qui ne réveille personne.

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = local.ecs_enabled ? var.ecs.service_names : {}

  alarm_name        = "${local.name_prefix}-ecs-${each.key}-cpu"
  alarm_description = "Le service ECS ${each.value} consomme plus de ${var.ecs.cpu_percent} % de son CPU depuis ${var.ecs.evaluation_periods * var.alarm_period_seconds / 60} minutes (CDC §4.11). L'auto-scaling vise 60 % : à ce niveau, soit il a atteint `max_capacity`, soit il ne monte pas."

  namespace   = "AWS/ECS"
  metric_name = "CPUUtilization"
  dimensions = {
    ClusterName = var.ecs.cluster_name
    ServiceName = each.value
  }

  # `Average` sur l'ensemble des tâches du service, et non `Maximum` : une seule
  # tâche à 95 % pendant qu'une autre est à 10 % est le fonctionnement normal
  # d'un équilibrage par requêtes en cours, pas une saturation.
  statistic = "Average"

  period = var.alarm_period_seconds

  # Ce qui fait les « dix minutes » du critère. Une période suffirait à faire
  # sonner l'alarme sur le pic de démarrage d'un déploiement.
  evaluation_periods = var.ecs.evaluation_periods

  threshold           = var.ecs.cpu_percent
  comparison_operator = "GreaterThanThreshold"

  # `missing` et non `notBreaching` : un service sans aucune tâche ne publie plus
  # de métrique, et le déclarer « pas en alarme » reviendrait à peindre en vert
  # un service disparu. L'absence de données est ici une information — c'est
  # l'alarme 5xx de l'ALB qui dira que plus rien ne répond.
  treat_missing_data = "missing"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.name_prefix}-ecs-${each.key}-cpu"
  }
}
