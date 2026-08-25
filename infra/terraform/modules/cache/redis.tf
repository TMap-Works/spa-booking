# Groupe de réplication ElastiCache Redis (CDC §4.5).
#
# Un seul fragment, un primaire et `replica_count` réplicas : le MVP n'a pas de
# volume qui justifie le mode clusterisé, et le mode non fragmenté garde une
# connexion cliente ordinaire. Passer au mode clusterisé plus tard change le
# client autant que l'infrastructure — c'est une décision à prendre sur des
# métriques, pas par anticipation.

# --- Jeton AUTH ---------------------------------------------------------------
#
# ElastiCache n'a pas d'équivalent du `manage_master_user_password` de RDS : il
# n'existe aucun moyen de faire engendrer le jeton par le service et de le
# déposer lui-même dans Secrets Manager. Le module l'engendre donc, et
# l'écrit dans un secret chiffré par la même clé KMS que les données.
#
# La conséquence est assumée et vaut d'être écrite : contrairement au mot de
# passe RDS, **ce jeton se retrouve dans l'état Terraform**. Ce qui le protège
# est le backend de #136 — bucket chiffré, versionné, accès restreint — et non
# le module. C'est la raison pour laquelle il n'apparaît dans aucune sortie :
# qui doit le lire le demande à Secrets Manager, ce qui laisse une trace
# CloudTrail que la lecture d'un état ne laisse pas.
#
# `auth_token_enabled = false` reste possible sur un environnement jetable. Le
# chiffrement en transit, lui, n'est pas négociable et n'est pas une variable.

resource "random_password" "auth_token" {
  count = var.auth_token_enabled ? 1 : 0

  length  = 64
  special = true

  # ElastiCache refuse `/`, `"`, `@` et l'espace dans un jeton AUTH. Restreindre
  # l'alphabet des caractères spéciaux est plus sûr que de compter sur le hasard
  # pour ne pas en tirer un.
  override_special = "!&#$^<>-"
}

resource "aws_secretsmanager_secret" "auth_token" {
  count = var.auth_token_enabled ? 1 : 0

  # `name_prefix` plutôt qu'un nom figé : un secret supprimé reste réservé
  # pendant sa fenêtre de récupération, et un nom figé ferait échouer tout
  # `apply` de reconstruction pendant ce délai. L'ARN, lui, est une sortie.
  name_prefix = "${local.name_prefix}/redis/auth-token-"
  description = "Jeton AUTH Redis de ${local.identifier}"
  kms_key_id  = local.kms_key_arn

  recovery_window_in_days = var.secret_recovery_window_in_days

  tags = {
    Name = "${local.identifier}-auth-token"
    Tier = "data"
  }
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  count = var.auth_token_enabled ? 1 : 0

  secret_id = aws_secretsmanager_secret.auth_token[0].id

  # Le jeton seul, sans enrobage JSON : l'hôte et le port ne sont pas des
  # secrets et voyagent dans les variables d'environnement de la tâche, ce qui
  # laisse ce secret se mapper directement sur une entrée `secrets` de la
  # définition de tâche ECS (skill aws-infra §7).
  secret_string = random_password.auth_token[0].result
}

# --- Journaux -----------------------------------------------------------------
#
# Les groupes sont créés ici, avant le cluster, pour porter une rétention
# explicite : laissés à ElastiCache, ils naissent sans expiration et se paient
# indéfiniment (skill aws-infra §8).

resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(local.cloudwatch_log_types)

  name              = "/aws/elasticache/${local.identifier}/${each.value}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "${local.identifier}-${each.value}"
  }
}

# --- Cluster ------------------------------------------------------------------

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.identifier
  description          = "Cache applicatif et verrous de ${local.name_prefix}"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = local.redis_port

  num_cache_clusters         = local.cache_cluster_count
  automatic_failover_enabled = local.automatic_failover_enabled
  multi_az_enabled           = var.multi_az

  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.this.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  # --- Chiffrement ----------------------------------------------------------
  # Les deux sont posés en dur, sans variable : ce sont des critères
  # d'acceptation du ticket, pas des réglages d'environnement. Basculer l'un des
  # deux sur un cluster existant le fait recréer, ce que le plan montrera.
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = local.kms_key_arn

  auth_token = var.auth_token_enabled ? random_password.auth_token[0].result : null
  # `ROTATE` ajoute le nouveau jeton avant de retirer l'ancien : les connexions
  # en cours survivent au changement. `null` quand il n'y a pas de jeton — le
  # fournisseur refuse cet argument sans `auth_token`.
  auth_token_update_strategy = var.auth_token_enabled ? "ROTATE" : null

  # --- Sauvegardes et fenêtres ----------------------------------------------
  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = var.snapshot_retention_limit > 0 ? var.snapshot_window : null
  maintenance_window       = var.maintenance_window

  # --- Mises à jour ---------------------------------------------------------
  #
  # Faux, contrairement au module database, et ce n'est pas une inattention.
  # ElastiCache tient 7.1 → 7.2 pour une mise à jour mineure et la passerait dans
  # la fenêtre de maintenance. Le plan suivant comparerait alors un cluster en 7.2
  # à une configuration en 7.1, y verrait une **rétrogradation** — que le
  # fournisseur traite en `ForceNew` — et proposerait de détruire puis recréer le
  # groupe de réplication : nouveau point d'accès, cache et verrous perdus, coupure.
  # Le tout sans qu'aucune ligne de code n'ait bougé.
  #
  # `aws_db_instance` échappe à ce piège parce que son `engine_version` absorbe le
  # suffixe mineur : `16` couvre `16.4`. ElastiCache n'a pas d'équivalent — la
  # version doit être écrite en `majeure.mineure`. La monter est donc un geste
  # délibéré, dans le code, comme le reste de l'infrastructure.
  auto_minor_version_upgrade = false
  apply_immediately          = var.apply_immediately

  # --- Observabilité --------------------------------------------------------
  dynamic "log_delivery_configuration" {
    for_each = toset(local.cloudwatch_log_types)

    content {
      destination      = aws_cloudwatch_log_group.this[log_delivery_configuration.value].name
      destination_type = "cloudwatch-logs"
      log_format       = "json"
      log_type         = log_delivery_configuration.value
    }
  }

  tags = {
    Name = local.identifier
    Tier = "data"
  }

  lifecycle {
    precondition {
      condition     = !var.multi_az || var.replica_count >= 1
      error_message = "multi_az exige au moins un réplica : sans nœud de secours, il n'y a nulle part où basculer."
    }

    # Les exigences de production, tenues par le code plutôt que par la
    # relecture. Elles ne mettent aucune valeur d'environnement dans le module :
    # elles refusent seulement qu'un environnement nommé `prod` soit configuré
    # comme un bac à sable.
    precondition {
      condition     = !local.is_production || var.replica_count >= 1
      error_message = "replica_count doit valoir au moins 1 en production (skill aws-infra §6) : sans réplica, la perte du nœud primaire est une perte de service."
    }

    precondition {
      condition     = !local.is_production || var.multi_az
      error_message = "multi_az doit valoir true en production : un réplica dans la même zone que son primaire ne protège pas d'une panne de zone."
    }

    precondition {
      condition     = !local.is_production || var.auth_token_enabled
      error_message = "auth_token_enabled doit valoir true en production : le groupe de sécurité protège du reste du VPC, le jeton protège de ce qui tourne déjà dans le niveau applicatif."
    }
  }
}
