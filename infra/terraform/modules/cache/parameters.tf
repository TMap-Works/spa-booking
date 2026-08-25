# Groupe de sous-réseaux et groupe de paramètres — tout ce qui doit exister
# avant le groupe de réplication lui-même.

resource "aws_elasticache_subnet_group" "this" {
  name        = "${local.name_prefix}-redis"
  description = "Sous-reseaux prives de donnees pour ${local.identifier}"
  subnet_ids  = var.subnet_ids

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}

# Le groupe de paramètres est attaché au groupe de réplication : ElastiCache
# refuse de le supprimer tant qu'il est référencé. `create_before_destroy`
# inverse l'ordre, sans quoi un changement de famille échoue au milieu de
# l'`apply`.
#
# Contrairement à `aws_db_parameter_group`, cette ressource n'accepte pas de
# `name_prefix` : le nom porte donc la famille. C'est ce qui rend le couple
# viable — la seule modification qui force un remplacement est justement le
# changement de famille, et il change le nom du même geste. Une modification de
# paramètre, elle, s'applique sur place.
resource "aws_elasticache_parameter_group" "this" {
  name        = "${local.name_prefix}-${local.parameter_group_family}"
  family      = local.parameter_group_family
  description = "Parametres Redis de ${local.identifier}"

  # Politique d'éviction. `volatile-lru` par défaut : seules les clés porteuses
  # d'un délai d'expiration sont candidates, une clé posée sans TTL ne disparaît
  # jamais sous la pression mémoire.
  #
  # À lire avec la règle n°4 du projet en tête : la garantie « zéro double
  # réservation » repose sur la contrainte d'exclusion PostgreSQL, pas sur la
  # survie d'un verrou Redis. Un verrou évincé fait retomber une réservation
  # concurrente sur la contrainte en base — elle échoue proprement — au lieu de
  # produire un double créneau. C'est ce qui rend l'éviction acceptable ici.
  parameter {
    name  = "maxmemory-policy"
    value = var.maxmemory_policy
  }

  # Coupe une connexion inactive au bout d'une heure. Sans cela, un client qui
  # meurt sans fermer laisse sa connexion ouverte jusqu'au redémarrage du nœud,
  # et un `cache.t4g.micro` plafonne vite en nombre de connexions.
  parameter {
    name  = "timeout"
    value = "3600"
  }

  dynamic "parameter" {
    for_each = var.extra_parameters

    content {
      name  = parameter.key
      value = parameter.value
    }
  }

  tags = {
    Name = "${local.name_prefix}-${local.parameter_group_family}"
  }

  lifecycle {
    create_before_destroy = true
  }
}
