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
  description = "Clé KMS qui chiffre le topic d'événements. Tout consommateur du topic — file SQS, Lambda — doit obtenir `kms:Decrypt` sur cette clé, sans quoi il recevra des messages qu'il ne saura pas lire."
  value       = local.kms_key_arn
}
