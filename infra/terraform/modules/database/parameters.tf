# Groupe de sous-réseaux et groupe de paramètres — tout ce qui doit exister
# avant l'instance elle-même.

resource "aws_db_subnet_group" "this" {
  name        = "${local.name_prefix}-rds"
  description = "Sous-reseaux prives de donnees pour ${local.identifier}"
  subnet_ids  = var.subnet_ids

  tags = {
    Name = "${local.name_prefix}-rds"
  }
}

# Le groupe de paramètres est attaché à l'instance : Terraform ne peut pas le
# supprimer tant qu'elle le référence. `create_before_destroy` inverse l'ordre,
# sans quoi le moindre changement de paramètre échoue au milieu de l'`apply`.
resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.name_prefix}-${local.parameter_group_family}-"
  family      = local.parameter_group_family
  description = "Parametres PostgreSQL de ${local.identifier}"

  # `rds.allowed_extensions` restreint les extensions installables. Le poser
  # explicitement fait de `btree_gist` une garantie vérifiable dans le code, et
  # non une propriété implicite du catalogue RDS du jour : c'est cette extension
  # qui autorise une contrainte d'exclusion sur une paire (identifiant de
  # ressource, plage de temps), donc la seule barrière réelle contre la double
  # réservation. Paramètre statique — d'où `pending-reboot`.
  dynamic "parameter" {
    for_each = length(var.allowed_extensions) > 0 ? [1] : []

    content {
      name         = "rds.allowed_extensions"
      value        = join(",", var.allowed_extensions)
      apply_method = "pending-reboot"
    }
  }

  # `pg_stat_statements` doit être préchargée au démarrage du moteur : sans elle,
  # Performance Insights montre l'attente mais pas la requête qui la cause.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  # Refus des connexions non chiffrées. Le chiffrement en transit ne se déduit
  # pas de l'isolation réseau : un client mal configuré parlerait en clair sur un
  # réseau que d'autres tenants traverseront un jour.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Règle de code du projet : tout est stocké en UTC et converti à l'affichage
  # selon le fuseau du tenant. Le poser explicitement évite qu'une valeur héritée
  # d'un jour à l'autre ne décale silencieusement chaque rendez-vous.
  parameter {
    name  = "timezone"
    value = "UTC"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_statement)
  }

  dynamic "parameter" {
    for_each = var.extra_parameters

    content {
      name         = parameter.key
      value        = parameter.value.value
      apply_method = parameter.value.apply_method
    }
  }

  tags = {
    Name = "${local.name_prefix}-${local.parameter_group_family}"
  }

  lifecycle {
    create_before_destroy = true
  }
}
