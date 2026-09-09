# Le bucket des exports du reporting — #563, premier critère.
#
# Ce qu'il contient : des fichiers CSV d'indicateurs, déposés par l'API sous
# `exports/{tenant_id}/{export_id}.csv`, servis par URL présignée de quinze
# minutes au plus, et purgés au bout de `retention_days`.
#
# Ce qu'il ne contient **jamais** : aucune donnée de carte bancaire (le périmètre
# PCI du projet s'arrête à Stripe), aucun nom de cliente, aucune adresse. Les
# rapports que l'API sérialise ne portent que des chiffres et des noms publics —
# celui d'un praticien, celui d'une prestation (voir l'en-tête de
# `apps/api/src/modules/reporting/reporting.types.ts`).
#
# Ce qu'il porte quand même de sensible, et qui justifie tout ce qui suit : le
# **chiffre d'affaires** de chaque établissement, jour par jour. C'est ce qu'un
# concurrent paierait pour lire, et c'est la seule raison pour laquelle ce bucket
# n'est ni public, ni joignable en clair, ni durable.

# Journaux d'accès S3 non activés, pour la raison déjà annotée sur les buckets
# d'état et d'audit du bootstrap : ils exigeraient un bucket de destination
# soumis au même contrôle, et la règle se mord la queue. Les événements de
# données du trail du compte couvrent les accès aux objets, y compris ceux faits
# par URL présignée.
#
# La directive doit rester collée au bloc : tfsec ne rattache une exemption qu'à
# la ligne qui la suit immédiatement.
#tfsec:ignore:aws-s3-enable-bucket-logging
resource "aws_s3_bucket" "exports" {
  bucket = local.bucket_name

  # `force_destroy` volontairement laissé à son défaut (`false`). Le bucket est
  # censé être vide ou presque — le cycle de vie le purge —, et un
  # `terraform destroy` qui échoue parce qu'un export d'hier traîne encore est
  # une bonne surprise plutôt qu'une mauvaise : il dit que la purge n'a pas eu
  # lieu.

  tags = {
    Name = local.bucket_name
  }
}

# Versionnement **désactivé**, et c'est un choix, pas un oubli.
#
# Un objet de ce bucket est écrit une fois, sous une clé tirée au sort, et n'est
# jamais réécrit : il n'y a pas d'historique à conserver, et rien à restaurer
# d'un écrasement qui ne peut pas se produire. Ce que le versionnement
# apporterait ici est une seconde population d'objets — les versions non
# courantes — qu'il faudrait purger par une seconde règle de cycle de vie, et
# qu'une règle mal écrite laisserait vivre indéfiniment. C'est exactement la
# façon dont un bucket « purgé » finit par contenir cinq ans de chiffre
# d'affaires.
#
# La directive doit rester collée au bloc.
#tfsec:ignore:aws-s3-enable-versioning
resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id

  versioning_configuration {
    status = "Suspended"
  }
}

# Chiffrement au repos, appliqué **par défaut à tout objet déposé**. L'API ne
# demande donc rien à l'écriture : deux endroits qui décideraient du chiffrement
# finiraient par diverger, et c'est celui qui n'est pas dans ce fichier qu'on
# oublierait de revoir.
resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.customer_managed_key ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn
    }

    # Sans effet en SSE-S3 ; en SSE-KMS, une clé de compartiment évite un appel
    # KMS par objet — sur un export par écran et par jour, c'est marginal, mais
    # c'est gratuit.
    bucket_key_enabled = local.customer_managed_key
  }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket = aws_s3_bucket.exports.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# `BucketOwnerEnforced` désactive les ACL : la politique de bucket devient le
# seul mécanisme d'autorisation. Rien ici n'écrit d'ACL — l'API dépose sous le
# rôle de tâche, dans le compte propriétaire.
resource "aws_s3_bucket_ownership_controls" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Le cycle de vie — la moitié du premier critère de #563 qui n'est ni le
# chiffrement ni l'absence de surface publique.
#
# Deux règles, et elles ne font pas la même chose : la première supprime les
# exports, la seconde ramasse les envois multipart abandonnés. Ces derniers ne
# sont **pas** des objets : ils ne relèvent d'aucune règle d'expiration, ils sont
# invisibles à un `ListObjects`, et ils sont facturés jusqu'à ce qu'on les
# abandonne explicitement. Un export interrompu par un redéploiement d'ECS en
# laisse un.
resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    id     = "purger-les-exports"
    status = "Enabled"

    # Le filtre porte sur le préfixe des exports plutôt que sur tout le bucket :
    # si un jour un autre usage y dépose quoi que ce soit, il ne disparaîtra pas
    # au bout de sept jours parce qu'une règle écrite pour les exports l'aura
    # emporté au passage.
    filter {
      prefix = "${local.export_prefix}/"
    }

    expiration {
      days = var.retention_days
    }
  }

  rule {
    id     = "abandonner-les-envois-multipart-incomplets"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# --- Politique de bucket ------------------------------------------------------

data "aws_iam_policy_document" "exports" {
  # Le transport en clair est refusé pour **tout le monde**, y compris pour nos
  # propres rôles. Une URL présignée est un lien qu'on colle dans un navigateur :
  # sans ce refus, un `http://` recopié à la main livrerait le chiffre d'affaires
  # d'un salon sur le réseau du salon.
  statement {
    sid    = "RefuserLeTransportEnClair"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.exports.arn,
      "${aws_s3_bucket.exports.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Rien de ce bucket n'a de raison d'être touché depuis un autre compte. Le
  # refus est écrit ici plutôt que laissé à l'absence d'autorisation : une
  # politique de rôle ajoutée par mégarde dans un compte tiers ne suffirait pas à
  # ouvrir la porte, il faudrait aussi retirer cet énoncé.
  #
  # Aucun principal de service n'écrit ici — contrairement au bucket d'audit, où
  # ce même refus aurait coupé CloudTrail —, la condition est donc sans effet de
  # bord.
  statement {
    sid    = "RefuserHorsDuCompte"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.exports.arn,
      "${aws_s3_bucket.exports.arn}/*",
    ]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "exports" {
  bucket = aws_s3_bucket.exports.id
  policy = data.aws_iam_policy_document.exports.json

  # Poser le blocage d'accès public avant la politique : l'ordre inverse ouvre
  # une fenêtre, si courte soit-elle, où le bucket n'a ni l'un ni l'autre.
  depends_on = [aws_s3_bucket_public_access_block.exports]
}
