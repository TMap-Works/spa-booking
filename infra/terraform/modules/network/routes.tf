# Les routes sont déclarées en ressources `aws_route` autonomes plutôt qu'en
# blocs `route` imbriqués dans `aws_route_table`. Ce n'est pas un goût de style :
# un bloc imbriqué fait de Terraform le propriétaire de la liste *complète* des
# routes de la table, et il supprimerait alors à chaque `apply` la route de liste
# de préfixes que l'endpoint S3 de passerelle y installe (voir endpoints.tf).

# --- Niveau public : sortie et entrée par l'Internet Gateway ------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-rtb-public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# --- Niveau applicatif : sortie par la NAT Gateway, une table par zone --------
#
# Une table par zone parce que la passerelle à emprunter dépend de la zone. Avec
# une seule passerelle, le modulo ramène toutes les zones sur elle ; avec une
# passerelle par zone, chacune garde la sienne et une panne de zone n'emporte
# pas la sortie de l'autre.

resource "aws_route_table" "app" {
  for_each = local.subnet_slots

  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-rtb-app-${substr(each.key, -1, 1)}"
  }
}

resource "aws_route" "app_internet" {
  for_each = local.subnet_slots

  route_table_id         = aws_route_table.app[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[each.value % var.nat_gateway_count].id
}

resource "aws_route_table_association" "app" {
  for_each = aws_subnet.app

  subnet_id      = each.value.id
  route_table_id = aws_route_table.app[each.key].id
}

# --- Niveau données : aucune route vers Internet ------------------------------
#
# Critère d'acceptation de #11, et la raison d'être de la segmentation : cette
# table ne porte volontairement AUCUNE ressource `aws_route`. Ni `0.0.0.0/0`,
# ni Internet Gateway, ni NAT Gateway, ni appairage, ni passerelle de transit.
#
# Ce qui la traverse se limite donc à :
#   - la route locale du VPC, implicite et non supprimable ;
#   - la liste de préfixes de l'endpoint S3 de passerelle, dont le trafic ne
#     quitte jamais le réseau AWS et ne passe par aucune passerelle Internet.
#
# Une base de données qui aurait besoin d'un accès sortant n'a rien à faire ici :
# elle relève du niveau applicatif. Ajouter une route à cette table, c'est
# annuler l'isolation que tout le reste de la sécurité suppose acquise.

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-rtb-data"
  }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}
