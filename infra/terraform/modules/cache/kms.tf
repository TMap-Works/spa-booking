# Chiffrement au repos (CDC §4.5, skill aws-infra §6) : données du nœud,
# instantanés et secret du jeton AUTH partagent la même clé.
#
# Même arbitrage que dans le module database : une clé gérée par AWS ne peut ni
# recevoir de politique, ni être auditée par utilisateur, ni accompagner un
# instantané partagé vers un autre compte. `kms_key_arn` permet à
# l'environnement de repasser ici la clé du module database — c'est le montage
# attendu, et il n'en laisse qu'une à administrer pour tout le niveau données.
#
# Aucune politique de clé n'est déclarée : sans bloc `policy`, KMS installe la
# politique par défaut, qui délègue les autorisations à IAM pour le compte
# propriétaire. Une politique écrite à la main et incomplète, elle, rend la clé
# — et donc le cache — définitivement inaccessible.

resource "aws_kms_key" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  description             = "Chiffrement ElastiCache Redis ${local.name_prefix}"
  deletion_window_in_days = var.kms_deletion_window_in_days

  # La rotation annuelle ne réécrit pas les données déjà chiffrées : elle limite
  # le volume protégé par une même version de clé.
  enable_key_rotation = true

  tags = {
    Name = "${local.name_prefix}-redis-kms"
  }
}

resource "aws_kms_alias" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  name          = "alias/${local.name_prefix}-redis"
  target_key_id = aws_kms_key.this[0].key_id
}
