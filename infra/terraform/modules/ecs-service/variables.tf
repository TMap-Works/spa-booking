variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de chaque ressource, sous la forme `spa-{environment}-{composant}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

# --- Réseau -------------------------------------------------------------------
#
# Les trois valeurs ci-dessous sont les sorties du module `network` : `vpc_id`,
# `public_subnet_ids` et `app_subnet_ids`. Elles sont passées en variables plutôt
# que relues par une `data` : un module qui interroge l'API pour retrouver un
# réseau que Terraform vient de créer dépend d'un ordre d'exécution que rien ne
# garantit.

variable "vpc_id" {
  description = "VPC hébergeant l'ALB et les tâches — sortie `vpc_id` du module `network`."
  type        = string
}

variable "public_subnet_ids" {
  description = "Sous-réseaux publics recevant l'ALB — sortie `public_subnet_ids` du module `network`. Deux zones au minimum : un ALB refuse d'être créé sur une seule."
  type        = list(string)

  # `distinct` et non `length` seul : passer deux fois le même sous-réseau
  # satisfait un simple décompte et fait échouer la création de l'ALB, qui exige
  # deux zones. Le module ne peut pas vérifier les zones — il ne voit que des
  # identifiants — mais il peut refuser le doublon, qui en est le cas courant.
  validation {
    condition     = length(distinct(var.public_subnet_ids)) >= 2
    error_message = "public_subnet_ids doit contenir au moins deux sous-réseaux distincts, à placer dans deux zones distinctes."
  }
}

variable "app_subnet_ids" {
  description = "Sous-réseaux privés applicatifs recevant les tâches Fargate — sortie `app_subnet_ids` du module `network`. Jamais les sous-réseaux de données, qui n'ont aucune route sortante."
  type        = list(string)

  validation {
    condition     = length(distinct(var.app_subnet_ids)) >= 2
    error_message = "app_subnet_ids doit contenir au moins deux sous-réseaux distincts, à placer dans deux zones distinctes."
  }
}

# --- Terminaison TLS ----------------------------------------------------------

variable "certificate_arn" {
  description = "Certificat ACM porté par le listener 443 (CDC §4.4). Il doit couvrir tous les noms d'hôte servis par les règles d'écoute — un certificat à SAN multiples plutôt qu'un certificat par application."
  type        = string

  # La forme se contrôle ici ; l'appartenance à la région de l'ALB se contrôle
  # sur le listener, seul endroit où la région du provider est connue — voir la
  # précondition de `aws_lb_listener.https`. Confondre les deux ferait promettre
  # à ce message une vérification que la regex ne fait pas : un certificat
  # `us-east-1` prévu pour CloudFront le satisfait sans problème.
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "certificate_arn doit avoir la forme d'un ARN de certificat ACM."
  }
}

variable "ssl_policy" {
  description = "Politique TLS du listener 443. Le défaut n'accepte que TLS 1.2 et 1.3 ; ne le rabaisser que sur besoin client démontré."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

# --- Services -----------------------------------------------------------------

variable "services" {
  description = <<-EOT
    Applications déployées sur le cluster, indexées par nom court — `api`, `web`.
    La clé sert de nom de conteneur, de famille de définition de tâche et de
    suffixe à toutes les ressources du service.

    Attributs obligatoires :
      * `image`                  image du conteneur, étiquette incluse
      * `ecr_repository_arn`     dépôt ECR autorisé au rôle d'exécution. Aucun
                                 défaut : le module ne délivre pas de droit de
                                 tirage sur `*` à la place de l'appelant.
      * `listener_rule_priority` priorité de la règle d'écoute, unique par ALB

    Les autres attributs ont un défaut aligné sur le CDC : 2 tâches, 2 → 8 en
    auto-scaling, health check sur `/health`.
  EOT

  type = map(object({
    image                  = string
    ecr_repository_arn     = string
    listener_rule_priority = number

    container_port    = optional(number, 3000)
    cpu               = optional(number, 512)
    memory            = optional(number, 1024)
    cpu_architecture  = optional(string, "X86_64")
    desired_count     = optional(number, 2)
    min_capacity      = optional(number, 2)
    max_capacity      = optional(number, 8)
    health_check_path = optional(string, "/health")

    # Conditions de routage. Au moins l'une des deux doit être renseignée :
    # une règle d'écoute sans condition est refusée par l'API.
    host_headers  = optional(list(string), [])
    path_patterns = optional(list(string), [])

    # Délai laissé au conteneur avant que l'ALB ne commence à compter ses échecs
    # de health check. Trop court, une tâche lente à démarrer est tuée en boucle.
    health_check_grace_period_seconds = optional(number, 60)

    command = optional(list(string), null)

    # Variables d'environnement en clair. Tout ce qui est sensible passe par
    # `secret_arns` : le contenu de ce bloc est lisible par quiconque a accès à
    # la console ECS.
    environment = optional(map(string), {})

    # Nom de variable d'environnement → ARN Secrets Manager. La valeur n'est
    # jamais lue par Terraform : l'agent ECS la résout au démarrage de la tâche.
    secret_arns = optional(map(string), {})

    # Politiques attachées au rôle de tâche. Vide par défaut : une application
    # qui n'appelle aucune API AWS n'a besoin d'aucun droit.
    task_role_policy_arns = optional(list(string), [])
  }))

  validation {
    condition     = length(var.services) > 0
    error_message = "services doit décrire au moins une application ; un cluster sans service ne sert à rien."
  }

  validation {
    condition     = alltrue([for name in keys(var.services) : can(regex("^[a-z][a-z0-9-]{1,15}$", name))])
    error_message = "Chaque clé de services doit être en minuscules, de 2 à 16 caractères — elle sert de nom de conteneur et de suffixe de ressource."
  }

  validation {
    condition     = length(distinct([for s in values(var.services) : s.listener_rule_priority])) == length(var.services)
    error_message = "listener_rule_priority doit être unique : deux règles de même priorité sur un même listener sont refusées par l'API."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : s.listener_rule_priority >= 1 && s.listener_rule_priority <= 50000])
    error_message = "listener_rule_priority doit être compris entre 1 et 50000."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : contains(["X86_64", "ARM64"], s.cpu_architecture)])
    error_message = "cpu_architecture doit valoir X86_64 ou ARM64."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : startswith(s.health_check_path, "/")])
    error_message = "health_check_path doit être un chemin absolu, par exemple /health."
  }
}

# --- Dimensionnement et coût --------------------------------------------------

variable "cpu_target_utilization" {
  description = "Cible d'utilisation CPU de l'auto-scaling, en pourcentage (CDC §4.4). Au-delà de 80 %, la montée en charge démarre trop tard pour absorber un pic ; en deçà de 40 %, le cluster tourne à vide et la facture avec."
  type        = number
  default     = 60

  validation {
    condition     = var.cpu_target_utilization > 0 && var.cpu_target_utilization <= 90
    error_message = "cpu_target_utilization doit être strictement positif et ne pas dépasser 90."
  }
}

variable "scale_in_cooldown_seconds" {
  description = "Délai avant une nouvelle réduction du nombre de tâches. Volontairement plus long que la montée : redescendre trop vite fait osciller le service sur une charge en dents de scie."
  type        = number
  default     = 300

  validation {
    condition     = var.scale_in_cooldown_seconds >= 0 && var.scale_in_cooldown_seconds <= 86400
    error_message = "scale_in_cooldown_seconds doit être compris entre 0 et 86400 secondes."
  }
}

variable "scale_out_cooldown_seconds" {
  description = "Délai avant une nouvelle augmentation du nombre de tâches."
  type        = number
  default     = 60

  validation {
    condition     = var.scale_out_cooldown_seconds >= 0 && var.scale_out_cooldown_seconds <= 86400
    error_message = "scale_out_cooldown_seconds doit être compris entre 0 et 86400 secondes."
  }
}

variable "log_retention_days" {
  description = "Rétention des journaux CloudWatch : 30 jours en dev et staging, 90 en production (skill aws-infra §8). Sans rétention explicite, les journaux sont conservés indéfiniment et la facture monte sans bruit."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days doit être l'une des durées acceptées par CloudWatch Logs."
  }
}

variable "container_insights_enabled" {
  description = "Container Insights sur le cluster. Facturé à la métrique : à réserver à la production et à staging, où le diagnostic vaut son prix."
  type        = bool
  default     = false
}

# --- Sécurité et cycle de vie -------------------------------------------------

variable "kms_key_arn" {
  description = "Clé KMS chiffrant les groupes de journaux et les secrets injectés. `null` = clé gérée par AWS. Si elle est renseignée, sa politique doit autoriser `logs.{region}.amazonaws.com` — sinon la création du groupe de journaux échoue."
  type        = string
  default     = null
}

variable "alb_deletion_protection" {
  description = "Protection contre la suppression de l'ALB. `true` en production : détruire l'ALB coupe le service et change son nom DNS."
  type        = bool
  default     = false
}

variable "alb_idle_timeout_seconds" {
  description = "Durée pendant laquelle l'ALB garde une connexion inactive ouverte. Doit rester inférieure au keep-alive du serveur applicatif, faute de quoi l'ALB réutilise une connexion que le serveur vient de fermer et renvoie un 502."
  type        = number
  default     = 60

  validation {
    condition     = var.alb_idle_timeout_seconds >= 1 && var.alb_idle_timeout_seconds <= 4000
    error_message = "alb_idle_timeout_seconds doit être compris entre 1 et 4000 secondes — les bornes admises par l'API Elastic Load Balancing."
  }
}

variable "task_egress_rules" {
  description = <<-EOT
    Sorties supplémentaires du groupe de sécurité des tâches, au-delà du 443
    sortant que le module pose lui-même (ECR, Secrets Manager, CloudWatch Logs,
    API tierces).

    C'est ici que l'environnement ouvre PostgreSQL et Redis, en désignant les
    groupes de sécurité des modules `database` et `cache`. Le sens de la règle
    est délibéré : le module de données déclare son entrée depuis
    `tasks_security_group_id`, ce module déclare sa sortie — aucun des deux ne
    dépend de l'autre, et le cycle entre modules n'existe pas.

    `description` est envoyée telle quelle à l'API EC2, qui refuse les accents et
    les apostrophes.
  EOT

  type = map(object({
    description                  = string
    port                         = number
    cidr_ipv4                    = optional(string)
    referenced_security_group_id = optional(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for rule in values(var.task_egress_rules) :
      (rule.cidr_ipv4 == null) != (rule.referenced_security_group_id == null)
    ])
    error_message = "Chaque règle de task_egress_rules doit désigner exactement une destination : cidr_ipv4 ou referenced_security_group_id, jamais les deux ni aucune."
  }

  validation {
    condition     = alltrue([for rule in values(var.task_egress_rules) : can(regex("^[a-zA-Z0-9 ._:/()#,@[\\]+=&;{}!$*-]*$", rule.description))])
    error_message = "La description d'une règle de groupe de sécurité ne peut porter ni accent ni apostrophe : l'API EC2 la rejette."
  }
}
