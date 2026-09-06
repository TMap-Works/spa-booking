variable "aws_region" {
  description = "Région AWS de l'environnement. Doit rester alignée sur la région du bloc `backend` de backend.tf, qui n'accepte ni variable ni interpolation."
  type        = string
  default     = "eu-west-3"
}

variable "budget_alert_emails" {
  description = <<-EOT
    Adresses prévenues quand le budget mensuel de l'environnement dépasse 80 %
    puis 100 % de son plafond. Vide par défaut, et non versionnée : une liste de
    destinataires est une donnée d'exploitation, pas une décision d'architecture,
    et elle change sans que l'infrastructure change.

    Le topic SNS est créé quoi qu'il arrive — s'abonner après coup ne demande
    qu'un `-var` à l'`apply`, ou un abonnement posé à la main sur le topic dont
    l'ARN est donné par la sortie `budget_alerts_topic_arn`.

    **Un abonnement par courriel doit être confirmé par son destinataire** :
    Terraform le crée, il ne peut pas le confirmer. Tant qu'il ne l'est pas,
    l'adresse ne reçoit aucune alerte — ce qui, sur la production, revient à
    n'avoir aucune alerte du tout.
  EOT
  type        = list(string)
  default     = []
}

variable "notification_domain" {
  description = <<-EOT
    Domaine d'envoi des notifications, vérifié dans SES — celui qui apparaît à
    droite du `@` dans l'en-tête `From`. `null` — le défaut — ne compose pas du
    tout le module `notifications`, ce qui laisse cet environnement applicable
    avant que le domaine d'envoi ne soit arrêté.

    **La production ne peut pas rester à `null`** : sans identité vérifiée,
    aucune confirmation ni aucun rappel J-1 ne part. La valeur doit être posée,
    et la sortie du bac à sable SES obtenue, avant le go-live (#83).

    Une identité de domaine SES est unique par compte et par région : la
    production garde le nom d'envoi réel, dev et staging prennent chacun leur
    sous-domaine.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.notification_domain == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.notification_domain))
    error_message = "notification_domain doit être `null` ou un nom de domaine pleinement qualifié en minuscules, par exemple `mail.exemple.fr`."
  }
}

variable "notification_route53_zone_id" {
  description = <<-EOT
    Zone hébergée Route 53 servant `notification_domain`. Renseignée, le module
    publie lui-même les six enregistrements de délivrabilité — trois CNAME DKIM,
    un MX et un TXT SPF sur le `MAIL FROM`, un TXT DMARC — et la vérification du
    domaine aboutit sans intervention.

    `null` quand le DNS est servi ailleurs : la sortie `notification_dns_records`
    donne alors la liste exacte à publier chez le registraire. Tant qu'elle ne
    l'est pas, l'identité reste en attente et aucun message ne part.
  EOT
  type        = string
  default     = null
}

variable "notification_dmarc_report_uri" {
  description = <<-EOT
    Adresse destinataire des rapports agrégés DMARC (`rua`). `null` publie un
    enregistrement DMARC sans `rua`.

    La politique par défaut du module est `p=none` : elle n'existe que pour
    observer qui écrit au nom du domaine. En production, c'est aussi la seule
    source qui dira quand elle peut passer à `quarantine` puis `reject` — sans
    destinataire de rapports, la politique reste à `none` pour toujours.
  EOT
  type        = string
  default     = null
}

# --- Chaîne d'envoi des notifications (#67) -----------------------------------

variable "notification_dispatch_url" {
  description = <<-EOT
    URL de la route d'envoi servie par l'API, que la Lambda appelle pour chaque
    message de la file de notifications.

    `null` — le défaut — laisse la fonction en **défaut fermé** : elle rend chaque
    message à SQS, qui l'épuise en cinq réceptions — un quart d'heure au plus —
    puis le verse en DLQ, où l'alarme de profondeur le signale. C'est délibéré. Une chaîne non branchée doit se voir ; une chaîne qui
    acquitterait les messages sans rien envoyer serait invisible.

    Elle n'est pas déduite de l'ALB. En développement, la terminaison TLS est un
    certificat auto-signé qu'aucun client ne vérifie sans y être forcé — et la
    fonction refuse de désactiver la vérification. Ailleurs, l'URL dépend du nom
    de domaine réel du produit. Cette valeur se pose donc le jour où la route
    existe (#70) et où un certificat vérifiable la sert.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.notification_dispatch_url == null || can(regex("^https://", var.notification_dispatch_url))
    error_message = "notification_dispatch_url doit être `null` ou une URL en `https://` — un appel en clair porterait le jeton et les identifiants de rendez-vous sur le réseau."
  }
}

variable "notification_dispatch_token_secret_arn" {
  description = <<-EOT
    Secret Manager portant le jeton partagé que la Lambda présente à l'API dans
    l'en-tête `x-internal-token`. La valeur n'est jamais lue par Terraform : la
    fonction la lit elle-même à son démarrage à froid.

    `null` — le défaut — n'envoie aucun en-tête et n'accorde à la fonction aucun
    droit de lecture de secret. À poser **en même temps** que
    `notification_dispatch_url` : une route d'envoi joignable sans jeton laisserait
    n'importe qui déclencher des messages au nom d'un établissement.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.notification_dispatch_token_secret_arn == null || can(regex("^arn:aws[a-z-]*:secretsmanager:", var.notification_dispatch_token_secret_arn))
    error_message = "notification_dispatch_token_secret_arn doit être `null` ou un ARN Secrets Manager (`arn:aws:secretsmanager:…`)."
  }
}
