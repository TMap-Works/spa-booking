# observability — alarmes, tableau de bord et traçage

Ce module pose la supervision minimale exigée avant tout go-live (CDC §4.11,
skill aws-infra §8) : les alarmes CloudWatch des sept pannes qui arrêtent la
plateforme, un tableau de bord transverse pour les regarder venir, et la règle
d'échantillonnage X-Ray de l'environnement.

Il **n'ouvre aucun canal de notification** : il se branche sur le topic SNS que
le module `budgets` crée déjà. Un second topic voudrait dire un second jeu
d'abonnements à confirmer, et une astreinte qui reçoit deux fois la même panne
par deux chemins finit par filtrer les deux.

## Ce qu'il crée

| Ressource | Nom | Déclenchée par |
|---|---|---|
| Alarme | `spa-{env}-alb-5xx-rate` | Plus de 1 % de réponses 5xx, au-delà d'un plancher de trafic |
| Alarme | `spa-{env}-alb-latency-p99` | Latence au 99e centile au-dessus de 2 s |
| Alarme | `spa-{env}-ecs-{service}-cpu` | CPU au-dessus de 80 % pendant dix minutes |
| Alarme | `spa-{env}-rds-connections` | Connexions au-dessus de 80 % du maximum du moteur |
| Alarme | `spa-{env}-rds-free-storage` | Espace disque libre sous 20 % du volume provisionné |
| Alarme | `spa-{env}-{clé}-dlq-depth` | Un seul message en file d'attente morte |
| Alarme | `spa-{env}-{clé}-errors` | Une seule erreur de fonction Lambda |
| Tableau de bord | `spa-{env}-supervision` | — |
| Règle d'échantillonnage X-Ray | `spa-{env}-api` | — |

Chaque famille est facultative : ce que l'environnement ne compose pas n'est pas
supervisé, et rien n'est créé pour lui.

## Composition

```hcl
module "observability" {
  source = "../../modules/observability"

  environment      = local.environment
  alarm_topic_arns = [module.budgets.alerts_topic_arn]

  alb = {
    arn_suffix = module.ecs_service.alb_arn_suffix
  }

  ecs = {
    cluster_name  = module.ecs_service.cluster_name
    service_names = module.ecs_service.service_names
  }

  rds = {
    instance_id           = module.database.instance_id
    allocated_storage_gib = module.database.allocated_storage
    max_connections       = 450
  }
}
```

## Pourquoi des objets nullables plutôt que des variables scalaires

`alb.arn_suffix` est un attribut calculé de l'ALB : sa valeur est **inconnue au
plan** du premier `apply`. Une variable scalaire `alb_arn_suffix` obligerait à
écrire `count = var.alb_arn_suffix == null ? 0 : 1`, c'est-à-dire à comparer une
valeur inconnue — et Terraform s'arrête là-dessus, avant même de planifier :

```
Error: Invalid count argument
The "count" value depends on resource attributes that cannot be determined
until apply.
```

La nullité de l'**objet**, elle, se lit dans la configuration de l'appelant :
elle est connue au plan, même quand tous ses attributs sont inconnus. C'est la
seule raison de cette forme, et elle vaut aussi pour `ecs` et `rds`.

## Le nombre maximal de connexions se dit, il ne se déduit pas

`rds.max_connections` est le seul paramètre du module qu'aucune sortie ne
fournit. RDS calcule cette valeur à partir de la mémoire de l'instance —
`LEAST({DBInstanceClassMemory/9531392}, 5000)` pour PostgreSQL — et ne la publie
sous aucune métrique CloudWatch. Sur `db.t4g.medium` (4 Gio), cela fait environ
**450** connexions.

Conséquence à retenir : **changer `instance_class` change ce maximum**, et le
seuil de l'alarme cesse alors de valoir 80 %. L'environnement doit revoir la
valeur en même temps que le dimensionnement de sa base. La sortie
`rds_connections_threshold` donne le nombre effectivement posé, pour le vérifier
sans ouvrir la console.

## Les seuils, et pourquoi ils sont là où ils sont

**5xx en pourcentage, pas en compte.** Dix erreurs sur cent mille requêtes ne
sont pas un incident ; dix sur deux cents en sont un. L'alarme additionne
`HTTPCode_Target_5XX_Count` — l'application a répondu 500 — et
`HTTPCode_ELB_5XX_Count` — l'ALB n'a trouvé personne à qui parler. Ne compter que
le premier laisserait invisible le cas le plus grave.

**Un plancher de trafic.** Sans lui, une seule requête en erreur sur une seule
requête servie fait 100 % de 5xx et réveille l'astreinte pour un robot
d'indexation tombé sur une URL morte. `alb.min_requests_per_period` vaut 20 par
défaut.

**p99 et non moyenne.** Une moyenne à 300 ms recouvre sans peine une requête sur
cent à huit secondes — et c'est celle-là qui fait abandonner la réservation.

**Dix minutes de CPU, pas cinq.** L'auto-scaling vise 60 % : un pic bref est le
fonctionnement normal du service, pas un incident. Deux périodes de cinq minutes
au-dessus de 80 % veulent dire que la montée en charge n'a pas suffi — ou qu'elle
a atteint `max_capacity`.

**20 % d'espace libre, pas 10 %.** RDS n'étend le volume de lui-même qu'en
dessous de 10 %, et l'opération prend plusieurs minutes. À 20 %, il reste le
temps de comprendre pourquoi le disque se remplit. Le pourcentage porte sur le
volume **provisionné** — sortie `allocated_storage` du module `database` — et non
sur `max_allocated_storage` : un pourcentage du plafond d'extension décrirait un
disque qui n'existe pas encore.

**Zéro message en DLQ.** Une file d'attente morte n'a pas de profondeur
acceptable : ce qui s'y trouve a épuisé ses tentatives et ne repartira pas sans
intervention.

## Les files et les fonctions, et pourquoi elles sont vides ici

`dead_letter_queues` et `lambda_functions` sont vides par défaut, et le restent
sur les environnements d'aujourd'hui. La seule chaîne asynchrone du projet est
celle des notifications, et le module `notifications` pose déjà les alarmes de sa
DLQ et de sa Lambda (#67), avec les descriptions qui nomment ses pannes à elle.
Les reposer ici enverrait deux notifications pour le même message.

Ces deux entrées existent pour la file suivante — celle qui n'aura pas de module
à elle — et pour que les sept lignes du tableau du CDC §4.11 soient couvertes par
un seul module, quel que soit l'endroit d'où on les lit.

## Traçage X-Ray — ce que ce module fait, et ce qu'il ne fait pas

Le traçage tient en trois pièces, et ce module n'en porte qu'une :

| Pièce | Où |
|---|---|
| Règle d'échantillonnage | **ici** — `aws_xray_sampling_rule` |
| Sidecar `aws-xray-daemon` dans la tâche | module `ecs-service`, `xray_tracing_enabled` |
| Droit `xray:PutTraceSegments` sur le rôle de tâche | module `ecs-service`, même interrupteur |
| Ouverture des segments par le code | `apps/api` — **pas encore fait** |

Tant que l'API n'ouvre pas de segment, le démon tourne et ne reçoit rien : la
console X-Ray reste vide, et ce n'est pas une panne d'infrastructure. L'ordre est
délibéré — le chemin de collecte existe et est éprouvé avant qu'on instrumente le
code, plutôt que l'inverse.

La règle filtre sur `spa-{env}-*` et non sur `*` : les trois environnements
partagent un compte AWS, donc un jeu de règles d'échantillonnage. Une règle en
`*` posée par `dev` gouvernerait le traçage de la production.

Ce filtre porte sur le **nom de service déclaré par le SDK**, pas sur le nom du
service ECS : les deux ne coïncident que parce que `ecs-service` pose
`AWS_XRAY_TRACING_NAME=spa-{env}-{service}` sur les tâches tracées. Changer l'un
sans l'autre ne casse rien de visible — la règle cesse simplement de trouver un
service à gouverner, et X-Ray retombe sur sa règle `Default` (1 requête par
seconde puis 5 %, pour tout le compte).

## Rétention des journaux

Ce module ne crée aucun groupe de journaux, et n'a donc pas de rétention à poser.
La rétention se règle là où les groupes se créent — `ecs-service`, `database`,
`cache`, `notifications` —, à partir du `log_retention_days` que chaque
environnement leur passe : 30 jours hors production, 90 en production
(skill aws-infra §8). La sortie `log_retention_days` de l'environnement rend la
valeur vérifiable sans ouvrir un module.

## Vérifier

```bash
# Les alarmes existent et ont un destinataire
terraform output alarm_names
terraform output alarms_notify     # false = elles ne préviennent personne

# Le seuil de connexions correspond bien au dimensionnement de la base
terraform output rds_connections_threshold

# État courant, sans ouvrir la console
aws cloudwatch describe-alarms \
  --alarm-name-prefix "spa-dev-" \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

# Une alarme se vérifie en la forçant, jamais en attendant la panne
aws cloudwatch set-alarm-state --alarm-name spa-dev-rds-connections \
  --state-value ALARM --state-reason "test de la chaine de notification"
```

Le dernier appel est le seul moyen de prouver que la chaîne complète fonctionne —
alarme, topic, abonnement confirmé, boîte de réception. Une alarme qui n'a jamais
changé d'état n'a jamais rien prouvé.
