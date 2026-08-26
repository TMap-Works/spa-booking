# Chiffrement des couches d'image au repos (skill aws-infra §6).
#
# ECR chiffre de toute façon, en AES256 avec une clé qu'AWS détient seul. Une clé
# gérée par le client change trois choses : elle peut porter une politique, chaque
# déchiffrement est tracé par appelant dans CloudTrail, et la révoquer suffit à
# rendre le registre inexploitable sans avoir à supprimer quoi que ce soit.
#
# `kms_key_arn` permet à l'environnement de repasser ici une clé déjà administrée
# — celle du niveau données, par exemple — plutôt que d'en ajouter une à la
# rotation et à la surveillance.
#
# Aucune politique de clé n'est déclarée : sans bloc `policy`, KMS installe la
# politique par défaut, qui délègue les autorisations à IAM pour le compte
# propriétaire. Une politique écrite à la main et incomplète rendrait la clé — et
# donc toutes les images — définitivement inaccessible.

resource "aws_kms_key" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  description             = "Chiffrement des images ECR ${local.name_prefix}"
  deletion_window_in_days = var.kms_deletion_window_in_days

  # La rotation annuelle ne rechiffre pas les couches déjà publiées : elle limite
  # le volume protégé par une même version de clé.
  enable_key_rotation = true

  tags = {
    Name = "${local.name_prefix}-ecr-kms"
  }
}

resource "aws_kms_alias" "this" {
  count = var.kms_key_arn == null ? 1 : 0

  name          = "alias/${local.name_prefix}-ecr"
  target_key_id = aws_kms_key.this[0].key_id
}
