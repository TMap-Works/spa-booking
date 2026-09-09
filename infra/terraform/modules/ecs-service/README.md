# ecs-service — cluster Fargate, ALB, services, auto-scaling

Exécution des conteneurs applicatifs (CDC §4.4). Un appel du module produit **un
cluster, un ALB et autant de services que d'applications** — `api` et `web` pour
le MVP — plutôt qu'un appel par application : les deux se partagent le même
répartiteur de charge, et un ALB par service triplerait la facture de la couche
d'entrée pour rien.

Le module ne porte **aucune valeur spécifique à un environnement** : ce qui varie
est une variable. La composition se fait dans `envs/{dev,staging,prod}`, qui lui
passe les sorties du module [`network`](../network/README.md) — le module ne
relit jamais le réseau par une `data`, ce qui le ferait dépendre d'un ordre
d'exécution que rien ne garantit.

## Ce qu'il crée

| Ressource | Nombre | Rôle |
|---|---|---|
| Cluster ECS | 1 | `spa-{env}-cluster`, fournisseur de capacité `FARGATE` seul |
| Application Load Balancer | 1 | Public, sur les sous-réseaux publics, deux zones |
| Listener 80 | 1 | Redirection permanente vers 443, aucune requête applicative en clair |
| Listener 443 | 1 | Terminaison TLS par certificat ACM, action par défaut `404` |
| Groupes de sécurité | 2 | `…-alb`, `…-tasks` |
| Groupe cible | 1 par service | `target_type = "ip"`, imposé par `awsvpc` |
| Règle d'écoute | 1 par service | Routage par `host_headers` et/ou `path_patterns` |
| Groupe de journaux | 1 par service | `/ecs/spa-{env}/{service}`, rétention explicite |
| Rôle IAM | 2 par service | Exécution **et** tâche, jamais un seul |
| Définition de tâche | 1 par service | Un conteneur, secrets par ARN — plus le sidecar `xray-daemon` si le traçage est activé |
| Politique de rôle de tâche | 1 par service tracé | `xray:PutTraceSegments` et les quatre actions qui l'accompagnent |
| Service ECS | 1 par service | Rolling à 100 %, disjoncteur de déploiement armé |
| Cible + politique d'auto-scaling | 1 par service | Suivi de cible sur le CPU |

Aucun fournisseur de capacité EC2 n'est déclaré : ce qui n'existe pas ne peut pas
être choisi par distraction dans une définition de service, et le parc reste sans
instance à administrer ni à corriger.

## La chaîne de trafic

```
   Internet
      │  443 (et 80, redirigé)
      ▼
   ┌───────────────┐   sg spa-{env}-alb
   │      ALB      │   seul 0.0.0.0/0 entrant légitime du dépôt
   └───────┬───────┘
           │  port applicatif, par id de groupe
           ▼
   ┌───────────────┐   sg spa-{env}-tasks
   │ Tâches Fargate│   sous-réseaux app, assign_public_ip = false
   └───────┬───────┘
           │  443 sortant (ECR, Secrets Manager, Logs, Stripe)
           │  + task_egress_rules
           ▼
   RDS 5432 · Redis 6379   sous-réseaux data
```

Le saut ALB → tâches est référencé **par identifiant de groupe de sécurité,
jamais par bloc CIDR** (skill `aws-infra` §4), et il en va de même des sorties
vers la base et le cache dès lors que l'environnement leur passe un groupe. Il
reste deux `0.0.0.0/0`, tous deux inévitables : l'entrée publique de l'ALB, qui
n'a pas de liste d'adresses clientes connue, et la sortie 443 des tâches, qui
tire l'image, résout les secrets et pousse les journaux. Rien en IPv6 : le VPC
du module `network` n'a pas de bloc IPv6, l'ALB reste donc `ipv4`.

Les tâches n'ont pas d'adresse publique : les joindre passe obligatoirement par
l'ALB.

Le sens de la dernière règle est délibéré. Le module `ecs-service` déclare la
**sortie** vers la base et le cache, via `task_egress_rules` ; les modules
`database` et `cache` déclarent leur **entrée** depuis `tasks_security_group_id`.
Aucun des deux ne dépend de l'autre, et le cycle entre modules n'existe pas.

## Deux rôles par service, jamais un seul

| Rôle | Qui l'utilise | Ce qu'il autorise |
|---|---|---|
| `…-{service}-exec` | l'agent ECS, **avant** le démarrage du conteneur | tirer l'image du dépôt ECR du service, lire ses secrets, ouvrir son flux de journaux |
| `…-{service}-task` | l'application, **une fois démarrée** | rien par défaut ; ce que `task_role_policy_arns` lui accorde |

Les confondre donne au code applicatif le droit de lire tous les secrets du
service et de tirer n'importe quelle image — exactement ce que cherche un
attaquant qui a obtenu une exécution de code dans le conteneur.

La politique d'exécution est écrite ici plutôt qu'empruntée à la politique gérée
`AmazonECSTaskExecutionRolePolicy` : celle-ci autorise le tirage de *tout* dépôt
ECR du compte et l'écriture dans *tout* groupe de journaux. Celle du module cible
le dépôt du service (`ecr_repository_arn`, sans défaut) et son seul groupe de
journaux. Un unique `Resource: "*"` subsiste, sur `ecr:GetAuthorizationToken` :
cette action ne porte sur aucune ressource nommable.

La politique d'endossement porte les deux conditions de garde contre le député
confus — `aws:SourceArn` et `aws:SourceAccount`. Sans elles, le service ECS de
n'importe quel compte AWS peut demander l'endossement de ces rôles.

## Déploiement sans coupure

`deployment_minimum_healthy_percent = 100` et `deployment_maximum_percent = 200` :
ECS démarre les nouvelles tâches, attend qu'elles soient saines pour l'ALB, puis
retire les anciennes. À 50 %, la moitié du service disparaît pendant chaque
déploiement, et une montée en charge concomitante se paie en erreurs.

Le disjoncteur (`deployment_circuit_breaker`, `rollback = true`) est armé. Sans
lui, un déploiement dont les tâches ne passent jamais le health check tourne
jusqu'au délai maximal, le service reste marqué « en cours de déploiement » et le
suivant est refusé.

`deregistration_delay = 30` sur les groupes cibles : le défaut de 300 s allonge
chaque vague d'un rolling update de cinq minutes sans rien protéger de plus
qu'une API HTTP n'a besoin.

## Auto-scaling

Suivi de cible sur `ECSServiceAverageCPUUtilization`, à `cpu_target_utilization`
(60 % par défaut, CDC §4.4), entre `min_capacity` et `max_capacity`. Le défaut
est 2 → 8, c'est-à-dire le dimensionnement de production ; dev et staging
l'abaissent, deux tâches par service y étant un plancher de facturation et non
un besoin. L'asymétrie des délais est voulue : `scale_out_cooldown` à 60 s,
`scale_in_cooldown` à 300 s. On monte vite, on redescend lentement ; une
réduction trop prompte fait osciller le service sur une charge en dents de scie,
et chaque oscillation se paie en démarrages à froid.

C'est Application Auto Scaling qui détient `desired_count` une fois le service
créé, d'où l'`ignore_changes = [desired_count]` posé sur le service. Sans cette
exclusion, chaque `apply` ramènerait le service à sa valeur initiale —
c'est-à-dire réduirait la capacité en pleine charge.

## Arrêt hors heures ouvrées

« Dev et staging dimensionnés a minima et **arrêtables hors heures ouvrées** »
(skill aws-infra §9, CDC §4.16). `off_hours_shutdown` le pose en Terraform, ce
qui n'est pas un détail : un environnement qu'on éteint à la main reste allumé
le soir où personne n'y pense.

```hcl
off_hours_shutdown = {
  stop_cron  = "cron(0 20 ? * MON-FRI *)"   # 20 h, du lundi au vendredi
  start_cron = "cron(0 7 ? * MON-FRI *)"    # 7 h, du lundi au vendredi
  timezone   = "Europe/Paris"
}
```

Deux actions planifiées par service, posées sur la **cible** d'auto-scaling et
non sur le service : l'arrêt y écrit `min_capacity = max_capacity = 0`, la
reprise y restaure les bornes déclarées dans `services`. Le week-end reste éteint
de lui-même — l'arrêt du vendredi soir n'est suivi d'aucun démarrage avant lundi.

Zéro des **deux** côtés, et pas seulement du minimum : un maximum non nul
laisserait la politique de suivi de cible faire remonter le service à la première
métrique de CPU.

Trois choses à savoir :

1. **Rien d'autre ne s'arrête.** ALB, base, cache, endpoints d'interface et NAT
   Gateway continuent d'être facturés. Ce réglage coupe le calcul, pas
   l'environnement. Arrêter la base est une décision distincte : RDS redémarre de
   lui-même toute instance arrêtée depuis sept jours, et une tâche de migration
   jouée par un déploiement de nuit échouerait sur une base éteinte.
2. **Un `terraform apply` réveille l'environnement.** Une action planifiée
   modifie la cible elle-même : après l'arrêt du soir, elle porte `0/0` là où
   l'état déclare les capacités du service, et le `apply` suivant les rétablit —
   Application Auto Scaling redémarre alors les tâches manquantes. C'est le
   comportement voulu, un déploiement de nuit devant aboutir, mais `plan` montre
   cette dérive-là toutes les nuits.
3. Les expressions sont des crons **Application Auto Scaling** : six champs,
   année comprise, et non la forme à cinq champs d'un crontab Unix.

Pour lever l'arrêt ponctuellement, sans toucher au code :

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id "service/<cluster>/<service>" --min-capacity 1 --max-capacity 2
```

La prochaine action planifiée reprendra la main. Pour le lever durablement,
repasser `off_hours_shutdown` à `null` et appliquer.

## Secrets

Les valeurs sensibles arrivent par **ARN Secrets Manager**, dans le bloc
`secrets` de la définition de tâche, résolues par l'agent ECS au démarrage. Seul
l'ARN y figure : la *valeur* du secret ne transite ni par l'état Terraform, ni
par la définition de tâche, ni par la console ECS.

Trois gardes refusent l'erreur au `plan` plutôt qu'à l'`apply` :

- un nom de variable de `environment` qui sonne comme un secret (`password`,
  `secret`, `credential`, `private_key`, `…_token`) arrête le plan — le bloc
  `environment` est lisible par quiconque a accès à la console ECS ;
- une entrée de `secret_arns` qui n'est pas un ARN `secretsmanager` arrête le
  plan, ce qui attrape la valeur du secret collée à la place de son ARN ;
- le couple `cpu` / `memory` est confronté aux combinaisons Fargate admises, et
  l'erreur nomme le service fautif et énumère ce qui est possible — là où l'API
  répond « Invalid CPU or Memory value specified » sans dire laquelle des deux
  est en cause.

Un ARN de `valueFrom` peut porter un suffixe `:clé-json:étiquette:version` ; IAM
n'accepte que les sept premiers champs. Le module tronque de lui-même avant
d'écrire la politique — accorder le droit sur l'ARN suffixé produirait une
politique qui n'autorise rien, et un démarrage de tâche en échec.

## L'origine publique n'est pas un secret (#345)

Un conteneur a presque toujours besoin de savoir sous quelle origine il est
servi : le front y compose ses balises canoniques et ses données structurées,
l'API y compose les liens de ses notifications. Cette valeur est publique par
définition — et elle passait pourtant par Secrets Manager, faute de pouvoir être
calculée ailleurs : elle vaut l'URL de l'ALB, que seul ce module connaît, et lire
sa sortie `alb_dns_name` pour construire son entrée `services` est un cycle que
Terraform refuse.

Le module la calcule donc lui-même. Vu du graphe, la définition de tâche dépend
de l'ALB — une arête de plus, dans le seul sens qui existe.

```hcl
public_base_url = null            # défaut : https://<alb_dns_name>

services = {
  web = {
    # …
    public_url_env_vars = ["APP_URL", "API_URL"]
  }
}
```

Chaque nom listé reçoit l'origine, en clair dans `environment` — ce qu'elle
mérite. Deux gardes au plan : le nom doit ressembler à une variable
d'environnement (`^[A-Z][A-Z0-9_]*$`), et il ne doit apparaître ni dans
`environment` ni dans `secret_arns` du même service — une même clé des deux côtés
fait refuser la définition de tâche par l'API ECS, sur un message qui ne dit pas
laquelle.

`public_base_url` se renseigne dès qu'un nom de domaine existe : le nom DNS d'un
ALB n'est pas une adresse à publier, et il change si l'ALB est recréé. La sortie
`public_base_url` rend la valeur effective, `public_url_env_vars` dit quel service
la reçoit et sous quels noms.

## Traçage X-Ray

`xray_tracing_enabled = true` sur un service ajoute à sa tâche un second
conteneur, `xray-daemon`, et accorde à son **rôle de tâche** le droit de publier
des segments. C'est tout ce que l'infrastructure peut faire : X-Ray ne s'active
pas sur un service comme une case à cocher, il se collecte.

Le SDK X-Ray n'appelle pas l'API AWS. Il envoie ses segments en **UDP sur
127.0.0.1:2000**, où ce démon les agrège avant de les publier. Trois
conséquences :

- sans le sidecar, le code instrumenté écrit dans le vide et ne lève jamais
  d'erreur — la panne la plus silencieuse de la chaîne ;
- le démon est déclaré `essential = false` : s'il meurt, la tâche applicative
  continue. Perdre des traces dégrade le diagnostic, perdre le service coupe les
  réservations ;
- il ne réserve ni CPU ni mémoire. En Fargate, un conteneur sans réservation
  puise dans l'allocation de la tâche ; en fixer une les retirerait à
  l'application sur les gabarits où `cpu = 256` ne laisse pas cette marge.

Le module pose aussi trois variables dans l'environnement du conteneur
applicatif :

- `AWS_XRAY_DAEMON_ADDRESS=127.0.0.1:2000` — où le SDK émet ses segments ;
- `AWS_XRAY_CONTEXT_MISSING=LOG_ERROR` — au défaut `RUNTIME_ERROR`, une
  opération hors contexte de trace (un travail de fond, un appel au démarrage)
  ferait **lever l'application**. Le traçage observe, il n'arbitre pas ;
- `AWS_XRAY_TRACING_NAME=spa-{env}-{service}` — le **nom de service** déclaré
  par le SDK. C'est sur lui que la règle d'échantillonnage du module
  `observability` filtre (`spa-{env}-*`) : sans lui, la règle ne gouverne rien
  et X-Ray retombe sans bruit sur sa règle `Default`, commune aux trois
  environnements qui partagent le compte.

Ce que le module ne fait pas : la règle d'échantillonnage, qui est une ressource
de compte et vit dans le module `observability` ; et l'ouverture des segments par
le code, qui appartient à `apps/api`. Tant que l'API n'est pas instrumentée, la
sortie `xray_traced_services` liste bien le service, et la console X-Ray reste
vide — ce n'est pas une panne d'infrastructure.

## Variables

| Variable | Type | Défaut | Rôle |
|---|---|---|---|
| `environment` | `string` | — | Préfixe de nom, `spa-{environment}-…` |
| `vpc_id` | `string` | — | Sortie `vpc_id` du module `network` |
| `public_subnet_ids` | `list(string)` | — | ALB — deux zones au minimum |
| `app_subnet_ids` | `list(string)` | — | Tâches Fargate — jamais les sous-réseaux `data` |
| `certificate_arn` | `string` | — | Certificat ACM du listener 443, à SAN multiples |
| `ssl_policy` | `string` | `ELBSecurityPolicy-TLS13-1-2-2021-06` | TLS 1.2 et 1.3 seulement |
| `public_base_url` | `string` | `null` | Origine publique injectée dans `public_url_env_vars` ; `null` = `https://<alb_dns_name>` |
| `services` | `map(object)` | — | Une entrée par application, voir ci-dessous |
| `cpu_target_utilization` | `number` | `60` | Cible d'auto-scaling, en pourcentage |
| `scale_out_cooldown_seconds` | `number` | `60` | Délai avant une nouvelle montée |
| `scale_in_cooldown_seconds` | `number` | `300` | Délai avant une nouvelle descente |
| `off_hours_shutdown` | `object` | `null` | Arrêt programmé hors heures ouvrées ; `null` en production |
| `log_retention_days` | `number` | `30` | 30 en dev et staging, 90 en production |
| `container_insights_enabled` | `bool` | `false` | Facturé à la métrique ; production et staging |
| `kms_key_arn` | `string` | `null` | Chiffre journaux et secrets ; `null` = clé gérée par AWS |
| `alb_deletion_protection` | `bool` | `false` | `true` en production |
| `alb_idle_timeout_seconds` | `number` | `60` | Doit rester sous le keep-alive applicatif |
| `task_egress_rules` | `map(object)` | `{}` | Sorties vers PostgreSQL, Redis |
| `xray_daemon_image` | `string` | `public.ecr.aws/xray/aws-xray-daemon:3.x` | Sidecar de traçage ; registre public, aucun droit de tirage à accorder |

La clé de `services` sert de nom de conteneur, de famille de définition de tâche
et de suffixe à toutes les ressources du service. Trois attributs sont
obligatoires — `image`, `ecr_repository_arn` et `listener_rule_priority`, unique
par ALB. Les autres ont un défaut aligné sur le CDC : port `3000`, 512 CPU /
1024 Mio, 2 tâches, 2 → 8 en auto-scaling, health check sur `/health`.

Chaque service doit porter au moins un `host_headers` ou un `path_patterns` :
une règle d'écoute sans condition est refusée par l'API, et une précondition le
dit au plan.

## Sorties

`cluster_id`, `cluster_name`, `cluster_arn`, `alb_arn`, `alb_arn_suffix`,
`alb_dns_name`, `alb_zone_id`, `alb_security_group_id`, `https_listener_arn`,
`tasks_security_group_id`, `service_names`, `service_arns`,
`task_definition_arns`, `task_role_arns`, `task_role_names`,
`execution_role_arns`, `target_group_arns`, `target_group_arn_suffixes`,
`log_group_names`, `xray_traced_services`, `public_base_url`,
`public_url_env_vars`, `off_hours_shutdown_enabled`, `off_hours_schedule`,
`off_hours_scheduled_action_names`.

Les sorties par service sont des maps indexées sur la clé de `services`. Cinq
d'entre elles servent aux modules voisins, en trois usages :

- `tasks_security_group_id` — ce que `database` et `cache` autorisent en entrée ;
- `alb_arn_suffix` et `target_group_arn_suffixes` — les dimensions qu'attendent
  les métriques CloudWatch, donc les alarmes 5xx et latence p99 du module
  `observability` ;
- `alb_dns_name` et `alb_zone_id` — la cible d'un alias Route 53.

## Utilisation

```hcl
module "ecs" {
  source = "../../modules/ecs-service"

  environment       = "prod"
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  app_subnet_ids    = module.network.app_subnet_ids
  certificate_arn   = aws_acm_certificate.public.arn

  log_retention_days         = 90
  container_insights_enabled = true
  alb_deletion_protection    = true

  # Un domaine existe ici : l'origine ne se déduit plus du nom DNS de l'ALB.
  public_base_url = "https://exemple.com"

  services = {
    api = {
      image                  = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
      ecr_repository_arn     = aws_ecr_repository.api.arn
      listener_rule_priority = 10
      host_headers           = ["api.exemple.com"]
      min_capacity           = 2
      max_capacity           = 8

      environment = {
        NODE_ENV = "production"
        TZ       = "UTC"
      }

      secret_arns = {
        DATABASE_URL          = aws_secretsmanager_secret.database_url.arn
        STRIPE_SECRET_KEY     = aws_secretsmanager_secret.stripe.arn
        STRIPE_WEBHOOK_SECRET = aws_secretsmanager_secret.stripe_webhook.arn
      }
    }

    web = {
      image                  = "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}"
      ecr_repository_arn     = aws_ecr_repository.web.arn
      listener_rule_priority = 20
      host_headers           = ["exemple.com", "www.exemple.com"]

      # L'origine sous laquelle le front est servi, calculée par le module.
      public_url_env_vars = ["APP_URL"]
    }
  }

  task_egress_rules = {
    postgres = {
      description                  = "Vers PostgreSQL"
      port                         = 5432
      referenced_security_group_id = module.database.security_group_id
    }
    redis = {
      description                  = "Vers Redis"
      port                         = 6379
      referenced_security_group_id = module.cache.security_group_id
    }
  }
}
```

## À savoir avant de modifier

- **Le health check n'est utile que si `/health` vérifie réellement la base et le
  cache.** Un `200` inconditionnel laisse en service une tâche qui ne peut plus
  rien servir, et le disjoncteur de déploiement ne voit rien à rejeter. Le
  contrat côté application ne relève pas de ce module, mais il en conditionne
  l'intérêt.
- La description d'un groupe de sécurité et celle d'une règle sont les seuls
  champs du module où l'accent et l'apostrophe sont interdits : l'API EC2 les
  rejette et fait échouer l'`apply`. C'est pourquoi `task_egress_rules` valide la
  description qu'on lui passe. Les étiquettes, elles, acceptent l'Unicode.
- Les listes `environment` et `secrets` de la définition de tâche sont triées sur
  le nom. Sans ordre stable, chaque plan réécrirait la définition de tâche et
  déclencherait un déploiement pour rien.
- L'ARN d'un groupe de journaux porte déjà un suffixe `:*` ; la politique
  d'exécution reconstruit l'ARN au lieu de le lire, sans quoi le `:*` concaténé
  deux fois produit une politique qui n'autorise rien.
- Le nom d'un groupe cible est borné à 32 caractères par l'API. Une précondition
  le contrôle et nomme le coupable — un `environment` long et une clé de service
  longue s'additionnent.
- **Aucune clé de `for_each` ne dérive d'un ARN de ressource.**
  `task_role_policy_arns` est indexé sur le rang, pas sur l'ARN : l'environnement
  passe des politiques qu'il crée lui-même, dont l'ARN est inconnu au plan, et
  une clé construite dessus arrête Terraform avant d'avoir planifié quoi que ce
  soit. Même raison pour la garde du bloc `secrets` de la politique
  d'exécution, qui compte des clés de map et non des ARN.
- `skip_destroy = true` sur les définitions de tâche laisse les révisions
  précédentes `ACTIVE`. C'est ce qui donne une cible au retour arrière du
  disjoncteur de déploiement : on ne démarre pas de tâche depuis une révision
  `INACTIVE`.
- Le service dépend explicitement de `aws_iam_role_policy.execution`. La
  définition de tâche ne référence que le *rôle*, pas sa politique : sans cette
  arête, le premier déploiement peut partir avant elle et échouer sur
  `CannotPullContainerError`.
- `container_ports` déduplique les ports : deux services qui écoutent le même
  port partagent une règle de groupe de sécurité au lieu d'en ajouter une
  identique.
- Le module ne déclare pas de `provider` : les étiquettes obligatoires
  (`Project`, `Environment`, `ManagedBy`, `Owner`) viennent du `default_tags` de
  l'environnement appelant. Chaque ressource n'ajoute qu'un `Name`.
