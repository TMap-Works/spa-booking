# Politique de cycle de vie — la seule chose qui empêche le stockage ECR de
# croître indéfiniment (skill aws-infra §9).
#
# Chaque push sur `develop` publie une image par application, étiquetée par le
# SHA du commit. Sans plafond, un an de déploiements laisse plusieurs centaines
# de gigaoctets facturés pour des images que personne ne tirera jamais.
#
# **L'ordre des règles compte** : ECR les évalue par `rulePriority` croissante et
# la première qui s'applique à une image l'emporte. Les images sans étiquette
# sont donc traitées en premier, sur un critère d'âge ; le décompte des images
# étiquetées vient ensuite.

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Supprimer les images sans étiquette après ${var.untagged_image_retention_days} jours."
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_retention_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Ne conserver que les ${var.max_tagged_images} images les plus récentes, étiquetées ou non."
        selection = {
          # `any` et non `tagged` : ECR exige un `tagPrefixList` avec `tagged`, or
          # les images sont étiquetées par SHA de commit, qui ne partage aucun
          # préfixe. Une règle à préfixe ne sélectionnerait rien et le dépôt
          # grossirait sans que rien ne le dise.
          #
          # **Conséquence à ne pas ignorer** : `any` compte aussi les images
          # devenues orphelines que la règle 1 n'a pas encore expirées. Le nombre
          # d'images *étiquetées* réellement conservées peut donc descendre
          # sous `max_tagged_images` — au pire de ce qu'une fenêtre de
          # `untagged_image_retention_days` jours accumule. Dimensionner
          # `max_tagged_images` en conséquence si le retour arrière doit couvrir
          # un nombre garanti de déploiements.
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.max_tagged_images
        }
        action = { type = "expire" }
      },
    ]
  })
}
