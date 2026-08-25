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
