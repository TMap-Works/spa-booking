# Supervision des travaux de sauvegarde et de restauration.
#
# Par des alarmes CloudWatch sur l'espace de noms `AWS/Backup`, et **non** par
# `aws_backup_vault_notifications`. Les deux préviendraient, mais les
# notifications de coffre publient sous le principal `backup.amazonaws.com`, qui
# n'est pas autorisé par la politique du topic du module `budgets` — et cette
# politique appartient à ce module-là. En ajouter une seconde sur le même topic
# ne l'étend pas : SNS n'accepte qu'une politique par topic, et le dernier
# `apply` effacerait celle de l'autre. Les alarmes, elles, publient sous
# `cloudwatch.amazonaws.com`, que le topic autorise déjà (budgets/alerts.tf).
#
# Aucune alarme tant que le plan ne protège rien : « aucune sauvegarde terminée »
# serait alors vrai en permanence, et une alarme qui hurle en régime nominal
# cesse d'être lue.

locals {
  alarm_prefix = "${local.name_prefix}-backup"

  missing_backup_period_seconds = var.missing_backup_period_hours * 3600
}

# La panne que ce ticket existe pour éviter : la sauvegarde qui n'a jamais eu
# lieu. Un échec est bruyant et se voit ; une absence est silencieuse, et ne se
# découvre qu'au moment de restaurer.
#
# `treat_missing_data = "breaching"` est le cœur de l'alarme : sans aucun travail
# terminé, AWS Backup ne publie pas un zéro, il ne publie rien du tout. Traitée
# comme « pas de données, pas de problème » — le défaut de CloudWatch —, l'alarme
# resterait éternellement verte pour un environnement qui ne sauvegarde plus.
resource "aws_cloudwatch_metric_alarm" "no_backup" {
  count = local.protects_anything ? 1 : 0

  alarm_name        = "${local.alarm_prefix}-none-completed"
  alarm_description = "Aucun travail de sauvegarde terminé dans le coffre ${local.vault_name} sur les ${var.missing_backup_period_hours} dernières heures. La restauration la plus récente possible vieillit à chaque heure qui passe (CDC §4.14)."

  namespace   = "AWS/Backup"
  metric_name = "NumberOfBackupJobsCompleted"
  dimensions  = { BackupVaultName = aws_backup_vault.this.name }

  statistic           = "Sum"
  period              = local.missing_backup_period_seconds
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-none-completed"
  }
}

resource "aws_cloudwatch_metric_alarm" "failed" {
  count = local.protects_anything ? 1 : 0

  alarm_name        = "${local.alarm_prefix}-jobs-failed"
  alarm_description = "Au moins un travail de sauvegarde en échec dans le coffre ${local.vault_name}. Le point de restauration attendu n'existe pas."

  namespace   = "AWS/Backup"
  metric_name = "NumberOfBackupJobsFailed"
  dimensions  = { BackupVaultName = aws_backup_vault.this.name }

  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0

  # Ici l'absence de donnée est normale — il n'y a pas d'échec à compter la
  # plupart des heures. C'est l'alarme précédente qui couvre le silence.
  treat_missing_data = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-jobs-failed"
  }
}

# `EXPIRED` : le travail n'a pas démarré dans sa fenêtre. Distinct d'un échec —
# rien ne s'est mal passé, rien ne s'est passé du tout — et c'est le symptôme
# d'une fenêtre de démarrage trop courte ou d'une instance occupée par son propre
# instantané RDS au même moment.
resource "aws_cloudwatch_metric_alarm" "expired" {
  count = local.protects_anything ? 1 : 0

  alarm_name        = "${local.alarm_prefix}-jobs-expired"
  alarm_description = "Un travail de sauvegarde n'a pas démarré dans sa fenêtre (${var.start_window_minutes} min) et a expiré. Vérifier le chevauchement avec la fenêtre de sauvegarde automatique de RDS."

  namespace   = "AWS/Backup"
  metric_name = "NumberOfBackupJobsExpired"
  dimensions  = { BackupVaultName = aws_backup_vault.this.name }

  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-jobs-expired"
  }
}

# Une restauration en échec, c'est presque toujours pendant l'exercice du
# runbook. L'alarme sert alors moins à prévenir qu'à horodater : elle marque
# l'instant où l'essai a buté, ce qui compte pour le relevé de RTO.
resource "aws_cloudwatch_metric_alarm" "restore_failed" {
  count = local.protects_anything ? 1 : 0

  alarm_name        = "${local.alarm_prefix}-restore-failed"
  alarm_description = "Un travail de restauration a échoué depuis le coffre ${local.vault_name}. Voir docs/runbooks/pra-restauration-rds.md."

  namespace   = "AWS/Backup"
  metric_name = "NumberOfRestoreJobsFailed"
  dimensions  = { BackupVaultName = aws_backup_vault.this.name }

  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-restore-failed"
  }
}
