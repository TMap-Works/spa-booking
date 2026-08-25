data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name_prefix = "spa-${var.environment}"

  # Ports distincts exposés par les conteneurs. La chaîne ALB → tâches n'ouvre
  # que ceux-là : deux services qui écoutent le même port partagent une règle au
  # lieu d'en ajouter une identique. Les clés sont des chaînes — `for_each`
  # n'accepte pas un ensemble de nombres.
  container_ports = toset([for service in values(var.services) : tostring(service.container_port)])

  # Combinaisons CPU / mémoire acceptées par Fargate. Les vérifier au plan
  # transforme un `apply` refusé sur « Invalid CPU or Memory value specified »,
  # message qui ne dit pas laquelle des deux valeurs est en cause, en une erreur
  # qui nomme le service fautif et énumère ce qui est possible.
  fargate_memory_by_cpu = {
    "256"   = [512, 1024, 2048]
    "512"   = range(1024, 4097, 1024)
    "1024"  = range(2048, 8193, 1024)
    "2048"  = range(4096, 16385, 1024)
    "4096"  = range(8192, 30721, 1024)
    "8192"  = range(16384, 61441, 4096)
    "16384" = range(32768, 122881, 8192)
  }

  # Un ARN de secret peut porter, dans le champ `valueFrom` d'une définition de
  # tâche, un suffixe `:clé-json:étiquette:version`. IAM, lui, n'autorise que
  # l'ARN du secret : les sept premiers champs, jusqu'au nom versionné inclus.
  # Accorder le droit sur l'ARN suffixé produirait une politique qui n'autorise
  # rien, et un démarrage de tâche en échec au lieu d'une erreur de plan.
  secret_arns_by_service = {
    for name, service in var.services :
    name => distinct([
      for arn in values(service.secret_arns) : join(":", slice(split(":", arn), 0, 7))
    ])
  }

  # Nom du groupe cible, borné par l'API à 32 caractères. Calculé ici pour que la
  # précondition qui le contrôle et la ressource qui le porte lisent la même
  # expression.
  target_group_names = {
    for name in keys(var.services) : name => "${local.name_prefix}-${name}"
  }
}
