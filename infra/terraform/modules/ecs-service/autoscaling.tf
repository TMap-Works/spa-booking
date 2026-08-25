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
