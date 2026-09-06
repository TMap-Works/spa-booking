# Canal des événements de remise — rebonds, plaintes, refus, échecs de rendu.
#
# Un topic plutôt qu'une file directe : c'est ce qui laisse plusieurs
# consommateurs se brancher sans que SES le sache. Le traitement applicatif (#73)
# s'y abonnera par une file SQS, une alarme CloudWatch pourra s'y greffer, et
# aucun des deux n'aura à toucher au jeu de configuration.

# --- Chiffrement --------------------------------------------------------------

# Le message d'un rebond porte **l'adresse du destinataire**, donc une donnée
# personnelle au sens du CDC §5.1. C'est la différence avec le topic d'alertes
# budgétaires, laissé en clair parce qu'il ne transporte qu'un pourcentage : ici
# le chiffrement au repos n'est pas une formalité, et il justifie la dépense d'une
# clé gérée par le client (≈ 1 USD par mois et par environnement).
#
# Une clé gérée par AWS ne conviendrait pas : elle n'accepte aucune politique, et
# SES ne pourrait donc pas produire la clé de données nécessaire à la publication.
resource "aws_kms_key" "events" {
  count = var.kms_key_arn == null ? 1 : 0

  description             = "Chiffrement des evenements de remise SES ${local.name_prefix}"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.events_kms[0].json

  tags = {
    Name = "${local.name_prefix}-ses-events-kms"
  }
}

resource "aws_kms_alias" "events" {
  count = var.kms_key_arn == null ? 1 : 0

  name          = "alias/${local.name_prefix}-ses-events"
  target_key_id = aws_kms_key.events[0].key_id
}

# Politique de clé. Écrire une politique remplace celle que KMS installe par
# défaut : il faut donc **réaffirmer** la délégation au compte propriétaire, faute
# de quoi la clé devient inadministrable — et une clé KMS dont plus personne n'a
# les droits ne se répare pas, elle se remplace.
#
# `resources = ["*"]` n'est pas un caractère générique ici : dans une **politique
# de clé**, la ressource ne peut désigner que la clé à laquelle la politique est
# attachée. L'écrire autrement est impossible — l'ARN de la clé n'existe pas encore
# au moment où sa politique est évaluée, et le mettre en dur créerait un cycle.
# La portée réelle de ces deux énoncés est donc cette clé et rien d'autre.
#tfsec:ignore:aws-iam-no-policy-wildcards
data "aws_iam_policy_document" "events_kms" {
  count = var.kms_key_arn == null ? 1 : 0

  statement {
    sid    = "AllowAccountDelegation"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowSesToEncryptEvents"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    # `GenerateDataKey*` et `Decrypt` : SNS chiffre par enveloppe, le producteur
    # doit donc pouvoir fabriquer la clé de données et relire celle du contexte.
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]

    resources = ["*"]

    # Garde contre l'adjoint confus : le service SES d'un autre compte ne peut pas
    # se faire chiffrer quoi que ce soit par cette clé.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# --- Topic --------------------------------------------------------------------

resource "aws_sns_topic" "events" {
  name              = "${local.name_prefix}-ses-events"
  display_name      = "Evenements de remise SES ${var.environment}"
  kms_master_key_id = local.kms_key_arn

  tags = {
    Name = "${local.name_prefix}-ses-events"
  }
}

data "aws_iam_policy_document" "events" {
  statement {
    sid    = "AllowSesPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.events.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    # Portée aux ressources SES de ce compte et de cette région. Elle n'est pas
    # resserrée sur l'ARN du jeu de configuration : selon l'événement, SES publie
    # sous l'ARN de l'identité ou sous celui du jeu de configuration, et une
    # condition qui ne nommerait que l'un des deux ferait disparaître en silence
    # la moitié des rebonds.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }

  # Même raison que dans le module budgets : poser une politique efface celle
  # qu'SNS installe par défaut, y compris les droits du compte propriétaire.
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

    resources = [aws_sns_topic.events.arn]
  }
}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events.json
}
