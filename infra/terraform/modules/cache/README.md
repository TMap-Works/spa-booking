# cache — ElastiCache Redis, chiffrement, jeton AUTH

Cache applicatif et verrous d'un environnement (CDC §4.5). Il porte des sessions,
des créneaux calculés et des verrous de réservation — jamais une donnée dont la
perte serait un incident.

Le module ne porte **aucune valeur spécifique à un environnement** : ce qui varie
est une variable. La composition se fait dans `envs/{dev,staging,prod}`, et le
réseau vient des sorties du module `network`.

## Ce qu'il crée

| Ressource | Nombre | Rôle |
|---|---|---|
| Groupe de réplication Redis | 1 | `spa-{env}-redis`, un fragment, `1 + replica_count` nœuds |
| Clé KMS + alias | 0 ou 1 | Créée sauf si `kms_key_arn` est fourni |
| Secret Secrets Manager | 0 ou 1 | Jeton AUTH, si `auth_token_enabled` |
| Groupe de sous-réseaux | 1 | Les sous-réseaux **de données** du VPC |
| Groupe de paramètres | 1 | Politique d'éviction, expiration des connexions inactives |
| Groupe de sécurité | 1 | 6379 depuis les groupes applicatifs, plus la réplication |
| Groupes de journaux CloudWatch | 2 | `slow-log` et `engine-log`, avec rétention explicite |

Un seul fragment, pas de mode clusterisé : le MVP n'a pas le volume qui le
justifierait, et le mode non fragmenté garde une connexion cliente ordinaire.
Y passer plus tard change le client autant que l'infrastructure — c'est une
décision à prendre sur des métriques, pas par anticipation.

## Chiffrement : les deux bouts, sans variable

`at_rest_encryption_enabled` et `transit_encryption_enabled` sont posés en dur,
sans variable, y compris en dev. Ce sont des critères d'acceptation du ticket,
pas des réglages d'environnement.

Conséquence côté client : l'URL de connexion est en **`rediss://`**, jamais
`redis://` — un client qui parle en clair est refusé par le nœud. La sortie
`connection_url_scheme` existe pour que l'environnement n'ait pas à le deviner.

Basculer l'un des deux drapeaux sur un cluster existant le fait recréer. Le plan
le montre ; il faut le lire.

## Le jeton AUTH, lui, passe par l'état — et c'est assumé

ElastiCache n'a pas d'équivalent du `manage_master_user_password` de RDS : aucun
moyen de faire engendrer le jeton par le service et de le déposer lui-même dans
Secrets Manager. Le module l'engendre donc avec `random_password` et l'écrit dans
un secret chiffré par la même clé KMS que les données.

**Le jeton se retrouve donc dans l'état Terraform.** Ce qui le protège est le
backend de #136 — bucket chiffré, versionné, accès restreint — et non le module.
C'est la raison pour laquelle il n'apparaît dans aucune sortie : seul
`auth_token_secret_arn` est publié, et qui doit lire le jeton le demande à
Secrets Manager, ce qui laisse une trace CloudTrail que la lecture d'un état ne
laisse pas.

Le rôle de tâche ECS a besoin de `secretsmanager:GetSecretValue` sur ce secret
**et** de `kms:Decrypt` sur `kms_key_arn`. Le second est celui qu'on oublie.

`auth_token_update_strategy = "ROTATE"` ajoute le nouveau jeton avant de retirer
l'ancien : les connexions en cours survivent au changement.

`auth_token_enabled = false` reste possible sur un environnement jetable, et une
précondition l'interdit en production. Le groupe de sécurité protège du reste du
VPC ; le jeton protège de ce qui tourne déjà dans le niveau applicatif.

## L'éviction est acceptable — parce que le verrou n'est pas la garantie

`maxmemory-policy` vaut `volatile-lru` : seules les clés porteuses d'un délai
d'expiration sont candidates à l'éviction, une clé posée sans TTL ne disparaît
jamais sous la pression mémoire.

À lire avec la règle non négociable n°4 du projet en tête. La garantie « zéro
double réservation » repose sur la contrainte d'exclusion PostgreSQL, **pas** sur
la survie d'un verrou Redis. Un verrou évincé fait retomber une réservation
concurrente sur la contrainte en base — elle échoue proprement — au lieu de
produire un double créneau. Un cache dont l'indisponibilité produirait une
double réservation serait un défaut de conception du moteur, pas un défaut de
dimensionnement du cache.

`timeout = 3600` coupe une connexion inactive au bout d'une heure : sans cela, un
client qui meurt sans fermer laisse sa connexion ouverte jusqu'au redémarrage du
nœud, et un `cache.t4g.micro` plafonne vite en nombre de connexions.

## Ce que la production impose, et qui est tenu par le code

Quatre préconditions refusent l'`apply` sur une combinaison incohérente ou sur un
environnement nommé `prod` configuré comme un bac à sable.

| Exigence | Variable | Hors production | Production |
|---|---|---|---|
| Nœud de secours | `replica_count` | `0` | `>= 1` |
| Répartition sur plusieurs zones | `multi_az` | `false` | `true` |
| Jeton exigé à la connexion | `auth_token_enabled` | libre | `true` |
| Cohérence bascule / réplica | — | `multi_az` exige `replica_count >= 1` | idem |

`automatic_failover_enabled` n'est pas une variable : il se déduit de
`replica_count`, parce que l'API refuse la bascule sans réplica et le Multi-AZ
sans bascule. Une variable de plus n'aurait servi qu'à produire cette erreur.

## Variables principales

| Variable | Type | Défaut | Rôle |
|---|---|---|---|
| `environment` | `string` | — | Préfixe de nom, `spa-{environment}-…` |
| `vpc_id` | `string` | — | Sortie `vpc_id` du module `network` |
| `subnet_ids` | `list(string)` | — | Sortie `data_subnet_ids`, au moins deux zones |
| `allowed_security_group_ids` | `map(string)` | `{}` | Groupes autorisés sur 6379, par étiquette |
| `engine_version` | `string` | `"7.1"` | `majeure.mineure` |
| `node_type` | `string` | `"cache.t4g.micro"` | Dimensionnement CDC §4.15 |
| `replica_count` | `number` | `0` | `1` en production |
| `kms_key_arn` | `string` | `null` | `null` = clé créée par le module |

Le reste — fenêtres d'instantané et de maintenance, rétention des journaux, délai
de récupération du secret, paramètres additionnels — est documenté dans
`variables.tf`, description par description.

## Sorties

`replication_group_id`, `replication_group_arn`, `primary_endpoint_address`,
`reader_endpoint_address`, `port`, `connection_url_scheme`,
`auth_token_secret_arn`, `auth_token_enabled`, `security_group_id`,
`kms_key_arn`, `subnet_group_name`, `parameter_group_name`,
`cloudwatch_log_group_names`.

Aucune sortie ne porte de secret. `auth_token_secret_arn` désigne où le lire.

Les verrous se posent sur `primary_endpoint_address` : c'est le seul nœud qui
accepte les écritures. `reader_endpoint_address` vaut le primaire tant que
`replica_count` est nul.

## Utilisation

```hcl
module "cache" {
  source = "../../modules/cache"

  environment = "prod"
  vpc_id      = module.network.vpc_id
  subnet_ids  = module.network.data_subnet_ids

  allowed_security_group_ids = {
    ecs_tasks = module.ecs_service.task_security_group_id
  }

  node_type          = "cache.t4g.micro"
  replica_count      = 1
  multi_az           = true
  log_retention_days = 90

  # Une seule clé pour tout le niveau données.
  kms_key_arn = module.database.kms_key_arn
}
```

## À savoir avant de modifier

- Le groupe de paramètres n'accepte pas de `name_prefix`, contrairement à son
  équivalent RDS : le nom porte donc la famille. C'est ce qui rend
  `create_before_destroy` viable — un changement de famille force un
  remplacement, et il change le nom du même geste. **La description, elle, est
  aussi `ForceNew`** : la réécrire sans toucher à la famille ferait créer un
  remplaçant sous un nom identique, et l'`apply` échouerait sur
  `CacheParameterGroupAlreadyExists`. Ne pas la modifier seule.
- `auto_minor_version_upgrade` vaut `false`, contrairement au module `database`.
  ElastiCache tient `7.1 → 7.2` pour une mise à jour mineure ; le plan suivant y
  verrait une rétrogradation, que le fournisseur traite en `ForceNew`, et
  proposerait de détruire puis recréer le cluster sans qu'aucune ligne de code
  n'ait bougé. Monter la version est donc un geste délibéré, dans le code.
- Le groupe de sécurité se référence lui-même en entrée **et** en sortie, sur le
  seul port Redis. Ce groupe n'est porté que par les nœuds ElastiCache : cela
  n'ouvre donc que le trafic primaire vers réplica, et évite d'écrire la moindre
  règle sortante vers `0.0.0.0/0`.
- La description d'un groupe de sécurité et celle d'une règle n'acceptent ni
  accent ni apostrophe — l'API EC2 fait échouer l'`apply` dessus.
- Les groupes de journaux CloudWatch sont créés **avant** le cluster. Laissés à
  ElastiCache, ils naissent sans expiration et se paient indéfiniment. Ils ne
  portent pas `kms_key_id`, pour la même raison que dans le module `database` :
  y poser la clé cliente obligerait à lui écrire une politique autorisant
  `logs.{région}.amazonaws.com`, ce que `kms.tf` évite délibérément.
- Le secret du jeton utilise `name_prefix` : un secret supprimé reste réservé
  pendant sa fenêtre de récupération, et un nom figé ferait échouer tout `apply`
  de reconstruction pendant ce délai.
- Le module ne déclare pas de `provider` : les étiquettes obligatoires
  (`Project`, `Environment`, `ManagedBy`, `Owner`) viennent du `default_tags` de
  l'environnement appelant.
