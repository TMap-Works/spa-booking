locals {
  name_prefix = "spa-${var.environment}"

  distribution_name = "${local.name_prefix}-cdn"

  # Identifiant de l'origine unique de la distribution. Repris tel quel dans
  # chaque comportement de cache : CloudFront relie les deux par cette chaîne, et
  # un écart y produit une erreur de validation que le message n'explique pas.
  origin_id = "${local.name_prefix}-alb"

  aliases = concat([var.domain_name], var.additional_aliases)

  # Le certificat par défaut de CloudFront ne couvre que `*.cloudfront.net` :
  # annoncer un alias sans certificat à soi ferait échouer l'`apply` côté AWS.
  # La précondition de `distribution.tf` le dit avant, avec le nom de la variable
  # à renseigner.
  serves_custom_domain = var.certificate_arn != null

  manages_dns = var.route53_zone_id != null

  # Ce qu'il faut publier quand la zone n'est pas gérée ici. L'origine est un
  # CNAME et non un alias : hors Route 53, aucun registraire ne sait faire
  # pointer un nom sur un ALB autrement.
  #
  # Les noms publics n'y figurent que si la distribution les sert réellement :
  # sans certificat à soi, elle n'annonce aucun alias et y faire pointer le nom
  # public ferait rendre un refus par CloudFront plutôt qu'une page.
  dns_records_to_publish = local.manages_dns ? {} : merge(
    {
      (var.origin_domain_name) = {
        type  = "CNAME"
        value = var.alb_dns_name
        ttl   = var.dns_record_ttl
      }
    },
    local.serves_custom_domain ? {
      for name in local.aliases : name => {
        type  = "CNAME"
        value = aws_cloudfront_distribution.this.domain_name
        ttl   = var.dns_record_ttl
      }
    } : {},
  )
}

# Politiques managées par AWS plutôt que des politiques à soi : elles sont
# maintenues par le fournisseur, elles ne coûtent rien, et leurs identifiants
# sont les mêmes dans tous les comptes. Les lire par leur nom plutôt que d'écrire
# l'UUID en dur rend l'intention lisible en revue.

# Rien n'est mis en cache, tout est transmis à l'origine. C'est le régime du
# comportement par défaut : les pages de cette plateforme portent des données
# d'établissement et de cliente.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Cache long sur les seuls chemins déclarés cachables, sans transmettre ni
# en-tête, ni cookie, ni chaîne de requête — ce que les fichiers empreintés de
# Next.js n'ont pas besoin de voir.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Transmet à l'origine tout ce que le navigateur a envoyé : en-têtes, cookies et
# chaîne de requête, `Host` compris. C'est la politique qu'AWS documente pour une
# origine ALB, et c'est ce qui permet à l'application de continuer à voir le nom
# public sous lequel elle est servie plutôt que le nom d'origine.
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# Ajoute les en-têtes de sécurité que l'application n'a pas à poser elle-même —
# HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`.
data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}
