# Traçage distribué (CDC §4.11).
#
# X-Ray répond à la question que ni les journaux ni les métriques ne savent
# traiter : *où* passent les deux secondes de cette requête. Une réservation
# traverse l'ALB, l'API, PostgreSQL, Redis et Stripe ; un p99 dégradé peut venir
# de n'importe lequel des cinq, et le chercher dans les journaux revient à
# recoller des horodatages à la main.
#
# Ce fichier ne pose que l'échantillonnage. Le traçage proprement dit tient en
# deux choses, toutes deux portées par le module `ecs-service` parce qu'elles
# vivent dans la tâche :
#
#   1. le sidecar `aws-xray-daemon`, qui écoute en UDP sur 127.0.0.1:2000 et
#      relaie les segments — sans lui, le SDK écrit dans le vide ;
#   2. le droit `xray:PutTraceSegments` sur le rôle de tâche.
#
# Il y manque une troisième, hors de ce dépôt d'infrastructure : l'instrumentation
# du code de l'API. Tant qu'`apps/api` n'ouvre pas de segment, le démon tourne et
# ne reçoit rien.

resource "aws_xray_sampling_rule" "this" {
  count = var.tracing.enabled ? 1 : 0

  rule_name = "${local.name_prefix}-api"

  # Rang d'évaluation, du plus petit au plus grand. La règle `Default` de X-Ray
  # occupe 10000 : toute règle placée au-delà serait inatteignable.
  priority = var.tracing.priority

  # Seule valeur admise par l'API — le champ existe pour un versionnement du
  # format de règle qui n'a jamais eu lieu.
  version = 1

  # Le réservoir se compte **par seconde** : une requête tracée par seconde,
  # quoi qu'il arrive, avant que le taux fixe ne s'applique au reste. C'est ce
  # qui garantit de voir quelque chose sur un environnement à faible trafic, où
  # 5 % de trois requêtes par minute ne trace rien la plupart du temps.
  reservoir_size = var.tracing.reservoir_size
  fixed_rate     = var.tracing.fixed_rate

  # Filtre du champ d'application de la règle. `service_name` est le nom que
  # l'application déclare au SDK ; le laisser à `*` ferait gouverner par cette
  # règle le traçage des trois environnements, qui partagent un compte.
  service_name = local.tracing_service_name
  service_type = "*"
  host         = "*"
  http_method  = "*"
  url_path     = "*"

  # `resource_arn` ne sert qu'aux règles rattachées à une ressource précise
  # (une API Gateway, par exemple). `*` est la valeur des règles de service, et
  # l'API la refuse vide.
  resource_arn = "*"

  tags = {
    Name = "${local.name_prefix}-api"
  }
}
