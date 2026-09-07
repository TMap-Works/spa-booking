# CloudTrail — l'audit complet des appels d'API du compte (CDC §4.10).
#
# C'est ici, et nulle part ailleurs, que cette trace a sa place : un trail
# multi-région couvre le **compte entier**, et non un environnement. Déclaré dans
# un module composé une fois par environnement, il en existerait trois, chacun
# facturant ses propres événements de données et écrivant les mêmes lignes dans
# trois buckets — le même raisonnement qui tient l'activation des étiquettes de
# répartition de coûts et les préférences SMS d'SNS hors des environnements.
#
# Il solde aussi une dette nommée dans le README : les accès aux buckets d'état
# n'étaient tracés par rien, faute de journaux d'accès S3 (dont le bucket de
# destination serait soumis au même contrôle). Le second sélecteur ci-dessous
# les couvre, et couvre en prime les lectures faites hors S3.

resource "aws_cloudtrail" "account" {
  count = var.cloudtrail_enabled ? 1 : 0

  name = local.cloudtrail_name

  s3_bucket_name = aws_s3_bucket.audit.id
  s3_key_prefix  = local.cloudtrail_prefix

  # Multi-région, sans discussion. Un trail limité à eu-west-3 ne verrait rien
  # d'un attaquant qui crée ses ressources à Singapour — ce qui est précisément
  # ce que fait un attaquant qui vient de trouver une clé.
  is_multi_region_trail = true

  # Les services globaux — IAM, STS, CloudFront — n'émettent leurs événements que
  # dans us-east-1. Sans cette option, aucune création de rôle IAM n'apparaîtrait
  # dans le journal.
  include_global_service_events = true

  # Empreinte signée de chaque fichier livré. C'est ce qui distingue un journal
  # d'un fichier texte : sans elle, un fichier modifié après coup est
  # indiscernable d'un fichier authentique, et le journal ne prouve plus rien.
  enable_log_file_validation = true

  kms_key_id = aws_kms_key.audit.arn

  # Livraison en parallèle vers CloudWatch Logs. Le bucket S3 est l'archive — il
  # conserve, il prouve, et il se relit avec Athena après coup ; le groupe de
  # journaux est ce sur quoi on peut poser un **filtre de métrique**, donc une
  # alarme qui se déclenche pendant l'incident et non trois semaines plus tard.
  #
  # GuardDuty consomme déjà cette même trace et couvre la détection
  # comportementale, mais il ne sait pas alarmer sur un événement précis choisi
  # par l'équipe — connexion du compte racine, modification d'une politique IAM,
  # arrêt du trail lui-même. C'est ce que cette livraison rend possible, et c'est
  # la raison pour laquelle elle vaut son coût d'ingestion (voir README).
  #
  # Le suffixe `:*` est exigé par l'API CloudTrail, qui attend l'ARN de tous les
  # flux du groupe et non celui du groupe.
  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail[0].arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_cloudwatch[0].arn

  # --- Ce qui est enregistré --------------------------------------------------
  #
  # Dès qu'un `advanced_event_selector` est présent, il remplace entièrement la
  # sélection par défaut : les événements de gestion doivent donc être demandés
  # explicitement, faute de quoi le trail n'enregistrerait *que* les données.

  advanced_event_selector {
    name = "Evenements de gestion"

    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  # Événements de données restreints aux objets des buckets d'état, et à eux
  # seuls. C'est un arbitrage de coût autant que de bruit : les événements de
  # données sont facturés à l'événement, et les activer sur tous les buckets d'un
  # compte produit un volume sans commune mesure avec ce qu'on en tire. L'état
  # Terraform, lui, contient les identifiants de connexion à la base et les ARN de
  # toute l'infrastructure — savoir qui l'a lu vaut le prix.
  advanced_event_selector {
    name = "Acces aux objets des buckets d'etat"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field       = "resources.ARN"
      starts_with = [for env in var.environments : "${aws_s3_bucket.state[env].arn}/"]
    }
  }

  tags = {
    Name = local.cloudtrail_name
  }

  # La politique du bucket doit être en place avant la création de la trace :
  # CloudTrail vérifie qu'il peut écrire, et échoue sinon sur
  # « InsufficientS3BucketPolicyException ».
  depends_on = [
    aws_s3_bucket_policy.audit,
    aws_iam_role_policy.cloudtrail_cloudwatch,
  ]
}

# --- Livraison vers CloudWatch Logs -------------------------------------------
#
# Le groupe et son rôle. Deux destinations pour une même trace, et ce n'est pas
# une redondance : elles ne servent pas la même chose. S3 archive à bas coût sur
# un an et porte la preuve d'intégrité ; CloudWatch permet de chercher tout de
# suite et d'alarmer sur ce qu'on choisit.
#
# La rétention est donc volontairement courte ici — l'archive longue est dans le
# bucket, la dupliquer sur un an dans CloudWatch coûterait plusieurs fois le prix
# sans rien ajouter.

# Chiffré par la clé gérée par CloudWatch Logs et non par la clé d'audit : la
# politique de cette dernière ne nomme pas `logs.{région}.amazonaws.com`, et
# l'y ajouter voudrait dire élargir une clé dont c'est précisément la valeur
# d'être étroite. La contrepartie est nommée : ce groupe n'est pas protégé par
# une clé du compte, alors que l'archive S3 l'est.
#tfsec:ignore:aws-cloudwatch-log-group-customer-key
resource "aws_cloudwatch_log_group" "cloudtrail" {
  count = var.cloudtrail_enabled ? 1 : 0

  name              = "/aws/cloudtrail/${local.cloudtrail_name}"
  retention_in_days = var.cloudtrail_cloudwatch_retention_days

  tags = {
    Name = local.cloudtrail_name
  }
}

data "aws_iam_policy_document" "cloudtrail_cloudwatch_assume" {
  count = var.cloudtrail_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    # Garde contre l'adjoint confus, jusque dans la relation de confiance : seule
    # la trace de ce compte-ci peut endosser ce rôle.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }
}

resource "aws_iam_role" "cloudtrail_cloudwatch" {
  count = var.cloudtrail_enabled ? 1 : 0

  name               = "spa-cloudtrail-cloudwatch"
  description        = "Role endosse par CloudTrail pour livrer ses evenements dans CloudWatch Logs"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_cloudwatch_assume[0].json

  tags = {
    Name = "spa-cloudtrail-cloudwatch"
  }
}

# Deux actions, et pas une de plus. Pas de `logs:CreateLogGroup` : le groupe est
# créé par Terraform, et un rôle capable d'en créer d'autres pourrait déverser
# ailleurs. Pas de `logs:DescribeLogStreams` non plus — CloudTrail n'en a pas
# besoin pour écrire.
data "aws_iam_policy_document" "cloudtrail_cloudwatch" {
  count = var.cloudtrail_enabled ? 1 : 0

  statement {
    sid    = "EcrireDansLeGroupeDeLaTrace"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.cloudtrail[0].arn}:log-stream:*"]
  }
}

resource "aws_iam_role_policy" "cloudtrail_cloudwatch" {
  count = var.cloudtrail_enabled ? 1 : 0

  name   = "spa-cloudtrail-cloudwatch"
  role   = aws_iam_role.cloudtrail_cloudwatch[0].id
  policy = data.aws_iam_policy_document.cloudtrail_cloudwatch[0].json
}
