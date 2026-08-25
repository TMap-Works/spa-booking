# Cluster Fargate (CDC §4.4). Aucun fournisseur de capacité EC2 n'est déclaré :
# ce qui n'existe pas ne peut pas être choisi par distraction dans une définition
# de service, et le parc reste sans instance à administrer ni à corriger.

resource "aws_ecs_cluster" "this" {
  name = "${local.name_prefix}-cluster"

  setting {
    name = "containerInsights"
    # Facturé à la métrique publiée, donc laissé au choix de l'environnement.
    value = var.container_insights_enabled ? "enabled" : "disabled"
  }

  tags = {
    Name = "${local.name_prefix}-cluster"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# Un groupe de journaux par service, créé ici plutôt que laissé à l'agent ECS :
# un groupe créé automatiquement n'a ni rétention ni chiffrement, et personne ne
# s'en aperçoit avant la facture (skill aws-infra §8).
resource "aws_cloudwatch_log_group" "service" {
  for_each = var.services

  name              = "/ecs/${local.name_prefix}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn

  tags = {
    Name = "${local.name_prefix}-${each.key}-logs"
  }
}
