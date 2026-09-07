# Runbook — panne d'une zone de disponibilité

**Cibles du CDC §4.14 : RPO ≤ 1 h, RTO ≤ 4 h.**

Une zone de disponibilité tombe. Ce document dit ce qui bascule tout seul, ce
qui ne bascule pas, et dans quel ordre s'en occuper.

L'environnement occupe **deux zones** — `eu-west-3a` et `eu-west-3b` — avec trois
niveaux de sous-réseaux dans chacune. Ce qui survit dépend entièrement de
l'environnement, et l'écart n'est pas un oubli : c'est le dimensionnement du
CDC §4.13.

| Composant | `dev` / `staging` | `prod` |
|---|---|---|
| RDS PostgreSQL | mono-AZ — **ne bascule pas** | Multi-AZ — bascule automatique, 1 à 2 min |
| ElastiCache Redis | sans réplica — **perdu** | 1 réplica, Multi-AZ — bascule automatique |
| Tâches ECS | replanifiées dans la zone survivante | idem |
| ALB | 2 zones, retire la cible morte | idem |
| NAT Gateway | **une seule** — la perdre coupe la sortie des deux zones | une par zone |

**La règle qui décide de tout** : si `terraform output rds_multi_az` vaut `true`,
il n'y a presque rien à faire. S'il vaut `false`, la perte de la zone de la base
est une **restauration**, pas une bascule — et c'est
[pra-restauration-rds.md](pra-restauration-rds.md) qu'il faut ouvrir.

---

## 0. Établir le fait — cinq minutes

Ne pas déduire la panne de zone d'une application qui répond mal : les deux se
ressemblent, et restaurer une base saine coûte des heures pour rien.

```bash
# 1. Ce qu'AWS annonce.  https://health.aws.amazon.com/health/status
aws health describe-events \
  --filter regions=eu-west-3,eventStatusCodes=open \
  --query 'events[].{service: service, code: eventTypeCode, debut: startTime}' \
  --output table 2>/dev/null || echo "API Health indisponible — voir la page de statut"

# 2. Où est la base maintenant, et où était-elle au §0 du runbook de restauration.
terraform output rds_availability_zone
aws rds describe-db-instances --db-instance-identifier spa-<env>-rds \
  --query 'DBInstances[0].{az: AvailabilityZone, statut: DBInstanceStatus, multi_az: MultiAZ}'

# 3. Les tâches ECS, par zone.
aws ecs list-tasks --cluster "$(terraform output -raw ecs_cluster_name)" \
  --query 'taskArns' --output text | xargs -r aws ecs describe-tasks \
  --cluster "$(terraform output -raw ecs_cluster_name)" --tasks \
  --query 'tasks[].{az: availabilityZone, statut: lastStatus, sante: healthStatus}' \
  --output table

# 4. Ce que l'ALB voit de ses cibles.
aws elbv2 describe-target-health --target-group-arn <arn du groupe cible api> \
  --query 'TargetHealthDescriptions[].{cible: Target.Id, zone: Target.AvailabilityZone,
                                       etat: TargetHealth.State, cause: TargetHealth.Reason}' \
  --output table
```

**Démarrer le chronomètre** et noter l'heure : le RTO se compte depuis la
détection, et c'est le tableau du §5 qu'on remplit.

Le point 2 est le plus parlant : `rds_availability_zone` est relevé **avant**
l'incident (§0 du runbook de restauration). Si la valeur rendue par l'API diffère
de celle-là, **la bascule a déjà eu lieu** — c'est ce qu'on cherche à savoir, et
c'est la raison d'être de cette sortie.

---

## 1. Production — la bascule est automatique, le travail est de la vérifier

RDS Multi-AZ tient une instance de secours dans la seconde zone et bascule seul.
Il n'y a **aucune commande à lancer pour la déclencher**, et la déclencher à la
main pendant qu'elle se produit ne fait que rallonger la coupure.

### 1.1 Confirmer que la bascule a eu lieu

```bash
aws rds describe-events \
  --source-identifier spa-prod-rds --source-type db-instance \
  --duration 120 \
  --query 'Events[].{quand: Date, message: Message}' --output table
```

L'événement recherché est de la catégorie `failover` — « Multi-AZ instance
failover started » puis « completed ». Entre les deux, l'application prend des
erreurs de connexion : c'est attendu, cela dure une à deux minutes.

Le **nom DNS du point d'accès ne change pas** : c'est tout l'intérêt du Multi-AZ.
Aucun secret à réécrire, aucun `DATABASE_URL` à toucher.

### 1.2 Purger les connexions restées sur l'ancienne instance

C'est le seul geste vraiment nécessaire, et celui qu'on oublie. Le pool de
connexions de l'application garde des sockets ouverts vers l'adresse d'avant la
bascule : le DNS a changé, pas les connexions déjà établies. Elles échouent une
par une, et l'application semble à moitié rétablie.

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
SERVICE=$(terraform output -json ecs_service_names | jq -r '.api')

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

### 1.3 Redis

Avec un réplica et le Multi-AZ, ElastiCache promeut le réplica seul. Vérifier —
et se souvenir que **le cache est un cache** : sa perte dégrade, elle
n'interrompt pas. En revanche, les **verrous de réservation** vivent dans Redis :
juste après une bascule, un verrou perdu peut laisser passer deux tentatives
concurrentes sur le même créneau. La contrainte d'exclusion en base reste la
barrière réelle — c'est précisément pourquoi elle existe (règle non négociable
n°4) — et la seconde tentative échouera en base plutôt que de produire une
double réservation.

```bash
aws elasticache describe-replication-groups \
  --replication-group-id spa-prod-redis \
  --query 'ReplicationGroups[0].{statut: Status, multi_az: MultiAZ,
                                 noeuds: NodeGroups[0].NodeGroupMembers[].{
                                     id: CacheClusterId, zone: PreferredAvailabilityZone,
                                     role: CurrentRole}}'
```

### 1.4 Capacité applicative

Les tâches de la zone perdue sont replanifiées par ECS dans la zone survivante,
à condition que le sous-réseau applicatif de celle-ci ait de la place et que
l'auto-scaling ait de la marge. Vérifier que le compte de tâches saines est
revenu à `desired_count`, et **ne pas relever `max_capacity` dans l'urgence** :
une zone tombée ne double pas la charge, elle la concentre.

```bash
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{souhaite: desiredCount, actif: runningCount, en_attente: pendingCount}'
```

---

## 2. Hors production — la base ne bascule pas

`dev` et `staging` sont mono-AZ (`rds_multi_az` vaut `false`). Si la zone perdue
est celle de la base, l'instance est **indisponible jusqu'au retour de la zone**.

Deux conduites, et le choix se fait en une minute :

- **Attendre.** C'est le bon choix par défaut sur un environnement sans client au
  bout. Une panne de zone AWS se résorbe généralement en quelques heures, et une
  restauration coûte plus qu'elle ne rapporte ici.
- **Restaurer dans la zone survivante**, si l'environnement est nécessaire tout
  de suite — une recette UAT en cours, par exemple. C'est le chemin A de
  [pra-restauration-rds.md](pra-restauration-rds.md), avec un argument de plus :

  ```bash
  aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier spa-<env>-rds \
    --target-db-instance-identifier spa-<env>-rds-restore \
    --use-latest-restorable-time \
    --availability-zone eu-west-3b \
    --db-subnet-group-name <subnet_group> \
    --db-parameter-group-name <parameter_group> \
    --vpc-security-group-ids <security_groups> \
    --no-publicly-accessible --no-multi-az
  ```

  `--availability-zone` désigne la zone **survivante** : sans lui, RDS peut
  replacer l'instance dans la zone en panne. Le §5 du runbook de restauration
  s'applique ensuite intégralement — c'est une nouvelle instance, donc un nouveau
  point d'accès, donc un secret à réécrire.

Le cache, lui, est perdu sans réplica. Il se recrée vide au retour de la zone, et
rien n'est à faire : l'application repeuple ses clés à la demande.

### La NAT Gateway, le point qu'on ne voit pas venir

`dev` et `staging` n'ont **qu'une** NAT Gateway. Si elle était dans la zone
perdue, la sortie Internet des **deux** zones applicatives est coupée : plus
d'appel à Stripe, plus de SES, plus de SNS — alors même que la base et les tâches
vont bien. Le symptôme trompe : l'application répond, et seuls les paiements et
les notifications échouent.

```bash
aws ec2 describe-nat-gateways \
  --filter Name=tag:Environment,Values=<env> \
  --query 'NatGateways[].{id: NatGatewayId, zone: SubnetId, etat: State}' --output table
```

Ce n'est pas une panne à réparer dans l'urgence : c'est l'arbitrage de coût
inscrit dans `envs/dev/main.tf` et `envs/staging/main.tf` — « la résilience par
zone ne vaut pas son coût sur un environnement de développement ». La production
en a deux, une par zone, et c'est le seul poste qu'on accepte d'y doubler. Le
remède, si l'environnement doit vraiment tenir : passer `nat_gateway_count = 2`
et appliquer.

---

## 3. Après le retour de la zone

**Ne rien précipiter.** Une zone qui revient est encore instable, et rebasculer
tout de suite ajoute une seconde coupure à une journée qui en a déjà eu une.

- **RDS Multi-AZ ne se rebascule pas.** L'instance qui sert est primaire, celle
  d'en face est de secours, et savoir laquelle est dans quelle zone n'a aucune
  conséquence fonctionnelle. Forcer un retour par
  `reboot-db-instance --force-failover` ne rachète rien et coupe une à deux
  minutes de plus. Ne le faire que si la répartition déséquilibre réellement
  quelque chose — et alors, hors heures ouvrées.
- **Mettre `rds_availability_zone` à jour** dans le relevé conservé avec le
  runbook de restauration : c'est la valeur de référence du prochain incident, et
  périmée elle fera conclure à une bascule qui n'a pas eu lieu.
- **Rééquilibrer les tâches ECS** en laissant faire : un déploiement ordinaire
  les répartira sur les deux zones. Aucun geste dédié.
- **Reprendre la main sur Terraform** si l'on a restauré au §2 : §5.6 du runbook
  de restauration. Aucun `apply` pendant l'incident.
- **Lancer un `terraform plan`** une fois tout stable, et le lire. Il dit ce que
  l'incident a fait diverger du code — c'est le seul contrôle qui rattrape un
  geste d'urgence oublié.

---

## 4. Ce que cette bascule ne couvre pas

- **La perte de la région entière.** Hors périmètre du MVP : le CDC §4.14 classe
  la réplication inter-région en option, le module `backup` n'expose pas de
  `copy_action`, et le coffre est régional. Une perte de région implique de
  reconstruire depuis l'IaC dans une autre région, sans les données.
- **Une corruption logique.** Elle se réplique dans la zone de secours en même
  temps qu'elle se produit : le Multi-AZ n'en protège pas, il n'a jamais été fait
  pour. C'est le chemin A du runbook de restauration.
- **La perte de la clé KMS.** Le coffre AWS Backup a la sienne, distincte de
  celle de la base, précisément pour que les sauvegardes survivent à la perte de
  la clé de leur source.

---

## 5. Relevé de temps

À remplir à chaque exercice et à chaque incident réel.

| Étape | Attendu (`prod`) | Mesuré |
|---|---|---|
| Détection → fait établi (§0) | ≤ 5 min | |
| Bascule RDS constatée terminée (§1.1) | 1 à 2 min | |
| Connexions purgées, service stable (§1.2) | ≤ 10 min | |
| Redis et capacité vérifiés (§1.3, §1.4) | ≤ 10 min | |
| **Total — détection → service rétabli** | **≤ 4 h (CDC §4.14)** | |

Hors production, le total est celui du runbook de restauration : la bascule
n'existe pas, c'est une restauration complète.

| Mesure | Attendu | Relevé |
|---|---|---|
| RPO — perte de données sur bascule Multi-AZ | **0** (réplication synchrone) | |
| RPO — restauration hors production | ≤ 1 h (PITR à 5 min près) | |

Le RPO nul de la bascule Multi-AZ est ce qui justifie son coût : la réplication
est synchrone, une transaction validée sur la primaire l'est aussi sur le
secours. C'est la différence entre « on a perdu une heure de rendez-vous » et
« on n'a rien perdu ».

---

## 6. Ce qui reste à exercer sur un compte AWS réel

**Cette procédure n'a pas été jouée.** Le dépôt n'a aucun accès à un compte AWS,
et une bascule ne se simule pas.

Restent ouverts, avec le critère « procédure testée » du CDC §4.14 :

1. Provoquer une bascule sur `staging` une fois qu'il compose `database` en
   Multi-AZ — `aws rds reboot-db-instance --force-failover` la déclenche
   proprement, sans attendre une vraie panne de zone.
2. Mesurer la durée réelle entre le début de la bascule et le retour d'un
   `/health` à 200, et remplir le tableau du §5. C'est la valeur qui manque : la
   fenêtre de 1 à 2 min est celle qu'annonce AWS pour la bascule seule, pas celle
   du rétablissement applicatif, qui dépend du pool de connexions.
3. Vérifier que le point d'accès DNS n'a effectivement pas changé — c'est
   l'hypothèse sur laquelle repose tout le §1, et elle n'a pas été constatée ici.
4. Corriger ce runbook avec ce que l'exercice aura démenti.

Ce qui **est** acquis sans compte AWS : la configuration qui rend la bascule
possible — deux zones dans chaque environnement, `multi_az` imposé en production
par une précondition du module `database`, deux NAT Gateway en production — et la
sortie `rds_availability_zone` qui permet de dire, après coup, que la bascule a
eu lieu.
