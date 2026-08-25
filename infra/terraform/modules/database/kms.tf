# Chiffrement au repos (CDC §4.5, skill aws-infra §6) : stockage, instantanés,
# journaux de Performance Insights et secret du mot de passe maître partagent la
# même clé.
#
# Le module crée sa clé par défaut plutôt que d'utiliser `aws/rds`. Une clé gérée
# par AWS ne peut ni recevoir de politique, ni être auditée par utilisateur, ni
# accompagner un instantané partagé vers un autre compte — trois besoins qui
# arrivent le jour où l'on en a besoin tout de suite. `kms_key_arn` permet à
# l'environnement de fournir la sienne, partagée avec le module cache.
#
# Aucune politique de clé n'est déclarée : sans bloc `policy`, KMS installe la
# politique par défaut, qui délègue les autorisations à IAM pour le compte
# propriétaire. Une politique écrite à la main et incomplète, elle, rend la clé
# — et donc la base — définitivement inaccessible.

resource "aws_kms_key" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  description             = "Chiffrement RDS PostgreSQL ${local.name_prefix}"
  deletion_window_in_days = var.kms_deletion_window_in_days

  # La rotation annuelle ne réécrit pas les données déjà chiffrées : elle limite
  # le volume protégé par une même version de clé.
  enable_key_rotation = true

  tags = {
    Name = "${local.name_prefix}-rds-kms"
  }
}

resource "aws_kms_alias" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  name          = "alias/${local.name_prefix}-rds"
  target_key_id = aws_kms_key.this[0].key_id
}
