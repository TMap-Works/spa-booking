# Distribution CloudFront en amont de l'ALB (CDC §4.4 et §4.10).
#
# ## Ce qu'elle apporte, et ce qu'elle n'apporte pas
#
# Elle apporte trois choses, dans cet ordre d'importance pour ce produit :
#
#   1. **Un endroit où poser le WAF avant la région.** Une Web ACL de portée
#      `CLOUDFRONT` bloque au point de présence, avant que la requête n'ait
#      traversé l'Internet jusqu'à `eu-west-3` — et elle y voit l'adresse réelle
#      de la cliente, ce que l'ALB ne voit plus une fois derrière un CDN.
#   2. **La terminaison TLS et HTTP/3 au plus près de la visiteuse.** Sur un
#      tunnel de réservation, la poignée de main est une part sensible du temps
#      de la première page.
#   3. **Le cache des fichiers empreintés de Next.js**, et rien d'autre. Voir
#      `cached_path_patterns` : mettre en cache une page de disponibilités la
#      livrerait à la visiteuse suivante.
#
# Elle n'apporte pas, et il faut le savoir : **elle ne rend pas l'ALB privé**.
# Celui-ci reste joignable par son nom `*.elb.amazonaws.com`, et une requête qui
# l'atteint directement contourne cette distribution — donc son WAF de bord. Ce
# qui la couvre est la seconde Web ACL, de portée `REGIONAL`, associée à l'ALB
# lui-même : `envs/prod` compose les deux, et c'est la raison d'être de la
# seconde. La fermer complètement demanderait un en-tête partagé vérifié par une
# règle d'écoute de l'ALB, que le module `ecs-service` n'expose pas aujourd'hui.
resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Point d'entree public ${var.environment} — spa-booking"
  price_class     = var.price_class
  http_version    = var.http_version

  aliases = local.serves_custom_domain ? local.aliases : []

  # L'ARN de la Web ACL, malgré le nom de l'argument : `web_acl_id` attend un
  # identifiant pour WAF Classic et un **ARN** pour WAFv2, qui est ce qu'on
  # utilise ici.
  web_acl_id = var.web_acl_arn

  origin {
    origin_id   = local.origin_id
    domain_name = var.origin_domain_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = var.origin_protocol_policy

      # TLS 1.2 seulement vers l'origine. Les versions antérieures sont encore
      # acceptées par le fournisseur ici, jamais par la politique du listener.
      origin_ssl_protocols = ["TLSv1.2"]

      origin_read_timeout      = var.origin_read_timeout_seconds
      origin_keepalive_timeout = var.origin_keepalive_timeout_seconds
    }
  }

  # Tout ce qui n'est pas explicitement cachable passe par ici, sans cache.
  default_cache_behavior {
    target_origin_id = local.origin_id

    # `redirect-to-https` et non `https-only` : une cliente qui tape l'adresse
    # sans protocole arrive en clair, et un `403` la laisserait croire que le
    # service est tombé. La redirection est immédiate et le contenu ne part
    # jamais en clair.
    viewer_protocol_policy = "redirect-to-https"

    # Les méthodes d'écriture sont indispensables : réserver, annuler et payer
    # sont des `POST` et des `PATCH`, et une distribution qui ne les accepte pas
    # rend `403` sur le geste central du produit.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    compress = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  # Les fichiers empreintés de Next.js — leur nom change avec leur contenu, ils
  # sont donc cachables longtemps sans risque de servir une version périmée.
  dynamic "ordered_cache_behavior" {
    for_each = var.cached_path_patterns

    content {
      path_pattern     = ordered_cache_behavior.value
      target_origin_id = local.origin_id

      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true

      # Pas de politique de requête d'origine : ce qui n'est pas transmis ne
      # fragmente pas le cache. Un fichier empreinté est le même pour tout le
      # monde, et le faire varier sur un cookie de session reviendrait à ne rien
      # mettre en cache du tout.
      cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
      response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    }
  }

  # Aucune restriction géographique. Le produit s'adresse à des établissements
  # européens, mais une cliente en déplacement doit pouvoir annuler son
  # rendez-vous : la restriction se poserait par le WAF, et sur décision métier,
  # pas ici.
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.serves_custom_domain ? null : true
    acm_certificate_arn            = var.certificate_arn
    ssl_support_method             = local.serves_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.serves_custom_domain ? var.minimum_protocol_version : null
  }

  tags = {
    Name = local.distribution_name
  }

  lifecycle {
    precondition {
      condition     = local.serves_custom_domain || length(var.additional_aliases) == 0
      error_message = "Des alias sont demandés sans `certificate_arn` : le certificat par défaut de CloudFront ne couvre que `*.cloudfront.net`, et l'apply serait refusé par AWS. Composer le module `certificate` sur un provider aliasé `us-east-1` et passer sa sortie `certificate_arn`."
    }

    # `local.aliases` et non `var.domain_name` seul : un nom d'origine glissé dans
    # `additional_aliases` produirait la même boucle, et ferait en plus gérer le
    # même enregistrement Route 53 par `aws_route53_record.origin` — qui le fait
    # pointer sur l'ALB — et par `aws_route53_record.public` — qui le fait pointer
    # sur la distribution. Deux ressources pour un seul nom, que l'`apply` ne peut
    # pas départager.
    precondition {
      condition     = !contains(local.aliases, var.origin_domain_name)
      error_message = "origin_domain_name figure parmi les noms publics de cette distribution (`domain_name` ou `additional_aliases`) : le nom public pointerait sur la distribution et servirait en même temps d'origine à cette distribution, qui s'appellerait elle-même — et les deux enregistrements Route 53 posés par ce module se disputeraient ce nom. Prendre un nom distinct pour l'origine, `origin.<domaine>` par exemple."
    }
  }
}
