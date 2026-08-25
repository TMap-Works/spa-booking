# Dernier maillon de la chaîne décrite par le skill aws-infra §4, côté cache :
#
#   Internet → ALB (443) → ECS (port applicatif) → Redis (6379)
#
# Chaque entrée référence un **groupe de sécurité**, jamais un bloc CIDR : un
# bloc CIDR autorise tout ce qui obtiendra un jour une adresse dans cette plage,
# un identifiant de groupe n'autorise que les membres de ce groupe.
#
# Les descriptions restent sans accent ni apostrophe : l'API EC2 n'accepte, dans
# la description d'un groupe comme dans celle d'une règle, que `a-z A-Z 0-9`,
# l'espace et `._-:/()#,@[]+=&;{}!$*`. Un caractère accentué fait échouer
# l'`apply` sur « InvalidParameterValue: Invalid characters in description ».

resource "aws_security_group" "this" {
  # `name_prefix` et non `name` : le groupe est référencé par le groupe de
  # réplication, donc AWS refuse de le détacher avant qu'un remplaçant n'existe
  # — et deux groupes ne peuvent pas porter le même nom dans un VPC. Le couple
  # `name_prefix` + `create_before_destroy` est la seule combinaison qui laisse
  # un remplacement aboutir ; l'étiquette `Name`, elle, reste lisible.
  name_prefix = "${local.name_prefix}-redis-"
  description = "Redis depuis les groupes de securite applicatifs autorises"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${local.name_prefix}-redis"
    Tier = "data"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# `for_each` sur la map, et non sur `toset()` d'une liste : les clés d'un
# `for_each` doivent être connues au moment du plan. Les identifiants de groupe,
# eux, ne le sont pas tant que le groupe applicatif n'existe pas — un ensemble
# construit à partir d'eux fait échouer le plan sur « Invalid for_each argument »,
# et le premier `apply` d'un environnement est exactement ce cas. L'étiquette,
# écrite par l'appelant, est connue ; la valeur peut rester inconnue.
resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each = var.allowed_security_group_ids

  security_group_id            = aws_security_group.this.id
  description                  = "Redis depuis ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = local.redis_port
  to_port                      = local.redis_port
  ip_protocol                  = "tcp"
}

# Réplication entre nœuds du même groupe. Ce groupe n'est porté que par les
# nœuds ElastiCache : s'y référencer lui-même n'ouvre donc rien d'autre que le
# trafic primaire ↔ réplica, sur le seul port Redis. C'est ce qui permet de
# n'écrire aucune règle sortante vers `0.0.0.0/0` tout en laissant un groupe à
# réplicas fonctionner.
resource "aws_vpc_security_group_ingress_rule" "replication" {
  security_group_id            = aws_security_group.this.id
  description                  = "Replication entre noeuds du groupe"
  referenced_security_group_id = aws_security_group.this.id
  from_port                    = local.redis_port
  to_port                      = local.redis_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "replication" {
  security_group_id            = aws_security_group.this.id
  description                  = "Replication vers les noeuds du groupe"
  referenced_security_group_id = aws_security_group.this.id
  from_port                    = local.redis_port
  to_port                      = local.redis_port
  ip_protocol                  = "tcp"
}

# Aucune autre règle sortante n'est déclarée, et c'est voulu : un nœud
# ElastiCache répond à des connexions, il n'en ouvre pas vers l'extérieur. Un
# groupe dont les seules règles sortantes pointent vers lui-même n'autorise rien
# hors du cluster — c'est la différence avec le comportement par défaut d'un
# groupe créé dans la console, qui part sur `0.0.0.0/0` en sortie.
