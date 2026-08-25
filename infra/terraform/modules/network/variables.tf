variable "environment" {
  description = "Nom de l'environnement. Entre dans le nom de chaque ressource, sous la forme `spa-{environment}-{composant}`."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment doit être en minuscules, de 2 à 16 caractères, et n'utiliser que des chiffres et des tirets comme séparateurs."
  }
}

variable "vpc_cidr" {
  description = "Bloc CIDR du VPC — un /16 par environnement (CDC §4.3). Le plan d'adressage découpe ce bloc en seize /20 ; un préfixe plus étroit ne laisserait pas la place aux trois niveaux de sous-réseaux."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && can(regex("/16$", var.vpc_cidr))
    error_message = "vpc_cidr doit être un bloc CIDR valide en /16, par exemple 10.10.0.0/16."
  }
}

variable "availability_zone_count" {
  description = "Nombre de zones de disponibilité couvertes. Chacun des trois niveaux de sous-réseaux est répliqué sur ce nombre de zones."
  type        = number
  default     = 2

  validation {
    condition     = contains([2, 3], var.availability_zone_count)
    error_message = "availability_zone_count doit valoir 2 ou 3 : en dessous il n'y a plus de résilience, au-delà le plan d'adressage déborde des quatre /20 réservés par niveau."
  }
}

variable "availability_zones" {
  description = "Zones de disponibilité à utiliser, dans l'ordre. Liste vide = les premières zones disponibles de la région. Les figer protège d'un changement d'ordre côté AWS, qui recréerait les sous-réseaux."
  type        = list(string)
  default     = []
}

variable "nat_gateway_count" {
  description = "Nombre de NAT Gateway. 1 en dev et staging, 2 en production — une par zone, pour qu'une panne de zone ne coupe pas la sortie de l'autre. C'est l'un des postes les plus chers du CDC §4.16 : ne pas l'augmenter par confort."
  type        = number
  default     = 1

  validation {
    condition     = var.nat_gateway_count >= 1 && var.nat_gateway_count <= 3
    error_message = "nat_gateway_count doit être compris entre 1 et 3, et ne jamais dépasser availability_zone_count."
  }
}
