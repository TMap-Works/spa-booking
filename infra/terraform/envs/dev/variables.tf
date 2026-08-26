variable "aws_region" {
  description = "Région AWS de l'environnement. Doit rester alignée sur la région du bloc `backend` de backend.tf, qui n'accepte ni variable ni interpolation."
  type        = string
  default     = "eu-west-3"
}

variable "budget_alert_emails" {
  description = <<-EOT
    Adresses prévenues quand le budget mensuel de l'environnement dépasse 80 %
    puis 100 % de son plafond. Vide par défaut, et non versionnée : une liste de
    destinataires est une donnée d'exploitation, pas une décision d'architecture,
    et elle change sans que l'infrastructure change.

    Le topic SNS est créé quoi qu'il arrive — s'abonner après coup ne demande
    qu'un `-var` à l'`apply`, ou un abonnement posé à la main sur le topic dont
    l'ARN est donné par la sortie `budget_alerts_topic_arn`.

    **Un abonnement par courriel doit être confirmé par son destinataire** :
    Terraform le crée, il ne peut pas le confirmer. Tant qu'il ne l'est pas,
    l'adresse ne reçoit aucune alerte.
  EOT
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = <<-EOT
    Certificat ACM porté par le listener 443 de l'ALB. `null` — le défaut — fait
    fabriquer à l'environnement un certificat auto-signé et l'importe dans ACM,
    ce qui permet à `terraform apply` d'aboutir sans nom de domaine ni zone
    Route 53. Renseigner ici l'ARN d'un vrai certificat dès qu'un domaine existe :
    un certificat auto-signé oblige tout client à désactiver la vérification TLS,
    ce qui est acceptable en développement et nulle part ailleurs.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.certificate_arn == null || can(regex("^arn:aws[a-z-]*:acm:", var.certificate_arn))
    error_message = "certificate_arn doit être `null` ou un ARN de certificat ACM (`arn:aws:acm:…`)."
  }
}

variable "image_tag" {
  description = <<-EOT
    Étiquette des images tirées par le service ECS et par la tâche de migration :
    le **sha du commit déployé**. Les dépôts du module `ecr` sont immuables — une
    étiquette mobile ne pourrait être poussée qu'une fois — et la définition de
    tâche appartient à l'état : déployer, c'est donc appliquer avec le nouveau
    sha, ce que fait `deploy-dev.yml` (`-var="image_tag=<sha>"`).

    Le défaut n'est **pas** une image déployable : il ne sert qu'au tout premier
    `apply` d'un environnement vide, avant qu'aucune image n'existe. Un `apply`
    lancé à la main sans `-var image_tag` ramènerait le service à cette
    étiquette inexistante — les nouvelles tâches échoueraient au tirage et le
    disjoncteur de déploiement reviendrait à la révision précédente. Reprendre la
    valeur de la sortie `api_image` avant d'appliquer à la main.
  EOT
  type        = string
  default     = "bootstrap"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", var.image_tag))
    error_message = "image_tag doit être une étiquette d'image valide : lettres, chiffres, point, tiret ou tiret bas, 128 caractères au plus."
  }
}
