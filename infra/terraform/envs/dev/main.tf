# Environnement développement — composition de modules.
#
# Un environnement ne déclare aucune ressource en propre : il compose des modules
# et leur fournit les valeurs. L'état vit dans le bucket créé par ../../bootstrap
# (voir backend.tf), verrouillé par sa table DynamoDB.

locals {
  environment = "dev"
}

module "network" {
  source = "../../modules/network"

  environment = local.environment

  # Zones figées plutôt que déduites de l'API. `data.aws_availability_zones`
  # filtre sur l'état « available » : une zone déclarée dégradée pendant un
  # incident — ou une zone nouvellement ouverte au compte, qui se trierait avant
  # les autres — décalerait le rang de tous les sous-réseaux et ferait planifier
  # la destruction puis la recréation des six, donc de RDS, d'ElastiCache et du
  # service ECS avec eux. Ces noms doivent rester cohérents avec `aws_region` :
  # un écart fait échouer l'`apply`, ce qui est exactement le bon échec.
  availability_zones = ["eu-west-3a", "eu-west-3b"]

  # Plage disjointe des autres environnements : un appairage ou une passerelle de
  # transit reste possible sans renumérotation.
  vpc_cidr = "10.10.0.0/16"

  # Une seule NAT Gateway : la résilience par zone ne vaut pas son coût
  # sur un environnement de développement, où une coupure de sortie se répare
  # en attendant le retour de la zone.
  nat_gateway_count = 1
}
