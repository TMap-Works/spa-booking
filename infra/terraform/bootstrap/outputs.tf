output "state_bucket_names" {
  description = "Nom du bucket d'état, par environnement."
  value       = { for env in var.environments : env => aws_s3_bucket.state[env].id }
}

output "lock_table_names" {
  description = "Nom de la table DynamoDB de verrouillage, par environnement."
  value       = { for env in var.environments : env => aws_dynamodb_table.lock[env].name }
}

output "state_kms_key_aliases" {
  description = "Alias de la clé KMS chiffrant l'état, par environnement."
  value       = { for env in var.environments : env => aws_kms_alias.state[env].name }
}

# Le backend S3 refuse les alias : `kms_key_id` n'accepte qu'un identifiant de clé
# (UUID) ou un ARN de clé. Ce sont donc ces valeurs — et non les alias ci-dessus —
# qu'il faut passer à `terraform init -backend-config="kms_key_id=…"` pour que
# l'état d'un environnement soit chiffré par sa propre clé plutôt qu'en SSE-S3.
output "state_kms_key_ids" {
  description = "Identifiant de la clé KMS chiffrant l'état, par environnement — à passer en `-backend-config` lors de l'init d'un envs/*."
  value       = { for env in var.environments : env => aws_kms_key.state[env].key_id }
}

# --- Volet audit (CDC §4.10, issue #79) ---------------------------------------

output "audit_bucket_name" {
  description = "Bucket recevant les journaux CloudTrail et les instantanés AWS Config du compte."
  value       = aws_s3_bucket.audit.id
}

output "audit_kms_key_alias" {
  description = "Alias de la clé chiffrant les journaux d'audit. Distincte des clés d'état : lire l'état d'un environnement ne donne pas de lire la trace du compte."
  value       = aws_kms_alias.audit.name
}

output "cloudtrail_arn" {
  description = "ARN de la trace multi-région du compte, ou null si `cloudtrail_enabled` est faux."
  value       = one(aws_cloudtrail.account[*].arn)
}

output "guardduty_detector_id" {
  description = "Identifiant du détecteur GuardDuty, ou null si `guardduty_enabled` est faux."
  value       = one(aws_guardduty_detector.this[*].id)
}

output "security_alerts_topic_arn" {
  description = "Topic SNS recevant les constats GuardDuty au-delà du seuil de sévérité. Distinct du topic budgétaire de chaque environnement — ce ne sont pas les mêmes urgences."
  value       = one(aws_sns_topic.security_alerts[*].arn)
}

# Un abonnement créé n'est pas un abonnement confirmé : SNS attend que le
# destinataire clique le lien reçu, et Terraform ne peut pas le faire à sa place.
# Sans confirmation, les constats sont publiés et personne ne les reçoit — ce qui
# ressemble en tout point à un compte sans incident.
output "security_alert_subscriptions_pending" {
  description = "Abonnements au topic d'alertes de sécurité restant à confirmer par leur destinataire. Non vide, c'est un point ouvert de la liste de go-live (#83)."
  # `pending_confirmation` et non `confirmation_was_authenticated` : le second dit
  # si la confirmation a été *authentifiée* par des identifiants AWS, ce qu'un clic
  # sur le lien reçu par courriel n'est jamais — il resterait donc faux après
  # confirmation, et cette sortie nommerait éternellement des abonnements en règle.
  value = sort([for sub in aws_sns_topic_subscription.security_alerts_email : sub.endpoint if sub.pending_confirmation])
}

output "config_recorder_running" {
  description = "Vrai si l'enregistreur AWS Config est démarré. Le créer ne le démarre pas — c'est le piège le plus courant du service, et un enregistreur à l'arrêt n'évalue aucune règle tout en paraissant installé."
  value       = length(aws_config_configuration_recorder_status.this) > 0 ? aws_config_configuration_recorder_status.this[0].is_enabled : false
}

output "config_rule_names" {
  description = "Règles Config évaluées en continu. Chacune tient un critère nommé de l'issue #79 — voir la variable `config_rules` pour la correspondance."
  value       = sort(keys(aws_config_config_rule.this))
}

# Ce que la liste de vérification du go-live (#83) doit pouvoir lire d'un coup
# d'œil : les trois services du critère « GuardDuty, Config et CloudTrail
# activés » sont-ils en place, oui ou non.
output "audit_services_enabled" {
  description = "État des trois services d'audit à portée de compte. Un `false` ici est un critère de sécurité non tenu, pas une préférence de configuration."
  value = {
    cloudtrail = length(aws_cloudtrail.account) > 0
    config     = length(aws_config_configuration_recorder_status.this) > 0
    guardduty  = length(aws_guardduty_detector.this) > 0
  }
}

output "cost_allocation_tag_keys" {
  description = "Étiquettes activées comme étiquettes de répartition de coûts. L'activation vaut pour le compte entier et ne ventile la facture qu'à partir du mois de l'`apply` — une clé absente d'ici est une dimension que Cost Explorer refusera de regrouper."
  value       = sort([for tag in aws_ce_cost_allocation_tag.this : tag.tag_key])
}

# Sert de contrôle après l'amorçage : ces valeurs doivent correspondre trait pour
# trait aux blocs `backend` déjà versionnés dans envs/*. Un écart signifie qu'un
# environnement pointe vers un état qui n'existe pas.
output "backend_configuration" {
  description = "Configuration de backend attendue par chaque environnement, à comparer avec envs/<env>/backend.tf."
  value = {
    for env in var.environments : env => {
      bucket         = aws_s3_bucket.state[env].id
      key            = "envs/${env}/terraform.tfstate"
      region         = var.aws_region
      dynamodb_table = aws_dynamodb_table.lock[env].name
      encrypt        = true
    }
  }
}
