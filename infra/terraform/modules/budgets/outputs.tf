output "budget_name" {
  description = "Nom du budget mensuel — celui sous lequel il apparaît dans la console Billing et dans les messages d'alerte."
  value       = aws_budgets_budget.monthly.name
}

output "budget_limit" {
  description = "Plafond mensuel et sa devise, tels qu'ils sont enregistrés côté AWS. À reprendre dans un compte rendu de coût plutôt que de recopier la valeur passée au module."
  value       = "${aws_budgets_budget.monthly.limit_amount} ${aws_budgets_budget.monthly.limit_unit}"
}

output "budget_cost_filter" {
  description = "Filtre d'étiquette qui délimite la dépense mesurée, par exemple `user:Environment$dev`. C'est la valeur à comparer aux `default_tags` de l'environnement quand un budget reste obstinément à zéro."
  value       = local.environment_cost_filter
}

output "alert_thresholds_percent" {
  description = "Seuils d'alerte effectivement posés, en pourcentage du plafond."
  value       = var.alert_thresholds_percent
}

output "alerts_topic_arn" {
  description = "Topic SNS qui porte les alertes budgétaires. C'est là que se branche tout destinataire supplémentaire — et c'est le topic à réemployer pour les alarmes CloudWatch plutôt que d'en créer un second."
  value       = aws_sns_topic.alerts.arn
}

output "alerts_topic_name" {
  description = "Nom du topic d'alerte."
  value       = aws_sns_topic.alerts.name
}

output "alert_email_subscription_arns" {
  description = "ARN des abonnements par courriel, par adresse. Un ARN valant `pending confirmation` signale un destinataire qui n'a pas encore confirmé son abonnement : il ne recevra aucune alerte tant qu'il ne l'aura pas fait."
  value       = { for address, subscription in aws_sns_topic_subscription.email : address => subscription.arn }
}

output "cost_allocation_tag_keys" {
  description = "Étiquettes de répartition de coûts activées par cet environnement. Vide partout sauf sur celui qui porte l'activation — elle vaut pour le compte entier."
  value       = sort([for tag in aws_ce_cost_allocation_tag.this : tag.tag_key])
}
