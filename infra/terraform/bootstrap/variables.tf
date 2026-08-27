variable "aws_region" {
  description = "Région AWS hébergeant les états Terraform. Doit être identique à la région déclarée dans les blocs `backend` de envs/*."
  type        = string
  default     = "eu-west-3"
}

variable "environments" {
  description = "Environnements disposant d'un état isolé. Un bucket, une table de verrouillage et une clé KMS par entrée."
  type        = set(string)
  default     = ["dev", "staging", "prod"]

  validation {
    condition     = length(var.environments) > 0
    error_message = "Il faut au moins un environnement : sans état distant, aucun autre module ne peut être appliqué."
  }
}

variable "state_bucket_prefix" {
  description = "Préfixe des buckets d'état. Les noms de bucket S3 sont uniques au niveau mondial : si `<prefix>-<env>-tfstate` est déjà pris, changer cette valeur et reporter le nouveau nom dans les blocs `backend` de envs/*."
  type        = string
  default     = "spa-booking"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$", var.state_bucket_prefix))
    error_message = "Le préfixe doit respecter le nommage S3 : minuscules, chiffres et tirets, sans tiret en tête ni en fin."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Durée de conservation des versions antérieures de l'état. Assez longue pour récupérer une corruption passée inaperçue, assez courte pour que le bucket ne grossisse pas indéfiniment."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30
    error_message = "Moins de 30 jours d'historique ne laisse pas le temps de détecter une corruption d'état."
  }
}

variable "kms_deletion_window_in_days" {
  description = "Délai de grâce avant destruction effective d'une clé KMS. Une clé supprimée rend l'état illisible : le délai maximal est un filet de sécurité, pas une lenteur."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "AWS n'accepte qu'une valeur comprise entre 7 et 30 jours."
  }
}

variable "cost_allocation_tag_keys" {
  description = <<-EOT
    Étiquettes à activer comme **étiquettes de répartition de coûts**. Sans cette
    activation, Cost Explorer connaît l'étiquette mais refuse de regrouper la
    dépense dessus : le filtre des budgets d'environnement et la ventilation de la
    facture restent lettre morte.

    Les quatre clés par défaut sont celles que les `default_tags` posent partout
    (skill aws-infra §2). Activer `Environment` seule ventilerait par
    environnement mais ni par projet ni par propriétaire, et il faudrait attendre
    un mois de facturation de plus pour obtenir la ventilation manquante — AWS ne
    rétro-applique pas une étiquette.

    L'activation vaut pour le **compte entier**, ce qui est la raison d'être de
    cette variable ici plutôt que dans un module composé une fois par
    environnement. La vider désactive les étiquettes plutôt que de les laisser en
    l'état : `aws_ce_cost_allocation_tag` repasse la clé en `Inactive` à sa
    destruction.
  EOT
  type        = set(string)
  default     = ["Environment", "ManagedBy", "Owner", "Project"]

  validation {
    condition     = alltrue([for key in var.cost_allocation_tag_keys : can(regex("^[A-Za-z0-9+=._:/-]{1,128}$", key))])
    error_message = "Chaque entrée de cost_allocation_tag_keys doit être une clé d'étiquette AWS valide : 128 caractères au plus, sans espace."
  }
}
