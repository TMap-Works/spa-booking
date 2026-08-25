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
  description = "Sous-réseaux privés **de données** — sortie `data_subnet_ids` du module network. Ces sous-réseaux n'ont aucune route vers Internet (CDC §4.3) ; y poser la base est ce qui rend vraie la règle « aucune base joignable depuis Internet »."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids doit couvrir au moins deux zones de disponibilité : un groupe de sous-réseaux RDS mono-zone interdit le passage en Multi-AZ et le rétablissement dans une autre zone."
  }
}

variable "allowed_security_group_ids" {
  description = <<-EOT
    Groupes de sécurité autorisés à joindre le port PostgreSQL, **par étiquette** —
    `{ ecs_tasks = module.ecs_service.task_security_group_id }`. Référencement par
    identifiant de groupe et jamais par bloc CIDR (skill aws-infra §4). Map vide tant
    que le module ecs-service n'est pas composé : la base est alors créée sans aucune
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
  description = "Version du moteur PostgreSQL. `16` laisse RDS choisir la version mineure par défaut de la famille, et `auto_minor_version_upgrade` la fait suivre ; figer une mineure précise oblige à la mettre à jour à la main avant qu'elle ne soit dépréciée."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.engine_version))
    error_message = "engine_version doit rester dans la famille PostgreSQL 16 (CDC §4.5) : `16` ou `16.x`."
  }
}

variable "instance_class" {
  description = "Classe d'instance RDS. `db.t4g.medium` d'après le dimensionnement du CDC §4.15 — c'est aussi le plancher : Performance Insights, activé en dur par ce module, n'est pas proposé sur les tailles `micro` et `small`."
  type        = string
  default     = "db.t4g.medium"

  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.instance_class)) && !can(regex("\\.(micro|small)$", var.instance_class))
    error_message = "instance_class doit suivre la forme `db.{famille}.{taille}` et ne peut être ni `micro` ni `small` : RDS ne propose pas Performance Insights sur ces tailles, et le module l'active en dur. L'`apply` échouerait sur un message qui ne désigne pas la cause."
  }
}

variable "allocated_storage" {
  description = "Stockage initial, en gibioctets. Le minimum gp3 est de 20 Gio."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage >= 20
    error_message = "allocated_storage doit valoir au moins 20 Gio — le minimum imposé par le type de stockage gp3."
  }
}

variable "max_allocated_storage" {
  description = "Plafond de l'extension automatique du stockage. `0` la désactive — auquel cas une base pleine cesse d'accepter les écritures."
  type        = number
  default     = 100

  # La cohérence avec `allocated_storage` est vérifiée par une précondition sur
  # l'instance (rds.tf) et non ici : une règle de validation ne peut lire une
  # autre variable qu'à partir de Terraform 1.9, et ce module s'accommode de 1.6.
  validation {
    condition     = var.max_allocated_storage == 0 || var.max_allocated_storage >= 20
    error_message = "max_allocated_storage doit valoir 0 (extension désactivée) ou au moins 20 Gio."
  }
}

# --- Résilience et sauvegardes ------------------------------------------------

variable "multi_az" {
  description = "Bascule automatique vers une instance de secours dans une autre zone. **Vrai en production** (CDC §4.5), faux ailleurs où le doublement du coût ne se justifie pas."
  type        = bool
  default     = false
}

variable "backup_retention_period" {
  description = "Rétention des sauvegardes automatiques, en jours. **7 hors production, 30 en production** (CDC §4.5 et §4.14)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_period >= 7 && var.backup_retention_period <= 35
    error_message = "backup_retention_period doit être compris entre 7 et 35 jours : en deçà de 7 le CDC §4.14 n'est plus tenu, au-delà de 35 RDS refuse la valeur."
  }
}

variable "backup_window" {
  description = "Fenêtre quotidienne de sauvegarde, en UTC, au format `hh:mm-hh:mm`. Placée aux heures creuses des salons."
  type        = string
  default     = "02:00-03:00"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$", var.backup_window))
    error_message = "backup_window doit suivre le format `hh:mm-hh:mm` en UTC, avec des heures de 00 à 23."
  }
}

variable "maintenance_window" {
  description = "Fenêtre hebdomadaire de maintenance, en UTC, au format `ddd:hh:mm-ddd:hh:mm`. Distincte de `backup_window`, que RDS refuse de chevaucher."
  type        = string
  default     = "mon:03:30-mon:04:30"

  validation {
    condition     = can(regex("^(mon|tue|wed|thu|fri|sat|sun):([01][0-9]|2[0-3]):[0-5][0-9]-(mon|tue|wed|thu|fri|sat|sun):([01][0-9]|2[0-3]):[0-5][0-9]$", var.maintenance_window))
    error_message = "maintenance_window doit suivre le format `ddd:hh:mm-ddd:hh:mm` en UTC, par exemple `mon:03:30-mon:04:30`."
  }
}

variable "deletion_protection" {
  description = "Refus par l'API RDS de supprimer l'instance. **Vrai en production.** Ce n'est pas une protection contre l'erreur humaine seulement : c'est aussi ce qui arrête un `terraform destroy` lancé sur le mauvais répertoire."
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "Suppression sans instantané final. Vrai uniquement sur un environnement jetable ; faux partout où la donnée compte."
  type        = bool
  default     = false
}

# --- Observabilité ------------------------------------------------------------

variable "performance_insights_retention_period" {
  description = "Rétention de Performance Insights, en jours. `7` reste dans l'offre gratuite ; au-delà, la valeur doit être 731 ou un multiple de 31."
  type        = number
  default     = 7

  # Les bornes comptent autant que le multiple : sans elles, `0` — la valeur qu'on
  # écrit pour « désactiver » — satisfait `% 31 == 0` et passe le plan, alors que
  # Performance Insights est activé en dur et que RDS refusera `0` à l'`apply`.
  validation {
    condition = (
      var.performance_insights_retention_period == 7
      || var.performance_insights_retention_period == 731
      || (var.performance_insights_retention_period % 31 == 0
        && var.performance_insights_retention_period >= 31
      && var.performance_insights_retention_period <= 713)
    )
    error_message = "performance_insights_retention_period doit valoir 7, 731, ou un multiple de 31 compris entre 31 et 713 — les seules valeurs acceptées par RDS. Performance Insights est activé en dur : il n'y a pas de valeur qui le désactive."
  }
}

variable "monitoring_interval" {
  description = "Période de collecte du monitoring renforcé, en secondes. `0` le désactive. Toute autre valeur exige `monitoring_role_arn`."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1, 5, 10, 15, 30, 60], var.monitoring_interval)
    error_message = "monitoring_interval doit valoir 0, 1, 5, 10, 15, 30 ou 60."
  }
}

variable "monitoring_role_arn" {
  description = "Rôle IAM utilisé par le monitoring renforcé pour publier ses métriques. Le module ne le crée pas : les rôles IAM de la plateforme sont composés au niveau de l'environnement."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "Rétention des journaux PostgreSQL exportés vers CloudWatch, en jours. 30 hors production, 90 en production (skill aws-infra §8). Sans rétention explicite, CloudWatch conserve indéfiniment et la facture monte sans bruit."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days doit être une des durées acceptées par CloudWatch Logs (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653)."
  }
}

# --- Base, accès et chiffrement -----------------------------------------------

variable "database_name" {
  description = "Nom de la base créée à l'initialisation."
  type        = string
  default     = "spa"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name doit commencer par une lettre minuscule et ne contenir que des minuscules, des chiffres et des tirets bas."
  }
}

variable "master_username" {
  description = "Nom du compte maître. Son mot de passe n'est **pas** une variable : il est généré par RDS et déposé dans Secrets Manager (voir rds.tf)."
  type        = string
  default     = "spa_admin"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{2,62}$", var.master_username)) && !contains(["postgres", "admin", "rdsadmin"], var.master_username)
    error_message = "master_username doit être en minuscules et ne peut être ni `postgres`, ni `admin`, ni `rdsadmin` — noms réservés ou devinés en premier."
  }
}

variable "kms_key_arn" {
  description = "Clé KMS gérée par le client, pour le stockage, les instantanés, Performance Insights et le secret du mot de passe maître. `null` fait créer une clé dédiée par le module. En fournir une permet de partager la même clé avec le module cache."
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

variable "iam_database_authentication_enabled" {
  description = "Connexion à la base par jeton IAM, en plus du mot de passe. C'est ce qui permet à un opérateur d'ouvrir une session via Session Manager sans qu'aucune clé statique ne circule (skill aws-infra §4)."
  type        = bool
  default     = true
}

# --- Paramètres du moteur -----------------------------------------------------

variable "allowed_extensions" {
  description = "Extensions PostgreSQL autorisées à l'installation (`rds.allowed_extensions`). `btree_gist` est **obligatoire** : c'est elle qui rend une contrainte d'exclusion possible sur une paire (identifiant, plage de temps), donc la garantie « zéro double réservation » du CDC. Liste vide = paramètre non posé, RDS retombe alors sur `*`."
  type        = list(string)
  default     = ["btree_gist", "pg_stat_statements", "pgcrypto", "citext"]

  validation {
    condition     = length(var.allowed_extensions) == 0 || contains(var.allowed_extensions, "btree_gist")
    error_message = "allowed_extensions doit contenir `btree_gist` : sans elle, `CREATE EXTENSION btree_gist` est refusé et la contrainte d'exclusion qui empêche les doubles réservations ne peut pas être créée."
  }
}

variable "log_min_duration_statement" {
  description = "Seuil, en millisecondes, au-delà duquel une requête est journalisée. `-1` désactive la journalisation des requêtes lentes."
  type        = number
  default     = 1000
}

variable "extra_parameters" {
  description = "Paramètres supplémentaires du groupe de paramètres, par nom. `apply_method` vaut `immediate` par défaut ; un paramètre statique exige `pending-reboot`, sinon l'`apply` échoue."
  type = map(object({
    value        = string
    apply_method = optional(string, "immediate")
  }))
  default = {}
}

variable "apply_immediately" {
  description = "Application des modifications sans attendre la fenêtre de maintenance. Faux en production : certaines modifications provoquent un redémarrage."
  type        = bool
  default     = false
}
