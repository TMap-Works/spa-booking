output "vpc_id" {
  description = "Identifiant du VPC de l'environnement."
  value       = module.network.vpc_id
}

output "vpc_cidr_block" {
  description = "Bloc CIDR du VPC."
  value       = module.network.vpc_cidr_block
}

output "public_subnet_ids" {
  description = "Sous-réseaux publics — ALB et NAT Gateway."
  value       = module.network.public_subnet_ids
}

output "app_subnet_ids" {
  description = "Sous-réseaux privés applicatifs — ECS Fargate et Lambda dans le VPC."
  value       = module.network.app_subnet_ids
}

output "data_subnet_ids" {
  description = "Sous-réseaux privés de données — RDS et ElastiCache, sans route vers Internet."
  value       = module.network.data_subnet_ids
}

output "data_route_table_id" {
  description = "Table de routage du niveau données. Elle ne doit jamais porter de route sortante."
  value       = module.network.data_route_table_id
}

output "nat_gateway_public_ips" {
  description = "Adresses publiques de sortie du VPC."
  value       = module.network.nat_gateway_public_ips
}

output "vpc_endpoint_security_group_id" {
  description = "Groupe de sécurité des endpoints d'interface."
  value       = module.network.vpc_endpoint_security_group_id
}

# --- Registre d'images --------------------------------------------------------

output "ecr_repository_urls" {
  description = "URL des dépôts ECR, par application. C'est ce que le workflow de déploiement étiquette et pousse."
  value       = module.ecr.repository_urls
}

output "api_image" {
  description = "Image que la définition de tâche de l'API désigne actuellement — dépôt et étiquette. C'est la valeur à reprendre en `-var image_tag` avant tout `terraform apply` lancé à la main, faute de quoi le service reviendrait à l'étiquette d'amorçage."
  value       = local.api_image
}

# --- Point d'entrée public ----------------------------------------------------

output "alb_dns_name" {
  description = "Nom DNS public de l'ALB. C'est l'hôte à poser dans la variable de dépôt APP_URL (`https://<ce nom>`) et à reprendre dans les clés APP_URL et API_URL du secret d'exécution."
  value       = module.ecs_service.alb_dns_name
}

output "app_url" {
  description = "URL publique de l'environnement, telle qu'elle doit être posée en variable de dépôt APP_URL. Le certificat étant auto-signé par défaut, un client doit y désactiver la vérification TLS."
  value       = "https://${module.ecs_service.alb_dns_name}"
}

# --- Compute ------------------------------------------------------------------

output "ecs_cluster_name" {
  description = "Nom du cluster ECS — celui que le workflow de déploiement passe en `--cluster`."
  value       = module.ecs_service.cluster_name
}

output "ecs_service_names" {
  description = "Nom du service ECS, par application."
  value       = module.ecs_service.service_names
}

output "migrate_task_definition_family" {
  description = "Famille de la définition de tâche de migration, jouée avant chaque déploiement."
  value       = aws_ecs_task_definition.migrate.family
}

# --- Configuration d'exécution ------------------------------------------------

output "api_runtime_secret_arn" {
  description = "ARN du secret Secrets Manager portant les variables d'exécution de l'API. Terraform en crée le conteneur ; sa valeur est déposée hors Terraform (voir README)."
  value       = aws_secretsmanager_secret.api_runtime.arn
}

output "database_endpoint" {
  description = "Point d'accès `hôte:port` de PostgreSQL, à composer dans la clé DATABASE_URL du secret d'exécution."
  value       = module.database.endpoint
}

output "database_master_user_secret_arn" {
  description = "ARN du secret où RDS dépose le mot de passe maître. C'est là que se lit le mot de passe à composer dans DATABASE_URL — jamais dans l'état Terraform."
  value       = module.database.master_user_secret_arn
}

output "redis_primary_endpoint" {
  description = "Nom d'hôte du nœud primaire Redis, à composer dans la clé REDIS_URL du secret d'exécution — en `rediss://`, le chiffrement en transit étant activé."
  value       = module.cache.primary_endpoint_address
}

output "redis_auth_token_secret_arn" {
  description = "ARN du secret portant le jeton AUTH Redis, à reprendre dans REDIS_URL."
  value       = module.cache.auth_token_secret_arn
}
