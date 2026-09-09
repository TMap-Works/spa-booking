output "certificate_arn" {
  description = <<-EOT
    ARN du certificat, à poser sur un listener ALB ou sur une distribution
    CloudFront.

    Quand le module gère la validation, cette valeur passe par
    `aws_acm_certificate_validation` : ce qui la consomme attend donc que le
    certificat soit réellement émis, au lieu d'échouer sur un certificat encore
    en attente.
  EOT
  value       = local.waits_for_validation ? one(aws_acm_certificate_validation.this[*].certificate_arn) : aws_acm_certificate.this.arn
}

output "certificate_id" {
  description = "ARN du certificat sans l'attente de validation. À n'utiliser que pour un diagnostic — poser cette valeur sur un listener contourne l'ordre des opérations que `certificate_arn` garantit."
  value       = aws_acm_certificate.this.arn
}

output "domain_name" {
  description = "Nom principal du certificat."
  value       = aws_acm_certificate.this.domain_name
}

output "subject_alternative_names" {
  description = "Tous les noms couverts, nom principal compris. C'est cette liste qu'il faut confronter au nom d'origine que CloudFront appelle : un nom absent d'ici fait échouer la connexion à l'origine, sans que rien ne le dise côté ALB."
  value       = sort(aws_acm_certificate.this.subject_alternative_names)
}

output "region" {
  description = "Région du certificat. Elle n'est pas cosmétique : le module `ecs-service` refuse au plan un certificat d'une autre région que son ALB, et CloudFront n'accepte que des certificats de `us-east-1`. C'est la valeur à regarder en premier quand l'une des deux barrières tombe."
  value       = data.aws_region.current.name
}

output "status" {
  description = "État ACM du certificat — `ISSUED` quand il est utilisable, `PENDING_VALIDATION` tant que les enregistrements de validation ne sont pas lus."
  value       = aws_acm_certificate.this.status
}

output "renewal_eligibility" {
  description = "`ELIGIBLE` quand ACM peut renouveler ce certificat de lui-même, `INELIGIBLE` sinon. C'est la seule valeur qui réponde à « le renouvellement est-il vraiment automatique ? » — et la seule à relire après avoir touché à la zone DNS."
  value       = aws_acm_certificate.this.renewal_eligibility
}

output "dns_validation_automated" {
  description = "Vrai quand ce module publie lui-même les enregistrements de validation, donc quand rien d'humain ne s'interpose entre l'émission, le renouvellement et leur aboutissement. Faux, les CNAME sont à publier à la main — et à **laisser en place** : les retirer après l'émission fait échouer le renouvellement un an plus tard, sans alerte."
  value       = local.manages_dns
}

output "validation_records" {
  description = <<-EOT
    Enregistrements CNAME de validation, indexés par leur nom : ce qu'ACM attend
    de trouver dans le DNS.

    Rendus dans tous les cas, y compris quand le module les publie lui-même —
    c'est ce qui permet de comparer à ce qu'un `dig` voit réellement quand un
    certificat reste obstinément en attente.
  EOT
  value       = local.validation_records
}

output "validation_record_fqdns" {
  description = "Noms pleinement qualifiés des enregistrements de validation effectivement posés par ce module. Vide quand la zone n'est pas gérée ici."
  value       = sort([for record in aws_route53_record.validation : record.fqdn])
}
