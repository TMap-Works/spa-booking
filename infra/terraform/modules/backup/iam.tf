# Rôle de service d'AWS Backup.
#
# Un rôle créé par le module plutôt que le rôle par défaut `AWSBackupDefaultServiceRole` :
# ce dernier n'existe qu'après un passage dans la console, ce que la règle « aucune
# ressource AWS créée à la main » interdit, et il est partagé par tout le compte —
# donc par les trois environnements.
#
# Il porte **aussi** les droits de restauration. C'est délibéré : c'est ce rôle
# que le runbook passe à `start-restore-job`, et un second rôle qu'on découvrirait
# manquant le jour d'un incident vaut moins qu'un privilège un peu plus large
# sur un rôle que seul AWS Backup peut endosser.

data "aws_partition" "current" {}

data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }

    # Pas de condition `aws:SourceAccount` ici : AWS Backup n'endosse ce rôle que
    # pour des travaux du compte qui le porte, et la politique de confiance de
    # référence du service n'en pose pas. Une condition sur une clé que le service
    # ne renseigne pas refuserait *tout* — un rôle qu'on croit prêt et qui ne peut
    # rien sauvegarder.
  }
}

resource "aws_iam_role" "this" {
  name        = "${local.name_prefix}-backup"
  description = "Rôle de service AWS Backup — sauvegarde et restauration de ${var.environment}"

  assume_role_policy = data.aws_iam_policy_document.assume.json

  tags = {
    Name = "${local.name_prefix}-backup"
  }
}

# Les deux politiques managées du service. Écrire les mêmes droits à la main
# obligerait à les suivre à chaque type de ressource qu'AWS Backup ajoute — et
# une politique de sauvegarde qui prend du retard sur le service se découvre en
# restaurant.
resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

# Accès aux clés, explicitement. Les politiques managées couvrent les clés gérées
# par AWS et celles atteintes `kms:ViaService` ; nos clés sont gérées par le
# client et leur politique par défaut délègue à IAM — c'est donc au rôle de
# porter le droit, et il ne le porte que sur des ARN nommés.
data "aws_iam_policy_document" "kms" {
  statement {
    sid    = "UseBackupAndSourceKeys"
    effect = "Allow"

    actions = [
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
      "kms:RetireGrant",
    ]

    resources = distinct(concat([local.kms_key_arn], var.restore_kms_key_arns))
  }
}

resource "aws_iam_role_policy" "kms" {
  name   = "${local.name_prefix}-backup-kms"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.kms.json
}
