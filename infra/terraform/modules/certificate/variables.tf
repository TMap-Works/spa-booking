variable "environment" {
  description = "Nom de l'environnement. Entre dans l'étiquette `Name` du certificat, sous la forme `spa-{environment}-{usage}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

variable "usage" {
  description = <<-EOT
    Ce que ce certificat termine — `alb` ou `edge`. Sert uniquement à distinguer
    deux certificats du même environnement dans la console et dans les étiquettes.

    Il en faut bien deux en production, et ce n'est pas une redondance : ACM est
    un service **régional**, et CloudFront n'accepte que des certificats de
    `us-east-1` quelle que soit la région du reste de la plateforme. Le même nom
    de domaine est donc certifié deux fois, par deux ressources distinctes, dans
    deux régions.
  EOT
  type        = string
  default     = "alb"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.usage))
    error_message = "usage doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

variable "domain_name" {
  description = <<-EOT
    Nom principal du certificat — celui que les visiteuses tapent, par exemple
    `reservation.exemple.fr`. C'est lui qui figure en `CN`, et c'est lui que
    CloudFront ou l'ALB doivent servir pour qu'un navigateur accepte la connexion.
  EOT
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name doit être un nom de domaine pleinement qualifié en minuscules, par exemple `reservation.exemple.fr`. Les jokers (`*.exemple.fr`) sont refusés par ce module — voir la note du README : un joker partage son enregistrement de validation avec son apex, et deux ressources Route 53 se disputeraient alors le même nom."
  }
}

variable "subject_alternative_names" {
  description = <<-EOT
    Noms supplémentaires couverts par le même certificat.

    **Ne jamais y remettre un nom qu'un autre certificat du compte couvre déjà.**
    ACM émet le même enregistrement CNAME de validation pour un domaine donné
    dans un compte donné, quelle que soit la région : deux certificats qui se
    recouvrent font gérer le même enregistrement Route 53 par deux instances de ce
    module, et la destruction de l'un emporterait l'enregistrement dont l'autre a
    besoin — dont le renouvellement échouerait un an plus tard, sans alerte. Voir
    la section correspondante du README.

    En production, les deux certificats sont donc disjoints : celui de l'ALB
    couvre `origin.<domaine>`, celui de bord couvre `<domaine>`.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for name in var.subject_alternative_names :
      can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", name))
    ])
    error_message = "Chaque entrée de subject_alternative_names doit être un nom de domaine pleinement qualifié en minuscules. Les jokers sont refusés — voir la note du README."
  }
}

variable "route53_zone_id" {
  description = <<-EOT
    Zone hébergée Route 53 servant `domain_name`. Renseignée, le module publie
    lui-même les enregistrements CNAME de validation et attend qu'ACM les lise :
    l'émission est alors entièrement automatique, et le **renouvellement l'est
    aussi** — ACM réémet un certificat validé par DNS soixante jours avant son
    échéance, sans intervention, tant que ces CNAME restent publiés.

    `null` quand le DNS est servi ailleurs. Le certificat est alors créé et reste
    `PENDING_VALIDATION` : la sortie `validation_records` donne la liste exacte à
    publier chez le registraire. Tant qu'elle ne l'est pas, le certificat ne peut
    être posé sur aucun listener — et, une fois posé, **son renouvellement
    dépendra de la présence continue de ces enregistrements**. Les retirer après
    l'émission fait échouer le renouvellement automatique, silencieusement, un an
    plus tard.
  EOT
  type        = string
  default     = null
}

variable "validation_record_ttl" {
  description = "Durée de vie des enregistrements CNAME de validation, en secondes. Soixante secondes : ils ne changent qu'à la création, et une valeur basse raccourcit la première émission autant que la reprise après une correction."
  type        = number
  default     = 60

  validation {
    condition     = var.validation_record_ttl >= 60 && var.validation_record_ttl <= 86400
    error_message = "validation_record_ttl doit être compris entre 60 et 86400 secondes."
  }
}

variable "wait_for_validation" {
  description = <<-EOT
    Attendre qu'ACM ait validé le certificat avant de rendre la main.

    Vrai par défaut, et cela vaut la peine d'être compris : sans cette attente,
    `apply` poserait sur le listener un certificat encore `PENDING_VALIDATION`,
    qu'AWS refuse — l'erreur porterait alors sur le listener et non sur la cause.

    N'a d'effet que si `route53_zone_id` est renseignée : sans zone, il n'y a
    personne pour publier les CNAME, et attendre serait attendre pour toujours.
  EOT
  type        = bool
  default     = true
}

variable "validation_timeout" {
  description = "Délai au bout duquel l'attente de validation abandonne. Quinze minutes : ACM lit les CNAME en quelques minutes quand la zone est correcte, et un dépassement signale presque toujours une zone qui ne sert pas réellement le domaine."
  type        = string
  default     = "15m"
}

variable "key_algorithm" {
  description = "Algorithme de la clé — `RSA_2048` par défaut, seul jeu accepté par tous les clients. `EC_prime256v1` allège la poignée de main TLS mais reste refusé par de vieux clients, ce qu'un tunnel de réservation grand public ne peut pas se permettre."
  type        = string
  default     = "RSA_2048"

  validation {
    condition     = contains(["RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1"], var.key_algorithm)
    error_message = "key_algorithm doit être un des algorithmes admis par ACM : RSA_2048, RSA_3072, RSA_4096, EC_prime256v1, EC_secp384r1."
  }
}
