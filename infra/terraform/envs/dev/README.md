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
| Définition de tâche de migration | `spa-dev-migrate` | déclarée ici |
| Secret d'exécution de l'API | `spa-dev/api/runtime-…` | déclarée ici |
| Certificat de terminaison TLS | `spa-dev-alb` | déclarée ici |

## Ordre d'amorçage

1. **`../../bootstrap`** — bucket d'état et table de verrouillage. Sans lui,
   `terraform init` n'a pas de backend.
2. **`../../modules/oidc`**, appliqué par une identité d'administrateur — il crée
   les rôles GitHub Actions. Poser ensuite les variables de dépôt `AWS_REGION`,
   `AWS_DEPLOY_ROLE_ARN`, `AWS_TERRAFORM_ROLE_ARN`, `AWS_TERRAFORM_PLAN_ROLE_ARN`.

   **En l'état, le rôle de déploiement ne fonctionnera pas** : ses ARN sont
   construits sur `cluster/spa-{env}` alors que `modules/ecs-service` nomme le
   cluster `spa-{env}-cluster`, et chaque appel `ecs:DescribeServices`,
   `RunTask`, `DescribeTasks` ou `UpdateService` est refusé. La correction vit
   dans `modules/oidc/main.tf`, hors du périmètre de cet environnement — voir
   l'issue de suivi.
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
  encore (skill aws-infra §8).
- Les ARN ECS du rôle de déploiement (`modules/oidc`) ne correspondent pas au nom
  du cluster : tant que ce n'est pas corrigé, l'étape de migration du workflow
  échoue en `AccessDenied`. Correction hors du périmètre de cet environnement.
- Rien de tout ceci n'a été appliqué : ni `terraform apply`, ni `terraform
  validate`, ni le moindre appel AWS n'ont pu être joués sur la machine qui a
  écrit ce répertoire. Le premier `apply` réel est aussi la première vérification.
