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

output "vpc_flow_log_group_name" {
  description = "Groupe CloudWatch Logs des flow logs du VPC — trafic accepté et rejeté. C'est là qu'on cherche après un incident réseau."
  value       = module.network.flow_log_group_name
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

# --- Supervision (#78) --------------------------------------------------------

output "observability_alarm_names" {
  description = "Alarmes CloudWatch de l'environnement, dans l'ordre où elles se lisent : entrée publique, calcul, données. C'est la liste à confronter au tableau du CDC §4.11 avant un go-live."
  value       = module.observability.alarm_names
}

output "observability_alarms_notify" {
  description = "Vrai quand les alarmes sont branchées sur un topic SNS. Faux, elles changent d'état dans la console sans prévenir personne — ce qui est pire que pas d'alarme du tout, puisqu'on se croit couvert."
  value       = module.observability.alarms_notify
}

output "observability_rds_connections_threshold" {
  description = "Nombre de connexions à partir duquel l'alarme se déclenche. À revérifier après tout changement de `instance_class` : le maximum du moteur dépend de la mémoire de l'instance, et il est saisi à la main dans main.tf faute d'être exposé par une métrique."
  value       = module.observability.rds_connections_threshold
}

output "observability_dashboard_name" {
  description = "Tableau de bord transverse de l'environnement — trafic et 5xx de l'ALB, latence, CPU et mémoire des services, connexions et espace disque de la base."
  value       = module.observability.dashboard_name
}

output "xray_traced_services" {
  description = "Services dont la tâche porte le sidecar `aws-xray-daemon` et dont le rôle peut publier ses segments. Le code de l'API n'ouvrant pas encore de segment, la console X-Ray reste vide : c'est attendu, pas une panne d'infrastructure."
  value       = module.ecs_service.xray_traced_services
}

output "xray_sampling_rule_name" {
  description = "Règle d'échantillonnage X-Ray de l'environnement. Elle filtre sur `spa-dev-*` : les trois environnements partagent un compte, donc un jeu de règles."
  value       = module.observability.xray_sampling_rule_name
}

# --- Chaîne d'envoi des notifications (#67) -----------------------------------

# Toutes nulles tant que `notification_domain` n'est pas fourni : le module n'est
# alors pas composé, et il n'y a ni file, ni Lambda, ni alarme.

output "notification_dispatch_queue_url" {
  description = "File sur laquelle l'API publie au lieu d'appeler SES depuis le chemin de requête HTTP (CDC §4.8). C'est aussi la cible de la règle EventBridge du rappel J-1 (#71)."
  value       = one(module.notifications[*].dispatch_queue_url)
}

output "notification_dispatch_dlq_name" {
  description = "File d'attente morte de la chaîne d'envoi. Un message ici a épuisé ses tentatives : l'alarme de profondeur s'en déclenche, et c'est d'ici qu'on rejoue une fois la panne corrigée."
  value       = one(module.notifications[*].dispatch_dlq_name)
}

output "notification_dispatch_producer_policy_arn" {
  description = "Politique IAM du droit de publier sur la file — à attacher au rôle de tâche de l'API et, plus tard, au rôle d'EventBridge Scheduler. Elle n'accorde jamais `ReceiveMessage`."
  value       = one(module.notifications[*].dispatch_producer_policy_arn)
}

output "notification_sms_publisher_policy_arn" {
  description = "Politique IAM du droit d'émettre un SMS, déjà attachée au rôle de tâche de l'API. Elle n'accorde aucun droit sur les réglages SMS du compte — plafond de dépense compris — que seule la production détient (#66)."
  value       = one(module.notifications[*].sms_publisher_policy_arn)
}

output "notification_dispatcher_function_name" {
  description = "Lambda d'envoi. `aws logs tail /aws/lambda/<ce nom> --follow` montre les événements structurés `notification.sent`, `notification.skipped` et `notification.permanent_failure`."
  value       = one(module.notifications[*].dispatcher_function_name)
}

output "notification_dispatch_configured" {
  description = "Vrai quand la route d'envoi est renseignée. Faux, la Lambda est en **défaut fermé** : elle rend chaque message à SQS, la file vieillit et la DLQ finit par se remplir. À vérifier en premier quand rien ne part."
  value       = one(module.notifications[*].dispatch_configured)
}

output "notification_reminder_sweeper_function_name" {
  description = "Lambda de balayage du rappel J-1 (#71). `aws logs tail /aws/lambda/<ce nom> --follow` montre `reminder.swept`, `reminder.rejected`, `reminder.sweep_truncated` et `reminder.sweep_failed`."
  value       = one(module.notifications[*].reminder_sweeper_function_name)
}

output "notification_reminder_schedule_state" {
  description = "`ENABLED` quand la chaîne du rappel J-1 est branchée, `DISABLED` tant que `notification_reminder_sweep_url` est nulle. Un planning désactivé n'est pas une panne : c'est un environnement où il n'y a rien à rappeler."
  value       = one(module.notifications[*].reminder_schedule_state)
}

output "notification_reminder_sweep_configured" {
  description = "Vrai quand la route de balayage est renseignée. Faux, aucun rappel J-1 n'est produit — à vérifier en premier quand la file reste vide alors que des rendez-vous approchent."
  value       = one(module.notifications[*].reminder_sweep_configured)
}

# --- Rebonds et plaintes (#73) ------------------------------------------------

output "notification_delivery_events_function_name" {
  description = "Lambda de relais des rebonds et des plaintes. `aws logs tail /aws/lambda/<ce nom> --follow` montre `delivery.relayed`, `delivery.unconfigured` et `delivery.failed` — jamais une adresse de destinataire (CDC §5.1)."
  value       = one(module.notifications[*].delivery_events_function_name)
}

output "notification_delivery_events_queue_url" {
  description = "File sur laquelle SES dépose ses événements de remise, via le topic SNS. C'est la destination du rejeu de la DLQ des rebonds — `aws sqs start-message-move-task`."
  value       = one(module.notifications[*].delivery_events_queue_url)
}

output "notification_delivery_events_dlq_name" {
  description = "File d'attente morte de la chaîne des rebonds. Un événement ici ne sera plus rejoué : l'adresse qu'il désigne reste sollicitée, et c'est d'ici qu'on rejoue une fois le câblage posé."
  value       = one(module.notifications[*].delivery_events_dlq_name)
}

output "notification_delivery_events_configured" {
  description = "Vrai quand `notification_delivery_events_url` est renseignée. Faux, la Lambda est en **défaut fermé** : les rebonds s'accumulent dans la file puis en DLQ, aucune adresse morte n'est supprimée, et la réputation d'envoi du domaine se dégrade sans que rien d'autre ne le dise. À vérifier en premier quand la DLQ des événements de remise se remplit."
  value       = one(module.notifications[*].delivery_events_configured)
}

output "notification_alarm_names" {
  description = "Les huit alarmes de la chaîne, dans l'ordre du trajet d'un message : balayage jamais fait, balayage incomplet, refus définitifs, retard, plantage de l'envoi, bout de course — puis, sur le chemin de retour, plantage du traitement des rebonds et rebonds en bout de course."
  value       = one(module.notifications[*].alarm_names)
}

output "notification_alarms_notify" {
  description = "Vrai quand les alarmes de la chaîne sont branchées sur un topic SNS. Faux, elles changent d'état sans prévenir personne."
  value       = one(module.notifications[*].alarms_notify)
}

output "notification_dashboard_name" {
  description = "Tableau de bord CloudWatch de la chaîne d'envoi : issue des livraisons, profondeur et âge des files, invocations et durée de la Lambda."
  value       = one(module.notifications[*].dashboard_name)
}

# --- Pare-feu applicatif (#79) ------------------------------------------------

output "waf_web_acl_name" {
  description = "Nom de la Web ACL protégeant l'ALB. C'est aussi la valeur de la dimension CloudWatch `WebACL` — celle à donner à `aws wafv2 get-sampled-requests` pour voir ce qui a été bloqué."
  value       = module.waf.web_acl_name
}

output "waf_protects_anything" {
  description = "Faux si la Web ACL n'est associée à aucune ressource : elle existe alors, ses règles sont là, ses métriques sont à zéro — ce qui ressemble à du calme et n'est qu'un pare-feu débranché."
  value       = module.waf.protects_anything
}

output "waf_blocking_rule_groups" {
  description = "Groupes de règles managés en mode blocage. Ceux qui n'y figurent pas comptent sans bloquer."
  value       = module.waf.blocking_rule_groups
}

output "waf_counting_rule_groups" {
  description = "Groupes de règles managés en observation. La métrique `CountedRequests` de chacun dit ce qu'il aurait bloqué : c'est elle qu'il faut lire avant de le faire passer en blocage."
  value       = module.waf.counting_rule_groups
}

output "waf_log_group_name" {
  description = "Groupe de journaux où atterrissent les décisions du WAF. C'est là qu'on lit quelle règle a bloqué quelle requête."
  value       = module.waf.log_group_name
}

# --- Sauvegarde et reprise d'activité (#82) -----------------------------------
#
# Les neuf valeurs que la vérification préalable du runbook de restauration lit
# avant de commencer — `terraform output` plutôt que la console AWS, pour que le
# relevé de l'exercice soit reproductible. Voir docs/runbooks/pra-restauration-rds.md.

output "rds_backup_retention_period" {
  description = "Rétention des sauvegardes automatiques RDS, en jours. Borne de la restauration à un instant donné : au-delà, il ne reste que le coffre AWS Backup."
  value       = module.database.backup_retention_period
}

output "rds_multi_az" {
  description = "Vrai quand une instance de secours veille dans une seconde zone. Faux, la perte d'une zone se répare par une restauration et non par une bascule — voir docs/runbooks/pra-bascule-az.md."
  value       = module.database.multi_az
}

output "rds_availability_zone" {
  description = "Zone de l'instance primaire. À relever avant l'incident : après une bascule, la valeur a changé, et c'est ce qui prouve que la bascule a eu lieu."
  value       = module.database.availability_zone
}

output "backup_vault_name" {
  description = "Coffre AWS Backup. Première commande du runbook : `aws backup list-recovery-points-by-backup-vault --backup-vault-name <cette valeur>`."
  value       = module.backup.vault_name
}

output "backup_restore_role_arn" {
  description = "Rôle à passer à `aws backup start-restore-job --iam-role-arn`. Il porte les droits de restauration en plus de ceux de sauvegarde."
  value       = module.backup.role_arn
}

output "backup_retention_policy" {
  description = "Rétentions effectivement posées, par cadence et en jours. Une cadence absente n'a pas de règle dans le plan."
  value       = module.backup.retention_policy
}

output "backup_continuous_enabled" {
  description = "Vrai quand la sauvegarde continue est active dans le coffre — donc quand la restauration à un instant donné y est possible. C'est la seule règle qui tienne le RPO ≤ 1 h du CDC §4.14."
  value       = module.backup.continuous_backup_enabled
}

output "backup_protects_anything" {
  description = "Faux si le plan n'a aucune sélection : coffre et plan existent, règles posées, et rien n'est sauvegardé."
  value       = module.backup.protects_anything
}

output "backup_alarms_notify" {
  description = "Vrai quand les alarmes du coffre sont branchées sur un topic SNS. Faux, elles passent au rouge sans prévenir personne."
  value       = module.backup.alarms_notify
}

# --- Export du reporting (#563) -----------------------------------------------

output "reporting_export_bucket" {
  description = "Bucket qui reçoit les exports CSV du back-office. C'est la valeur posée dans `REPORT_EXPORT_BUCKET` sur la tâche de l'API ; sans elle, la route d'export répond 503."
  value       = module.reporting_export.bucket_name
}

output "reporting_export_retention_days" {
  description = "Nombre de jours au bout desquels un export est supprimé par le cycle de vie du bucket. Rendu pour être vérifiable sans ouvrir le module."
  value       = module.reporting_export.retention_days
}

output "reporting_export_encryption" {
  description = "Chiffrement au repos effectivement appliqué au bucket d'exports — `AES256` sans clé client, `aws:kms` avec. Dans les deux cas, le bucket est chiffré."
  value       = module.reporting_export.encryption_algorithm
}
