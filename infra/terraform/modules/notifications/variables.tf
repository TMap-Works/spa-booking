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
