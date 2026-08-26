# Environnement production — composition de modules.
#
# Un environnement ne déclare aucune ressource en propre : il compose des modules
# et leur fournit les valeurs. L'état vit dans le bucket créé par ../../bootstrap
# (voir backend.tf), verrouillé par sa table DynamoDB.

locals {
  environment = "prod"

  # Rétention des journaux CloudWatch de l'environnement : 90 jours en production
  # (skill aws-infra §8). Trois mois, parce qu'un incident se rejoue rarement le
  # jour où on le comprend — et pas davantage, parce que CloudWatch facture le
  # stockage indéfiniment quand personne ne fixe de terme.
  #
  # Aucun module composé ici ne crée encore de groupe de journaux — `network` n'en
  # produit pas. La valeur est posée maintenant, et exposée en sortie pour être
  # vérifiable, parce que c'est le contrat que devront recevoir `database`,
  # `cache` et `ecs-service` le jour où cet environnement les composera, comme le
  # fait déjà `envs/dev`.
  log_retention_days = 90
}

# --- Maîtrise budgétaire ------------------------------------------------------

module "budgets" {
  source = "../../modules/budgets"

  environment = local.environment

  # Haut de la fourchette du CDC §4.16 — 430 à 800 USD par mois pour la
  # production. Le plafond se pose au sommet de la fourchette et non à son
  # milieu : à 430, l'alerte à 80 % se déclencherait dans le fonctionnement
  # nominal prévu, et une alerte qui se déclenche en régime normal cesse d'être
  # lue. À 800, le seuil de 80 % tombe à 640 — au-dessus de la fourchette, donc
  # sur une vraie dérive.
  monthly_limit = 800

  alert_emails = var.budget_alert_emails

  # Activation des étiquettes de répartition de coûts, sans laquelle Cost
  # Explorer connaît les étiquettes mais refuse de regrouper la dépense dessus —
  # et sans laquelle le filtre des trois budgets ne mesure rien.
  #
  # Portée par cet environnement **et lui seul** : l'activation vaut pour le
  # compte entier, pas pour un environnement. Déclarée dans les trois, le dernier
  # `apply` gagnerait en écrasant les deux autres, exactement ce que le module
  # `ecr` refuse de faire du scan « enhanced ». La production est le propriétaire
  # désigné parce que c'est l'environnement qu'on ne détruit pas.
  #
  # Les quatre clés sont celles des `default_tags` de providers.tf : activer
  # `Environment` seule ventilerait par environnement mais pas par projet ni par
  # propriétaire, et il faudrait attendre un mois de facturation de plus pour
  # obtenir la ventilation manquante — AWS ne rétro-applique pas une étiquette.
  #
  # Sur un compte neuf, le premier `apply` peut s'arrêter ici : une clé n'est
  # activable qu'une fois découverte par la facturation, ce qui prend jusqu'à
  # 24 heures après qu'une ressource l'a portée. Le reste de l'environnement est
  # alors déjà créé — relancer l'`apply` le lendemain suffit.
  cost_allocation_tag_keys = ["Environment", "ManagedBy", "Owner", "Project"]
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
  vpc_cidr = "10.30.0.0/16"

  # Deux NAT Gateway, une par zone : avec une seule, la perte de sa zone
  # couperait la sortie Internet des deux zones applicatives — donc Stripe, SES
  # et SNS. C'est le poste de coût qu'on accepte de doubler, et le seul.
  nat_gateway_count = 2
}
