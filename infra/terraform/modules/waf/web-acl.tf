# Web ACL AWS WAF v2 — la première chose que rencontre une requête venue
# d'Internet, avant l'ALB et donc bien avant NestJS (CDC §4.10).
#
# Ce que ce module protège et ce qu'il ne protège pas, parce que la confusion est
# classique : WAF filtre la **forme** des requêtes — une charge d'injection, un
# en-tête malformé, un débit anormal. Il ne connaît ni les tenants, ni les rôles,
# ni les règles de réservation. L'isolation inter-tenant reste entièrement du
# ressort de l'application (skill tenant-isolation) ; un WAF qui laisserait croire
# le contraire serait pire qu'aucun WAF.
#
# `default_action = allow` et non `block` : la Web ACL est une liste de refus, pas
# une liste d'autorisations. Un défaut à `block` demanderait d'énumérer tout ce
# que le parcours client émet — et couperait la plateforme au premier chemin
# oublié.

resource "aws_wafv2_web_acl" "this" {
  name        = local.web_acl_name
  description = "Filtrage applicatif en amont de l'ALB ${local.name_prefix} — injections, XSS, entrees connues, reputation IP, bots, limitation de debit."
  scope       = var.scope

  default_action {
    allow {}
  }

  # Réponse servie à qui dépasse le débit. Sans corps personnalisé, WAF rend un
  # 403 sec : un client légitime pris dans la limite d'un réseau partagé ne peut
  # pas distinguer « vous allez trop vite » de « vous n'avez pas le droit », et
  # réessaie aussitôt.
  custom_response_body {
    key          = local.rate_limit_body_key
    content_type = "APPLICATION_JSON"

    # Même forme d'erreur que celle de l'API — `{ code, message, details }` —
    # pour qu'un client n'ait pas deux schémas d'erreur à connaître selon que la
    # requête a été refusée avant ou après l'ALB.
    content = jsonencode({
      code    = "RATE_LIMITED"
      message = "Trop de requetes depuis cette adresse. Reessayez dans quelques minutes."
      details = {}
    })
  }

  # --- Limitation de débit ----------------------------------------------------
  #
  # Priorité 1, avant tous les groupes managés : une inondation se rejette au
  # moins cher possible. Inspecter le corps de dix mille requêtes par seconde pour
  # découvrir qu'elles viennent de la même adresse coûte l'inspection.
  rule {
    name     = local.rate_limit_rule_name
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = local.rate_limit_body_key
        }
      }
    }

    statement {
      rate_based_statement {
        limit = var.rate_limit

        # Agrégation par adresse IP source. `FORWARDED_IP` supposerait de faire
        # confiance à un `X-Forwarded-For` que n'importe quel client peut écrire :
        # le compteur deviendrait contournable en changeant un en-tête.
        aggregate_key_type = "IP"
      }
    }

    # `metric_name` identique au nom de la règle : c'est cette valeur, et non le
    # nom de la ressource, que WAF publie dans la dimension CloudWatch `Rule`, et
    # c'est elle que nomme l'alarme `rate_limited`.
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = local.rate_limit_rule_name
      sampled_requests_enabled   = true
    }
  }

  # --- Groupes de règles managés AWS ------------------------------------------
  #
  # Les priorités et les motifs de chaque groupe sont dans locals.tf. Ici, la
  # seule subtilité est `override_action`, dont le nom trompe : il ne remplace pas
  # l'action d'une règle, il décide si le groupe **peut** bloquer (`none`) ou s'il
  # se contente de compter (`count`).
  dynamic "rule" {
    for_each = local.managed_rule_groups

    content {
      name     = rule.value.name
      priority = rule.value.priority

      override_action {
        dynamic "count" {
          for_each = rule.value.count_only ? [1] : []
          content {}
        }

        dynamic "none" {
          for_each = rule.value.count_only ? [] : [1]
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.value.name

          # Neutralisation d'une règle précise sans désarmer son groupe. C'est la
          # granularité à préférer dès qu'un faux positif est identifié.
          dynamic "rule_action_override" {
            for_each = toset(rule.value.counted_rules)

            content {
              name = rule_action_override.value

              action_to_use {
                count {}
              }
            }
          }

          # Bot Control est le seul groupe à demander une configuration ; les
          # quatre autres n'en acceptent aucune.
          dynamic "managed_rule_group_configs" {
            for_each = rule.value.bot_inspection == null ? [] : [rule.value.bot_inspection]

            content {
              aws_managed_rules_bot_control_rule_set {
                inspection_level = managed_rule_group_configs.value
              }
            }
          }
        }
      }

      # Même règle que ci-dessus : la dimension CloudWatch `Rule` d'un groupe
      # managé porte son nom AWS, celui qu'on retrouve dans la console et dans les
      # journaux du WAF.
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.value.name
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true

    # Valeur de la dimension CloudWatch `WebACL`, celle que nomment les deux
    # alarmes et la sortie `web_acl_name`.
    metric_name = local.web_acl_name

    # Conserve un échantillon des requêtes évaluées, consultable dans la console.
    # C'est ce qui permet de comprendre *pourquoi* une règle a bloqué sans avoir à
    # journaliser tout le trafic — et donc ce qui rend `log_only_inspected_requests`
    # tenable.
    sampled_requests_enabled = true
  }

  tags = {
    Name = local.web_acl_name
  }

  lifecycle {
    precondition {
      condition     = var.scope == "REGIONAL" || length(var.associated_resource_arns) == 0
      error_message = "Une Web ACL de portée CLOUDFRONT ne s'associe pas par `aws_wafv2_web_acl_association` : la distribution la référence elle-même par `web_acl_id`. Laisser `associated_resource_arns` vide, ou repasser `scope` à REGIONAL."
    }
  }
}

# --- Association aux ressources protégées -------------------------------------

# `for_each` sur la map fournie par l'appelant, et non sur un ensemble d'ARN :
# l'ARN de l'ALB est un attribut calculé, inconnu au plan du premier `apply`. Un
# `toset()` d'ARN ferait échouer le plan sur « Invalid for_each argument », ce qui
# est exactement le cas que rencontrent les modules `database` et `cache` avec les
# identifiants de groupes de sécurité.
resource "aws_wafv2_web_acl_association" "this" {
  for_each = var.associated_resource_arns

  resource_arn = each.value
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
