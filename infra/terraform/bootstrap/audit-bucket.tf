# Destination unique des journaux d'audit du compte : CloudTrail et AWS Config.
#
# Un seul bucket pour les deux, deux préfixes distincts. Les séparer en deux
# buckets ne protégerait rien de plus — c'est la même politique, la même clé et
# le même cycle de vie — et doublerait la surface à tenir.
#
# Ce bucket est la mémoire du compte : c'est lui qu'un attaquant efface en
# premier pour couvrir ses traces, et c'est la raison de chacun des choix
# ci-dessous — versionnement, chiffrement par clé du compte, destruction
# empêchée, validation d'intégrité côté CloudTrail.

# --- Clé de chiffrement -------------------------------------------------------

# Une clé dédiée, distincte des clés d'état : un rôle qui déchiffre l'état de
# `dev` n'a aucune raison de pouvoir lire les journaux d'audit du compte, et
# l'inverse est encore plus vrai.
resource "aws_kms_key" "audit" {
  description             = "Chiffrement des journaux d'audit du compte — CloudTrail et AWS Config"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.audit_key.json

  tags = {
    Name = "spa-audit-logs"
  }
}

resource "aws_kms_alias" "audit" {
  name          = "alias/spa-audit-logs"
  target_key_id = aws_kms_key.audit.key_id
}

# Politique de clé explicite, contrairement aux clés d'état qui gardent celle par
# défaut. Elle est indispensable ici : CloudTrail chiffre ses fichiers sous son
# propre principal de service, qu'aucune politique IAM du compte ne peut couvrir.
#
# Le premier énoncé est celui qu'il ne faut jamais oublier dans une politique de
# clé écrite à la main — sans lui, plus aucune identité du compte n'administre la
# clé, et une clé KMS dont personne n'a la main est définitivement perdue.
data "aws_iam_policy_document" "audit_key" {
  statement {
    sid    = "DeleguerAIam"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "CloudTrailChiffreSesFichiers"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    # `GenerateDataKey*` et non `Encrypt` : CloudTrail chiffre par enveloppe — il
    # demande une clé de données, s'en sert, et n'appelle jamais KMS sur le
    # contenu lui-même.
    actions = [
      "kms:DescribeKey",
      "kms:GenerateDataKey*",
    ]

    resources = ["*"]

    # Garde contre l'adjoint confus : seule la trace de ce compte-ci peut faire
    # produire une clé de données.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  # Lire un journal chiffré demande le droit de déchiffrer. Sans cet énoncé, la
  # console CloudTrail affiche la liste des fichiers et échoue à en ouvrir un —
  # ce qui se découvre en général pendant l'incident qu'on cherchait à instruire.
  statement {
    sid    = "LireLesJournauxChiffres"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions   = ["kms:Decrypt", "kms:ReEncryptFrom"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }
}

# --- Bucket -------------------------------------------------------------------

# Journaux d'accès S3 non activés, pour la raison déjà annotée sur le bucket
# d'état : ils exigeraient un bucket de destination soumis au même contrôle, et
# la règle se mord la queue. C'est justement ce trail-ci qui solde la dette —
# les événements de données CloudTrail couvrent les accès aux objets, y compris
# ceux faits hors S3.
#
# La directive doit rester collée au bloc : tfsec ne rattache une exemption qu'à
# la ligne qui la suit immédiatement.
#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "audit" {
  bucket = local.audit_bucket_name

  # Détruire ce bucket, c'est détruire la seule preuve de ce qui s'est passé sur
  # le compte. Le garde-fou est volontairement non paramétrable, comme celui des
  # buckets d'état.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = local.audit_bucket_name
  }
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket = aws_s3_bucket.audit.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# `BucketOwnerEnforced` désactive les ACL : la politique de bucket devient le seul
# mécanisme d'autorisation. CloudTrail et Config continuent de fonctionner — tous
# deux envoient `bucket-owner-full-control`, la seule ACL que ce mode accepte
# encore.
resource "aws_s3_bucket_ownership_controls" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Un journal d'audit ne se relit pas souvent, mais il doit exister longtemps.
# D'où les deux temps : stockage courant le temps qu'une investigation reste
# probable, puis archivage à froid jusqu'à l'échéance de conservation.
resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "archiver-puis-expirer"
    status = "Enabled"

    filter {}

    transition {
      days = var.audit_log_glacier_transition_days

      # `GLACIER_IR` et non `GLACIER` : la restitution est immédiate, au prix d'un
      # stockage légèrement supérieur. Une investigation qui attend douze heures
      # ses journaux est une investigation qui n'a pas lieu.
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = var.audit_log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.audit_log_retention_days
    }
  }

  rule {
    id     = "abandonner-les-envois-multipart-incomplets"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Les deux durées sont validées séparément — 30 jours au moins pour la
  # transition, 90 au moins pour l'expiration —, ce qui laisse passer une
  # combinaison que S3 refuse : archiver le jour où l'objet expire, ou après. Les
  # défauts (90 et 365) sont sains ; c'est l'opérateur qui abaisse
  # `audit_log_retention_days` à son minimum qui tombe dessus, et l'erreur d'API
  # ne nomme aucune des deux variables.
  lifecycle {
    precondition {
      condition     = var.audit_log_glacier_transition_days < var.audit_log_retention_days
      error_message = "audit_log_glacier_transition_days (${var.audit_log_glacier_transition_days}) doit être strictement inférieur à audit_log_retention_days (${var.audit_log_retention_days}) : S3 refuse une transition qui n'a pas lieu avant l'expiration."
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit]
}

# --- Politique de bucket ------------------------------------------------------

data "aws_iam_policy_document" "audit" {
  statement {
    sid    = "RefuserLeTransportEnClair"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.audit.arn,
      "${aws_s3_bucket.audit.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Le refus « hors du compte » du bucket d'état n'est **pas** repris ici, et ce
  # n'est pas un oubli : `aws:PrincipalAccount` n'est pas renseigné pour un
  # principal de service, si bien que le refus s'appliquerait à CloudTrail et à
  # Config eux-mêmes — le bucket d'audit ne recevrait plus rien. La frontière est
  # tenue autrement, par les conditions `aws:SourceAccount` et `aws:SourceArn` des
  # deux autorisations ci-dessous.

  statement {
    sid    = "CloudTrailLitLaConfigurationDuBucket"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid    = "CloudTrailDeposeSesJournaux"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    actions = ["s3:PutObject"]

    # Chemin imposé par CloudTrail, restreint au compte : la trace ne peut écrire
    # que sous son propre préfixe, jamais ailleurs dans le bucket.
    resources = ["${aws_s3_bucket.audit.arn}/${local.cloudtrail_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid    = "ConfigLitLaConfigurationDuBucket"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }

    actions = [
      "s3:GetBucketAcl",
      "s3:ListBucket",
    ]

    resources = [aws_s3_bucket.audit.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "ConfigDeposeSesInstantanes"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/${local.config_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/Config/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit.json

  # Poser le blocage d'accès public avant la politique : l'ordre inverse ouvre une
  # fenêtre, si courte soit-elle, où le bucket n'a ni l'un ni l'autre.
  depends_on = [aws_s3_bucket_public_access_block.audit]
}
