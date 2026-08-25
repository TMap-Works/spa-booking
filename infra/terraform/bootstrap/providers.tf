provider "aws" {
  region = var.aws_region

  # `Environment` est absent de ces étiquettes par défaut, contrairement à la règle
  # générale : ce module est le seul à couvrir les trois environnements d'un seul
  # état, la valeur ne peut donc pas être constante. Chaque ressource porte son
  # propre `Environment` — Cost Explorer répartit la facture de la même façon.
  default_tags {
    tags = {
      Project   = "spa-booking"
      ManagedBy = "terraform"
      Owner     = "TMap-Works"
    }
  }
}
