resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }

  lifecycle {
    precondition {
      condition     = length(var.availability_zones) == 0 || length(var.availability_zones) >= var.availability_zone_count
      error_message = "availability_zones, lorsqu'elle est renseignée, doit contenir au moins availability_zone_count entrées."
    }

    precondition {
      condition     = var.nat_gateway_count <= var.availability_zone_count
      error_message = "nat_gateway_count ne peut pas dépasser availability_zone_count : une NAT Gateway vit dans un sous-réseau public, et il n'y en a qu'un par zone."
    }
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

# Le groupe de sécurité par défaut d'un VPC autorise tout le trafic entre ses
# membres. Il n'est référencé nulle part dans ce dépôt, mais toute ressource
# créée sans groupe explicite y atterrit : le vider est ce qui empêche un oubli
# de devenir un chemin ouvert.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-default-sg"
  }
}

# Même raisonnement pour la table de routage principale : les six sous-réseaux
# du module ont une association explicite, mais un sous-réseau ajouté plus tard
# sans association hérite de celle-ci. La laisser sans route la rend inerte
# plutôt que silencieusement routable.
resource "aws_default_route_table" "this" {
  default_route_table_id = aws_vpc.this.default_route_table_id
  route                  = []

  tags = {
    Name = "${local.name_prefix}-rtb-principale"
  }
}
