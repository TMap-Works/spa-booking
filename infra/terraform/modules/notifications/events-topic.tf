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

  # SNS remet ce topic à des files SQS chiffrées par **cette même clé**
  # (`delivery-events.tf`, #73). La remise est une écriture faite par le service
  # SNS pour son propre compte : sans ce droit, SNS échoue en `KMSAccessDenied`,
  # abandonne le message, et la panne est **totalement silencieuse** — la file
  # reste vide, la file d'attente morte aussi, et les deux alarmes de la chaîne,
  # qui regardent l'une et l'autre, ne voient rien. Aucune adresse morte ne
  # serait jamais supprimée.
  #
  # Pas de condition `aws:SourceAccount` ici, contrairement à l'énoncé SES :
  # l'appel KMS de la remise n'est pas celui de la publication, et le contexte
  # qu'il porte n'est pas garanti. Une condition qui ne s'évalue pas rendrait le
  # droit inopérant, c'est-à-dire reconduirait exactement la panne qu'il ferme.
  # L'adjoint confus est fermé ailleurs, et deux fois : la politique de la file
  # n'accepte de dépôt que du topic **nommé** (`ArnEquals aws:SourceArn`), et
  # celle du topic ne laisse publier que l'identité SES de ce compte.
  statement {
    sid    = "AllowSnsToDeliverToEncryptedQueues"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]

    resources = ["*"]
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
  # Même garde de transport que sur les deux files de `dispatch-queue.tf`, que les
  # buckets d'état et d'audit du bootstrap, et que le topic d'alertes de sécurité.
  # Elle ferme l'asymétrie qui restait sur les topics antérieurs à #79 (#516).
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
  # principaux IAM et les appels anonymes, pas sur les principaux de service. SES
  # n'en dépend pas : il joint SNS en HTTPS, comme tout appel de service à service
  # chez AWS. Cet énoncé ne retire donc aucun droit à `AllowSesPublish` ni à
  # `AllowAccountOwner` ci-dessous — il ne mord que sur un appel en clair, qu'aucun
  # SDK ne fait par défaut.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.events.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

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
