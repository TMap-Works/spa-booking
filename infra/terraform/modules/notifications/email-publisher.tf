# Le droit d'émettre un e-mail — symétrique de celui du canal SMS (`sms.tf`).
#
# #799 a branché les passerelles SES et SNS côté application : l'API appelle
# `SendEmail` depuis la route d'envoi que la Lambda lui adresse. Elle en avait
# l'adresse d'expéditeur à poser et **pas le droit d'appeler** : le rôle de tâche
# ne portait que `spa-{env}-notifications-producer` — publier sur la file — et
# `spa-{env}-notifications-sms-publisher` — émettre un SMS. Un `SendEmail` aurait
# été refusé en `AccessDenied`, c'est-à-dire une ligne `FAILED` par confirmation
# et par rappel, sans qu'aucun réglage ne paraisse manquer (#918).
#
# Ce fichier ne pose que le droit. Ce que l'API en fait — quand elle envoie, à
# qui, avec quel modèle — est écrit dans `apps/api/src/modules/notifications`.

# --- Ce que la politique borne, et comment ------------------------------------

data "aws_iam_policy_document" "email_publisher" {
  statement {
    sid    = "SendEmailFromDomainIdentity"
    effect = "Allow"

    # `ses:SendEmail`, au singulier et sans préfixe `sesv2:`. Le second n'existe
    # pas : SES v2 partage le préfixe IAM `ses` avec l'API d'origine, et c'est
    # la même action qui autorise `SendEmailCommand` du SDK v3. Une politique
    # écrite sur `sesv2:SendEmail` serait acceptée par IAM — il ne valide pas le
    # nom d'une action — et n'autoriserait rien.
    #
    # Ni `ses:SendRawEmail`, ni `ses:SendTemplatedEmail`, ni `ses:SendBulkEmail` :
    # `ses-email.gateway.ts` n'émet qu'un `Content.Simple`, et les modèles sont
    # rendus côté API. Ce qui n'est pas appelé n'est pas accordé.
    actions = ["ses:SendEmail"]

    # Les **deux** ressources, et c'est ce que le critère 2 de #918 exige à la
    # place d'un `Resource = "*"` :
    #
    # | Ressource | Ce qu'elle borne |
    # |---|---|
    # | l'identité de domaine | on n'écrit qu'au nom de ce domaine-là |
    # | le jeu de configuration | on n'écrit que sous le jeu qui route les rebonds |
    #
    # Les deux et non l'une : `ses:SendEmail` porte sur plusieurs types de
    # ressource, et IAM autorise alors chaque type séparément — il faut que la
    # politique couvre l'identité **et** le jeu de configuration pour que l'appel
    # passe. Or `identity.tf` rattache le jeu à l'identité pour que le routage
    # des événements soit « indépendant de la discipline de l'appelant » : SES
    # l'applique même quand la passerelle ne le nomme pas, si bien qu'un
    # `Resource` réduit à l'identité seule refuserait chaque envoi.
    resources = [
      aws_sesv2_email_identity.this.arn,
      aws_sesv2_configuration_set.this.arn,
    ]
  }
}

# --- Ce qu'elle ne borne pas, délibérément ------------------------------------

# Pas de condition `ses:FromAddress` sur `from_email`, alors que ce module
# connaît l'adresse exacte et pourrait l'y épingler. La raison est écrite dans
# `identity.tf` : l'identité est **de domaine** et non d'adresse, parce que « le
# MVP envoie au nom de chaque salon » et qu'une identité de domaine « autorise
# n'importe quelle boîte du domaine, sans nouvelle vérification à chaque tenant
# ajouté ». Épingler une adresse ici retirerait exactement la liberté pour
# laquelle l'identité a été choisie, et la retirerait en IAM — là où la panne se
# lit `AccessDenied` et non « expéditeur non vérifié ».
#
# Le domaine, lui, est bien borné : c'est l'ARN de l'identité qui le fait, et
# aucune autre identité du compte n'est joignable par cette politique.
#
# Ce qu'elle ne donne pas non plus, et qui est le pendant du refus de
# `sns:SetSMSAttributes` côté SMS : ni `ses:PutAccountSendingAttributes` — une
# application qui pourrait réactiver son propre envoi suspendu —, ni
# `ses:PutSuppressedDestination` / `ses:DeleteSuppressedDestination` — la liste
# de suppression du compte est ce qui protège la réputation du domaine même d'un
# bug applicatif (skill notifications §4), et un code qui peut en retirer une
# adresse morte peut la re-solliciter indéfiniment.
resource "aws_iam_policy" "email_publisher" {
  name        = "${local.name_prefix}-notifications-email-publisher"
  description = "Émettre un e-mail au nom de l'identité de domaine SES de cet environnement, sous son jeu de configuration, et rien d'autre : ni les réglages d'envoi du compte, ni la liste de suppression."
  policy      = data.aws_iam_policy_document.email_publisher.json

  tags = {
    Name = "${local.name_prefix}-notifications-email-publisher"
  }
}
