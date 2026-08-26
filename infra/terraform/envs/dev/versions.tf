terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Fabrique le certificat auto-signé de la terminaison TLS, faute de domaine
    # à faire valider en développement (voir main.tf).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
