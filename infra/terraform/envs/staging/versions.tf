terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Fabrique le certificat auto-signé de repli de la terminaison TLS, le temps
    # qu'un vrai certificat ACM soit posé sur cet environnement (voir main.tf,
    # « Terminaison TLS »).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
