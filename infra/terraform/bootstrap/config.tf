# AWS Config — traçabilité des changements et contrôle continu de conformité
# (CDC §4.10).
#
# CloudTrail dit **qui a fait quoi**. Config dit **dans quel état se trouve le
# compte**, et le compare en continu à un jeu de règles. Les deux sont
# complémentaires : un groupe de sécurité ouvert sur Internet apparaît dans
# CloudTrail au moment où quelqu'un l'ouvre — une ligne parmi des milliers — et
# dans Config tant qu'il reste ouvert.
#
# C'est cette seconde propriété qui fait de Config la preuve continue des critères
# de l'issue #79 : « aucun groupe de sécurité n'expose la base à Internet » n'est
# pas une chose qu'on vérifie une fois avant le go-live, c'est une chose qui doit
# rester vraie. Le tableau de `config_rules` associe chaque règle au critère
# qu'elle tient.
#
# Un enregistreur par compte et par région : portée de l'amorçage, comme
# CloudTrail et GuardDuty.

# --- Rôle du service ----------------------------------------------------------

data "aws_iam_policy_document" "config_assume" {
  count = var.config_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }

    # Garde contre l'adjoint confus, jusque dans la relation de confiance : sans
    # elle, le service Config d'un autre compte pourrait être amené à endosser ce
    # rôle.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "config" {
  count = var.config_enabled ? 1 : 0

  name               = "spa-config-recorder"
  description        = "Role du service AWS Config — lecture de l'inventaire et depot des instantanes"
  assume_role_policy = data.aws_iam_policy_document.config_assume[0].json

  tags = {
    Name = "spa-config-recorder"
  }
}

# La politique managée par AWS, et non une politique écrite à la main : elle
# n'accorde que des lectures (`Describe*`, `List*`, `Get*`) sur l'ensemble des
# services, ce qui est exactement ce qu'un inventaire suppose. La réécrire à la
# main voudrait dire la tenir à jour à chaque nouveau service supporté par Config,
# et un service manquant se traduirait par une ressource jamais évaluée — donc une
# non-conformité invisible.
resource "aws_iam_role_policy_attachment" "config" {
  count = var.config_enabled ? 1 : 0

  role       = aws_iam_role.config[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWS_ConfigRole"
}

# Le dépôt dans le bucket d'audit, qui n'est pas couvert par la politique managée
# — celle-ci ne connaît pas le bucket de destination.
data "aws_iam_policy_document" "config_delivery" {
  count = var.config_enabled ? 1 : 0

  statement {
    sid       = "LireLaConfigurationDuBucket"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]
  }

  statement {
    sid       = "DeposerLesInstantanes"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/${local.config_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  # Le bucket chiffre par défaut avec la clé d'audit : sans ce droit, chaque dépôt
  # échoue sur un refus KMS que le message d'erreur S3 n'explique pas.
  statement {
    sid       = "ChiffrerAvecLaCleDAudit"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.audit.arn]
  }
}

resource "aws_iam_role_policy" "config_delivery" {
  count = var.config_enabled ? 1 : 0

  name   = "spa-config-delivery"
  role   = aws_iam_role.config[0].id
  policy = data.aws_iam_policy_document.config_delivery[0].json
}

# --- Enregistreur et canal de livraison ---------------------------------------

resource "aws_config_configuration_recorder" "this" {
  count = var.config_enabled ? 1 : 0

  name     = "spa-config-recorder"
  role_arn = aws_iam_role.config[0].arn

  recording_group {
    all_supported = true

    # Les ressources globales — rôles, politiques et utilisateurs IAM — ne sont
    # enregistrées que dans une région. Sans cette option, les trois règles IAM
    # ci-dessous n'auraient rien à évaluer.
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "this" {
  count = var.config_enabled ? 1 : 0

  name           = "spa-config-delivery"
  s3_bucket_name = aws_s3_bucket.audit.id
  s3_key_prefix  = local.config_prefix
  s3_kms_key_arn = aws_kms_key.audit.arn

  # L'enregistreur doit exister avant son canal : l'API refuse un canal orphelin.
  depends_on = [
    aws_config_configuration_recorder.this,
    aws_s3_bucket_policy.audit,
  ]
}

# Créer l'enregistreur ne le démarre pas. C'est le piège le plus courant d'AWS
# Config : la console montre un enregistreur, les règles existent, et aucune
# évaluation n'a jamais lieu.
resource "aws_config_configuration_recorder_status" "this" {
  count = var.config_enabled ? 1 : 0

  name       = aws_config_configuration_recorder.this[0].name
  is_enabled = true

  depends_on = [aws_config_delivery_channel.this]
}

# --- Règles -------------------------------------------------------------------

# Règles managées AWS uniquement : chacune est une Lambda maintenue par AWS, dont
# le coût est à l'évaluation et non à l'heure. Écrire une règle personnalisée
# voudrait dire héberger et maintenir cette Lambda — hors périmètre MVP tant
# qu'une règle managée couvre le critère.
resource "aws_config_config_rule" "this" {
  for_each = { for name, rule in var.config_rules : name => rule if var.config_enabled }

  name        = each.key
  description = each.value.description

  source {
    owner             = "AWS"
    source_identifier = each.value.source_identifier
  }

  # `null` et non `"{}"` quand la règle n'attend aucun paramètre : une chaîne JSON
  # vide fait échouer la création de certaines règles managées.
  input_parameters = length(each.value.input_parameters) > 0 ? jsonencode(each.value.input_parameters) : null

  # Une règle créée avant que l'enregistreur ne tourne échoue sur
  # « NoAvailableConfigurationRecorderException ».
  depends_on = [aws_config_configuration_recorder_status.this]
}
