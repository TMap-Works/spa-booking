output "replication_group_id" {
  description = "Identifiant du groupe de réplication — `spa-{env}-redis`."
  value       = aws_elasticache_replication_group.this.id
}

output "replication_group_arn" {
  description = "ARN du groupe de réplication, à cibler dans une politique IAM ou une alarme CloudWatch."
  value       = aws_elasticache_replication_group.this.arn
}

output "primary_endpoint_address" {
  description = "Nom d'hôte du nœud primaire — le seul qui accepte les écritures, donc le seul où poser un verrou."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Nom d'hôte de lecture, réparti sur les réplicas. Vaut le primaire tant que `replica_count` est nul."
  value       = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "port" {
  description = "Port d'écoute Redis."
  value       = aws_elasticache_replication_group.this.port
}

output "connection_url_scheme" {
  description = "Schéma d'URL à utiliser côté client. `rediss://` et non `redis://` : le chiffrement en transit est activé, un client qui parle en clair est refusé par le nœud."
  value       = "rediss"
}

output "auth_token_secret_arn" {
  description = "ARN du secret Secrets Manager qui porte le jeton AUTH, ou `null` si `auth_token_enabled` est faux. C'est ce que le rôle de tâche ECS doit être autorisé à lire — avec `kms:Decrypt` sur `kms_key_arn`. Le jeton lui-même n'est jamais une sortie."
  value       = one(aws_secretsmanager_secret.auth_token[*].arn)
}

output "auth_token_enabled" {
  description = "Vrai si un jeton AUTH est exigé à la connexion."
  value       = var.auth_token_enabled
}

output "security_group_id" {
  description = "Groupe de sécurité du cache. À référencer en source d'une règle sortante côté applicatif, pas à ouvrir sur un bloc CIDR."
  value       = aws_security_group.this.id
}

output "kms_key_arn" {
  description = "Clé KMS qui chiffre les données au repos, les instantanés et le secret du jeton AUTH."
  value       = local.kms_key_arn
}

output "subnet_group_name" {
  description = "Groupe de sous-réseaux de données utilisé par le cluster."
  value       = aws_elasticache_subnet_group.this.name
}

output "parameter_group_name" {
  description = "Groupe de paramètres appliqué — celui qui porte la politique d'éviction."
  value       = aws_elasticache_parameter_group.this.name
}

output "cloudwatch_log_group_names" {
  description = "Groupes de journaux CloudWatch alimentés par le cluster, par type de journal."
  value       = { for type, group in aws_cloudwatch_log_group.this : type => group.name }
}
