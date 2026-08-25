locals {
  name_prefix = "spa-${var.environment}"

  identifier = "${local.name_prefix}-rds"

  # La production n'est pas un réglage du module — toutes les valeurs qui varient
  # restent des variables. Ce booléen ne sert qu'aux préconditions de rds.tf, qui
  # refusent un environnement nommé `prod` mais configuré comme un bac à sable.
  #
  # `startswith` et non `==` : le test doit échouer *fermé*. Une égalité stricte
  # laisserait `production`, `prod-eu` ou `prod2` désarmer les quatre
  # préconditions — Multi-AZ, rétention, protection contre la suppression,
  # instantané final — sans que rien dans le plan ne le signale. Un environnement
  # hors production nommé `prod-quelque-chose` est, lui, une confusion qu'il vaut
  # mieux corriger que contourner.
  is_production = startswith(var.environment, "prod")

  # `postgres16` pour un moteur `16` comme pour `16.4` : la famille d'un groupe de
  # paramètres suit la version majeure.
  parameter_group_family = "postgres${split(".", var.engine_version)[0]}"

  postgres_port = 5432

  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : aws_kms_key.this[0].arn

  # `postgresql` porte les journaux du moteur, `upgrade` la trace des montées de
  # version majeure — la seule pièce disponible quand une migration échoue.
  cloudwatch_log_types = ["postgresql", "upgrade"]
}
