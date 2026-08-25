# VPC Endpoints (CDC §4.3). Deux raisons, dans cet ordre :
#
#   1. Coût. Sans eux, le tirage d'image ECR au démarrage de chaque tâche
#      Fargate et chaque ligne de log poussée vers CloudWatch sortent par la NAT
#      Gateway, facturée au gigaoctet traité — l'un des postes qui gonflent le
#      plus discrètement (CDC §4.16).
#   2. Sécurité. Le trafic vers ces services ne quitte jamais le réseau AWS.

# Les descriptions ci-dessous sont volontairement sans apostrophe ni accent :
# l'API EC2 n'accepte, dans la description d'un groupe de sécurité comme dans
# celle d'une règle, que `a-z A-Z 0-9`, l'espace et `._-:/()#,@[]+=&;{}!$*`. Une
# apostrophe ou un caractère accentué fait échouer l'`apply` sur
# « InvalidParameterValue: Invalid characters in description ». Les étiquettes,
# elles, acceptent l'Unicode — la contrainte ne porte que sur ces deux champs.
resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.name_prefix}-vpce"
  description = "HTTPS depuis le VPC vers les endpoints de type interface"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${local.name_prefix}-vpce"
  }
}

# Seule entorse assumée à la règle « référencer un groupe de sécurité par son id,
# jamais par un bloc CIDR » (skill aws-infra §4) : les groupes clients — ECS,
# Lambda — appartiennent à des modules qui n'existent pas encore, et un endpoint
# ne peut pas attendre.
#
# La portée est celle des seuls niveaux privés, pas du VPC entier : ce qui vit
# dans le niveau public — ALB, demain un bastion — n'a aucune raison de joindre
# Secrets Manager ou ECR, et l'y autoriser reviendrait à rendre l'endpoint plus
# large que le besoin qui le justifie.
resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_https" {
  for_each = merge(
    { for az, subnet in aws_subnet.app : "app-${az}" => subnet.cidr_block },
    { for az, subnet in aws_subnet.data : "data-${az}" => subnet.cidr_block },
  )

  security_group_id = aws_security_group.vpc_endpoints.id
  description       = "HTTPS depuis le sous-reseau prive ${each.key}"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Aucune règle sortante n'est déclarée, et c'est voulu : une ENI d'endpoint
# d'interface ne fait que répondre à des connexions entrantes.

# --- Endpoint de passerelle S3 ------------------------------------------------
#
# Associé aux tables de routage privées, y compris celle du niveau données : ce
# chemin reste interne au réseau AWS, il n'introduit donc pas de route vers
# Internet. Il porte aussi les couches d'image ECR, que `ecr.dkr` seul ne suffit
# pas à récupérer.

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    [for table in aws_route_table.app : table.id],
    [aws_route_table.data.id],
  )

  tags = {
    Name = "${local.name_prefix}-vpce-s3"
  }
}

# --- Endpoints d'interface ----------------------------------------------------
#
# Les ENI sont posées dans le niveau applicatif. Le niveau données les atteint
# tout de même par la route locale du VPC, sans qu'aucune route sortante ne lui
# soit ajoutée.

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(local.interface_endpoints)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for subnet in aws_subnet.app : subnet.id]
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = {
    Name = "${local.name_prefix}-vpce-${replace(each.key, ".", "-")}"
  }
}
