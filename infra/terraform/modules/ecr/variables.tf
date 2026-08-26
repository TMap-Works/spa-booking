variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de chaque dépôt, sous la forme `spa-{environment}-{application}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) >= 2 && length(var.environment) <= 16
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser le tiret que comme séparateur : ni en tête, ni en fin, ni doublé. ECR n'accepte pas un nom de dépôt comportant deux tirets consécutifs."
  }
}

variable "applications" {
  description = <<-EOT
    Applications dont les images sont hébergées, par nom court. Chaque entrée
    donne un dépôt `spa-{environment}-{nom}` — ce sont les noms qu'emploient déjà
    les workflows de déploiement (`spa-dev-api`, `spa-dev-web`).

    Un dépôt par application et non un dépôt commun étiqueté : c'est ce qui permet
    au rôle d'exécution ECS de chaque service de ne recevoir le droit de tirage que
    sur son propre dépôt (module ecs-service, `ecr_repository_arn`), et à une
    politique de cycle de vie de compter les images d'une application sans que le
    rythme de publication de l'autre ne la fasse dériver.
  EOT
  type        = set(string)
  default     = ["api", "web"]

  validation {
    condition     = length(var.applications) > 0
    error_message = "applications doit contenir au moins une application ; un registre sans dépôt ne sert à rien."
  }

  validation {
    condition     = alltrue([for name in var.applications : can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", name)) && length(name) <= 16])
    error_message = "Chaque nom d'application doit être en minuscules, de 16 caractères au plus, et n'utiliser le tiret que comme séparateur — il devient un segment du nom de dépôt ECR."
  }
}

# --- Rétention et coût --------------------------------------------------------

variable "max_tagged_images" {
  description = <<-EOT
    Nombre d'images conservées par dépôt, les plus récentes d'abord — étiquetées
    ou non, voir la règle 2 de `lifecycle.tf`. Au-delà, la politique de cycle de
    vie détruit les plus anciennes.

    Une image d'API pèse quelques centaines de mégaoctets et un déploiement en
    publie une par commit : sans plafond, le stockage ECR grossit indéfiniment et
    la facture avec lui (skill aws-infra §9). Le défaut laisse de quoi revenir
    plusieurs déploiements en arrière, ce qui est le seul usage réel des anciennes
    images.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.max_tagged_images >= 5 && var.max_tagged_images <= 1000
    error_message = "max_tagged_images doit être compris entre 5 et 1000 images. En deçà de 5, un retour arrière de quelques déploiements devient impossible."
  }
}

variable "untagged_image_retention_days" {
  description = "Durée de conservation d'une image sans étiquette, en jours. Une image perd son étiquette quand une nouvelle la reprend, ou quand une construction échoue à mi-course : elle n'est plus référencée par rien mais reste facturée. Quelques jours suffisent à diagnostiquer une publication ratée."
  type        = number
  default     = 7

  validation {
    condition     = var.untagged_image_retention_days >= 1 && var.untagged_image_retention_days <= 90
    error_message = "untagged_image_retention_days doit être compris entre 1 et 90 jours."
  }
}

# --- Chiffrement --------------------------------------------------------------

variable "kms_key_arn" {
  description = "Clé KMS gérée par le client, pour le chiffrement des couches d'image au repos. `null` fait créer une clé dédiée par le module. Une clé gérée par le client — et non le chiffrement AES256 par défaut d'ECR — parce qu'elle seule peut recevoir une politique, être auditée par appelant dans CloudTrail, et être révoquée sans supprimer le registre."
  type        = string
  default     = null
}

variable "kms_deletion_window_in_days" {
  description = "Délai avant destruction effective de la clé créée par le module. Sans ce délai, une suppression accidentelle rend toutes les images publiées définitivement illisibles — y compris celles que les tâches ECS en service tirent au prochain redémarrage."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days doit être compris entre 7 et 30 jours."
  }
}

# --- Cycle de vie du dépôt ----------------------------------------------------

variable "force_delete" {
  description = "Autorise `terraform destroy` à supprimer un dépôt qui contient encore des images. Faux par défaut, y compris en dev : un dépôt non vide qui refuse de disparaître est un garde-fou, pas une gêne. Ne le passer à vrai que sur un environnement éphémère que l'on sait jetable."
  type        = bool
  default     = false
}
