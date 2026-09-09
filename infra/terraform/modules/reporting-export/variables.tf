variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom du bucket et dans celui de la politique — `spa-{environment}-reporting-exports`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) >= 2 && length(var.environment) <= 16
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser le tiret que comme séparateur : ni en tête, ni en fin, ni doublé."
  }
}

variable "retention_days" {
  description = <<-EOT
    Nombre de jours au bout duquel un export est **définitivement supprimé** par
    le cycle de vie du bucket — troisième moitié du premier critère de #563.

    Court par construction, et c'est le point : un export est une photographie
    d'indicateurs, pas une archive. Il est reproductible d'un appel à l'autre, il
    ne fait autorité sur rien, et il porte le chiffre d'affaires d'un salon. Le
    garder au-delà de quelques jours reviendrait à constituer, dans un bucket, un
    entrepôt de données d'exploitation dont personne ne surveillerait la
    croissance — exactement le genre de dépôt qui se retrouve dans une fuite sans
    que quiconque se souvienne l'avoir créé.

    Sept jours par défaut : de quoi rouvrir un fichier la semaine suivante, sans
    qu'un export de trimestre traîne.

    Le plancher de 1 jour est celui de S3 lui-même ; le plafond de 90 est le
    nôtre, et il est délibéré — au-delà, la question à se poser n'est plus « quel
    cycle de vie ? » mais « pourquoi un export vit-il si longtemps ? ».
  EOT
  type        = number
  default     = 7

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 90 && floor(var.retention_days) == var.retention_days
    error_message = "retention_days doit être un entier compris entre 1 et 90 jours — un export est une photographie, pas une archive."
  }
}

variable "kms_key_arn" {
  description = <<-EOT
    Clé KMS gérée par le client dont le bucket se sert pour chiffrer les objets
    au repos.

    `null` — le défaut — laisse le chiffrement **géré par S3** (`AES256`,
    SSE-S3), qui est actif et non désactivable : le bucket est chiffré dans les
    deux cas, et le premier critère de #563 est tenu par l'un comme par l'autre.

    Ce que la clé client ajoute, et qui n'est pas rien : une politique de clé
    distincte de la politique de bucket, une rotation qu'on décide, et une
    révocation qui rend les objets illisibles sans avoir à les supprimer. Ce
    qu'elle coûte : un tarif mensuel par clé, un appel KMS par objet, et
    l'obligation d'accorder `kms:Decrypt` **au signataire** — une URL présignée
    est vérifiée avec les droits de qui l'a signée, si bien qu'un rôle de tâche
    sans `kms:Decrypt` produirait des URL qui rendent 403 à qui les suit, sans
    que rien ne l'ait signalé au moment de la signature.

    D'où le défaut : SSE-S3 en dev, une clé du compte en production si
    l'exploitant en décide ainsi. Le module attache alors de lui-même les droits
    KMS à la politique du producteur.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn doit être `null` ou un ARN de clé KMS (`arn:aws:kms:…`)."
  }
}
