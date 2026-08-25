variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de chaque ressource, sous la forme `spa-{environment}-{composant}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) >= 2 && length(var.environment) <= 16
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser le tiret que comme séparateur : ni en tête, ni en fin, ni doublé. Un tiret final produirait `spa-{env}--rds`, un identifiant que RDS refuse."
  }
}

variable "vpc_id" {
  description = "VPC d'accueil — sortie `vpc_id` du module network."
  type        = string
}

variable "subnet_ids" {
  description = "Sous-réseaux privés **de données** — sortie `data_subnet_ids` du module network. Ces sous-réseaux n'ont aucune route vers Internet (CDC §4.3) ; le cache s'y pose pour la même raison que la base."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids doit couvrir au moins deux zones de disponibilité : un groupe de sous-réseaux mono-zone interdit la bascule automatique vers un réplica placé ailleurs."
  }
}

variable "allowed_security_group_ids" {
  description = <<-EOT
    Groupes de sécurité autorisés à joindre le port Redis, **par étiquette** —
    `{ ecs_tasks = module.ecs_service.task_security_group_id }`. Référencement par
    identifiant de groupe et jamais par bloc CIDR (skill aws-infra §4). Map vide tant
    que le module ecs-service n'est pas composé : le cache est alors créé sans aucune
    entrée ouverte, ce qui est le bon état par défaut.

    Une map et non une liste : `for_each` exige des clés connues au moment du plan, or
    l'identifiant d'un groupe que le même `apply` doit encore créer ne l'est pas. Avec
    une liste — dont les éléments *sont* les clés — le tout premier plan d'un
    environnement échouerait sur « Invalid for_each argument », et de nouveau à chaque
    remplacement du groupe applicatif. L'étiquette, elle, est écrite par l'appelant :
    elle est connue, stable, et sert d'identité à la règle dans l'état.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for label in keys(var.allowed_security_group_ids) : can(regex("^[A-Za-z0-9 ._:/()-]{1,64}$", label))])
    error_message = "Les étiquettes de allowed_security_group_ids entrent dans la description de la règle, que l'API EC2 restreint : ni accent, ni apostrophe, 64 caractères au plus."
  }
}

# --- Moteur et dimensionnement ------------------------------------------------

variable "engine_version" {
  description = "Version du moteur Redis, sous la forme `majeure.mineure`. La monter est un geste délibéré, dans le code : le module désactive la mise à jour mineure automatique, qui ferait diverger le cluster de sa configuration et ferait proposer sa recréation au plan suivant (voir redis.tf)."
  type        = string
  default     = "7.1"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+$", var.engine_version))
    error_message = "engine_version doit être une version `majeure.mineure`, par exemple `7.1`."
  }
}

variable "node_type" {
  description = "Type de nœud ElastiCache. `cache.t4g.micro` suffit au MVP : le cache ne porte que des sessions, des créneaux calculés et des verrous, jamais une donnée dont la perte serait un incident."
  type        = string
  default     = "cache.t4g.micro"

  validation {
    condition     = can(regex("^cache\\.[a-z0-9]+\\.[a-z0-9]+$", var.node_type))
    error_message = "node_type doit suivre la forme `cache.{famille}.{taille}`, par exemple `cache.t4g.micro`."
  }
}

variable "replica_count" {
  description = "Nombre de réplicas en lecture, en plus du nœud primaire. **1 en production** (skill aws-infra §6) : c'est lui qui rend la bascule automatique possible. `0` ailleurs, où l'indisponibilité du cache dégrade sans interrompre."
  type        = number
  default     = 0

  validation {
    condition     = var.replica_count >= 0 && var.replica_count <= 5
    error_message = "replica_count doit être compris entre 0 et 5 réplicas."
  }
}

variable "multi_az" {
  description = "Répartition du primaire et de ses réplicas sur plusieurs zones, avec bascule automatique. **Vrai en production**, faux ailleurs où le doublement du coût ne se justifie pas. Exige `replica_count >= 1`."
  type        = bool
  default     = false
}

# --- Sauvegardes et fenêtres --------------------------------------------------

variable "snapshot_retention_limit" {
  description = "Rétention des instantanés quotidiens, en jours. `0` les désactive. Un cache se reconstruit, mais repartir d'un instantané évite la vague de requêtes vers la base qui suit un démarrage à froid."
  type        = number
  default     = 1

  validation {
    condition     = var.snapshot_retention_limit >= 0 && var.snapshot_retention_limit <= 35
    error_message = "snapshot_retention_limit doit être compris entre 0 et 35 jours."
  }
}

variable "snapshot_window" {
  description = "Fenêtre quotidienne d'instantané, en UTC, au format `hh:mm-hh:mm`. ElastiCache refuse qu'elle chevauche `maintenance_window`."
  type        = string
  default     = "02:00-03:00"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$", var.snapshot_window))
    error_message = "snapshot_window doit suivre le format `hh:mm-hh:mm` en UTC, avec des heures de 00 à 23."
  }
}

variable "maintenance_window" {
  description = "Fenêtre hebdomadaire de maintenance, en UTC, au format `ddd:hh:mm-ddd:hh:mm`. Distincte de `snapshot_window`."
  type        = string
  default     = "mon:04:30-mon:05:30"

  validation {
    condition     = can(regex("^(mon|tue|wed|thu|fri|sat|sun):([01][0-9]|2[0-3]):[0-5][0-9]-(mon|tue|wed|thu|fri|sat|sun):([01][0-9]|2[0-3]):[0-5][0-9]$", var.maintenance_window))
    error_message = "maintenance_window doit suivre le format `ddd:hh:mm-ddd:hh:mm` en UTC, par exemple `mon:04:30-mon:05:30`."
  }
}

variable "apply_immediately" {
  description = "Application des modifications sans attendre la fenêtre de maintenance. Faux en production : certaines modifications provoquent une bascule de nœud."
  type        = bool
  default     = false
}

# --- Observabilité ------------------------------------------------------------

variable "log_retention_days" {
  description = "Rétention des journaux Redis exportés vers CloudWatch, en jours. 30 hors production, 90 en production (skill aws-infra §8). Sans rétention explicite, CloudWatch conserve indéfiniment et la facture monte sans bruit."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days doit être une des durées acceptées par CloudWatch Logs (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653)."
  }
}

# --- Chiffrement et authentification ------------------------------------------

variable "kms_key_arn" {
  description = "Clé KMS gérée par le client, pour le chiffrement au repos et pour le secret du jeton AUTH. `null` fait créer une clé dédiée par le module. Passer ici la sortie `kms_key_arn` du module database permet de n'en administrer qu'une pour tout le niveau données."
  type        = string
  default     = null
}

variable "kms_deletion_window_in_days" {
  description = "Délai avant destruction effective de la clé créée par le module. Sans ce délai, une suppression accidentelle rend les instantanés chiffrés définitivement illisibles."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days doit être compris entre 7 et 30 jours."
  }
}

variable "auth_token_enabled" {
  description = "Jeton AUTH exigé à la connexion, en plus du chiffrement en transit et de l'isolation réseau. Vrai par défaut : le groupe de sécurité protège du reste du VPC, le jeton protège de ce qui tourne déjà dans le niveau applicatif. Le mettre à faux est un choix explicite d'environnement jetable, pas un oubli."
  type        = bool
  default     = true
}

variable "secret_recovery_window_in_days" {
  description = "Délai de récupération du secret Secrets Manager après suppression. `0` supprime immédiatement — à ne poser que sur un environnement jetable ; ailleurs, ce délai est ce qui permet de revenir sur une destruction lancée par erreur."
  type        = number
  default     = 30

  validation {
    condition     = var.secret_recovery_window_in_days == 0 || (var.secret_recovery_window_in_days >= 7 && var.secret_recovery_window_in_days <= 30)
    error_message = "secret_recovery_window_in_days doit valoir 0 (suppression immédiate) ou être compris entre 7 et 30 jours."
  }
}

# --- Paramètres du moteur -----------------------------------------------------

variable "maxmemory_policy" {
  description = "Politique d'éviction quand le nœud sature. `volatile-lru` n'évince que les clés porteuses d'un délai d'expiration, jamais une clé posée sans TTL. Voir le README : la garantie « zéro double réservation » repose sur la contrainte d'exclusion en base, pas sur la survie d'un verrou Redis."
  type        = string
  default     = "volatile-lru"

  validation {
    condition = contains([
      "noeviction", "allkeys-lru", "allkeys-lfu", "allkeys-random",
      "volatile-lru", "volatile-lfu", "volatile-random", "volatile-ttl",
    ], var.maxmemory_policy)
    error_message = "maxmemory_policy doit être une des politiques d'éviction reconnues par Redis."
  }
}

variable "extra_parameters" {
  description = "Paramètres supplémentaires du groupe de paramètres, par nom. Permet un réglage ponctuel d'environnement sans modifier le module."
  type        = map(string)
  default     = {}
}
