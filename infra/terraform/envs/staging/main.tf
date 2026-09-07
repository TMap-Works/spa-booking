# Environnement recette — composition de modules.
#
# Un environnement ne déclare aucune ressource en propre : il compose des modules
# et leur fournit les valeurs. L'état vit dans le bucket créé par ../../bootstrap
# (voir backend.tf), verrouillé par sa table DynamoDB.

locals {
  environment = "staging"

  # Rétention des journaux CloudWatch de l'environnement : 30 jours hors
  # production, 90 en production (skill aws-infra §8). Sans rétention explicite,
  # CloudWatch conserve indéfiniment et la facture monte sans bruit.
  #
  # Aucun module composé ici ne crée encore de groupe de journaux — `network` n'en
  # produit pas. La valeur est posée maintenant, et exposée en sortie pour être
  # vérifiable, parce que c'est le contrat que devront recevoir `database`,
  # `cache` et `ecs-service` le jour où cet environnement les composera, comme le
  # fait déjà `envs/dev`.
  log_retention_days = 30
}

# --- Maîtrise budgétaire ------------------------------------------------------

module "budgets" {
  source = "../../modules/budgets"

  environment = local.environment

  # Même plafond qu'en développement : la recette a vocation à reproduire la
  # forme de la production, pas son dimensionnement — et elle ne compose encore
  # que son réseau. Le plafond décrit donc l'environnement complet à venir, pas
  # la poignée de ressources d'aujourd'hui : c'est ce qui évite d'avoir à le
  # relever — et à réapprendre à ignorer l'alerte — à chaque module ajouté.
  monthly_limit = 250

  alert_emails = var.budget_alert_emails

  # Le filtre d'étiquette de ce budget suppose que `Environment` soit activée
  # comme étiquette de répartition de coûts. Cette activation vaut pour le compte
  # entier et n'est donc pas déclarée ici : elle est portée par
  # ../../bootstrap, le seul état à cette portée. Renseignée par un
  # environnement, elle ferait gagner le dernier `apply` en écrasant les deux
  # autres.
}

module "network" {
  source = "../../modules/network"

  environment = local.environment

  # Zones figées plutôt que déduites de l'API. `data.aws_availability_zones`
  # filtre sur l'état « available » : une zone déclarée dégradée pendant un
  # incident — ou une zone nouvellement ouverte au compte, qui se trierait avant
  # les autres — décalerait le rang de tous les sous-réseaux et ferait planifier
  # la destruction puis la recréation des six, donc de RDS, d'ElastiCache et du
  # service ECS avec eux. Ces noms doivent rester cohérents avec `aws_region` :
  # un écart fait échouer l'`apply`, ce qui est exactement le bon échec.
  availability_zones = ["eu-west-3a", "eu-west-3b"]

  # Plage disjointe des autres environnements : un appairage ou une passerelle de
  # transit reste possible sans renumérotation.
  vpc_cidr = "10.20.0.0/16"

  # Une seule NAT Gateway, comme en développement : la recette valide un
  # comportement applicatif, pas une tolérance de panne d'infrastructure — ce
  # qui se vérifie, lui, en production.
  nat_gateway_count = 1
}

# --- Délivrabilité e-mail -----------------------------------------------------

# Rien tant qu'aucun domaine d'envoi n'est fourni. Ce n'est pas de la prudence
# gratuite : une identité de domaine SES est unique par compte et par région, et
# un défaut en dur ferait vérifier le même nom depuis les trois états
# d'environnement. La recette prend son propre sous-domaine —
# `-var notification_domain=staging.mail.<domaine>` — pour que ses envois
# d'essai n'entament pas la réputation du domaine de production.
module "notifications" {
  count  = var.notification_domain == null ? 0 : 1
  source = "../../modules/notifications"

  environment = local.environment
  domain      = var.notification_domain

  # Renseigné, le module publie DKIM, SPF et DMARC lui-même. Sinon il expose la
  # liste exacte à publier chez le registraire — sortie `notification_dns_records`.
  route53_zone_id = var.notification_route53_zone_id

  # Sans destinataire de rapports, une politique DMARC `none` — celle du module
  # par défaut — n'apprend rien à personne : elle n'existe que pour faire remonter
  # qui écrit au nom du domaine.
  dmarc_report_uri = var.notification_dmarc_report_uri

  # --- Chaîne d'envoi : file, Lambda, DLQ, alarmes (#67) ---

  # Le premier groupe de journaux CloudWatch que cet environnement crée : la
  # valeur posée plus haut cesse d'être une simple intention.
  log_retention_days = local.log_retention_days

  # Le topic du module `budgets`, dont l'en-tête prévoit que les alarmes
  # d'observabilité s'y branchent plutôt que d'en créer un second.
  alarm_topic_arns = [module.budgets.alerts_topic_arn]

  # Nulles tant que la route d'envoi n'existe pas : la Lambda reste alors en
  # défaut fermé, ce que dit la sortie `notification_dispatch_configured`. C'est
  # sur cet environnement que la chaîne se branche en premier — la recette est
  # faite pour cela.
  dispatch_url              = var.notification_dispatch_url
  dispatch_token_secret_arn = var.notification_dispatch_token_secret_arn

  # --- Rappel J-1 : balayage horaire (#71) ---
  #
  # Le planning EventBridge Scheduler existe dans tous les cas ; il reste
  # désactivé tant que cette URL est nulle. Les deux fonctions de la chaîne
  # présentent le même jeton à la même API — un seul secret, une seule
  # frontière de confiance, une seule rotation.
  reminder_sweep_url = var.notification_reminder_sweep_url

  # --- Rebonds et plaintes (#73) ---
  #
  # La file, la Lambda de relais et leurs deux alarmes existent dès que le module
  # est composé ; seule la destination manque. Nulle, la fonction est en défaut
  # fermé — elle rend chaque événement à SQS plutôt que de l'acquitter, la DLQ se
  # remplit et son alarme parle. Ce que la sortie
  # `notification_delivery_events_configured` dit sans avoir à chercher.
  #
  # C'est ici que la chaîne se prouve avant la production : la recette est le
  # seul endroit où l'on peut faire rebondir une adresse pour de vrai — la boîte
  # à rebonds d'SES, `bounce@simulator.amazonses.com` — sans toucher une vraie
  # cliente. Même jeton que les deux autres fonctions de la chaîne.
  delivery_events_url = var.notification_delivery_events_url

  # --- Canal SMS (#66) ---

  # `manage_sms_account_preferences` reste au défaut — faux, comme en
  # développement et pour la même raison : le réglage SMS d'SNS est unique par
  # compte et par région, et la production le détient. La recette en hérite,
  # plafond compris, ce qui est le comportement voulu — un essai d'envoi en
  # recette consomme le même budget que la production, et doit donc être borné
  # par le même plafond.
}

# --- Observabilité ------------------------------------------------------------

# `../../modules/observability` n'est pas composé ici : ses alarmes décrivent un
# ALB, des services ECS et une base que cet environnement ne crée pas encore. Il
# se composera en même temps qu'eux, comme le fait déjà `envs/dev` — et avant la
# production, la recette étant l'endroit où l'on découvre qu'une alarme se
# déclenche en fonctionnement nominal.
#
# Voir infra/terraform/modules/observability/README.md.

# --- Sauvegarde et reprise d'activité (#82) -----------------------------------

# `../../modules/backup` n'est pas composé ici : il n'y a pas encore de base à
# protéger dans cet environnement. Le bloc arrive avec `module "database"`, dans
# le même `apply` — un coffre sans sélection ne sauvegarde rien tout en ayant
# l'air en place.
#
#   module "backup" {
#     source = "../../modules/backup"
#
#     environment          = local.environment
#     resource_arns        = [module.database.instance_arn]
#     restore_kms_key_arns = [module.database.kms_key_arn]
#
#     # Rétentions de recette : la forme de la production — les quatre cadences —
#     # à une échelle qui ne se paie pas au gibioctet-mois pendant un an. C'est
#     # ici que le runbook de restauration se répète avant d'être joué en
#     # production, et pour cela deux semaines de points suffisent.
#     continuous_backup_retention_days = 14
#     daily_retention_days             = 14
#     weekly_retention_days            = 35
#     monthly_retention_days           = 0
#
#     alarm_topic_arns = [module.budgets.alerts_topic_arn]
#   }
#
# La recette est l'environnement où la procédure se répète : elle porte de vraies
# données de recette, et elle n'a pas de client au bout. Voir
# docs/runbooks/pra-restauration-rds.md.
