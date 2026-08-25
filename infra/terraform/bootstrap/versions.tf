terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Pas de bloc `backend` ici, et c'est délibéré : ce module crée les buckets d'état.
# Il ne peut pas s'y stocker au premier `apply` — l'amorçage se fait donc en état
# local, puis l'état est migré. Procédure complète dans README.md.
