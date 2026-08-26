# Environnement recette — composition de modules.
#
# Un environnement ne déclare aucune ressource en propre : il compose des modules
# et leur fournit les valeurs. L'état vit dans le bucket créé par ../../bootstrap
# (voir backend.tf), verrouillé par sa table DynamoDB.

locals {
  environment = "staging"

  # Rétention des journaux CloudWatch de l'environnement : 30 jours hors
  # production, 90 en production (skill aws-infra §8). Sans rétention explicite,
  # CloudWatch conserve indéfiniment et la facture monte sans bruit.
  #
  # Aucun module composé ici ne crée encore de groupe de journaux — `network` n'en
  # produit pas. La valeur est posée maintenant, et exposée en sortie pour être
  # vérifiable, parce que c'est le contrat que devront recevoir `database`,
  # `cache` et `ecs-service` le jour où cet environnement les composera, comme le
  # fait déjà `envs/dev`.
  log_retention_days = 30
}

# --- Maîtrise budgétaire ------------------------------------------------------

module "budgets" {
  source = "../../modules/budgets"

  environment = local.environment

  # Même plafond qu'en développement : la recette a vocation à reproduire la
  # forme de la production, pas son dimensionnement — et elle ne compose encore
  # que son réseau. Le plafond décrit donc l'environnement complet à venir, pas
  # la poignée de ressources d'aujourd'hui : c'est ce qui évite d'avoir à le
  # relever — et à réapprendre à ignorer l'alerte — à chaque module ajouté.
  monthly_limit = 250

  alert_emails = var.budget_alert_emails

  # Les étiquettes de répartition de coûts sont activées pour le compte entier,
  # par le seul environnement `prod` — voir modules/budgets/README.md.
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
  vpc_cidr = "10.20.0.0/16"

  # Une seule NAT Gateway, comme en développement : la recette valide un
  # comportement applicatif, pas une tolérance de panne d'infrastructure — ce
  # qui se vérifie, lui, en production.
  nat_gateway_count = 1
}
