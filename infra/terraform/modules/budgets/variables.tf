variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom du budget et du topic — `spa-{environment}-monthly`, `spa-{environment}-budget-alerts` — et sert de valeur au filtre d'étiquette qui délimite la dépense mesurée."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) >= 2 && length(var.environment) <= 16
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser le tiret que comme séparateur : ni en tête, ni en fin, ni doublé."
  }
}

# --- Plafond ------------------------------------------------------------------

variable "monthly_limit" {
  description = <<-EOT
    Plafond mensuel de l'environnement, dans la devise `currency`. Le CDC §4.16
    vise 430 à 800 USD par mois en production ; les environnements hors production
    sont dimensionnés a minima (skill aws-infra §9).

    Ce n'est pas un plafond de dépense — AWS Budgets n'arrête rien — mais le
    dénominateur des seuils d'alerte. Le fixer trop haut retarde l'alerte jusqu'à
    ce qu'elle ne serve plus à rien ; le fixer sous la dépense nominale la rend
    permanente, donc ignorée.
  EOT
  type        = number

  validation {
    condition     = var.monthly_limit > 0
    error_message = "monthly_limit doit être strictement positif : un budget à zéro alerterait dès la première heure facturée."
  }
}

variable "currency" {
  description = "Code ISO 4217 de la devise du plafond. La facture AWS du compte est libellée en USD ; changer cette valeur fait convertir le budget par AWS, au taux du mois."
  type        = string
  default     = "USD"

  validation {
    condition     = can(regex("^[A-Z]{3}$", var.currency))
    error_message = "currency doit être un code ISO 4217 en trois lettres majuscules, par exemple `USD` ou `EUR`."
  }
}

variable "time_period_start" {
  description = "Début de la première période budgétaire, au format `AAAA-MM-JJ_hh:mm` attendu par l'API Budgets. `null` — le défaut — laisse AWS le fixer au premier jour du mois courant, ce qui est le comportement voulu dans tous les cas connus. À ne renseigner que pour rejouer un budget sur un historique précis."
  type        = string
  default     = null

  validation {
    condition     = var.time_period_start == null || can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}:[0-9]{2}$", var.time_period_start))
    error_message = "time_period_start doit être `null` ou suivre la forme `AAAA-MM-JJ_hh:mm`, par exemple `2026-09-01_00:00`."
  }
}

# --- Alertes ------------------------------------------------------------------

variable "alert_thresholds_percent" {
  description = <<-EOT
    Seuils de déclenchement des alertes, en pourcentage du plafond. Le défaut —
    80 % puis 100 % — est celui du CDC §4.16 : le premier laisse le temps de
    réagir, le second constate le dépassement.

    Les seuils portent sur la dépense **constatée** (`ACTUAL`), pas sur la
    prévision : une alerte prévisionnelle se déclenche sur une extrapolation
    qu'un pic ponctuel suffit à fausser, et le MVP n'a pas encore d'historique de
    facturation qui la rendrait fiable.
  EOT
  type        = list(number)
  default     = [80, 100]

  validation {
    condition     = length(var.alert_thresholds_percent) > 0
    error_message = "alert_thresholds_percent doit contenir au moins un seuil : un budget sans alerte ne prévient de rien."
  }

  validation {
    condition     = alltrue([for threshold in var.alert_thresholds_percent : threshold > 0 && threshold <= 1000])
    error_message = "Chaque seuil doit être strictement positif et inférieur ou égal à 1000 % du plafond."
  }

  validation {
    condition     = length(distinct(var.alert_thresholds_percent)) == length(var.alert_thresholds_percent)
    error_message = "alert_thresholds_percent ne doit pas comporter de doublon : deux notifications de même seuil et de même type sont refusées par l'API Budgets."
  }
}

variable "alert_emails" {
  description = <<-EOT
    Adresses abonnées au topic d'alerte. Vide par défaut : le topic est créé quoi
    qu'il arrive, et l'abonnement d'une adresse ne demande alors qu'une ligne.

    Un abonnement SNS par courriel n'est **actif qu'après confirmation** par son
    destinataire — Terraform le laisse en `PendingConfirmation` et n'a aucun moyen
    de le confirmer. Une adresse ajoutée ici sans que le message de confirmation
    soit suivi ne reçoit donc rien.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for address in var.alert_emails : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", address))])
    error_message = "Chaque entrée de alert_emails doit être une adresse de courriel."
  }
}

# --- Périmètre de la dépense mesurée ------------------------------------------

variable "environment_tag_key" {
  description = "Clé de l'étiquette qui délimite la dépense de l'environnement. C'est celle que `default_tags` pose sur tout ce que l'environnement crée (skill aws-infra §2) ; la changer sans changer `default_tags` donne un budget qui ne mesure rien."
  type        = string
  default     = "Environment"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=._:/-]{1,128}$", var.environment_tag_key))
    error_message = "environment_tag_key doit être une clé d'étiquette AWS valide : 128 caractères au plus, sans espace."
  }
}

variable "include_credits_and_refunds" {
  description = "Fait entrer crédits et remboursements dans la dépense mesurée. Faux par défaut : ni l'un ni l'autre ne porte d'étiquette, ils s'appliquent au compte entier. Les compter dans un budget filtré par environnement ferait descendre la dépense d'un environnement à cause d'un crédit qui ne le concerne pas — et l'alerte se tairait au mauvais moment."
  type        = bool
  default     = false
}
