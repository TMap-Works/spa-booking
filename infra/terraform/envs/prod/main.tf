# Environnement production — composition de modules.
#
# Un environnement ne déclare presque aucune ressource en propre : il compose des
# modules et leur fournit les valeurs. L'état vit dans le bucket créé par
# ../../bootstrap (voir backend.tf), verrouillé par sa table DynamoDB.
#
# Les quatre ressources déclarées ici — le conteneur du secret d'exécution, le
# certificat auto-signé de repli, le topic d'alertes de bord et la définition de
# tâche de migration — sont de la colle d'environnement : elles n'existent qu'une
# fois par environnement et n'ont pas encore de module, exactement comme dans
# `envs/dev` et `envs/staging`.
#
# ## Ce qui distingue cet environnement des deux autres (CDC §4.15)
#
# La **forme** est celle de `envs/staging` : les mêmes modules, la même chaîne de
# trafic, les mêmes alarmes, le même coffre de sauvegarde. Ce qui change tient en
# une liste courte, et chaque ligne se paie :
#
#   * **RDS Multi-AZ** — une instance de secours dans la seconde zone, bascule
#     automatique ;
#   * **deux NAT Gateway**, une par zone, pour que la perte d'une zone ne coupe
#     pas la sortie Internet de l'autre ;
#   * **auto-scaling de 2 à 8 tâches** par service, contre 1 à 2 en recette ;
#   * **un réplica ElastiCache** réparti sur deux zones ;
#   * **CloudFront et un second WAF en amont de l'ALB**, ce qu'aucun autre
#     environnement ne compose ;
#   * **aucun arrêt hors heures ouvrées** — la production ne dort pas ;
#   * des rétentions plus longues, partout : 90 jours de journaux, 35 jours de
#     sauvegardes, un an de points mensuels.

locals {
  environment = "prod"

  # Rétention des journaux CloudWatch de l'environnement : 90 jours en production
  # (skill aws-infra §8). Trois mois, parce qu'un incident se rejoue rarement le
  # jour où on le comprend — et pas davantage, parce que CloudWatch facture le
  # stockage indéfiniment quand personne ne fixe de terme.
  #
  # Passée explicitement à chacun des modules qui créent un groupe de journaux
  # plutôt que laissée à leur défaut, qui vaut 30 — le réglage hors production —,
  # et exposée en sortie pour être vérifiable.
  log_retention_days = 90

  # Image tirée par les services ECS et par la tâche de migration. L'étiquette est
  # le sha du commit déployé : les dépôts du module `ecr` sont **immuables**, une
  # étiquette mobile du genre `:prod` ne pourrait donc être poussée qu'une fois.
  # C'est aussi ce qui fait que le déploiement passe par un
  # `terraform apply -var image_tag=<sha>` — la définition de tâche appartient à
  # l'état, et rien d'autre ne peut la faire pointer sur la nouvelle image.
  api_image = "${module.ecr.repository_urls["api"]}:${var.image_tag}"
  web_image = "${module.ecr.repository_urls["web"]}:${var.image_tag}"

  # --- Nom public et chaîne TLS ------------------------------------------------
  #
  # Tout ce qui suit dépend d'une seule décision : cet environnement a-t-il un nom
  # de domaine et une zone Route 53 pour le servir ?
  #
  # Sans eux, l'environnement reste **applicable** — ALB, certificat auto-signé de
  # repli, WAF régional — mais il n'est pas exploitable : aucune cliente ne tape
  # un nom `*.elb.amazonaws.com`, et le repli auto-signé rend inexécutable tout
  # appel du front vers l'API. C'est un état d'amorçage, pas un état de service,
  # et la sortie `go_live_blockers` le dit sans détour.
  #
  # Avec eux, la chaîne complète se compose : deux certificats ACM validés par
  # DNS — donc renouvelés automatiquement —, la distribution CloudFront, sa Web
  # ACL de bord, et les enregistrements qui font pointer le nom public dessus.
  cdn_enabled = var.public_domain_name != null && var.route53_zone_id != null

  # Le nom par lequel CloudFront joint l'ALB. **Jamais** le nom
  # `*.elb.amazonaws.com` : CloudFront vérifie le certificat de son origine, et
  # aucun certificat public ne couvre ce nom-là. Voir modules/cdn/README.md.
  origin_domain_name = local.cdn_enabled ? "origin.${var.public_domain_name}" : null

  # Certificat du listener 443. Trois sources possibles, dans l'ordre : un ARN
  # fourni par l'opérateur, le certificat que le module `certificate` émet et
  # renouvelle, ou le repli auto-signé de l'amorçage. Exactement une des trois est
  # non nulle par construction, ce dont `coalesce` a besoin.
  alb_certificate_arn = coalesce(
    var.certificate_arn,
    one(module.certificate_alb[*].certificate_arn),
    one(aws_acm_certificate.alb_self_signed[*].arn),
  )

  # Certificat de la distribution, dans `us-east-1` — CloudFront n'en accepte
  # aucun autre. `try` parce que les deux sources sont nulles quand le CDN n'est
  # pas composé, cas où `coalesce` échouerait au lieu de rendre `null`.
  edge_certificate_arn = try(coalesce(
    var.edge_certificate_arn,
    one(module.certificate_edge[*].certificate_arn),
  ), null)

  # Origine publique annoncée par le front dans ses balises canoniques et ses
  # données structurées.
  #
  # Déduite de la **variable** et non de la sortie `public_url` du module `cdn`,
  # et ce n'est pas de la paresse : `cdn` dépend de `ecs_service` — il lui faut le
  # nom DNS de l'ALB — et lire sa sortie ici ferait dépendre `ecs_service` de
  # `cdn`. Terraform refuserait le cycle.
  public_base_url = local.cdn_enabled ? "https://${var.public_domain_name}" : null

  # Bornes d'auto-scaling des deux services — **le troisième critère du CDC
  # §4.15** : deux tâches au repos, huit au maximum, sur une cible d'utilisation
  # CPU de 60 % (le défaut du module `ecs-service`).
  #
  # Écrites ici plutôt qu'en dur dans chaque entrée de `services` pour une raison
  # précise : la sortie `ecs_autoscaling_capacity` les rend telles quelles, et
  # c'est ce qui permet de vérifier le critère par un `terraform output` au lieu
  # d'aller relire la console. Deux valeurs recopiées auraient fini par diverger.
  #
  # Deux et non une, et c'est le point : une seule tâche ferait de chaque
  # déploiement, de chaque remplacement de tâche et de chaque panne de zone une
  # coupure. Deux tâches réparties sur les deux sous-réseaux applicatifs sont ce
  # qui rend le déploiement rolling réellement sans interruption.
  service_capacity = {
    api = {
      desired_count = 2
      min_capacity  = 2
      max_capacity  = 8
    }

    web = {
      desired_count = 2
      min_capacity  = 2
      max_capacity  = 8
    }
  }

  # Nombre maximal de connexions accepté par le moteur, dont l'alarme de
  # saturation surveille les 80 %. Il se dit ici parce qu'il ne se déduit de
  # rien : RDS le calcule par `LEAST({DBInstanceClassMemory/9531392}, 5000)` et
  # ne le publie sous aucune métrique. Sur le `db.t4g.medium` du CDC §4.15 —
  # 4 Gio —, cela fait 4 294 967 296 / 9 531 392 ≈ 450.
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
  # une liste vide.
  notification_queue_env = { for url in module.notifications[*].dispatch_queue_url : "NOTIFICATION_QUEUE_URL" => url }

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

  # Haut de la fourchette du CDC §4.16 — 430 à 800 USD par mois pour la
  # production. Le plafond se pose au sommet de la fourchette et non à son
  # milieu : à 430, l'alerte à 80 % se déclencherait dans le fonctionnement
  # nominal prévu, et une alerte qui se déclenche en régime normal cesse d'être
  # lue. À 800, le seuil de 80 % tombe à 640 — au-dessus de la fourchette, donc
  # sur une vraie dérive.
  #
  # Ce que la composition complète y met, poste par poste et en ordre de
  # grandeur : RDS `db.t4g.medium` Multi-AZ et son stockage (~185), deux NAT
  # Gateway et leur transfert (~75), quatre endpoints d'interface sur deux zones
  # (~58), quatre tâches Fargate au repos (~75), ElastiCache `cache.t4g.small`
  # avec son réplica (~50), l'ALB (~21), **deux** Web ACL — bord et région —
  # (~25), CloudFront (~30), les journaux à 90 jours, le coffre de sauvegarde,
  # les clés KMS et ECR (~60). Soit ~580, dans la fourchette et sous le seuil.
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
  # Premier critère du CDC §4.15.
  nat_gateway_count = 2

  # Rétention des flow logs du VPC — quatre-vingt-dix jours en production. Un
  # incident réseau se comprend rarement le jour où il se produit, et c'est le
  # seul environnement dont les traces servent à répondre à quelqu'un.
  log_retention_days = local.log_retention_days
}

# --- Registre d'images --------------------------------------------------------

module "ecr" {
  source = "../../modules/ecr"

  environment  = local.environment
  applications = ["api", "web"]

  # `force_delete` reste au défaut — faux. Un dépôt de production ne se supprime
  # pas parce qu'un `destroy` a été lancé dans le mauvais répertoire.

  # Le défaut du module. Trente images étiquetées, c'est-à-dire de quoi revenir
  # loin en arrière : le rollback de `deploy-production.yml` repart de la
  # définition de tâche précédente, mais un incident découvert une semaine plus
  # tard se répare en redéployant un sha choisi à la main, et l'image doit encore
  # exister ce jour-là.
  max_tagged_images = 30
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

  # `db.t4g.medium`, le dimensionnement de départ du CDC §4.15 — le même que dev
  # et staging, ce qui est voulu : un environnement de recette qui tournerait sur
  # une classe inférieure ne dirait rien des requêtes lentes de la production.
  # Le levier de montée en charge est écrit dans le CDC : instance supérieure,
  # puis réplicas de lecture. À réviser après un à deux mois de métriques réelles,
  # et **en revoyant `local.rds_max_connections` du même geste**.
  instance_class = "db.t4g.medium"

  # Cinquante gibioctets, bas de la fourchette du CDC §4.15, avec l'autoscaling
  # du stockage jusqu'à 200. Partir haut ne sert à rien — RDS facture ce qui est
  # provisionné, pas ce qui est utilisé, et le stockage ne se réduit jamais une
  # fois étendu.
  allocated_storage     = 50
  max_allocated_storage = 200

  # **Le premier critère de ce ticket.** Une instance de secours veille dans la
  # seconde zone et prend la main en une poignée de minutes. Une précondition du
  # module refuse déjà un `prod` sans elle — cette ligne dit la décision, la
  # précondition la protège.
  multi_az = true

  # Les deux verrous qui rendent une suppression difficile et jamais définitive.
  # Deux préconditions du module les exigent en production ; ils sont écrits ici
  # parce qu'ils décrivent une décision, pas un défaut hérité.
  deletion_protection = true
  skip_final_snapshot = false

  # Trente-cinq jours — le maximum de RDS, et la même valeur que les règles
  # quotidienne et continue du coffre `backup` plus bas. Deux politiques de
  # rétention qui divergeraient sur le même moteur seraient une source de
  # confusion permanente le jour d'une restauration. Le module refuse moins de
  # trente en production (CDC §4.14).
  backup_retention_period = 35

  # Trois mois de Performance Insights au lieu de sept jours : une lenteur
  # signalée par une gérante se compare au même jour de la semaine précédente, et
  # sept jours ne le permettent pas. La valeur doit être 7, 731, ou un multiple
  # de 31 — 93 est le trimestre.
  performance_insights_retention_period = 93

  # Métriques système à la minute, ce que Performance Insights ne donne pas : il
  # voit la base, pas la machine. Un `iowait` qui monte pendant que les requêtes
  # ralentissent est ce qui distingue « la requête est mauvaise » de « le volume
  # sature ».
  #
  # Conditionné au rôle, et pas seulement par prudence : une précondition du
  # module refuse un intervalle de mesure sans rôle pour l'écrire, et l'écrire en
  # dur ici rendrait cet environnement **non planifiable** tant que ce rôle de
  # compte n'existe pas. Il vaut mieux une production sans métriques système
  # qu'une production qu'on ne peut pas appliquer — et `go_live_blockers` dit
  # laquelle des deux on a.
  monitoring_interval = var.rds_monitoring_role_arn == null ? 0 : 60
  monitoring_role_arn = var.rds_monitoring_role_arn

  # `apply_immediately` reste au défaut — faux. En production, un changement de
  # paramètre attend la fenêtre de maintenance : une bascule de nœud provoquée en
  # pleine journée est une coupure, même courte.

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

  # `cache.t4g.small` et un réplica, dimensionnement du CDC §4.15. Le réplica
  # n'est pas là pour la lecture — le produit n'en fait pas assez pour cela — mais
  # pour la bascule : sans lui, la perte du nœud primaire est une perte de
  # service, et Redis porte ici les verrous du moteur de réservation.
  node_type     = "cache.t4g.small"
  replica_count = 1

  # Réplica dans l'autre zone, et bascule automatique. Deux préconditions du
  # module l'exigent en production, pour la raison qu'un réplica dans la même
  # zone que son primaire ne protège d'aucune panne de zone.
  multi_az = true

  # Cinq jours d'instantanés au lieu d'un. Le cache est reconstructible par
  # définition, mais une reconstruction complète en pleine journée fait retomber
  # toute la charge de lecture sur PostgreSQL au pire moment.
  snapshot_retention_limit = 5

  # Trente jours — le défaut du module. La production ne se recrée pas, et un nom
  # de secret libéré trop vite après une suppression accidentelle est exactement
  # ce qui empêche de revenir en arrière.

  # Rétention des journaux Redis exportés vers CloudWatch, même contrat que pour
  # PostgreSQL et pour le service ECS.
  log_retention_days = local.log_retention_days
}

# --- Sauvegarde et reprise d'activité (#82) -----------------------------------

# La politique de rétention unifiée du CDC §4.14, en plus des sauvegardes
# automatiques que le module `database` configure de son côté.
module "backup" {
  source = "../../modules/backup"

  environment = local.environment

  # Désignée par ARN et non par étiquette : un plan qui ne protège plus rien se
  # voit alors en revue, au lieu de se découvrir le jour de la restauration. Une
  # sélection par `{ Environment = "prod" }` embarquerait au passage les
  # compartiments S3 de l'environnement — dont celui de l'état Terraform.
  resource_arns = [module.database.instance_arn]

  # La clé de l'instance source. Le coffre, lui, a la sienne : une sauvegarde
  # chiffrée par la clé de ce qu'elle sauvegarde ne survit pas à la perte de
  # cette clé. Sans cette ligne, le travail de sauvegarde ne peut pas lire le
  # volume chiffré — et la restauration vers cette clé échoue.
  restore_kms_key_arns = [module.database.kms_key_arn]

  # Politique de rétention unifiée de la production (CDC §4.14). La règle
  # continue est la seule qui tienne le RPO ≤ 1 h ; les préconditions du module
  # refusent de la désactiver ici, et refusent une rétention quotidienne sous
  # 30 jours.
  continuous_backup_retention_days = 35
  daily_retention_days             = 35
  weekly_retention_days            = 90
  monthly_retention_days           = 365

  # Verrou de gouvernance : plus personne ne raccourcit une rétention ni ne
  # supprime un point avant son terme sans lever le verrou d'abord. Le mode
  # conformité, lui, n'est pas exposé par le module — il est irréversible.
  vault_lock = {
    min_retention_days = 30
    max_retention_days = 400
  }

  # `force_destroy` reste au défaut — faux —, et une précondition du module l'y
  # tient en production.

  alarm_topic_arns = [module.budgets.alerts_topic_arn]
}

# --- Export du reporting (#563) -----------------------------------------------

module "reporting_export" {
  source = "../../modules/reporting-export"

  environment = local.environment

  # Trente jours au lieu de sept. Un export de chiffre d'affaires se rouvre le
  # mois suivant, à la clôture — c'est même son usage principal.
  retention_days = 30

  # `kms_key_arn` reste nul : chiffrement géré par S3.
  #
  # Une clé du compte se défend — ces fichiers portent le chiffre d'affaires réel
  # des établissements, et une clé dédiée ajoute une politique distincte, une
  # rotation qu'on décide et une révocation qui les rend illisibles sans avoir à
  # les supprimer. Ce qui la retient ici est qu'il faudrait une **clé à elle** :
  # réutiliser celle du module `database` lierait la lisibilité des exports à la
  # survie de la clé de la base, ce qui est l'inverse de l'effet recherché. Ce
  # module-là n'existe pas encore, et le créer déborde du dimensionnement de la
  # production. À reprendre quand une clé de compte dédiée aux données métier
  # sera posée.
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

  # --- Rappel J-1 : balayage horaire (#71) ---
  #
  # Le planning EventBridge Scheduler existe dans tous les cas ; il reste
  # désactivé tant que cette URL est nulle. Les deux fonctions de la chaîne
  # présentent le même jeton à la même API — un seul secret, une seule
  # frontière de confiance, une seule rotation.
  reminder_sweep_url = var.notification_reminder_sweep_url

  # --- Rebonds et plaintes (#73) ---
  #
  # À poser avant le go-live (#83), au même moment que `dispatch_url` et pour une
  # raison qui n'est pas symétrique de la sienne : sans route d'envoi, rien ne
  # part et cela se voit tout de suite ; sans route d'ingestion, tout part —
  # y compris vers les adresses mortes que SES vient de signaler. Continuer à
  # écrire à une adresse morte dégrade la réputation d'envoi de **tout le
  # domaine**, partagée par tous les établissements (CDC §6). C'est une panne
  # lente, et elle ne se voit que dans la DLQ des événements de remise.
  #
  # La sortie `notification_delivery_events_configured` fait donc partie de la
  # liste de vérification de la mise en production, au même titre que
  # `notification_dispatch_configured`.
  delivery_events_url = var.notification_delivery_events_url

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

# --- Configuration d'exécution de l'API ---------------------------------------

# Conteneur du secret, sans sa valeur (skill aws-infra §7) : Terraform crée le
# secret, un opérateur y dépose le JSON. Rien de sensible ne transite donc ni par
# le code, ni par l'état.
#
# Six clés, dont deux qui ne sont pas des secrets — `APP_URL` et `API_URL`. Elles
# sont là parce qu'elles valent l'origine publique, que seul le déploiement
# connaît : les passer en `environment` demanderait de lire une sortie du module
# `ecs-service` pour construire une de ses entrées, ce qui est un cycle. Le README
# de `envs/dev` donne le JSON attendu et l'ordre des opérations ; il vaut mot pour
# mot ici, à ceci près qu'en production ces deux clés valent l'URL **de la
# distribution CloudFront** et non celle de l'ALB.
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

  # Trente jours — le défaut, et l'inverse de la recette. Un secret de production
  # supprimé par erreur doit pouvoir être restauré, et le nom réservé pendant ce
  # temps est précisément ce qui empêche de le recréer vide par-dessus.
  recovery_window_in_days = 30

  tags = {
    Name = "spa-${local.environment}-api-runtime"
  }
}

# --- Certificats ACM (CDC §4.9) -----------------------------------------------

# Deux certificats pour un seul domaine, et ce n'est pas une redondance : ACM est
# régional, et CloudFront n'accepte que des certificats de `us-east-1`. Le module
# `ecs-service`, lui, refuse au plan un certificat qui ne serait pas dans la
# région de son ALB.
#
# Les deux sont validés par **DNS**, ce qui est la condition — et la seule — du
# renouvellement automatique exigé par le CDC §4.9 : ACM réémet soixante jours
# avant l'échéance, sans intervention, tant que les CNAME de validation restent
# publiés. C'est pour cela que la zone Route 53 est confiée au module : il les
# tient lui-même, et l'oubli devient impossible.
#
# La validation par courriel aurait été l'autre voie. Elle redemande à un humain
# de cliquer un lien tous les treize mois : une panne de production programmée à
# date connue, un dimanche, sans personne pour faire le lien.

module "certificate_alb" {
  count  = var.certificate_arn == null && local.cdn_enabled ? 1 : 0
  source = "../../modules/certificate"

  environment = local.environment
  usage       = "alb"

  # **Le nom d'origine, et lui seul.**
  #
  # C'est celui que CloudFront appelle, et le seul que le certificat de l'ALB doit
  # couvrir — sous peine d'un `502` que rien n'explique côté ALB.
  #
  # Il serait tentant d'y ajouter le nom public en SAN, pour garder l'ALB
  # utilisable en direct le jour où il faudrait court-circuiter la distribution.
  # C'est un piège : **ACM émet le même enregistrement CNAME de validation pour un
  # domaine donné dans un compte donné**, quelle que soit la région et quel que
  # soit le certificat. Le nom public étant déjà couvert par le certificat de
  # bord, les deux modules se disputeraient le même enregistrement Route 53 — et,
  # le jour où l'un des deux certificats serait détruit, il emporterait
  # l'enregistrement dont l'autre a besoin. Le renouvellement de celui qui reste
  # échouerait alors un an plus tard, sans que rien ne relie la panne au geste qui
  # l'a causée. C'est exactement l'accident que la validation par DNS est censée
  # rendre impossible.
  #
  # Le court-circuit de la distribution reste faisable autrement : viser l'ALB par
  # `origin.<domaine>`, que ce certificat couvre.
  domain_name = local.origin_domain_name

  route53_zone_id = var.route53_zone_id
}

module "certificate_edge" {
  count  = var.edge_certificate_arn == null && local.cdn_enabled ? 1 : 0
  source = "../../modules/certificate"

  # `us-east-1` : CloudFront n'accepte aucun certificat d'une autre région.
  providers = {
    aws = aws.us_east_1
  }

  environment = local.environment
  usage       = "edge"

  domain_name = var.public_domain_name

  # La zone Route 53 est globale — l'y publier depuis un provider `us-east-1` ne
  # change rien à ce que le DNS sert.
  route53_zone_id = var.route53_zone_id
}

# --- Terminaison TLS de repli -------------------------------------------------

# Le module `ecs-service` exige un certificat : son listener 443 est le seul par
# lequel une requête applicative passe.
#
# Ce repli n'existe que pour que le **tout premier** `terraform apply` aboutisse
# avant qu'un nom de domaine n'existe — sans lui, l'environnement ne serait pas
# applicable du tout, et il n'y aurait rien sur quoi poser le vrai certificat.
#
# **Il n'est pas un état d'exploitation.** Tant qu'il est en place, ni les Server
# Components du front, ni les trois Lambda de la chaîne de notifications ne
# peuvent joindre l'API : toutes trois refusent un certificat non vérifiable, et
# aucune ne permet de désactiver la vérification. La sortie
# `tls_certificate_is_self_signed` dit dans lequel des deux états on se trouve, et
# `go_live_blockers` en fait un bloquant nommé.
resource "tls_private_key" "alb" {
  count = var.certificate_arn == null && !local.cdn_enabled ? 1 : 0

  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "alb" {
  count = var.certificate_arn == null && !local.cdn_enabled ? 1 : 0

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

resource "aws_acm_certificate" "alb_self_signed" {
  count = var.certificate_arn == null && !local.cdn_enabled ? 1 : 0

  private_key      = tls_private_key.alb[0].private_key_pem
  certificate_body = tls_self_signed_cert.alb[0].cert_pem

  tags = {
    Name = "spa-${local.environment}-alb-self-signed"
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
  certificate_arn   = local.alb_certificate_arn

  log_retention_days = local.log_retention_days

  # Les métriques par tâche, sans lesquelles une saturation se diagnostique après
  # coup et à l'aveugle. C'est le seul environnement où l'on ne peut pas rejouer
  # l'incident pour l'observer.
  container_insights_enabled = true

  # Vrai — détruire cet ALB coupe le service **et** change son nom DNS, ce qui
  # invaliderait du même geste l'origine de la distribution CloudFront.
  alb_deletion_protection = true

  # L'origine publique est celle de CloudFront, pas celle de l'ALB : c'est sous ce
  # nom que le front est servi, et c'est celui qu'il doit publier dans ses balises
  # canoniques. Nulle tant qu'aucun domaine n'est fourni, auquel cas le module
  # retombe sur `https://<nom DNS de l'ALB>`.
  public_base_url = local.public_base_url

  # `off_hours_shutdown` reste au défaut — nul. La production ne s'arrête pas la
  # nuit : c'est le seul environnement où une réservation peut arriver à trois
  # heures du matin, et un salon qui ouvre à sept heures a des clientes qui
  # réservent la veille au soir.

  # Ouverture de la chaîne vers le niveau données. Le sens est délibéré : les
  # modules `database` et `cache` déclarent leur entrée depuis le groupe des
  # tâches, ce module déclare la sortie vers eux.
  task_egress_rules = {
    postgres = {
      description                  = "PostgreSQL vers RDS spa-prod-rds"
      port                         = 5432
      referenced_security_group_id = module.database.security_group_id
    }

    redis = {
      description                  = "Redis vers ElastiCache spa-prod-redis"
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

      # Un vCPU et deux gibioctets — le haut de la fourchette du CDC §4.15 pour
      # l'API, qui porte le moteur de disponibilité et ses transactions
      # verrouillées. Le front, lui, reste à la moitié.
      cpu    = 1024
      memory = 2048

      # **Le troisième critère de ce ticket** — voir `local.service_capacity`,
      # que la sortie `ecs_autoscaling_capacity` rend telle quelle.
      desired_count = local.service_capacity["api"].desired_count
      min_capacity  = local.service_capacity["api"].min_capacity
      max_capacity  = local.service_capacity["api"].max_capacity

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

      desired_count = local.service_capacity["web"].desired_count
      min_capacity  = local.service_capacity["web"].min_capacity
      max_capacity  = local.service_capacity["web"].max_capacity

      # `/*` en dernier : la règle de l'API est évaluée avant (priorité 100) et
      # capte `/health` et `/api/*`. Tout le reste — la page publique du salon,
      # le tunnel de réservation, l'espace client, le back-office — est servi par
      # le front.
      path_patterns = ["/*"]

      # La racine, et non un `/health` dédié : le front n'expose aucune route de
      # santé, sa seule dépendance est l'API que le health check de l'API couvre
      # déjà, et `/health` est de toute façon routé vers l'API par la règle
      # d'écoute prioritaire.
      health_check_path = "/"

      # Next compile ses routes au démarrage du serveur autonome, et la première
      # requête servie déclenche son hook d'instrumentation.
      health_check_grace_period_seconds = 120

      # `APP_URL` et `API_URL`, calculées par le module à partir de
      # `public_base_url` — donc, ici, l'origine CloudFront. `API_URL` est l'hôte
      # **sans** préfixe : `lib/api-client.ts` y ajoute lui-même `/api/v1`, le
      # versionnement étant une propriété de l'API et non du déploiement.
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

# --- Pare-feu applicatif (CDC §4.10) ------------------------------------------

# Deux Web ACL, et c'est la lecture littérale du CDC §4.10 : « en amont de
# CloudFront/ALB ».
#
#   * celle de **bord**, portée `CLOUDFRONT`, bloque au point de présence — avant
#     la traversée du réseau, et sur l'adresse réelle de la cliente ;
#   * celle de **région**, portée `REGIONAL`, couvre le chemin que la première ne
#     voit pas : l'ALB reste joignable par son nom `*.elb.amazonaws.com`, et une
#     requête qui l'atteint en direct contourne la distribution.
#
# Sans la seconde, poser CloudFront devant l'ALB **affaiblirait** la protection
# au lieu de la renforcer : le filtrage se déplacerait à un endroit qu'il suffit
# de contourner. Sans la première, le filtrage n'aurait lieu qu'après la
# traversée du réseau et sur une adresse source qui n'est plus celle de la
# cliente. Les deux, donc — pour environ 25 USD par mois au total.

module "waf" {
  source = "../../modules/waf"

  environment = local.environment

  associated_resource_arns = {
    alb = module.ecs_service.alb_arn
  }

  alarm_topic_arns   = [module.budgets.alerts_topic_arn]
  log_retention_days = local.log_retention_days

  # Bot Control retiré de **cette** Web ACL, et présent sur celle de bord. C'est
  # le seul groupe facturé des cinq, et le classer deux fois coûterait deux fois
  # sans rien apprendre de plus : le trafic nominal passe par la distribution, où
  # il est déjà classé. Ce qui arrive ici en direct est marginal, et les quatre
  # groupes gratuits le couvrent.
  bot_control_inspection_level = null

  # Le seuil par défaut du module. Il ne mord que sur le trafic qui court-circuite
  # la distribution : le trafic nominal est déjà limité au bord, sur une adresse
  # source exacte.
  rate_limit = 2000
}

# La Web ACL de bord. Créée par le provider `us-east-1` — WAF n'accepte pas
# d'autre région pour la portée `CLOUDFRONT` — et **non associée ici** : c'est la
# distribution qui la référence par `web_acl_id`, ce qu'une précondition du
# module rappelle en refusant `associated_resource_arns` sur cette portée.
module "waf_edge" {
  count  = local.cdn_enabled ? 1 : 0
  source = "../../modules/waf"

  providers = {
    aws = aws.us_east_1
  }

  # `prod-edge` et non `prod`, et ce n'est pas un environnement de plus.
  #
  # Dans ce module, `environment` n'est qu'un **préfixe de nom** : Web ACL, groupe
  # de journaux, politique de ressource, alarmes. Lui passer `prod` donnerait à
  # ces deux Web ACL des noms rigoureusement identiques — `spa-prod-waf`,
  # `aws-waf-logs-spa-prod` — que seule leur région distinguerait. Deux sorties
  # `terraform output` rendraient la même chaîne, et le premier réflexe d'un
  # incident de bord serait d'ouvrir le mauvais groupe de journaux.
  #
  # L'étiquette `Environment` reste `prod` : elle vient des `default_tags` du
  # provider (providers.tf), pas de cette variable. Le filtre du budget continue
  # donc de compter cette Web ACL avec le reste de l'environnement.
  environment = "${local.environment}-edge"

  scope = "CLOUDFRONT"

  # Vide, et c'est la précondition du module qui l'exige.
  associated_resource_arns = {}

  # Le topic de `us-east-1`, et non celui du module `budgets`. Ce n'est pas un
  # choix : une alarme CloudWatch ne peut notifier qu'un topic SNS de **sa
  # propre région**, et les métriques d'une Web ACL de portée `CLOUDFRONT` ne
  # vivent que dans `us-east-1`. Sans ce second topic, les deux alarmes de bord
  # changeraient d'état sans prévenir personne — ce qui est pire qu'une absence
  # d'alarme, puisqu'on se croit couvert.
  alarm_topic_arns   = [aws_sns_topic.edge_alerts[0].arn]
  log_retention_days = local.log_retention_days

  # Bot Control composé ici, en **comptage** — le défaut du module. C'est le seul
  # des cinq groupes qui distingue un robot d'indexation légitime d'un racleur de
  # créneaux, et c'est aussi le plus intrusif : un faux positif sur un tunnel de
  # réservation coûte une réservation. Il vit donc en observation le temps que la
  # métrique `CountedRequests` dise ce qu'il aurait bloqué. Le retirer de
  # `count_only_rule_groups` est un geste délibéré, à poser après lecture — pas
  # avant.
  bot_control_inspection_level = "COMMON"

  rate_limit = 2000
}

# Canal d'alerte de `us-east-1`, pour les seules alarmes de la Web ACL de bord.
#
# Il existe pour une raison mécanique et une seule : une alarme CloudWatch ne
# notifie qu'un topic SNS de sa région. Le topic du module `budgets` vit dans
# `eu-west-3` avec le reste de l'environnement ; les métriques d'une Web ACL de
# portée `CLOUDFRONT`, elles, n'existent que dans `us-east-1`.
#
# Mêmes destinataires que les alertes budgétaires : c'est la même astreinte qui
# lit les deux. Non chiffré, pour la même raison que le topic de `budgets` — le
# chiffrement SNS exige une clé gérée par le client, à 1 USD par mois, pour
# protéger un message dont tout le contenu est « le WAF de bord a bloqué
# beaucoup de requêtes ».
#tfsec:ignore:aws-sns-enable-topic-encryption
resource "aws_sns_topic" "edge_alerts" {
  count = local.cdn_enabled ? 1 : 0

  provider = aws.us_east_1

  name         = "spa-${local.environment}-edge-alerts"
  display_name = "Alertes de bord ${local.environment}"

  tags = {
    Name = "spa-${local.environment}-edge-alerts"
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "edge_alerts" {
  count = local.cdn_enabled ? 1 : 0

  # Garde de transport, alignée sur celle du topic de `budgets` : un refus pur,
  # qui n'accorde rien et interdit seulement de joindre ce topic hors TLS.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["sns:*"]
    resources = [aws_sns_topic.edge_alerts[0].arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Sans cet énoncé, les alarmes changent d'état — la console le montre — et
  # aucune notification ne part : CloudWatch publie sous son propre principal de
  # service, que l'énoncé du propriétaire ne couvre pas. Écrire une politique
  # efface celle qu'SNS pose par défaut, et il faut donc la réaffirmer (#67).
  statement {
    sid    = "AllowCloudWatchAlarms"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.edge_alerts[0].arn]

    # Garde contre l'adjoint confus : seules les alarmes de ce compte publient ici.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "AllowAccountOwner"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.account_id]
    }

    actions = [
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]

    resources = [aws_sns_topic.edge_alerts[0].arn]
  }
}

resource "aws_sns_topic_policy" "edge_alerts" {
  count = local.cdn_enabled ? 1 : 0

  provider = aws.us_east_1

  arn    = aws_sns_topic.edge_alerts[0].arn
  policy = data.aws_iam_policy_document.edge_alerts[0].json
}

# Abonnements par courriel. Ils restent en `PendingConfirmation` tant que leur
# destinataire n'a pas cliqué le lien — Terraform crée l'abonnement, il ne peut
# pas le confirmer à sa place. Un abonnement non confirmé ne reçoit rien, ce qui
# en production revient à n'avoir aucune alerte.
resource "aws_sns_topic_subscription" "edge_alerts_email" {
  for_each = local.cdn_enabled ? toset(var.budget_alert_emails) : toset([])

  provider = aws.us_east_1

  topic_arn = aws_sns_topic.edge_alerts[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# --- Diffusion (CDC §4.4) -----------------------------------------------------

# **Le deuxième critère de ce ticket.** La distribution ne se compose que si un
# nom de domaine et une zone Route 53 existent, et ce n'est pas de la prudence :
# CloudFront vérifie le certificat de son origine, et une origine ALB jointe par
# son nom `*.elb.amazonaws.com` n'a aucun certificat public possible. Sans
# domaine, il n'y a rien à mettre devant l'ALB — seulement un `502`.
module "cdn" {
  count  = local.cdn_enabled ? 1 : 0
  source = "../../modules/cdn"

  environment = local.environment

  domain_name        = var.public_domain_name
  additional_aliases = var.public_domain_aliases
  origin_domain_name = local.origin_domain_name

  alb_dns_name = module.ecs_service.alb_dns_name
  alb_zone_id  = module.ecs_service.alb_zone_id

  route53_zone_id = var.route53_zone_id

  certificate_arn = local.edge_certificate_arn
  web_acl_arn     = module.waf_edge[0].web_acl_arn

  # Le délai de lecture de l'origine, accordé sur `alb_idle_timeout_seconds` du
  # module `ecs-service`, qui vaut 60 par défaut. Deux délais désaccordés font
  # rendre un `504` par celui qui abandonne le premier, et l'on cherche alors la
  # panne du mauvais côté.
  origin_read_timeout_seconds = 60
}

# --- Observabilité ------------------------------------------------------------

# Les alarmes que le CDC §4.11 exige avant tout go-live, le tableau de bord qui
# les regarde venir, et la règle d'échantillonnage X-Ray de l'environnement.
#
# Ce n'est pas une amélioration à programmer ensuite : une plateforme mise en
# production sans ces alarmes apprend ses pannes par ses clientes.
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
# (modules/oidc/main.tf), et `deploy-production.yml` la passe en
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
