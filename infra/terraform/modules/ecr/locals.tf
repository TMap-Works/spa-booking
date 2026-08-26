locals {
  name_prefix = "spa-${var.environment}"

  # `spa-{env}-{app}` — exactement les noms que `deploy-dev.yml` construit pour
  # pousser les images. Le nom du dépôt fait partie du contrat entre
  # l'infrastructure et les workflows de déploiement : le changer casse le push.
  repository_names = { for app in var.applications : app => "${local.name_prefix}-${app}" }

  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : aws_kms_key.this[0].arn
}
