variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de chaque ressource, sous la forme `spa-{environment}-{composant}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) >= 2 && length(var.environment) <= 16
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser le tiret que comme séparateur : ni en tête, ni en fin, ni doublé."
  }
}

# --- Ce que le plan protège ---------------------------------------------------

variable "resource_arns" {
  description = <<-EOT
    ARN des ressources protégées, désignées une à une — `[module.database.instance_arn]`.
    C'est la forme à préférer : elle dit dans le code ce qui est sauvegardé, et un
    plan qui ne protège plus rien se voit en revue au lieu de se découvrir le jour
    de la restauration.

    Liste vide et `selection_tags` vide : le coffre et le plan sont créés, aucune
    sélection ne l'est. C'est l'état d'un environnement qui pose sa politique de
    sauvegarde avant de composer sa base.
  EOT
  type        = list(string)
  default     = []
}

variable "selection_tags" {
  description = <<-EOT
    Sélection par étiquette, en complément des ARN — `{ Backup = "daily" }`. Une
    ressource est protégée dès qu'elle porte **toutes** ces étiquettes.

    À manier avec précaution : `{ Environment = "prod" }` embarquerait aussi les
    compartiments S3 de l'environnement, dont celui de l'état Terraform. Le
    filtrage par type de ressource ne se fait pas ici mais dans `not_resources`,
    que ce module n'expose pas — donc, tant que le besoin ne va pas au-delà de
    RDS, `resource_arns` fait mieux le travail.
  EOT
  type        = map(string)
  default     = {}
}

# --- Politique de rétention unifiée (CDC §4.14) -------------------------------

variable "continuous_backup_retention_days" {
  description = <<-EOT
    Rétention de la **sauvegarde continue**, en jours. `0` la désactive.

    C'est la règle qui tient le RPO : elle permet de restaurer à n'importe quel
    instant de la fenêtre, à cinq minutes près, là où un instantané quotidien
    plafonne le RPO à vingt-quatre heures. Le CDC §4.14 vise ≤ 1 h : sans elle,
    la cible n'est pas tenue par AWS Backup.

    Elle exige que la ressource RDS ait ses sauvegardes automatiques activées
    (`backup_retention_period > 0` côté module `database`), et AWS Backup plafonne
    sa rétention à 35 jours.
  EOT
  type        = number
  default     = 35

  validation {
    condition     = var.continuous_backup_retention_days == 0 || (var.continuous_backup_retention_days >= 1 && var.continuous_backup_retention_days <= 35)
    error_message = "continuous_backup_retention_days doit valoir 0 (désactivée) ou un nombre de jours entre 1 et 35 — la borne haute qu'impose AWS Backup à la sauvegarde continue."
  }
}

variable "daily_retention_days" {
  description = "Rétention des instantanés quotidiens, en jours. `0` retire la règle. 30 au moins en production (CDC §4.14)."
  type        = number
  default     = 35

  validation {
    condition     = var.daily_retention_days == 0 || (var.daily_retention_days >= 1 && var.daily_retention_days <= 36500)
    error_message = "daily_retention_days doit valoir 0 (règle retirée) ou un nombre de jours entre 1 et 36500."
  }
}

variable "weekly_retention_days" {
  description = "Rétention des instantanés hebdomadaires, en jours. `0` retire la règle. C'est le palier qui couvre la corruption découverte tardivement — une donnée abîmée un lundi et vue le mois suivant."
  type        = number
  default     = 90

  validation {
    condition     = var.weekly_retention_days == 0 || (var.weekly_retention_days >= 1 && var.weekly_retention_days <= 36500)
    error_message = "weekly_retention_days doit valoir 0 (règle retirée) ou un nombre de jours entre 1 et 36500."
  }
}

variable "monthly_retention_days" {
  description = "Rétention des instantanés mensuels, en jours. `0` retire la règle. Palier d'archive : il sert la preuve et l'audit, pas la reprise d'activité."
  type        = number
  default     = 365

  validation {
    condition     = var.monthly_retention_days == 0 || (var.monthly_retention_days >= 1 && var.monthly_retention_days <= 36500)
    error_message = "monthly_retention_days doit valoir 0 (règle retirée) ou un nombre de jours entre 1 et 36500."
  }
}

# --- Cadences -----------------------------------------------------------------

variable "continuous_schedule" {
  description = "Cadence de rafraîchissement de la sauvegarde continue, en UTC. Elle ne déclenche pas un instantané : elle vérifie que la fenêtre de restauration reste ouverte."
  type        = string
  default     = "cron(0 1 * * ? *)"

  validation {
    condition     = can(regex("^cron\\(.+\\)$", var.continuous_schedule))
    error_message = "continuous_schedule doit être une expression `cron(...)` au format AWS — six champs, en UTC."
  }
}

variable "daily_schedule" {
  description = <<-EOT
    Cadence quotidienne, en UTC. Placée après la fenêtre de sauvegarde RDS du
    module `database` (02:00-03:00 UTC par défaut) : deux instantanés simultanés
    de la même instance allongent chacun l'autre.

    Elle chevauche en revanche la **fenêtre de maintenance** de ce même module —
    `mon:03:30-mon:04:30` par défaut. C'est assumé plutôt que corrigé : les
    créneaux voisins sont pris par les cadences hebdomadaire et mensuelle, et
    `start_window_minutes` (60 min) couvre largement le retard qu'une maintenance
    du lundi peut causer. Si le travail du lundi expirait malgré tout, l'alarme
    `-jobs-expired` le dirait, et c'est alors cette valeur qu'il faut décaler.
  EOT
  type        = string
  default     = "cron(0 4 * * ? *)"

  validation {
    condition     = can(regex("^cron\\(.+\\)$", var.daily_schedule))
    error_message = "daily_schedule doit être une expression `cron(...)` au format AWS — six champs, en UTC."
  }
}

variable "weekly_schedule" {
  description = "Cadence hebdomadaire, en UTC. Le dimanche, hors des heures d'ouverture des salons."
  type        = string
  default     = "cron(0 5 ? * SUN *)"

  validation {
    condition     = can(regex("^cron\\(.+\\)$", var.weekly_schedule))
    error_message = "weekly_schedule doit être une expression `cron(...)` au format AWS — six champs, en UTC."
  }
}

variable "monthly_schedule" {
  description = "Cadence mensuelle, en UTC. Le premier du mois."
  type        = string
  default     = "cron(0 6 1 * ? *)"

  validation {
    condition     = can(regex("^cron\\(.+\\)$", var.monthly_schedule))
    error_message = "monthly_schedule doit être une expression `cron(...)` au format AWS — six champs, en UTC."
  }
}

variable "start_window_minutes" {
  description = "Délai laissé à un travail de sauvegarde pour démarrer après l'heure prévue. Passé ce délai, AWS Backup le marque `EXPIRED` — c'est ce que surveille l'alarme du même nom."
  type        = number
  default     = 60

  validation {
    condition     = var.start_window_minutes >= 60
    error_message = "start_window_minutes doit valoir au moins 60 : AWS Backup refuse une fenêtre de démarrage plus courte."
  }
}

variable "completion_window_minutes" {
  description = "Délai laissé à un travail pour se terminer, à compter de son heure prévue. Trop court, un instantané d'une base qui a grossi est annulé au milieu."
  type        = number
  default     = 480

  validation {
    condition     = var.completion_window_minutes >= 120
    error_message = "completion_window_minutes doit valoir au moins 120 minutes."
  }
}

# --- Coffre -------------------------------------------------------------------

variable "kms_key_arn" {
  description = "Clé KMS qui chiffre les points de restauration du coffre. `null` fait créer une clé dédiée par le module. **Ne pas réemployer la clé du module `database`** : une sauvegarde chiffrée par la clé de ce qu'elle sauvegarde disparaît avec elle."
  type        = string
  default     = null
}

variable "kms_deletion_window_in_days" {
  description = "Délai avant destruction effective de la clé créée par le module. Sans ce délai, une suppression accidentelle rend tous les points de restauration définitivement illisibles."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days doit être compris entre 7 et 30 jours."
  }
}

variable "force_destroy" {
  description = "Autorise `terraform destroy` à supprimer le coffre **avec ses points de restauration**. Vrai uniquement sur un environnement jetable ; une précondition le refuse en production."
  type        = bool
  default     = false
}

variable "vault_lock" {
  description = <<-EOT
    Verrou de coffre en mode **gouvernance** : AWS Backup refuse alors de
    raccourcir une rétention ou de supprimer un point de restauration avant son
    terme, sauf à un principal explicitement autorisé à lever le verrou.

    `null` — le défaut — ne pose aucun verrou. Renseigné, l'objet borne les
    rétentions que le coffre accepte.

    Le mode **conformité** n'est délibérément pas exposé : il est irréversible
    passé son délai de grâce, y compris pour la racine du compte, et un plafond
    de rétention mal saisi immobiliserait alors le coffre — et sa facture —
    jusqu'à l'expiration du dernier point. Ce n'est pas une décision qui se prend
    dans une variable Terraform.
  EOT
  type = object({
    min_retention_days = number
    max_retention_days = number
  })
  default = null

  validation {
    condition     = var.vault_lock == null || try(var.vault_lock.min_retention_days >= 1 && var.vault_lock.max_retention_days > var.vault_lock.min_retention_days, false)
    error_message = "vault_lock exige min_retention_days ≥ 1 et max_retention_days strictement supérieur à min_retention_days."
  }
}

# --- Restauration -------------------------------------------------------------

variable "restore_kms_key_arns" {
  description = <<-EOT
    Clés KMS supplémentaires que le rôle de sauvegarde doit pouvoir employer :
    celle qui chiffre l'instance source — `module.database.kms_key_arn` — et toute
    clé sous laquelle un point de restauration doit être rétabli.

    Sans la clé source, le travail de sauvegarde échoue à lire le volume chiffré ;
    sans la clé cible, c'est la **restauration** qui échoue — et on l'apprend le
    jour où elle compte.
  EOT
  type        = list(string)
  default     = []
}

# --- Supervision --------------------------------------------------------------

variable "alarm_topic_arns" {
  description = "Topics SNS notifiés par les alarmes — `[module.budgets.alerts_topic_arn]`. Vide, les alarmes existent et changent d'état sans prévenir personne."
  type        = list(string)
  default     = []
}

variable "missing_backup_period_hours" {
  description = "Fenêtre sur laquelle l'alarme « aucune sauvegarde terminée » compte les succès. Doit couvrir largement la cadence la plus lente qui compte pour la reprise — la quotidienne."
  type        = number
  default     = 24

  validation {
    condition     = var.missing_backup_period_hours >= 1 && var.missing_backup_period_hours <= 24
    error_message = "missing_backup_period_hours doit être compris entre 1 et 24 : CloudWatch plafonne la période d'une alarme à 86 400 secondes."
  }
}
