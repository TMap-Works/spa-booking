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
  description = <<-EOT
    Politique TLS du listener 443. Le défaut n'accepte que TLS 1.2 et 1.3.

    La liste admise ci-dessous est **fermée**, et c'est le point : « TLS 1.2
    minimum sur toutes les communications externes » est un critère de sécurité
    (CDC §4.10, #79), pas une préférence. Tant que cette exigence ne vivait que
    dans la description, un environnement pouvait passer
    `ELBSecurityPolicy-2016-08` — qui accepte encore TLS 1.0 — et le plan
    l'aurait appliqué sans rien dire. Elle vit maintenant dans le plan.

    Toutes les politiques nommées ici imposent TLS 1.2 au minimum. Celles qu'AWS
    propose et qui n'y figurent pas — `ELBSecurityPolicy-2016-08`,
    `ELBSecurityPolicy-TLS-1-0-2015-04`, `ELBSecurityPolicy-TLS-1-1-2017-01`,
    `ELBSecurityPolicy-FS-2018-06`, `ELBSecurityPolicy-FS-1-1-2019-08` — sont
    exclues parce qu'elles négocient TLS 1.0 ou 1.1.

    Une politique nouvellement publiée par AWS s'ajoute ici, dans une pull
    request qui dit laquelle et pourquoi.
  EOT
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  validation {
    condition = contains([
      # Familles TLS 1.3 — TLS 1.2 en plancher, 1.3 négocié quand le client sait.
      "ELBSecurityPolicy-TLS13-1-2-2021-06",
      "ELBSecurityPolicy-TLS13-1-2-Res-2021-06",
      "ELBSecurityPolicy-TLS13-1-2-Ext1-2021-06",
      "ELBSecurityPolicy-TLS13-1-2-Ext2-2021-06",
      # TLS 1.3 seul : plancher plus haut encore, au prix des clients anciens.
      "ELBSecurityPolicy-TLS13-1-3-2021-06",
      # Familles TLS 1.2, sans 1.3.
      "ELBSecurityPolicy-TLS-1-2-2017-01",
      "ELBSecurityPolicy-TLS-1-2-Ext-2018-06",
      # Confidentialité persistante, plancher 1.2.
      "ELBSecurityPolicy-FS-1-2-2019-08",
      "ELBSecurityPolicy-FS-1-2-Res-2019-08",
      "ELBSecurityPolicy-FS-1-2-Res-2020-10",
    ], var.ssl_policy)
    error_message = "ssl_policy doit être une politique imposant TLS 1.2 au minimum (CDC §4.10). `ELBSecurityPolicy-2016-08`, `-TLS-1-0-2015-04`, `-TLS-1-1-2017-01`, `-FS-2018-06` et `-FS-1-1-2019-08` négocient TLS 1.0 ou 1.1 et sont refusées."
  }
}

# --- Origine publique ---------------------------------------------------------

variable "public_base_url" {
  description = <<-EOT
    Origine sous laquelle ce déploiement est vu de l'extérieur — celle qu'un
    visiteur tape, qu'un moteur de recherche indexe et qu'un lien de notification
    porte. Sans barre oblique finale ni chemin : c'est une **origine**, pas une
    URL de base.

    `null` — le défaut — la déduit du nom DNS de l'ALB créé par ce module :
    `https://<dns>`. C'est ce qui permet à un environnement de renseigner
    `public_url_env_vars` sans rien connaître de l'ALB, et c'est le point : lire
    la sortie `alb_dns_name` pour construire une entrée de ce même module serait
    un cycle que Terraform refuse. La dérivation a lieu **dans** le module, où
    l'ALB et la définition de tâche sont deux ressources ordinaires — la seconde
    dépend de la première, et rien ne revient en arrière.

    À renseigner dès qu'un nom de domaine existe : le nom DNS d'un ALB n'est pas
    une adresse à publier, et il change si l'ALB est recréé.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.public_base_url == null || can(regex("^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$", var.public_base_url))
    error_message = "public_base_url doit être `null` ou une origine en `https://` sans chemin ni barre oblique finale, par exemple `https://reservation.exemple.fr`."
  }
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

    # Variables qui reçoivent l'origine publique du déploiement — `public_base_url`
    # si elle est fournie, le nom DNS de l'ALB sinon. C'est ce qui donne à un
    # conteneur son `APP_URL` sans qu'aucune valeur ne remonte à l'appelant.
    #
    # Une origine publique n'est pas un secret : elle est publique par
    # définition. Elle passait pourtant par Secrets Manager faute de pouvoir être
    # calculée hors du module, ce qui accordait au rôle d'exécution du service
    # un `GetSecretValue` sur un secret entier — IAM ne sait pas restreindre à
    # une clé JSON.
    public_url_env_vars = optional(set(string), [])

    # Nom de variable d'environnement → ARN Secrets Manager. La valeur n'est
    # jamais lue par Terraform : l'agent ECS la résout au démarrage de la tâche.
    secret_arns = optional(map(string), {})

    # Politiques attachées au rôle de tâche. Vide par défaut : une application
    # qui n'appelle aucune API AWS n'a besoin d'aucun droit.
    task_role_policy_arns = optional(list(string), [])

    # Traçage distribué X-Ray (CDC §4.11). À vrai, le module ajoute à la tâche
    # le sidecar `aws-xray-daemon` — le relais UDP sans lequel le SDK écrit dans
    # le vide — et accorde au rôle de tâche le droit de publier ses segments.
    # Faux par défaut : le démon consomme du CPU et de la mémoire de la tâche, et
    # une application non instrumentée n'en tirerait rien.
    xray_tracing_enabled = optional(bool, false)
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

  validation {
    condition = alltrue([
      for s in values(var.services) :
      alltrue([for name in s.public_url_env_vars : can(regex("^[A-Z][A-Z0-9_]*$", name))])
    ])
    error_message = "Chaque entrée de public_url_env_vars doit être un nom de variable d'environnement en majuscules, par exemple APP_URL."
  }

  # Une même clé dans `environment` et dans `secrets` fait refuser la définition
  # de tâche par l'API ECS, et le message ne dit pas laquelle. Le collisionnement
  # se voit ici, au plan, avec le nom du service et celui de la variable.
  validation {
    condition = alltrue([
      for name, s in var.services :
      length(setintersection(
        s.public_url_env_vars,
        toset(concat(keys(s.environment), keys(s.secret_arns))),
      )) == 0
    ])
    error_message = "Une variable de public_url_env_vars est déjà déclarée dans `environment` ou dans `secret_arns` du même service. L'origine publique est calculée par le module : retirer le doublon."
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

variable "off_hours_shutdown" {
  description = <<-EOT
    Arrêt programmé des services hors heures ouvrées — le « environnement
    arrêtable hors heures ouvrées » du skill aws-infra §9 et du CDC §4.16, en
    Terraform plutôt qu'en geste manuel.

    `null` — le défaut — ne pose aucune planification : c'est le réglage de la
    production, qu'on n'arrête jamais, et celui d'un environnement dont
    personne n'a encore décidé les horaires.

    Renseigné, le module pose **deux actions planifiées par service** sur la
    cible d'auto-scaling :

      * `stop_cron` ramène `min_capacity` et `max_capacity` à **zéro** —
        Application Auto Scaling réduit alors `desired_count` à zéro, les tâches
        s'arrêtent, et la facture Fargate de l'environnement cesse de courir ;
      * `start_cron` les restaure aux valeurs déclarées par chaque service —
        relever la capacité minimale d'une cible au-dessus de sa capacité
        courante fait immédiatement redémarrer les tâches manquantes.

    Trois choses à savoir avant de s'en servir :

    1. **Rien d'autre ne s'arrête.** L'ALB, la base, le cache, les endpoints
       d'interface et la NAT Gateway continuent d'être facturés : ce réglage
       coupe le calcul, pas l'environnement. Arrêter la base est une décision
       distincte, et elle a ses propres effets de bord — voir le README de ce
       module.
    2. **Un `terraform apply` réveille l'environnement.** Une action planifiée
       modifie la cible d'auto-scaling elle-même : après l'arrêt du soir, la
       cible porte `0/0` là où l'état Terraform déclare les capacités du
       service. Le `apply` suivant les rétablit, donc redémarre les tâches, et
       l'arrêt du soir suivant les recouche. C'est le comportement voulu — un
       déploiement lancé à 23 h sur cet environnement doit pouvoir aboutir —
       mais il faut savoir que `plan` montrera cette dérive-là toutes les nuits.
    3. **Les crons sont des crons d'Application Auto Scaling** : six champs,
       `cron(minutes heures jour-du-mois mois jour-de-semaine année)`, et non la
       forme à cinq champs d'un crontab Unix.

    Pour lever l'arrêt — une recette qui doit tourner un week-end, une
    démonstration un soir :

      * ponctuellement, sans toucher au code :
        `aws application-autoscaling register-scalable-target
         --service-namespace ecs --scalable-dimension ecs:service:DesiredCount
         --resource-id service/<cluster>/<service> --min-capacity 1 --max-capacity 2`
        — la prochaine action planifiée reprendra la main ;
      * durablement : repasser cette variable à `null` et appliquer.
  EOT

  type = object({
    # 20 h et 7 h, du lundi au vendredi. Le week-end reste éteint de lui-même :
    # l'arrêt du vendredi soir n'est suivi d'aucun démarrage avant lundi matin.
    stop_cron  = optional(string, "cron(0 20 ? * MON-FRI *)")
    start_cron = optional(string, "cron(0 7 ? * MON-FRI *)")

    # Fuseau des deux expressions. Sans lui, Application Auto Scaling lit les
    # crons en UTC : « 20 h » deviendrait 21 h l'hiver et 22 h l'été à Paris,
    # c'est-à-dire deux heures de Fargate payées pour rien la moitié de l'année.
    timezone = optional(string, "Europe/Paris")
  })
  default = null

  # `try(…, true)` et non `var.off_hours_shutdown == null || …` : l'opérateur `||`
  # de Terraform n'est pas court-circuitant au sens où on l'attend — les deux
  # opérandes sont évalués, et lire un attribut sur `null` lève avant que la
  # disjonction n'ait pu trancher. C'est exactement ce qu'a montré
  # `terraform validate` sur `envs/dev`, qui ne compose pas ce réglage.
  validation {
    condition = try(alltrue([
      for expression in [var.off_hours_shutdown.stop_cron, var.off_hours_shutdown.start_cron] :
      can(regex("^(cron\\(.+\\)|rate\\(.+\\)|at\\(.+\\))$", expression))
    ]), true)
    error_message = "stop_cron et start_cron doivent être des expressions Application Auto Scaling — `cron(...)`, `rate(...)` ou `at(...)`. Un cron y compte six champs, année comprise."
  }

  # Le `try` est **à l'intérieur** du `can`, et pas l'inverse : `can` avale
  # l'erreur d'accès à un attribut de `null` et rend `false`, que `try` n'a alors
  # plus aucune raison de rattraper. La règle refusait ainsi le défaut du module.
  validation {
    condition     = can(regex("^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$|^UTC$", try(var.off_hours_shutdown.timezone, "UTC")))
    error_message = "off_hours_shutdown.timezone doit être un fuseau IANA — `Europe/Paris`, `Indian/Antananarivo` — ou `UTC`."
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

variable "xray_daemon_image" {
  description = <<-EOT
    Image du sidecar de traçage, ajoutée aux tâches dont le service porte
    `xray_tracing_enabled`. Le registre public d'AWS ne demande aucune
    authentification : le rôle d'exécution n'a donc pas à recevoir de droit de
    tirage supplémentaire, contrairement à l'image applicative.

    Étiquette flottante `3.x` et non `latest` : le démon est un binaire
    autonome dont AWS publie les correctifs sur cette branche, et l'épingler à
    une version exacte obligerait à un `apply` pour chaque correctif d'un
    composant qui ne sert qu'à relayer des paquets UDP.
  EOT
  type        = string
  default     = "public.ecr.aws/xray/aws-xray-daemon:3.x"
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
