# Environnement développement — composition de modules.
#
# Un environnement ne déclare presque aucune ressource en propre : il compose des
# modules et leur fournit les valeurs. L'état vit dans le bucket créé par
# ../../bootstrap (voir backend.tf), verrouillé par sa table DynamoDB.
#
# Les trois ressources déclarées ici — le conteneur du secret d'exécution, le
# certificat de terminaison TLS et la définition de tâche de migration — sont de
# la colle d'environnement : elles n'existent qu'une fois par environnement et
# n'ont pas encore de module. Voir le README pour ce qui a vocation à en devenir
# un.

locals {
  environment = "dev"

  # Image tirée par le service ECS et par la tâche de migration. L'étiquette est
  # le sha du commit déployé : les dépôts du module `ecr` sont **immuables**, une
  # étiquette mobile du genre `:develop` ne pourrait donc être poussée qu'une
  # fois. C'est aussi ce qui fait que le déploiement passe par un
  # `terraform apply -var image_tag=<sha>` — la définition de tâche appartient à
  # l'état, et rien d'autre ne peut la faire pointer sur la nouvelle image.
  api_image = "${module.ecr.repository_urls["api"]}:${var.image_tag}"

  # Certificat porté par le listener 443. À défaut d'ARN fourni, l'environnement
  # en fabrique un lui-même — voir le bloc « Terminaison TLS » plus bas.
  certificate_arn = var.certificate_arn != null ? var.certificate_arn : one(aws_acm_certificate.alb[*].arn)
}

data "aws_region" "current" {}

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
  vpc_cidr = "10.10.0.0/16"

  # Une seule NAT Gateway : la résilience par zone ne vaut pas son coût
  # sur un environnement de développement, où une coupure de sortie se répare
  # en attendant le retour de la zone.
  nat_gateway_count = 1
}

# --- Registre d'images --------------------------------------------------------

module "ecr" {
  source = "../../modules/ecr"

  environment  = local.environment
  applications = ["api", "web"]

  # Un environnement de développement se détruit et se recrée : un dépôt qui
  # refuse de disparaître tant qu'il contient une image transformerait chaque
  # `terraform destroy` en ménage manuel. Le garde-fou garde tout son sens en
  # staging et en production, où il reste à sa valeur par défaut.
  force_delete = true

  # Moins d'images conservées qu'ailleurs : `develop` publie à chaque merge, et
  # personne ne revient dix déploiements en arrière sur un environnement de
  # développement (skill aws-infra §9).
  max_tagged_images = 10
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

  # Dimensionnement et résilience de développement : pas de bascule
  # inter-zone, pas d'instantané final, suppression possible. Les préconditions
  # du module refuseraient ces valeurs sur un environnement nommé `prod`.
  multi_az            = false
  deletion_protection = false
  skip_final_snapshot = true

  # Les modifications s'appliquent tout de suite plutôt qu'à la prochaine fenêtre
  # de maintenance : sur un environnement de développement, attendre lundi 3 h 30
  # pour voir un paramètre pris en compte n'a aucun intérêt.
  apply_immediately = true
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

  # Ni réplica ni Multi-AZ : sur un environnement de développement,
  # l'indisponibilité du cache dégrade sans interrompre.
  replica_count = 0
  multi_az      = false

  apply_immediately = true

  # Suppression immédiate du secret du jeton AUTH. Avec la fenêtre de
  # récupération par défaut, Secrets Manager garde le nom réservé trente jours
  # après un `destroy` — et le `terraform apply` suivant échoue sur un nom déjà
  # pris. Un environnement qu'on recrée souvent ne peut pas vivre avec ça.
  secret_recovery_window_in_days = 0
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
# Le README donne le JSON attendu et l'ordre des opérations.
#
# Chiffré par la clé gérée par AWS et non par une clé du compte, délibérément :
# le rôle d'exécution ECS n'obtient `kms:Decrypt` que si l'environnement passe
# une clé au module `ecs-service` — laquelle chiffrerait du même geste les
# groupes de journaux, ce que CloudWatch Logs refuse tant que la politique de la
# clé ne nomme pas `logs.{région}.amazonaws.com`. Une clé dédiée au secret
# suppose donc de découpler les deux usages dans le module, hors du périmètre de
# cet environnement (issue de suivi).
#tfsec:ignore:aws-ssm-secret-use-customer-key
resource "aws_secretsmanager_secret" "api_runtime" {
  # `name_prefix` et non `name` : deux `apply` séparés par un `destroy` ne se
  # disputent pas le même nom.
  name_prefix = "spa-${local.environment}/api/runtime-"
  description = "Variables d'exécution de l'API ${local.environment} — valeur déposée hors Terraform."

  # Comme pour le jeton AUTH du cache : un environnement jetable ne peut pas
  # attendre trente jours qu'un nom se libère.
  recovery_window_in_days = 0

  tags = {
    Name = "spa-${local.environment}-api-runtime"
  }
}

# --- Terminaison TLS ----------------------------------------------------------

# Le module `ecs-service` exige un certificat : son listener 443 est le seul par
# lequel une requête applicative passe. En développement, il n'y a ni nom de
# domaine ni zone Route 53 à valider — un certificat ACM public y serait bloqué
# en `PENDING_VALIDATION`, et l'`apply` échouerait faute d'un certificat émis.
#
# L'environnement en fabrique donc un lui-même, auto-signé et importé dans ACM.
# Conséquences assumées, et cantonnées au développement :
#
#   * un client TLS le refuse s'il ne désactive pas la vérification — le contrôle
#     de santé du workflow de déploiement passe `--insecure`, et le dit ;
#   * la clé privée est écrite dans l'état Terraform, qui est chiffré et dont
#     l'accès est restreint (bucket de l'amorçage).
#
# `certificate_arn` permet de fournir un vrai certificat ACM dès qu'un domaine
# existe ; staging et production n'auront pas d'autre choix que celui-là.
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

  log_retention_days         = 30
  container_insights_enabled = false
  alb_deletion_protection    = false

  # Ouverture de la chaîne vers le niveau données. Le sens est délibéré : les
  # modules `database` et `cache` déclarent leur entrée depuis le groupe des
  # tâches, ce module déclare la sortie vers eux.
  task_egress_rules = {
    postgres = {
      description                  = "PostgreSQL vers RDS spa-dev-rds"
      port                         = 5432
      referenced_security_group_id = module.database.security_group_id
    }

    redis = {
      description                  = "Redis vers ElastiCache spa-dev-redis"
      port                         = 6379
      referenced_security_group_id = module.cache.security_group_id
    }
  }

  # Un seul service pour l'instant : `apps/web` ne porte encore aucun
  # `next.config.*`, son image ne se construit donc pas (voir la garde du job
  # `docker` de ci.yml). Le dépôt ECR `spa-dev-web` existe déjà côté registre ;
  # le service ECS s'ajoutera ici le jour où le front démarre.
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

      # Une tâche suffit en développement, et le déploiement reste sans coupure :
      # `minimum_healthy_percent = 100` et `maximum_percent = 200` font démarrer
      # la nouvelle tâche, attendre qu'elle soit saine pour l'ALB, puis retirer
      # l'ancienne.
      desired_count = 1
      min_capacity  = 1
      max_capacity  = 4

      # `/health` est servi hors préfixe `/api` et hors versionnement
      # (apps/api/src/bootstrap.ts) : il exécute `SELECT 1` sur PostgreSQL et
      # `PING` sur Redis, et répond 503 dès qu'une dépendance est tombée. C'est
      # ce qui fait retirer une tâche coupée de la base du groupe cible.
      health_check_path = "/health"
      path_patterns     = ["/health", "/api/*"]

      # `NODE_ENV` n'est pas repris ici : l'image le pose déjà à `production`, et
      # le contredire depuis la définition de tâche ferait diverger le
      # comportement de l'application de celui de l'image qu'on déploie ailleurs.
      environment = {
        LOG_LEVEL = "debug"
        PORT      = "3001"
      }

      # Résolus par l'agent ECS au démarrage, à partir des clés JSON du secret
      # d'exécution. Aucune valeur ne transite par l'état ni par la console ECS.
      secret_arns = {
        API_URL            = "${aws_secretsmanager_secret.api_runtime.arn}:API_URL::"
        APP_URL            = "${aws_secretsmanager_secret.api_runtime.arn}:APP_URL::"
        DATABASE_URL       = "${aws_secretsmanager_secret.api_runtime.arn}:DATABASE_URL::"
        JWT_REFRESH_SECRET = "${aws_secretsmanager_secret.api_runtime.arn}:JWT_REFRESH_SECRET::"
        JWT_SECRET         = "${aws_secretsmanager_secret.api_runtime.arn}:JWT_SECRET::"
        REDIS_URL          = "${aws_secretsmanager_secret.api_runtime.arn}:REDIS_URL::"
      }
    }
  }
}

# --- Migrations de schéma -----------------------------------------------------

# La famille `spa-{env}-migrate` est un contrat, pas une préférence : le rôle de
# déploiement OIDC n'autorise `ecs:RunTask` que sur cette famille
# (modules/oidc/main.tf). Un autre nom rendrait le déploiement incapable de jouer
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
