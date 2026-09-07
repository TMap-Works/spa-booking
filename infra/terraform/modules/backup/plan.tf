# Plan de sauvegarde — la politique de rétention unifiée du CDC §4.14.
#
# « Unifiée » veut dire une seule politique, écrite à un seul endroit, pour toutes
# les ressources d'un environnement. Les sauvegardes automatiques que RDS gère de
# son côté (module `database`, `backup_retention_period`) restent en place : elles
# sont le chemin de restauration le plus rapide et le seul qui n'ait besoin de
# rien. Ce plan-ci ajoute la couche que RDS ne sait pas donner — une rétention
# longue, auditable, dans un coffre à part et sous une autre clé.
#
# Aucune règle ne pose `cold_storage_after` : le stockage froid d'AWS Backup ne
# couvre pas les instantanés RDS. Le renseigner ferait échouer l'`apply` sur un
# message qui ne dit pas cela.

resource "aws_backup_plan" "this" {
  name = "${local.name_prefix}-backup"

  dynamic "rule" {
    for_each = local.rules

    content {
      rule_name         = "${local.name_prefix}-${rule.key}"
      target_vault_name = aws_backup_vault.this.name
      schedule          = rule.value.schedule

      start_window      = var.start_window_minutes
      completion_window = var.completion_window_minutes

      enable_continuous_backup = rule.value.continuous_backup

      lifecycle {
        delete_after = rule.value.delete_after
      }

      # Étiquette portée par le point de restauration lui-même, et non par la
      # ressource sauvegardée. C'est ce qui permet de retrouver « le dernier
      # mensuel » dans une liste où tous les points se ressemblent — la console
      # n'affiche pas la règle d'origine.
      recovery_point_tags = {
        Cadence     = rule.value.recovery_point_tag
        Environment = var.environment
      }
    }
  }

  tags = {
    Name = "${local.name_prefix}-backup"
  }

  lifecycle {
    precondition {
      condition     = length(local.rules) > 0
      error_message = "Aucune règle de sauvegarde : au moins une des quatre rétentions (continue, quotidienne, hebdomadaire, mensuelle) doit être non nulle, sinon le plan ne sauvegarde rien."
    }

    precondition {
      condition     = var.completion_window_minutes > var.start_window_minutes
      error_message = "completion_window_minutes doit dépasser start_window_minutes : la fenêtre d'achèvement court à partir de l'heure prévue, pas du démarrage effectif, et une fenêtre plus courte que le délai de démarrage annule tout travail qui n'a pas commencé à l'heure."
    }

    # Les exigences de production du CDC §4.14, tenues par le code plutôt que par
    # la relecture. Elles ne mettent aucune valeur d'environnement dans le module :
    # elles refusent seulement qu'un environnement nommé `prod` soit configuré
    # comme un bac à sable.
    precondition {
      condition     = !local.is_production || var.continuous_backup_retention_days > 0
      error_message = "continuous_backup_retention_days doit être non nul en production : la sauvegarde continue est le seul mécanisme qui tienne le RPO ≤ 1 h du CDC §4.14, un instantané quotidien plafonnant la perte tolérée à vingt-quatre heures."
    }

    precondition {
      condition     = !local.is_production || var.daily_retention_days >= 30
      error_message = "daily_retention_days doit valoir au moins 30 jours en production (CDC §4.14)."
    }

    precondition {
      condition     = !local.is_production || local.protects_anything
      error_message = "Le plan de production ne protège aucune ressource : renseigner resource_arns ou selection_tags. Un coffre vide passe tous les contrôles et ne restaure rien."
    }

    # Le verrou de coffre borne les rétentions que le coffre **accepte** : un
    # travail dont la rétention sort de [min, max] est rejeté à l'exécution, pas
    # à l'`apply`. Sans ce contrôle, une composition qui reprend le verrou de la
    # production et les rétentions de la recette produit un coffre verrouillé qui
    # refuse chaque sauvegarde — l'`apply` est vert et rien n'est protégé.
    precondition {
      condition = var.vault_lock == null || alltrue([
        for name, rule in local.rules :
        rule.delete_after >= var.vault_lock.min_retention_days && rule.delete_after <= var.vault_lock.max_retention_days
      ])
      error_message = "Une rétention du plan sort des bornes du verrou de coffre : chaque cadence doit rester entre vault_lock.min_retention_days et vault_lock.max_retention_days, faute de quoi AWS Backup rejette le travail au moment de l'exécuter."
    }
  }
}

# --- Ce que le plan protège ---------------------------------------------------

resource "aws_backup_selection" "by_arn" {
  count = local.select_by_arn ? 1 : 0

  name         = "${local.name_prefix}-by-arn"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.this.arn

  resources = var.resource_arns
}

resource "aws_backup_selection" "by_tag" {
  count = local.select_by_tag ? 1 : 0

  name         = "${local.name_prefix}-by-tag"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.this.arn

  # `condition` alimente le champ `Conditions` de l'API, qui **filtre** la
  # sélection de ressources au lieu de la définir : il est évalué en ET avec
  # `Resources`. Sans `resources`, l'ensemble de départ est vide et la sélection
  # ne protège rien — elle est pourtant créée sans erreur, ce qui est exactement
  # la panne silencieuse que ce module existe pour éviter. `["*"]` ouvre la
  # sélection à toutes les ressources, que les conditions restreignent ensuite.
  resources = ["*"]

  # Un seul bloc `condition` — le schéma n'en accepte pas davantage —, et autant
  # de `string_equals` que d'étiquettes. AWS Backup les combine par un ET : une
  # ressource doit les porter toutes pour être protégée.
  condition {
    dynamic "string_equals" {
      for_each = var.selection_tags

      content {
        key   = "aws:ResourceTag/${string_equals.key}"
        value = string_equals.value
      }
    }
  }
}
