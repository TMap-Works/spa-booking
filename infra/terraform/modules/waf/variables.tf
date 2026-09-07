variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de la Web ACL, de son groupe de journaux et de ses alarmes, sous la forme `spa-{environment}-waf`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

# --- Portée -------------------------------------------------------------------

variable "scope" {
  description = <<-EOT
    Portée de la Web ACL — `REGIONAL` ou `CLOUDFRONT`.

    `REGIONAL` couvre un Application Load Balancer, une API Gateway ou un AppSync
    de la région du provider. C'est la valeur qui correspond à l'architecture
    d'aujourd'hui : le CDC §4.10 dit « en amont de CloudFront/ALB », et aucun
    CloudFront n'existe encore dans ce dépôt — l'ALB du module `ecs-service` est
    la seule frontière publique à couvrir.

    `CLOUDFRONT` est utilisable le jour où une distribution apparaît, à deux
    conditions qu'aucune variable ne peut porter : la Web ACL doit être créée par
    un provider aliasé sur **us-east-1** — WAF n'accepte pas d'autre région pour
    cette portée —, et son association se déclare dans la distribution
    (`web_acl_id`) et non par `aws_wafv2_web_acl_association`, que
    `associated_resource_arns` refuse alors.
  EOT
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "CLOUDFRONT"], var.scope)
    error_message = "scope doit valoir `REGIONAL` ou `CLOUDFRONT`."
  }
}

variable "associated_resource_arns" {
  description = <<-EOT
    Ressources régionales protégées par cette Web ACL, indexées par une étiquette
    lisible qui sert de clé de `for_each` — `{ alb = module.ecs_service.alb_arn }`.

    La clé est écrite par l'appelant et l'ARN peut rester inconnu au plan : c'est
    exactement la contrainte qui interdit un `for_each` sur `toset()` d'une liste
    d'ARN, dont les éléments ne sont connus qu'après création de l'ALB.

    Vide, la Web ACL existe sans rien protéger. Ce n'est pas une erreur — c'est
    l'état d'un environnement qui ne compose pas encore `ecs-service` — mais
    c'est aussi le piège que la sortie `protects_anything` sert à voir.
  EOT
  type        = map(string)
  default     = {}
}

# --- Limitation de débit ------------------------------------------------------

variable "rate_limit" {
  description = <<-EOT
    Nombre de requêtes qu'une même adresse IP peut émettre sur une fenêtre
    glissante de cinq minutes avant d'être bloquée.

    Deux mille par défaut, soit près de sept requêtes par seconde et par adresse :
    largement au-dessus d'une cliente qui réserve — quelques dizaines d'appels
    pour parcourir un catalogue et choisir un créneau — et bien en dessous d'un
    script qui énumère les disponibilités d'un établissement.

    Le blocage est **par adresse IP**, ce qui a une conséquence à connaître avant
    de baisser ce seuil : les clientes d'un même réseau d'entreprise ou d'un
    opérateur mobile partagent une adresse de sortie.
  EOT
  type        = number
  default     = 2000

  validation {
    condition     = var.rate_limit >= 100 && var.rate_limit <= 2000000000
    error_message = "rate_limit doit être compris entre 100 et 2 000 000 000 requêtes par fenêtre de cinq minutes."
  }
}

# --- Groupes de règles managés ------------------------------------------------

variable "count_only_rule_groups" {
  description = <<-EOT
    Groupes de règles managés laissés en **observation** : ils s'évaluent, ils
    comptent, ils ne bloquent pas.

    C'est le mode dans lequel un groupe doit vivre le temps de vérifier ce qu'il
    aurait bloqué. `AWSManagedRulesBotControlRuleSet` y est par défaut parce que
    c'est le plus intrusif des cinq — il classe le trafic, et un faux positif sur
    un parcours de réservation coûte une réservation.

    Retirer une entrée d'ici fait passer le groupe en blocage au prochain
    `apply` : à faire une fois la métrique `CountedRequests` du groupe lue, pas
    avant.
  EOT
  type        = set(string)
  default     = ["AWSManagedRulesBotControlRuleSet"]

  validation {
    condition = alltrue([
      for name in var.count_only_rule_groups : contains([
        "AWSManagedRulesAmazonIpReputationList",
        "AWSManagedRulesKnownBadInputsRuleSet",
        "AWSManagedRulesSQLiRuleSet",
        "AWSManagedRulesCommonRuleSet",
        "AWSManagedRulesBotControlRuleSet",
      ], name)
    ])
    error_message = "count_only_rule_groups ne peut nommer que des groupes effectivement composés par ce module : AWSManagedRulesAmazonIpReputationList, AWSManagedRulesKnownBadInputsRuleSet, AWSManagedRulesSQLiRuleSet, AWSManagedRulesCommonRuleSet, AWSManagedRulesBotControlRuleSet."
  }
}

variable "counted_rules" {
  description = <<-EOT
    Règles individuelles neutralisées **à l'intérieur** d'un groupe managé,
    indexées par nom de groupe : `{ AWSManagedRulesCommonRuleSet = ["SizeRestrictions_BODY"] }`.

    Une règle nommée ici passe en comptage sans que le reste du groupe cesse de
    bloquer. C'est la granularité à préférer à `count_only_rule_groups` dès qu'un
    faux positif est identifié : désarmer `SizeRestrictions_BODY` parce qu'une
    fiche client dépasse 8 Ko ne doit pas désarmer la détection XSS du même
    groupe.

    Le nom attendu est celui de la règle AWS, tel qu'il apparaît dans la
    dimension CloudWatch `Rule` des requêtes comptées.
  EOT
  type        = map(list(string))
  default     = {}
}

variable "bot_control_inspection_level" {
  description = <<-EOT
    Niveau d'inspection de `AWSManagedRulesBotControlRuleSet` — `COMMON`,
    `TARGETED`, ou `null` pour ne pas composer le groupe du tout.

    `COMMON` reconnaît les robots qui se déclarent et les bibliothèques HTTP
    courantes ; `TARGETED` y ajoute la détection comportementale et le
    défi JavaScript, à un coût sensiblement supérieur.

    Ce groupe est le seul **facturé** des cinq : environ 10 USD par mois et par
    Web ACL, plus l'analyse au million de requêtes. Sur les 430 à 800 USD par
    mois du CDC §4.16, c'est acceptable en production et discutable sur un
    environnement de développement — d'où la possibilité de le retirer.
  EOT
  type        = string
  default     = "COMMON"

  validation {
    condition     = var.bot_control_inspection_level == null || contains(["COMMON", "TARGETED"], coalesce(var.bot_control_inspection_level, "COMMON"))
    error_message = "bot_control_inspection_level doit valoir `COMMON`, `TARGETED` ou `null`."
  }
}

# --- Journalisation -----------------------------------------------------------

variable "log_retention_days" {
  description = "Rétention du groupe de journaux WAF, en jours. Sans valeur explicite, CloudWatch conserve indéfiniment et la facture grimpe sans que personne ne le voie (skill aws-infra §8)."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days doit être une des durées admises par CloudWatch Logs."
  }
}

variable "log_only_inspected_requests" {
  description = <<-EOT
    Ne journaliser que les requêtes **bloquées ou comptées**, et laisser tomber
    celles que la Web ACL laisse passer sans rien déclencher.

    Vrai par défaut, et c'est un arbitrage de coût assumé : journaliser
    l'intégralité du trafic d'un ALB produit une ligne par requête, soit le poste
    CloudWatch Logs le plus volumineux de la plateforme, pour une information que
    les journaux d'accès de l'ALB portent déjà. Ce qu'on veut ici, c'est ce que le
    WAF a **décidé**.

    Le passer à faux le temps d'un incident donne la vue complète, au prix
    correspondant.
  EOT
  type        = bool
  default     = true
}

variable "create_log_resource_policy" {
  description = <<-EOT
    Créer la politique de ressource CloudWatch Logs qui autorise le service de
    livraison des journaux à écrire dans le groupe.

    Vrai par défaut parce que sans elle, `aws_wafv2_web_acl_logging_configuration`
    échoue sur un refus d'accès que le message d'erreur n'explique pas. La console
    la crée dans le dos de l'utilisateur ; en Terraform, elle se déclare.

    À connaître avant de composer un quatrième environnement : un compte n'admet
    que **dix** politiques de ressource CloudWatch Logs par région, et celle-ci
    en consomme une par environnement. La mettre à faux suppose qu'une politique
    couvrant `aws-waf-logs-*` existe déjà par ailleurs.
  EOT
  type        = bool
  default     = true
}

# --- Supervision --------------------------------------------------------------

variable "alarm_topic_arns" {
  description = "Topics SNS notifiés à l'entrée et à la sortie des alarmes. Vide par défaut : les alarmes existent alors et restent consultables, mais ne préviennent personne. Le topic attendu est `alerts_topic_arn` du module `budgets`, dont la politique nomme déjà `cloudwatch.amazonaws.com`."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.alarm_topic_arns : can(regex("^arn:aws[a-z-]*:sns:", arn))])
    error_message = "Chaque entrée de alarm_topic_arns doit être un ARN de topic SNS."
  }
}

variable "alarm_period_seconds" {
  description = "Période d'évaluation des deux alarmes, en secondes. Cinq minutes, comme celles du module `observability` — les seuils ci-dessous s'entendent sur cette durée."
  type        = number
  default     = 300

  validation {
    condition     = contains([60, 300, 900, 3600], var.alarm_period_seconds)
    error_message = "alarm_period_seconds doit valoir 60, 300, 900 ou 3600 secondes."
  }
}

variable "blocked_requests_alarm_threshold" {
  description = <<-EOT
    Nombre de requêtes bloquées sur une période au-delà duquel l'alarme se
    déclenche.

    Le seuil n'est **pas** à zéro, contrairement à celui de la DLQ des
    notifications : une Web ACL exposée sur Internet bloque en permanence des
    scanners, et une alarme qui sonne toutes les heures cesse d'être lue au bout
    d'une semaine. Ce qui mérite un réveil, c'est le changement de régime — une
    salve, pas le bruit de fond.

    Cent sur cinq minutes est un point de départ à réviser une fois le bruit de
    fond réel connu, ce que le tableau des requêtes bloquées donne en une
    journée.
  EOT
  type        = number
  default     = 100

  validation {
    condition     = var.blocked_requests_alarm_threshold >= 0
    error_message = "blocked_requests_alarm_threshold ne peut pas être négatif."
  }
}

variable "rate_limit_alarm_threshold" {
  description = "Nombre de requêtes bloquées par la seule règle de limitation de débit au-delà duquel l'alarme se déclenche. Seuil bas et distinct du précédent : ce compteur ne bouge que si une adresse a franchi `rate_limit`, ce qui n'arrive pas dans le trafic nominal d'une réservation."
  type        = number
  default     = 0

  validation {
    condition     = var.rate_limit_alarm_threshold >= 0
    error_message = "rate_limit_alarm_threshold ne peut pas être négatif."
  }
}
