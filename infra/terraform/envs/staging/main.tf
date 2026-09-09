# Environnement recette — composition de modules.
#
# Un environnement ne déclare presque aucune ressource en propre : il compose des
# modules et leur fournit les valeurs. L'état vit dans le bucket créé par
# ../../bootstrap (voir backend.tf), verrouillé par sa table DynamoDB.
#
# Les trois ressources déclarées ici — le conteneur du secret d'exécution, le
# certificat de terminaison TLS et la définition de tâche de migration — sont de
# la colle d'environnement : elles n'existent qu'une fois par environnement et
# n'ont pas encore de module, exactement comme dans `envs/dev`.
#
# ## Ce que « proche de la production à échelle réduite » veut dire ici (CDC §4.13)
#
# La **forme** est celle de la production : les mêmes onze modules, la même
# chaîne de trafic, les mêmes alarmes, le même WAF, le même coffre de sauvegarde.
# L'**échelle** ne l'est pas : une seule NAT Gateway, une base mono-AZ, aucun
# réplica de cache, une tâche par service au lieu de deux à huit, et un arrêt
# programmé hors heures ouvrées. C'est ce qui tient sous le plafond budgétaire
# posé plus bas.

locals {
  environment = "staging"

  # Rétention des journaux CloudWatch de l'environnement : 30 jours hors
  # production, 90 en production (skill aws-infra §8). Sans rétention explicite,
  # CloudWatch conserve indéfiniment et la facture monte sans bruit.
  #
  # Passée explicitement à chacun des modules qui créent un groupe de journaux
  # plutôt que laissée à leur défaut, et exposée en sortie pour être vérifiable.
  log_retention_days = 30

  # Image tirée par le service ECS et par la tâche de migration. L'étiquette est
  # le sha du commit déployé : les dépôts du module `ecr` sont **immuables**, une
  # étiquette mobile du genre `:staging` ne pourrait donc être poussée qu'une
  # fois. C'est aussi ce qui fait que le déploiement passe par un
  # `terraform apply -var image_tag=<sha>` — la définition de tâche appartient à
  # l'état, et rien d'autre ne peut la faire pointer sur la nouvelle image.
  api_image = "${module.ecr.repository_urls["api"]}:${var.image_tag}"

  # Même étiquette pour les deux images : `deploy-staging.yml` construit et pousse
  # `spa-staging-api:<sha>` et `spa-staging-web:<sha>` dans le même job, depuis le
  # même commit. Deux `image_tag` distincts laisseraient le front et l'API diverger
  # sans que rien ne le dise, alors qu'ils partagent les contrats de
  # `packages/shared`.
  web_image = "${module.ecr.repository_urls["web"]}:${var.image_tag}"

  # Certificat porté par le listener 443. À défaut d'ARN fourni, l'environnement
  # en fabrique un lui-même — voir le bloc « Terminaison TLS » plus bas, et la
  # réserve qui l'accompagne : un certificat auto-signé rend la recette de bout en
  # bout inexécutable.
  certificate_arn = var.certificate_arn != null ? var.certificate_arn : one(aws_acm_certificate.alb[*].arn)

  # Nombre maximal de connexions accepté par le moteur, dont l'alarme de
  # saturation surveille les 80 %. Il se dit ici parce qu'il ne se déduit de
  # rien : RDS le calcule par `LEAST({DBInstanceClassMemory/9531392}, 5000)` et
  # ne le publie sous aucune métrique. Sur le `db.t4g.medium` par défaut du
  # module `database` — 4 Gio —, cela fait 4 294 967 296 / 9 531 392 ≈ 450.
  #
  # **Changer `instance_class` oblige à revoir cette valeur** : le seuil de
  # l'alarme cesserait sinon de valoir 80 %. La sortie `instance_class` du module
  # `database` dit ce qui est réellement provisionné.
  rds_max_connections = 450

  # Ce que l'API doit connaître de la chaîne de notifications, et le droit d'y
  # publier. Les deux sont vides tant que `notification_domain` n'est pas fourni,
  # le module n'étant alors pas composé.
  #
  # Splat sur le module plutôt qu'un index : `count` peut valoir zéro, et
  # `module.notifications[0]` ferait alors échouer l'évaluation au lieu de rendre
  # une liste vide. La compréhension à clé constante produit une map d'une entrée
  # ou d'aucune, jamais de doublon.
  notification_queue_env = { for url in module.notifications[*].dispatch_queue_url : "NOTIFICATION_QUEUE_URL" => url }

  # Les deux politiques que le rôle de tâche de l'API réclame de la chaîne de
  # notifications : publier sur la file, et émettre un SMS. Concaténées ici plutôt
  # qu'à l'appel — les deux listes sont vides ou pleines ensemble, et le `count`
  # du module est leur seule condition d'existence.
  notification_api_policy_arns = concat(
    module.notifications[*].dispatch_producer_policy_arn,
    module.notifications[*].sms_publisher_policy_arn,
  )

  # Vrai dès qu'une des routes **internes** de la chaîne a une destination. Les
  # trois fonctions Lambda présentent le même jeton dans `x-internal-token` : il
  # suffit qu'une seule soit branchée pour que la clé
  # `NOTIFICATIONS_INTERNAL_TOKEN` doive être résolue dans la définition de
  # tâche — voir le commentaire de `secret_arns`, plus bas.
  notification_internal_route_wired = anytrue([
    var.notification_dispatch_url != null,
    var.notification_reminder_sweep_url != null,
    var.notification_delivery_events_url != null,
  ])
}

data "aws_region" "current" {}

# --- Maîtrise budgétaire ------------------------------------------------------

module "budgets" {
  source = "../../modules/budgets"

  environment = local.environment

  # Ordre de grandeur du coût nominal de cet environnement, en USD par mois :
  # quatre endpoints d'interface sur deux zones (~58), RDS `db.t4g.medium`
  # mono-AZ et son stockage (~55), une NAT Gateway (~32), l'ALB (~21),
  # ElastiCache `cache.t4g.micro` (~12), le WAF sans Bot Control (~9), Container
  # Insights (~5), le coffre de sauvegarde, les journaux, les clés KMS et le
  # stockage ECR pour le reste (~9) — et **deux** tâches Fargate 0,5 vCPU dont
  # l'arrêt hors heures ouvrées ne laisse tourner qu'un peu moins de 40 % du
  # temps (~14). Soit ~215.
  #
  # **Relevé de 250 à 300 par #76**, quand cet environnement est passé de trois
  # modules composés à onze. Le plafond de 250 avait été posé pour décrire
  # « l'environnement complet à venir » plutôt que la poignée de ressources du
  # jour — l'intention était la bonne, l'estimation était courte : elle supposait
  # une base d'un cran plus petite, que le module `database` refuse (voir
  # `module "database"`).
  #
  # Le seuil d'alerte est à 80 % du plafond. À 250, il valait 200 — sous le coût
  # nominal, donc une alerte qui sonne en permanence, c'est-à-dire une alerte
  # qu'on apprend à ne plus regarder. À 300 il vaut 240, ce qui laisse la marge
  # d'une campagne de recette sans laisser passer une dérive. C'est le même
  # raisonnement, et la même valeur, que `envs/dev` (#345).
  #
  # **Ce qui mange la marge**, et qu'il faut savoir avant de la consommer : lever
  # durablement `off_hours_shutdown` rend ~22 USD à la facture Fargate et porte le
  # nominal à ~237, à un cheveu du seuil.
  monthly_limit = 300

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

  # Rétention des flow logs du VPC — trente jours, comme en développement. La
  # recette reproduit la forme de la production, pas sa profondeur d'archive.
  log_retention_days = local.log_retention_days
}

# --- Registre d'images --------------------------------------------------------

module "ecr" {
  source = "../../modules/ecr"

  environment  = local.environment
  applications = ["api", "web"]

  # `force_delete` reste au défaut — faux. C'est la différence avec `envs/dev` :
  # un environnement de recette ne se détruit pas entre deux commits, et le
  # garde-fou qui refuse d'emporter un dépôt encore plein a ici tout son sens.
  # Vider les dépôts avant un `destroy` volontaire est un geste de plus ; c'est
  # exactement le geste qu'on veut voir posé consciemment.

  # Entre les dix de `envs/dev` et les trente du défaut : la recette revient en
  # arrière — c'est même une partie de son métier, comparer un comportement au
  # déploiement précédent — mais pas sur un mois de merges.
  max_tagged_images = 20
}

# --- Niveau données -----------------------------------------------------------

module "database" {
  source = "../../modules/database"

  environment = local.environment
  vpc_id      = module.network.vpc_id
  subnet_ids  = module.network.data_subnet_ids

  # Seules les tâches Fargate joignent PostgreSQL, et par identifiant de groupe —
  # jamais par bloc CIDR (skill aws-infra §4). Le module `ecs-service` déclare la
  # sortie correspondante de son côté : aucun des deux ne dépend de l'autre.
  allowed_security_group_ids = {
    ecs_tasks = module.ecs_service.tasks_security_group_id
  }

  # `instance_class` reste au défaut du module — `db.t4g.medium`, la même classe
  # qu'en développement et qu'en production. Un cran plus bas aurait allégé la
  # facture d'une vingtaine de dollars, et le jeu de données de recette
  # (`apps/api/prisma/seed.ts`) y tiendrait sans transpirer : le module le
  # **refuse**, RDS ne proposant Performance Insights ni sur `micro` ni sur
  # `small`, et le module l'activant en dur. C'est un arbitrage assumé du module,
  # pas un oubli ici — diagnostiquer une requête lente sans Performance Insights
  # coûte des heures (skill aws-infra §6), et la recette est justement l'endroit
  # où l'on découvre les requêtes lentes.
  #
  # C'est cette contrainte, et elle seule, qui fait que le plafond budgétaire de
  # cet environnement a dû passer de 250 à 300 — voir `module "budgets"`.

  # Résilience de recette : pas de bascule inter-zone. Une panne de zone se
  # vérifie en production, où la Multi-AZ est exigée par le CDC §4.5 et par une
  # précondition du module.
  multi_az = false

  # Contrairement au développement, la suppression **laisse un instantané final**
  # et la base porte de vraies données de recette : les deux valeurs par défaut du
  # module conviennent, et elles sont écrites ici parce qu'elles décrivent une
  # décision, pas un oubli.
  deletion_protection = false
  skip_final_snapshot = false

  # Quatorze jours, contre sept par défaut : c'est la rétention que reprennent les
  # règles quotidienne et continue du coffre `backup` plus bas, et deux politiques
  # de rétention qui divergeraient sur le même moteur seraient une source de
  # confusion permanente le jour d'une restauration.
  backup_retention_period = 14

  # `apply_immediately` reste au défaut — faux, comme en production. C'est une
  # différence délibérée avec `envs/dev` : la recette est l'endroit où l'on
  # découvre qu'un changement de paramètre attend la fenêtre de maintenance, et
  # une bascule de nœud provoquée en pleine campagne de recette fausserait
  # précisément ce qu'on est en train de mesurer.

  # Rétention des journaux PostgreSQL exportés vers CloudWatch, même contrat que
  # pour les autres groupes de journaux de l'environnement.
  log_retention_days = local.log_retention_days
}

module "cache" {
  source = "../../modules/cache"

  environment = local.environment
  vpc_id      = module.network.vpc_id
  subnet_ids  = module.network.data_subnet_ids

  allowed_security_group_ids = {
    ecs_tasks = module.ecs_service.tasks_security_group_id
  }

  # Une seule clé pour tout le niveau données, comme les deux modules le
  # recommandent : c'est celle du module `database`, qui la crée. Les groupes de
  # journaux du cache, eux, ne la portent pas — CloudWatch Logs exigerait alors
  # que la politique de clé nomme `logs.{région}.amazonaws.com`, ce que la
  # politique par défaut ne fait pas.
  kms_key_arn = module.database.kms_key_arn

  # Ni réplica ni Multi-AZ : sur un environnement de recette, l'indisponibilité
  # du cache dégrade sans interrompre, et le doublement du coût ne se justifie
  # qu'en production — où deux préconditions du module l'imposent.
  replica_count = 0
  multi_az      = false

  # Sept jours, entre les zéro de `envs/dev` et les trente du défaut : un
  # environnement de recette se recrée plus rarement qu'un environnement de
  # développement, mais attendre un mois qu'un nom de secret se libère après un
  # `destroy` reste hors de question.
  secret_recovery_window_in_days = 7

  # Rétention des journaux Redis exportés vers CloudWatch, même contrat que pour
  # PostgreSQL et pour le service ECS.
  log_retention_days = local.log_retention_days
}

# --- Sauvegarde et reprise d'activité (#82) -----------------------------------

# La politique de rétention unifiée du CDC §4.14, en plus des sauvegardes
# automatiques que le module `database` configure de son côté. La recette est
# l'environnement où la procédure se répète : elle porte de vraies données de
# recette, et elle n'a pas de cliente au bout
# (docs/runbooks/pra-restauration-rds.md).
module "backup" {
  source = "../../modules/backup"

  environment = local.environment

  # Désignée par ARN et non par étiquette : un plan qui ne protège plus rien se
  # voit alors en revue, au lieu de se découvrir le jour de la restauration. Une
  # sélection par `{ Environment = "staging" }` embarquerait au passage les
  # compartiments S3 de l'environnement — dont celui de l'état Terraform.
  resource_arns = [module.database.instance_arn]

  # La clé de l'instance source. Le coffre, lui, a la sienne : une sauvegarde
  # chiffrée par la clé de ce qu'elle sauvegarde ne survit pas à la perte de
  # cette clé. Sans cette ligne, le travail de sauvegarde ne peut pas lire le
  # volume chiffré — et la restauration vers cette clé échoue.
  restore_kms_key_arns = [module.database.kms_key_arn]

  # Rétentions de recette : la forme de la production — les quatre cadences —
  # à une échelle qui ne se paie pas au gibioctet-mois pendant un an. C'est
  # ici que le runbook de restauration se répète avant d'être joué en
  # production, et pour cela deux semaines de points suffisent. Le palier
  # mensuel, lui, ne sert que l'archive : un besoin que cet environnement n'a
  # pas.
  continuous_backup_retention_days = 14
  daily_retention_days             = 14
  weekly_retention_days            = 35
  monthly_retention_days           = 0

  # Faux — le défaut, et la différence assumée avec `envs/dev`. Conséquence à
  # connaître : un `terraform destroy` de cet environnement échouera tant que le
  # coffre contient des points de restauration, et il faudra les supprimer à la
  # main. C'est le prix d'un environnement qui porte les seules données de
  # recette qu'on ait, et le geste qu'on veut voir posé consciemment.
  force_destroy = false

  # Le topic du module `budgets`, comme pour les alarmes d'observabilité. Sans
  # lui, les quatre alarmes du coffre changent d'état sans prévenir personne —
  # et « aucune sauvegarde depuis vingt-quatre heures » est précisément le genre
  # de panne qu'on ne découvre pas en regardant une console.
  alarm_topic_arns = [module.budgets.alerts_topic_arn]

  # `vault_lock` reste nul. Le verrou de gouvernance est une décision de
  # production : posé ici, il interdirait de raccourcir une rétention sur
  # l'environnement dont c'est justement le métier d'essayer les réglages avant
  # la production.
}

# --- Export du reporting (#563) -----------------------------------------------

# Le bucket qui reçoit les exports CSV du back-office, et le droit pour l'API de
# les y déposer et de les signer. Aucune dépendance : il n'est branché ni au VPC,
# ni à la base — l'API l'atteint par l'endpoint S3 déjà présent dans le réseau.
module "reporting_export" {
  source = "../../modules/reporting-export"

  environment = local.environment

  # Sept jours — le défaut du module. La recette porte de vraies données de
  # recette, et un export s'y rouvre la semaine suivante.
  retention_days = 7

  # `kms_key_arn` laissé à `null` : chiffrement géré par S3. Une clé du compte se
  # justifie en production, où les exports portent le chiffre d'affaires réel ;
  # ici ils portent celui d'un jeu d'essai.
}

# --- Délivrabilité e-mail -----------------------------------------------------

# Rien tant qu'aucun domaine d'envoi n'est fourni. Ce n'est pas de la prudence
# gratuite : une identité de domaine SES est unique par compte et par région, et
# un défaut en dur ferait vérifier le même nom depuis les trois états
# d'environnement. La recette prend son propre sous-domaine —
# `notification_domain = "staging.mail.<domaine>"` — pour que ses envois d'essai
# n'entament pas la réputation du domaine de production.
#
# Dans le **`.tfvars`** de l'environnement, et reporté dans la variable de dépôt
# `STAGING_TFVARS` : `terraform` ne garde aucune trace d'un `-var` de ligne de
# commande, et l'`apply` du déploiement suivant ramènerait ce domaine à `null` —
# donc `count = 0`, donc la destruction de l'identité SES, de la file, de la DLQ
# et des trois Lambda. Voir docs/runbooks/recette-staging.md §1.4.
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

  # Même contrat de rétention que les autres groupes de journaux de
  # l'environnement, pour la même raison : celui que Lambda crée de lui-même
  # conserve indéfiniment.
  log_retention_days = local.log_retention_days

  # Le topic du module `budgets`, dont l'en-tête prévoit que les alarmes
  # d'observabilité s'y branchent plutôt que d'en créer un second.
  alarm_topic_arns = [module.budgets.alerts_topic_arn]

  # Nulles tant que la route d'envoi n'existe pas : la Lambda reste alors en
  # défaut fermé, ce que dit la sortie `notification_dispatch_configured`. C'est
  # sur cet environnement que la chaîne se branche en premier — la recette est
  # faite pour cela, et elle ne le pourra qu'une fois `certificate_arn` posé :
  # la fonction refuse de désactiver la vérification TLS, et le certificat
  # auto-signé de repli ne se vérifie pas.
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

# --- Configuration d'exécution de l'API ---------------------------------------

# Conteneur du secret, sans sa valeur (skill aws-infra §7) : Terraform crée le
# secret, un opérateur y dépose le JSON. Rien de sensible ne transite donc ni par
# le code, ni par l'état.
#
# Six clés, dont deux qui ne sont pas des secrets — `APP_URL` et `API_URL`. Elles
# sont là parce qu'elles valent l'URL publique de l'ALB, que seul le module
# `ecs-service` connaît : les passer en `environment` demanderait de lire une
# sortie de ce module pour construire une de ses entrées, ce qui est un cycle.
# Le README de `envs/dev` donne le JSON attendu et l'ordre des opérations ; il
# vaut mot pour mot ici.
#
# Chiffré par la clé gérée par AWS et non par une clé du compte, pour la raison
# décrite dans `envs/dev/main.tf` : le rôle d'exécution ECS n'obtient
# `kms:Decrypt` que si l'environnement passe une clé au module `ecs-service`,
# laquelle chiffrerait du même geste les groupes de journaux — ce que CloudWatch
# Logs refuse tant que la politique de la clé ne nomme pas
# `logs.{région}.amazonaws.com`.
#tfsec:ignore:aws-ssm-secret-use-customer-key
resource "aws_secretsmanager_secret" "api_runtime" {
  # `name_prefix` et non `name` : deux `apply` séparés par un `destroy` ne se
  # disputent pas le même nom.
  name_prefix = "spa-${local.environment}/api/runtime-"
  description = "Variables d'exécution de l'API ${local.environment} — valeur déposée hors Terraform."

  # Sept jours, comme le secret du jeton AUTH du cache et pour la même raison :
  # la recette se recrée plus rarement que le développement, mais un nom réservé
  # trente jours après un `destroy` bloquerait le `apply` suivant.
  recovery_window_in_days = 7

  tags = {
    Name = "spa-${local.environment}-api-runtime"
  }
}

# --- Terminaison TLS ----------------------------------------------------------

# Le module `ecs-service` exige un certificat : son listener 443 est le seul par
# lequel une requête applicative passe.
#
# **Cet environnement veut un vrai certificat ACM**, et c'est une différence de
# fond avec `envs/dev`. Le parcours que la recette doit exercer — réserver,
# confirmer, encaisser — passe par des appels que rien ne peut faire sur un
# certificat auto-signé :
#
#   * les Server Components du front rappellent l'API par l'ALB public, et
#     `fetch` refuse un certificat qui ne se vérifie pas ;
#   * les trois Lambda de la chaîne de notifications refusent, elles aussi, de
#     désactiver la vérification.
#
# Le repli auto-signé ci-dessous n'existe donc que pour que le **tout premier**
# `terraform apply` aboutisse avant qu'un nom de domaine n'existe : sans lui,
# l'environnement ne serait pas applicable du tout, et il n'y aurait rien sur
# quoi poser le certificat. La sortie `tls_certificate_is_self_signed` dit sans
# détour dans lequel des deux états on se trouve, et
# `docs/runbooks/recette-staging.md` en fait le premier prérequis de la campagne.
resource "tls_private_key" "alb" {
  count = var.certificate_arn == null ? 1 : 0

  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "alb" {
  count = var.certificate_arn == null ? 1 : 0

  private_key_pem = tls_private_key.alb[0].private_key_pem

  # Le nom DNS réel de l'ALB n'est pas connu avant sa création, et le mettre ici
  # serait de toute façon un cycle : le certificat est une entrée du module qui
  # crée l'ALB. Le nom porté est donc conventionnel — ce certificat n'est pas là
  # pour être vérifié, il est là pour que la terminaison TLS existe.
  subject {
    common_name  = "spa-${local.environment}.internal"
    organization = "TMap-Works"
  }

  validity_period_hours = 8760
  early_renewal_hours   = 720

  allowed_uses = [
    "digital_signature",
    "key_encipherment",
    "server_auth",
  ]
}

resource "aws_acm_certificate" "alb" {
  count = var.certificate_arn == null ? 1 : 0

  private_key      = tls_private_key.alb[0].private_key_pem
  certificate_body = tls_self_signed_cert.alb[0].cert_pem

  tags = {
    Name = "spa-${local.environment}-alb"
  }

  # Le listener 443 référence le certificat : il faut le remplaçant avant de
  # retirer le remplacé, sinon le renouvellement coupe l'écoute.
  lifecycle {
    create_before_destroy = true
  }
}

# --- Compute ------------------------------------------------------------------

module "ecs_service" {
  source = "../../modules/ecs-service"

  environment       = local.environment
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  app_subnet_ids    = module.network.app_subnet_ids
  certificate_arn   = local.certificate_arn

  log_retention_days = local.log_retention_days

  # Vrai ici, faux en développement : le module le réserve « à la production et à
  # staging, où le diagnostic vaut son prix ». C'est sur cet environnement qu'on
  # instruit une lenteur constatée pendant une campagne de recette, et les
  # métriques par tâche sont exactement ce qui manque quand on essaie de le faire
  # après coup.
  container_insights_enabled = true

  # Faux : cet environnement se détruit et se recrée entre deux campagnes de
  # recette, et une protection de suppression sur l'ALB transformerait chaque
  # `terraform destroy` en ménage manuel. `true` reste le réglage de la
  # production, où détruire l'ALB coupe le service et change son nom DNS.
  alb_deletion_protection = false

  # `null` : l'origine publique est déduite du nom DNS de l'ALB par le module.
  # À poser en même temps que `certificate_arn` — les deux décrivent le même
  # passage à un vrai domaine.
  public_base_url = var.public_base_url

  # Arrêt hors heures ouvrées (skill aws-infra §9, CDC §4.16) : les deux services
  # descendent à zéro tâche le soir et remontent le matin, le week-end restant
  # éteint de lui-même. C'est le seul poste de cet environnement qu'on sache
  # éteindre sans le démonter, et il vaut une vingtaine de dollars par mois.
  #
  # Ce que cela n'arrête pas : l'ALB, la base, le cache, les endpoints
  # d'interface et la NAT Gateway, qui continuent d'être facturés. Voir le README
  # du module pour la manière de lever l'arrêt le temps d'une campagne, et
  # `docs/runbooks/recette-staging.md` pour le moment où il faut le faire.
  off_hours_shutdown = var.off_hours_shutdown

  # Ouverture de la chaîne vers le niveau données. Le sens est délibéré : les
  # modules `database` et `cache` déclarent leur entrée depuis le groupe des
  # tâches, ce module déclare la sortie vers eux.
  task_egress_rules = {
    postgres = {
      description                  = "PostgreSQL vers RDS spa-staging-rds"
      port                         = 5432
      referenced_security_group_id = module.database.security_group_id
    }

    redis = {
      description                  = "Redis vers ElastiCache spa-staging-redis"
      port                         = 6379
      referenced_security_group_id = module.cache.security_group_id
    }
  }

  services = {
    api = {
      image                  = local.api_image
      ecr_repository_arn     = module.ecr.repository_arns["api"]
      listener_rule_priority = 100

      # `PORT=3001` dans l'image de l'API (apps/api/Dockerfile), et le groupe
      # cible équilibre sur ce port.
      container_port = 3001

      cpu    = 512
      memory = 1024

      # Une tâche au repos, deux au maximum. Le maximum n'est pas décoratif : à
      # `max_capacity = 1`, la politique de suivi de cible ne pourrait jamais
      # rien faire, et la recette ne dirait rien de la montée en charge que la
      # production, elle, pratiquera. Deux suffisent à prouver que le chemin
      # existe — l'ALB répartit, les deux tâches lisent la même base, la session
      # ne colle pas à une tâche.
      desired_count = 1
      min_capacity  = 1
      max_capacity  = 2

      # Même sidecar `aws-xray-daemon` qu'en développement : le chemin de collecte
      # doit exister sur l'environnement où l'on instruit une lenteur.
      xray_tracing_enabled = true

      # `/health` est servi hors préfixe `/api` et hors versionnement
      # (apps/api/src/bootstrap.ts) : il exécute `SELECT 1` sur PostgreSQL et
      # `PING` sur Redis, et répond 503 dès qu'une dépendance est tombée. C'est
      # ce qui fait retirer une tâche coupée de la base du groupe cible.
      health_check_path = "/health"
      path_patterns     = ["/health", "/api/*"]

      # `NODE_ENV` n'est pas repris ici : l'image le pose déjà à `production`, et
      # le contredire depuis la définition de tâche ferait diverger le
      # comportement de l'application de celui de l'image qu'on déploie ailleurs.
      #
      # `LOG_LEVEL` vaut `info` et non `debug` : la recette doit produire les
      # journaux de la production, sous peine de ne jamais découvrir qu'une trace
      # utile n'y figure pas.
      #
      # `NOTIFICATION_QUEUE_URL` s'y ajoute quand la chaîne est composée : c'est
      # la file sur laquelle l'API publie au lieu d'appeler SES depuis le chemin
      # de requête HTTP (CDC §4.8). Une URL de file n'est pas un secret — elle ne
      # donne aucun droit à qui la connaît sans la politique qui va avec.
      #
      # `REPORT_EXPORT_BUCKET` obéit à la même règle (#563), et `AWS_REGION`
      # n'est pas facultative : contrairement à Lambda, ECS ne pose **aucune**
      # variable de région dans le conteneur, et le SDK JS v3 échouerait sur
      # « Region is missing » au premier export.
      environment = merge(local.notification_queue_env, {
        LOG_LEVEL            = "info"
        PORT                 = "3001"
        AWS_REGION           = data.aws_region.current.name
        REPORT_EXPORT_BUCKET = module.reporting_export.bucket_name
      })

      # Le droit de publier sur cette file, et celui d'émettre un SMS — rien
      # d'autre. La première n'accorde pas `ReceiveMessage`, un producteur qui
      # pourrait dépiler pouvant faire disparaître un rappel ; la seconde
      # n'accorde aucun droit sur les réglages SMS du compte (#66).
      #
      # S'y ajoute le droit de déposer et de signer un export de reporting
      # (#563) : ni `ListBucket` — qui donnerait à l'API le droit d'énumérer les
      # exports de tous les établissements —, ni `DeleteObject` — c'est le cycle
      # de vie du bucket qui purge.
      task_role_policy_arns = concat(local.notification_api_policy_arns, [
        module.reporting_export.producer_policy_arn,
      ])

      # Résolus par l'agent ECS au démarrage, à partir des clés JSON du secret
      # d'exécution. Aucune valeur ne transite par l'état ni par la console ECS.
      secret_arns = merge(
        {
          API_URL            = "${aws_secretsmanager_secret.api_runtime.arn}:API_URL::"
          APP_URL            = "${aws_secretsmanager_secret.api_runtime.arn}:APP_URL::"
          DATABASE_URL       = "${aws_secretsmanager_secret.api_runtime.arn}:DATABASE_URL::"
          JWT_REFRESH_SECRET = "${aws_secretsmanager_secret.api_runtime.arn}:JWT_REFRESH_SECRET::"
          JWT_SECRET         = "${aws_secretsmanager_secret.api_runtime.arn}:JWT_SECRET::"
          REDIS_URL          = "${aws_secretsmanager_secret.api_runtime.arn}:REDIS_URL::"
        },
        # Le jeton que les trois fonctions Lambda de la chaîne présentent dans
        # `x-internal-token` (#71, #73). Exigé **seulement** quand l'une des
        # routes internes est branchée : une clé absente du JSON du secret
        # empêche la tâche ECS de démarrer, et l'API entière tomberait pour une
        # capacité que l'environnement n'utilise pas encore.
        local.notification_internal_route_wired ? {
          NOTIFICATIONS_INTERNAL_TOKEN = "${aws_secretsmanager_secret.api_runtime.arn}:NOTIFICATIONS_INTERNAL_TOKEN::"
        } : {},
      )
    }

    web = {
      image                  = local.web_image
      ecr_repository_arn     = module.ecr.repository_arns["web"]
      listener_rule_priority = 200

      # `PORT=3000` dans l'image du front (apps/web/Dockerfile), et `HOSTNAME` y
      # vaut `0.0.0.0` — sans quoi le serveur autonome de Next n'écouterait que
      # la boucle locale du conteneur et aucun health check ne l'atteindrait.
      container_port = 3000

      cpu    = 512
      memory = 1024

      desired_count = 1
      min_capacity  = 1
      max_capacity  = 2

      # `/*` en dernier : la règle de l'API est évaluée avant (priorité 100) et
      # capte `/health` et `/api/*`. Tout le reste — la page publique du salon,
      # le tunnel de réservation, l'espace client, le back-office — est servi par
      # le front.
      path_patterns = ["/*"]

      # La racine, et non un `/health` dédié : le front n'expose aucune route de
      # santé, sa seule dépendance est l'API que le health check de l'API couvre
      # déjà, et `/health` est de toute façon routé vers l'API par la règle
      # d'écoute prioritaire.
      #
      # C'est aussi ce qui donne son effet à la garde d'origine publique
      # (`apps/web/instrumentation.ts`) : Next ne joue son hook d'instrumentation
      # qu'à la première requête servie, et cette première requête est justement
      # ce contrôle. Faute d'`APP_URL`, la tâche sort en code 1 sans jamais
      # entrer dans le groupe cible, et le disjoncteur revient à la révision
      # précédente.
      health_check_path = "/"

      # Next compile ses routes au démarrage du serveur autonome. Cent vingt
      # secondes ici comme en développement : un démarrage après un arrêt de nuit
      # part d'un cache d'image froid.
      health_check_grace_period_seconds = 120

      # `APP_URL` et `API_URL`, calculées par le module à partir de son ALB.
      # `API_URL` est l'hôte **sans** préfixe : `lib/api-client.ts` y ajoute
      # lui-même `/api/v1`, le versionnement étant une propriété de l'API et non
      # du déploiement.
      #
      # **Cet aller-retour ne fonctionnera pas tant que `certificate_arn` n'est
      # pas fourni** — voir « Terminaison TLS » plus haut. Le service démarre, son
      # contrôle de santé passe, et les pages qui appellent l'API rendent une
      # erreur de service indisponible. C'est le premier prérequis de la campagne
      # de recette, pas une surprise à découvrir le jour J.
      public_url_env_vars = ["APP_URL", "API_URL"]

      environment = {
        LOG_LEVEL = "info"
        PORT      = "3000"
      }

      # Aucune politique : le front n'appelle aucune API AWS. Pas de sidecar
      # X-Ray non plus — il n'ouvre aucun segment, et le démon consommerait le
      # CPU et la mémoire de la tâche pour relayer du vide.
    }
  }
}

# --- Pare-feu applicatif ------------------------------------------------------

# Le WAF du CDC §4.10, en amont de la seule frontière publique de cet
# environnement (#79). Portée `REGIONAL` : aucune distribution CloudFront
# n'existe encore dans ce dépôt, l'ALB est donc ce qu'il y a à couvrir.
module "waf" {
  source = "../../modules/waf"

  environment = local.environment

  associated_resource_arns = {
    alb = module.ecs_service.alb_arn
  }

  alarm_topic_arns   = [module.budgets.alerts_topic_arn]
  log_retention_days = local.log_retention_days

  # Bot Control retiré, comme en développement — et c'est **la** concession de
  # cet environnement au « proche de la production ». C'est le seul groupe
  # facturé des cinq : environ 10 USD par mois et par Web ACL, plus l'analyse au
  # million de requêtes, soit la marge budgétaire entière de la recette.
  #
  # Ce que cela coûte, dit franchement : les faux positifs propres à Bot Control
  # ne seront pas éprouvés ici. Ce que cela ne coûte pas : le module le laisse
  # dans `count_only_rule_groups` par défaut, donc la production le composera en
  # **comptage** et non en blocage — ses faux positifs s'y verront sans couper
  # personne, ce qui est le seul régime sous lequel on peut les découvrir en
  # production.
  bot_control_inspection_level = null

  # Le seuil par défaut du module, c'est-à-dire celui de la production — et non
  # les 10 000 de `envs/dev`. C'est le point : un parcours de recette qui
  # déclenche la limitation de débit doit le déclencher **ici**, pas chez une
  # cliente. Une campagne de tirs de charge, elle, le relèvera explicitement pour
  # sa durée, en sachant qu'elle change ce qu'elle mesure.
  rate_limit = 2000
}

# --- Observabilité ------------------------------------------------------------

# Les alarmes que le CDC §4.11 exige avant tout go-live, le tableau de bord qui
# les regarde venir, et la règle d'échantillonnage X-Ray de l'environnement.
#
# La recette est l'endroit où l'on découvre qu'une alarme se déclenche en
# fonctionnement nominal — c'est-à-dire l'endroit où l'on évite d'apprendre à
# ignorer celles de la production.
module "observability" {
  source = "../../modules/observability"

  environment = local.environment

  alarm_topic_arns = [module.budgets.alerts_topic_arn]

  alb = {
    # Le suffixe d'ARN, et non l'ARN : c'est la forme qu'attendent les dimensions
    # de métriques CloudWatch.
    arn_suffix = module.ecs_service.alb_arn_suffix
  }

  ecs = {
    cluster_name = module.ecs_service.cluster_name

    # Une alarme par service, pas une pour le cluster : la moyenne de deux
    # services dont l'un sature et l'autre dort ne franchit jamais le seuil.
    service_names = module.ecs_service.service_names
  }

  rds = {
    instance_id           = module.database.instance_id
    allocated_storage_gib = module.database.allocated_storage
    max_connections       = local.rds_max_connections
  }

  # Volontairement vides. La seule chaîne asynchrone de cet environnement est
  # celle des notifications, et son module pose déjà les alarmes de sa DLQ et de
  # sa Lambda (#67), avec les descriptions qui nomment ses pannes à elle. Les
  # reposer ici enverrait deux notifications pour le même message.
  dead_letter_queues = {}
  lambda_functions   = {}
}

# --- Migrations de schéma -----------------------------------------------------

# La famille `spa-{env}-migrate` est un contrat, pas une préférence : le rôle de
# déploiement OIDC n'autorise `ecs:RunTask` que sur cette famille
# (modules/oidc/main.tf), et `deploy-staging.yml` la passe en
# `--task-definition`. Un autre nom rendrait le déploiement incapable de jouer
# ses migrations.
#
# L'image est celle de l'API : son étape `prod-deps` conserve délibérément le CLI
# Prisma et le schéma pour cette tâche (apps/api/Dockerfile).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "spa-${local.environment}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"

  # Les rôles de l'API, et pas des rôles dédiés : la tâche tire la même image et
  # lit la même clé du même secret. Un troisième rôle n'accorderait rien de
  # moins, et il faudrait le tenir à jour en parallèle.
  execution_role_arn = module.ecs_service.execution_role_arns["api"]
  task_role_arn      = module.ecs_service.task_role_arns["api"]

  # Les révisions précédentes restent `ACTIVE` : une migration qui échoue se
  # rejoue sur la révision qui a fonctionné.
  skip_destroy = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.api_image
    essential = true

    # Le binaire local plutôt que `npx` : `npx` passe par npm, qui résout, écrit
    # dans un cache et peut décider de télécharger. Ici le CLI est dans l'image,
    # à un chemin connu, sous `WORKDIR /app`.
    command = [
      "node_modules/.bin/prisma",
      "migrate",
      "deploy",
      "--schema",
      "apps/api/prisma/schema.prisma",
    ]

    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = "${aws_secretsmanager_secret.api_runtime.arn}:DATABASE_URL::"
    }]

    # Le groupe de journaux de l'API, avec un préfixe de flux distinct. Le rôle
    # d'exécution n'est autorisé à écrire que dans ce groupe-là : un groupe
    # dédié demanderait d'élargir sa politique, qui vit dans le module.
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = module.ecs_service.log_group_names["api"]
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])

  tags = {
    Name = "spa-${local.environment}-migrate"
  }
}
