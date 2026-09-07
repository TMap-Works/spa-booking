output "web_acl_arn" {
  description = "ARN de la Web ACL. C'est cette valeur que référence une distribution CloudFront (`web_acl_id`) le jour où il y en a une."
  value       = aws_wafv2_web_acl.this.arn
}

output "web_acl_id" {
  description = "Identifiant de la Web ACL."
  value       = aws_wafv2_web_acl.this.id
}

output "web_acl_name" {
  description = "Nom de la Web ACL — également la valeur de la dimension CloudWatch `WebACL`."
  value       = aws_wafv2_web_acl.this.name
}

output "log_group_name" {
  description = "Groupe de journaux CloudWatch où atterrissent les décisions du WAF. C'est là qu'on lit quelle règle a bloqué quelle requête."
  value       = aws_cloudwatch_log_group.waf.name
}

output "protected_resource_arns" {
  description = "ARN effectivement associés à la Web ACL, par clé de `associated_resource_arns`."
  value       = { for key, association in aws_wafv2_web_acl_association.this : key => association.resource_arn }
}

# Une Web ACL qui ne protège rien est indiscernable d'une Web ACL qui protège,
# tant qu'on ne regarde que la console WAF : elle existe, ses règles sont là, ses
# métriques sont à zéro — ce qui ressemble à du calme. Cette sortie est ce qui
# rend la différence visible dans la liste de vérification du go-live (#83).
output "protects_anything" {
  description = "Faux si la Web ACL n'est associée à aucune ressource : elle existe alors sans filtrer quoi que ce soit."
  value       = length(aws_wafv2_web_acl_association.this) > 0
}

output "blocking_rule_groups" {
  description = "Groupes de règles managés en mode blocage. Ceux qui n'y figurent pas sont composés en observation — ils comptent sans bloquer."
  value       = sort([for group in local.managed_rule_groups : group.name if !group.count_only])
}

output "counting_rule_groups" {
  description = "Groupes de règles managés en observation. La métrique `CountedRequests` de chacun dit ce qu'il aurait bloqué : c'est elle qu'il faut lire avant de le retirer de `count_only_rule_groups`."
  value       = sort([for group in local.managed_rule_groups : group.name if group.count_only])
}

output "rate_limit" {
  description = "Requêtes admises par adresse IP sur une fenêtre glissante de cinq minutes."
  value       = var.rate_limit
}
