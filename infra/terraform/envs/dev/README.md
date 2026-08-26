# envs/dev — environnement de développement

Composition de modules pour l'environnement `dev` : réseau, registre d'images,
PostgreSQL, Redis, cluster ECS derrière un ALB, et la tâche de migration jouée
avant chaque déploiement.

```
Internet → ALB (443, certificat auto-signé)
         → ECS Fargate spa-dev-api (port 3001, /health)
         → RDS spa-dev-rds (5432) · ElastiCache spa-dev-redis (6379)
```

| Ressource | Nom | Module |
|---|---|---|
| VPC `10.10.0.0/16`, 3 niveaux × 2 AZ, 1 NAT | `spa-dev-*` | `network` |
| Dépôts d'images `api` et `web` | `spa-dev-api`, `spa-dev-web` | `ecr` |
| PostgreSQL 16, mono-AZ, 7 j de sauvegardes | `spa-dev-rds` | `database` |
| Redis 7.1, un nœud, chiffré en transit | `spa-dev-redis` | `cache` |
| Cluster, ALB, service `api`, auto-scaling | `spa-dev-cluster` | `ecs-service` |
| Budget mensuel 250 USD, alertes 80 % et 100 % | `spa-dev-monthly` | `budgets` |
| Définition de tâche de migration | `spa-dev-migrate` | déclarée ici |
| Secret d'exécution de l'API | `spa-dev/api/runtime-…` | déclarée ici |
| Certificat de terminaison TLS | `spa-dev-alb` | déclarée ici |

## Ordre d'amorçage

1. **`../../bootstrap`** — bucket d'état et table de verrouillage. Sans lui,
   `terraform init` n'a pas de backend.
2. **`../../modules/oidc`**, appliqué par une identité d'administrateur — il crée
   les rôles GitHub Actions. Son entrée `ecs_cluster_names` est **obligatoire et
   sans défaut**, et doit nommer le cluster de **chaque** environnement de
   `deployment_environments` — `dev`, `staging` et `prod` par défaut, soit
   `spa-dev-cluster`, `spa-staging-cluster`, `spa-prod-cluster` : la valeur que la
   sortie `cluster_name` de `modules/ecs-service` produit pour chacun. Sans
   l'entrée, le `plan` de la racine d'administration s'arrête sur une variable
   manquante ; avec un seul environnement renseigné, il s'arrête sur la
   précondition de `aws_iam_role_policy.deploy_scoped`, qui nomme ceux qui
   manquent ; avec une valeur approximative, les ARN de la politique de
   déploiement désignent un cluster inexistant et le déploiement revient en
   `AccessDenied` (#198). Elle s'écrit en clair parce que cette racine est
   distincte d'`envs/dev` et n'a pas accès à son état — voir
   [modules/oidc/README.md](../../modules/oidc/README.md).
   Poser ensuite les variables de dépôt `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`,
   `AWS_TERRAFORM_ROLE_ARN`, `AWS_TERRAFORM_PLAN_ROLE_ARN`.
3. **`terraform apply` ici.** Les dépôts ECR sont alors vides : le service ECS est
   créé mais ses tâches ne démarrent pas encore. C'est attendu — Terraform
   n'attend pas la stabilité du service, l'`apply` aboutit quand même.
4. **Déposer la valeur du secret d'exécution** (voir ci-dessous).
5. **Pousser sur `develop`** : `deploy-dev.yml` construit les images, joue les
   migrations, puis applique la nouvelle image (voir la section « Comment un push
   sur `develop` déploie »).
6. **Poser la variable de dépôt `APP_URL`** avec la sortie `app_url`, pour que le
   contrôle de santé post-déploiement s'exécute.

## Le secret d'exécution

Terraform crée le **conteneur** du secret, jamais sa valeur (skill aws-infra §7) :
une valeur écrite par Terraform vit dans l'état, et l'état se lit. La tâche ECS ne
démarre donc pas tant que le JSON suivant n'y a pas été déposé :

```json
{
  "APP_URL": "https://<sortie alb_dns_name>",
  "API_URL": "https://<sortie alb_dns_name>/api",
  "DATABASE_URL": "postgresql://spa_admin:<mot de passe>@<sortie database_endpoint>/spa?sslmode=require",
  "REDIS_URL": "rediss://:<jeton AUTH>@<sortie redis_primary_endpoint>:6379",
  "JWT_SECRET": "<32 caractères au moins>",
  "JWT_REFRESH_SECRET": "<32 caractères au moins, différent du précédent>"
}
```

- le mot de passe se lit dans le secret `database_master_user_secret_arn`, déposé
  par RDS lui-même ;
- le jeton AUTH se lit dans `redis_auth_token_secret_arn` ;
- `JWT_SECRET` et `JWT_REFRESH_SECRET` doivent **différer** — l'API refuse de
  démarrer sinon (`apps/api/src/config/env.schema.ts`).

`APP_URL` et `API_URL` passent par le secret bien qu'elles ne soient pas
sensibles : elles valent l'URL de l'ALB, que seul le module `ecs-service` connaît.
Les passer en variables d'environnement de la définition de tâche demanderait de
lire une sortie de ce module pour construire une de ses entrées — un cycle que
Terraform refuse. Le jour où un nom de domaine existe, elles redeviennent des
valeurs en clair.

## Terminaison TLS

Le listener 443 porte par défaut un certificat **auto-signé**, fabriqué par le
provider `tls` et importé dans ACM. C'est ce qui permet à `terraform apply`
d'aboutir sans nom de domaine ni zone Route 53 : un certificat ACM public resterait
bloqué en `PENDING_VALIDATION`, et l'ALB refuse un certificat non émis.

Deux conséquences, cantonnées au développement : un client doit désactiver la
vérification TLS (`curl --insecure`, ce que fait le contrôle de santé du
workflow), et la clé privée est écrite dans l'état — chiffré, à accès restreint.

Fournir `certificate_arn` remplace ce montage par un vrai certificat ACM.

## Coût et rétention

Le module `budgets` pose un budget mensuel de **250 USD** sur cet environnement,
filtré sur l'étiquette `Environment` et notifié à 80 % puis 100 % de ce plafond
sur le topic SNS `spa-dev-budget-alerts`. Le plafond décrit l'ordre de grandeur
du coût nominal — endpoints d'interface, RDS, NAT, ALB, Fargate, ElastiCache —
avec la marge d'un environnement qu'on recrée.

Le topic n'a **aucun destinataire par défaut**. Poser `budget_alert_emails` à
l'`apply`, ou s'abonner à la main sur l'ARN de la sortie
`budget_alerts_topic_arn` — puis **confirmer le message d'abonnement** : sans
confirmation, l'adresse ne reçoit rien.

La rétention des journaux CloudWatch est de **30 jours**, passée explicitement à
`database`, `cache` et `ecs-service` depuis un seul `local` — c'est la sortie
`log_retention_days`. Sans rétention explicite, CloudWatch conserve indéfiniment
et le poste grossit sans jamais apparaître dans une revue.

La ventilation de la dépense par environnement dans Cost Explorer dépend en
revanche d'une activation faite **une fois pour le compte**, portée par
`envs/prod` : voir [modules/budgets/README.md](../../modules/budgets/README.md).

## Comment un push sur `develop` déploie

Trois contraintes se croisent ici, et c'est leur intersection qui dicte le
montage :

1. les dépôts ECR sont **immuables** (`modules/ecr`) — une étiquette mobile du
   genre `:develop` ne peut être poussée qu'une fois ;
2. la définition de tâche appartient à **l'état Terraform** — la modifier hors
   Terraform la ferait revenir en arrière au plan suivant ;
3. le rôle de déploiement OIDC n'a **pas** `ecs:RegisterTaskDefinition` — il ne
   peut donc pas publier une révision pointant sur la nouvelle image.

`deploy-dev.yml` en tire la seule séquence qui tienne :

1. rôle de **déploiement** : construire et pousser `spa-dev-api:<sha>` ;
2. rôle **Terraform** : `terraform apply -var="image_tag=<sha>"` **ciblé** sur
   `aws_ecs_task_definition.migrate` — le schéma doit être migré avant que les
   nouvelles tâches ne démarrent ;
3. rôle de **déploiement** : `ecs run-task` sur `spa-dev-migrate`, attente de
   l'arrêt, vérification du code de sortie ;
4. rôle **Terraform** : `terraform apply -var="image_tag=<sha>"` complet — le
   service passe à la nouvelle révision, ECS déroule un déploiement rolling avec
   `minimum_healthy_percent = 100`, donc sans coupure ;
5. `ecs wait services-stable`, puis contrôle de santé sur `/health`.

**Conséquence à connaître** : `image_tag` n'a pas de défaut déployable. Un
`terraform plan` ou `apply` lancé à la main sans `-var image_tag` propose de
ramener le service à l'étiquette d'amorçage — reprendre d'abord la valeur de la
sortie `api_image`. C'est le prix de la contrainte 3 : le jour où le rôle de
déploiement saura publier une révision de définition de tâche, ou le module
`ecs-service` ignorer l'image, l'étiquette sortira de l'état et ce piège avec.

## Ce qui reste à faire

- `apps/web` ne porte encore aucun `next.config.*` : son dépôt ECR existe, mais
  ni son image ni son service ECS ne sont créés. Le service s'ajoutera dans
  `services` quand le front démarrera.
- Le certificat, le secret d'exécution et la définition de tâche de migration
  sont déclarés ici faute de module. Ils ont vocation à en devenir un —
  `modules/ecs-service` pour la tâche de migration, un module `dns` pour le
  certificat.
- Aucune alarme CloudWatch n'est posée : le module `observability` n'existe pas
  encore (skill aws-infra §8). Le topic `spa-dev-budget-alerts` créé par
  `budgets` est fait pour les accueillir — les alarmes n'ont pas à créer un
  second canal.
- `terraform fmt -check` et `terraform validate` sont joués à chaque pull request
  par le job « Format et validation » de `terraform.yml`. En revanche **aucun
  `apply` réel n'a eu lieu** et aucun appel AWS n'a été fait : la machine du run
  n'a ni `terraform` installé ni compte joignable. Le premier `apply` reste donc
  la première vérification de bout en bout — il est suivi en #200.
