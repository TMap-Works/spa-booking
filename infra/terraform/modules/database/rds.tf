# Instance RDS PostgreSQL (CDC §4.5).
#
# Le mot de passe maître mérite un mot : `manage_master_user_password` fait
# générer le mot de passe par RDS, qui le dépose lui-même dans un secret de
# Secrets Manager et sait le faire tourner. Terraform ne le voit jamais — ni
# dans le code, ni dans un `.tfvars`, ni **dans l'état**. C'est ce dernier point
# qui écarte l'alternative `random_password` : elle sort le secret des fichiers
# versionnés, mais l'écrit en clair dans un état que lit toute personne autorisée
# sur le bucket. Le module n'expose que l'ARN du secret ; qui doit le lire le
# demande à Secrets Manager, ce qui laisse une trace CloudTrail.

# Le nom de l'instantané final doit être unique et ne peut pas dépendre de
# `timestamp()`, qui rendrait chaque plan différent du précédent. Un suffixe
# aléatoire figé dans l'état donne un nom stable tant que l'instance ne change
# pas d'identifiant.
resource "random_id" "final_snapshot" {
  byte_length = 4

  keepers = {
    identifier = local.identifier
  }
}

# Journaux exportés vers CloudWatch. Les groupes sont créés ici, avant
# l'instance, pour porter une rétention explicite : laissés à RDS, ils naissent
# sans expiration et se paient indéfiniment (skill aws-infra §8).
resource "aws_cloudwatch_log_group" "this" {
  for_each = toset(local.cloudwatch_log_types)

  name              = "/aws/rds/instance/${local.identifier}/${each.value}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "${local.identifier}-${each.value}"
  }
}

resource "aws_db_instance" "this" {
  identifier = local.identifier

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  # --- Stockage -------------------------------------------------------------
  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true
  kms_key_id            = local.kms_key_arn

  # --- Base et compte maître ------------------------------------------------
  db_name  = var.database_name
  username = var.master_username

  manage_master_user_password   = true
  master_user_secret_kms_key_id = local.kms_key_arn

  iam_database_authentication_enabled = var.iam_database_authentication_enabled

  # --- Réseau ---------------------------------------------------------------
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  port                   = local.postgres_port

  # Redondant avec des sous-réseaux sans route vers Internet, et posé quand même :
  # c'est la seule ligne qu'un relecteur cherche, et la seule qui protège encore
  # si le module était un jour composé sur d'autres sous-réseaux.
  publicly_accessible = false

  # --- Paramètres du moteur -------------------------------------------------
  parameter_group_name = aws_db_parameter_group.this.name

  # --- Résilience et sauvegardes --------------------------------------------
  multi_az                = var.multi_az
  backup_retention_period = var.backup_retention_period
  backup_window           = var.backup_window
  maintenance_window      = var.maintenance_window
  copy_tags_to_snapshot   = true

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.identifier}-final-${random_id.final_snapshot.hex}"

  # --- Mises à jour ---------------------------------------------------------
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = var.apply_immediately

  # --- Observabilité --------------------------------------------------------
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = local.kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention_period

  monitoring_interval = var.monitoring_interval
  monitoring_role_arn = var.monitoring_interval == 0 ? null : var.monitoring_role_arn

  enabled_cloudwatch_logs_exports = local.cloudwatch_log_types

  tags = {
    Name = local.identifier
    Tier = "data"
  }

  # Les groupes de journaux doivent exister avant que RDS ne commence à exporter,
  # sinon il les crée lui-même sans rétention et Terraform bute ensuite dessus.
  depends_on = [aws_cloudwatch_log_group.this]

  lifecycle {
    # RDS n'exige pas seulement un plafond supérieur au stockage alloué : il le
    # veut supérieur d'au moins 10 %. Un plafond égal — la valeur qu'on écrit
    # naturellement en croyant « désactiver la marge » — passe le plan et fait
    # échouer l'`apply`.
    precondition {
      condition     = var.max_allocated_storage == 0 || var.max_allocated_storage >= var.allocated_storage * 1.1
      error_message = "max_allocated_storage doit valoir 0 (extension désactivée) ou dépasser allocated_storage d'au moins 10 % — le seuil qu'impose l'extension automatique du stockage RDS."
    }

    precondition {
      condition     = var.monitoring_interval == 0 || var.monitoring_role_arn != null
      error_message = "monitoring_interval non nul exige monitoring_role_arn : le monitoring renforcé publie ses métriques sous une identité IAM, que ce module ne crée pas."
    }

    # Les quatre exigences de production du CDC §4.5 et §4.14, tenues par le
    # code plutôt que par la relecture. Elles ne mettent aucune valeur
    # d'environnement dans le module : elles refusent seulement qu'un
    # environnement nommé `prod` soit configuré comme un bac à sable.
    precondition {
      condition     = !local.is_production || var.multi_az
      error_message = "multi_az doit valoir true en production (CDC §4.5) : sans instance de secours, une panne de zone est une panne de service."
    }

    precondition {
      condition     = !local.is_production || var.backup_retention_period >= 30
      error_message = "backup_retention_period doit valoir au moins 30 jours en production (CDC §4.14)."
    }

    precondition {
      condition     = !local.is_production || var.deletion_protection
      error_message = "deletion_protection doit valoir true en production : c'est ce qui arrête un destroy lancé sur le mauvais répertoire."
    }

    precondition {
      condition     = !local.is_production || !var.skip_final_snapshot
      error_message = "skip_final_snapshot doit valoir false en production : une suppression sans instantané final est irréversible."
    }
  }
}
