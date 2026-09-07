variable "aws_region" {
  description = "Région AWS hébergeant les états Terraform. Doit être identique à la région déclarée dans les blocs `backend` de envs/*."
  type        = string
  default     = "eu-west-3"
}

variable "environments" {
  description = "Environnements disposant d'un état isolé. Un bucket, une table de verrouillage et une clé KMS par entrée."
  type        = set(string)
  default     = ["dev", "staging", "prod"]

  validation {
    condition     = length(var.environments) > 0
    error_message = "Il faut au moins un environnement : sans état distant, aucun autre module ne peut être appliqué."
  }
}

variable "state_bucket_prefix" {
  description = "Préfixe des buckets d'état. Les noms de bucket S3 sont uniques au niveau mondial : si `<prefix>-<env>-tfstate` est déjà pris, changer cette valeur et reporter le nouveau nom dans les blocs `backend` de envs/*."
  type        = string
  default     = "spa-booking"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$", var.state_bucket_prefix))
    error_message = "Le préfixe doit respecter le nommage S3 : minuscules, chiffres et tirets, sans tiret en tête ni en fin."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Durée de conservation des versions antérieures de l'état. Assez longue pour récupérer une corruption passée inaperçue, assez courte pour que le bucket ne grossisse pas indéfiniment."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30
    error_message = "Moins de 30 jours d'historique ne laisse pas le temps de détecter une corruption d'état."
  }
}

variable "kms_deletion_window_in_days" {
  description = "Délai de grâce avant destruction effective d'une clé KMS. Une clé supprimée rend l'état illisible : le délai maximal est un filet de sécurité, pas une lenteur."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "AWS n'accepte qu'une valeur comprise entre 7 et 30 jours."
  }
}

variable "cost_allocation_tag_keys" {
  description = <<-EOT
    Étiquettes à activer comme **étiquettes de répartition de coûts**. Sans cette
    activation, Cost Explorer connaît l'étiquette mais refuse de regrouper la
    dépense dessus : le filtre des budgets d'environnement et la ventilation de la
    facture restent lettre morte.

    Les quatre clés par défaut sont celles que les `default_tags` posent partout
    (skill aws-infra §2). Activer `Environment` seule ventilerait par
    environnement mais ni par projet ni par propriétaire, et il faudrait attendre
    un mois de facturation de plus pour obtenir la ventilation manquante — AWS ne
    rétro-applique pas une étiquette.

    L'activation vaut pour le **compte entier**, ce qui est la raison d'être de
    cette variable ici plutôt que dans un module composé une fois par
    environnement. La vider désactive les étiquettes plutôt que de les laisser en
    l'état : `aws_ce_cost_allocation_tag` repasse la clé en `Inactive` à sa
    destruction.
  EOT
  type        = set(string)
  default     = ["Environment", "ManagedBy", "Owner", "Project"]

  validation {
    condition     = alltrue([for key in var.cost_allocation_tag_keys : can(regex("^[A-Za-z0-9+=._:/-]{1,128}$", key))])
    error_message = "Chaque entrée de cost_allocation_tag_keys doit être une clé d'étiquette AWS valide : 128 caractères au plus, sans espace."
  }
}

# --- Journaux d'audit (CDC §4.10) ---------------------------------------------
#
# CloudTrail, AWS Config et GuardDuty sont à portée de **compte**, comme les
# étiquettes de répartition de coûts au-dessus. C'est ce qui les met ici plutôt
# que dans un module composé une fois par environnement : trois traces
# multi-région pour un seul compte factureraient trois fois les mêmes événements.

variable "audit_log_retention_days" {
  description = <<-EOT
    Durée de conservation des journaux d'audit dans le bucket, en jours.

    Un an par défaut. C'est le seuil en dessous duquel une intrusion découverte
    tardivement — le délai médian de détection se compte en mois — ne serait plus
    instruisible : les journaux qui la décrivent auraient expiré avant qu'on
    sache qu'il fallait les lire.
  EOT
  type        = number
  default     = 365

  validation {
    condition     = var.audit_log_retention_days >= 90
    error_message = "Moins de 90 jours de journaux d'audit ne couvre pas le délai usuel de découverte d'une intrusion."
  }
}

variable "audit_log_glacier_transition_days" {
  description = "Âge à partir duquel un journal d'audit bascule en `GLACIER_IR`. Passé ce délai, un journal ne se lit plus que pendant une investigation : le stockage à froid divise son coût sans allonger sa restitution."
  type        = number
  default     = 90

  validation {
    condition     = var.audit_log_glacier_transition_days >= 30
    error_message = "S3 refuse une transition vers une classe d'archivage avant 30 jours."
  }
}

# --- CloudTrail ---------------------------------------------------------------

variable "cloudtrail_enabled" {
  description = <<-EOT
    Créer la trace CloudTrail multi-région du compte.

    Vrai par défaut : c'est le critère « CloudTrail activé » de l'issue #79, et
    un compte sans trace ne peut répondre à aucune question posée après un
    incident. Le passer à faux n'a de sens que sur un compte de démonstration où
    une trace existe déjà par ailleurs — la désactiver sur le compte de
    production est une décision à documenter, pas un réglage.

    Le premier trail du compte est gratuit sur les événements de gestion ; seuls
    les événements de données sont facturés, et `cloudtrail.tf` les restreint
    aux objets des buckets d'état.
  EOT
  type        = bool
  default     = true
}

variable "cloudtrail_cloudwatch_retention_days" {
  description = <<-EOT
    Rétention du groupe de journaux CloudWatch qui reçoit la trace, en jours.

    Trente jours, **délibérément beaucoup plus court** que la rétention S3 : les
    deux destinations ne servent pas la même chose. Le bucket archive à bas coût
    et porte la preuve d'intégrité ; le groupe de journaux sert à chercher tout
    de suite et à porter des filtres de métrique. Conserver un an des deux côtés
    multiplierait le coût d'ingestion sans rien ajouter — une investigation qui
    remonte à plus d'un mois se mène sur S3, avec Athena.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.cloudtrail_cloudwatch_retention_days)
    error_message = "cloudtrail_cloudwatch_retention_days doit être une des durées admises par CloudWatch Logs."
  }
}

# --- AWS Config ---------------------------------------------------------------

variable "config_enabled" {
  description = <<-EOT
    Activer l'enregistreur AWS Config, son canal de livraison et ses règles.

    Vrai par défaut, pour la même raison que `cloudtrail_enabled` : c'est la
    preuve **continue** des critères de l'issue #79 qu'aucune relecture ponctuelle
    ne peut remplacer.

    Coût à connaître avant de le laisser à vrai sur un compte chargé : Config
    facture chaque élément de configuration enregistré et chaque évaluation de
    règle. Sur les trois environnements de cette plateforme, l'ordre de grandeur
    reste sous la dizaine de dollars par mois — largement dans la fourchette du
    CDC §4.16, et sans commune mesure avec le coût d'un groupe de sécurité ouvert
    découvert trois semaines trop tard.
  EOT
  type        = bool
  default     = true
}

variable "config_rules" {
  description = <<-EOT
    Règles managées AWS évaluées en continu, indexées par leur nom de règle.

    Chaque entrée du défaut tient **un critère nommé de l'issue #79**, et c'est
    la raison de sa présence — une règle qui ne tient aucun critère est du bruit
    facturé à l'évaluation :

    | Règle | Critère #79 tenu |
    |---|---|
    | `rds-instance-public-access-check` | aucun groupe de sécurité n'expose la base à Internet |
    | `rds-snapshots-public-prohibited` | idem, par le chemin qu'on oublie : l'instantané |
    | `vpc-sg-open-only-to-authorized-ports` | idem — seuls 80 et 443 admettent `0.0.0.0/0` |
    | `restricted-ssh` | idem, sur le port par lequel un bastion se rouvre |
    | `elb-tls-https-listeners-only` | TLS 1.2 minimum sur les communications externes |
    | `elasticache-repl-grp-encrypted-in-transit` | idem, jusqu'au cache |
    | `rds-storage-encrypted` | idem, au repos |
    | `s3-bucket-ssl-requests-only` | idem, sur les buckets d'état et d'audit |
    | `iam-root-access-key-check` | aucune clé d'accès statique sur le compte |
    | `access-keys-rotated` | idem, pour les clés d'utilisateur qu'on croyait supprimées |
    | `iam-policy-no-statements-with-admin-access` | aucun `Resource "*"` non justifié |
    | `iam-user-no-policies-check` | idem — les droits passent par des rôles |
    | `cloud-trail-encryption-enabled` | la trace elle-même reste protégée |
    | `s3-bucket-public-read-prohibited` | le bucket d'audit ne devient pas public |

    `input_parameters` est optionnel et vaut `{}` : `config.tf` le convertit alors
    en `null` plutôt qu'en `"{}"`, une chaîne JSON vide faisant échouer la
    création de certaines règles managées.

    Ajouter une règle ne demande qu'une entrée ici ; le nom de gauche est celui
    qui apparaîtra dans la console, le `source_identifier` est l'identifiant AWS
    en capitales, que la documentation des règles managées donne pour chacune.
  EOT
  type = map(object({
    description       = string
    source_identifier = string
    input_parameters  = optional(map(string), {})
  }))

  default = {
    # --- « Aucun groupe de sécurité n'expose la base à Internet » ---

    rds-instance-public-access-check = {
      description       = "Aucune instance RDS n'est joignable depuis Internet."
      source_identifier = "RDS_INSTANCE_PUBLIC_ACCESS_CHECK"
    }

    rds-snapshots-public-prohibited = {
      description       = "Aucun instantané RDS n'est partagé publiquement — le chemin de fuite qu'on oublie en ne regardant que les groupes de sécurité."
      source_identifier = "RDS_SNAPSHOTS_PUBLIC_PROHIBITED"
    }

    vpc-sg-open-only-to-authorized-ports = {
      description       = "Seuls 80 et 443 admettent une règle entrante depuis 0.0.0.0/0 — c'est l'ALB public, et rien d'autre."
      source_identifier = "VPC_SG_OPEN_ONLY_TO_AUTHORIZED_PORTS"

      # 5432 et 6379 sont volontairement absents : les atteindre depuis Internet
      # est exactement ce que le critère interdit.
      input_parameters = {
        authorizedTcpPorts = "80,443"
      }
    }

    restricted-ssh = {
      description       = "Aucun groupe de sécurité n'ouvre le port 22 sur Internet — l'accès administrateur passe par Session Manager (skill aws-infra §4)."
      source_identifier = "INCOMING_SSH_DISABLED"
    }

    # --- « TLS 1.2 minimum sur toutes les communications externes » ---

    elb-tls-https-listeners-only = {
      description       = "Tout listener d'équilibreur termine en HTTPS. Le port 80 de l'ALB ne fait que rediriger, aucune requête applicative n'y transite en clair."
      source_identifier = "ELB_TLS_HTTPS_LISTENERS_ONLY"
    }

    elasticache-repl-grp-encrypted-in-transit = {
      description       = "Le trafic Redis est chiffré en transit, jeton AUTH compris."
      source_identifier = "ELASTICACHE_REPL_GRP_ENCRYPTED_IN_TRANSIT"
    }

    rds-storage-encrypted = {
      description       = "Le stockage RDS est chiffré au repos par une clé du compte."
      source_identifier = "RDS_STORAGE_ENCRYPTED"
    }

    s3-bucket-ssl-requests-only = {
      description       = "Chaque bucket refuse le transport en clair. Couvre les buckets d'état, qui portent les identifiants de la base, et le bucket d'audit."
      source_identifier = "S3_BUCKET_SSL_REQUESTS_ONLY"
    }

    # --- « Aucune clé d'accès statique sur le compte » ---

    iam-root-access-key-check = {
      description       = "Le compte racine n'a aucune clé d'accès. Une clé racine ne se restreint par aucune politique et ne s'attribue à personne."
      source_identifier = "IAM_ROOT_ACCESS_KEY_CHECK"
    }

    access-keys-rotated = {
      description       = "Aucune clé d'accès d'utilisateur IAM plus vieille que 90 jours. Le dépôt n'en crée aucune — cette règle est là pour voir celle qu'un opérateur aurait créée à la console."
      source_identifier = "ACCESS_KEYS_ROTATED"

      input_parameters = {
        maxAccessKeyAge = "90"
      }
    }

    # --- « Aucun Resource "*" non justifié » ---

    iam-policy-no-statements-with-admin-access = {
      description       = "Aucune politique gérée n'accorde Action \"*\" sur Resource \"*\"."
      source_identifier = "IAM_POLICY_NO_STATEMENTS_WITH_ADMIN_ACCESS"
    }

    iam-user-no-policies-check = {
      description       = "Aucune politique n'est attachée directement à un utilisateur IAM. Les droits passent par des rôles, endossés et traçables."
      source_identifier = "IAM_USER_NO_POLICIES_CHECK"
    }

    # --- La trace elle-même ---

    cloud-trail-encryption-enabled = {
      description       = "Les fichiers CloudTrail sont chiffrés par une clé KMS. Un journal lisible par qui accède au bucket ne protège pas ce qu'il décrit."
      source_identifier = "CLOUD_TRAIL_ENCRYPTION_ENABLED"
    }

    s3-bucket-public-read-prohibited = {
      description       = "Aucun bucket n'est lisible publiquement — à commencer par celui qui contient les journaux d'audit."
      source_identifier = "S3_BUCKET_PUBLIC_READ_PROHIBITED"
    }
  }

  validation {
    condition     = alltrue([for name in keys(var.config_rules) : can(regex("^[A-Za-z0-9._-]{1,128}$", name))])
    error_message = "Un nom de règle Config est limité à 128 caractères parmi lettres, chiffres, point, tiret et souligné."
  }

  validation {
    condition     = alltrue([for rule in values(var.config_rules) : can(regex("^[A-Z0-9_]+$", rule.source_identifier))])
    error_message = "source_identifier doit être l'identifiant AWS d'une règle managée, en capitales et souligné — par exemple RDS_INSTANCE_PUBLIC_ACCESS_CHECK."
  }
}

# --- GuardDuty ----------------------------------------------------------------

variable "guardduty_enabled" {
  description = "Activer le détecteur GuardDuty du compte, ses sources additionnelles et le canal d'alerte qui fait sortir ses constats de la console. Vrai par défaut : c'est le troisième service du critère « GuardDuty, Config et CloudTrail activés »."
  type        = bool
  default     = true
}

variable "guardduty_finding_publishing_frequency" {
  description = <<-EOT
    Fréquence de publication des constats mis à jour — `FIFTEEN_MINUTES`,
    `ONE_HOUR` ou `SIX_HOURS`.

    Quinze minutes par défaut, et non les six heures du défaut d'AWS : le délai
    ne change ni le coût ni le nombre de constats, seulement le temps entre la
    détection et le courriel. Six heures pour apprendre qu'une clé exfiltrée
    énumère le compte, c'est six heures pendant lesquelles elle continue.

    Ce réglage ne concerne que les **mises à jour** d'un constat existant : le
    premier constat d'un type donné est publié immédiatement dans tous les cas.
  EOT
  type        = string
  default     = "FIFTEEN_MINUTES"

  validation {
    condition     = contains(["FIFTEEN_MINUTES", "ONE_HOUR", "SIX_HOURS"], var.guardduty_finding_publishing_frequency)
    error_message = "guardduty_finding_publishing_frequency doit valoir FIFTEEN_MINUTES, ONE_HOUR ou SIX_HOURS."
  }
}

variable "guardduty_features" {
  description = <<-EOT
    Sources additionnelles du détecteur, activées une par une. Chacune a un coût
    et une pertinence propres — les activer en bloc ferait payer l'analyse de
    services que cette plateforme n'utilise pas.

    Le défaut est arbitré sur ce que le CDC décrit :

    * `S3_DATA_EVENTS` — vrai. Les buckets d'état portent les identifiants de la
      base et les ARN de toute l'infrastructure ; une énumération anormale de
      leurs objets est précisément le signal recherché.
    * `EBS_MALWARE_PROTECTION` — faux. Il analyse les volumes EBS d'instances
      EC2, et cette plateforme est en Fargate : il n'y a aucun volume à analyser.
    * `RDS_LOGIN_EVENTS` — vrai. Une salve d'échecs d'authentification sur
      PostgreSQL est le premier signe d'une attaque par dictionnaire, et le
      moteur ne la signale à personne.
    * `EKS_AUDIT_LOGS` — faux. Aucun cluster Kubernetes n'existe ni n'est prévu
      (ADR : ECS Fargate).
    * `LAMBDA_NETWORK_LOGS` — vrai. Les fonctions de la chaîne de notifications
      appellent l'extérieur ; une destination inattendue est un signal.

    Les trois sources de base — journaux CloudTrail, journaux de flux VPC et
    requêtes DNS — ne figurent pas ici : elles sont incluses dans le détecteur et
    ne se désactivent pas.
  EOT
  type        = map(bool)

  default = {
    EBS_MALWARE_PROTECTION = false
    EKS_AUDIT_LOGS         = false
    LAMBDA_NETWORK_LOGS    = true
    RDS_LOGIN_EVENTS       = true
    S3_DATA_EVENTS         = true
  }

  validation {
    condition = alltrue([
      for name in keys(var.guardduty_features) : contains([
        "EBS_MALWARE_PROTECTION",
        "EKS_AUDIT_LOGS",
        "LAMBDA_NETWORK_LOGS",
        "RDS_LOGIN_EVENTS",
        "RUNTIME_MONITORING",
        "S3_DATA_EVENTS",
      ], name)
    ])
    error_message = "guardduty_features ne peut nommer que des fonctionnalités reconnues par aws_guardduty_detector_feature : EBS_MALWARE_PROTECTION, EKS_AUDIT_LOGS, LAMBDA_NETWORK_LOGS, RDS_LOGIN_EVENTS, RUNTIME_MONITORING, S3_DATA_EVENTS."
  }
}

variable "guardduty_min_severity" {
  description = <<-EOT
    Sévérité minimale d'un constat pour qu'il parte par courriel.

    GuardDuty gradue de 1 à 8,9. En dessous de 4, c'est de l'information — un
    scan de port depuis Internet, qui arrive en permanence sur toute adresse
    publique. Faire suivre ce bruit apprendrait à l'équipe à filtrer la boîte de
    réception, ce qui reviendrait à n'avoir aucune alerte.

    Les constats sous le seuil restent visibles dans la console et sur le bus
    d'événements : le seuil filtre la **notification**, pas la détection.
  EOT
  type        = number
  default     = 4

  validation {
    condition     = var.guardduty_min_severity >= 1 && var.guardduty_min_severity <= 8.9
    error_message = "guardduty_min_severity doit être compris entre 1 et 8,9 — l'échelle de sévérité GuardDuty."
  }
}

variable "security_alert_emails" {
  description = <<-EOT
    Adresses abonnées au topic d'alertes de sécurité du compte.

    Vide par défaut : le topic et la règle EventBridge existent alors, les
    constats y sont publiés, et personne ne les lit. C'est un état acceptable le
    temps de l'amorçage et **inacceptable au go-live** (#83) — un
    `-var 'security_alert_emails=["secu@…"]'` suffit à le corriger.

    Distinct des destinataires budgétaires du module `budgets` : ce sont deux
    urgences différentes, qui ne réveillent pas les mêmes personnes.

    Chaque abonnement reste en `PendingConfirmation` tant que son destinataire
    n'a pas cliqué le lien reçu — Terraform crée l'abonnement, il ne le confirme
    pas à sa place.
  EOT
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for email in var.security_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "Chaque entrée de security_alert_emails doit être une adresse électronique."
  }
}
