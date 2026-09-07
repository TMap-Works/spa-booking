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

output "notification_sms_publisher_policy_arn" {
  description = "Politique IAM du droit d'émettre un SMS, à attacher au rôle de tâche de l'API quand cet environnement composera `ecs-service`. Elle n'accorde aucun droit sur les réglages SMS du compte — plafond de dépense compris — que seule la production détient (#66)."
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
