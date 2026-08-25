# Chaîne stricte, référencée par identifiant de groupe et non par bloc CIDR
# (skill aws-infra §4) :
#
#   Internet → ALB (80, 443) → tâches (port applicatif) → données (par
#   task_egress_rules, déclaré par l'environnement)
#
# Les descriptions de groupes et de règles sont sans accent ni apostrophe :
# l'API EC2 n'accepte dans ces deux champs que `a-z A-Z 0-9`, l'espace et
# `._-:/()#,@[]+=&;{}!$*`. Un caractère accentué fait échouer l'`apply` sur
# « InvalidParameterValue: Invalid characters in description ». Les étiquettes,
# elles, acceptent l'Unicode.

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Entree HTTP et HTTPS depuis Internet vers l ALB"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name_prefix}-tasks"
  description = "Taches Fargate - entree depuis l ALB uniquement"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${local.name_prefix}-tasks"
  }
}

# --- Entrée de l'ALB ----------------------------------------------------------
#
# Seul endroit du dépôt où `0.0.0.0/0` est légitime en entrée : un ALB public
# n'a pas de liste d'adresses clientes connue. Le port 80 n'est ouvert que pour
# être immédiatement redirigé vers 443 (voir alb.tf) — le refuser ferait tomber
# en délai d'attente une saisie d'URL sans schéma, au lieu de la corriger.
#
# Rien en IPv6 : le VPC du module `network` n'a pas de bloc IPv6, l'ALB reste
# donc `ipv4`. Une règle `::/0` n'y autoriserait aucun trafic réel tout en
# élargissant la surface déclarée du groupe — et ferait croire à une relecture
# que le double pile est en service. Le jour où il le sera, ces règles
# reviendront en même temps que `ip_address_type = "dualstack"` et que le bloc
# IPv6 des sous-réseaux publics, pas avant.

resource "aws_vpc_security_group_ingress_rule" "alb_https_ipv4" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS depuis Internet"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_ipv4" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP depuis Internet - redirige vers HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# --- ALB vers les tâches ------------------------------------------------------
#
# Une paire de règles par port applicatif distinct, et rien d'autre : l'ALB n'a
# aucune raison de joindre autre chose que les conteneurs qu'il sert.

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  for_each = local.container_ports

  security_group_id            = aws_security_group.alb.id
  description                  = "Vers les taches Fargate sur le port ${each.key}"
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each = local.container_ports

  security_group_id            = aws_security_group.tasks.id
  description                  = "Depuis l ALB sur le port ${each.key}"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  ip_protocol                  = "tcp"
}

# --- Sortie des tâches --------------------------------------------------------
#
# 443 vers l'exterieur est indispensable et ne se contourne pas : avec le mode
# réseau `awsvpc`, c'est l'interface de la tâche elle-même qui tire l'image ECR,
# résout ses secrets et pousse ses journaux. Ce trafic reste interne au réseau
# AWS grâce aux endpoints du module `network`, mais il passe bien par ce groupe.
# S'y ajoutent les API tierces appelées en HTTPS, Stripe au premier chef.

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS sortant - ECR, Secrets Manager, CloudWatch Logs, API tierces"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Sorties déclarées par l'environnement — PostgreSQL, Redis. Rien n'est ouvert
# par défaut : une tâche qui n'a pas besoin de la base n'y accède pas.
resource "aws_vpc_security_group_egress_rule" "tasks_additional" {
  for_each = var.task_egress_rules

  security_group_id            = aws_security_group.tasks.id
  description                  = each.value.description
  cidr_ipv4                    = each.value.cidr_ipv4
  referenced_security_group_id = each.value.referenced_security_group_id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
}
