provider "aws" {
  region = var.aws_region

  # Étiquettes obligatoires sur tout ce que cet environnement crée : sans elles,
  # Cost Explorer ne sait pas répartir la facture et le suivi budgétaire du
  # CDC §4.16 devient inapplicable.
  default_tags {
    tags = {
      Project     = "spa-booking"
      Environment = local.environment
      ManagedBy   = "terraform"
      Owner       = "TMap-Works"
    }
  }
}

# Provider de bord.
#
# Trois ressources de cet environnement n'existent que dans `us-east-1`, et
# aucune des trois n'est un choix :
#
#   * le **certificat ACM de la distribution** — CloudFront n'en accepte pas
#     d'autre région, quelle que soit celle du reste de la plateforme ;
#   * la **Web ACL de portée `CLOUDFRONT`** — WAF n'accepte pas d'autre région
#     pour cette portée ;
#   * le **topic SNS des alarmes de bord** — une alarme CloudWatch ne notifie
#     qu'un topic de sa propre région, et les métriques d'une Web ACL de bord ne
#     vivent que là.
#
# Les mêmes `default_tags` : ces ressources sont facturées au même budget que le
# reste de l'environnement, et le filtre d'étiquette du module `budgets` ne les
# verrait pas sans elles — CloudFront et son WAF disparaîtraient du suivi de
# coût précisément parce qu'ils sont ailleurs.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "spa-booking"
      Environment = local.environment
      ManagedBy   = "terraform"
      Owner       = "TMap-Works"
    }
  }
}
