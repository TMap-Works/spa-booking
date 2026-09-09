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

  # --- Origine publique -------------------------------------------------------

  # Ce que le monde extérieur voit de ce déploiement. Déduite du nom DNS de l'ALB
  # tant qu'aucun domaine n'est fourni.
  #
  # Calculée **ici**, dans le module qui crée l'ALB, et non par l'environnement :
  # celui-ci devrait sinon lire la sortie `alb_dns_name` pour construire l'entrée
  # `services` du même module, ce que Terraform refuse. Vue du graphe, la
  # définition de tâche dépend de l'ALB — une arête de plus, dans le seul sens
  # qui existe.
  #
  # `aws_lb.this.dns_name` est en minuscules et sans point final : l'origine
  # produite est directement comparable à celle qu'un navigateur enverrait.
  public_base_url = var.public_base_url != null ? var.public_base_url : "https://${aws_lb.this.dns_name}"

  # --- Traçage distribué ------------------------------------------------------

  # Les services à tracer, sous une forme directement utilisable en `for_each` :
  # c'est la même sélection pour le sidecar et pour la politique du rôle de
  # tâche, et les faire diverger donnerait soit un démon sans droit de publier,
  # soit un droit sans démon pour s'en servir.
  xray_services = {
    for name, service in var.services : name => service if service.xray_tracing_enabled
  }

  # Le SDK X-Ray vise 127.0.0.1:2000 par défaut ; le poser explicitement rend la
  # dépendance visible dans la console ECS, là où on cherche pourquoi aucun
  # segment n'arrive. `LOG_ERROR` plutôt que le défaut `RUNTIME_ERROR` : une
  # requête hors contexte de trace — un travail de fond, un appel au démarrage —
  # ne doit pas faire lever l'application. Le traçage observe, il n'arbitre pas.
  xray_environment = {
    AWS_XRAY_CONTEXT_MISSING = "LOG_ERROR"
    AWS_XRAY_DAEMON_ADDRESS  = "127.0.0.1:2000"
  }

  # Variables d'environnement effectives du conteneur applicatif. La map fournie
  # par l'appelant reste la source de vérité de la précondition anti-secret :
  # ce qui est ajouté ici sont des adresses et un nom, pas des valeurs d'appelant.
  #
  # `AWS_XRAY_TRACING_NAME` n'est pas décoratif : c'est le **nom de service** que
  # le SDK déclare, et c'est sur lui que la règle d'échantillonnage du module
  # `observability` filtre (`spa-{env}-*`). Sans lui, le SDK nomme le segment
  # comme le veut le code applicatif, la règle ne trouve rien à gouverner, et
  # X-Ray retombe silencieusement sur sa règle `Default` — commune aux trois
  # environnements, qui partagent un compte. La panne est muette : des traces
  # arrivent, simplement pas à l'échantillonnage qu'on croit avoir posé.
  # L'origine publique s'y ajoute par `public_url_env_vars`, sous les noms que le
  # service demande. Aucun risque d'écraser une valeur de l'appelant : une
  # validation de `services` refuse la collision au plan, avec le nom du service
  # et celui de la variable.
  service_environment = {
    for name, service in var.services :
    name => merge(
      service.environment,
      { for variable_name in service.public_url_env_vars : variable_name => local.public_base_url },
      service.xray_tracing_enabled ? merge(local.xray_environment, {
        AWS_XRAY_TRACING_NAME = "${local.name_prefix}-${name}"
      }) : {},
    )
  }
}
