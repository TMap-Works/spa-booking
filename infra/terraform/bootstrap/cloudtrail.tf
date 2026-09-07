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
  depends_on = [aws_s3_bucket_policy.audit]
}
