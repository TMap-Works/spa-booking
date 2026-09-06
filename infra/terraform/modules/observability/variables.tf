variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de chaque alarme et du tableau de bord, sous la forme `spa-{environment}-{composant}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

# --- Canal de notification ----------------------------------------------------

variable "alarm_topic_arns" {
  description = <<-EOT
    Topics SNS notifiés à l'entrée **et à la sortie** de chaque alarme. Vide par
    défaut : les alarmes existent alors et restent consultables, mais ne
    préviennent personne — ce qui est exactement le piège que ce module est censé
    fermer.

    Le topic attendu est celui du module `budgets` — `alerts_topic_arn` —, dont
    le commentaire prévoit explicitement que les alarmes d'observabilité s'y
    branchent plutôt que d'en créer un second. Sa politique nomme
    `cloudwatch.amazonaws.com` : sans cet énoncé, une alarme change bien d'état
    dans la console mais aucune notification ne part.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.alarm_topic_arns : can(regex("^arn:aws[a-z-]*:sns:", arn))])
    error_message = "Chaque entrée de alarm_topic_arns doit être un ARN de topic SNS."
  }
}

variable "alarm_period_seconds" {
  description = "Période d'évaluation commune à toutes les alarmes, en secondes. Cinq minutes par défaut : assez court pour qu'un incident se sache dans le quart d'heure, assez long pour ne pas transformer une secousse d'une minute en salve de notifications. C'est aussi cette période qui, multipliée par `ecs.evaluation_periods`, donne les dix minutes du seuil CPU du CDC §4.11."
  type        = number
  default     = 300

  validation {
    condition     = contains([60, 300, 900, 3600], var.alarm_period_seconds)
    error_message = "alarm_period_seconds doit valoir 60, 300, 900 ou 3600 secondes."
  }
}

# --- Point d'entrée public ----------------------------------------------------

# Un objet nullable plutôt que trois variables scalaires nullables, et ce n'est
# pas une question de goût : `arn_suffix` est un attribut calculé de l'ALB, donc
# **inconnu au plan** du premier `apply`. Un `count = var.alb_arn_suffix == null`
# comparerait une valeur inconnue et Terraform s'arrêterait sur « count depends
# on resource attributes that cannot be determined until apply ». La nullité de
# l'objet, elle, se lit dans la configuration : elle est connue au plan, même
# quand tous ses attributs sont inconnus. Même raison pour `ecs` et `rds`.
variable "alb" {
  description = <<-EOT
    Application Load Balancer à superviser, ou `null` si l'environnement n'en
    compose pas encore.

      * `arn_suffix`              sortie `alb_arn_suffix` du module `ecs-service`
                                  — la forme que réclament les dimensions
                                  CloudWatch, pas l'ARN complet
      * `error_rate_percent`      seuil de la part de réponses 5xx (CDC §4.11)
      * `min_requests_per_period` trafic en deçà duquel le taux n'est pas évalué
      * `p99_latency_seconds`     seuil de latence au 99e centile
  EOT

  type = object({
    arn_suffix = string

    error_rate_percent = optional(number, 1)

    # Sans plancher de trafic, une seule requête en erreur sur une seule requête
    # servie fait 100 % de 5xx et réveille l'astreinte pour un robot d'indexation
    # tombé sur une URL morte à 4 h du matin. Vingt requêtes sur cinq minutes,
    # c'est le seuil en dessous duquel un pourcentage ne veut rien dire.
    min_requests_per_period = optional(number, 20)

    p99_latency_seconds = optional(number, 2)
  })

  default = null

  validation {
    condition     = var.alb == null || try(var.alb.error_rate_percent > 0 && var.alb.error_rate_percent <= 100, false)
    error_message = "alb.error_rate_percent doit être strictement positif et ne pas dépasser 100."
  }

  validation {
    condition     = var.alb == null || try(var.alb.min_requests_per_period >= 1, false)
    error_message = "alb.min_requests_per_period doit valoir au moins 1 : à zéro, le taux d'erreur se calculerait sur une division par zéro."
  }

  validation {
    condition     = var.alb == null || try(var.alb.p99_latency_seconds > 0, false)
    error_message = "alb.p99_latency_seconds doit être strictement positif."
  }
}

# --- Compute ------------------------------------------------------------------

variable "ecs" {
  description = <<-EOT
    Services ECS à superviser, ou `null` si l'environnement n'en compose pas
    encore.

      * `cluster_name`       sortie `cluster_name` du module `ecs-service`
      * `service_names`      sortie `service_names` du même module : clé courte
                             du service → nom réel. La clé sert à nommer l'alarme,
                             la valeur à la dimensionner.
      * `cpu_percent`        seuil d'utilisation CPU (CDC §4.11)
      * `evaluation_periods` nombre de périodes consécutives au-dessus du seuil
  EOT

  type = object({
    cluster_name  = string
    service_names = map(string)

    cpu_percent = optional(number, 80)

    # Deux périodes de cinq minutes : le seuil du CDC est « au-dessus de 80 %
    # pendant dix minutes », et non « au-dessus de 80 % ». La différence est
    # tout l'intérêt de l'alarme — l'auto-scaling monte à 60 % de cible, un pic
    # bref est donc le fonctionnement normal, pas un incident.
    evaluation_periods = optional(number, 2)
  })

  default = null

  validation {
    condition     = var.ecs == null || try(var.ecs.cpu_percent > 0 && var.ecs.cpu_percent <= 100, false)
    error_message = "ecs.cpu_percent doit être strictement positif et ne pas dépasser 100."
  }

  validation {
    condition     = var.ecs == null || try(var.ecs.evaluation_periods >= 1, false)
    error_message = "ecs.evaluation_periods doit valoir au moins 1."
  }
}

# --- Base de données ----------------------------------------------------------

variable "rds" {
  description = <<-EOT
    Instance RDS à superviser, ou `null` si l'environnement n'en compose pas
    encore.

      * `instance_id`            sortie `instance_id` du module `database`
      * `max_connections`        nombre maximal de connexions **du moteur**, dont
                                 le seuil d'alarme est un pourcentage. RDS le
                                 calcule par `LEAST({DBInstanceClassMemory/9531392}, 5000)`
                                 et ne l'expose par aucune métrique : il n'y a
                                 donc rien à en déduire côté Terraform, il faut
                                 le dire. Changer `instance_class` oblige à
                                 revoir cette valeur.
      * `allocated_storage_gib`  sortie `allocated_storage` du module `database`
      * `connections_percent`    seuil de saturation des connexions (CDC §4.11)
      * `free_storage_percent`   plancher d'espace disque libre (CDC §4.11)
  EOT

  type = object({
    instance_id           = string
    max_connections       = number
    allocated_storage_gib = number

    connections_percent  = optional(number, 80)
    free_storage_percent = optional(number, 20)
  })

  default = null

  validation {
    condition     = var.rds == null || try(var.rds.max_connections >= 1, false)
    error_message = "rds.max_connections doit valoir au moins 1 — c'est le dénominateur du seuil de saturation."
  }

  validation {
    condition     = var.rds == null || try(var.rds.allocated_storage_gib >= 1, false)
    error_message = "rds.allocated_storage_gib doit valoir au moins 1 Gio — c'est la base du seuil d'espace libre."
  }

  validation {
    condition     = var.rds == null || try(var.rds.connections_percent > 0 && var.rds.connections_percent <= 100, false)
    error_message = "rds.connections_percent doit être strictement positif et ne pas dépasser 100."
  }

  validation {
    condition     = var.rds == null || try(var.rds.free_storage_percent > 0 && var.rds.free_storage_percent < 100, false)
    error_message = "rds.free_storage_percent doit être strictement compris entre 0 et 100."
  }
}

# --- Traitements asynchrones --------------------------------------------------

variable "dead_letter_queues" {
  description = <<-EOT
    Files d'attente mortes à surveiller : clé courte → **nom** de la file (pas
    son URL, pas son ARN — la dimension CloudWatch `QueueName` attend le nom).
    Tout message qui s'y trouve déclenche l'alarme : une DLQ n'a pas de
    profondeur acceptable.

    Vide par défaut, et vide en pratique tant que la seule file du projet est
    celle de la chaîne de notifications : le module `notifications` pose déjà
    l'alarme de sa DLQ (#67), avec la description qui va avec. La reposer ici
    enverrait deux notifications pour le même message. Cette entrée existe pour
    la file suivante, celle qui n'aura pas de module à elle.
  EOT
  type        = map(string)
  default     = {}
}

variable "lambda_functions" {
  description = <<-EOT
    Fonctions Lambda à surveiller : clé courte → nom de la fonction. Toute erreur
    déclenche l'alarme.

    Vide par défaut, pour la même raison que `dead_letter_queues` : la Lambda
    d'envoi des notifications porte déjà la sienne.
  EOT
  type        = map(string)
  default     = {}
}

# --- Tableau de bord ----------------------------------------------------------

variable "create_dashboard" {
  description = "Crée le tableau de bord transverse de l'environnement. Vrai par défaut. Les trois premiers tableaux de bord d'un compte sont gratuits ; au-delà, chacun est facturé — d'où la possibilité d'y renoncer sur un environnement où les alarmes suffisent."
  type        = bool
  default     = true
}

# --- Traçage distribué --------------------------------------------------------

variable "tracing" {
  description = <<-EOT
    Règle d'échantillonnage X-Ray de l'environnement.

    Le traçage lui-même s'active côté tâche — sidecar `aws-xray-daemon` et droit
    de publier, tous deux portés par le module `ecs-service`. Ce qui se règle
    ici, c'est **combien** de requêtes sont tracées : une règle d'échantillonnage
    est une ressource de compte, pas de service, et sa place est donc dans le
    module d'observabilité.

      * `enabled`        crée la règle. À faux, X-Ray retombe sur sa règle
                         `Default` — 1 requête par seconde puis 5 %, pour tout
                         le compte, sans distinction d'environnement.
      * `service_name`   filtre sur le nom de service déclaré par l'application.
                         `null` le remplace par `spa-{environment}-*`, ce qui
                         empêche la règle de dev de gouverner l'échantillonnage
                         de la production — les trois environnements partagent un
                         compte, donc un jeu de règles. Ce filtre n'a de sens que
                         parce que `ecs-service` pose
                         `AWS_XRAY_TRACING_NAME=spa-{env}-{service}` sur les
                         tâches tracées : changer l'un sans l'autre rend la règle
                         inatteignable, et X-Ray retombe sans bruit sur sa règle
                         `Default`.
      * `fixed_rate`     part des requêtes tracées au-delà du réservoir
      * `reservoir_size` requêtes tracées par seconde avant d'appliquer le taux ;
                         c'est ce qui garantit de voir quelque chose sur un
                         environnement à faible trafic
      * `priority`       rang d'évaluation, du plus petit au plus grand. Doit
                         rester sous les 10 000 de la règle `Default`, sans quoi
                         la règle ne serait jamais atteinte.
  EOT

  type = object({
    enabled        = optional(bool, true)
    service_name   = optional(string, null)
    fixed_rate     = optional(number, 0.05)
    reservoir_size = optional(number, 1)
    priority       = optional(number, 9000)
  })

  default = {}

  # Non nullable, contrairement à `alb`, `ecs` et `rds` : c'est `enabled` qui
  # débranche la règle, et un `null` ici ferait échouer la lecture de ses
  # attributs sur un message qui ne dirait pas laquelle des deux formes on
  # voulait.
  nullable = false

  validation {
    condition     = var.tracing.fixed_rate >= 0 && var.tracing.fixed_rate <= 1
    error_message = "tracing.fixed_rate est une proportion : elle doit être comprise entre 0 et 1, pas exprimée en pourcentage."
  }

  validation {
    condition     = var.tracing.reservoir_size >= 0
    error_message = "tracing.reservoir_size ne peut pas être négatif."
  }

  validation {
    condition     = var.tracing.priority >= 1 && var.tracing.priority < 10000
    error_message = "tracing.priority doit être comprise entre 1 et 9999 : la règle `Default` de X-Ray occupe la priorité 10000, et toute règle placée après elle est inatteignable."
  }
}
