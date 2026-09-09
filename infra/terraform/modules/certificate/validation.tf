# Publication des enregistrements de validation, quand la zone est dans Route 53.
#
# `allow_overwrite` est vrai à dessein : un certificat recréé — changement de nom
# principal, de SAN, d'algorithme de clé — redemande le même nom d'enregistrement
# avec une valeur différente. Sans cette autorisation, `apply` échouerait sur un
# enregistrement déjà présent, celui du certificat qu'on est en train de
# remplacer, et la seule issue serait de le supprimer à la main — c'est-à-dire de
# désarmer le renouvellement automatique du certificat encore en service.
#
# `for_each` sur les noms **déclarés** et non sur `domain_validation_options` :
# les clés d'un `for_each` doivent être connues au plan, et celles d'ACM ne le
# sont pas sur un certificat qui n'existe pas encore. Voir `local.certificate_names`.
resource "aws_route53_record" "validation" {
  for_each = local.manages_dns ? toset(local.certificate_names) : toset([])

  zone_id         = var.route53_zone_id
  name            = local.validation_by_name[each.key].resource_record_name
  type            = local.validation_by_name[each.key].resource_record_type
  records         = [local.validation_by_name[each.key].resource_record_value]
  ttl             = var.validation_record_ttl
  allow_overwrite = true
}

# Ressource sans infrastructure : elle n'interroge ACM que jusqu'à ce que le
# certificat passe à `ISSUED`. Sa raison d'être est l'ordre des opérations — un
# listener HTTPS ou une distribution CloudFront qui référence un certificat
# encore `PENDING_VALIDATION` échoue, et l'erreur accuse alors le listener.
#
# La sortie `certificate_arn` du module en dépend : tout ce qui la consomme
# attend donc, par construction, un certificat réellement émis.
resource "aws_acm_certificate_validation" "this" {
  count = local.waits_for_validation ? 1 : 0

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]

  timeouts {
    create = var.validation_timeout
  }
}
