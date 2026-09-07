variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom du jeu de configuration, du topic d'événements et de la clé KMS — `spa-{environment}-email`, `spa-{environment}-ses-events`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) >= 2 && length(var.environment) <= 16
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser le tiret que comme séparateur : ni en tête, ni en fin, ni doublé."
  }
}

# --- Domaine d'envoi ----------------------------------------------------------

variable "domain" {
  description = <<-EOT
    Domaine d'envoi vérifié dans SES — celui qui apparaît à droite du `@` dans
    l'en-tête `From` des messages.

    Une identité de domaine est unique **par compte et par région** : les trois
    environnements ne peuvent pas vérifier le même nom. Chacun prend un
    sous-domaine qui lui est propre — `dev.mail.exemple.fr`,
    `staging.mail.exemple.fr` — et la production garde le nom d'envoi réel. Deux
    environnements qui déclareraient le même domaine se disputeraient la même
    ressource AWS depuis deux états Terraform distincts, et le dernier `apply`
    gagnerait.
  EOT
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain doit être un nom de domaine pleinement qualifié en minuscules, par exemple `mail.exemple.fr` — sans point final, sans schéma, sans chemin."
  }
}

variable "mail_from_subdomain" {
  description = <<-EOT
    Étiquette du sous-domaine `MAIL FROM` personnalisé, préfixée à `domain` :
    `mail` donne `mail.{domain}`.

    Sans `MAIL FROM` personnalisé, SES utilise `amazonses.com` comme domaine
    d'enveloppe : SPF passe, mais sur un domaine qui n'est pas le nôtre. DMARC
    exige l'**alignement** — que le domaine validé par SPF soit celui du `From` —
    et ne retient alors que DKIM. Un `MAIL FROM` à nous fait aligner les deux, ce
    qui laisse la délivrabilité tenir sur deux pieds au lieu d'un.
  EOT
  type        = string
  default     = "mail"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.mail_from_subdomain))
    error_message = "mail_from_subdomain doit être une seule étiquette DNS en minuscules — lettres, chiffres et tirets, 63 caractères au plus, ni en tête ni en fin de tiret."
  }
}

variable "mail_from_behavior_on_mx_failure" {
  description = <<-EOT
    Conduite de SES quand l'enregistrement MX du domaine `MAIL FROM` est
    introuvable.

    `USE_DEFAULT_VALUE` — le défaut — bascule sur `amazonses.com` et l'envoi
    aboutit, au prix de l'alignement SPF. `REJECT_MESSAGE` refuse l'envoi.

    Le défaut n'est pas de la complaisance : tant que la zone DNS n'est pas
    servie par Route 53, ce module ne publie aucun enregistrement, et
    `REJECT_MESSAGE` couperait **tous** les envois du domaine jusqu'à ce qu'un
    humain aille poser le MX chez son registraire. Passer à `REJECT_MESSAGE` une
    fois la propagation constatée est le réglage le plus strict, et le README dit
    comment la constater.
  EOT
  type        = string
  default     = "USE_DEFAULT_VALUE"

  validation {
    condition     = contains(["USE_DEFAULT_VALUE", "REJECT_MESSAGE"], var.mail_from_behavior_on_mx_failure)
    error_message = "mail_from_behavior_on_mx_failure doit valoir `USE_DEFAULT_VALUE` ou `REJECT_MESSAGE`."
  }
}

variable "dkim_signing_key_length" {
  description = "Longueur de la clé Easy DKIM générée et détenue par SES. `RSA_2048_BIT` par défaut : plus robuste que 1024 bits, et acceptée par tous les résolveurs qui appliquent DKIM. Certaines zones DNS anciennes tronquent une chaîne TXT de plus de 255 octets — ce module publie les clés en CNAME, la question ne se pose donc pas."
  type        = string
  default     = "RSA_2048_BIT"

  validation {
    condition     = contains(["RSA_1024_BIT", "RSA_2048_BIT"], var.dkim_signing_key_length)
    error_message = "dkim_signing_key_length doit valoir `RSA_1024_BIT` ou `RSA_2048_BIT`."
  }
}

# --- Publication DNS ----------------------------------------------------------

variable "route53_zone_id" {
  description = <<-EOT
    Zone hébergée Route 53 qui sert `domain`. Renseignée, le module y publie
    lui-même les six enregistrements que SES réclame — trois CNAME DKIM, un MX et
    un TXT SPF sur le `MAIL FROM`, un TXT DMARC — et la vérification du domaine
    aboutit sans intervention.

    `null` — le défaut — quand la zone est servie ailleurs. Le module crée alors
    tout le reste et **n'invente pas** d'enregistrement qu'il ne peut pas poser :
    la sortie `dns_records` donne la liste exacte, nom par nom, à publier chez le
    registraire. Tant qu'elle ne l'est pas, l'identité reste en
    `NOT_STARTED`/`PENDING` et aucun message ne part.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.route53_zone_id == null || can(regex("^[A-Z0-9]{4,32}$", var.route53_zone_id))
    error_message = "route53_zone_id doit être `null` ou un identifiant de zone hébergée Route 53, par exemple `Z0123456789ABCDEFGHIJ`."
  }
}

variable "dns_record_ttl" {
  description = "Durée de vie des enregistrements publiés dans Route 53, en secondes. Cinq minutes par défaut : assez court pour qu'une correction de DKIM ou de DMARC se propage dans la séance, assez long pour ne pas transformer chaque envoi en requête DNS."
  type        = number
  default     = 300

  validation {
    condition     = var.dns_record_ttl >= 60 && var.dns_record_ttl <= 86400
    error_message = "dns_record_ttl doit être compris entre 60 et 86400 secondes."
  }
}

variable "manage_root_spf_record" {
  description = <<-EOT
    Publie aussi un enregistrement SPF sur `domain` lui-même, en plus de celui du
    `MAIL FROM`.

    Faux par défaut, et ce n'est pas un oubli : **deux enregistrements SPF sur un
    même nom valent `permerror`**, c'est-à-dire un échec SPF pur et simple. Si le
    domaine reçoit déjà du courrier d'un autre émetteur — messagerie
    d'entreprise, facturation, outil de support —, il porte déjà un `v=spf1` et
    il faut y **ajouter** `include:amazonses.com` à la main plutôt que d'en poser
    un second.

    À passer à vrai uniquement sur un sous-domaine dédié à l'envoi, dont on sait
    qu'il ne porte rien d'autre.
  EOT
  type        = bool
  default     = false
}

# --- DMARC --------------------------------------------------------------------

variable "dmarc_policy" {
  description = <<-EOT
    Politique DMARC appliquée aux messages qui échouent à l'alignement.

    `none` par défaut : on **observe** avant de rejeter. Publier `reject` le jour
    de la mise en place ferait disparaître silencieusement tout message légitime
    qu'on aurait oublié — les relances d'un outil tiers, un formulaire de contact,
    une passerelle de facturation. Le passage à `quarantine` puis `reject` se fait
    sur la foi des rapports agrégés, une fois qu'ils ne montrent plus que des
    sources connues.
  EOT
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy doit valoir `none`, `quarantine` ou `reject`."
  }
}

variable "dmarc_report_uri" {
  description = <<-EOT
    Adresse destinataire des rapports agrégés DMARC (`rua`), sous la forme
    `rapports-dmarc@exemple.fr`. `null` — le défaut — publie un enregistrement
    sans `rua`.

    Sans rapports, la politique `none` ne sert à rien : elle n'existe que pour
    faire remonter qui envoie au nom du domaine. Renseigner cette adresse est donc
    la première chose à faire, et la condition pour resserrer la politique
    ensuite. Une adresse hors du domaine surveillé exige un enregistrement
    d'autorisation côté destinataire — le README le rappelle.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.dmarc_report_uri == null || can(regex("^[^@[:space:],;]+@[^@[:space:],;]+\\.[^@[:space:],;]+$", var.dmarc_report_uri))
    error_message = "dmarc_report_uri doit être `null` ou une adresse de courriel unique, sans `mailto:` — la virgule et le point-virgule sont refusés parce qu'ils sont les séparateurs de la syntaxe DMARC."
  }
}

variable "dmarc_percentage" {
  description = "Part des messages, en pourcentage, à laquelle la politique DMARC s'applique (`pct`). 100 par défaut. N'a d'intérêt qu'au moment de resserrer la politique : `quarantine` à 10 % éprouve le réglage sur un dixième du flux avant de le généraliser."
  type        = number
  default     = 100

  validation {
    condition     = var.dmarc_percentage >= 1 && var.dmarc_percentage <= 100 && floor(var.dmarc_percentage) == var.dmarc_percentage
    error_message = "dmarc_percentage doit être un entier compris entre 1 et 100."
  }
}

# --- Jeu de configuration -----------------------------------------------------

variable "tls_policy" {
  description = "Exigence TLS sur le trajet vers le serveur destinataire. `REQUIRE` par défaut : un message de confirmation porte un nom, une date et un lieu de rendez-vous — le laisser partir en clair parce que le destinataire n'annonce pas STARTTLS n'est pas un compromis acceptable (CDC §5.1). `OPTIONAL` rétablit la remise opportuniste."
  type        = string
  default     = "REQUIRE"

  validation {
    condition     = contains(["REQUIRE", "OPTIONAL"], var.tls_policy)
    error_message = "tls_policy doit valoir `REQUIRE` ou `OPTIONAL`."
  }
}

variable "suppressed_reasons" {
  description = <<-EOT
    Motifs qui font inscrire une adresse sur la liste de suppression du compte.
    `BOUNCE` et `COMPLAINT` par défaut, ce qui est exactement la règle de la skill
    notifications §4 : un rebond permanent ou une plainte, et l'adresse n'est plus
    jamais sollicitée.

    C'est SES qui tient cette liste, pas notre code : elle protège la réputation
    d'envoi même si un bug applicatif redemandait un envoi vers une adresse morte.
    Le traitement applicatif des rebonds — passer la notification en `suppressed`
    en base — reste à faire côté API (issue #73), et les deux sont complémentaires.

    Une liste vide désactive la suppression automatique.
  EOT
  type        = list(string)
  default     = ["BOUNCE", "COMPLAINT"]

  validation {
    condition     = alltrue([for reason in var.suppressed_reasons : contains(["BOUNCE", "COMPLAINT"], reason)])
    error_message = "suppressed_reasons n'accepte que `BOUNCE` et `COMPLAINT`."
  }
}

variable "event_types" {
  description = <<-EOT
    Types d'événements de remise publiés vers le topic SNS.

    Le défaut couvre les quatre issues sur lesquelles il y a quelque chose à
    faire : `BOUNCE` et `COMPLAINT` — les deux que le CDC §6 identifie comme
    risque de délivrabilité —, `REJECT` quand SES refuse le message lui-même, et
    `RENDERING_FAILURE` quand un modèle référence une variable absente.

    `SEND` et `DELIVERY` sont volontairement absents : ils produisent un message
    SNS **par envoi réussi**, c'est-à-dire du volume et de la dépense pour une
    information que la table `notifications` porte déjà.
  EOT
  type        = list(string)
  default     = ["BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE"]

  validation {
    condition     = length(var.event_types) > 0
    error_message = "event_types doit contenir au moins un type : une destination d'événements qui n'en retient aucun ne publie rien."
  }

  validation {
    condition = alltrue([for event in var.event_types : contains([
      "SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "OPEN", "CLICK",
      "RENDERING_FAILURE", "DELIVERY_DELAY", "SUBSCRIPTION",
    ], event)])
    error_message = "Chaque entrée de event_types doit être un type d'événement SES connu : SEND, REJECT, BOUNCE, COMPLAINT, DELIVERY, OPEN, CLICK, RENDERING_FAILURE, DELIVERY_DELAY ou SUBSCRIPTION."
  }

  validation {
    condition     = length(distinct(var.event_types)) == length(var.event_types)
    error_message = "event_types ne doit pas comporter de doublon."
  }
}

# --- Chiffrement du canal d'événements ----------------------------------------

variable "kms_key_arn" {
  description = <<-EOT
    Clé KMS chiffrant le topic des événements de remise. `null` — le défaut — fait
    créer au module une clé dédiée, avec la politique qui autorise SES à produire
    une clé de données.

    Une clé fournie ici doit porter la même autorisation : sans elle, SES échoue
    silencieusement à publier, et l'on découvre l'absence de rebonds le jour où
    la réputation du domaine a déjà baissé. C'est la raison pour laquelle le
    module ne réemploie pas la clé du niveau données, dont la politique par défaut
    ne nomme aucun service.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn doit être `null` ou un ARN de clé KMS (`arn:aws:kms:…`)."
  }
}

variable "kms_deletion_window_in_days" {
  description = "Délai avant destruction effective de la clé créée par le module. Sans ce délai, une suppression accidentelle rend illisibles les messages d'événements encore dans le topic."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days doit être compris entre 7 et 30 jours."
  }
}

variable "kms_data_key_reuse_period_seconds" {
  description = "Durée pendant laquelle SQS réemploie une clé de données avant d'en redemander une à KMS. Cinq minutes par défaut : au minimum d'une minute, chaque message ou presque déclencherait un appel KMS facturé ; au maximum de vingt-quatre heures, une clé compromise resterait utilisable trop longtemps."
  type        = number
  default     = 300

  validation {
    condition     = var.kms_data_key_reuse_period_seconds >= 60 && var.kms_data_key_reuse_period_seconds <= 86400
    error_message = "kms_data_key_reuse_period_seconds doit être compris entre 60 et 86400 secondes."
  }
}

# --- File de découplage -------------------------------------------------------

variable "dispatch_max_receive_count" {
  description = <<-EOT
    Nombre de réceptions infructueuses au bout desquelles un message part en file
    d'attente morte.

    Cinq par défaut. C'est le seul compteur de reprise de toute la chaîne : la
    Lambda ne boucle pas, ne compte pas et n'espace pas ses essais — SQS le fait,
    avec son propre report. Une valeur de 1 supprimerait toute reprise ; une
    valeur élevée retiendrait un message plusieurs heures avant qu'il ne devienne
    visible en DLQ, ce qui repousse d'autant le moment où quelqu'un l'apprend.
  EOT
  type        = number
  default     = 5

  validation {
    condition     = var.dispatch_max_receive_count >= 1 && var.dispatch_max_receive_count <= 20 && floor(var.dispatch_max_receive_count) == var.dispatch_max_receive_count
    error_message = "dispatch_max_receive_count doit être un entier compris entre 1 et 20."
  }
}

variable "dispatch_message_retention_seconds" {
  description = "Durée de conservation d'un message dans la file principale. Quatre jours par défaut — assez pour traverser un week-end de panne, et bien au-delà de la fenêtre utile d'un rappel J-1, qui n'a plus de sens passé l'heure du rendez-vous."
  type        = number
  default     = 345600

  validation {
    condition     = var.dispatch_message_retention_seconds >= 60 && var.dispatch_message_retention_seconds <= 1209600
    error_message = "dispatch_message_retention_seconds doit être compris entre 60 et 1209600 secondes (14 jours, le maximum SQS)."
  }
}

variable "dlq_message_retention_seconds" {
  description = "Durée de conservation d'un message en file d'attente morte. Le maximum SQS — 14 jours — par défaut : un message n'arrive ici qu'après avoir épuisé ses tentatives, il est la preuve d'une panne, et cette preuve doit survivre au délai qu'il faut pour qu'un humain la lise."
  type        = number
  default     = 1209600

  validation {
    condition     = var.dlq_message_retention_seconds >= 3600 && var.dlq_message_retention_seconds <= 1209600
    error_message = "dlq_message_retention_seconds doit être compris entre 3600 et 1209600 secondes."
  }
}

# --- Lambda d'envoi -----------------------------------------------------------

variable "dispatcher_timeout_seconds" {
  description = "Délai maximal d'une invocation de la Lambda d'envoi. Il borne aussi le délai de visibilité de la file, fixé à six fois cette valeur. Doit laisser tenir un lot entier : `dispatcher_batch_size × dispatch_timeout_ms`, plus deux secondes de marge — une précondition le vérifie au plan."
  type        = number
  default     = 30

  validation {
    condition     = var.dispatcher_timeout_seconds >= 3 && var.dispatcher_timeout_seconds <= 900
    error_message = "dispatcher_timeout_seconds doit être compris entre 3 et 900 secondes."
  }
}

variable "dispatcher_memory_mb" {
  description = "Mémoire allouée à la Lambda d'envoi, en Mio. 256 par défaut : la fonction ne fait qu'un appel HTTP par message, et la mémoire fixe aussi la part de vCPU — descendre à 128 rallongerait le démarrage à froid pour économiser une fraction de centime."
  type        = number
  default     = 256

  validation {
    condition     = var.dispatcher_memory_mb >= 128 && var.dispatcher_memory_mb <= 10240
    error_message = "dispatcher_memory_mb doit être compris entre 128 et 10240 Mio."
  }
}

variable "dispatcher_batch_size" {
  description = "Nombre de messages remis à la fonction par invocation. Cinq par défaut : la fonction les traite en séquence, et le lot entier doit tenir dans `dispatcher_timeout_seconds`. Un lot plus large amortirait mieux le démarrage à froid, au prix d'un délai de visibilité plus long pour tout le monde."
  type        = number
  default     = 5

  validation {
    condition     = var.dispatcher_batch_size >= 1 && var.dispatcher_batch_size <= 10 && floor(var.dispatcher_batch_size) == var.dispatcher_batch_size
    error_message = "dispatcher_batch_size doit être un entier compris entre 1 et 10 : au-delà de 10, SQS exige une fenêtre de regroupement non nulle."
  }
}

variable "dispatcher_maximum_concurrency" {
  description = "Nombre maximal d'invocations simultanées de la source d'événements SQS. Cinq par défaut, soit vingt-cinq messages de front : c'est la seule chose qui empêche un pic de réservations de se transformer en pic d'appels vers l'API. Le minimum imposé par AWS est 2."
  type        = number
  default     = 5

  validation {
    condition     = var.dispatcher_maximum_concurrency >= 2 && var.dispatcher_maximum_concurrency <= 1000 && floor(var.dispatcher_maximum_concurrency) == var.dispatcher_maximum_concurrency
    error_message = "dispatcher_maximum_concurrency doit être un entier compris entre 2 et 1000 — AWS refuse une concurrence maximale inférieure à 2."
  }
}

variable "dispatch_url" {
  description = <<-EOT
    URL de la route d'envoi servie par l'API, appelée par la Lambda pour chaque
    message. `null` — le défaut — laisse la fonction en **défaut fermé** : elle
    journalise `notification.unconfigured`, rend le message à SQS, et la chaîne
    devient visible en supervision au lieu d'avaler silencieusement les envois.

    Pas de valeur déduite de l'ALB : en développement, la terminaison TLS est un
    certificat auto-signé qu'aucun client ne vérifie sans y être forcé, et la
    fonction refuse — à juste titre — de désactiver la vérification. Cette URL est
    donc une entrée d'environnement, renseignée le jour où un nom de domaine et
    un certificat réels existent.

    Contrat attendu de la route, côté API : `POST` d'un corps
    `{ messageId, message }`, réponse `2xx` envoyé · `204`/`409` déjà envoyé ·
    `408`/`425`/`429`/`5xx` à rejouer · tout autre `4xx` échec permanent, jamais
    rejoué.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.dispatch_url == null || can(regex("^https://", var.dispatch_url))
    error_message = "dispatch_url doit être `null` ou une URL en `https://` — un appel en clair porterait le jeton d'appel et les identifiants de rendez-vous sur le réseau."
  }
}

variable "dispatch_token_secret_arn" {
  description = "Secret Manager contenant le jeton partagé que la Lambda présente à l'API dans l'en-tête `x-internal-token`. `null` — le défaut — n'envoie aucun en-tête et n'accorde aucun droit de lecture de secret à la fonction. La valeur du secret n'est jamais lue par Terraform : la fonction la lit au démarrage à froid."
  type        = string
  default     = null

  validation {
    condition     = var.dispatch_token_secret_arn == null || can(regex("^arn:aws[a-z-]*:secretsmanager:", var.dispatch_token_secret_arn))
    error_message = "dispatch_token_secret_arn doit être `null` ou un ARN Secrets Manager (`arn:aws:secretsmanager:…`)."
  }
}

variable "dispatch_timeout_ms" {
  description = "Délai maximal d'un appel à `dispatch_url`, en millisecondes. Un dépassement est traité comme un échec **transitoire** : le message revient à SQS. Cinq secondes par défaut, à multiplier par `dispatcher_batch_size` pour vérifier que le lot tient dans le délai de la fonction."
  type        = number
  default     = 5000

  validation {
    condition     = var.dispatch_timeout_ms >= 500 && var.dispatch_timeout_ms <= 60000
    error_message = "dispatch_timeout_ms doit être compris entre 500 et 60000 millisecondes."
  }
}

# --- Rappel J-1 (#71) ---------------------------------------------------------

variable "reminder_sweep_url" {
  description = <<-EOT
    URL de la route **interne** de balayage servie par l'API —
    `https://…/api/v1/notifications/reminders/sweep` —, appelée une fois par
    heure par la Lambda de balayage.

    `null` — le défaut — laisse le planning **désactivé**. Ce n'est pas un défaut
    ouvert : la fonction lèverait à chaque heure sans destination, et son alarme
    d'erreurs sonnerait indéfiniment sur un environnement où il n'y a rien à
    rappeler. Le planning existe quand même, écrit en IaC ; il ne déclenche rien
    tant que la chaîne n'est pas branchée, et la sortie
    `reminder_sweep_configured` le dit.

    Pas de valeur déduite de l'ALB, pour la raison qui vaut sur `dispatch_url` :
    en développement, la terminaison TLS est un certificat auto-signé qu'aucun
    client ne vérifie sans y être forcé.

    Contrat attendu de la route, côté API : `POST` sans corps, en-tête
    `x-internal-token`, réponse `200` portant `{ from, to, tenantCount,
    appointmentCount, truncated, messages[] }` — chaque message étant une
    enveloppe `NotificationMessage` prête à publier.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.reminder_sweep_url == null || can(regex("^https://", var.reminder_sweep_url))
    error_message = "reminder_sweep_url doit être `null` ou une URL en `https://` — un appel en clair porterait le jeton d'appel interne sur le réseau."
  }
}

variable "reminder_schedule_expression" {
  description = <<-EOT
    Expression de planification du balayage, au format EventBridge Scheduler.
    Évaluée en **UTC**, comme la sélection.

    `cron(0 * * * ? *)` par défaut — la minute zéro de chaque heure. `cron` et
    non `rate(1 hour)`, et la différence n'est pas cosmétique : `rate` compte à
    partir de la création du planning, si bien qu'un redéploiement en décale la
    phase. Or les fenêtres de sélection pavent le temps — `[T+24h, T+25h)`, puis
    `[T+25h, T+26h)` — et un décalage de phase se paie en rendez-vous jamais
    rappelés.

    **Changer la période oblige à changer `REMINDER_WINDOW_MS` côté API**, et
    réciproquement : la largeur de la fenêtre et l'intervalle du balayage sont
    la même durée vue de deux côtés. La sortie `reminder_window_hours` existe
    pour que l'écart se voie.
  EOT
  type        = string
  default     = "cron(0 * * * ? *)"

  validation {
    condition     = can(regex("^(cron|rate|at)\\(", var.reminder_schedule_expression))
    error_message = "reminder_schedule_expression doit être une expression `cron(…)`, `rate(…)` ou `at(…)` reconnue par EventBridge Scheduler."
  }
}

variable "reminder_sweeper_timeout_seconds" {
  description = "Délai maximal d'une invocation de la Lambda de balayage. Doit laisser tenir l'appel à l'API — `reminder_sweep_timeout_ms` — **plus** la publication du lot rendu, cinq secondes de marge ; une précondition le vérifie au plan."
  type        = number
  default     = 60

  validation {
    condition     = var.reminder_sweeper_timeout_seconds >= 10 && var.reminder_sweeper_timeout_seconds <= 900
    error_message = "reminder_sweeper_timeout_seconds doit être compris entre 10 et 900 secondes."
  }
}

variable "reminder_sweeper_memory_mb" {
  description = "Mémoire allouée à la Lambda de balayage, en Mio. 256 par défaut : elle fait un appel HTTP et quelques `SendMessageBatch`, et la mémoire fixe aussi la part de vCPU — descendre à 128 rallongerait le démarrage à froid pour économiser une fraction de centime par heure."
  type        = number
  default     = 256

  validation {
    condition     = var.reminder_sweeper_memory_mb >= 128 && var.reminder_sweeper_memory_mb <= 10240
    error_message = "reminder_sweeper_memory_mb doit être compris entre 128 et 10240 Mio."
  }
}

variable "reminder_sweep_timeout_ms" {
  description = "Délai maximal de l'appel à `reminder_sweep_url`, en millisecondes. Dix secondes par défaut, contre cinq pour un envoi unitaire : ce n'est pas un message, c'est la sélection d'une heure entière de rendez-vous sur tous les établissements. Un dépassement fait lever, et EventBridge Scheduler réessaie."
  type        = number
  default     = 10000

  validation {
    condition     = var.reminder_sweep_timeout_ms >= 1000 && var.reminder_sweep_timeout_ms <= 120000
    error_message = "reminder_sweep_timeout_ms doit être compris entre 1000 et 120000 millisecondes."
  }
}

variable "reminder_max_retry_attempts" {
  description = "Nombre de reprises d'un déclenchement en échec. Deux par défaut. Le défaut du service — 185 — est le pire réglage possible ici : il ferait rejouer pendant vingt-quatre heures un balayage dont la fenêtre est morte, pour produire des rappels que l'API refuserait d'envoyer parce qu'ils seraient en retard."
  type        = number
  default     = 2

  validation {
    condition     = var.reminder_max_retry_attempts >= 0 && var.reminder_max_retry_attempts <= 185 && floor(var.reminder_max_retry_attempts) == var.reminder_max_retry_attempts
    error_message = "reminder_max_retry_attempts doit être un entier compris entre 0 et 185."
  }
}

variable "reminder_max_event_age_seconds" {
  description = "Âge au-delà duquel un déclenchement en échec cesse d'être rejoué, en secondes. Une heure par défaut, soit la fenêtre elle-même : passé ce délai, les rendez-vous du balayage en cause en sont sortis, et leur rappel serait « en retard » (skill notifications §3)."
  type        = number
  default     = 3600

  validation {
    condition     = var.reminder_max_event_age_seconds >= 60 && var.reminder_max_event_age_seconds <= 86400
    error_message = "reminder_max_event_age_seconds doit être compris entre 60 et 86400 secondes."
  }
}

# --- Supervision --------------------------------------------------------------

variable "log_retention_days" {
  description = "Rétention du groupe de journaux de la Lambda d'envoi. 30 jours hors production, 90 en production (skill aws-infra §8). Le groupe est créé explicitement pour cette seule raison : celui que Lambda crée de lui-même conserve indéfiniment."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days doit être une des durées acceptées par CloudWatch Logs — 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288 ou 3653 jours."
  }
}

variable "metric_namespace" {
  description = "Espace de noms CloudWatch des métriques que la Lambda publie au format EMF — `Sent`, `Skipped`, `TransientFailures`, `PermanentFailures`, dimensionnées par `Environment`. Le changer ici et nulle part ailleurs suffit : les alarmes et le tableau de bord le lisent."
  type        = string
  default     = "Spa/Notifications"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/#:-]{1,255}$", var.metric_namespace))
    error_message = "metric_namespace doit être un espace de noms CloudWatch valide, de 1 à 255 caractères, par exemple `Spa/Notifications`."
  }
}

variable "alarm_topic_arns" {
  description = <<-EOT
    Topics SNS notifiés à l'entrée **et à la sortie** de chaque alarme de la
    chaîne. Vide par défaut : les alarmes existent alors et restent consultables,
    mais ne préviennent personne.

    Le topic attendu est celui du module `budgets` — `alerts_topic_arn` —, dont le
    commentaire prévoit explicitement que les alarmes d'observabilité s'y
    branchent plutôt que d'en créer un second. Sa politique nomme
    `cloudwatch.amazonaws.com` depuis #67 ; un topic fourni ici doit en faire
    autant, sans quoi l'alarme change bien d'état mais aucune notification ne part.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.alarm_topic_arns : can(regex("^arn:aws[a-z-]*:sns:", arn))])
    error_message = "Chaque entrée de alarm_topic_arns doit être un ARN de topic SNS (`arn:aws:sns:…`)."
  }
}

variable "alarm_period_seconds" {
  description = "Période d'évaluation des alarmes de la chaîne, en secondes. Cinq minutes par défaut : assez court pour qu'un message en DLQ se sache dans le quart d'heure, assez long pour ne pas transformer un incident d'une minute en salve de notifications."
  type        = number
  default     = 300

  validation {
    condition     = contains([60, 300, 900, 3600], var.alarm_period_seconds)
    error_message = "alarm_period_seconds doit valoir 60, 300, 900 ou 3600 secondes."
  }
}

variable "backlog_age_alarm_seconds" {
  description = "Âge, en secondes, à partir duquel le plus vieux message en attente déclenche l'alarme. Une heure par défaut, soit la période du balayage du rappel J-1 : au-delà, le retard n'est plus rattrapable dans la fenêtre du rappel (skill notifications §3)."
  type        = number
  default     = 3600

  validation {
    condition     = var.backlog_age_alarm_seconds >= 60 && var.backlog_age_alarm_seconds <= 86400
    error_message = "backlog_age_alarm_seconds doit être compris entre 60 et 86400 secondes."
  }
}

variable "create_dashboard" {
  description = "Crée le tableau de bord CloudWatch de la chaîne de notifications. Vrai par défaut. Les trois premiers tableaux de bord d'un compte sont gratuits, soit exactement un par environnement ; passer à faux le jour où un tableau de bord transverse (#78) prend le relais."
  type        = bool
  default     = true
}

# --- Canal SMS (#66) ----------------------------------------------------------

variable "manage_sms_account_preferences" {
  description = <<-EOT
    Confie à cet environnement les préférences SMS d'SNS — type de message,
    plafond de dépense, sender ID — et l'alarme de dépense qui va avec.

    **Faux par défaut, et il ne doit être vrai que dans un environnement à la
    fois.** `aws_sns_sms_preferences` n'a pas de nom : il y en a exactement un par
    compte et par région, comme il n'y a qu'un jeu de préférences dans la console.
    Deux environnements qui le déclareraient l'écraseraient tour à tour depuis
    deux états Terraform, sans que ni l'un ni l'autre ne voie de conflit dans son
    plan — le dernier `apply` gagnerait, et le plafond de la production pourrait
    être celui du développement.

    Le laisser à faux ne prive de rien : le réglage étant celui du compte, tous
    les environnements en héritent. Un envoi en boucle depuis le développement
    est plafonné par la valeur de la production, ce qui est exactement la
    protection recherchée.
  EOT
  type        = bool
  default     = false
}

variable "sms_monthly_spend_limit_usd" {
  description = <<-EOT
    Plafond de dépense SMS du mois civil, en dollars US. Sans effet quand
    `manage_sms_account_preferences` vaut faux.

    C'est un **arrêt dur**, pas un seuil d'alerte : SNS cesse d'envoyer dès que la
    dépense l'atteint, et la publication est refusée côté service — aucune erreur
    applicative ne le dit. Le CDC §4.16 sort le SMS de l'estimation budgétaire
    précisément parce que son coût varie fortement selon le pays ; ce plafond est
    ce qui borne l'inconnue.

    Dix dollars par défaut : de quoi couvrir plusieurs centaines de rappels vers
    l'Europe, largement moins vers une destination chère. Le dimensionner
    réellement demande un mois de métriques — le relever est une pull request,
    l'atteindre est une panne de rappels.

    **Le quota du compte plafonne cette valeur, et il vaut 1 USD sur un compte
    neuf.** Un `apply` qui demande davantage échoue tant que la demande de quota
    n'est pas accordée par le support AWS. À faire tôt : le délai n'est pas
    instantané.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.sms_monthly_spend_limit_usd >= 1 && var.sms_monthly_spend_limit_usd <= 10000 && floor(var.sms_monthly_spend_limit_usd) == var.sms_monthly_spend_limit_usd
    error_message = "sms_monthly_spend_limit_usd doit être un entier compris entre 1 et 10000 dollars — SNS n'accepte pas de plafond fractionnaire, et un plafond à zéro couperait le canal au premier message."
  }
}

variable "sms_spend_alarm_threshold_percent" {
  description = <<-EOT
    Part du plafond, en pourcentage, à partir de laquelle l'alarme de dépense se
    déclenche. 80 % par défaut, le même seuil que la première alerte du module
    `budgets` (CDC §4.16).

    Pourquoi pas 100 % : à 100 %, il n'y a plus rien à prévenir. Le plafond est
    atteint, SNS a cessé d'envoyer, et l'alarme ne fait que constater des rappels
    déjà perdus. Le seul moment où l'information sert est celui où il reste de la
    marge pour relever le plafond ou couper le canal.
  EOT
  type        = number
  default     = 80

  validation {
    condition     = var.sms_spend_alarm_threshold_percent >= 1 && var.sms_spend_alarm_threshold_percent <= 100 && floor(var.sms_spend_alarm_threshold_percent) == var.sms_spend_alarm_threshold_percent
    error_message = "sms_spend_alarm_threshold_percent doit être un entier compris entre 1 et 100."
  }
}

variable "sms_spend_alarm_period_seconds" {
  description = <<-EOT
    Période d'évaluation de l'alarme de dépense SMS, en secondes. Une heure par
    défaut, contre cinq minutes pour les alarmes de la chaîne d'envoi.

    L'écart est voulu : `SMSMonthToDateSpentUSD` est un cumul mensuel, pas un
    débit. Il ne bouge qu'au rythme des envois, et l'échantillonner toutes les
    cinq minutes ne ferait qu'ajouter des périodes sans point — donc du bruit —
    sans avancer d'une minute le moment où le seuil est franchi.
  EOT
  type        = number
  default     = 3600

  validation {
    condition     = contains([300, 900, 3600, 21600, 86400], var.sms_spend_alarm_period_seconds)
    error_message = "sms_spend_alarm_period_seconds doit valoir 300, 900, 3600, 21600 ou 86400 secondes."
  }
}

variable "sms_sender_id" {
  description = <<-EOT
    Nom d'expéditeur affiché à la place d'un numéro, là où l'opérateur du pays
    destinataire l'accepte. `null` — le défaut — laisse SNS émettre depuis un
    numéro partagé, et le message n'a alors l'air de venir de personne : sur un
    rappel de rendez-vous, c'est la première raison de ne pas le lire.

    Onze caractères au plus, lettres et chiffres uniquement, et **au moins une
    lettre** : un sender ID purement numérique est refusé par les opérateurs, qui
    y voient une usurpation de numéro court. Ni espace, ni accent, ni ponctuation.

    Poser cette valeur ne l'enregistre nulle part — voir la sortie
    `sms_sender_id_registration`.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.sms_sender_id == null || can(regex("^[A-Za-z0-9]{1,11}$", var.sms_sender_id))
    error_message = "sms_sender_id doit être `null` ou une chaîne de 1 à 11 caractères alphanumériques sans espace ni accent."
  }

  validation {
    condition     = var.sms_sender_id == null || can(regex("[A-Za-z]", var.sms_sender_id))
    error_message = "sms_sender_id doit comporter au moins une lettre : un expéditeur purement numérique est refusé par les opérateurs, qui y voient une usurpation de numéro court."
  }
}

variable "sms_target_countries" {
  description = <<-EOT
    Pays vers lesquels des SMS seront émis, en code ISO 3166-1 alpha-2. Sert
    uniquement à composer la sortie `sms_sender_id_registration` : la liste des
    démarches d'enregistrement d'expéditeur à mener avant le go-live.

    `["MG", "FR"]` par défaut — les deux que la skill notifications §5 nomme.
    Aucune ressource AWS n'en découle : l'enregistrement d'un sender ID n'a pas de
    ressource Terraform, chez aucun fournisseur.
  EOT
  type        = list(string)
  default     = ["MG", "FR"]

  validation {
    condition     = alltrue([for country in var.sms_target_countries : can(regex("^[A-Z]{2}$", country))])
    error_message = "Chaque entrée de sms_target_countries doit être un code pays ISO 3166-1 alpha-2 en deux majuscules, par exemple `MG` ou `FR`."
  }

  validation {
    condition     = length(distinct(var.sms_target_countries)) == length(var.sms_target_countries)
    error_message = "sms_target_countries ne doit pas comporter de doublon."
  }
}
