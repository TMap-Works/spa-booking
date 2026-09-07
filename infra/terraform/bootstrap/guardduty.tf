# GuardDuty — détection de menaces et d'activités anormales sur le compte
# (CDC §4.10).
#
# Un détecteur par compte et par région : c'est la portée de l'amorçage, pas
# celle d'un environnement. Le service analyse en continu les journaux CloudTrail,
# les journaux de flux VPC et les requêtes DNS, sans qu'aucune de ces sources
# n'ait à être activée ni payée séparément — c'est ce qui en fait le meilleur
# rapport signal/prix de la section 4.10.

resource "aws_guardduty_detector" "this" {
  count = var.guardduty_enabled ? 1 : 0

  enable                       = true
  finding_publishing_frequency = var.guardduty_finding_publishing_frequency

  tags = {
    Name = "spa-guardduty"
  }
}

# Les sources additionnelles, activées une par une plutôt qu'en bloc. Chacune a
# un coût et une pertinence propres, et le défaut de `guardduty_features` les
# arbitre en fonction de ce que cette plateforme fait tourner — voir la variable.
resource "aws_guardduty_detector_feature" "this" {
  for_each = var.guardduty_enabled ? var.guardduty_features : {}

  detector_id = aws_guardduty_detector.this[0].id
  name        = each.key
  status      = each.value ? "ENABLED" : "DISABLED"
}

# --- Canal d'alerte -----------------------------------------------------------
#
# Une détection que personne ne lit n'est pas une détection. GuardDuty publie ses
# constats dans sa console et sur le bus d'événements par défaut, et s'arrête là :
# sans la règle ci-dessous, il faudrait penser à ouvrir la console pour apprendre
# qu'une instance parle à un serveur de commande.
#
# Le topic est propre à l'amorçage et n'est pas celui du module `budgets` : ce
# dernier est créé une fois par environnement, alors qu'un constat GuardDuty ne se
# range dans aucun environnement. Le choisir aurait aussi voulu dire qu'un
# `terraform destroy` sur `envs/dev` emporte le canal d'alerte de sécurité du
# compte.
#
# Topic non chiffré, pour la même raison que celui des alertes budgétaires : le
# chiffrement SNS exige une clé gérée par le client — la clé gérée par AWS ne peut
# pas recevoir la politique qui autorise EventBridge à produire une clé de
# données. Le contenu publié est un résumé de constat, dont le détail reste dans
# GuardDuty ; il ne vaut pas une clé KMS supplémentaire à 1 USD par mois.
#
#tfsec:ignore:aws-sns-enable-topic-encryption
resource "aws_sns_topic" "security_alerts" {
  count = var.guardduty_enabled ? 1 : 0

  name         = "spa-security-alerts"
  display_name = "Alertes de securite du compte"

  tags = {
    Name = "spa-security-alerts"
  }
}

data "aws_iam_policy_document" "security_alerts" {
  count = var.guardduty_enabled ? 1 : 0

  # « TLS 1.2 minimum sur toutes les communications externes » (#79) vaut aussi
  # pour ce topic, et la garde est la même que celle des buckets d'état et de la
  # file d'envoi des notifications. Elle est bon marché et elle ferme une
  # asymétrie gênante : ce canal ne chiffre pas au repos — voir l'arbitrage
  # au-dessus — donc il n'y a aucune raison de le laisser aussi accessible en
  # clair sur le réseau.
  statement {
    sid    = "RefuserLeTransportEnClair"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.security_alerts[0].arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "AutoriserEventBridge"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.security_alerts[0].arn]

    # Garde contre l'adjoint confus : seules les règles EventBridge de ce compte
    # publient ici.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  # Écrire une politique de topic efface celle qu'SNS pose par défaut : les droits
  # du compte propriétaire doivent être réaffirmés, sans quoi plus personne ne
  # peut s'abonner ni lire les attributs du topic.
  statement {
    sid    = "AutoriserLeComptePropietaire"
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

    resources = [aws_sns_topic.security_alerts[0].arn]
  }
}

resource "aws_sns_topic_policy" "security_alerts" {
  count = var.guardduty_enabled ? 1 : 0

  arn    = aws_sns_topic.security_alerts[0].arn
  policy = data.aws_iam_policy_document.security_alerts[0].json
}

# Les abonnements restent en `PendingConfirmation` tant que leur destinataire n'a
# pas cliqué le lien : Terraform crée l'abonnement, il ne le confirme pas à sa
# place.
resource "aws_sns_topic_subscription" "security_alerts_email" {
  for_each = var.guardduty_enabled ? var.security_alert_emails : []

  topic_arn = aws_sns_topic.security_alerts[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# Seuls les constats à partir du seuil de sévérité retenu franchissent la règle.
# GuardDuty gradue de 1 à 8,9 — en dessous de 4, c'est de l'information (un scan
# de port depuis Internet, qui arrive en permanence), et la faire suivre par
# courriel apprendrait à l'équipe à filtrer la boîte de réception.
resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  count = var.guardduty_enabled ? 1 : 0

  name        = "spa-guardduty-findings"
  description = "Constats GuardDuty de severite au moins ${var.guardduty_min_severity}, vers le topic d'alertes de securite."

  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail = {
      severity = [{
        numeric = [">=", var.guardduty_min_severity]
      }]
    }
  })

  tags = {
    Name = "spa-guardduty-findings"
  }
}

resource "aws_cloudwatch_event_target" "guardduty_findings" {
  count = var.guardduty_enabled ? 1 : 0

  rule      = aws_cloudwatch_event_rule.guardduty_findings[0].name
  target_id = "spa-security-alerts"
  arn       = aws_sns_topic.security_alerts[0].arn

  # Sans transformation, le message publié est le JSON brut du constat — plusieurs
  # kilooctets illisibles dans un courriel. Les quatre champs retenus sont ceux
  # qui décident si on se lève : quoi, sur quoi, à quel point, dans quelle région.
  input_transformer {
    input_paths = {
      compte   = "$.detail.accountId"
      region   = "$.detail.region"
      severite = "$.detail.severity"
      titre    = "$.detail.title"
      type     = "$.detail.type"
    }

    input_template = <<-EOT
      "GuardDuty — severite <severite> — <titre> (type <type>, compte <compte>, region <region>). Detail complet dans la console GuardDuty."
    EOT
  }
}
