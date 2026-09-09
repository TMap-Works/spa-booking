# Le nom par lequel CloudFront joint l'ALB.
#
# Un alias Route 53 et non un CNAME : un alias se résout sans requête
# supplémentaire, ne se facture pas, et suit l'ALB si son adresse change. Il
# n'existe que pour donner à l'origine un nom que le certificat du listener 443
# puisse couvrir — voir `origin_domain_name`.
resource "aws_route53_record" "origin" {
  count = local.manages_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.origin_domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = false
  }
}

# Les noms publics, en A et en AAAA.
#
# Les deux, et pas seulement le A : la distribution est joignable en IPv6
# (`is_ipv6_enabled`), et un client dont le réseau ne porte que de l'IPv6 —
# certains opérateurs mobiles — ne trouverait rien sans l'AAAA. Une panne qui ne
# touche qu'une partie des visiteuses est la plus longue à comprendre.
#
# Conditionnés à `serves_custom_domain` : sans certificat à soi, la distribution
# n'annonce aucun alias, et un nom public qui pointerait quand même dessus se
# ferait rendre un refus par CloudFront — une panne qui ressemble à un problème
# de DNS alors que c'est le certificat qui manque.
locals {
  public_records = local.manages_dns && local.serves_custom_domain ? {
    for pair in setproduct(local.aliases, ["A", "AAAA"]) :
    "${pair[0]}-${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  } : {}
}

resource "aws_route53_record" "public" {
  for_each = local.public_records

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name    = aws_cloudfront_distribution.this.domain_name
    zone_id = aws_cloudfront_distribution.this.hosted_zone_id

    # Faux : CloudFront n'expose pas de contrôle de santé exploitable par Route 53,
    # et un `true` ferait disparaître le nom du DNS au premier doute — c'est-à-dire
    # transformerait une dégradation en panne totale.
    evaluate_target_health = false
  }
}
