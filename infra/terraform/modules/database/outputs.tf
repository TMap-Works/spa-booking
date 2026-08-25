output "instance_id" {
  description = "Identifiant de l'instance RDS — `spa-{env}-rds`."
  value       = aws_db_instance.this.id
}

output "instance_arn" {
  description = "ARN de l'instance, à cibler dans une politique IAM ou une alarme CloudWatch."
  value       = aws_db_instance.this.arn
}

output "address" {
  description = "Nom d'hôte de l'instance, sans le port."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Port d'écoute PostgreSQL."
  value       = aws_db_instance.this.port
}

output "endpoint" {
  description = "Point d'accès `hôte:port`."
  value       = aws_db_instance.this.endpoint
}

output "database_name" {
  description = "Nom de la base créée à l'initialisation."
  value       = aws_db_instance.this.db_name
}

output "master_username" {
  description = "Nom du compte maître. Son mot de passe se lit dans le secret `master_user_secret_arn`, jamais ici."
  value       = aws_db_instance.this.username
}

output "master_user_secret_arn" {
  description = "ARN du secret Secrets Manager où RDS dépose le mot de passe maître. C'est ce que le rôle de tâche ECS doit être autorisé à lire — avec `kms:Decrypt` sur `kms_key_arn`."
  value       = one(aws_db_instance.this.master_user_secret[*].secret_arn)
}

output "security_group_id" {
  description = "Groupe de sécurité de la base. À référencer en source d'une règle sortante côté applicatif, pas à ouvrir sur un bloc CIDR."
  value       = aws_security_group.this.id
}

output "kms_key_arn" {
  description = "Clé KMS qui chiffre le stockage, les instantanés, Performance Insights et le secret du mot de passe. À repasser au module cache pour n'en administrer qu'une."
  value       = local.kms_key_arn
}

output "subnet_group_name" {
  description = "Groupe de sous-réseaux de données utilisé par l'instance."
  value       = aws_db_subnet_group.this.name
}

output "parameter_group_name" {
  description = "Groupe de paramètres appliqué — celui qui autorise `btree_gist` et impose TLS."
  value       = aws_db_parameter_group.this.name
}

output "allowed_extensions" {
  description = "Extensions PostgreSQL installables sur cette instance. Liste vide = aucune restriction posée."
  value       = var.allowed_extensions
}

output "cloudwatch_log_group_names" {
  description = "Groupes de journaux CloudWatch alimentés par l'instance, par type de journal."
  value       = { for type, group in aws_cloudwatch_log_group.this : type => group.name }
}
