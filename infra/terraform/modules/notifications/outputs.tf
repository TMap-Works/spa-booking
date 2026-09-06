# --- Identité -----------------------------------------------------------------

output "domain" {
  description = "Domaine d'envoi vérifié — celui qui apparaît à droite du `@` dans l'en-tête `From`."
  value       = aws_sesv2_email_identity.this.email_identity
}

output "domain_identity_arn" {
  description = "ARN de l'identité de domaine SES. C'est la ressource à nommer dans la politique du rôle qui appellera `SendEmail` — la Lambda d'envoi de #67."
  value       = aws_sesv2_email_identity.this.arn
}

output "verified_for_sending_status" {
  description = <<-EOT
    Vrai quand SES a lu les enregistrements DKIM et considère le domaine comme
    vérifié. **Faux juste après le premier `apply`**, c'est normal : la
    vérification est asynchrone et dépend de la propagation DNS.

    Faux durablement, en revanche, veut dire que les enregistrements ne sont pas
    publiés ou pas résolus — comparer `dns_records` à ce que rend un `dig`.
  EOT
  value       = aws_sesv2_email_identity.this.verified_for_sending_status
}

output "dkim_tokens" {
  description = "Les trois jetons Easy DKIM. Ils composent le nom et la valeur des CNAME de signature ; `dns_records` les donne déjà sous leur forme publiable."
  value       = local.dkim_tokens
}

output "mail_from_domain" {
  description = "Domaine d'enveloppe personnalisé — le `MAIL FROM` vu par le serveur destinataire, et le domaine sur lequel SPF est évalué."
  value       = aws_sesv2_email_identity_mail_from_attributes.this.mail_from_domain
}

# --- DNS ----------------------------------------------------------------------

output "dns_managed" {
  description = "Vrai quand le module publie lui-même les enregistrements dans Route 53. Faux, il ne reste plus qu'à publier `dns_records` chez le registraire — sans quoi rien ne part."
  value       = local.manage_dns
}

output "dns_records" {
  description = <<-EOT
    Enregistrements DNS que la délivrabilité exige, chacun avec son nom, son type,
    sa valeur et ce à quoi il sert. Quand `dns_managed` vaut vrai, ce sont ceux
    que le module vient de poser — la liste sert alors à vérifier. Quand il vaut
    faux, c'est la consigne exacte à donner au registraire.

    `terraform output -json dns_records` en donne une forme directement
    exploitable.
  EOT
  value       = local.dns_records
}

output "dmarc_record_value" {
  description = "Valeur de l'enregistrement TXT `_dmarc`, telle qu'elle est publiée. À relire après tout resserrement de la politique — c'est la seule ligne dont une erreur de syntaxe fait disparaître les messages sans les faire échouer."
  value       = local.dmarc_record_value
}

# --- Jeu de configuration et événements ---------------------------------------

output "configuration_set_name" {
  description = "Nom du jeu de configuration. À passer en `ConfigurationSetName` de chaque `SendEmail` — l'identité le porte déjà par défaut, mais le nommer explicitement rend l'envoi indépendant de ce réglage."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "configuration_set_arn" {
  description = "ARN du jeu de configuration, pour les politiques IAM qui restreignent l'envoi à ce jeu-là."
  value       = aws_sesv2_configuration_set.this.arn
}

output "events_topic_arn" {
  description = "Topic SNS des rebonds, plaintes, refus et échecs de rendu. C'est le point d'entrée du traitement applicatif des rebonds (#73) : il s'y abonne par une file SQS plutôt que par HTTP, pour ne pas perdre un événement quand l'API redémarre."
  value       = aws_sns_topic.events.arn
}

output "events_topic_name" {
  description = "Nom du topic des événements de remise."
  value       = aws_sns_topic.events.name
}

output "event_types" {
  description = "Types d'événements effectivement publiés vers le topic. Un rebond absent du tableau de bord commence par se vérifier ici."
  value       = var.event_types
}

output "kms_key_arn" {
  description = "Clé KMS qui chiffre le topic d'événements et les deux files de la chaîne d'envoi. Tout consommateur — file SQS, Lambda — doit obtenir `kms:Decrypt` sur cette clé, sans quoi il recevra des messages qu'il ne saura pas lire."
  value       = local.kms_key_arn
}

# --- File de découplage -------------------------------------------------------

output "dispatch_queue_url" {
  description = "URL de la file de découplage. C'est la valeur à donner au producteur — `NOTIFICATION_QUEUE_URL` sur le conteneur de l'API, cible de la règle EventBridge du rappel J-1."
  value       = aws_sqs_queue.dispatch.url
}

output "dispatch_queue_arn" {
  description = "ARN de la file de découplage, pour les politiques qui la nomment."
  value       = aws_sqs_queue.dispatch.arn
}

output "dispatch_queue_name" {
  description = "Nom de la file de découplage — la dimension `QueueName` des métriques CloudWatch de SQS."
  value       = aws_sqs_queue.dispatch.name
}

output "dispatch_dlq_url" {
  description = "URL de la file d'attente morte. C'est d'ici que se rejouent les messages une fois la panne corrigée — `aws sqs start-message-move-task`, voir le README."
  value       = aws_sqs_queue.dispatch_dlq.url
}

output "dispatch_dlq_arn" {
  description = "ARN de la file d'attente morte."
  value       = aws_sqs_queue.dispatch_dlq.arn
}

output "dispatch_dlq_name" {
  description = "Nom de la file d'attente morte — la dimension `QueueName` de l'alarme de profondeur."
  value       = aws_sqs_queue.dispatch_dlq.name
}

output "dispatch_producer_policy_arn" {
  description = <<-EOT
    Politique IAM à attacher à tout rôle qui **publie** sur la file : le rôle de
    tâche de l'API (`task_role_policy_arns` du module `ecs-service`), puis le rôle
    qu'EventBridge Scheduler endossera pour le rappel J-1.

    Elle accorde `SendMessage` et le chiffrement, jamais `ReceiveMessage` : un
    producteur qui pourrait dépiler pourrait faire disparaître un rappel.
  EOT
  value       = aws_iam_policy.dispatch_producer.arn
}

output "dispatch_max_receive_count" {
  description = "Nombre de réceptions au bout desquelles un message part en DLQ. Le seul compteur de reprise de la chaîne — la Lambda n'en tient aucun."
  value       = var.dispatch_max_receive_count
}

# --- Lambda d'envoi -----------------------------------------------------------

output "dispatcher_function_name" {
  description = "Nom de la Lambda d'envoi — la dimension `FunctionName` de ses métriques, et le nom à donner à `aws logs tail`."
  value       = aws_lambda_function.dispatcher.function_name
}

output "dispatcher_function_arn" {
  description = "ARN de la Lambda d'envoi."
  value       = aws_lambda_function.dispatcher.arn
}

output "dispatcher_role_arn" {
  description = "ARN du rôle d'exécution de la Lambda d'envoi. C'est le principal à autoriser sur toute ressource que la fonction devra joindre plus tard."
  value       = aws_iam_role.dispatcher.arn
}

output "dispatcher_log_group_name" {
  description = "Groupe de journaux de la Lambda d'envoi. Les événements structurés y portent `notification.sent`, `notification.skipped`, `notification.permanent_failure` et `notification.rejected`."
  value       = aws_cloudwatch_log_group.dispatcher.name
}

output "dispatch_configured" {
  description = "Vrai quand `dispatch_url` est renseignée. Faux, la fonction est en défaut fermé : elle rend chaque message à SQS, la file vieillit et la DLQ finit par se remplir — ce qui est le comportement voulu, mais qu'il vaut mieux savoir avant de chercher la panne ailleurs."
  value       = var.dispatch_url != null
}

# --- Supervision --------------------------------------------------------------

output "alarm_names" {
  description = "Les quatre alarmes de la chaîne, dans l'ordre où elles se déclenchent quand la chaîne se dégrade : refus définitifs, retard, plantage, bout de course."
  value = {
    permanent_failures = aws_cloudwatch_metric_alarm.permanent_failures.alarm_name
    backlog_age        = aws_cloudwatch_metric_alarm.backlog_age.alarm_name
    dispatcher_errors  = aws_cloudwatch_metric_alarm.dispatcher_errors.alarm_name
    dlq_depth          = aws_cloudwatch_metric_alarm.dlq_depth.alarm_name
  }
}

output "alarms_notify" {
  description = "Vrai quand au moins un topic SNS est branché sur les alarmes. Faux, elles changent d'état sans prévenir personne — un tableau de bord, pas une supervision."
  value       = length(var.alarm_topic_arns) > 0
}

output "dashboard_name" {
  description = "Nom du tableau de bord CloudWatch de la chaîne, ou `null` si `create_dashboard` vaut faux."
  value       = one(aws_cloudwatch_dashboard.notifications[*].dashboard_name)
}

output "metric_namespace" {
  description = "Espace de noms des métriques publiées par la Lambda au format EMF."
  value       = var.metric_namespace
}
