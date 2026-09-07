output "instance_id" {
  description = "Identifiant de l'instance RDS — `spa-{env}-rds`."
  value       = aws_db_instance.this.id
}

output "instance_arn" {
  description = "ARN de l'instance, à cibler dans une politique IAM, une alarme CloudWatch ou une sélection AWS Backup."
  value       = aws_db_instance.this.arn
}

output "resource_id" {
  description = "Identifiant de ressource — `db-XXXX…`, stable même si l'instance est renommée. C'est cette forme, et non l'identifiant, qu'attend l'ARN d'une politique d'authentification IAM et que porte un point de restauration AWS Backup."
  value       = aws_db_instance.this.resource_id
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

output "instance_class" {
  description = "Classe d'instance effectivement provisionnée. C'est elle qui détermine le `max_connections` du moteur — que RDS calcule à partir de la mémoire et n'expose par aucune métrique : la changer oblige à revoir le seuil de l'alarme de saturation des connexions (module `observability`)."
  value       = aws_db_instance.this.instance_class
}

output "allocated_storage" {
  description = "Stockage provisionné, en gibioctets. Base du seuil de l'alarme d'espace disque libre — `FreeStorageSpace` est en octets, le critère du CDC en pourcentage, et la conversion a besoin de cette valeur."
  value       = aws_db_instance.this.allocated_storage
}

output "max_allocated_storage" {
  description = "Plafond de l'extension automatique du stockage, en gibioctets. `0` = extension désactivée, auquel cas une base pleine cesse d'accepter les écritures au lieu de grandir."
  value       = aws_db_instance.this.max_allocated_storage
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

# --- Reprise d'activité (CDC §4.14) -------------------------------------------
#
# Ces trois sorties existent pour la vérification préalable du runbook de
# restauration : elles disent, sans ouvrir la console AWS et sans lire le code du
# module, jusqu'où la base peut être ramenée en arrière et ce qui se passe à la
# perte d'une zone. Voir docs/runbooks/pra-restauration-rds.md.

output "backup_retention_period" {
  description = "Rétention des sauvegardes automatiques, en jours. C'est **elle** qui borne la restauration à un instant donné : au-delà, il ne reste que les instantanés manuels et le coffre AWS Backup. Zéro désactiverait la restauration à un instant donné — la validation de la variable l'interdit."
  value       = aws_db_instance.this.backup_retention_period
}

output "multi_az" {
  description = "Vrai quand une instance de secours veille dans une seconde zone. C'est ce qui fait la différence entre une bascule automatique de quelques minutes et une restauration complète en cas de panne de zone (CDC §4.14)."
  value       = aws_db_instance.this.multi_az
}

output "availability_zone" {
  description = "Zone où siège l'instance primaire. À relever **avant** un incident : après une bascule, cette valeur a changé, et savoir d'où l'on est parti est ce qui permet de dire si la bascule a bien eu lieu."
  value       = aws_db_instance.this.availability_zone
}
