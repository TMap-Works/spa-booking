# Tableau de bord transverse de l'environnement.
#
# Ce que les alarmes ne donnent pas : la vue d'ensemble et la tendance. Une
# alarme dit qu'un seuil est franchi maintenant ; elle ne dit pas que les
# connexions montent de dix par jour depuis une semaine, ni que la latence a
# doublé au dernier déploiement sans jamais atteindre deux secondes. C'est aussi
# le premier écran qu'on ouvre quand l'astreinte sonne : une seule page, du point
# d'entrée public jusqu'au disque de la base.
#
# Complémentaire du tableau de bord du module `notifications`, qui détaille
# l'issue des envois. Trois tableaux de bord par compte sont gratuits ; si un
# environnement en veut un seul, c'est `create_dashboard` qu'on passe à faux —
# ici ou là-bas, selon ce qu'on regarde le plus souvent.

locals {
  # Les alarmes du module, dans l'ordre où elles se lisent : entrée publique,
  # calcul, données, asynchrone. C'est aussi la liste que la vignette d'état
  # affiche en tête de tableau.
  #
  # `length()` de cette liste est connu au plan — les `count` et les `for_each`
  # amont le sont —, même quand les ARN eux-mêmes ne le sont pas. C'est ce qui
  # autorise à s'en servir pour décider s'il y a un tableau de bord à créer.
  alarm_arns = concat(
    aws_cloudwatch_metric_alarm.alb_5xx_rate[*].arn,
    aws_cloudwatch_metric_alarm.alb_latency_p99[*].arn,
    values(aws_cloudwatch_metric_alarm.ecs_cpu)[*].arn,
    aws_cloudwatch_metric_alarm.rds_connections[*].arn,
    aws_cloudwatch_metric_alarm.rds_free_storage[*].arn,
    values(aws_cloudwatch_metric_alarm.dead_letter_queue_depth)[*].arn,
    values(aws_cloudwatch_metric_alarm.lambda_errors)[*].arn,
  )

  # Propriétés communes à toutes les vignettes de métriques. Les répéter à la
  # main est le meilleur moyen de laisser une vignette sur une autre région ou
  # une autre période que ses voisines, et de comparer deux courbes qui ne
  # décrivent pas le même intervalle.
  widget_defaults = {
    region = data.aws_region.current.name
    view   = "timeSeries"
    period = var.alarm_period_seconds
  }

  # Une compréhension par vignette, sur une liste qui vaut zéro ou un élément,
  # plutôt qu'une conditionnelle portant la liste entière.
  #
  # Ce détour n'est pas gratuit : les deux branches d'un `?:` doivent avoir des
  # types unifiables, et deux vignettes n'ont pas la même forme — l'une porte une
  # annotation de seuil, l'autre non, et leurs `metrics` n'ont ni la même
  # longueur ni les mêmes options. Terraform refuse alors la conditionnelle sur
  # « The 'true' tuple has length 2, but the 'false' tuple has length 0 ».
  # `for` et `concat`, eux, produisent des tuples et s'accommodent de
  # l'hétérogénéité.
  alb_sources = local.alb_enabled ? [var.alb] : []
  ecs_sources = local.ecs_enabled ? [var.ecs] : []
  rds_sources = local.rds_enabled ? [var.rds] : []

  alb_widgets = concat(
    [for alb in local.alb_sources : {
      title = "Entree publique — trafic et reponses"
      stat  = "Sum"
      metrics = [
        ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", alb.arn_suffix, { label = "Requetes" }],
        ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", alb.arn_suffix, { label = "5xx applicatives" }],
        ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", alb.arn_suffix, { label = "5xx infrastructure" }],
        ["AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", "LoadBalancer", alb.arn_suffix, { label = "4xx" }],
      ]
    }],

    # Trois centiles sur la même métrique plutôt qu'une moyenne : c'est l'écart
    # entre p50 et p99 qui dit si le service est lent pour tout le monde ou
    # seulement pour quelques-uns, et les deux ne se réparent pas pareil.
    [for alb in local.alb_sources : {
      title = "Entree publique — latence de reponse"
      stat  = "p99"
      metrics = [
        ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", alb.arn_suffix, { stat = "p50", label = "p50" }],
        ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", alb.arn_suffix, { stat = "p90", label = "p90" }],
        ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", alb.arn_suffix, { stat = "p99", label = "p99" }],
      ]
      annotations = {
        horizontal = [{
          label = "Seuil d'alarme p99"
          value = alb.p99_latency_seconds
        }]
      }
    }],
  )

  ecs_widgets = [for ecs in local.ecs_sources : {
    title = "Services — CPU et memoire"
    stat  = "Average"
    metrics = concat(
      [for key, name in ecs.service_names :
        ["AWS/ECS", "CPUUtilization", "ClusterName", ecs.cluster_name, "ServiceName", name, { label = "${key} — CPU" }]
      ],
      [for key, name in ecs.service_names :
        ["AWS/ECS", "MemoryUtilization", "ClusterName", ecs.cluster_name, "ServiceName", name, { label = "${key} — memoire" }]
      ],
    )
    annotations = {
      horizontal = [{
        label = "Seuil d'alarme CPU"
        value = ecs.cpu_percent
      }]
    }
  }]

  rds_widgets = concat(
    [for rds in local.rds_sources : {
      title = "Base — connexions ouvertes"
      stat  = "Maximum"
      metrics = [
        ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", rds.instance_id, { label = "Connexions" }],
      ]
      annotations = {
        horizontal = [{
          label = "Seuil d'alarme (${rds.connections_percent} % de ${rds.max_connections})"
          value = local.rds_connections_threshold
        }]
      }
    }],

    [for rds in local.rds_sources : {
      title = "Base — espace disque libre"
      stat  = "Minimum"
      metrics = [
        ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", rds.instance_id, { label = "Espace libre" }],
      ]
      annotations = {
        horizontal = [{
          label = "Seuil d'alarme (${rds.free_storage_percent} % de ${rds.allocated_storage_gib} Gio)"
          value = local.rds_free_storage_threshold_bytes
        }]
      }
    }],
  )

  queue_widgets = length(var.dead_letter_queues) == 0 ? [] : [
    {
      title = "Files sans issue — profondeur"
      stat  = "Maximum"
      metrics = [for key, name in var.dead_letter_queues :
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", name, { label = key }]
      ]
    },
  ]

  lambda_widgets = length(var.lambda_functions) == 0 ? [] : [
    {
      title = "Fonctions — invocations et erreurs"
      stat  = "Sum"
      metrics = concat(
        [for key, name in var.lambda_functions :
          ["AWS/Lambda", "Invocations", "FunctionName", name, { label = "${key} — invocations" }]
        ],
        [for key, name in var.lambda_functions :
          ["AWS/Lambda", "Errors", "FunctionName", name, { label = "${key} — erreurs" }]
        ],
      )
    },
  ]

  metric_widgets = concat(
    local.alb_widgets,
    local.ecs_widgets,
    local.rds_widgets,
    local.queue_widgets,
    local.lambda_widgets,
  )

  # Positions calculées plutôt qu'écrites : le nombre de vignettes dépend de ce
  # que l'environnement compose, et une grille posée à la main se décalerait
  # d'une ligne le jour où un environnement n'a pas de base de données. Deux
  # colonnes de 12 unités sur les 24 de la grille CloudWatch, sous la vignette
  # d'état des alarmes qui occupe toute la première bande.
  alarm_widget_height = 4

  dashboard_widgets = concat(
    length(local.alarm_arns) == 0 ? [] : [{
      type   = "alarm"
      x      = 0
      y      = 0
      width  = 24
      height = local.alarm_widget_height
      properties = {
        title  = "Alarmes de ${local.name_prefix}"
        alarms = local.alarm_arns
      }
    }],
    [for index, widget in local.metric_widgets : {
      type   = "metric"
      x      = index % 2 == 0 ? 0 : 12
      y      = local.alarm_widget_height + floor(index / 2) * 6
      width  = 12
      height = 6
      properties = merge(local.widget_defaults, {
        title   = widget.title
        stat    = widget.stat
        metrics = widget.metrics
        # `try` et non `lookup` : les vignettes n'ont pas toutes la même forme —
        # seules certaines portent une annotation de seuil —, et `lookup` exige
        # une map, c'est-à-dire des valeurs de même type. Le `concat` ci-dessus
        # produit un tuple d'objets hétérogènes, ce qui est précisément le cas
        # que `try` sait traiter.
      }, try({ annotations = widget.annotations }, {}))
    }],
  )
}

resource "aws_cloudwatch_dashboard" "this" {
  # Rien à afficher tant que l'environnement ne compose aucune des sources : un
  # tableau de bord vide occuperait l'un des trois emplacements gratuits du
  # compte sans rien montrer.
  count = var.create_dashboard && length(local.metric_widgets) > 0 ? 1 : 0

  dashboard_name = "${local.name_prefix}-supervision"
  dashboard_body = jsonencode({ widgets = local.dashboard_widgets })
}
