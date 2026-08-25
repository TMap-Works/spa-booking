# database — RDS PostgreSQL, chiffrement, sauvegardes

Persistance managée d'un environnement (CDC §4.5). C'est ici que vit la donnée
métier : le chiffrement, les sauvegardes et la protection contre la suppression
se règlent au premier `apply`, pas le jour où l'on en a besoin.

Le module ne porte **aucune valeur spécifique à un environnement** : ce qui varie
est une variable. La composition se fait dans `envs/{dev,staging,prod}`, et le
réseau vient des sorties du module `network`.

## Ce qu'il crée

| Ressource | Nombre | Rôle |
|---|---|---|
| Instance RDS PostgreSQL | 1 | `spa-{env}-rds`, moteur 16, stockage gp3 chiffré |
| Clé KMS + alias | 0 ou 1 | Créée sauf si `kms_key_arn` est fourni |
| Groupe de sous-réseaux | 1 | Les sous-réseaux **de données** du VPC |
| Groupe de paramètres | 1 | `btree_gist`, TLS obligatoire, UTC, requêtes lentes |
| Groupe de sécurité | 1 | 5432 depuis les groupes applicatifs autorisés, rien en sortie |
| Groupes de journaux CloudWatch | 2 | `postgresql` et `upgrade`, avec rétention explicite |

Le mot de passe maître n'est **pas** une ressource du module : voir plus bas.

## Le mot de passe maître ne passe jamais par Terraform

`manage_master_user_password = true` fait engendrer le mot de passe par RDS, qui
le dépose lui-même dans un secret de Secrets Manager chiffré par `kms_key_arn` et
sait le faire tourner. Terraform ne le voit ni dans le code, ni dans un
`.tfvars`, **ni dans l'état**.

C'est ce dernier point qui écarte l'alternative `random_password` : elle sort le
secret des fichiers versionnés, mais l'écrit en clair dans un état que lit toute
personne autorisée sur le bucket. Le module n'expose que
`master_user_secret_arn` ; qui doit lire le mot de passe le demande à Secrets
Manager, ce qui laisse une trace CloudTrail que la lecture d'un état ne laisse
pas.

Le rôle de tâche ECS a donc besoin de `secretsmanager:GetSecretValue` sur ce
secret **et** de `kms:Decrypt` sur `kms_key_arn`. Le second est celui qu'on
oublie.

## `btree_gist` n'est pas un détail de confort

`rds.allowed_extensions` est posé explicitement, et `allowed_extensions` refuse
par validation toute liste qui ne contient pas `btree_gist`. C'est cette
extension qui autorise une contrainte d'exclusion PostgreSQL sur une paire
(identifiant de ressource, plage de temps) — donc la seule barrière réelle
contre la double réservation, règle non négociable n°4 du projet. Sans elle,
`CREATE EXTENSION btree_gist` est refusé et la migration qui pose la contrainte
échoue.

Le paramètre est statique : il ne prend effet qu'au redémarrage de l'instance,
d'où `apply_method = "pending-reboot"`.

Trois autres paramètres méritent d'être connus avant d'y toucher :

- `rds.force_ssl = 1` — les connexions non chiffrées sont refusées. Le
  chiffrement en transit ne se déduit pas de l'isolation réseau.
- `timezone = UTC` — règle de code du projet : tout est stocké en UTC et
  converti à l'affichage selon le fuseau du tenant.
- `shared_preload_libraries = pg_stat_statements` — sans elle, Performance
  Insights montre l'attente mais pas la requête qui la cause.

## Ce que la production impose, et qui est tenu par le code

Quatre préconditions sur l'instance refusent l'`apply` quand `environment` vaut
`prod` mais que la configuration est celle d'un bac à sable. Elles ne mettent
aucune valeur d'environnement dans le module — elles interdisent seulement une
combinaison.

| Exigence | Variable | Hors production | Production |
|---|---|---|---|
| Bascule de zone (CDC §4.5) | `multi_az` | `false` | `true` |
| Rétention des sauvegardes (CDC §4.14) | `backup_retention_period` | `7` | `≥ 30` |
| Refus de suppression | `deletion_protection` | `false` | `true` |
| Instantané final | `skip_final_snapshot` | libre | `false` |

Le chiffrement au repos, Performance Insights et `publicly_accessible = false`
ne sont pas des variables : ils sont posés en dur, y compris en dev.

## Variables principales

| Variable | Type | Défaut | Rôle |
|---|---|---|---|
| `environment` | `string` | — | Préfixe de nom, `spa-{environment}-…` |
| `vpc_id` | `string` | — | Sortie `vpc_id` du module `network` |
| `subnet_ids` | `list(string)` | — | Sortie `data_subnet_ids`, au moins deux zones |
| `allowed_security_group_ids` | `map(string)` | `{}` | Groupes autorisés sur 5432, par étiquette |
| `engine_version` | `string` | `"16"` | Famille PostgreSQL 16 imposée par validation |
| `instance_class` | `string` | `"db.t4g.medium"` | Dimensionnement CDC §4.15 |
| `kms_key_arn` | `string` | `null` | `null` = clé créée par le module |

Le reste — fenêtres de sauvegarde et de maintenance, stockage, rétention des
journaux, monitoring renforcé, paramètres additionnels — est documenté dans
`variables.tf`, description par description.

## Sorties

`instance_id`, `instance_arn`, `address`, `port`, `endpoint`, `database_name`,
`master_username`, `master_user_secret_arn`, `security_group_id`, `kms_key_arn`,
`subnet_group_name`, `parameter_group_name`, `allowed_extensions`,
`cloudwatch_log_group_names`.

Aucune sortie ne porte de secret. `master_user_secret_arn` désigne où le lire.

## Utilisation

```hcl
module "database" {
  source = "../../modules/database"

  environment = "prod"
  vpc_id      = module.network.vpc_id
  subnet_ids  = module.network.data_subnet_ids

  allowed_security_group_ids = {
    ecs_tasks = module.ecs_service.task_security_group_id
  }

  instance_class          = "db.t4g.medium"
  multi_az                = true
  backup_retention_period = 30
  deletion_protection     = true
  skip_final_snapshot     = false
  log_retention_days      = 90
}
```

Passer ensuite `module.database.kms_key_arn` au module `cache` : le niveau
données n'a alors qu'une seule clé à administrer, à auditer et à partager avec
un instantané.

## À savoir avant de modifier

- Le groupe de sécurité et le groupe de paramètres utilisent `name_prefix` +
  `create_before_destroy`. C'est la seule combinaison qui laisse un remplacement
  aboutir : l'instance les référence, donc AWS refuse de les détacher avant
  qu'un remplaçant n'existe, et deux ne peuvent pas porter le même nom.
- La description d'un groupe de sécurité et celle d'une règle n'acceptent ni
  accent ni apostrophe — l'API EC2 fait échouer l'`apply` dessus. Les étiquettes,
  elles, acceptent l'Unicode.
- Aucune règle sortante n'est déclarée sur le groupe de sécurité, et c'est voulu :
  une instance RDS répond à des connexions, elle n'en ouvre pas.
- Les groupes de journaux CloudWatch sont créés **avant** l'instance. Laissés à
  RDS, ils naissent sans expiration et se paient indéfiniment.
- Ces groupes ne portent **pas** `kms_key_id`, et c'est une décision, pas un
  oubli : avec `log_min_duration_statement` à 1000 ms, le groupe `postgresql`
  contient le texte des requêtes lentes, donc potentiellement de la donnée de
  tenant, chiffrée par la clé de service CloudWatch et non par la clé du module.
  Y poser la clé cliente obligerait à lui écrire une politique autorisant
  `logs.{région}.amazonaws.com` — exactement ce que `kms.tf` évite, une politique
  incomplète rendant la clé et la base inaccessibles. À rouvrir quand le module
  `observability` posera des politiques de clé pour de bon.
- Le nom de l'instantané final est suffixé par un `random_id` figé dans l'état, et
  non par `timestamp()`, qui rendrait chaque plan différent du précédent.
- Le module ne déclare pas de `provider` : les étiquettes obligatoires
  (`Project`, `Environment`, `ManagedBy`, `Owner`) viennent du `default_tags` de
  l'environnement appelant.
- Un plan de production qui fait apparaître un remplacement de l'instance se
  relit ligne à ligne avant l'`apply` : un `destroy` sur RDS est irréversible.
