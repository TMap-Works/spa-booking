# backup — AWS Backup, politique de rétention unifiée

Ce module pose la couche de sauvegarde centralisée du CDC §4.14 : un coffre
chiffré par sa propre clé, un plan à quatre cadences, la sélection de ce qu'il
protège, le rôle de service qui sauvegarde **et** restaure, et les quatre alarmes
qui disent quand il ne fait plus son travail.

Il ne remplace pas les sauvegardes automatiques de RDS — le module `database` les
configure de son côté, et elles restent le chemin de restauration le plus rapide.
Il ajoute ce que RDS ne sait pas donner : une rétention longue, auditable d'un
seul endroit, dans un coffre séparé et **sous une autre clé**.

## Pourquoi une clé distincte de celle de la base

C'est la raison d'être du module, plus encore que la rétention.

Une sauvegarde chiffrée par la clé de la ressource qu'elle sauvegarde ne survit
pas à la perte de cette clé. Programmer la suppression de la clé RDS — un geste
qui s'exécute sept à trente jours plus tard, sans retour possible passé le
délai — rendrait illisibles d'un même mouvement l'instance **et** l'intégralité
de ses points de restauration. Deux clés, deux rayons d'explosion.

Le corollaire est une contrainte de restauration, pas un détail : le rôle qui
restaure doit pouvoir employer les deux clés. C'est ce que fait
`restore_kms_key_arns`, et l'oublier ne se voit pas à la sauvegarde — seulement
le jour où l'on restaure.

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Coffre | `spa-{env}-backup` | Reçoit les points de restauration |
| Clé KMS + alias | `alias/spa-{env}-backup` | Chiffre le coffre — créée si `kms_key_arn` est nul |
| Verrou de coffre | — | Facultatif, mode gouvernance seulement |
| Plan | `spa-{env}-backup` | Jusqu'à quatre règles : continue, quotidienne, hebdomadaire, mensuelle |
| Sélection | `spa-{env}-by-arn` | Ressources désignées par ARN |
| Sélection | `spa-{env}-by-tag` | Ressources sélectionnées par étiquette |
| Rôle IAM | `spa-{env}-backup` | Endossé par AWS Backup pour sauvegarder et restaurer |
| Alarme | `spa-{env}-backup-none-completed` | Aucune sauvegarde terminée sur la fenêtre |
| Alarme | `spa-{env}-backup-jobs-failed` | Au moins un travail en échec |
| Alarme | `spa-{env}-backup-jobs-expired` | Un travail n'a pas démarré dans sa fenêtre |
| Alarme | `spa-{env}-backup-restore-failed` | Une restauration a échoué |

Les alarmes ne sont créées que si le plan protège quelque chose : sans sélection,
« aucune sauvegarde terminée » serait vrai en permanence.

## Les quatre cadences, et ce que chacune tient

| Règle | Défaut | Ce qu'elle couvre |
|---|---|---|
| `continuous` | 35 j | **Le RPO.** Restauration à un instant donné, à cinq minutes près |
| `daily` | 35 j | La reprise courante : hier, avant-hier |
| `weekly` | 90 j | La corruption découverte tardivement |
| `monthly` | 365 j | L'archive : preuve et audit, pas la reprise |

Une rétention à `0` retire sa règle. C'est la forme que prend « cette cadence ne
s'applique pas à cet environnement » — un booléen de plus ne dirait rien de
mieux.

**Seule `continuous` tient le RPO ≤ 1 h.** Les trois autres sont des instantanés :
avec elles seules, la perte tolérée vaut la cadence la plus courte, soit
vingt-quatre heures. Une précondition refuse un environnement `prod` qui la
désactiverait.

Elle exige en retour que la ressource RDS ait ses sauvegardes automatiques
actives — `backup_retention_period > 0` côté module `database`, ce que sa propre
validation garantit déjà — et AWS Backup plafonne sa rétention à 35 jours.

Aucune règle ne pose `cold_storage_after` : le stockage froid d'AWS Backup ne
couvre pas les instantanés RDS, et le renseigner ferait échouer l'`apply` sur un
message qui ne dit pas cela.

## Composition

```hcl
module "backup" {
  source = "../../modules/backup"

  environment = local.environment

  # Désigner les ressources une à une plutôt que par étiquette : un plan qui ne
  # protège plus rien se voit alors en revue, pas le jour de la restauration.
  resource_arns = [module.database.instance_arn]

  # La clé de l'instance source. Sans elle, le travail de sauvegarde ne peut pas
  # lire un volume chiffré — et la restauration vers cette clé échoue.
  restore_kms_key_arns = [module.database.kms_key_arn]

  continuous_backup_retention_days = 35
  daily_retention_days             = 35
  weekly_retention_days            = 90
  monthly_retention_days           = 365

  alarm_topic_arns = [module.budgets.alerts_topic_arn]
}
```

`kms_key_arn` n'est **pas** renseigné : le module crée sa clé. Lui passer
`module.database.kms_key_arn` annulerait la séparation décrite plus haut.

### Sélection par étiquette

`selection_tags` existe pour les ressources qu'on ne peut pas nommer une à une.
Elle se manie avec précaution : `{ Environment = "prod" }` embarquerait aussi les
compartiments S3 de l'environnement, dont celui qui porte l'état Terraform. Le
filtrage par type de ressource passerait par `not_resources`, que ce module
n'expose pas — tant que le besoin ne va pas au-delà de RDS, `resource_arns` fait
mieux le travail.

## Ce que les préconditions refusent en production

Un environnement dont le nom commence par `prod` ne peut pas :

- désactiver la sauvegarde continue — le RPO ≤ 1 h ne serait plus tenu ;
- descendre la rétention quotidienne sous 30 jours (CDC §4.14) ;
- poser `force_destroy = true` sur le coffre ;
- exister sans sélection — un coffre vide passe tous les contrôles et ne restaure
  rien.

Comme dans le module `database`, le test est `startswith(var.environment, "prod")`
et non une égalité : il doit échouer *fermé*.

## Verrou de coffre

`vault_lock` pose un verrou en **mode gouvernance** : AWS Backup refuse alors de
raccourcir une rétention ou de supprimer un point avant son terme, sauf à un
principal explicitement autorisé à lever le verrou.

Le **mode conformité** n'est pas exposé, délibérément. Il devient irréversible
passé son délai de grâce, y compris pour la racine du compte : un plafond de
rétention mal saisi immobiliserait le coffre — et sa facture — jusqu'à
l'expiration du dernier point. Ce n'est pas une décision qui se prend dans une
variable Terraform.

## Supervision : pourquoi des alarmes et non les notifications de coffre

`aws_backup_vault_notifications` publierait sous le principal
`backup.amazonaws.com`, que la politique du topic SNS du module `budgets`
n'autorise pas — et cette politique appartient à ce module-là. En ajouter une
seconde sur le même topic ne l'étend pas : SNS n'accepte qu'une politique par
topic, et le dernier `apply` effacerait celle de l'autre.

Les alarmes CloudWatch, elles, publient sous `cloudwatch.amazonaws.com`, que le
topic autorise déjà explicitement (`budgets/alerts.tf`, énoncé
`AllowCloudWatchAlarms`).

L'alarme qui compte le plus est `none-completed`, et son réglage mérite d'être
lu : `treat_missing_data = "breaching"`. Sans aucun travail terminé, AWS Backup
ne publie pas un zéro — il ne publie rien. Traitée par le défaut de CloudWatch,
l'alarme resterait éternellement verte pour un environnement qui ne sauvegarde
plus. C'est exactement la panne que ce module existe pour rendre visible.

**Une réserve, sur `restore-failed`.** Cette alarme filtre
`NumberOfRestoreJobsFailed` sur la dimension `BackupVaultName`, comme les trois
autres. Les métriques de **restauration** d'AWS Backup ne portent pas forcément
cette dimension : si elles ne la portent pas, l'alarme n'agrège rien et reste
verte quoi qu'il arrive, son `treat_missing_data = "notBreaching"` aidant. Cela
ne se tranche pas sans un compte AWS — la vérification est
`aws cloudwatch list-metrics --namespace AWS/Backup`, à faire au premier exercice
du runbook, qui produit précisément un travail de restauration. Les trois autres
alarmes ne sont pas concernées : `BackupVaultName` est la dimension documentée
des métriques de sauvegarde.

## Restaurer

La procédure pas à pas — restauration à un instant donné, depuis un instantané,
depuis un point de restauration du coffre, et le relevé de temps à confronter à
la cible RTO de 4 h — est dans
[docs/runbooks/pra-restauration-rds.md](../../../../docs/runbooks/pra-restauration-rds.md).
La bascule en cas de panne de zone est dans
[docs/runbooks/pra-bascule-az.md](../../../../docs/runbooks/pra-bascule-az.md).

Les deux sorties qui servent à la première commande : `vault_name` et `role_arn`.

## Hors périmètre

- **Copie inter-région** (`copy_action`). Le CDC §4.14 la classe en option
  (« Réplication S3 (option) »), et elle demande un second coffre dans une autre
  région, donc un second alias de fournisseur. À rouvrir si la résilience
  régionale entre dans le périmètre.
- **`aws_backup_region_settings`**. Le réglage est unique par compte et par
  région : posé depuis un environnement, il serait écrasé par les deux autres —
  la même chicane que les préférences SMS d'SNS dans le module `notifications`.
  L'activation de la protection par type de ressource se fait donc au niveau du
  compte, dans `infra/terraform/bootstrap`.
- **Sauvegarde de S3 et d'EFS.** Le rôle ne porte que les politiques managées de
  sauvegarde et de restauration ; S3 en réclame deux de plus.
