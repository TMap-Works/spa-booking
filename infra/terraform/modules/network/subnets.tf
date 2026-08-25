# Trois niveaux sur `availability_zone_count` zones (CDC §4.3) :
#
#   public  ALB et NAT Gateway                     — sortie par l'Internet Gateway
#   app     tâches ECS Fargate, Lambda dans le VPC — sortie par la NAT Gateway
#   data    RDS, ElastiCache                       — aucune sortie
#
# La segmentation ne vaut que par la table de routage qui l'accompagne : voir
# routes.tf, où le niveau données n'a strictement aucune route sortante.

resource "aws_subnet" "public" {
  for_each = local.subnet_slots

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, local.tier_offsets.public + each.value)

  # Une adresse publique automatique n'est utile à personne ici : l'ALB reçoit
  # ses adresses du service, et la NAT Gateway porte une Elastic IP explicite.
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name_prefix}-public-${substr(each.key, -1, 1)}"
    Tier = "public"
  }
}

resource "aws_subnet" "app" {
  for_each = local.subnet_slots

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, local.tier_offsets.app + each.value)

  tags = {
    Name = "${local.name_prefix}-app-${substr(each.key, -1, 1)}"
    Tier = "app"
  }
}

resource "aws_subnet" "data" {
  for_each = local.subnet_slots

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, local.tier_offsets.data + each.value)

  tags = {
    Name = "${local.name_prefix}-data-${substr(each.key, -1, 1)}"
    Tier = "data"
  }
}
