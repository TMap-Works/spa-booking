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
| Domaine SES, DKIM/SPF/DMARC, topic des rebonds | `spa-dev-email`, `spa-dev-ses-events` | `notifications` — **rien sans `notification_domain`** |
| File de découplage, DLQ, Lambda d'envoi, 4 alarmes | `spa-dev-notifications`, `spa-dev-notification-dispatcher` | `notifications` — idem |
| 5 alarmes, tableau de bord, règle d'échantillonnage X-Ray | `spa-dev-supervision`, `spa-dev-api` | `observability` |
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
  "JWT_REFRESH_SECRET": "<32 caractères au moins, différent du précédent>",
  "NOTIFICATIONS_INTERNAL_TOKEN": "<32 caractères au moins — la même valeur que le secret notification_dispatch_token_secret_arn>"
}
```

- le mot de passe se lit dans le secret `database_master_user_secret_arn`, déposé
  par RDS lui-même ;
- le jeton AUTH se lit dans `redis_auth_token_secret_arn` ;
- `JWT_SECRET` et `JWT_REFRESH_SECRET` doivent **différer** — l'API refuse de
  démarrer sinon (`apps/api/src/config/env.schema.ts`) ;
- `NOTIFICATIONS_INTERNAL_TOKEN` n'est exigé qu'à partir du moment où l'une des
  routes internes est branchée — `notification_dispatch_url`,
  `notification_reminder_sweep_url` ou `notification_delivery_events_url` : la
  définition de tâche ne résout cette clé que dans ce cas, et une clé absente du
  JSON empêcherait sinon la tâche de démarrer pour une capacité inutilisée. **À
  déposer avant l'`apply` qui pose la première des trois URL**, jamais après.
  C'est le **même** jeton que celui
  déposé dans
  `notification_dispatch_token_secret_arn` : les trois fonctions Lambda de la
  chaîne le présentent à l'API dans l'en-tête `x-internal-token`, et l'API le
  compare à cette valeur. Absent, la route de balayage du rappel J-1 répond 503
  et **aucun rappel ne part** ; la route d'ingestion des rebonds répond 503 elle
  aussi, chaque événement est traité en échec transitoire et **aucune adresse
  morte n'est supprimée**. C'est un défaut fermé, pas une panne silencieuse : les
  alarmes d'erreurs et de profondeur de DLQ des deux fonctions le disent. L'API
  démarre quand même : une variable de notifications ne conditionne pas les sept
  autres modules (`apps/api/src/modules/notifications/notifications.config.ts`).

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

## Délivrabilité e-mail

Le module `notifications` n'est composé que si `notification_domain` est fourni.
Sans lui, l'environnement s'applique exactement comme avant : aucune identité SES,
aucun topic, aucune clé KMS — donc aucune dépense et aucun conflit.

C'est délibéré. Une identité de domaine SES est unique **par compte et par
région** : un défaut en dur ferait vérifier le même nom depuis les trois états
d'environnement, qui se le disputeraient. Le développement prend son propre
sous-domaine le jour où il en a un :

```bash
terraform apply \
  -var 'notification_domain=dev.mail.exemple.fr' \
  -var 'notification_route53_zone_id=Z0123456789ABCDEFGHIJ' \
  -var 'notification_dmarc_report_uri=rapports-dmarc@exemple.fr'
```

L'adresse de rapport ci-dessus est hors du domaine surveillé : elle exige une
autorisation de destination externe dans la zone de `exemple.fr`, faute de quoi
aucun rapport DMARC n'arrive jamais — l'enregistrement exact est dans
[modules/notifications/README.md](../../modules/notifications/README.md).

Sans `notification_route53_zone_id` — DNS servi ailleurs —, le module publie
quand même tout ce qui est dans AWS et rend la liste des enregistrements à poser
chez le registraire : `terraform output -json notification_dns_records`. Tant
qu'ils ne le sont pas, l'identité reste en attente et **aucun message ne part**.

Deux points ne sont pas dans Terraform parce qu'ils n'y sont pas exprimables — la
**sortie du bac à sable SES** (une demande instruite par le support AWS) et le
**test d'envoi réel** vers Gmail, Outlook et Yahoo. Les deux procédures, commandes
comprises, sont dans
[modules/notifications/README.md](../../modules/notifications/README.md).

## Chaîne d'envoi des notifications

Le même `notification_domain` compose aussi la file de découplage, sa file
d'attente morte, la Lambda d'envoi et les quatre alarmes qui les surveillent.
L'API reçoit alors `NOTIFICATION_QUEUE_URL` dans son environnement de conteneur
et la politique `spa-dev-notifications-producer` sur son rôle de tâche : elle
publie et rend la main, elle n'appelle jamais SES depuis le chemin de requête
HTTP (CDC §4.8).

**La Lambda reste en défaut fermé tant que `notification_dispatch_url` n'est pas
posée.** Ce n'est pas un oubli : la route d'envoi côté API est le périmètre de
#70, et la terminaison TLS de cet environnement est un certificat auto-signé
qu'aucun client ne vérifie sans y être forcé — la fonction refuse de désactiver
la vérification. En attendant, chaque message est rendu à SQS, y épuise ses cinq
réceptions — un quart d'heure au plus, SQS n'espaçant pas les tentatives — puis
part en DLQ, où l'alarme de profondeur le signale : c'est ce qu'on veut voir
d'une chaîne non branchée.

```bash
terraform output notification_dispatch_configured   # false tant que la route manque
terraform output notification_alarms_notify         # true : alarmes sur le topic budgets
terraform output notification_alarm_names
```

Le rejeu de la file d'attente morte, la lecture des journaux structurés et le
contrat exact que la route doit servir sont dans
[modules/notifications/README.md](../../modules/notifications/README.md).

## Rebonds et plaintes

Le chemin de retour de la même chaîne : SES publie ses événements de remise sur
un topic SNS, une file SQS les découple, et une Lambda de relais les fait traiter
par l'API — `notification_delivery_events_url`. C'est ce qui supprime une adresse
morte au lieu de continuer à lui écrire.

**Même défaut fermé que la route d'envoi, et la même façon de le voir.** Tant que
l'URL est nulle, la fonction rend chaque événement à SQS, la DLQ se remplit et
son alarme de profondeur parle. La conséquence, elle, n'est pas symétrique : une
chaîne d'envoi non branchée n'envoie rien, ce qui se remarque tout de suite ; une
chaîne de rebonds non branchée laisse tout partir, y compris vers les adresses
que SES vient de signaler comme mortes — et la réputation d'envoi du domaine,
partagée par tous les établissements, se dégrade sans bruit (CDC §6).

```bash
terraform output notification_delivery_events_configured   # false tant que l'URL manque
terraform output notification_delivery_events_dlq_name     # ce qui se remplit en attendant
terraform output notification_delivery_events_function_name
```

**`NOTIFICATIONS_INTERNAL_TOKEN` est exigé dès que l'une des routes internes est
branchée** — celle-ci, l'envoi ou le balayage du rappel J-1 : la définition de
tâche ne résout cette clé que dans ce cas. Le déposer **avant** l'`apply` qui pose l'URL,
jamais après : sans lui la route répond 503, la Lambda traite chaque événement en
échec transitoire, et la file entière finit en DLQ sans qu'aucune adresse ne soit
supprimée.

## Supervision

Le module `observability` pose les cinq alarmes du CDC §4.11 que cet
environnement peut effectivement porter, toutes branchées sur
`spa-dev-budget-alerts` — le topic du module `budgets`, réemployé plutôt que
doublé :

| Alarme | Se déclenche quand |
|---|---|
| `spa-dev-alb-5xx-rate` | plus de 1 % de 5xx, au-delà de 20 requêtes sur cinq minutes |
| `spa-dev-alb-latency-p99` | une requête sur cent met plus de 2 s |
| `spa-dev-ecs-api-cpu` | le service dépasse 80 % de CPU pendant dix minutes |
| `spa-dev-rds-connections` | plus de 360 connexions ouvertes, soit 80 % des ~450 d'un `db.t4g.medium` |
| `spa-dev-rds-free-storage` | moins de 20 % des 20 Gio provisionnés restent libres |

Les deux alarmes restantes du tableau du CDC — profondeur de DLQ et erreurs
Lambda — sont posées par le module `notifications` sur sa propre chaîne, et ne
sont donc pas reposées ici : deux alarmes sur le même message enverraient deux
notifications.

Le tableau de bord `spa-dev-supervision` regroupe les mêmes indicateurs en
courbes, avec les seuils d'alarme en annotation.

```bash
terraform output observability_alarm_names
terraform output observability_alarms_notify              # true : alarmes sur le topic budgets
terraform output observability_rds_connections_threshold  # 360

# Une alarme se vérifie en la forçant, jamais en attendant la panne
aws cloudwatch set-alarm-state --alarm-name spa-dev-rds-connections \
  --state-value ALARM --state-reason "test de la chaine de notification"
```

**Le seuil de connexions est saisi à la main** (`rds_max_connections` dans
main.tf) : RDS calcule le maximum du moteur à partir de la mémoire de l'instance
et ne le publie sous aucune métrique. Changer `instance_class` oblige à revoir
cette valeur, faute de quoi le seuil cesse de valoir 80 %.

Le traçage X-Ray est activé côté infrastructure — sidecar `aws-xray-daemon` dans
la tâche, droit de publier sur le rôle de tâche, règle d'échantillonnage
`spa-dev-api` à 5 % avec un réservoir d'une requête par seconde. Il manque
l'instrumentation d'`apps/api` : tant qu'aucun segment n'est ouvert, la console
X-Ray reste vide.

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
- Le traçage X-Ray est **collecté mais pas produit** : la tâche porte le sidecar
  `aws-xray-daemon` et son rôle peut publier des segments, mais `apps/api`
  n'ouvre encore aucun segment. La console X-Ray reste donc vide, et ce n'est pas
  une panne d'infrastructure.
- `terraform fmt -check` et `terraform validate` sont joués à chaque pull request
  par le job « Format et validation » de `terraform.yml`. En revanche **aucun
  `apply` réel n'a eu lieu** et aucun appel AWS n'a été fait : la machine du run
  n'a ni `terraform` installé ni compte joignable. Le premier `apply` reste donc
  la première vérification de bout en bout — il est suivi en #200.
