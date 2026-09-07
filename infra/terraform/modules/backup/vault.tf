# Coffre AWS Backup et sa clé.
#
# Une clé **distincte** de celle du module `database`, et c'est le point qui
# justifie ce module à lui seul. Une sauvegarde chiffrée par la clé de la
# ressource qu'elle sauvegarde ne survit pas à la perte de cette clé : la
# suppression de la clé RDS — sept à trente jours après la commande, sans retour
# possible — rendrait illisibles à la fois l'instance et l'intégralité de ses
# points de restauration. Deux clés, deux rayons d'explosion.
#
# `kms_key_arn` reste ouvert pour l'environnement qui gère ses clés ailleurs ;
# le README dit ce qu'elle doit alors autoriser.

resource "aws_kms_key" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  description             = "Chiffrement du coffre AWS Backup ${local.name_prefix}"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true

  tags = {
    Name = "${local.vault_name}-kms"
  }
}

resource "aws_kms_alias" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  name          = "alias/${local.vault_name}"
  target_key_id = aws_kms_key.this[0].key_id
}

resource "aws_backup_vault" "this" {
  name        = local.vault_name
  kms_key_arn = local.kms_key_arn

  # Vrai, `terraform destroy` emporte les points de restauration avec le coffre.
  # Faux — le défaut, et une précondition l'impose en production —, la
  # destruction échoue tant qu'un point subsiste, ce qui est exactement la
  # protection attendue d'un coffre de sauvegarde.
  force_destroy = var.force_destroy

  tags = {
    Name = local.vault_name
    Tier = "data"
  }

  lifecycle {
    precondition {
      condition     = !local.is_production || !var.force_destroy
      error_message = "force_destroy doit valoir false en production : un `destroy` lancé sur le mauvais répertoire emporterait le coffre et tous ses points de restauration d'un seul geste."
    }
  }
}

# Verrou de coffre, en mode gouvernance uniquement — voir la variable pour les
# raisons pour lesquelles le mode conformité n'est pas exposé. L'absence de
# `changeable_for_days` est ce qui fait la différence entre les deux modes : la
# renseigner basculerait le coffre en conformité, irréversiblement.
resource "aws_backup_vault_lock_configuration" "this" {
  count = var.vault_lock == null ? 0 : 1

  backup_vault_name  = aws_backup_vault.this.name
  min_retention_days = var.vault_lock.min_retention_days
  max_retention_days = var.vault_lock.max_retention_days
}
