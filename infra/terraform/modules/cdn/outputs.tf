output "distribution_id" {
  description = "Identifiant de la distribution — celui que `aws cloudfront create-invalidation --distribution-id` attend, et celui de la dimension CloudWatch `DistributionId`."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "ARN de la distribution."
  value       = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  description = "Nom `*.cloudfront.net` de la distribution. C'est la cible des alias publics, et le seul nom par lequel elle répond tant qu'aucun certificat n'est fourni."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_hosted_zone_id" {
  description = "Zone hébergée de la distribution, exigée par un enregistrement d'alias Route 53 posé ailleurs."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}

output "distribution_status" {
  description = "État du déploiement de la distribution — `Deployed` quand la configuration est propagée à tous les points de présence. Un changement met une poignée de minutes à se propager, et c'est la valeur à regarder avant de conclure qu'un réglage n'a pas pris."
  value       = aws_cloudfront_distribution.this.status
}

output "public_url" {
  description = "Origine publique servie par la distribution. C'est la valeur à reprendre en `public_base_url` du module `ecs-service` et en variable de dépôt `APP_URL` — le front la publie dans ses balises canoniques."
  value       = local.serves_custom_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "aliases" {
  description = "Noms publics réellement servis. Vide quand aucun certificat n'est fourni : la distribution ne répond alors que sous son nom `*.cloudfront.net`."
  value       = sort(aws_cloudfront_distribution.this.aliases)
}

output "serves_custom_domain" {
  description = "Vrai quand la distribution porte un certificat à soi et sert le domaine du projet. Faux, elle fonctionne mais sous un nom `*.cloudfront.net` que personne ne tapera — état d'amorçage, pas état d'exploitation."
  value       = local.serves_custom_domain
}

output "origin_domain_name" {
  description = "Nom par lequel CloudFront joint l'ALB. Le certificat du listener 443 **doit** le couvrir : c'est la première chose à vérifier devant un `502` rendu par CloudFront alors que l'ALB est sain."
  value       = var.origin_domain_name
}

output "waf_web_acl_arn" {
  description = "Web ACL de bord associée à la distribution, ou `null`. Une valeur nulle veut dire que le filtrage n'a lieu qu'à l'ALB — donc après la traversée du réseau, et sur une adresse source qui n'est plus celle de la cliente."
  value       = aws_cloudfront_distribution.this.web_acl_id
}

output "protected_by_waf" {
  description = "Vrai quand une Web ACL de bord est associée. C'est la lecture directe du deuxième critère du CDC §4.10 — « en amont de CloudFront/ALB »."
  value       = var.web_acl_arn != null
}

output "cached_path_patterns" {
  description = "Chemins réellement servis depuis le cache. Tout le reste va à l'origine à chaque requête — ce qui est voulu : une page de disponibilités mise en cache serait servie à la visiteuse suivante."
  value       = var.cached_path_patterns
}

output "manages_dns" {
  description = "Vrai quand ce module publie lui-même l'enregistrement d'origine et les alias publics. Faux, voir `dns_records_to_publish`."
  value       = local.manages_dns
}

output "dns_records_to_publish" {
  description = "Enregistrements à publier chez le registraire quand la zone n'est pas dans Route 53, indexés par nom — type, valeur et durée de vie. Vide quand le module s'en charge. Tant qu'ils ne sont pas posés, la distribution n'est joignable que par son nom `*.cloudfront.net` et l'origine ne se résout pas."
  value       = local.dns_records_to_publish
}
