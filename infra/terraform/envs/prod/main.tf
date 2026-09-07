# Environnement production — composition de modules.
#
# Un environnement ne déclare aucune ressource en propre : il compose des modules
# et leur fournit les valeurs. L'état vit dans le bucket créé par ../../bootstrap
# (voir backend.tf), verrouillé par sa table DynamoDB.

locals {
  environment = "prod"

  # Rétention des journaux CloudWatch de l'environnement : 90 jours en production
  # (skill aws-infra §8). Trois mois, parce qu'un incident se rejoue rarement le
  # jour où on le comprend — et pas davantage, parce que CloudWatch facture le
  # stockage indéfiniment quand personne ne fixe de terme.
  #
  # Aucun module composé ici ne crée encore de groupe de journaux — `network` n'en
  # produit pas. La valeur est posée maintenant, et exposée en sortie pour être
  # vérifiable, parce que c'est le contrat que devront recevoir `database`,
  # `cache` et `ecs-service` le jour où cet environnement les composera, comme le
  # fait déjà `envs/dev`.
  log_retention_days = 90
}

# --- Maîtrise budgétaire ------------------------------------------------------

module "budgets" {
  source = "../../modules/budgets"

  environment = local.environment

  # Haut de la fourchette du CDC §4.16 — 430 à 800 USD par mois pour la
  # production. Le plafond se pose au sommet de la fourchette et non à son
  # milieu : à 430, l'alerte à 80 % se déclencherait dans le fonctionnement
  # nominal prévu, et une alerte qui se déclenche en régime normal cesse d'être
  # lue. À 800, le seuil de 80 % tombe à 640 — au-dessus de la fourchette, donc
  # sur une vraie dérive.
  monthly_limit = 800

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
  vpc_cidr = "10.30.0.0/16"

  # Deux NAT Gateway, une par zone : avec une seule, la perte de sa zone
  # couperait la sortie Internet des deux zones applicatives — donc Stripe, SES
  # et SNS. C'est le poste de coût qu'on accepte de doubler, et le seul.
  nat_gateway_count = 2
}

# --- Délivrabilité e-mail -----------------------------------------------------

# C'est ici que le risque du CDC §6 se joue : les rappels J-1 de production
# partent de ce domaine, et un rappel classé en indésirable ne réduit aucun
# no-show. Le module reste inerte tant qu'aucun domaine n'est fourni — une
# identité SES est unique par compte et par région, un défaut en dur ferait
# vérifier le même nom depuis les trois états d'environnement — mais la
# production, elle, ne peut pas rester sans : `notification_domain` doit être
# posé avant le go-live (#83), et la sortie du bac à sable SES demandée bien
# avant, le délai AWS n'étant pas instantané. Procédure dans le README du module.
module "notifications" {
  count  = var.notification_domain == null ? 0 : 1
  source = "../../modules/notifications"

  environment = local.environment
  domain      = var.notification_domain

  # Renseigné, le module publie DKIM, SPF et DMARC lui-même. Sinon il expose la
  # liste exacte à publier chez le registraire — sortie `notification_dns_records`.
  route53_zone_id = var.notification_route53_zone_id

  # Sans destinataire de rapports, une politique DMARC `none` — celle du module
  # par défaut — n'apprend rien à personne. En production, c'est aussi la seule
  # source qui dira quand la politique peut passer à `quarantine` puis `reject` :
  # renseigner cette adresse est le premier pas du resserrement, pas une option.
  dmarc_report_uri = var.notification_dmarc_report_uri

  # --- Chaîne d'envoi : file, Lambda, DLQ, alarmes (#67) ---

  # 90 jours en production, contre 30 ailleurs : un rappel non parti se découvre
  # parfois par la réclamation d'une cliente, des semaines après.
  log_retention_days = local.log_retention_days

  # Le topic du module `budgets`, dont l'en-tête prévoit que les alarmes
  # d'observabilité s'y branchent plutôt que d'en créer un second. En production,
  # c'est la seule chose qui transforme les quatre alarmes de la chaîne en
  # supervision plutôt qu'en tableau qu'il faut penser à ouvrir.
  alarm_topic_arns = [module.budgets.alerts_topic_arn]

  # À poser avant le go-live (#83), en même temps que le domaine : sans route
  # d'envoi, la Lambda est en défaut fermé et aucun message ne part — la sortie
  # `notification_dispatch_configured` le dit, et elle fait partie de la liste de
  # vérification de la mise en production.
  dispatch_url              = var.notification_dispatch_url
  dispatch_token_secret_arn = var.notification_dispatch_token_secret_arn

  # --- Canal SMS (#66) ---

  # C'est ici, et **seulement ici**, que les préférences SMS d'SNS se posent.
  # `aws_sns_sms_preferences` n'a pas de nom : il y en a un par compte et par
  # région, et les trois environnements partagent le compte. Deux environnements
  # à vrai s'écraseraient tour à tour sans qu'aucun plan ne montre de conflit —
  # le plafond de la production pourrait finir par être celui du développement.
  #
  # Le corollaire tient en une phrase : le réglage posé ici vaut pour dev et
  # staging aussi. C'est voulu — la dépense SMS est celle du compte, et un essai
  # d'envoi en recette la consomme au même titre qu'un rappel réel.
  manage_sms_account_preferences = true

  # Le CDC §4.16 sort le SMS de l'estimation budgétaire — « très variable selon
  # le pays et le volume ». Ce plafond est ce qui borne l'inconnue, et c'est un
  # arrêt dur : au plafond, SNS cesse d'envoyer et les rappels J-1 s'arrêtent sans
  # erreur applicative. L'alarme à 80 % existe pour qu'on l'apprenne avant.
  #
  # Le quota du compte le plafonne, et il vaut 1 USD sur un compte neuf : la
  # demande de relèvement se fait auprès du support AWS, tôt (#83).
  sms_monthly_spend_limit_usd = var.notification_sms_monthly_spend_limit_usd

  # Nul tant qu'aucun expéditeur n'est arrêté. Le poser ne l'enregistre nulle
  # part : la sortie `notification_sms_sender_id_registration` dit ce qui reste à
  # faire pays par pays, et aucun fournisseur Terraform n'expose de ressource pour
  # cette démarche.
  sms_sender_id = var.notification_sms_sender_id
}

# --- Observabilité ------------------------------------------------------------

# `../../modules/observability` n'est pas composé ici, et c'est temporaire : les
# cinq alarmes qu'il pose — 5xx de l'ALB, latence p99, CPU des services,
# connexions et espace disque de la base — décrivent des ressources que cet
# environnement ne crée pas encore. Le composer aujourd'hui produirait un tableau
# de bord vide et pas une alarme.
#
# Il se compose en même temps que `ecs-service` et `database`, comme le fait déjà
# `envs/dev` : c'est un **prérequis de go-live** du CDC §4.11, pas une amélioration
# à programmer ensuite. Une plateforme mise en production sans ces alarmes
# apprend ses pannes par ses clientes.
#
# Le traçage X-Ray suit le même chemin : `xray_tracing_enabled` sur le service
# `api` du module `ecs-service`, et la règle d'échantillonnage vient avec le
# module. Voir infra/terraform/modules/observability/README.md.
