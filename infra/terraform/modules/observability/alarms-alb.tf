# Supervision du point d'entrée public.
#
# C'est la seule couche qui voie ce que la cliente voit : une tâche saine pour
# ECS mais qui rend des 500, un déploiement qui passe le health check et casse
# une route sur deux, une base lente qui transforme la réservation en attente de
# quinze secondes. Les alarmes ECS et RDS disent qu'une ressource va mal ; ces
# deux-ci disent que le service ne rend plus ce qu'il promet.

# --- 1. Part de réponses 5xx --------------------------------------------------

# Un **taux**, pas un compte : le CDC §4.11 dit « au-dessus de 1 % des requêtes »,
# et c'est ce qui distingue une erreur isolée d'une panne. Dix 500 sur cent mille
# requêtes ne sont pas un incident ; dix 500 sur deux cents en sont un.
#
# Les deux compteurs sont additionnés parce qu'ils décrivent deux pannes
# différentes, toutes deux visibles de la cliente :
#
#   HTTPCode_Target_5XX_Count  l'application a répondu, et elle a répondu 500
#   HTTPCode_ELB_5XX_Count     l'ALB n'a trouvé personne à qui parler, ou la
#                              tâche a coupé la connexion — 502, 503, 504
#
# Ne compter que le premier laisserait invisible le cas le plus grave : plus une
# seule tâche saine, donc plus une seule réponse applicative.
resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  count = local.alb_enabled ? 1 : 0

  alarm_name        = "${local.name_prefix}-alb-5xx-rate"
  alarm_description = "Plus de ${var.alb.error_rate_percent} % des requêtes servies par l'ALB ${var.alb.arn_suffix} rendent une 5xx, applicative ou d'infrastructure. Le taux n'est évalué qu'à partir de ${var.alb.min_requests_per_period} requêtes sur la période."

  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alb.error_rate_percent
  evaluation_periods  = 1

  # Sans trafic, l'ALB ne publie aucun point et l'expression ne rend rien :
  # l'alarme resterait en `INSUFFICIENT_DATA`, c'est-à-dire ni verte ni rouge,
  # donc ignorée au bout d'une semaine.
  treat_missing_data = "notBreaching"

  # `FILL(…, 0)` sur les deux compteurs d'erreur, et sur eux seuls : l'ALB ne
  # publie pas de point pour un compteur resté à zéro, et une somme dont un
  # terme manque est un trou — pas un zéro. Sans cela, l'expression ne rendrait
  # de valeur que pendant les périodes où il y a **déjà** eu des erreurs, ce qui
  # est précisément le moment où l'on n'a plus besoin d'elle.
  #
  # `RequestCount` n'est pas rempli, lui : c'est le garde qui protège la
  # division, et le remplir à zéro la rendrait à nouveau possible.
  metric_query {
    id          = "error_rate"
    label       = "Part de reponses 5xx (%)"
    expression  = "IF(requests >= ${var.alb.min_requests_per_period}, 100 * (FILL(elb_5xx, 0) + FILL(target_5xx, 0)) / requests, 0)"
    return_data = true
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = var.alb.arn_suffix }
      period      = var.alarm_period_seconds
      stat        = "Sum"
    }
  }

  metric_query {
    id = "elb_5xx"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = { LoadBalancer = var.alb.arn_suffix }
      period      = var.alarm_period_seconds
      stat        = "Sum"
    }
  }

  metric_query {
    id = "target_5xx"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb.arn_suffix }
      period      = var.alarm_period_seconds
      stat        = "Sum"
    }
  }

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.name_prefix}-alb-5xx-rate"
  }
}

# --- 2. Latence au 99e centile ------------------------------------------------

# `p99` et non `Average` : une moyenne à 300 ms peut recouvrir une requête sur
# cent à huit secondes, et c'est celle-là qui fait abandonner la réservation. Le
# centile est le seul agrégat qui décrive une expérience plutôt qu'un total.
#
# `TargetResponseTime` mesure le temps que met la **tâche** à répondre, file
# d'attente de l'ALB comprise — ce n'est donc pas seulement un symptôme
# applicatif : une saturation du service s'y voit aussi.
resource "aws_cloudwatch_metric_alarm" "alb_latency_p99" {
  count = local.alb_enabled ? 1 : 0

  alarm_name        = "${local.name_prefix}-alb-latency-p99"
  alarm_description = "Une requête sur cent servie par l'ALB ${var.alb.arn_suffix} met plus de ${var.alb.p99_latency_seconds} s à répondre (CDC §4.11). À ce niveau, une réservation en cours est abandonnée avant d'aboutir."

  namespace   = "AWS/ApplicationELB"
  metric_name = "TargetResponseTime"
  dimensions = {
    LoadBalancer = var.alb.arn_suffix
  }

  # `extended_statistic` et non `statistic` : les deux champs s'excluent, et
  # c'est le second qui porte les centiles.
  extended_statistic  = "p99"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = var.alb.p99_latency_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.name_prefix}-alb-latency-p99"
  }
}
