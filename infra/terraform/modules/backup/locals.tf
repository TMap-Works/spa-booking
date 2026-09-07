locals {
  name_prefix = "spa-${var.environment}"

  vault_name = "${local.name_prefix}-backup"

  # Même test que le module `database`, et pour la même raison : il doit échouer
  # *fermé*. Une égalité stricte laisserait `production`, `prod-eu` ou `prod2`
  # désarmer silencieusement les préconditions de rétention.
  is_production = startswith(var.environment, "prod")

  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : aws_kms_key.this[0].arn

  # Les règles du plan, construites en une seule structure pour que `dynamic`
  # n'ait qu'un objet à parcourir. Une rétention nulle retire la règle : c'est la
  # forme que prend « cette cadence ne s'applique pas à cet environnement », sans
  # qu'il faille un booléen par règle en plus du nombre de jours.
  #
  # `continuous` est à part et vient en tête : elle ne produit pas d'instantané
  # mais la sauvegarde continue de RDS, c'est-à-dire la restauration à un instant
  # donné. C'est elle — et elle seule — qui tient le RPO ≤ 1 h du CDC §4.14 ; les
  # trois autres tiennent la rétention longue et auditable.
  rules = merge(
    var.continuous_backup_retention_days == 0 ? {} : {
      continuous = {
        schedule           = var.continuous_schedule
        delete_after       = var.continuous_backup_retention_days
        continuous_backup  = true
        recovery_point_tag = "continuous"
      }
    },
    var.daily_retention_days == 0 ? {} : {
      daily = {
        schedule           = var.daily_schedule
        delete_after       = var.daily_retention_days
        continuous_backup  = false
        recovery_point_tag = "daily"
      }
    },
    var.weekly_retention_days == 0 ? {} : {
      weekly = {
        schedule           = var.weekly_schedule
        delete_after       = var.weekly_retention_days
        continuous_backup  = false
        recovery_point_tag = "weekly"
      }
    },
    var.monthly_retention_days == 0 ? {} : {
      monthly = {
        schedule           = var.monthly_schedule
        delete_after       = var.monthly_retention_days
        continuous_backup  = false
        recovery_point_tag = "monthly"
      }
    },
  )

  # Deux sélections distinctes plutôt qu'une seule portant à la fois des ARN et
  # des conditions d'étiquette : AWS Backup évalue `Conditions` **en ET** avec
  # `Resources` au sein d'une même sélection — des ARN et des étiquettes réunis
  # là ne protégeraient que les ressources satisfaisant les deux. Séparées, elles
  # s'additionnent, et chacune dit ce qu'elle protège.
  select_by_arn = length(var.resource_arns) > 0
  select_by_tag = length(var.selection_tags) > 0

  # Sans rien à protéger, le coffre et le plan existent — c'est ce qui permet à un
  # environnement de les poser avant sa base — mais les alarmes, elles, ne sont
  # pas créées : « aucune sauvegarde terminée » serait vrai en permanence, et une
  # alarme qui hurle en régime nominal cesse d'être lue.
  protects_anything = local.select_by_arn || local.select_by_tag

  notify = length(var.alarm_topic_arns) > 0
}
