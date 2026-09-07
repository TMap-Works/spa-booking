# Journalisation des décisions de la Web ACL.
#
# Sans elle, WAF compte mais ne raconte rien : on sait que 412 requêtes ont été
# bloquées, pas lesquelles ni pourquoi. Or c'est précisément ce qu'il faut pour
# décider si une règle en observation peut passer en blocage — et pour instruire
# un faux positif signalé par une cliente.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# Le préfixe `aws-waf-logs-` n'est pas décoratif : WAF refuse toute destination
# CloudWatch Logs dont le nom de groupe ne commence pas par là, sur une erreur
# qui parle de destination invalide sans dire pourquoi.
resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${local.name_prefix}"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "aws-waf-logs-${local.name_prefix}"
  }
}

# Le service de livraison des journaux écrit dans le groupe pour le compte de
# WAF. Sans cette politique, la configuration de journalisation échoue sur un
# refus d'accès dont le message ne nomme ni le groupe ni le principal — la
# console la pose silencieusement, ce qui fait qu'on ne la découvre qu'en
# Terraform.
data "aws_iam_policy_document" "waf_logs" {
  count = var.create_log_resource_policy ? 1 : 0

  statement {
    sid    = "AutoriserLaLivraisonDesJournauxWaf"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    resources = ["${aws_cloudwatch_log_group.waf.arn}:*"]

    # Les deux conditions ferment le « confused deputy » : sans elles, le service
    # de livraison accepterait d'écrire ici pour le compte d'un autre compte AWS
    # qui aurait deviné l'ARN du groupe.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

# Un compte n'admet que dix politiques de ressource CloudWatch Logs par région, et
# celle-ci en consomme une par environnement — trois sur dix pour ce dépôt. Le
# jour où ce plafond gêne, `create_log_resource_policy = false` et une politique
# unique couvrant `aws-waf-logs-*` posée ailleurs.
resource "aws_cloudwatch_log_resource_policy" "waf" {
  count = var.create_log_resource_policy ? 1 : 0

  policy_name     = "${local.name_prefix}-waf-logs"
  policy_document = data.aws_iam_policy_document.waf_logs[0].json
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # Deux en-têtes caviardés, et ce sont les deux qui comptent : `authorization`
  # porte le jeton d'accès de la session, `cookie` porte le jeton de
  # rafraîchissement. Sans ce caviardage, le journal du WAF deviendrait le seul
  # endroit de la plateforme où des jetons de session valides sont écrits en
  # clair, avec la rétention d'un groupe de journaux — c'est-à-dire une escalade
  # de privilèges offerte à qui obtient `logs:GetLogEvents`.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  # Ne garder que ce que la Web ACL a décidé — bloqué ou compté. Le trafic
  # simplement laissé passer est déjà décrit par les journaux d'accès de l'ALB, et
  # le journaliser ici doublerait le poste CloudWatch Logs le plus volumineux de
  # la plateforme pour n'apprendre rien de neuf.
  dynamic "logging_filter" {
    for_each = var.log_only_inspected_requests ? [1] : []

    content {
      default_behavior = "DROP"

      filter {
        behavior    = "KEEP"
        requirement = "MEETS_ANY"

        condition {
          action_condition {
            action = "BLOCK"
          }
        }

        condition {
          action_condition {
            action = "COUNT"
          }
        }

        # `EXCLUDED_AS_COUNT` et non `COUNT` : c'est l'action que WAF journalise
        # quand ce qui a compté est un **groupe managé en `override_action =
        # count`** ou une règle neutralisée par `rule_action_override`. Sans cette
        # condition, les requêtes comptées par Bot Control — en observation par
        # défaut — et par toute entrée de `counted_rules` tombent dans le
        # `default_behavior = DROP`, et la procédure « lire les requêtes comptées
        # avant de faire passer le groupe en blocage » n'a plus rien à lire.
        condition {
          action_condition {
            action = "EXCLUDED_AS_COUNT"
          }
        }
      }
    }
  }

  # La politique de ressource doit exister avant que WAF n'essaie d'écrire :
  # l'ordre inverse fait échouer la création sur un refus d'accès.
  depends_on = [aws_cloudwatch_log_resource_policy.waf]
}
