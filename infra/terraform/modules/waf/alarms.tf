# Deux alarmes, et deux seulement.
#
# Un WAF exposé sur Internet bloque en permanence : scanners de vulnérabilités,
# racleurs, adresses de mauvaise réputation. Le bruit de fond est constant et il
# est **normal**. Une alarme à zéro y sonnerait toutes les heures, et cesserait
# d'être lue en une semaine — c'est la panne la plus courante d'une supervision.
#
# Ce qui mérite un réveil, c'est donc le changement de régime :
#
# | Ce qui se passe | Ce qui le dit |
# |---|---|
# | Une salve — attaque ciblée, ou règle qui vient de casser un parcours | requêtes bloquées au-dessus du bruit de fond |
# | Une adresse inonde la plateforme | requêtes bloquées par la seule limitation de débit |
#
# La seconde n'est pas un doublon de la première : elle est **incluse** dedans,
# mais son seuil est bas parce que son compteur, lui, ne bouge pas dans le trafic
# nominal. Un pic de limitation de débit noyé sous le bruit de fond des scanners
# ne franchirait jamais le seuil de la première.

locals {
  # `Region` n'a de sens que pour une Web ACL régionale : les métriques d'une Web
  # ACL de portée CloudFront sont publiées dans us-east-1 sous une dimension
  # `Region` valant `Global`, que la région du provider ne donne pas.
  waf_alarm_dimensions = merge(
    { WebACL = aws_wafv2_web_acl.this.name },
    var.scope == "REGIONAL" ? { Region = data.aws_region.current.name } : { Region = "Global" },
  )
}

# --- 1. Salve de requêtes bloquées --------------------------------------------

resource "aws_cloudwatch_metric_alarm" "blocked_requests" {
  alarm_name        = "${local.web_acl_name}-blocked-requests"
  alarm_description = "Plus de ${var.blocked_requests_alarm_threshold} requetes bloquees par ${local.web_acl_name} sur ${var.alarm_period_seconds} s. Deux lectures possibles, et il faut trancher entre les deux avant d'agir : une attaque en cours, ou une regle managee qui vient de couper un parcours legitime. Le groupe de journaux aws-waf-logs-${local.name_prefix} nomme la regle en cause."

  namespace   = "AWS/WAFV2"
  metric_name = "BlockedRequests"

  # `Rule = ALL` agrège toutes les règles de la Web ACL. C'est la valeur que WAF
  # publie lui-même pour le total ; elle n'a rien d'un caractère générique.
  dimensions = merge(local.waf_alarm_dimensions, { Rule = "ALL" })

  statistic           = "Sum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = var.blocked_requests_alarm_threshold
  comparison_operator = "GreaterThanThreshold"

  # WAF ne publie pas de point sur une période sans requête bloquée. Sans cette
  # valeur, l'alarme passerait l'essentiel de son temps en `INSUFFICIENT_DATA` —
  # ni verte ni rouge, donc ignorée.
  treat_missing_data = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.web_acl_name}-blocked-requests"
  }
}

# --- 2. Limitation de débit atteinte ------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rate_limited" {
  alarm_name        = "${local.web_acl_name}-rate-limited"
  alarm_description = "Une ou plusieurs adresses IP ont depasse ${var.rate_limit} requetes sur cinq minutes et sont bloquees par la regle ${local.rate_limit_rule_name}. Dans le trafic nominal d'une reservation, ce compteur reste a zero."

  namespace   = "AWS/WAFV2"
  metric_name = "BlockedRequests"
  dimensions  = merge(local.waf_alarm_dimensions, { Rule = local.rate_limit_rule_name })

  statistic           = "Sum"
  period              = var.alarm_period_seconds
  evaluation_periods  = 1
  threshold           = var.rate_limit_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.web_acl_name}-rate-limited"
  }
}
