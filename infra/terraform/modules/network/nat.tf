# NAT Gateway — 1 en dev et staging, 2 en production (CDC §4.3 et §4.16).
#
# Le nombre est un arbitrage explicite entre coût et résilience, pas un réglage
# de confort : chaque passerelle se facture à l'heure *et* au gigaoctet traité.
# Avec une seule passerelle, la perte de sa zone coupe la sortie Internet des
# deux zones applicatives ; avec deux, chaque zone garde la sienne. C'est
# acceptable en dev et staging, pas en production.

resource "aws_eip" "nat" {
  count = var.nat_gateway_count

  domain = "vpc"

  tags = {
    Name = "${local.name_prefix}-nat-${substr(local.availability_zones[count.index], -1, 1)}"
  }

  # L'Internet Gateway doit exister avant qu'une adresse ne soit associée à une
  # passerelle du VPC.
  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = var.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[local.availability_zones[count.index]].id

  tags = {
    Name = "${local.name_prefix}-nat-${substr(local.availability_zones[count.index], -1, 1)}"
  }

  depends_on = [aws_internet_gateway.this]
}
