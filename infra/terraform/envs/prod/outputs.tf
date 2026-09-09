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

output "nat_gateway_count" {
  description = "Nombre de NAT Gateway — **deux** en production, une par zone (CDC §4.15). Avec une seule, la perte de sa zone couperait la sortie Internet des deux zones applicatives, donc Stripe, SES et SNS."
  value       = length(module.network.nat_gateway_public_ips)
}

# --- Registre d'images --------------------------------------------------------

output "ecr_repository_urls" {
  description = "URL des dépôts ECR, par application. C'est ce que `deploy-production.yml` étiquette et pousse."
  value       = module.ecr.repository_urls
}

output "api_image" {
  description = "Image que la définition de tâche de l'API désigne actuellement — dépôt et étiquette. C'est la valeur à reprendre en `-var image_tag` avant tout `terraform apply` lancé à la main, faute de quoi les services reviendraient à l'étiquette d'amorçage."
  value       = local.api_image
}

output "web_image" {
  description = "Image que la définition de tâche du front désigne actuellement. Même étiquette que `api_image` — les deux images sortent du même commit."
  value       = local.web_image
}

# --- Point d'entrée public ----------------------------------------------------

output "app_url" {
  description = "Origine publique de la production — celle qu'une cliente tape, et la valeur à poser en variable de dépôt `APP_URL`. C'est l'URL de la **distribution CloudFront** dès qu'un domaine est fourni, et celle de l'ALB sinon."
  value       = module.ecs_service.public_base_url
}

output "alb_dns_name" {
  description = "Nom DNS de l'ALB. Ce n'est **pas** l'entrée publique : le public passe par CloudFront. C'est l'adresse de secours, celle qu'on vise pour court-circuiter la distribution pendant un incident — au prix de contourner la Web ACL de bord."
  value       = module.ecs_service.alb_dns_name
}

output "cloudfront_domain_name" {
  description = "Nom `*.cloudfront.net` de la distribution, ou `null` tant qu'elle n'est pas composée. C'est la cible des alias DNS publics."
  value       = one(module.cdn[*].distribution_domain_name)
}

output "cloudfront_distribution_id" {
  description = "Identifiant de la distribution — celui qu'attend `aws cloudfront create-invalidation --distribution-id`, et la dimension CloudWatch `DistributionId`."
  value       = one(module.cdn[*].distribution_id)
}

output "cloudfront_origin_domain_name" {
  description = "Nom par lequel CloudFront joint l'ALB. Le certificat du listener 443 **doit** le couvrir : c'est la première chose à vérifier devant un `502` rendu par CloudFront alors que l'ALB est sain et ses journaux vides."
  value       = one(module.cdn[*].origin_domain_name)
}

output "cloudfront_cached_path_patterns" {
  description = "Les seuls chemins servis depuis le cache de bord. Tout le reste va à l'origine à chaque requête, et c'est voulu : une page de disponibilités mise en cache serait servie à la visiteuse suivante, établissement compris."
  value       = one(module.cdn[*].cached_path_patterns)
}

output "cdn_enabled" {
  description = "Vrai quand la distribution CloudFront est composée. Faux, l'ALB est la seule frontière publique — état d'amorçage, pas état d'exploitation : il manque alors le nom de domaine et la zone Route 53."
  value       = local.cdn_enabled
}

# --- Certificats (CDC §4.9) ---------------------------------------------------

output "tls_certificate_is_self_signed" {
  description = "Vrai tant que l'ALB porte le certificat auto-signé de repli. Dans cet état, ni les Server Components du front, ni les trois Lambda de notification ne peuvent joindre l'API : toutes refusent un certificat non vérifiable. C'est un bloquant de mise en production, pas une nuance."
  value       = var.certificate_arn == null && !local.cdn_enabled
}

output "certificate_alb_arn" {
  description = "Certificat porté par le listener 443, quelle que soit sa provenance — module `certificate`, ARN fourni, ou repli auto-signé."
  value       = local.alb_certificate_arn
}

output "certificate_edge_arn" {
  description = "Certificat porté par la distribution CloudFront, dans `us-east-1`. `null` tant que le CDN n'est pas composé."
  value       = local.edge_certificate_arn
}

output "certificates_auto_renew" {
  description = <<-EOT
    Vrai quand **les deux** certificats sont émis et renouvelés par le module
    `certificate` sur une zone Route 53 gérée par cet état — donc quand le
    renouvellement automatique du CDC §4.9 est réellement acquis.

    Faux dans trois cas, qui ne se valent pas : le CDN n'est pas composé (rien
    n'est certifié), ou un ARN a été fourni de l'extérieur (le renouvellement est
    la responsabilité de qui l'a émis), ou la zone n'est pas dans Route 53 (les
    CNAME de validation sont posés à la main, et **les retirer casserait le
    renouvellement un an plus tard sans alerte**).
  EOT
  value = alltrue(concat(
    module.certificate_alb[*].dns_validation_automated,
    module.certificate_edge[*].dns_validation_automated,
  )) && var.certificate_arn == null && var.edge_certificate_arn == null && local.cdn_enabled
}

output "certificate_renewal_eligibility" {
  description = "Verdict d'ACM lui-même sur chacun des deux certificats — `ELIGIBLE` quand il sait le renouveler seul. C'est la valeur à relire après toute intervention sur la zone DNS, et la seule preuve qui ne dépende pas de ce que le code croit."
  value = {
    alb  = one(module.certificate_alb[*].renewal_eligibility)
    edge = one(module.certificate_edge[*].renewal_eligibility)
  }
}

output "certificate_validation_records" {
  description = "Enregistrements CNAME de validation des deux certificats. Publiés par le module quand la zone lui est confiée ; à publier chez le registraire sinon — **et à ne jamais retirer** : ils conditionnent chaque renouvellement, pas seulement la première émission."
  value = {
    alb  = one(module.certificate_alb[*].validation_records)
    edge = one(module.certificate_edge[*].validation_records)
  }
}

# --- Compute ------------------------------------------------------------------

output "ecs_cluster_name" {
  description = "Nom du cluster ECS — celui que `deploy-production.yml` passe en `--cluster`."
  value       = module.ecs_service.cluster_name
}

output "ecs_service_names" {
  description = "Nom du service ECS, par application. Ce sont les noms que `deploy-production.yml` passe en `--services`."
  value       = module.ecs_service.service_names
}

output "ecs_autoscaling_capacity" {
  description = "Bornes d'auto-scaling par service — **2 à 8 tâches** en production (CDC §4.15, troisième critère de #77). Le minimum à deux n'est pas décoratif : à une seule tâche, chaque déploiement et chaque panne de zone serait une coupure."
  value = {
    for name, service in local.service_capacity : name => service
  }
}

output "migrate_task_definition_family" {
  description = "Famille de la définition de tâche de migration, jouée avant chaque déploiement. Le rôle OIDC n'autorise `ecs:RunTask` que sur cette famille."
  value       = aws_ecs_task_definition.migrate.family
}

output "off_hours_shutdown_enabled" {
  description = "Faux, et il doit le rester : la production ne s'arrête pas la nuit. Rendu explicitement parce qu'un `true` ici serait une panne quotidienne programmée que rien d'autre ne signalerait."
  value       = module.ecs_service.off_hours_shutdown_enabled
}

# --- Configuration d'exécution ------------------------------------------------

output "api_runtime_secret_arn" {
  description = "ARN du secret Secrets Manager portant les variables d'exécution de l'API. Terraform en crée le conteneur ; sa valeur est déposée hors Terraform (voir le README de envs/dev, qui vaut mot pour mot ici — `APP_URL` et `API_URL` valant ici l'origine CloudFront)."
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

output "database_instance_class" {
  description = "Classe d'instance réellement provisionnée. À confronter à `observability_rds_connections_threshold` : le maximum de connexions du moteur dépend de la mémoire de l'instance, et le seuil de l'alarme est saisi à la main dans main.tf."
  value       = module.database.instance_class
}

output "redis_primary_endpoint" {
  description = "Nom d'hôte du nœud primaire Redis, à composer dans la clé REDIS_URL du secret d'exécution — en `rediss://`, le chiffrement en transit étant activé."
  value       = module.cache.primary_endpoint_address
}

output "redis_reader_endpoint" {
  description = "Point d'accès de lecture du groupe de réplication. Il n'existe que parce qu'un réplica existe — et le réplica est là pour la bascule, pas pour répartir la lecture."
  value       = module.cache.reader_endpoint_address
}

output "redis_auth_token_secret_arn" {
  description = "ARN du secret portant le jeton AUTH Redis, à reprendre dans REDIS_URL."
  value       = module.cache.auth_token_secret_arn
}

# --- Délivrabilité e-mail -----------------------------------------------------

# Toutes nulles tant que `notification_domain` n'est pas fourni : le module n'est
# alors pas composé. `one()` plutôt que `[0]` — l'index n'existe pas dans ce cas,
# et `terraform output` échouerait au lieu de rendre `null`. Sur la production,
# une valeur nulle ici est en soi le constat qu'aucune notification ne peut
# partir : c'est la première chose à regarder avant un go-live (#83).

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
  description = "Rétention des journaux CloudWatch de l'environnement, en jours. Contrat à passer à chaque module qui crée un groupe de journaux — 30 jours hors production, 90 en production (skill aws-infra §8)."
  value       = local.log_retention_days
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
  description = "`ENABLED` quand la chaîne du rappel J-1 est branchée, `DISABLED` tant que `notification_reminder_sweep_url` est nulle. En production, un `DISABLED` est une anomalie : le rappel J-1 est ce qui réduit le no-show (CDC §1.4)."
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
  description = "Vrai quand `notification_delivery_events_url` est renseignée. Faux en production est une anomalie à traiter avant le go-live : les rebonds s'accumulent en DLQ, aucune adresse morte n'est supprimée, et la réputation d'envoi du domaine — partagée par tous les établissements — se dégrade sans que rien d'autre ne le dise."
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

# --- Canal SMS (#66) ----------------------------------------------------------

# La production est le seul environnement qui **détient** ces réglages : SNS n'a
# qu'un jeu de préférences SMS par compte et par région. Dev et staging en
# héritent, et leurs sorties homonymes n'existent pas.

output "notification_sms_default_type" {
  description = "Type de message SMS posé sur le compte. Doit valoir `Transactional` : `Promotional` est routé en priorité basse et refusé par certains opérateurs sur un contenu transactionnel — un rappel classé promotionnel se perd sans erreur."
  value       = one(module.notifications[*].sms_default_type)
}

output "notification_sms_monthly_spend_limit_usd" {
  description = "Plafond de dépense SMS du mois civil, en dollars, tel qu'AWS l'enregistre. **Arrêt dur** : au plafond, SNS refuse la publication et les rappels J-1 s'arrêtent sans erreur applicative."
  value       = one(module.notifications[*].sms_monthly_spend_limit_usd)
}

output "notification_sms_spend_alarm_name" {
  description = "Alarme de dépense SMS, sur `AWS/SNS`/`SMSMonthToDateSpentUSD`. Une métrique de compte, donc une seule alarme pour les trois environnements — c'est pourquoi elle n'existe qu'ici."
  value       = one(module.notifications[*].sms_spend_alarm_name)
}

output "notification_sms_spend_alarm_threshold_usd" {
  description = "Dépense, en dollars, à partir de laquelle l'alarme se déclenche — 80 % du plafond par défaut. Déduite du plafond et non réglée à part : un seuil ne peut pas passer au-dessus de ce qu'il surveille."
  value       = one(module.notifications[*].sms_spend_alarm_threshold_usd)
}

output "notification_sms_sender_id" {
  description = "Nom d'expéditeur posé sur le compte, ou `null`. Le poser ne l'enregistre nulle part — voir `notification_sms_sender_id_registration`."
  value       = one(module.notifications[*].sms_sender_id)
}

output "notification_sms_sender_id_registration" {
  description = <<-EOT
    Démarches d'enregistrement d'expéditeur restant à mener, pays par pays.
    Chaque entrée porte `pays`, `statut` et `exigence`.

    Aucune ressource Terraform ne couvre cet enregistrement, chez aucun
    fournisseur : c'est un dossier instruit par un humain, au même titre que la
    sortie du bac à sable SES. Un `statut` valant `a-verifier` ou `a-reconfirmer`
    n'est pas un critère de go-live coché.
  EOT
  value       = one(module.notifications[*].sms_sender_id_registration)
}

output "notification_sms_publisher_policy_arn" {
  description = "Politique IAM du droit d'émettre un SMS, à attacher au rôle de tâche de l'API. Elle n'accorde aucun droit sur les réglages SMS du compte : une application capable de relever son propre plafond rendrait le plafond décoratif."
  value       = one(module.notifications[*].sms_publisher_policy_arn)
}

# --- Supervision (#78) --------------------------------------------------------

output "observability_alarm_names" {
  description = "Alarmes CloudWatch de l'environnement, dans l'ordre où elles se lisent : entrée publique, calcul, données. C'est la liste à confronter au tableau du CDC §4.11 avant le go-live — sans elles, la plateforme apprend ses pannes par ses clientes."
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
  description = "Services dont la tâche porte le sidecar `aws-xray-daemon` et dont le rôle peut publier ses segments."
  value       = module.ecs_service.xray_traced_services
}

output "xray_sampling_rule_name" {
  description = "Règle d'échantillonnage X-Ray de l'environnement. Elle filtre sur `spa-prod-*` : les trois environnements partagent un compte, donc un jeu de règles."
  value       = module.observability.xray_sampling_rule_name
}

# --- Pare-feu applicatif (#79, CDC §4.10) -------------------------------------

# Deux Web ACL — celle de bord, sur la distribution, et celle de région, sur
# l'ALB. Les deux sorties se lisent ensemble : le bord protège le chemin nominal,
# la région protège le chemin qui court-circuite le bord.

output "waf_web_acl_name" {
  description = "Nom de la Web ACL régionale, associée à l'ALB. C'est aussi la valeur de la dimension CloudWatch `WebACL` — celle à donner à `aws wafv2 get-sampled-requests` pour voir ce qui a été bloqué."
  value       = module.waf.web_acl_name
}

output "waf_protects_anything" {
  description = "Faux si la Web ACL régionale n'est associée à aucune ressource : elle existe alors, ses règles sont là, ses métriques sont à zéro — ce qui ressemble à du calme et n'est qu'un pare-feu débranché."
  value       = module.waf.protects_anything
}

output "waf_blocking_rule_groups" {
  description = "Groupes de règles managés en mode blocage sur l'ALB. Ceux qui n'y figurent pas comptent sans bloquer."
  value       = module.waf.blocking_rule_groups
}

output "waf_counting_rule_groups" {
  description = "Groupes de règles managés en observation sur l'ALB. La métrique `CountedRequests` de chacun dit ce qu'il aurait bloqué : c'est elle qu'il faut lire avant de le faire passer en blocage."
  value       = module.waf.counting_rule_groups
}

output "waf_log_group_name" {
  description = "Groupe de journaux où atterrissent les décisions du WAF régional. C'est là qu'on lit quelle règle a bloqué quelle requête — la première chose à ouvrir quand un parcours échoue sans erreur applicative."
  value       = module.waf.log_group_name
}

output "waf_edge_web_acl_name" {
  description = "Nom de la Web ACL de bord, portée `CLOUDFRONT`, dans `us-east-1` — `spa-prod-edge-waf`. Le suffixe la distingue de la Web ACL régionale, dont le nom serait sinon identique. `null` tant que la distribution n'est pas composée."
  value       = one(module.waf_edge[*].web_acl_name)
}

output "waf_edge_log_group_name" {
  description = "Groupe de journaux du WAF de bord, **dans `us-east-1`** et non dans la région de l'environnement. Le chercher dans `eu-west-3` est la première fausse piste d'un incident de bord — et le nom diffère de celui du WAF régional, précisément pour qu'on s'en aperçoive."
  value       = one(module.waf_edge[*].log_group_name)
}

output "waf_edge_counting_rule_groups" {
  description = "Groupes de règles managés en observation au bord. Bot Control y figure délibérément : il est le plus intrusif des cinq, et un faux positif sur un tunnel de réservation coûte une réservation. Le passer en blocage se décide après lecture de sa métrique `CountedRequests`, pas avant."
  value       = one(module.waf_edge[*].counting_rule_groups)
}

output "waf_edge_alerts_topic_arn" {
  description = "Topic SNS de `us-east-1` qui porte les alarmes du WAF de bord. Il existe parce qu'une alarme CloudWatch ne notifie qu'un topic de sa propre région : celui du module `budgets` vit dans la région de l'environnement, et ne pourrait pas recevoir ces deux alarmes-là."
  value       = one(aws_sns_topic.edge_alerts[*].arn)
}

output "cloudfront_protected_by_waf" {
  description = "Vrai quand une Web ACL de bord est associée à la distribution. C'est la lecture directe du deuxième critère de #77 et du CDC §4.10 — le pare-feu « en amont de CloudFront/ALB »."
  value       = one(module.cdn[*].protected_by_waf)
}

# --- Sauvegarde et reprise d'activité (#82) -----------------------------------
#
# Les valeurs que la vérification préalable du runbook de restauration lit avant
# de commencer — `terraform output` plutôt que la console AWS, pour que le relevé
# de l'exercice soit reproductible. Voir docs/runbooks/pra-restauration-rds.md.

output "rds_backup_retention_period" {
  description = "Rétention des sauvegardes automatiques RDS, en jours. Borne de la restauration à un instant donné : au-delà, il ne reste que le coffre AWS Backup."
  value       = module.database.backup_retention_period
}

output "rds_multi_az" {
  description = "**Le premier critère de #77.** Vrai quand une instance de secours veille dans la seconde zone et prend la main automatiquement. Une précondition du module refuse déjà un `prod` sans elle ; cette sortie le rend vérifiable sans lire le plan."
  value       = module.database.multi_az
}

output "rds_availability_zone" {
  description = "Zone de l'instance primaire. À relever avant l'incident : après une bascule, la valeur a changé, et c'est ce qui prouve que la bascule a eu lieu (docs/runbooks/pra-bascule-az.md)."
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
  description = "Rétentions effectivement posées, par cadence et en jours. Les quatre cadences existent en production, jusqu'au palier mensuel d'un an."
  value       = module.backup.retention_policy
}

output "backup_continuous_enabled" {
  description = "Vrai quand la sauvegarde continue est active dans le coffre — donc quand la restauration à un instant donné y est possible. C'est la seule règle qui tienne le RPO ≤ 1 h du CDC §4.14."
  value       = module.backup.continuous_backup_enabled
}

output "backup_vault_locked" {
  description = "Vrai quand le verrou de gouvernance est posé : plus personne ne raccourcit une rétention ni ne supprime un point avant son terme sans lever le verrou d'abord."
  value       = module.backup.vault_locked
}

output "backup_protects_anything" {
  description = "Faux si le plan n'a aucune sélection : coffre et plan existent, règles posées, et rien n'est sauvegardé. Une précondition du module refuse cet état en production."
  value       = module.backup.protects_anything
}

output "backup_alarms_notify" {
  description = "Vrai quand les alarmes du coffre sont branchées sur un topic SNS. Faux, elles passent au rouge sans prévenir personne — et « aucune sauvegarde depuis vingt-quatre heures » ne se découvre pas en regardant une console."
  value       = module.backup.alarms_notify
}

# --- Export du reporting (#563) -----------------------------------------------

output "reporting_export_bucket" {
  description = "Bucket qui reçoit les exports CSV du back-office. C'est la valeur posée dans `REPORT_EXPORT_BUCKET` sur la tâche de l'API ; sans elle, la route d'export répond 503."
  value       = module.reporting_export.bucket_name
}

output "reporting_export_retention_days" {
  description = "Nombre de jours au bout desquels un export est supprimé par le cycle de vie du bucket. Trente en production : un export de chiffre d'affaires se rouvre à la clôture du mois suivant."
  value       = module.reporting_export.retention_days
}

output "reporting_export_encryption" {
  description = "Chiffrement au repos effectivement appliqué au bucket d'exports — `AES256` sans clé client, `aws:kms` avec. Dans les deux cas, le bucket est chiffré."
  value       = module.reporting_export.encryption_algorithm
}

# --- Liste de vérification de la mise en production ---------------------------

output "go_live_blockers" {
  description = <<-EOT
    Ce qui empêche encore cette production de servir des clientes, en clair.

    Une liste vide n'est pas une autorisation de mise en production — la recette
    et la décision métier restent entières —, mais une liste non vide est un
    refus : chaque entrée décrit un état où quelque chose ne fonctionne pas, et
    non un réglage perfectible.

    C'est la première commande de docs/runbooks/mise-en-production.md, et elle se
    lit avant le premier déploiement comme avant chacun des suivants.
  EOT
  value = compact([
    local.cdn_enabled ? "" : "Aucun nom public : `public_domain_name` et `route53_zone_id` sont nuls. L'ALB porte un certificat auto-signé, aucune distribution CloudFront n'existe, et ni les Server Components du front ni les Lambda de notification ne peuvent joindre l'API — toutes refusent un certificat non vérifiable.",

    var.notification_domain == null ? "Aucun domaine d'envoi SES (`notification_domain`) : ni confirmation, ni rappel J-1, ni avis d'annulation ne part. Le module `notifications` n'est pas composé du tout (#83)." : "",

    var.notification_dispatch_url == null ? "`notification_dispatch_url` nulle : la Lambda d'envoi est en défaut fermé, la file vieillit et la DLQ se remplit. Rien ne part." : "",

    var.notification_delivery_events_url == null ? "`notification_delivery_events_url` nulle : les rebonds et les plaintes s'accumulent en DLQ, aucune adresse morte n'est supprimée, et la réputation d'envoi du domaine — partagée par tous les établissements — se dégrade sans que rien d'autre ne le dise (CDC §6)." : "",

    var.notification_reminder_sweep_url == null ? "`notification_reminder_sweep_url` nulle : le planning du rappel J-1 est désactivé. C'est la capacité qui réduit le no-show (CDC §1.4)." : "",

    length(var.budget_alert_emails) == 0 ? "`budget_alert_emails` vide : les alertes budgétaires et toutes les alarmes CloudWatch de l'environnement changent d'état sans prévenir personne." : "",

    var.rds_monitoring_role_arn == null ? "`rds_monitoring_role_arn` nul : Enhanced Monitoring est désactivé, et les métriques système de l'instance — dont l'`iowait` — n'existent pas. C'est ce qui distingue « la requête est mauvaise » de « le volume sature » un jour de lenteur." : "",
  ])
}
