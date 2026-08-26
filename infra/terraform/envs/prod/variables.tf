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
    l'adresse ne reçoit aucune alerte — ce qui, sur la production, revient à
    n'avoir aucune alerte du tout.
  EOT
  type        = list(string)
  default     = []
}
