# Budget mensuel de l'environnement (CDC §4.16, skill aws-infra §9).
#
# AWS Budgets est un service **global** : il n'existe qu'une fois par compte et
# ses appels sont signés pour `us-east-1`, quelle que soit la région du provider.
# Rien à configurer de ce côté — mais cela explique qu'un budget n'apparaisse pas
# dans la console régionale de `eu-west-3`.
#
# Un budget n'arrête aucune dépense. Il observe et notifie : la valeur est dans
# le délai entre le moment où la dépense dérive et celui où quelqu'un l'apprend.

resource "aws_budgets_budget" "monthly" {
  name        = "${local.name_prefix}-monthly"
  budget_type = "COST"
  time_unit   = "MONTHLY"

  # `format` plutôt que `tostring` : l'API renvoie systématiquement le montant
  # avec ses décimales, et une valeur écrite sans elles ferait diverger l'état à
  # chaque lecture.
  limit_amount = format("%.2f", var.monthly_limit)
  limit_unit   = var.currency

  # `null` laisse AWS fixer le début au premier jour du mois courant.
  time_period_start = var.time_period_start

  # Ce qui délimite la dépense mesurée : l'étiquette posée par `default_tags` sur
  # tout ce que l'environnement crée. Sans ce filtre, les trois environnements
  # partageant un compte mesureraient tous la même facture.
  cost_filter {
    name   = "TagKeyValue"
    values = [local.environment_cost_filter]
  }

  # Les autres postes — taxes, remises, abonnements, engagements — gardent le
  # défaut d'AWS, qui est de les compter. Seuls crédits et remboursements sont
  # exclus : voir `include_credits_and_refunds`.
  cost_types {
    include_credit = var.include_credits_and_refunds
    include_refund = var.include_credits_and_refunds
  }

  # Une notification par seuil. Toutes visent le topic et non des adresses : une
  # adresse ajoutée après coup n'a alors pas à toucher au budget lui-même, et le
  # même topic portera les alarmes CloudWatch de l'observabilité (skill
  # aws-infra §8).
  dynamic "notification" {
    for_each = toset(var.alert_thresholds_percent)

    content {
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      notification_type         = "ACTUAL"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }

  # Budgets vérifie qu'il peut publier sur le topic **au moment où le budget est
  # créé** — c'est l'erreur « Invalid SNS topic » de la documentation AWS. Le
  # droit vient de la politique du topic, que rien ne relie au budget : le budget
  # ne référence que l'ARN du topic, si bien que Terraform crée les deux en
  # parallèle et que l'`apply` échoue une fois sur deux. La dépendance est donc
  # déclarée explicitement.
  depends_on = [aws_sns_topic_policy.alerts]
}
