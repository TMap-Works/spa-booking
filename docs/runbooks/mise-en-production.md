# Mise en production

Ce document couvre trois moments distincts, et il vaut mieux savoir lequel on
vit avant de lire :

1. **Le premier `apply`** de `infra/terraform/envs/prod`, sur un compte où rien
   n'existe encore — §1 à §4.
2. **Chaque déploiement** ensuite, qui est automatique et n'a pas besoin d'être
   lu — §5, pour comprendre ce qu'il fait et où regarder quand il rougit.
3. **Le retour en arrière**, quand un déploiement a mal tourné — §6. Celui-là se
   lit **avant** d'en avoir besoin.

Ce qui est déjà écrit ailleurs et ne se répète pas ici : la restauration de la
base ([pra-restauration-rds.md](pra-restauration-rds.md)), la perte d'une zone
([pra-bascule-az.md](pra-bascule-az.md)), la campagne de recette
([recette-staging.md](recette-staging.md)).

---

## 1. Ce que la production compose, et ce que cela suppose

`infra/terraform/envs/prod` compose treize modules. Trois d'entre eux n'existent
dans aucun autre environnement, et ce sont ceux qui demandent des prérequis :

| Module | Ce qu'il crée | Ce qu'il exige |
|---|---|---|
| `certificate` ×2 | deux certificats ACM validés par DNS | un domaine et une zone Route 53 |
| `cdn` | la distribution CloudFront et ses enregistrements | les deux certificats |
| `waf` ×2 | une Web ACL de bord **et** une Web ACL régionale | rien de plus |

Le reste — réseau, base, cache, calcul, sauvegarde, observabilité, notifications,
registre, budget, export — est la composition de `envs/staging` à l'échelle de
la production : RDS Multi-AZ, deux NAT Gateway, deux à huit tâches par service,
un réplica Redis, aucun arrêt hors heures ouvrées.

### La question qui décide de tout

**Cet environnement a-t-il un nom de domaine et une zone Route 53 ?**

Sans eux, `public_domain_name` et `route53_zone_id` valent `null`,
`terraform apply` **aboutit quand même** — et produit un environnement qui n'est
pas exploitable : l'ALB porte un certificat auto-signé, aucune distribution
n'existe, et ni les Server Components du front ni les trois Lambda de la chaîne
de notifications ne peuvent joindre l'API. Toutes refusent un certificat non
vérifiable, sans contournement.

C'est un état d'amorçage volontaire : il permet au tout premier `apply`
d'aboutir avant qu'un domaine n'existe, faute de quoi il n'y aurait rien sur quoi
poser le certificat. Ce n'est pas un état de service.

```bash
terraform -chdir=infra/terraform/envs/prod output go_live_blockers
```

Une liste vide n'autorise pas la mise en production — la recette et la décision
métier restent entières. Une liste non vide la refuse.

---

## 2. Prérequis, dans cet ordre

### 2.1 L'amorçage appliqué

`infra/terraform/bootstrap` appliqué, et l'identifiant de clé KMS relevé :

```bash
terraform -chdir=infra/terraform/envs/prod init \
  -backend-config="kms_key_id=<uuid de la clé prod>"
```

Sans lui, l'état est chiffré en SSE-S3 et non par la clé du compte — voir
l'en-tête de `envs/prod/backend.tf`.

### 2.2 Le domaine et sa zone

Un nom public — `reservation.<domaine>` — et la **zone Route 53 qui le sert**.

La zone n'est pas une commodité : c'est elle qui rend le renouvellement des
certificats automatique. ACM réémet un certificat validé par DNS soixante jours
avant son échéance, sans intervention, à la seule condition que les
enregistrements CNAME de validation soient encore publiés ce jour-là. Confiée au
code, la zone rend leur suppression accidentelle impossible.

Servir le domaine hors Route 53 reste possible — `certificate_arn` et
`edge_certificate_arn` acceptent alors des ARN émis ailleurs — mais le
renouvellement redevient la responsabilité de qui les a émis, et
`certificates_auto_renew` rend `false` pour le dire.

Un sous-domaine est **réservé** par la composition : `origin.<nom public>`. C'est
par lui que CloudFront joint l'ALB, et il ne peut pas servir à autre chose. La
raison est dans `modules/cdn/README.md` : CloudFront vérifie le certificat de son
origine, et aucun certificat public n'existe pour un nom `*.elb.amazonaws.com`.

### 2.3 Le rôle de monitoring RDS

Un rôle de **compte**, unique, portant `AmazonRDSEnhancedMonitoringRole`, à
passer en `rds_monitoring_role_arn`. Il n'est pas créé par l'environnement : le
créer par environnement en produirait trois pour le même usage.

Sans lui, Enhanced Monitoring reste désactivé — l'environnement s'applique
quand même, et `go_live_blockers` le nomme. Ce qui manque alors, ce sont les
métriques **système** de l'instance : c'est ce qui distingue « la requête est
mauvaise » de « le volume sature », un jour de lenteur.

### 2.4 Le JSON du secret d'exécution

Le conteneur du secret est créé par Terraform ; sa valeur est déposée hors
Terraform. Six clés, plus une septième dès qu'une route interne de la chaîne de
notifications est branchée. Le README de `envs/dev` donne le JSON attendu et
l'ordre des opérations ; il vaut mot pour mot ici, **à une différence près** :

`APP_URL` et `API_URL` valent l'origine **de la distribution CloudFront**, pas
celle de l'ALB. C'est `terraform output app_url` qui la donne.

### 2.5 Les variables de dépôt

`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `AWS_TERRAFORM_ROLE_ARN` au niveau du
**dépôt** — jamais d'un environnement, sous peine de désaccorder les deux gardes
de `deploy-production.yml`. Puis `APP_URL` et `PROD_TFVARS`. Le détail est au §3
de [../github-setup.md](../github-setup.md).

`PROD_TFVARS` mérite qu'on s'y arrête : elle porte le contenu du `.tfvars` de
l'environnement, que le workflow dépose en `ci.auto.tfvars` avant chaque `apply`.
Sans elle, `terraform apply -var image_tag=<sha>` ramène **toutes les autres
variables à leur défaut** — c'est-à-dire qu'il détruit la distribution
CloudFront, sa Web ACL de bord et les deux certificats ACM, et remplace le
certificat du listener 443 par un repli auto-signé. Le workflow **échoue** donc
quand elle est absente, plutôt que d'avertir.

### 2.6 L'approbation manuelle de l'environnement `prod`

La règle « required reviewers » sur l'environnement GitHub `prod`. Elle n'est pas
disponible sur le plan Free : voir §2 de [../github-setup.md](../github-setup.md)
pour ce qui tient lieu de barrière en attendant, et pour la commande à jouer une
fois le plan relevé.

Tant qu'elle n'est pas posée, le quatrième critère de #77 n'est **pas** tenu :
le bloc `environment: prod` existe dans le workflow, mais il ne retient personne.
C'est l'un des points suivis par #590.

---

## 3. Le premier apply

Il se joue à la main, depuis une session humaine avec des identifiants AWS, et
**après avoir relu le plan**. Ce n'est pas un `apply` comme un autre : il crée le
VPC, la base, le cache, l'ALB et la distribution d'un coup.

```bash
cd infra/terraform/envs/prod
terraform init -backend-config="kms_key_id=<uuid>"
terraform plan -out=tfplan
```

Ce qu'il faut chercher dans ce plan, dans l'ordre :

1. **Aucune destruction.** Sur un premier apply, il ne doit y en avoir aucune.
2. **`multi_az = true`** sur `aws_db_instance` — le premier critère. Une
   précondition du module le refuse déjà, mais le lire vaut mieux que le
   supposer.
3. **Deux NAT Gateway**, une par zone.
4. **`min_capacity = 2` et `max_capacity = 8`** sur les deux cibles
   d'auto-scaling.
5. **Deux `aws_wafv2_web_acl`**, dont une en `scope = "CLOUDFRONT"`.
6. **`deletion_protection = true`** sur la base et sur l'ALB.
7. La classe d'instance RDS, confrontée au seuil de l'alarme de connexions :
   `local.rds_max_connections` est saisi à la main dans `main.tf`, et il vaut 450
   pour un `db.t4g.medium`. Changer la classe sans changer cette valeur rend
   l'alarme muette ou hurlante.

Puis :

```bash
terraform apply tfplan
```

**L'attente de validation des certificats est la partie longue.** ACM lit les
CNAME en quelques minutes quand la zone est correcte ; un dépassement du délai de
quinze minutes signale presque toujours une zone qui ne sert pas réellement le
domaine. La distribution CloudFront, elle, met une dizaine de minutes à se
propager après sa création.

### Vérifier ce qui vient d'être créé

```bash
terraform output go_live_blockers
terraform output rds_multi_az                 # true
terraform output nat_gateway_count            # 2
terraform output ecs_autoscaling_capacity     # min 2, max 8 sur api et web
terraform output certificates_auto_renew      # true
terraform output certificate_renewal_eligibility   # ELIGIBLE sur les deux
terraform output cloudfront_protected_by_waf  # true
terraform output waf_protects_anything        # true
terraform output backup_continuous_enabled    # true
terraform output observability_alarms_notify  # true
```

`certificate_renewal_eligibility` est le seul verdict qui ne dépende pas de ce
que le code croit : c'est ACM qui répond. C'est la valeur à relire après toute
intervention sur la zone DNS.

---

## 4. Après le premier apply

1. Poser `APP_URL` en variable d'environnement `prod` avec la sortie `app_url`.
2. Déposer le JSON du secret d'exécution (§2.4), avec `APP_URL` et `API_URL`
   valant cette même origine.
3. Confirmer les abonnements SNS : Terraform crée l'abonnement, il ne peut pas le
   confirmer. Un abonnement non confirmé ne reçoit rien — ce qui, en production,
   revient à n'avoir aucune alerte. Il y en a **deux** à confirmer : celui du
   topic budgétaire, et celui du topic de bord dans `us-east-1`
   (`waf_edge_alerts_topic_arn`).
4. Demander la sortie du bac à sable SES et le relèvement du plafond SMS auprès
   du support AWS. Ce sont des délais, pas des gestes : à demander tôt (#83).

---

## 5. Chaque déploiement

Un push sur `main` déclenche `deploy-production.yml`. Il déroule, dans cet ordre :

| Étape | Ce qui échoue si elle échoue |
|---|---|
| Parcours critique de bout en bout | rien n'est déployé, aucun instantané pris |
| **Approbation manuelle** (`environment: prod`) | idem — le job n'a pas démarré |
| **Instantané RDS**, attendu jusqu'à `available` | rien n'est déployé |
| Images construites et poussées | le schéma n'est pas touché |
| `terraform apply` ciblé sur la tâche de migration | idem |
| Migrations, avec attente et lecture du code de sortie | le schéma peut être partiellement migré |
| `terraform apply` complet | les services peuvent être partiellement à jour |
| Attente de stabilité **et** vérification du sha servi | le rollback part |
| Sonde de santé sur l'origine publique | le rollback part |

Deux points méritent d'être connus avant de lire un run rouge.

**L'instantané est attendu, pas seulement demandé.** `create-db-snapshot` rend la
main sur un instantané encore `creating`, et un instantané incomplet ne restaure
rien. Le workflow attend `db-snapshot-completed` — jusqu'à quarante minutes sur
une base Multi-AZ chargée. C'est du temps, et c'est ce qui rend l'instantané
utile le jour où on en a besoin.

**Stable ne veut pas dire déployé.** Le disjoncteur de déploiement d'ECS revient
de lui-même à la révision précédente quand les nouvelles tâches ne passent jamais
le contrôle de santé. Le service redevient alors parfaitement stable — sur
l'ancienne image — et la sonde HTTP passe aussi. Le workflow compare donc
l'étiquette des images de la révision **effectivement servie** au sha du commit
(#579).

**La sonde part sur l'origine publique**, donc sur CloudFront et non sur l'ALB.
Un `502` y désigne presque toujours un certificat d'ALB qui ne couvre pas le nom
d'origine ; un `403`, l'une des deux Web ACL ; un `503`, l'absence de cible
saine ; un `404`, une règle d'écoute manquante.

---

## 6. Revenir en arrière

### 6.1 Ce que le workflow fait seul

`rollback-on-failure` se déclenche quand — et seulement quand — le job `deploy` a
**échoué**. Il ramène chaque service à la définition de tâche qui tournait avant,
attend la stabilité, puis **relit la révision réellement active** et le nombre de
tâches en cours : un rollback demandé n'est pas un rollback abouti.

La révision de retour est **relevée avant le déploiement**, et non déduite après
coup de `deployments[1]`. La nuance décide de tout : une fois
`wait services-stable` revenu, ECS ne garde plus qu'un seul déploiement par
service et l'ancienne révision a disparu de sa réponse. Or c'est exactement
l'état dans lequel la sonde de santé rougit — des tâches saines pour ECS, un
service cassé pour une cliente —, c'est-à-dire la panne que ce rollback existe
pour réparer.

Son résumé de run porte trois choses : les services ramenés en arrière, ceux qui
n'avaient pas été redéployés — il n'y a rien à y défaire —, et **l'identifiant de
l'instantané** pris avant le déploiement.

### 6.2 Ce qu'il ne fait pas, et ne fera pas

**Il ne défait aucune migration de schéma.** `prisma migrate deploy` n'a pas
d'inverse, et restaurer un instantané perd toutes les écritures postérieures —
des rendez-vous pris, des paiements encaissés. C'est une décision humaine, jamais
une étape de workflow.

Le corollaire gouverne la manière d'écrire les migrations, et il est plus
important que tout ce qui précède : **une migration doit être additive et
rétrocompatible**. La révision précédente doit pouvoir tourner sur le schéma
nouveau — sinon ce rollback rend un service qui ne démarre plus, et il ne reste
que la restauration.

### 6.3 Revenir sur un déploiement déjà réussi

Le rollback automatique ne couvre que l'échec. Un défaut découvert une heure plus
tard se répare en redéployant un sha connu :

```bash
gh workflow run deploy-production.yml --ref main
```

...après avoir ramené `main` sur le commit voulu, ou en redéployant à la main la
définition de tâche d'une révision antérieure :

```bash
aws ecs update-service --cluster spa-prod-cluster --service spa-prod-api \
  --task-definition spa-prod-api:<révision>
aws ecs wait services-stable --cluster spa-prod-cluster --services spa-prod-api
```

C'est aussi la raison pour laquelle `max_tagged_images` vaut 30 sur les dépôts
ECR de production : l'image d'il y a trois semaines doit encore exister ce
jour-là.

### 6.4 Restaurer la base

Voir [pra-restauration-rds.md](pra-restauration-rds.md). L'instantané de
pré-déploiement s'y ajoute aux points de restauration du coffre : il est nommé
`spa-prod-predeploy-<horodatage>` et porte les étiquettes `Commit` et `Workflow`,
qui disent quel déploiement l'a pris.

---

## 7. Ce qui n'est pas tenu tant qu'un compte AWS n'existe pas

Ce dépôt n'a accès à aucun compte AWS. Trois choses de ce document ne sont donc
**pas** vérifiées, et aucune ne se simule :

- **le premier `apply` lui-même** — un plan relu n'est pas un plan appliqué ;
- **la vérification effective du rollback** — sixième critère de #77. Ce qui
  s'apprend en le jouant, et rien d'autre : le temps réel du retour en arrière,
  le comportement du disjoncteur d'ECS pendant que le workflow agit lui aussi,
  et ce que le service sert pendant la bascule ;
- **l'approbation manuelle**, qui dépend d'une règle indisponible sur le plan
  GitHub Free (§2.6).

Ces gestes sont suivis par **#590**, rattachée au jalon S4, qui porte le
protocole détaillé de chacun. Le découpage est le même que celui de #76 → #588 :
le volet code est livré et validé par `terraform fmt`, `terraform validate` et le
contrôle syntaxique des workflows ; ce qui exige un compte réel attend une
session humaine.
