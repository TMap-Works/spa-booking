terraform {
  required_version = ">= 1.6.0"

  required_providers {
    # L'alias `aws.us_east_1` n'est pas déclaré ici : `configuration_aliases`
    # sert à une **entrée** de module, et cette racine configure elle-même ses
    # deux providers (voir providers.tf).
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Fabrique le certificat auto-signé de repli de la terminaison TLS, le temps
    # qu'un nom de domaine existe (voir main.tf, « Terminaison TLS de repli »).
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
