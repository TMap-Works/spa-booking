data "aws_region" "current" {}

locals {
  name_prefix = "spa-${var.environment}"

  web_acl_name = "${local.name_prefix}-waf"

  # Les `metric_name` de `visibility_config` ne sont pas décoratifs : ce sont eux,
  # et non les noms de ressource, que WAF publie comme **valeurs des dimensions
  # CloudWatch** `WebACL` et `Rule`. Les faire diverger du nom de la règle rendrait
  # muettes les alarmes d'`alarms.tf`, qui nomment ces dimensions — une alarme qui
  # ne sonne jamais ressemble en tout point à une plateforme calme.
  #
  # Ils sont donc tenus **identiques** aux noms de ressource, ce que le jeu de
  # caractères admis par WAF — lettres, chiffres, tiret et souligné, 128 au plus —
  # autorise pour chacun d'eux : `spa-{env}-waf`, `limitation-de-debit` et les noms
  # de groupes managés y passent tels quels.

  # --- Les groupes de règles managés AWS ---------------------------------------
  #
  # Le CDC §4.10 demande une protection « contre les attaques applicatives
  # (injections, XSS, bots) ». Chacun de ces trois mots correspond à un groupe
  # précis, et l'ordre des priorités n'est pas neutre : WAF évalue par priorité
  # croissante et s'arrête au premier `block`. On veut donc que le moins cher à
  # évaluer — la réputation d'adresse IP, une simple appartenance à une liste —
  # tranche avant l'inspection du corps de la requête.
  #
  # `count_only` ne désarme pas la règle : elle continue de s'évaluer et de
  # compter, sans bloquer. C'est le mode dans lequel un groupe doit vivre le temps
  # d'observer ce qu'il aurait bloqué. Un WAF posé d'emblée en blocage sur un
  # parcours de réservation coupe des clientes réelles, et personne ne le
  # découvre avant le premier appel au support.
  managed_rule_groups = merge(
    {
      # Liste de réputation AWS : adresses associées à des bots, des scanners et
      # des relais compromis. Évaluée en premier — c'est la moins coûteuse.
      reputation_ip = {
        name           = "AWSManagedRulesAmazonIpReputationList"
        priority       = 10
        count_only     = contains(var.count_only_rule_groups, "AWSManagedRulesAmazonIpReputationList")
        counted_rules  = lookup(var.counted_rules, "AWSManagedRulesAmazonIpReputationList", [])
        bot_inspection = null
      }

      # Entrées connues pour faire tomber une application : chemins de traversée,
      # en-têtes malformés, charges d'exploitation publiées.
      known_bad_inputs = {
        name           = "AWSManagedRulesKnownBadInputsRuleSet"
        priority       = 20
        count_only     = contains(var.count_only_rule_groups, "AWSManagedRulesKnownBadInputsRuleSet")
        counted_rules  = lookup(var.counted_rules, "AWSManagedRulesKnownBadInputsRuleSet", [])
        bot_inspection = null
      }

      # Injection SQL. Le module `appointments` interroge PostgreSQL par Prisma,
      # donc en requêtes paramétrées : ce groupe n'est pas la barrière principale,
      # il est la seconde. Les deux se justifient — une injection ne passe pas par
      # l'ORM le jour où quelqu'un écrit un `$queryRaw`.
      sqli = {
        name           = "AWSManagedRulesSQLiRuleSet"
        priority       = 30
        count_only     = contains(var.count_only_rule_groups, "AWSManagedRulesSQLiRuleSet")
        counted_rules  = lookup(var.counted_rules, "AWSManagedRulesSQLiRuleSet", [])
        bot_inspection = null
      }

      # Le jeu de base : XSS, inclusion de fichier local, agents utilisateurs
      # absents, tailles de requête aberrantes. Évalué en dernier parmi les
      # gratuits parce que c'est celui qui inspecte le plus.
      common = {
        name           = "AWSManagedRulesCommonRuleSet"
        priority       = 40
        count_only     = contains(var.count_only_rule_groups, "AWSManagedRulesCommonRuleSet")
        counted_rules  = lookup(var.counted_rules, "AWSManagedRulesCommonRuleSet", [])
        bot_inspection = null
      }
    },

    # Bot Control est le seul groupe **facturé** de la liste — environ 10 USD par
    # mois et par Web ACL, plus l'analyse au million de requêtes (skill aws-infra
    # §9). Il est donc optionnel, et c'est aussi le seul qui distingue un robot
    # d'indexation légitime d'un racleur de créneaux.
    var.bot_control_inspection_level == null ? {} : {
      bot_control = {
        name           = "AWSManagedRulesBotControlRuleSet"
        priority       = 50
        count_only     = contains(var.count_only_rule_groups, "AWSManagedRulesBotControlRuleSet")
        counted_rules  = lookup(var.counted_rules, "AWSManagedRulesBotControlRuleSet", [])
        bot_inspection = var.bot_control_inspection_level
      }
    },
  )

  # Nom de la règle de limitation de débit. Repris tel quel comme `metric_name`,
  # donc comme valeur de la dimension CloudWatch `Rule` : c'est ce qui permet à
  # l'alarme de distinguer « on nous inonde » de « le WAF a bloqué une injection ».
  rate_limit_rule_name = "limitation-de-debit"

  # Clé du corps de réponse personnalisé servi à qui dépasse le débit. WAF
  # n'accepte ici que `[\w\-]{1,128}`.
  rate_limit_body_key = "trop-de-requetes"
}
