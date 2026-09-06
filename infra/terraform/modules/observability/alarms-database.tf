# Supervision du niveau données.
#
# Les deux pannes qui arrêtent net une plateforme de réservation, et qu'aucune
# alarme applicative ne voit venir : plus une connexion disponible, plus un octet
# libre. Toutes deux se préparent lentement et se déclarent d'un coup.

# --- 1. Saturation des connexions ---------------------------------------------

# Une base pleine de connexions refuse les nouvelles avec « too many clients
# already » — l'API rend alors 500 sur chaque requête, y compris `/health`, et le
# service entier est retiré du groupe cible. Le seuil à 80 % laisse la marge
# d'ouvrir une session d'administration pour comprendre.
#
# La cause habituelle n'est pas la charge mais une fuite : un pool applicatif qui
# ne rend pas ses connexions monte en marche d'escalier et ne redescend jamais.
resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  count = local.rds_enabled ? 1 : 0

  alarm_name        = "${local.name_prefix}-rds-connections"
  alarm_description = "L'instance ${var.rds.instance_id} dépasse ${local.rds_connections_threshold} connexions ouvertes, soit ${var.rds.connections_percent} % des ${var.rds.max_connections} que son moteur accepte (CDC §4.11). Au maximum, PostgreSQL refuse toute nouvelle session — y compris celle du contrôle de santé."

  namespace   = "AWS/RDS"
  metric_name = "DatabaseConnections"
  dimensions = {
    DBInstanceIdentifier = var.rds.instance_id
  }

  # `Maximum` et non `Average` : la saturation est un instant, pas une moyenne.
  # Cinq minutes à 90 % suivies de cinq minutes à 10 % font une moyenne
  # rassurante et un service coupé.
  statistic = "Maximum"

  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = local.rds_connections_threshold
  comparison_operator = "GreaterThanThreshold"

  # Une instance qui cesse de publier ses métriques est un incident en soi.
  treat_missing_data = "missing"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.name_prefix}-rds-connections"
  }
}

# --- 2. Espace disque libre ---------------------------------------------------

# Un volume plein met PostgreSQL en lecture seule : plus une réservation, plus un
# paiement, et une restauration à faire. L'extension automatique du stockage
# n'attend qu'à 10 % et met plusieurs minutes ; ce seuil à 20 % prévient pendant
# qu'il reste le temps d'agir.
resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  count = local.rds_enabled ? 1 : 0

  alarm_name        = "${local.name_prefix}-rds-free-storage"
  alarm_description = "Il reste moins de ${var.rds.free_storage_percent} % d'espace libre sur les ${var.rds.allocated_storage_gib} Gio provisionnés de ${var.rds.instance_id}, soit ${local.rds_free_storage_threshold_bytes} octets (CDC §4.11). Un volume plein bascule PostgreSQL en lecture seule."

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions = {
    DBInstanceIdentifier = var.rds.instance_id
  }

  # `Minimum` : c'est le creux de la période qui compte, pas sa moyenne.
  statistic = "Minimum"

  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = local.rds_free_storage_threshold_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.name_prefix}-rds-free-storage"
  }
}
