data "aws_region" "current" {}

locals {
  name_prefix = "spa-${var.environment}"

  certificate_name = "${local.name_prefix}-${var.usage}"

  # La validation par DNS n'est automatisable que si quelqu'un peut écrire dans la
  # zone. Sans identifiant de zone, le module s'arrête à la création du certificat
  # et publie la liste des enregistrements à poser — c'est le même contrat que le
  # module `notifications` pour DKIM et SPF.
  manages_dns = var.route53_zone_id != null

  # Attendre n'a de sens que si les enregistrements sont publiés par ce module :
  # sinon l'attente ne s'achèverait qu'au moment où un humain aurait posé les
  # CNAME à la main, c'est-à-dire jamais dans la durée d'un `apply`.
  waits_for_validation = local.manages_dns && var.wait_for_validation

  # Tous les noms couverts, tels que la **configuration** les déclare — et non
  # tels que le certificat les rendra.
  #
  # C'est la distinction qui fait marcher le `for_each` de `validation.tf`. Un
  # `for_each` exige des **clés connues au plan** ; celles d'ACM ne le sont pas
  # sur un certificat qui n'existe pas encore, et itérer directement sur
  # `domain_validation_options` fait échouer le plan sur « the "for_each" value
  # depends on resource attributes that cannot be determined until apply ». Les
  # clés viennent donc des variables, les valeurs de la ressource.
  certificate_names = distinct(concat([var.domain_name], var.subject_alternative_names))

  # Les options de validation, indexées par le nom qu'elles couvrent. Cette map
  # n'est connue qu'à l'`apply` : elle sert de **valeurs**, jamais de clés.
  validation_by_name = {
    for option in aws_acm_certificate.this.domain_validation_options :
    option.domain_name => option
  }

  validation_records = {
    for name in local.certificate_names :
    name => {
      name  = local.validation_by_name[name].resource_record_name
      type  = local.validation_by_name[name].resource_record_type
      value = local.validation_by_name[name].resource_record_value
    }
  }
}
