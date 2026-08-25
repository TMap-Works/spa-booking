data "aws_caller_identity" "current" {}

# Les journaux d'accès S3 exigeraient un bucket de destination, lui-même soumis au
# même contrôle — la règle se mord la queue. Les accès à l'état sont tracés par
# CloudTrail (événements de données), qui couvre aussi les lectures faites hors S3.
#
# La directive ci-dessous doit rester collée au bloc : tfsec ne rattache une
# exemption qu'à la ligne qui la suit immédiatement. Intercaler ne serait-ce qu'une
# ligne de commentaire la rend inopérante, et le scan `security-scan.yml` échoue.
#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "state" {
  for_each = var.environments

  bucket = "${var.state_bucket_prefix}-${each.key}-tfstate"

  # Un bucket d'état détruit, c'est une infrastructure entière devenue orpheline :
  # les ressources continuent d'exister et d'être facturées, mais plus rien ne sait
  # les nommer. Le garde-fou est volontairement non paramétrable.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "${var.state_bucket_prefix}-${each.key}-tfstate"
    Environment = each.key
  }
}

# Critère : état versionné. C'est la seule façon de revenir à un état antérieur
# après un `apply` malheureux — sans versions, une corruption est définitive.
resource "aws_s3_bucket_versioning" "state" {
  for_each = var.environments

  bucket = aws_s3_bucket.state[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

# Critère : état chiffré. `bucket_key_enabled` réduit d'environ deux ordres de
# grandeur le nombre d'appels KMS facturés, sans changer la protection.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  for_each = var.environments

  bucket = aws_s3_bucket.state[each.key].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state[each.key].arn
    }
    bucket_key_enabled = true
  }
}

# Critère : accès public bloqué. Les quatre interrupteurs, sans exception — trois
# sur quatre laissent une porte ouverte.
resource "aws_s3_bucket_public_access_block" "state" {
  for_each = var.environments

  bucket = aws_s3_bucket.state[each.key].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Les ACL sont un mécanisme d'autorisation parallèle à la politique de bucket, et
# une source classique d'exposition accidentelle. `BucketOwnerEnforced` les
# désactive : seule la politique fait autorité.
resource "aws_s3_bucket_ownership_controls" "state" {
  for_each = var.environments

  bucket = aws_s3_bucket.state[each.key].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# L'état est réécrit à chaque `apply` : sans expiration, le bucket accumule des
# milliers de versions dont plus personne ne se sert.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  for_each = var.environments

  bucket = aws_s3_bucket.state[each.key].id

  rule {
    id     = "expirer-les-versions-anterieures"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
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

  depends_on = [aws_s3_bucket_versioning.state]
}

# Critère : accès restreint. Deux refus, évalués avant toute autorisation IAM.
data "aws_iam_policy_document" "state" {
  for_each = var.environments

  statement {
    sid    = "RefuserLeTransportEnClair"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.state[each.key].arn,
      "${aws_s3_bucket.state[each.key].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "RefuserHorsDuCompte"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.state[each.key].arn,
      "${aws_s3_bucket.state[each.key].arn}/*",
    ]

    # `aws:PrincipalAccount` est absent d'une requête anonyme : `StringNotEquals`
    # est alors vrai et le refus s'applique. Aucun partage inter-comptes n'est
    # prévu sur un bucket d'état.
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  for_each = var.environments

  bucket = aws_s3_bucket.state[each.key].id
  policy = data.aws_iam_policy_document.state[each.key].json

  # Poser le blocage d'accès public avant la politique : l'ordre inverse ouvre une
  # fenêtre, si courte soit-elle, où le bucket n'a ni l'un ni l'autre.
  depends_on = [aws_s3_bucket_public_access_block.state]
}
