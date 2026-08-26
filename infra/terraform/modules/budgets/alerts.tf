# Canal de notification des alertes budgétaires.
#
# Un topic SNS plutôt que des adresses posées directement sur le budget : c'est
# lui qui rend le canal indépendant de ses destinataires. Ajouter, retirer ou
# rediriger un abonné — vers une adresse, un webhook de messagerie, une Lambda —
# ne touche alors pas au budget, et les alarmes CloudWatch de l'observabilité
# viendront s'y brancher sans en créer un second (skill aws-infra §8).

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# Topic non chiffré, délibérément. Le chiffrement SNS exige une clé **gérée par
# le client** : la clé gérée par AWS ne peut pas recevoir la politique qui
# autorise `budgets.amazonaws.com` à produire une clé de données, et une
# publication vers un topic chiffré par elle échoue. Il faudrait donc une clé KMS
# dédiée, à 1 USD par mois et par environnement, pour protéger un message dont
# tout le contenu est « le budget de dev a dépassé 80 % » — soit une dépense
# permanente créée par le module chargé de surveiller la dépense.
#
#tfsec:ignore:aws-sns-enable-topic-encryption
resource "aws_sns_topic" "alerts" {
  name         = "${local.name_prefix}-budget-alerts"
  display_name = "Alertes budgetaires ${var.environment}"

  tags = {
    Name = "${local.name_prefix}-budget-alerts"
  }
}

# La politique du topic remplace celle qu'SNS pose par défaut : il faut donc
# réaffirmer les droits du compte propriétaire en plus d'ouvrir la publication à
# Budgets, faute de quoi un principal du compte n'aurait plus que ses politiques
# IAM pour joindre le topic.
data "aws_iam_policy_document" "alerts" {
  statement {
    sid    = "AllowBudgetsPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    # Garde contre l'adjoint confus : sans ces deux conditions, le service
    # Budgets d'un autre compte pourrait être amené à publier ici.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:budgets::${data.aws_caller_identity.current.account_id}:budget/*"]
    }
  }

  statement {
    sid    = "AllowAccountOwner"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.account_id]
    }

    actions = [
      "SNS:AddPermission",
      "SNS:DeleteTopic",
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:RemovePermission",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]

    resources = [aws_sns_topic.alerts.arn]
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

# Abonnements par courriel. Ils restent en `PendingConfirmation` tant que leur
# destinataire n'a pas cliqué le lien de confirmation — Terraform crée
# l'abonnement, il ne peut pas le confirmer à sa place.
resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}
