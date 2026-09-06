# Jeu de configuration — le point où se règlent, pour tous les envois du domaine,
# la remise, la réputation et la publication des événements.
#
# Un seul jeu par environnement, et non un par type de message : les trois
# messages du MVP (confirmation, rappel J-1, avis d'annulation) sont tous
# transactionnels, partent du même domaine et méritent le même traitement. Les
# distinguer se fait par l'étiquette de message posée à l'envoi, pas par une
# multiplication des jeux de configuration.

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = local.configuration_set_name

  delivery_options {
    tls_policy = var.tls_policy
  }

  # Sans métriques de réputation, les taux de rebond et de plainte du compte ne
  # sont visibles nulle part — or ce sont eux qu'AWS surveille pour décider de
  # suspendre l'envoi. Les activer coûte zéro et donne le tableau de bord SES.
  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # Liste de suppression du compte : une adresse en rebond permanent ou ayant
  # porté plainte n'est plus jamais sollicitée, même si l'application redemandait
  # un envoi (skill notifications §4). C'est le filet sous le traitement
  # applicatif des rebonds, pas son remplacement — celui-ci fait l'objet de #73.
  suppression_options {
    suppressed_reasons = var.suppressed_reasons
  }

  tags = {
    Name = local.configuration_set_name
  }
}

# Destination d'événements — le routage des rebonds et des plaintes vers SNS,
# c'est-à-dire le critère d'acceptation du CDC §6 sur la délivrabilité.
#
# `depends_on` sur la politique du topic, et non sur le topic seul : SES vérifie
# à la création de la destination qu'il a bien le droit de publier. Sans cette
# arête, Terraform peut créer la destination avant la politique et l'`apply`
# échoue sur un « could not publish to topic » qui disparaît au second passage —
# le pire des échecs, celui qui se répare tout seul et qu'on ne comprend jamais.
resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "${local.name_prefix}-delivery-events"

  event_destination {
    enabled              = true
    matching_event_types = var.event_types

    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.events]
}
