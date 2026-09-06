# Identité de domaine SES et signature DKIM.
#
# `aws_sesv2_email_identity` sur un domaine — et non sur une adresse : une
# identité d'adresse ne permet d'écrire qu'au nom de cette adresse-là, et le MVP
# envoie au nom de chaque salon. Une identité de domaine autorise n'importe quelle
# boîte du domaine, sans nouvelle vérification à chaque tenant ajouté.
#
# **Créer cette ressource ne vérifie rien.** SES enregistre l'identité en
# `PENDING` et attend de lire les trois CNAME DKIM dans le DNS public. Avec
# `route53_zone_id`, dns.tf les pose et la vérification aboutit d'elle-même en
# quelques minutes ; sans lui, l'identité reste en attente jusqu'à ce que
# quelqu'un publie la sortie `dns_records` chez le registraire. C'est le seul
# maillon de cette chaîne que Terraform ne peut pas fermer, parce que le DNS du
# domaine n'appartient pas forcément à AWS.

resource "aws_sesv2_email_identity" "this" {
  email_identity = var.domain

  # Rattache l'identité au jeu de configuration : tout envoi fait en son nom
  # publie ses événements et respecte la liste de suppression, y compris un envoi
  # lancé depuis la console ou par un futur appelant qui aurait oublié de nommer
  # le jeu de configuration. C'est ce qui rend le routage des rebonds
  # indépendant de la discipline de l'appelant.
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  # Easy DKIM : SES génère la paire de clés et la fait tourner lui-même. Le bloc
  # ne porte donc que la longueur de clé — un `domain_signing_private_key` ferait
  # basculer en BYODKIM, avec une clé privée à détenir, à faire tourner, et qui
  # transiterait par l'état Terraform.
  dkim_signing_attributes {
    next_signing_key_length = var.dkim_signing_key_length
  }

  tags = {
    Name = "${local.name_prefix}-ses-domain"
  }
}

# Domaine d'enveloppe personnalisé — le `MAIL FROM` que voit le serveur
# destinataire, et sur lequel SPF est évalué.
#
# Ressource séparée de l'identité, comme l'API le veut : elle se pose après la
# création de l'identité et se retire sans la détruire.
resource "aws_sesv2_email_identity_mail_from_attributes" "this" {
  email_identity         = aws_sesv2_email_identity.this.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = var.mail_from_behavior_on_mx_failure
}
