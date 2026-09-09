# Auto-scaling par suivi de cible sur l'utilisation CPU (CDC §4.4). Les bornes
# viennent de chaque service : 2 tâches au repos et 8 au maximum par défaut,
# c'est-à-dire le dimensionnement de production. Dev et staging les abaissent —
# le skill `aws-infra` §9 demande qu'ils soient dimensionnés a minima, et deux
# tâches par service y sont un plancher de facturation, pas un besoin.
#
# Application Auto Scaling ajuste `desired_count` — d'où l'`ignore_changes` posé
# sur le service.

resource "aws_appautoscaling_target" "service" {
  for_each = var.services

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.min_capacity
  max_capacity       = each.value.max_capacity

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = var.services

  name               = "${local.name_prefix}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.cpu_target_utilization

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    # Asymétrie voulue : on monte vite, on redescend lentement. Une réduction
    # trop prompte fait osciller le service sur une charge en dents de scie, et
    # chaque oscillation se paie en démarrages à froid.
    scale_out_cooldown = var.scale_out_cooldown_seconds
    scale_in_cooldown  = var.scale_in_cooldown_seconds
  }
}

# --- Arrêt hors heures ouvrées ------------------------------------------------
#
# « Dev et staging dimensionnés a minima et **arrêtables hors heures ouvrées** »
# (skill aws-infra §9, CDC §4.16). Arrêtables *en Terraform* : un environnement
# qu'on éteint à la main reste allumé le soir où personne n'y pense, et c'est
# précisément le poste de dépense qu'on croyait avoir maîtrisé.
#
# Le levier est la **cible** d'auto-scaling, pas le service : une action
# planifiée y écrit `min_capacity` et `max_capacity`, et Application Auto
# Scaling ramène `desired_count` dans l'intervalle. Passer par
# `aws_ecs_service.desired_count` n'aurait rien donné — il est sous
# `ignore_changes`, l'auto-scaling en étant propriétaire une fois le service
# créé.
#
# Les deux ressources ne se posent que si `off_hours_shutdown` est renseigné, et
# elles se posent **par service** : l'API et le front s'arrêtent ensemble, mais
# rien n'oblige à ce qu'ils repartent avec la même capacité.

resource "aws_appautoscaling_scheduled_action" "off_hours_stop" {
  for_each = var.off_hours_shutdown == null ? {} : var.services

  name               = "${local.name_prefix}-${each.key}-off-hours-stop"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension

  schedule = var.off_hours_shutdown.stop_cron
  timezone = var.off_hours_shutdown.timezone

  # Zéro des deux côtés, et pas seulement `min_capacity` : laisser un maximum
  # non nul autoriserait la politique de suivi de cible à faire remonter le
  # service dès la première métrique de CPU, ce qui rallumerait l'environnement
  # qu'on vient d'éteindre.
  scalable_target_action {
    min_capacity = 0
    max_capacity = 0
  }
}

resource "aws_appautoscaling_scheduled_action" "off_hours_start" {
  for_each = var.off_hours_shutdown == null ? {} : var.services

  name               = "${local.name_prefix}-${each.key}-off-hours-start"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension

  schedule = var.off_hours_shutdown.start_cron
  timezone = var.off_hours_shutdown.timezone

  # Les bornes déclarées par le service, et non des constantes : c'est ce qui
  # fait que relever `min_capacity` dans `services` suffit, sans avoir à penser
  # à corriger la planification du matin en même temps.
  scalable_target_action {
    min_capacity = each.value.min_capacity
    max_capacity = each.value.max_capacity
  }
}
