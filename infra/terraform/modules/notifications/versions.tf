terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Empaquetage de la Lambda d'envoi. Le fournisseur `archive` ne parle à
    # aucune API : il zippe un répertoire local au moment du plan, ce qui garde
    # `terraform apply` autonome — pas d'artefact à construire en CI, pas de
    # bucket intermédiaire à alimenter avant de pouvoir déployer.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
