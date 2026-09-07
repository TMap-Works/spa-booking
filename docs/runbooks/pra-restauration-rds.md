# Runbook — restauration de la base PostgreSQL

**Cibles du CDC §4.14 : RPO ≤ 1 h, RTO ≤ 4 h.**

Ce document se lit **avant** l'incident, et s'exécute pendant. Il ne suppose ni
accès à la console AWS, ni lecture du code Terraform : tout ce dont il a besoin
se lit par `terraform output` ou par l'API RDS.

Il couvre trois chemins de restauration, dans l'ordre où on les essaie. Le
premier est presque toujours le bon.

| Chemin | Quand | Perte de données | Durée indicative |
|---|---|---|---|
| **A** — instant donné (PITR) | Corruption logique datée, dans la fenêtre de rétention | ≤ 5 min | 20 à 60 min |
| **B** — instantané RDS | Le PITR est indisponible, ou l'on veut un état de référence | Jusqu'à 24 h | 20 à 60 min |
| **C** — point de restauration AWS Backup | L'état recherché est plus vieux que la rétention RDS | Selon la cadence | 30 à 90 min |

Une **panne de zone** ne se traite pas ici : voir
[pra-bascule-az.md](pra-bascule-az.md). Restaurer alors qu'une bascule suffisait
coûte des heures pour rien.

---

## 0. Vérification préalable — à faire aujourd'hui, pas pendant l'incident

Depuis `infra/terraform/envs/<env>` :

```bash
terraform output rds_backup_retention_period   # jours de PITR disponibles
terraform output rds_multi_az                  # bascule automatique ou non
terraform output rds_availability_zone         # zone de départ
terraform output backup_vault_name
terraform output backup_restore_role_arn
terraform output backup_retention_policy       # rétentions par cadence
terraform output backup_continuous_enabled     # doit être true
terraform output backup_protects_anything      # doit être true
terraform output backup_alarms_notify          # doit être true
```

Quatre lectures conditionnent la suite :

- `backup_continuous_enabled` **faux** ⇒ le RPO du coffre vaut la cadence du plus
  court instantané, soit 24 h. Le chemin A reste possible via RDS tant que
  `rds_backup_retention_period` est non nul, mais la cible RPO ≤ 1 h n'est plus
  tenue par le coffre. En production, une précondition du module `backup` refuse
  cette configuration.
- `backup_protects_anything` **faux** ⇒ le coffre existe, le plan existe, ses
  règles sont là, et **rien n'est sauvegardé**. C'est l'état qui passe tous les
  contrôles et ne restaure rien. Le chemin C est indisponible.
- `rds_backup_retention_period` **à 0** ⇒ pas de PITR du tout. La validation de
  la variable l'interdit ; si la valeur est nulle, l'instance n'a pas été créée
  par ce module.
- `backup_alarms_notify` **faux** ⇒ les alarmes du coffre passent au rouge sans
  prévenir personne. On apprendra la panne de sauvegarde en restaurant.

Relever aussi, **une fois pour toutes**, la description de l'instance en
fonctionnement nominal. Ces quatre valeurs sont ce que la restauration devra
reposer à la main, et les lire pendant l'incident sur une instance en panne est
exactement ce qui ne fonctionne pas :

```bash
aws rds describe-db-instances \
  --db-instance-identifier spa-<env>-rds \
  --query 'DBInstances[0].{
      subnet_group: DBSubnetGroup.DBSubnetGroupName,
      parameter_group: DBParameterGroups[0].DBParameterGroupName,
      security_groups: VpcSecurityGroups[*].VpcSecurityGroupId,
      instance_class: DBInstanceClass,
      kms_key: KmsKeyId,
      multi_az: MultiAZ,
      az: AvailabilityZone
  }'
```

Garder cette sortie avec ce runbook, hors du compte AWS concerné.

---

## 1. Décider — cinq minutes, pas plus

| Constat | Chemin |
|---|---|
| Une migration ou une suppression a corrompu la donnée à une heure connue | **A**, en visant une minute avant |
| L'instance est perdue, la donnée d'hier suffit | **B** |
| Il faut un état antérieur à `rds_backup_retention_period` jours | **C** |
| La zone est tombée, la donnée est intacte | **Rien ici** → [pra-bascule-az.md](pra-bascule-az.md) |

**Démarrer le chronomètre maintenant**, et noter l'heure. Le RTO se compte à
partir de la détection de l'incident, pas du début de la commande de
restauration. C'est le tableau du §6 qu'on remplit.

**Ne pas supprimer l'instance endommagée.** Une restauration produit toujours une
**nouvelle** instance : RDS ne sait pas restaurer en place. Tant que la nouvelle
n'a pas été validée, l'ancienne est le seul état qui reste — et sur un
environnement où `deletion_protection` est vrai, sa suppression demande de
surcroît un geste supplémentaire, ce qui est le comportement voulu.

---

## 2. Chemin A — restauration à un instant donné

C'est le chemin qui tient le RPO : RDS conserve les journaux de transaction en
continu et sait revenir à **cinq minutes près**.

```bash
# Jusqu'où peut-on remonter ? Les deux bornes de la fenêtre.
aws rds describe-db-instances \
  --db-instance-identifier spa-<env>-rds \
  --query 'DBInstances[0].{debut: EarliestRestorableTime, fin: LatestRestorableTime}'
```

`LatestRestorableTime` est le vrai RPO du moment. Il retarde de quelques minutes
sur l'heure courante : c'est normal, et c'est la valeur à reporter au §6.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier spa-<env>-rds \
  --target-db-instance-identifier spa-<env>-rds-restore \
  --restore-time 2026-09-07T14:35:00Z \
  --db-subnet-group-name <subnet_group du §0> \
  --db-parameter-group-name <parameter_group du §0> \
  --vpc-security-group-ids <security_groups du §0> \
  --no-publicly-accessible \
  --no-multi-az \
  --db-instance-class <instance_class du §0>
```

Quatre arguments méritent d'être compris plutôt que recopiés :

- **`--db-parameter-group-name`.** Sans lui, l'instance restaurée reçoit le
  groupe **par défaut** de la famille. Elle démarre, elle répond, et
  `rds.allowed_extensions` n'y contient plus `btree_gist` : la contrainte
  d'exclusion qui interdit la double réservation ne peut plus être recréée, et
  `force_ssl` n'est plus imposé. C'est l'oubli le plus coûteux du chemin A,
  parce qu'il ne provoque aucune erreur visible.
- **`--vpc-security-group-ids`.** Sans lui, l'instance atterrit dans le groupe
  par défaut du VPC. Les tâches ECS ne la joindront pas, et on cherchera la panne
  du côté de l'application.
- **`--no-multi-az`.** Restaurer en mono-AZ va plus vite. La bascule se remet
  après validation (`modify-db-instance --multi-az`), et cette opération-là n'a
  pas besoin d'être dans le chemin critique du RTO. **En production, ne pas
  oublier de la repasser** — une précondition du module `database` l'exige, et le
  prochain `terraform plan` la signalera.
- **`--restore-time`** est en **UTC**, comme tout ce qui est stocké dans ce
  projet. Une heure locale saisie ici restaure une heure de plus ou de moins que
  voulu, sans que rien ne le dise.

Le chiffrement et la clé KMS de la source sont conservés d'office : rien à passer.

Passer au §5.

---

## 3. Chemin B — restauration depuis un instantané RDS

```bash
# Les instantanés disponibles, du plus récent au plus ancien.
aws rds describe-db-snapshots \
  --db-instance-identifier spa-<env>-rds \
  --query 'reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[:10].{
      id: DBSnapshotIdentifier, type: SnapshotType, cree: SnapshotCreateTime, etat: Status}' \
  --output table
```

Les instantanés `automated` sont pris dans la fenêtre `backup_window`
(02:00–03:00 UTC par défaut). Les `manual` sont ceux pris avant une mise en
production — le CDC §4.14 les prévoit explicitement, et c'est le geste à ne pas
sauter avant un `apply` de schéma risqué :

```bash
aws rds create-db-snapshot \
  --db-instance-identifier spa-<env>-rds \
  --db-snapshot-identifier spa-<env>-rds-avant-<version>
```

Restauration :

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-snapshot-identifier <identifiant relevé ci-dessus> \
  --db-instance-identifier spa-<env>-rds-restore \
  --db-subnet-group-name <subnet_group du §0> \
  --db-parameter-group-name <parameter_group du §0> \
  --vpc-security-group-ids <security_groups du §0> \
  --no-publicly-accessible \
  --no-multi-az \
  --db-instance-class <instance_class du §0>
```

Mêmes remarques qu'au §2 sur les groupes de paramètres et de sécurité : elles
valent tout autant ici.

**La perte de données vaut l'âge de l'instantané.** Sur un instantané quotidien,
elle peut atteindre 24 h — au-delà de la cible RPO. C'est pourquoi ce chemin
n'est le premier que si le chemin A est indisponible.

Passer au §5.

---

## 4. Chemin C — restauration depuis le coffre AWS Backup

À employer quand l'état recherché est plus ancien que la rétention RDS, ou quand
l'instance et ses instantanés automatiques ont disparu avec elle.

```bash
VAULT=$(terraform output -raw backup_vault_name)
ROLE=$(terraform output -raw backup_restore_role_arn)

aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name "$VAULT" \
  --by-resource-type RDS \
  --query 'RecoveryPoints[].{arn: RecoveryPointArn, cree: CreationDate,
                             etat: Status, taille: BackupSizeInBytes}' \
  --output table
```

Les points portent l'étiquette `Cadence` (`continuous`, `daily`, `weekly`,
`monthly`) posée par le plan : c'est ce qui permet de retrouver « le dernier
mensuel » dans une liste où tout se ressemble, la console n'affichant pas la
règle d'origine.

AWS Backup restaure à partir de **métadonnées**, qu'on récupère puis qu'on
corrige — les inventer à la main ne fonctionne pas :

```bash
RP=<arn du point retenu>

aws backup get-recovery-point-restore-metadata \
  --backup-vault-name "$VAULT" \
  --recovery-point-arn "$RP" \
  --query 'RestoreMetadata' > /tmp/restore-metadata.json
```

Éditer `/tmp/restore-metadata.json` :

- `DBInstanceIdentifier` → `spa-<env>-rds-restore` (l'identifiant d'origine est
  encore pris par l'instance endommagée, qu'on ne supprime pas) ;
- `DBParameterGroupName` → celui relevé au §0, pour la raison exposée au §2 ;
- `MultiAZ` → `false` pendant la restauration ;
- `PubliclyAccessible` → `false`, toujours.

```bash
aws backup start-restore-job \
  --recovery-point-arn "$RP" \
  --iam-role-arn "$ROLE" \
  --resource-type RDS \
  --metadata file:///tmp/restore-metadata.json
```

Deux pièges propres à ce chemin :

- **Le groupe de sécurité n'est pas dans les métadonnées de restauration RDS.**
  L'instance restaurée atterrit donc dans le groupe par défaut du VPC, et
  personne ne la joint. Corriger dès qu'elle est `available` :

  ```bash
  aws rds modify-db-instance \
    --db-instance-identifier spa-<env>-rds-restore \
    --vpc-security-group-ids <security_groups du §0> \
    --apply-immediately
  ```

- **Le rôle doit pouvoir employer les deux clés** — celle du coffre et celle de
  l'instance source. C'est ce que pose `restore_kms_key_arns` dans la composition
  de l'environnement. Un `start-restore-job` qui échoue en `AccessDenied` sur KMS
  vient presque toujours de là : le manque ne se voit pas à la sauvegarde,
  seulement le jour où l'on restaure.

Suivre le travail :

```bash
aws backup describe-restore-job --restore-job-id <id rendu ci-dessus> \
  --query '{etat: Status, message: StatusMessage, pct: PercentDone, ressource: CreatedResourceArn}'
```

---

## 5. Basculer l'application sur l'instance restaurée

**C'est cette section qui fait le RTO, pas la restauration elle-même.** Une
instance restaurée que rien n'utilise n'a rien remis en service.

### 5.1 Attendre que l'instance soit joignable

```bash
aws rds wait db-instance-available --db-instance-identifier spa-<env>-rds-restore

aws rds describe-db-instances \
  --db-instance-identifier spa-<env>-rds-restore \
  --query 'DBInstances[0].{endpoint: Endpoint.Address, port: Endpoint.Port,
                           az: AvailabilityZone, pg: DBParameterGroups[0],
                           sg: VpcSecurityGroups[*].VpcSecurityGroupId}'
```

Si `DBParameterGroups[0].ParameterApplyStatus` vaut `pending-reboot`, redémarrer
maintenant : `rds.allowed_extensions` est un paramètre **statique**, et tant
qu'il n'est pas appliqué, `btree_gist` reste indisponible.

```bash
aws rds reboot-db-instance --db-instance-identifier spa-<env>-rds-restore
aws rds wait db-instance-available --db-instance-identifier spa-<env>-rds-restore
```

### 5.2 Le mot de passe maître

L'instance restaurée conserve les identifiants du compte maître tels qu'ils
étaient au moment du point de restauration. Le secret que RDS gère pour
l'instance **source** — `terraform output database_master_user_secret_arn` —
porte donc la bonne valeur, sauf si une rotation a eu lieu depuis. Le lire :

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw database_master_user_secret_arn)" \
  --query SecretString --output text
```

Si l'authentification échoue, c'est qu'une rotation est passée entre le point de
restauration et maintenant : reposer un mot de passe sur l'instance restaurée
avec `modify-db-instance --manage-master-user-password --apply-immediately`, qui
crée un secret neuf attaché à elle.

### 5.3 Réécrire `DATABASE_URL`

Le point d'accès a changé — c'est inévitable, l'instance est nouvelle. La chaîne
de connexion vit dans le secret d'exécution de l'API, dont Terraform ne crée que
le conteneur :

```bash
SECRET=$(terraform output -raw api_runtime_secret_arn)

# Relire la valeur courante, n'en changer que l'hôte, la redéposer entière :
# `put-secret-value` remplace le document, il ne le fusionne pas.
aws secretsmanager get-secret-value --secret-id "$SECRET" \
  --query SecretString --output text > /tmp/runtime.json

# éditer /tmp/runtime.json : DATABASE_URL → postgresql://spa_admin:<mdp>@<nouvel
# endpoint>:5432/spa?sslmode=require   (sslmode obligatoire : force_ssl = 1)

aws secretsmanager put-secret-value --secret-id "$SECRET" \
  --secret-string file:///tmp/runtime.json
```

`sslmode=require` n'est pas décoratif : le groupe de paramètres pose
`rds.force_ssl = 1`, et une chaîne sans lui produit un refus de connexion qu'on
lira comme une panne de la base restaurée.

### 5.4 Redémarrer les tâches et rejouer les migrations

Les tâches ECS ne relisent le secret **qu'au démarrage** : sans redéploiement,
elles continuent de composer l'ancien point d'accès.

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
SERVICE=$(terraform output -json ecs_service_names | jq -r '.api')

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

Si la restauration ramène la base à un état antérieur au dernier déploiement,
rejouer les migrations avant de rouvrir le service — la définition de tâche
`spa-<env>-migrate` existe pour cela, et `prisma migrate deploy` est idempotent :

```bash
aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$(terraform output -raw migrate_task_definition_family)" \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<app_subnet_ids>],securityGroups=[<sg des tâches>],assignPublicIp=DISABLED}'
```

Le workflow `deploy-<env>.yml` compose déjà cette configuration réseau : s'en
inspirer plutôt que de la reconstruire.

### 5.5 Vérifier avant de déclarer le service rétabli

```bash
curl -k "https://$(terraform output -raw alb_dns_name)/health"
```

`/health` exécute `SELECT 1` sur PostgreSQL et `PING` sur Redis : un 200 prouve
que la nouvelle base est réellement branchée, pas seulement que l'ALB répond.

Puis, dans l'ordre — un seul de ces contrôles qui échoue interdit de déclarer
l'incident clos :

1. **La contrainte anti-double-réservation est là.** C'est la règle non
   négociable n°4 du projet, et c'est ce qu'un mauvais groupe de paramètres fait
   disparaître en silence :
   ```sql
   SELECT conname, contype FROM pg_constraint WHERE contype = 'x';
   ```
   Aucune ligne ⇒ ne pas rouvrir le service : reprendre au §5.1 avec le bon
   groupe de paramètres.
2. **Le schéma est à jour** — `_prisma_migrations` ne contient aucune migration
   en échec ni de retard sur `apps/api/prisma/migrations/`.
3. **La donnée est là.** Compter les rendez-vous du jour et les comparer à ce que
   le métier attend. Un décompte plausible mais faux est le seul échec que la
   technique ne verra pas.
4. **L'isolation entre établissements tient** — un `tenant_id` nul ou vide dans
   une table métier signale une restauration partielle :
   ```sql
   SELECT COUNT(*) FROM appointments WHERE tenant_id IS NULL;
   ```
5. **Une réservation de bout en bout** passe : réserver → confirmer → encaisser.

### 5.6 Reprendre la main sur Terraform — après, jamais pendant

L'instance restaurée n'est pas dans l'état Terraform. **Ne pas lancer de
`terraform apply` pendant l'incident** : le plan proposerait de recréer
`spa-<env>-rds` et de détruire ce qui vient d'être remis en service.

Une fois le service stable, au calme, deux options :

- **Renommer** — `modify-db-instance --new-db-instance-identifier` sur
  l'instance endommagée puis sur la restaurée, pour que cette dernière reprenne
  le nom canonique. Chaque renommage redémarre l'instance et change le point
  d'accès : deux coupures, à faire hors service.
- **Réimporter** — `terraform import` de l'instance restaurée sur l'adresse
  `module.database.aws_db_instance.this`, après un `terraform state rm` de
  l'ancienne. Aucune coupure, mais un `plan` à relire ligne à ligne : les
  attributs qui ne correspondent pas au code apparaîtront en modification, et
  certains — la classe d'instance, le Multi-AZ — sont ceux qu'on a délibérément
  changés pendant la restauration.

Dans les deux cas, **relire le plan avant l'`apply`** : un remplacement d'instance
dans un plan de production est irréversible.

Supprimer l'instance endommagée **en dernier**, et pas avant que le §5.5 ne soit
entièrement vert. En production, `deletion_protection` la protège : la lever est
un geste délibéré, et c'en est un dernier rappel.

---

## 6. Relevé de temps — le RTO se mesure, il ne se suppose pas

À remplir **à chaque exercice** et **à chaque incident réel**, puis à archiver
avec la date, l'environnement et le chemin employé (A, B ou C).

| Étape | Attendu | Mesuré |
|---|---|---|
| Détection → décision (§1) | ≤ 15 min | |
| Lancement de la restauration (§2, §3 ou §4) | ≤ 5 min | |
| Instance `available` | 20 à 60 min | |
| Groupe de sécurité, groupe de paramètres, redémarrage (§5.1) | ≤ 10 min | |
| Secret réécrit, tâches redéployées (§5.3, §5.4) | ≤ 10 min | |
| Vérifications (§5.5) | ≤ 15 min | |
| **Total — détection → service rétabli** | **≤ 4 h (CDC §4.14)** | |

| Mesure | Attendu | Relevé |
|---|---|---|
| RPO — écart entre `LatestRestorableTime` et l'incident | ≤ 1 h | |
| Cadence du point employé | `continuous` en production | |

Les valeurs de la colonne « attendu » sont des **estimations**, pas des
mesures : elles servent à repérer l'étape qui dérape, pas à prouver le RTO. La
durée de création de l'instance est celle qui varie le plus — elle croît avec le
volume, et c'est elle qu'un premier exercice réel apprend.

**Trois issues possibles, et une seule est neutre :**

- total ≤ 4 h ⇒ la cible est tenue, archiver le relevé ;
- total > 4 h ⇒ la cible n'est **pas** tenue. Ouvrir une issue avec le relevé.
  Le premier levier est presque toujours le §5, pas la restauration elle-même :
  un `DATABASE_URL` réécrit à la main coûte plus que la création d'une instance ;
- exercice non joué depuis plus de six mois ⇒ le runbook n'est plus une
  procédure testée, c'est une intention. Le CDC §4.14 demande une « procédure
  testée ».

---

## 7. Cadence des exercices

| Environnement | Fréquence | Chemin exercé |
|---|---|---|
| `dev` | à chaque modification de ce runbook | A |
| `staging` | trimestrielle | A, puis C une fois par an |
| `prod` | semestrielle, hors heures ouvrées | A |

La recette est l'environnement où la procédure se répète : elle porte de vraies
données et n'a pas de client au bout. La production, elle, ne s'exerce qu'avec
une fenêtre annoncée — et un exercice de production restaure vers une instance
`-restore` **sans** basculer le §5, la bascule étant la seule étape qui coupe le
service.

---

## 8. Ce qui reste à exercer sur un compte AWS réel

**Cette procédure n'a pas encore été jouée.** Le dépôt ne dispose d'aucun accès à
un compte AWS, et une restauration ne se simule pas : ce qu'elle apprend — la
durée réelle de création d'une instance, le comportement exact des métadonnées
d'AWS Backup, la liste des attributs qu'un `terraform import` fait diverger — ne
s'obtient qu'en la jouant.

Restent donc ouverts, et le critère « restauration effectivement testée » de
l'issue #82 avec eux :

1. Jouer le chemin A sur `dev` de bout en bout, §5.5 compris, et remplir le
   tableau du §6.
2. Jouer le chemin C sur `dev` — c'est celui qui porte le plus d'inconnues :
   métadonnées de restauration, groupe de sécurité absent, droits KMS croisés.
3. Confronter le total mesuré à la cible RTO de 4 h, et le RPO relevé à la cible
   d'1 h.
4. Profiter du travail de restauration ainsi produit pour vérifier que l'alarme
   `spa-<env>-backup-restore-failed` s'appuie sur une métrique réellement
   publiée — `aws cloudwatch list-metrics --namespace AWS/Backup` dit si
   `NumberOfRestoreJobsFailed` porte bien la dimension `BackupVaultName`. La
   réserve est documentée dans le README du module `backup`.
5. Corriger ce runbook avec ce que l'exercice aura démenti — c'est le seul
   passage qui transforme une procédure écrite en procédure testée.

En attendant, ce qui **est** acquis et vérifiable sans compte AWS : le dispositif
Terraform qui rend la restauration possible — coffre à clé distincte de celle de
la base, sauvegarde continue, rôle portant les droits de restauration, alarmes
qui signalent une sauvegarde qui ne se fait plus — et les sorties que ce runbook
lit au §0.
