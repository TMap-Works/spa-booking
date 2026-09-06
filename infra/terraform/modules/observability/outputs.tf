output "alarm_names" {
  description = "Nom de chaque alarme posée par le module, dans l'ordre où elles se lisent : entrée publique, calcul, données, asynchrone. Liste vide = l'environnement ne compose encore aucune source à superviser."
  value = concat(
    aws_cloudwatch_metric_alarm.alb_5xx_rate[*].alarm_name,
    aws_cloudwatch_metric_alarm.alb_latency_p99[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.ecs_cpu)[*].alarm_name,
    aws_cloudwatch_metric_alarm.rds_connections[*].alarm_name,
    aws_cloudwatch_metric_alarm.rds_free_storage[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.dead_letter_queue_depth)[*].alarm_name,
    values(aws_cloudwatch_metric_alarm.lambda_errors)[*].alarm_name,
  )
}

output "alarm_arns" {
  description = "ARN de chaque alarme, dans le même ordre. C'est ce qu'un abonnement supplémentaire ou une règle EventBridge doit cibler."
  value       = local.alarm_arns
}

output "alarms_notify" {
  description = "Vrai quand les alarmes sont branchées sur au moins un topic SNS. Faux, elles changent d'état dans la console sans prévenir personne — ce qui est pire que pas d'alarme du tout, puisqu'on se croit couvert."
  value       = length(var.alarm_topic_arns) > 0
}

output "rds_connections_threshold" {
  description = "Nombre de connexions à partir duquel l'alarme se déclenche, dérivé du pourcentage demandé. `null` si aucune base n'est supervisée."
  value       = local.rds_connections_threshold
}

output "rds_free_storage_threshold_bytes" {
  description = "Espace libre, en octets, sous lequel l'alarme se déclenche. `null` si aucune base n'est supervisée."
  value       = local.rds_free_storage_threshold_bytes
}

output "dashboard_name" {
  description = "Tableau de bord transverse de l'environnement, ou `null` s'il n'a pas été créé — soit `create_dashboard` est faux, soit il n'y avait aucune source à afficher."
  value       = one(aws_cloudwatch_dashboard.this[*].dashboard_name)
}

output "xray_sampling_rule_name" {
  description = "Règle d'échantillonnage X-Ray de l'environnement, ou `null` si le traçage n'est pas activé — auquel cas X-Ray retombe sur sa règle `Default`, commune à tout le compte."
  value       = one(aws_xray_sampling_rule.this[*].rule_name)
}

output "xray_sampling_service_name" {
  description = "Filtre de service auquel la règle d'échantillonnage s'applique. C'est le nom que l'application doit déclarer au SDK X-Ray pour être gouvernée par cette règle plutôt que par la `Default`."
  value       = var.tracing.enabled ? local.tracing_service_name : null
}
