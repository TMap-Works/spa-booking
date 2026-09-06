data "aws_region" "current" {}

locals {
  name_prefix = "spa-${var.environment}"

  # --- Ce que l'environnement compose -----------------------------------------
  #
  # Trois interrupteurs lus dans la *configuration* et non dans les attributs des
  # ressources amont : voir l'en-tête de `variable "alb"` pour la raison, qui
  # coûte un `apply` échoué à qui l'ignore.
  alb_enabled = var.alb != null
  ecs_enabled = var.ecs != null
  rds_enabled = var.rds != null

  # --- Seuils dérivés ---------------------------------------------------------

  # Le critère du CDC est « connexions RDS au-dessus de 80 % du maximum », mais
  # CloudWatch ne connaît que `DatabaseConnections`, un compte absolu : le
  # pourcentage se transforme donc en nombre ici, une fois, plutôt que dans la
  # tête de qui lit l'alarme.
  rds_connections_threshold = local.rds_enabled ? floor(var.rds.max_connections * var.rds.connections_percent / 100) : null

  # Même traduction pour l'espace disque : `FreeStorageSpace` est en octets, le
  # critère en pourcentage. La base est le volume **provisionné** et non le
  # plafond d'extension automatique — un pourcentage du plafond décrirait un
  # disque qui n'existe pas encore. C'est aussi ce qui fait de l'alarme un
  # avertissement plutôt qu'un constat : RDS n'étend le volume de lui-même qu'en
  # dessous de 10 %, et l'opération prend plusieurs minutes.
  rds_free_storage_threshold_bytes = local.rds_enabled ? floor(var.rds.allocated_storage_gib * 1024 * 1024 * 1024 * var.rds.free_storage_percent / 100) : null

  # --- Traçage ----------------------------------------------------------------

  # `spa-{env}-*` par défaut : les trois environnements partagent un compte, donc
  # un jeu de règles d'échantillonnage. Une règle en `*` posée par dev
  # gouvernerait le traçage de la production.
  tracing_service_name = coalesce(var.tracing.service_name, "${local.name_prefix}-*")
}
