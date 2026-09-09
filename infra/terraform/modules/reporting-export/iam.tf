# La politique que le rôle de tâche de l'API porte pour produire et signer un
# export — #563.
#
# ## Trois actions, et pas une de plus
#
# | Action | Pourquoi elle est là |
# |---|---|
# | `s3:PutObject` | déposer le fichier |
# | `s3:GetObject` | **signer** une lecture : une URL présignée est vérifiée avec les droits de qui l'a signée, un signataire sans ce droit produit des URL qui rendent 403 |
# | `s3:DeleteObject` | absent — c'est le cycle de vie qui purge, et un producteur qui pourrait effacer pourrait effacer autre chose que le sien |
#
# `s3:ListBucket` est **absent**, et c'est délibéré : ce droit ne s'attache pas
# aux objets mais au bucket entier, tous préfixes confondus. L'accorder pour
# vérifier l'existence d'un export reviendrait à donner à l'API le droit
# d'énumérer les exports de tous les établissements — la chose exacte que la
# clé préfixée par le `tenant_id` existe pour empêcher. Le code s'en passe :
# `HeadObject` interroge une clé exacte, et sur un bucket sans `ListBucket` S3
# répond 403 pour un objet absent, ce que le module traite comme un « rien ici »
# (voir `S3ReportExportStorage.exists`).
#
# ## La ressource est bornée au préfixe d'exports
#
# `arn:…:bucket/exports/*` et non `bucket/*`. Ce n'est pas une isolation entre
# établissements — elle, c'est la forme de la clé qui la tient, côté application,
# et aucune politique IAM statique ne saurait la reproduire pour des tenants qui
# n'existent pas encore. C'est une isolation entre **usages** : le jour où ce
# bucket sert à autre chose, l'API n'y aura toujours pas accès.

data "aws_iam_policy_document" "producer" {
  statement {
    sid    = "DeposerEtSignerUnExport"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:GetObject",
    ]

    resources = ["${aws_s3_bucket.exports.arn}/${local.export_prefix}/*"]
  }

  # Ajouté seulement quand le bucket chiffre par clé gérée par le client. En
  # SSE-S3, aucun droit KMS n'est requis — et un énoncé qui nommerait une clé
  # `null` ne serait pas seulement inutile, il ferait échouer le plan.
  dynamic "statement" {
    for_each = local.customer_managed_key ? [var.kms_key_arn] : []

    content {
      sid    = "ChiffrerEtDechiffrerLesExports"
      effect = "Allow"

      # `GenerateDataKey` pour écrire — S3 chiffre par enveloppe et ne demande
      # jamais à KMS de chiffrer le contenu lui-même —, `Decrypt` pour que
      # l'URL présignée soit honorée : c'est le **signataire** dont les droits
      # sont vérifiés au moment où quelqu'un suit le lien.
      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
      ]

      resources = [statement.value]
    }
  }
}

resource "aws_iam_policy" "producer" {
  name        = "${local.name_prefix}-reporting-export-producer"
  description = "Dépose et signe les exports de reporting dans ${local.bucket_name} — rôle de tâche de l'API."
  policy      = data.aws_iam_policy_document.producer.json

  tags = {
    Name = "${local.name_prefix}-reporting-export-producer"
  }
}
