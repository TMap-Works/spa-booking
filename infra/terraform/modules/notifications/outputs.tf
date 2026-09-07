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

# --- Rappel J-1 ---------------------------------------------------------------

output "reminder_sweeper_function_name" {
  description = "Nom de la Lambda de balayage — la dimension `FunctionName` de ses métriques, et le nom à donner à `aws logs tail`."
  value       = aws_lambda_function.reminder_sweeper.function_name
}

output "reminder_sweeper_function_arn" {
  description = "ARN de la Lambda de balayage."
  value       = aws_lambda_function.reminder_sweeper.arn
}

output "reminder_sweeper_role_arn" {
  description = "ARN du rôle d'exécution de la Lambda de balayage. C'est lui qui porte la politique de production de la file — jamais celui du planning, qui ne fait qu'invoquer."
  value       = aws_iam_role.reminder_sweeper.arn
}

output "reminder_sweeper_log_group_name" {
  description = "Groupe de journaux du balayage. Les événements structurés y portent `reminder.swept`, `reminder.rejected`, `reminder.sweep_truncated` et `reminder.sweep_failed`."
  value       = aws_cloudwatch_log_group.reminder_sweeper.name
}

output "reminder_schedule_name" {
  description = "Nom du planning EventBridge Scheduler du rappel J-1."
  value       = aws_scheduler_schedule.reminder.name
}

output "reminder_schedule_expression" {
  description = "Expression de planification effectivement posée, évaluée en UTC. Sa période et la largeur de la fenêtre de sélection côté API sont la **même durée** : les faire diverger laisse des rendez-vous sans rappel."
  value       = aws_scheduler_schedule.reminder.schedule_expression
}

output "reminder_schedule_state" {
  description = "`ENABLED` quand la chaîne est branchée, `DISABLED` tant que `reminder_sweep_url` est nulle. Un planning désactivé n'est pas une panne : c'est un environnement où il n'y a rien à rappeler."
  value       = aws_scheduler_schedule.reminder.state
}

output "reminder_window_hours" {
  description = <<-EOT
    La fenêtre de sélection du rappel, en heures : `[+24 h, +25 h)`, bornes basse
    incluse et haute exclue, **en UTC**.

    Cette sortie ne configure rien — la fenêtre est écrite dans
    `apps/api/src/modules/notifications/reminder-window.ts`, où elle est testée.
    Elle est ici pour que l'écart se voie : la largeur de la fenêtre et la
    période de `reminder_schedule_expression` sont la même durée vue de deux
    côtés, et les faire diverger laisse des rendez-vous sans rappel (fenêtre plus
    étroite que la période) ou en sélectionne deux fois (fenêtre plus large).
  EOT
  value = {
    lead_hours  = 24
    width_hours = 1
  }
}

output "reminder_sweep_configured" {
  description = "Vrai quand `reminder_sweep_url` est renseignée. Faux, le planning est désactivé et aucun rappel n'est produit — ce qui est le comportement voulu sur un environnement non branché, mais qu'il vaut mieux savoir avant de chercher la panne ailleurs."
  value       = var.reminder_sweep_url != null
}

output "dispatch_configured" {
  description = "Vrai quand `dispatch_url` est renseignée. Faux, la fonction est en défaut fermé : elle rend chaque message à SQS, la file vieillit et la DLQ finit par se remplir — ce qui est le comportement voulu, mais qu'il vaut mieux savoir avant de chercher la panne ailleurs."
  value       = var.dispatch_url != null
}

# --- Rebonds et plaintes (#73) ------------------------------------------------

output "delivery_events_queue_url" {
  description = "URL de la file abonnée au topic d'événements de remise. Utile pour purger ou rejouer à la main pendant un incident de délivrabilité ; aucun producteur n'a à la connaître — c'est SNS qui dépose."
  value       = aws_sqs_queue.delivery_events.url
}

output "delivery_events_queue_arn" {
  description = "ARN de la file des événements de remise."
  value       = aws_sqs_queue.delivery_events.arn
}

output "delivery_events_queue_name" {
  description = "Nom de la file des événements de remise — la dimension `QueueName` des métriques SQS."
  value       = aws_sqs_queue.delivery_events.name
}

output "delivery_events_dlq_url" {
  description = "URL de la file d'attente morte des événements de remise. C'est là que se trouvent les rebonds qu'aucune adresse n'a suivis : les relire est le premier geste du diagnostic."
  value       = aws_sqs_queue.delivery_events_dlq.url
}

output "delivery_events_dlq_arn" {
  description = "ARN de la file d'attente morte des événements de remise."
  value       = aws_sqs_queue.delivery_events_dlq.arn
}

output "delivery_events_dlq_name" {
  description = "Nom de la file d'attente morte des événements de remise — la dimension `QueueName` de son alarme de profondeur."
  value       = aws_sqs_queue.delivery_events_dlq.name
}

output "delivery_events_function_name" {
  description = "Nom de la Lambda de traitement des rebonds — la dimension `FunctionName` de son alarme d'erreurs."
  value       = aws_lambda_function.delivery_events.function_name
}

output "delivery_events_function_arn" {
  description = "ARN de la Lambda de traitement des rebonds."
  value       = aws_lambda_function.delivery_events.arn
}

output "delivery_events_role_arn" {
  description = "ARN du rôle d'exécution de la Lambda de traitement des rebonds. Distinct de celui de la Lambda d'envoi : les deux ne consomment pas la même file, et un rôle partagé aurait donné à chacune l'accès à la file de l'autre."
  value       = aws_iam_role.delivery_events.arn
}

output "delivery_events_log_group_name" {
  description = "Groupe de journaux de la Lambda de traitement des rebonds. Il ne contient **aucune adresse** — la fonction ne journalise que des compteurs et l'accusé opaque de SES (CDC §5.1)."
  value       = aws_cloudwatch_log_group.delivery_events.name
}

output "delivery_events_configured" {
  description = "Vrai quand `delivery_events_url` est renseignée. Faux, la fonction est en défaut fermé : les rebonds s'accumulent dans la file puis en DLQ, aucune adresse morte n'est supprimée, et la réputation d'envoi du domaine se dégrade sans que rien d'autre ne le dise."
  value       = var.delivery_events_url != null
}

# --- Supervision --------------------------------------------------------------

output "alarm_names" {
  description = "Les huit alarmes de la chaîne, dans l'ordre du trajet d'un message : balayage jamais fait, balayage incomplet, refus définitifs, retard, plantage de l'envoi, bout de course — puis, sur le chemin de retour, plantage du traitement des rebonds et rebonds en bout de course."
  value = {
    reminder_sweeper_errors   = aws_cloudwatch_metric_alarm.reminder_sweeper_errors.alarm_name
    reminder_sweep_truncated  = aws_cloudwatch_metric_alarm.reminder_sweep_truncated.alarm_name
    permanent_failures        = aws_cloudwatch_metric_alarm.permanent_failures.alarm_name
    backlog_age               = aws_cloudwatch_metric_alarm.backlog_age.alarm_name
    dispatcher_errors         = aws_cloudwatch_metric_alarm.dispatcher_errors.alarm_name
    dlq_depth                 = aws_cloudwatch_metric_alarm.dlq_depth.alarm_name
    delivery_events_errors    = aws_cloudwatch_metric_alarm.delivery_events_errors.alarm_name
    delivery_events_dlq_depth = aws_cloudwatch_metric_alarm.delivery_events_dlq_depth.alarm_name
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

# --- Canal SMS ----------------------------------------------------------------

output "sms_publisher_policy_arn" {
  description = <<-EOT
    Politique IAM à attacher au rôle de tâche de l'API — `task_role_policy_arns`
    du module `ecs-service` — pour qu'elle puisse émettre un SMS.

    Elle accorde `sns:Publish` et **aucun droit sur les réglages SMS du compte** :
    une application capable de relever son propre plafond de dépense rendrait le
    plafond décoratif.

    Elle ne permet pas davantage de publier sur un **topic** du compte : le
    joker qu'exige l'envoi vers un numéro de téléphone est repris par un `Deny`
    explicite sur les ARN de topic (#79).
  EOT
  value       = aws_iam_policy.sms_publisher.arn
}

output "sms_account_preferences_managed" {
  description = <<-EOT
    Vrai quand cet environnement détient les préférences SMS du compte — type de
    message, plafond, sender ID — et l'alarme de dépense.

    Faux dans les autres : ils **héritent** du réglage, ils ne le posent pas.
    Deux environnements à vrai sur un même compte et une même région est une
    erreur de composition que Terraform ne signalera pas, chacun s'écrasant à son
    tour.
  EOT
  value       = var.manage_sms_account_preferences
}

output "sms_default_type" {
  description = "Type de message effectivement posé, ou `null` quand cet environnement ne détient pas le réglage. `Transactional` est le seul acceptable pour un rappel de rendez-vous : `Promotional` est routé en priorité basse, et refusé par certains opérateurs."
  value       = one(aws_sns_sms_preferences.this[*].default_sms_type)
}

output "sms_monthly_spend_limit_usd" {
  description = "Plafond de dépense mensuel effectivement posé, en dollars, ou `null` quand cet environnement ne détient pas le réglage. Rappel : c'est un arrêt dur, pas une alerte — au plafond, SNS cesse d'envoyer."
  value       = one(aws_sns_sms_preferences.this[*].monthly_spend_limit)
}

output "sms_spend_alarm_name" {
  description = "Nom de l'alarme de dépense SMS, ou `null` quand cet environnement ne détient pas le réglage. Elle porte sur `AWS/SNS`/`SMSMonthToDateSpentUSD`, une métrique **de compte** : c'est pourquoi elle n'existe qu'une fois."
  value       = one(aws_cloudwatch_metric_alarm.sms_spend[*].alarm_name)
}

output "sms_spend_alarm_threshold_usd" {
  description = "Dépense, en dollars, à partir de laquelle l'alarme se déclenche — le plafond multiplié par `sms_spend_alarm_threshold_percent`. Déduit et non réglé séparément, pour qu'un seuil ne puisse pas passer au-dessus du plafond qu'il surveille."
  value       = local.sms_spend_alarm_threshold_usd
}

output "sms_sender_id" {
  description = "Nom d'expéditeur posé sur le compte, ou `null`. Le poser ne l'enregistre nulle part : voir `sms_sender_id_registration`."
  value       = one(aws_sns_sms_preferences.this[*].default_sender_id)
}

output "sms_sender_id_registration" {
  description = <<-EOT
    Ce qui reste à faire, pays par pays, pour que le sender ID soit accepté.
    Chaque entrée porte `pays`, `statut` et `exigence`.

    Aucun fournisseur Terraform n'expose de ressource d'enregistrement de sender
    ID : c'est une démarche administrative, instruite par un humain, au même titre
    que la sortie du bac à sable SES. Cette sortie existe pour qu'elle ne se
    redécouvre pas la veille du go-live.

    `terraform output -json sms_sender_id_registration` en donne une forme
    lisible. Un `statut` valant `a-verifier` ou `a-reconfirmer` n'est pas un
    critère coché.
  EOT
  value       = local.sms_sender_id_registration
}
