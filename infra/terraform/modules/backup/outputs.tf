output "vault_name" {
  description = "Nom du coffre. C'est la valeur à passer à `aws backup list-recovery-points-by-backup-vault --backup-vault-name` — la première commande du runbook de restauration."
  value       = aws_backup_vault.this.name
}

output "vault_arn" {
  description = "ARN du coffre, à cibler dans une politique IAM ou une règle EventBridge."
  value       = aws_backup_vault.this.arn
}

output "vault_kms_key_arn" {
  description = "Clé qui chiffre les points de restauration. Distincte de celle du module `database` : c'est ce qui fait qu'une sauvegarde survit à la perte de la clé de sa source."
  value       = local.kms_key_arn
}

output "vault_locked" {
  description = "Vrai quand un verrou de coffre en mode gouvernance est posé. Faux, une rétention peut être raccourcie et un point de restauration supprimé avant son terme par tout principal qui en a le droit."
  value       = var.vault_lock != null
}

output "plan_name" {
  description = "Nom du plan de sauvegarde."
  value       = aws_backup_plan.this.name
}

output "plan_id" {
  description = "Identifiant du plan."
  value       = aws_backup_plan.this.id
}

output "plan_version" {
  description = "Version du plan. Elle change à chaque modification des règles : c'est ce qui permet de dire, devant un point de restauration ancien, sous quelle politique il a été pris."
  value       = aws_backup_plan.this.version
}

output "role_arn" {
  description = "Rôle de service AWS Backup. C'est celui que le runbook passe à `aws backup start-restore-job --iam-role-arn` : il porte à la fois les droits de sauvegarde et ceux de restauration."
  value       = aws_iam_role.this.arn
}

output "retention_policy" {
  description = "Politique de rétention effectivement posée, par cadence et en jours. Une cadence absente de cette map n'a pas de règle dans le plan. À comparer aux cibles du CDC §4.14 sans ouvrir la console."
  value       = { for name, rule in local.rules : name => rule.delete_after }
}

output "continuous_backup_enabled" {
  description = "Vrai quand la sauvegarde continue est active — donc quand la restauration à un instant donné est possible depuis le coffre. Faux, le RPO de ce coffre vaut la cadence du plus court instantané, soit vingt-quatre heures pour un plan quotidien."
  value       = contains(keys(local.rules), "continuous")
}

output "protects_anything" {
  description = "Faux si le plan n'a aucune sélection : le coffre existe, le plan existe, ses règles sont là — et rien n'est sauvegardé. C'est l'état qui passe tous les contrôles et ne restaure rien."
  value       = local.protects_anything
}

output "protected_resource_arns" {
  description = "Ressources protégées par ARN. Ne dit rien de celles qui le sont par étiquette — voir `selection_tags`."
  value       = var.resource_arns
}

output "selection_tags" {
  description = "Étiquettes qui sélectionnent des ressources supplémentaires. Une ressource doit les porter toutes."
  value       = var.selection_tags
}

output "alarm_names" {
  description = "Alarmes du coffre — aucune sauvegarde terminée, travaux en échec, travaux expirés, restauration en échec. Vide quand le plan ne protège rien."
  value = compact([
    one(aws_cloudwatch_metric_alarm.no_backup[*].alarm_name),
    one(aws_cloudwatch_metric_alarm.failed[*].alarm_name),
    one(aws_cloudwatch_metric_alarm.expired[*].alarm_name),
    one(aws_cloudwatch_metric_alarm.restore_failed[*].alarm_name),
  ])
}

output "alarms_notify" {
  description = "Vrai quand les alarmes sont branchées sur un topic SNS. Faux, elles passent au rouge dans la console sans prévenir personne — ce qui est pire que pas d'alarme, puisqu'on se croit couvert."
  value       = local.notify
}
