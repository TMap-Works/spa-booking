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
    l'adresse ne reçoit aucune alerte.
  EOT
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = <<-EOT
    Certificat ACM porté par le listener 443 de l'ALB.

    **Cet environnement en veut un vrai**, et pas seulement par principe : le
    parcours que la recette doit exercer — réserver, confirmer, encaisser —
    passe par des appels qui refusent un certificat non vérifiable. Les Server
    Components du front rappellent l'API par l'ALB public et `fetch` refuse ;
    les trois Lambda de la chaîne de notifications refusent aussi, sans
    contournement possible.

    `null` — le défaut — fait fabriquer à l'environnement un certificat
    auto-signé et l'importe dans ACM. Ce repli n'a qu'une raison d'être : que le
    **tout premier** `terraform apply` aboutisse avant qu'un nom de domaine
    n'existe, sans quoi il n'y aurait rien sur quoi poser le vrai certificat.
    Tant qu'il est en place, l'environnement se déploie et rend `/health`, mais
    la recette de bout en bout ne s'y joue pas. La sortie
    `tls_certificate_is_self_signed` dit dans lequel des deux états on se trouve.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.certificate_arn == null || can(regex("^arn:aws[a-z-]*:acm:", var.certificate_arn))
    error_message = "certificate_arn doit être `null` ou un ARN de certificat ACM (`arn:aws:acm:…`)."
  }
}

variable "public_base_url" {
  description = <<-EOT
    Origine publique de l'environnement — celle qu'un testeur tape et que le
    front publie dans ses balises canoniques et ses données structurées (#345).
    C'est la valeur que le module `ecs-service` injecte dans `APP_URL` et
    `API_URL` de la définition de tâche du service `web`.

    `null` — le défaut — la fait déduire du nom DNS de l'ALB, `https://<dns>`.
    C'est ce qui rend cet environnement applicable sans nom de domaine, et c'est
    exactement ce que la sortie `app_url` rend.

    À poser **en même temps que `certificate_arn`** : les deux décrivent le même
    passage à un vrai domaine, et une origine publique annoncée sur un certificat
    qui ne la couvre pas ferait échouer chaque appel du front vers l'API.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.public_base_url == null || can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$", var.public_base_url))
    error_message = "public_base_url doit être `null` ou une origine en `https://` sans chemin ni barre oblique finale, par exemple `https://recette.reservation.exemple.fr`."
  }
}

variable "image_tag" {
  description = <<-EOT
    Étiquette des images tirées par les services ECS et par la tâche de
    migration : le **sha du commit déployé**. Les dépôts du module `ecr` sont
    immuables — une étiquette mobile ne pourrait être poussée qu'une fois — et la
    définition de tâche appartient à l'état : déployer, c'est donc appliquer avec
    le nouveau sha, ce que fait `deploy-staging.yml` (`-var="image_tag=<sha>"`).

    Le défaut n'est **pas** une image déployable : il ne sert qu'au tout premier
    `apply` d'un environnement vide, avant qu'aucune image n'existe. Un `apply`
    lancé à la main sans `-var image_tag` ramènerait les services à cette
    étiquette inexistante — les nouvelles tâches échoueraient au tirage et le
    disjoncteur de déploiement reviendrait à la révision précédente. Reprendre la
    valeur de la sortie `api_image` avant d'appliquer à la main.
  EOT
  type        = string
  default     = "bootstrap"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", var.image_tag))
    error_message = "image_tag doit être une étiquette d'image valide : lettres, chiffres, point, tiret ou tiret bas, 128 caractères au plus."
  }
}

variable "off_hours_shutdown" {
  description = <<-EOT
    Arrêt programmé des services ECS hors heures ouvrées — « dev et staging
    dimensionnés a minima et **arrêtables hors heures ouvrées** » (skill
    aws-infra §9, CDC §4.16).

    Le défaut arrête les deux services à 20 h et les redémarre à 7 h, du lundi au
    vendredi, à l'heure de Paris. Le week-end reste éteint de lui-même :
    l'arrêt du vendredi soir n'est suivi d'aucun démarrage avant le lundi.

    **Ce que cela n'arrête pas** : l'ALB, la base, le cache, les endpoints
    d'interface et la NAT Gateway continuent d'être facturés — ce réglage coupe
    le calcul, pas l'environnement. La base est délibérément laissée allumée :
    RDS redémarre de lui-même toute instance arrêtée depuis sept jours, et une
    tâche de migration jouée par un déploiement de nuit échouerait sur une base
    éteinte.

    `null` lève l'arrêt durablement — au prix d'une vingtaine de dollars par mois
    qui font passer le coût nominal au-dessus du seuil d'alerte du budget. Pour
    le lever le temps d'une campagne de recette sans toucher au code, voir
    `infra/terraform/modules/ecs-service/README.md`.
  EOT

  type = object({
    stop_cron  = optional(string, "cron(0 20 ? * MON-FRI *)")
    start_cron = optional(string, "cron(0 7 ? * MON-FRI *)")
    timezone   = optional(string, "Europe/Paris")
  })
  default = {}
}

variable "notification_domain" {
  description = <<-EOT
    Domaine d'envoi des notifications, vérifié dans SES — celui qui apparaît à
    droite du `@` dans l'en-tête `From`. `null` — le défaut — ne compose pas du
    tout le module `notifications` : l'environnement reste applicable sans qu'un
    domaine existe.

    Une identité de domaine SES est unique **par compte et par région** : la
    recette prend un sous-domaine qui lui est propre — `staging.mail.<domaine>` —
    et la production garde le nom d'envoi réel. Deux environnements qui
    déclareraient le même nom se disputeraient la même ressource AWS depuis deux
    états distincts, et un envoi d'essai de recette entamerait la réputation du
    domaine de production.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.notification_domain == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.notification_domain))
    error_message = "notification_domain doit être `null` ou un nom de domaine pleinement qualifié en minuscules, par exemple `staging.mail.exemple.fr`."
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
    observer qui écrit au nom du domaine. Sans destinataire de rapports, elle
    n'apprend rien — et il n'y a donc jamais de quoi la resserrer vers
    `quarantine` puis `reject`.
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

variable "notification_reminder_sweep_url" {
  description = <<-EOT
    URL de la route **interne** de balayage du rappel J-1 servie par l'API —
    `https://…/api/v1/notifications/reminders/sweep`. La Lambda de balayage
    l'appelle une fois par heure, présente `notification_dispatch_token_secret_arn`
    dans l'en-tête `x-internal-token`, et publie sur la file ce que l'API lui rend.

    `null` — le défaut — laisse le **planning désactivé**. Le contraste avec
    `notification_dispatch_url` est voulu : là-bas, le défaut fermé se voit dans
    la profondeur de la DLQ, ce qui est exactement ce qu'on veut d'une chaîne
    non branchée. Ici, un balayage sans destination lèverait à chaque heure et
    ferait sonner son alarme d'erreurs indéfiniment sur un environnement où il
    n'y a rien à rappeler — c'est-à-dire qu'il apprendrait à l'équipe à ne plus
    la regarder. Le planning existe quand même, écrit en IaC ; il ne déclenche
    rien tant que cette valeur n'est pas posée, et la sortie
    `notification_reminder_sweep_configured` le dit.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.notification_reminder_sweep_url == null || can(regex("^https://", var.notification_reminder_sweep_url))
    error_message = "notification_reminder_sweep_url doit être `null` ou une URL en `https://` — un appel en clair porterait le jeton d'appel interne sur le réseau."
  }
}

# --- Rebonds et plaintes (#73) ------------------------------------------------

variable "notification_delivery_events_url" {
  description = <<-EOT
    URL de la route **interne** d'ingestion des rebonds et des plaintes servie
    par l'API — `https://…/api/v1/notifications/delivery-events`. La Lambda de
    relais l'appelle pour chaque événement de remise dépilé de la file, et
    présente `notification_dispatch_token_secret_arn` dans l'en-tête
    `x-internal-token`.

    `null` — le défaut — laisse la fonction en **défaut fermé**, comme
    `notification_dispatch_url` et pour la même raison : elle rend chaque
    événement à SQS, la file vieillit, la DLQ se remplit et son alarme de
    profondeur parle. Une chaîne non branchée doit se voir. Rien ne se perd —
    la DLQ retient un événement quatorze jours —, mais rien ne se rattrape tout
    seul : au bout de cinq réceptions infructueuses, soit une douzaine de
    minutes, l'événement n'est plus dans la file mais dans sa DLQ, et un câblage
    posé ensuite ne le rejouera qu'une fois la DLQ vidée à la main
    (`aws sqs start-message-move-task`).

    Ce n'est pas une capacité de confort : tant qu'elle est nulle, **aucune
    adresse en rebond permanent n'est supprimée**. On continue d'écrire à des
    boîtes mortes, et la réputation d'envoi du domaine — partagée par tous les
    établissements — se dégrade sans que rien d'autre ne le dise (CDC §6).

    C'est sur cet environnement que la chaîne se branche avant la production :
    la boîte à rebonds d'SES — `bounce@simulator.amazonses.com` — produit un
    rebond permanent réel sans toucher une seule cliente. La sortie
    `notification_delivery_events_configured` dit l'état sans détour.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.notification_delivery_events_url == null || can(regex("^https://", var.notification_delivery_events_url))
    error_message = "notification_delivery_events_url doit être `null` ou une URL en `https://` — un appel en clair porterait le jeton d'appel interne et l'adresse du destinataire sur le réseau."
  }
}
