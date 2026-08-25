terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Sert uniquement à engendrer le jeton AUTH : voir redis.tf.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}
