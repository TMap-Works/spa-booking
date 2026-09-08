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
  # Garde de transport, alignée sur les files d'envoi des notifications, les
  # buckets d'état et d'audit, et le topic d'alertes de sécurité (#516). Elle vaut
  # d'autant plus ici que ce topic **n'est pas chiffré au repos** — voir
  # l'arbitrage au-dessus : il n'y a aucune raison de le laisser en plus joignable
  # en clair sur le réseau.
  #
  # Un refus pur : il n'accorde rien — les droits viennent des énoncés ci-dessous
  # et des politiques d'identité — il interdit seulement de joindre ce topic hors
  # TLS. Un `Deny` explicite l'emporte sur tout `Allow`, y compris celui du compte
  # propriétaire, ce qui est bien l'effet recherché.
  #
  # Le caractère générique sur l'action est ici la forme **correcte** : une garde
  # de transport doit couvrir toute action présente et à venir. La restreindre à
  # une liste laisserait passer en clair celles qu'on aurait oublié d'y écrire —
  # l'inverse exact du risque qu'elle couvre.
  #
  # `{"AWS": "*"}` — la forme des quatre gardes déjà en place — porte sur les
  # principaux IAM et les appels anonymes, pas sur les principaux de service.
  # Budgets et CloudWatch n'en dépendent pas : ils joignent SNS en HTTPS, comme
  # tout appel de service à service chez AWS. Cet énoncé ne retire donc aucun droit
  # aux trois `Allow` ci-dessous — il ne mord que sur un appel en clair, qu'aucun
  # SDK ne fait par défaut.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.alerts.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

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

  # Les alarmes CloudWatch de l'observabilité, que l'en-tête de ce fichier
  # annonce comme le second usage du topic. Elles ne publient **pas** sous
  # l'identité du compte : le service CloudWatch publie sous son propre principal,
  # et l'énoncé `AllowAccountOwner` ci-dessous ne le couvre donc pas.
  #
  # C'est un piège discret : sans cette autorisation, l'alarme change bel et bien
  # d'état — elle passe au rouge dans la console, son historique le montre — mais
  # aucune notification ne part. On croit être prévenu, et on ne l'est pas. La
  # politique par défaut d'SNS l'autorisait ; l'écrire l'a effacée, et il faut la
  # réaffirmer (#67).
  statement {
    sid    = "AllowCloudWatchAlarms"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    # Même garde contre l'adjoint confus que pour Budgets : seules les alarmes de
    # ce compte-ci publient ici.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
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
