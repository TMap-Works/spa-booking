# Application Load Balancer public : terminaison TLS par certificat ACM, un
# groupe cible par service, routage par règle d'écoute (CDC §4.4).

resource "aws_lb" "this" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  enable_deletion_protection = var.alb_deletion_protection
  idle_timeout               = var.alb_idle_timeout_seconds

  # Un en-tête HTTP mal formé est rejeté au lieu d'être transmis tel quel. C'est
  # ce qui ferme la porte au « request smuggling » : sans cela, l'ALB et le
  # serveur applicatif peuvent lire deux requêtes différentes dans le même flux.
  drop_invalid_header_fields = true

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

# --- Groupes cibles -----------------------------------------------------------

resource "aws_lb_target_group" "service" {
  for_each = var.services

  name        = local.target_group_names[each.key]
  vpc_id      = var.vpc_id
  port        = each.value.container_port
  protocol    = "HTTP"
  target_type = "ip" # imposé par le mode réseau `awsvpc` de Fargate

  # Le temps qu'une tâche retirée du service finisse de servir ses requêtes en
  # cours. Trente secondes suffisent à une API HTTP et raccourcissent d'autant
  # chaque déploiement ; le défaut de 300 s allonge un rolling update de cinq
  # minutes par vague, sans rien protéger de plus.
  deregistration_delay = 30

  # Répartit sur la tâche qui a le moins de requêtes en cours plutôt qu'au
  # hasard. La différence se voit quand les requêtes ont des coûts très
  # inégaux — un calcul de disponibilité face à un rendu de page.
  load_balancing_algorithm_type = "least_outstanding_requests"

  health_check {
    enabled             = true
    path                = each.value.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = local.target_group_names[each.key]
  }

  lifecycle {
    precondition {
      condition     = length(local.target_group_names[each.key]) <= 32
      error_message = "Le nom du groupe cible « ${local.target_group_names[each.key]} » dépasse les 32 caractères admis par l'API : raccourcir `environment` ou la clé du service."
    }
  }
}

# --- Écoute -------------------------------------------------------------------

# Le port 80 ne sert qu'à rediriger : aucune requête applicative ne transite en
# clair. La redirection est permanente pour que les clients qui la mettent en
# cache cessent d'y repasser.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = {
    Name = "${local.name_prefix}-alb-http"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  # Action par défaut explicite plutôt que renvoi vers un service : ce qui ne
  # correspond à aucune règle est une erreur de routage, et le dire vaut mieux
  # que de la faire absorber par l'application qui se trouve être la première.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Aucun service ne correspond a cette requete."
      status_code  = "404"
    }
  }

  tags = {
    Name = "${local.name_prefix}-alb-https"
  }

  lifecycle {
    # Un ALB n'accepte qu'un certificat de sa propre région. L'erreur classique
    # est le certificat `us-east-1` créé pour CloudFront, qui a la bonne forme
    # et que l'API refuse à l'`apply` sur un message qui ne dit pas pourquoi.
    precondition {
      condition     = split(":", var.certificate_arn)[3] == data.aws_region.current.name
      error_message = "Le certificat ACM « ${var.certificate_arn} » n'est pas dans la région de l'ALB (${data.aws_region.current.name}). Un ALB n'accepte qu'un certificat de sa propre région."
    }
  }
}

resource "aws_lb_listener_rule" "service" {
  for_each = var.services

  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }

  dynamic "condition" {
    for_each = length(each.value.host_headers) > 0 ? [each.value.host_headers] : []

    content {
      host_header {
        values = condition.value
      }
    }
  }

  dynamic "condition" {
    for_each = length(each.value.path_patterns) > 0 ? [each.value.path_patterns] : []

    content {
      path_pattern {
        values = condition.value
      }
    }
  }

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }

  lifecycle {
    precondition {
      condition     = length(each.value.host_headers) > 0 || length(each.value.path_patterns) > 0
      error_message = "Le service « ${each.key} » doit porter au moins un `host_headers` ou un `path_patterns` : une règle d'écoute sans condition est refusée par l'API."
    }
  }
}
