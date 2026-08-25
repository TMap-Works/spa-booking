locals {
  name_prefix = "spa-${var.environment}"

  identifier = "${local.name_prefix}-redis"

  # La production n'est pas un réglage du module — tout ce qui varie reste une
  # variable. Ce booléen ne sert qu'aux préconditions de redis.tf, qui refusent
  # un environnement nommé `prod` mais configuré comme un bac à sable.
  #
  # `startswith` et non `==` : le test doit échouer *fermé*. Une égalité stricte
  # laisserait `production`, `prod-eu` ou `prod2` désarmer les trois préconditions
  # — réplica, Multi-AZ, jeton AUTH — sans que rien dans le plan ne le signale.
  is_production = startswith(var.environment, "prod")

  # `redis7` pour un moteur `7.1` comme pour `7.0` : la famille d'un groupe de
  # paramètres suit la version majeure. Suffixe `.cluster.on` volontairement
  # absent — ce module déploie un groupe de réplication à un seul fragment.
  parameter_group_family = "redis${split(".", var.engine_version)[0]}"

  redis_port = 6379

  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : aws_kms_key.this[0].arn

  # Un nœud primaire, plus les réplicas demandés.
  cache_cluster_count = 1 + var.replica_count

  # La bascule automatique exige au moins un réplica ; Multi-AZ exige la bascule
  # automatique. Déduire l'un de l'autre évite la combinaison que l'API refuse.
  automatic_failover_enabled = var.replica_count >= 1

  # `slow-log` porte les commandes lentes, `engine-log` les événements du moteur
  # — bascule de nœud, redémarrage, échec d'authentification.
  cloudwatch_log_types = ["slow-log", "engine-log"]
}
