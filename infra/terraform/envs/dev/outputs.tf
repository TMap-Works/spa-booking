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

# --- Délivrabilité e-mail -----------------------------------------------------

# Toutes nulles tant que `notification_domain` n'est pas fourni : le module n'est
# alors pas composé. `one()` plutôt que `[0]` — l'index n'existe pas dans ce cas,
# et `terraform output` échouerait au lieu de rendre `null`.

output "notification_domain" {
  description = "Domaine d'envoi vérifié dans SES, ou `null` tant qu'aucun n'est fourni à l'environnement."
  value       = one(module.notifications[*].domain)
}

output "notification_verified_for_sending_status" {
  description = "Vrai quand SES a lu les enregistrements DKIM et considère le domaine comme vérifié. Faux juste après le premier `apply` — la vérification est asynchrone. Faux durablement, comparer `notification_dns_records` à ce que rend un `dig`."
  value       = one(module.notifications[*].verified_for_sending_status)
}

output "notification_dns_records" {
  description = "Enregistrements DKIM, SPF et DMARC de la délivrabilité, avec leur nom, leur type et leur valeur. Posés par le module quand la zone est dans Route 53 ; à publier chez le registraire sinon — sans eux, aucun message ne part."
  value       = one(module.notifications[*].dns_records)
}

output "notification_configuration_set_name" {
  description = "Jeu de configuration SES à passer en `ConfigurationSetName` de chaque envoi, y compris pour le test d'envoi réel décrit dans le README du module."
  value       = one(module.notifications[*].configuration_set_name)
}

output "notification_events_topic_arn" {
  description = "Topic SNS des rebonds, plaintes, refus et échecs de rendu. Point d'entrée du traitement applicatif des rebonds (#73), auquel on s'abonne par une file SQS et non par HTTP."
  value       = one(module.notifications[*].events_topic_arn)
}

output "notification_events_kms_key_arn" {
  description = "Clé KMS chiffrant le topic d'événements. Tout consommateur du topic doit obtenir `kms:Decrypt` dessus, faute de quoi il recevra des messages illisibles."
  value       = one(module.notifications[*].kms_key_arn)
}

# --- Coûts et observabilité ---------------------------------------------------

output "budget_name" {
  description = "Nom du budget mensuel de l'environnement, tel qu'il apparaît dans la console Billing et dans les messages d'alerte."
  value       = module.budgets.budget_name
}

output "budget_limit" {
  description = "Plafond mensuel de l'environnement et sa devise. Les alertes se déclenchent à 80 % puis 100 % de cette valeur, sur la dépense constatée."
  value       = module.budgets.budget_limit
}

output "budget_cost_filter" {
  description = "Filtre d'étiquette qui délimite la dépense mesurée par le budget. À comparer aux `default_tags` de providers.tf quand un budget reste obstinément à zéro : c'est presque toujours une ressource non étiquetée."
  value       = module.budgets.budget_cost_filter
}

output "budget_alerts_topic_arn" {
  description = "Topic SNS qui porte les alertes budgétaires. C'est là que s'abonne tout destinataire supplémentaire, et c'est le topic à réemployer pour les alarmes CloudWatch plutôt que d'en créer un second."
  value       = module.budgets.alerts_topic_arn
}

output "budget_alert_email_subscription_arns" {
  description = "ARN des abonnements par courriel aux alertes budgétaires, par adresse. Un ARN valant `pending confirmation` désigne un destinataire qui n'a pas confirmé son abonnement — il ne recevra rien."
  value       = module.budgets.alert_email_subscription_arns
}

output "log_retention_days" {
  description = "Rétention des journaux CloudWatch de l'environnement, en jours. Contrat passé explicitement à chaque module qui crée un groupe de journaux — 30 jours hors production, 90 en production (skill aws-infra §8)."
  value       = local.log_retention_days
}
