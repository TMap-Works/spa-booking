# File de découplage des notifications, et sa file d'attente morte.
#
# Le CDC §4.8 et la skill notifications §1 posent la même contrainte : « l'API ne
# parle jamais directement à SES ou SNS ». Une réservation ne doit pas échouer
# parce qu'un e-mail n'est pas parti — or un `SendEmail` synchrone dans le chemin
# de requête HTTP fait exactement cela, et le fait au pire moment, celui où SES
# est en throttling parce que le trafic est fort.
#
# Cette file est la frontière. En amont, l'API publie et rend la main. En aval,
# la Lambda de `dispatcher-lambda.tf` consomme à son rythme, et c'est SQS — pas
# notre code — qui compte les tentatives.

# --- File d'attente morte -----------------------------------------------------

# Déclarée avant la file principale : c'est elle qui est référencée par la
# politique de redrive, pas l'inverse.
#
# Rétention au maximum, 14 jours, et non les 4 jours de la file principale. Un
# message n'arrive ici qu'après avoir échoué `dispatch_max_receive_count` fois :
# il y a une panne, elle demande un diagnostic humain, et ce diagnostic peut
# tomber un lundi matin sur un incident du samedi. Une rétention courte
# effacerait la preuve avant qu'on l'ait lue.
resource "aws_sqs_queue" "dispatch_dlq" {
  name                       = "${local.name_prefix}-notifications-dlq"
  message_retention_seconds  = var.dlq_message_retention_seconds
  visibility_timeout_seconds = local.dispatch_visibility_timeout_seconds

  # Même clé que le topic d'événements. L'enveloppe ne porte que des
  # identifiants — jamais d'adresse ni de nom, c'est la règle du contrat côté API
  # — mais elle désigne une cliente et un rendez-vous, ce qui reste une donnée
  # personnelle indirecte au sens du CDC §5.1. Réemployer la clé plutôt qu'en
  # créer une seconde évite un deuxième USD par mois et par environnement pour
  # la même frontière de confiance.
  kms_master_key_id                 = local.kms_key_arn
  kms_data_key_reuse_period_seconds = var.kms_data_key_reuse_period_seconds

  tags = {
    Name = "${local.name_prefix}-notifications-dlq"
  }
}

# Qui a le droit de déverser ici. Sans cette autorisation, n'importe quelle file
# du compte pourrait désigner cette DLQ comme la sienne et y mêler ses échecs —
# et l'alarme de profondeur, qui ne sait pas d'où vient un message, se
# déclencherait pour une panne qui n'est pas celle des notifications.
resource "aws_sqs_queue_redrive_allow_policy" "dispatch_dlq" {
  queue_url = aws_sqs_queue.dispatch_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.dispatch.arn]
  })
}

# --- File principale ----------------------------------------------------------

resource "aws_sqs_queue" "dispatch" {
  name = "${local.name_prefix}-notifications"

  # Le délai pendant lequel un message pris par la Lambda reste invisible des
  # autres consommateurs. AWS recommande six fois le délai de la fonction : si
  # elle est tuée sur un délai dépassé, la reprise ne doit pas commencer avant
  # que l'invocation précédente ne soit réellement terminée, sinon deux
  # exécutions traitent le même message en même temps. L'idempotence de #68 le
  # rattraperait, mais au prix d'un appel fournisseur inutile.
  visibility_timeout_seconds = local.dispatch_visibility_timeout_seconds

  message_retention_seconds = var.dispatch_message_retention_seconds

  # Interrogation longue : le consommateur attend jusqu'à 20 secondes qu'un
  # message arrive au lieu de rendre une réponse vide immédiatement. C'est le
  # réglage qui divise par vingt le nombre de requêtes facturées sur une file peu
  # active — et une file de notifications l'est, hors pics de réservation.
  receive_wait_time_seconds = 20

  kms_master_key_id                 = local.kms_key_arn
  kms_data_key_reuse_period_seconds = var.kms_data_key_reuse_period_seconds

  # Le cœur du critère « reprises laissées à SQS » : après
  # `dispatch_max_receive_count` réceptions infructueuses, le message part en
  # DLQ. La Lambda ne compte rien, ne boucle pas et n'espace pas ses essais —
  # c'est ce compteur-ci qui fait autorité, et c'est lui qui rend la profondeur
  # de la DLQ interprétable.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dispatch_dlq.arn
    maxReceiveCount     = var.dispatch_max_receive_count
  })

  tags = {
    Name = "${local.name_prefix}-notifications"
  }
}

# --- Transport chiffré exigé --------------------------------------------------

# Politique de refus pur : elle n'accorde rien — les droits viennent des
# politiques d'identité — elle interdit seulement d'appeler ces files hors TLS.
# Un `Deny` explicite l'emporte sur tout `Allow`, y compris celui d'un
# administrateur, ce qui est bien l'effet recherché.
#
# Le caractère générique sur l'action est ici la forme **correcte** : une garde de
# transport doit couvrir toute action présente et à venir. Le restreindre à une
# liste d'actions laisserait passer en clair celles qu'on aurait oublié d'y
# écrire — c'est l'inverse exact du risque que la règle cherche à couvrir.
data "aws_iam_policy_document" "dispatch_tls" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["sqs:*"]

    resources = [
      aws_sqs_queue.dispatch.arn,
      aws_sqs_queue.dispatch_dlq.arn,
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "dispatch" {
  queue_url = aws_sqs_queue.dispatch.id
  policy    = data.aws_iam_policy_document.dispatch_tls.json
}

resource "aws_sqs_queue_policy" "dispatch_dlq" {
  queue_url = aws_sqs_queue.dispatch_dlq.id
  policy    = data.aws_iam_policy_document.dispatch_tls.json
}

# --- Droit de publier ---------------------------------------------------------

# Une politique gérée plutôt qu'une politique en ligne sur un rôle que ce module
# ne possède pas. Le module `ecs-service` attend précisément cela : son
# `task_role_policy_arns` attache des politiques que l'environnement lui donne,
# et « ce qui n'est pas demandé n'est pas accordé ».
#
# Le même ARN servira au rôle qu'EventBridge Scheduler endossera pour le rappel
# J-1 (#71) : les deux producteurs ont besoin exactement de ces droits-là, et
# d'aucun autre. Pas de `sqs:ReceiveMessage` ici — un producteur qui pourrait
# dépiler pourrait faire disparaître un rappel.
data "aws_iam_policy_document" "dispatch_producer" {
  statement {
    sid    = "PublishNotification"
    effect = "Allow"

    actions = [
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:SendMessage",
    ]

    resources = [aws_sqs_queue.dispatch.arn]
  }

  # La file est chiffrée par une clé gérée par le compte : sans ces deux actions,
  # `SendMessage` échoue sur un `KMS.AccessDeniedException` que rien dans le
  # message d'erreur ne rattache à la clé.
  statement {
    sid    = "EncryptNotification"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]

    resources = [local.kms_key_arn]
  }
}

resource "aws_iam_policy" "dispatch_producer" {
  name        = "${local.name_prefix}-notifications-producer"
  description = "Publier sur la file de notifications ${var.environment} — jamais la consommer."
  policy      = data.aws_iam_policy_document.dispatch_producer.json

  tags = {
    Name = "${local.name_prefix}-notifications-producer"
  }
}
