variable "environment" {
  description = "Nom de l'environnement. Entre dans le commentaire de la distribution et dans ses étiquettes, sous la forme `spa-{environment}-cdn`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

# --- Nom public ---------------------------------------------------------------

variable "domain_name" {
  description = <<-EOT
    Nom public de la plateforme — celui qu'une cliente tape, et le premier alias
    de la distribution. C'est ce nom que `certificate_arn` doit couvrir.
  EOT
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "domain_name doit être un nom de domaine pleinement qualifié en minuscules, par exemple `reservation.exemple.fr`."
  }
}

variable "additional_aliases" {
  description = "Noms supplémentaires servis par la même distribution — un `www.` par exemple. Chacun doit être couvert par `certificate_arn`, faute de quoi l'`apply` échoue sur un refus de CloudFront."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for name in var.additional_aliases :
      can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", name))
    ])
    error_message = "Chaque entrée de additional_aliases doit être un nom de domaine pleinement qualifié en minuscules."
  }
}

variable "certificate_arn" {
  description = <<-EOT
    Certificat ACM de la distribution, **obligatoirement dans `us-east-1`** :
    CloudFront n'en accepte aucun autre, quelle que soit la région du reste de la
    plateforme. Composer le module `certificate` avec un provider aliasé.

    `null` fait servir la distribution sous le certificat par défaut de
    CloudFront, donc sous son seul nom `*.cloudfront.net` — et `aliases` doit
    alors être vide. Ce n'est pas un mode d'exploitation : c'est ce qui permet
    d'appliquer avant qu'un nom de domaine n'existe.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.certificate_arn == null || can(regex("^arn:aws[a-z-]*:acm:us-east-1:", var.certificate_arn))
    error_message = "certificate_arn doit être `null` ou un ARN de certificat ACM de la région `us-east-1` — CloudFront n'accepte pas de certificat d'une autre région."
  }
}

# --- Origine ------------------------------------------------------------------

variable "origin_domain_name" {
  description = <<-EOT
    Nom par lequel CloudFront joint l'ALB.

    **Ce n'est jamais le nom `*.elb.amazonaws.com` de l'ALB.** CloudFront vérifie
    le certificat de son origine et refuse une connexion dont le certificat ne
    couvre pas le nom appelé ; aucun certificat public n'existe pour un nom
    `elb.amazonaws.com`. L'origine se joint donc par un nom à soi —
    `origin.<domaine>` — que ce module fait pointer sur l'ALB et que le
    certificat du listener 443 doit couvrir.

    Le symptôme, quand cela manque : `502` rendu par CloudFront, ALB sain,
    journaux d'accès vides, et rien qui nomme le certificat.
  EOT
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.origin_domain_name))
    error_message = "origin_domain_name doit être un nom de domaine pleinement qualifié en minuscules."
  }

  validation {
    condition     = !endswith(var.origin_domain_name, ".elb.amazonaws.com")
    error_message = "origin_domain_name ne peut pas être le nom DNS brut d'un ALB : CloudFront vérifie le certificat de son origine, et aucun certificat public ne couvre `*.elb.amazonaws.com`. Passer par un nom du domaine du projet, couvert par le certificat du listener 443."
  }
}

variable "alb_dns_name" {
  description = "Nom DNS de l'ALB, cible de l'enregistrement d'alias `origin_domain_name`. Sortie `alb_dns_name` du module `ecs-service`."
  type        = string
}

variable "alb_zone_id" {
  description = "Zone hébergée de l'ALB, exigée par un enregistrement d'alias Route 53. Sortie `alb_zone_id` du module `ecs-service`."
  type        = string
}

variable "route53_zone_id" {
  description = <<-EOT
    Zone hébergée Route 53 servant `domain_name`. Le module y publie
    l'enregistrement d'origine et les alias publics — A et AAAA, la distribution
    étant joignable en IPv6.

    `null` ne publie rien : les sorties `dns_records_to_publish` et
    `distribution_domain_name` donnent alors ce qu'il faut poser chez le
    registraire. Tant que ce n'est pas fait, la distribution existe et n'est
    joignable que par son nom `*.cloudfront.net`.
  EOT
  type        = string
  default     = null
}

variable "origin_protocol_policy" {
  description = "Protocole d'appel de l'origine — `https-only` par défaut. Le trafic entre CloudFront et l'ALB traverse l'Internet public : le passer en `http-only` exposerait en clair les jetons de session et les identifiants de rendez-vous."
  type        = string
  default     = "https-only"

  validation {
    condition     = contains(["https-only", "match-viewer"], var.origin_protocol_policy)
    error_message = "origin_protocol_policy doit valoir `https-only` ou `match-viewer` — `http-only` exposerait le trafic en clair entre CloudFront et l'ALB."
  }
}

variable "origin_read_timeout_seconds" {
  description = "Délai d'attente de la réponse de l'origine. Soixante secondes, comme le `alb_idle_timeout_seconds` du module `ecs-service` : deux délais désaccordés font rendre un `504` par celui qui abandonne le premier, et cherche-t-on alors la panne du mauvais côté."
  type        = number
  default     = 60

  validation {
    condition     = var.origin_read_timeout_seconds >= 1 && var.origin_read_timeout_seconds <= 180
    error_message = "origin_read_timeout_seconds doit être compris entre 1 et 180 secondes."
  }
}

variable "origin_keepalive_timeout_seconds" {
  description = "Durée pendant laquelle CloudFront garde ouverte une connexion inutilisée vers l'origine. Réutiliser une connexion évite une poignée de main TLS complète par requête — sur un tunnel de réservation, c'est la latence la plus facile à ne pas payer."
  type        = number
  default     = 5

  validation {
    condition     = var.origin_keepalive_timeout_seconds >= 1 && var.origin_keepalive_timeout_seconds <= 60
    error_message = "origin_keepalive_timeout_seconds doit être compris entre 1 et 60 secondes."
  }
}

# --- Comportements de cache ---------------------------------------------------

variable "cached_path_patterns" {
  description = <<-EOT
    Chemins servis depuis le cache de CloudFront, tout le reste étant transmis à
    l'origine sans être mis en cache.

    Le défaut couvre les fichiers que Next.js publie sous une empreinte de
    contenu : leur nom change dès que leur contenu change, ils sont donc
    cachables sans risque de servir une version périmée. **Tout le reste ne l'est
    pas** — une page de disponibilités, un tableau de bord, une réponse d'API
    portent des données propres à un établissement et parfois à une cliente, et
    les mettre en cache au bord du réseau les livrerait à la visiteuse suivante.
    C'est pour cela que le comportement par défaut est `CachingDisabled` et non
    l'inverse.
  EOT
  type        = list(string)
  default     = ["/_next/static/*"]

  validation {
    condition     = alltrue([for pattern in var.cached_path_patterns : startswith(pattern, "/")])
    error_message = "Chaque motif de cached_path_patterns doit commencer par une barre oblique."
  }
}

# --- Pare-feu et diffusion ----------------------------------------------------

variable "web_acl_arn" {
  description = <<-EOT
    Web ACL WAF de portée `CLOUDFRONT` associée à la distribution — le pare-feu
    applicatif du CDC §4.10, posé là où il voit l'adresse réelle de la cliente et
    où il bloque avant que la requête n'atteigne la région.

    L'association se déclare **ici** et non par `aws_wafv2_web_acl_association`,
    que WAF refuse pour cette portée.

    `null` laisse la distribution sans filtrage : la limitation de débit et les
    groupes de règles managés ne s'appliquent alors qu'au trafic qui atteint
    l'ALB, c'est-à-dire trop tard.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.web_acl_arn == null || can(regex("^arn:aws[a-z-]*:wafv2:us-east-1:[0-9]{12}:global/webacl/", var.web_acl_arn))
    error_message = "web_acl_arn doit être `null` ou l'ARN d'une Web ACL de portée CLOUDFRONT (`arn:aws:wafv2:us-east-1:…:global/webacl/…`)."
  }
}

variable "price_class" {
  description = <<-EOT
    Étendue géographique des points de présence utilisés.

    `PriceClass_100` — Europe, Amérique du Nord et Israël — par défaut : c'est
    l'aire desservie par la plateforme (CDC §4.1, région `eu-west-3`), et les
    classes supérieures facturent des points de présence que personne n'utilise.
    Une visiteuse hors de cette aire est servie quand même, depuis le point de
    présence le plus proche de ceux qui restent.
  EOT
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class doit valoir PriceClass_100, PriceClass_200 ou PriceClass_All."
  }
}

variable "minimum_protocol_version" {
  description = "Version TLS minimale acceptée d'un navigateur. `TLSv1.2_2021` aligne la distribution sur la politique du listener ALB — accepter moins reviendrait à ouvrir au bord ce que l'on ferme derrière."
  type        = string
  default     = "TLSv1.2_2021"

  validation {
    condition     = contains(["TLSv1.2_2018", "TLSv1.2_2019", "TLSv1.2_2021"], var.minimum_protocol_version)
    error_message = "minimum_protocol_version doit valoir TLSv1.2_2018, TLSv1.2_2019 ou TLSv1.2_2021 — les versions antérieures à TLS 1.2 ne sont pas acceptables sur un service qui traite des données personnelles."
  }
}

variable "http_version" {
  description = "Versions HTTP proposées aux navigateurs. `http2and3` ajoute HTTP/3 sans rien retirer : un client qui ne le sait pas négocie HTTP/2."
  type        = string
  default     = "http2and3"

  validation {
    condition     = contains(["http1.1", "http2", "http2and3", "http3"], var.http_version)
    error_message = "http_version doit valoir http1.1, http2, http2and3 ou http3."
  }
}

variable "dns_record_ttl" {
  description = "Durée de vie proposée pour les enregistrements de la sortie `dns_records_to_publish`, c'est-à-dire ceux qu'il faut poser à la main quand la zone n'est pas dans Route 53. Sans effet sur les enregistrements que ce module publie lui-même : ce sont des alias, qu'AWS sert avec sa propre durée de vie."
  type        = number
  default     = 300

  validation {
    condition     = var.dns_record_ttl >= 60 && var.dns_record_ttl <= 86400
    error_message = "dns_record_ttl doit être compris entre 60 et 86400 secondes."
  }
}
