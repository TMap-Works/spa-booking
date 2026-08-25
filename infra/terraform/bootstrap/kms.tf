# Une clé par environnement, et non une clé partagée : un rôle qui peut déchiffrer
# l'état de dev ne doit rien pouvoir lire de celui de production. C'est la même
# frontière que celle des buckets, appliquée au chiffrement.
#
# Aucune politique de clé explicite : la politique par défaut délègue à IAM. La
# frontière ci-dessus n'existe donc que si les politiques IAM ciblent l'ARN d'une
# clé précise — un `kms:Decrypt` sur `*` les traverse toutes. À cadrer dans le rôle
# OIDC (#14). Une politique explicite ici exposerait au verrouillage définitif de
# l'état si elle était mal écrite : le garde-fou est volontairement côté IAM.

resource "aws_kms_key" "state" {
  for_each = var.environments

  description             = "Chiffrement de l'état Terraform — ${each.key}"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true

  tags = {
    Name        = "spa-${each.key}-tfstate"
    Environment = each.key
  }
}

resource "aws_kms_alias" "state" {
  for_each = var.environments

  # C'est cet alias — et non l'ARN, qui contient l'identifiant de compte — que
  # référencent les blocs `backend` de envs/*, pour qu'ils restent littéraux et
  # versionnables sans exposer le compte.
  name          = "alias/spa-${each.key}-tfstate"
  target_key_id = aws_kms_key.state[each.key].key_id
}
