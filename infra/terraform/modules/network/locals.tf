data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  # Écarte les zones qui demandent une adhésion explicite (Local Zones,
  # Wavelength) : elles n'hébergent ni RDS Multi-AZ ni les endpoints d'interface
  # dont ce module a besoin.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  name_prefix = "spa-${var.environment}"

  # `sort` est explicite plutôt que confiant : l'ordre de la liste détermine
  # quelle zone reçoit quel bloc CIDR, et une réponse d'API réordonnée
  # renumérotera tous les sous-réseaux. Passer `availability_zones` fige ce
  # choix pour de bon.
  availability_zones = slice(
    length(var.availability_zones) > 0 ? var.availability_zones : sort(data.aws_availability_zones.available.names),
    0,
    var.availability_zone_count,
  )

  # Un emplacement par zone : la zone est la clé (stable dans l'état même si AWS
  # réordonne sa réponse), le rang sert au calcul du bloc CIDR.
  subnet_slots = { for rank, az in local.availability_zones : az => rank }

  # Le /16 est coupé en seize /20 (4 091 adresses utilisables chacun) et chaque
  # niveau se voit réserver quatre blocs consécutifs. Ajouter une troisième zone
  # consomme donc un bloc déjà réservé, sans renuméroter l'existant — un
  # renumérotage forcerait la recréation de tous les sous-réseaux, donc de tout
  # ce qui y est attaché.
  tier_offsets = {
    public = 0
    app    = 4
    data   = 8
  }

  # Services joints par un endpoint d'interface (CDC §4.3). `ecr.api` sert les
  # appels d'API ECR, `ecr.dkr` le tirage d'image : les deux sont nécessaires,
  # et les couches d'image transitent en plus par l'endpoint S3 de passerelle.
  # Sans eux, chaque démarrage de tâche Fargate sort par la NAT Gateway et se
  # paie au gigaoctet.
  interface_endpoints = ["ecr.api", "ecr.dkr", "secretsmanager", "logs"]
}
