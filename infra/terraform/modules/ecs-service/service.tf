resource "aws_ecs_task_definition" "this" {
  for_each = var.services

  family                   = "${local.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  # Les révisions précédentes restent `ACTIVE`. Sans cela, le provider
  # désenregistre l'ancienne à chaque nouvelle, et le retour arrière du
  # disjoncteur de déploiement n'a plus de cible : on ne démarre pas de tâche
  # depuis une définition `INACTIVE`. Le garde-fou armé plus bas ne servirait
  # alors qu'à constater l'échec.
  skip_destroy = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = each.value.cpu_architecture
  }

  container_definitions = jsonencode([
    merge(
      {
        name      = each.key
        image     = each.value.image
        essential = true

        portMappings = [{
          containerPort = each.value.container_port
          protocol      = "tcp"
        }]

        # `sort` sur les clés : sans ordre stable, chaque plan réécrirait la
        # définition de tâche et déclencherait un déploiement pour rien.
        environment = [
          for name in sort(keys(each.value.environment)) : {
            name  = name
            value = each.value.environment[name]
          }
        ]

        # Les valeurs sensibles arrivent par ARN, résolues par l'agent ECS au
        # démarrage. Seul l'ARN figure ici : la *valeur* du secret ne transite
        # ni par l'état Terraform, ni par la définition de tâche, ni par la
        # console ECS (CDC §4.4).
        secrets = [
          for name in sort(keys(each.value.secret_arns)) : {
            name      = name
            valueFrom = each.value.secret_arns[name]
          }
        ]

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.service[each.key].name
            "awslogs-region"        = data.aws_region.current.name
            "awslogs-stream-prefix" = each.key
          }
        }

        # Laisse à l'application le temps de finir ses requêtes en cours après le
        # SIGTERM, avant le SIGKILL.
        stopTimeout = 30
      },
      each.value.command == null ? {} : { command = each.value.command },
    )
  ])

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }

  lifecycle {
    precondition {
      condition     = contains(lookup(local.fargate_memory_by_cpu, tostring(each.value.cpu), []), each.value.memory)
      error_message = "Le couple cpu/memory du service « ${each.key} » (${each.value.cpu} / ${each.value.memory}) n'est pas une combinaison Fargate valide. Pour ${each.value.cpu} unités de CPU, memory doit valoir l'une de : ${join(", ", [for value in lookup(local.fargate_memory_by_cpu, tostring(each.value.cpu), []) : tostring(value)])}."
    }

    # Le nom d'une variable en clair qui sonne comme un secret est presque
    # toujours un secret posé au mauvais endroit : le bloc `environment` d'une
    # définition de tâche est lisible par quiconque a accès à la console ECS.
    precondition {
      condition = length([
        for name in keys(each.value.environment) :
        name if can(regex("(?i)(password|secret|credential|private_key|_token$)", name))
      ]) == 0
      error_message = "Le service « ${each.key} » place une valeur d'apparence sensible dans `environment`, en clair dans la définition de tâche. La déplacer vers `secret_arns`."
    }

    precondition {
      condition = alltrue([
        for arn in values(each.value.secret_arns) :
        can(regex("^arn:aws[a-z-]*:secretsmanager:", arn))
      ])
      error_message = "Chaque entrée de `secret_arns` du service « ${each.key} » doit être un ARN Secrets Manager — jamais la valeur du secret elle-même."
    }
  }
}

resource "aws_ecs_service" "this" {
  for_each = var.services

  name            = "${local.name_prefix}-${each.key}"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this[each.key].arn
  desired_count   = each.value.desired_count

  launch_type      = "FARGATE"
  platform_version = "LATEST"

  # Déploiement rolling sans coupure (CDC §4.4) : ECS démarre les nouvelles
  # tâches, attend qu'elles soient saines pour l'ALB, puis retire les anciennes.
  # `minimum_healthy_percent = 100` est ce qui interdit de descendre sous la
  # capacité nominale — à 50 %, la moitié du service disparaît pendant chaque
  # déploiement, et une montée en charge concomitante se paie en erreurs.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_controller {
    type = "ECS"
  }

  # Sans disjoncteur, un déploiement dont les tâches ne passent jamais le health
  # check tourne jusqu'au délai maximal en laissant l'ancienne version en place
  # — mais le service reste marqué « en cours de déploiement » et le suivant est
  # refusé. Avec, ECS revient de lui-même à la définition précédente.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = each.value.health_check_grace_period_seconds

  network_configuration {
    subnets         = var.app_subnet_ids
    security_groups = [aws_security_group.tasks.id]

    # Les tâches vivent dans le niveau applicatif et sortent par la NAT Gateway.
    # Une adresse publique les rendrait joignables depuis Internet en contournant
    # l'ALB, seul point d'entrée prévu.
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.service[each.key].arn
    container_name   = each.key
    container_port   = each.value.container_port
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }

  # Le groupe cible doit être rattaché à un listener avant qu'un service ne
  # puisse s'y enregistrer.
  #
  # La politique du rôle d'exécution est une ressource distincte du rôle : la
  # définition de tâche référence le rôle et n'attend donc pas sa politique.
  # Sans cette arête, le service peut être créé avant elle, ses premières tâches
  # échouent sur `CannotPullContainerError` — et le disjoncteur armé plus haut
  # fait échouer le tout premier déploiement.
  depends_on = [
    aws_lb_listener_rule.service,
    aws_iam_role_policy.execution,
  ]

  lifecycle {
    # `desired_count` appartient à l'auto-scaling une fois le service créé. Sans
    # cette exclusion, chaque `apply` ramènerait le service à sa valeur initiale
    # — c'est-à-dire réduirait la capacité en pleine charge.
    ignore_changes = [desired_count]

    precondition {
      condition     = each.value.min_capacity <= each.value.desired_count && each.value.desired_count <= each.value.max_capacity
      error_message = "Le service « ${each.key} » doit vérifier min_capacity ≤ desired_count ≤ max_capacity (${each.value.min_capacity} ≤ ${each.value.desired_count} ≤ ${each.value.max_capacity})."
    }
  }
}
