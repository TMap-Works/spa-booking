# Un dépôt d'images par application — `spa-{env}-api`, `spa-{env}-web`.

resource "aws_ecr_repository" "this" {
  for_each = local.repository_names

  name = each.value

  # Étiquettes immuables : republier `spa-dev-api:abc1234` est refusé par le
  # registre plutôt que de déplacer silencieusement l'étiquette.
  #
  # Ce n'est pas une précaution théorique. Une définition de tâche ECS référence
  # une image par étiquette ; si l'étiquette peut bouger, deux tâches de la même
  # révision peuvent tourner sur deux images différentes, et le contenu que le
  # scan de vulnérabilités a examiné n'est plus celui qui s'exécute.
  #
  # **Contrepartie, à connaître avant le premier incident** : les workflows de
  # déploiement étiquettent par `github.sha`. Republier le *même* commit — un
  # `workflow_dispatch` de `deploy-dev.yml`, ou la relance d'un job qui a échoué
  # après son `docker push` — se heurte alors à `ImmutableTagException` et
  # échoue avant l'`ecs update-service`. Redéployer un commit déjà publié se fait
  # donc en forçant un nouveau déploiement du service, pas en repoussant l'image
  # qui n'a pas changé. Voir le README.
  image_tag_mutability = "IMMUTABLE"

  # **Le scan de vulnérabilités du registre** (critère d'acceptation de l'issue
  # #15, CDC §4.13). Chaque image poussée est analysée à la publication, sans
  # aucune action de l'appelant.
  #
  # Ce n'est délibérément pas une variable : un environnement où le scan serait
  # désactivé n'est pas un réglage légitime, et le rendre configurable
  # reviendrait à laisser une porte ouverte pour un gain nul. Le scan de base est
  # par ailleurs gratuit — il n'y a même pas d'arbitrage de coût à faire.
  #
  # Il couvre le système d'exploitation de l'image. Les dépendances applicatives
  # sont couvertes en amont par le scan Trivy de `security-scan.yml`, qui lit le
  # dépôt : les deux sont complémentaires, aucun ne remplace l'autre.
  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = local.kms_key_arn
  }

  # Un dépôt qui contient encore des images refuse de disparaître, sauf demande
  # explicite : c'est la dernière barrière avant qu'un `destroy` mal ciblé
  # n'emporte les images que les tâches en service retireront au redémarrage.
  force_delete = var.force_delete

  tags = {
    Name        = each.value
    Application = each.key
  }
}
