# Runbook — monter et exercer l'environnement de recette

**Cible du CDC §4.13 : un environnement de recette proche de la production, à
échelle réduite, sur lequel le parcours « réserver → confirmer → encaisser » se
joue de bout en bout avant chaque mise en production.**

Ce document couvre l'environnement `staging` : ce qu'il faut poser avant le
premier `terraform apply`, dans quel ordre, comment y charger le jeu de données
de recette, et comment vivre avec son arrêt hors heures ouvrées.

Il suppose une session humaine avec des **identifiants AWS sur le compte du
projet**. Ce n'est pas une formalité : aucune de ces étapes n'est jouable depuis
la CI, et aucune n'est jouable par un agent — voir la dernière section.

---

## 0. Ce que l'environnement est, et ce qu'il n'est pas

`infra/terraform/envs/staging` compose les **onze** modules de `envs/dev` :
`network`, `budgets`, `ecr`, `database`, `cache`, `backup`, `reporting-export`,
`notifications`, `ecs-service`, `waf`, `observability`.

La **forme** est celle de la production. L'**échelle** ne l'est pas :

| | dev | staging | prod |
|---|---|---|---|
| NAT Gateway | 1 | 1 | 2 |
| RDS | `db.t4g.medium` mono-AZ | `db.t4g.medium` mono-AZ | Multi-AZ |
| Réplica Redis | 0 | 0 | 1 |
| Tâches par service | 1 → 4 | 1 → 2 | 2 → 8 |
| Container Insights | non | **oui** | oui |
| Bot Control (WAF) | non | non | oui |
| Limite de débit WAF | 10 000 | **2 000** | 2 000 |
| Arrêt hors heures ouvrées | non | **oui** | non |
| Rétention des journaux | 30 j | 30 j | 90 j |
| Plafond budgétaire | 300 USD | 300 USD | 800 USD |

Deux écarts méritent d'être connus avant de s'étonner :

- **La limite de débit du WAF est celle de la production**, pas celle du
  développement. C'est le point : un parcours de recette qui déclenche la
  limitation doit la déclencher ici, pas chez une cliente. Une campagne de tirs
  de charge la relève explicitement pour sa durée, en sachant qu'elle change ce
  qu'elle mesure.
- **Bot Control n'est pas composé**, seul écart assumé au « proche de la
  production ». C'est le seul groupe de règles facturé — environ 10 USD par mois
  et par Web ACL —, et il représenterait la marge budgétaire entière de cet
  environnement. Conséquence : ses faux positifs ne sont pas éprouvés ici. Ils
  ne couperont personne pour autant, le module laissant ce groupe en **comptage**
  par défaut jusqu'à ce qu'on décide de le faire bloquer.

---

## 1. Avant le premier `terraform apply`

### 1.1 L'amorçage doit être appliqué

L'état de `staging` vit dans le bucket créé par `infra/terraform/bootstrap`
(voir `envs/staging/backend.tf`). Sans lui, `terraform init` n'a pas de backend.

```bash
cd infra/terraform/bootstrap && terraform output backend_configuration
cd infra/terraform/bootstrap && terraform output state_kms_key_ids
```

L'identifiant de clé relevé sert au `init` de l'environnement — sans lui, l'état
est chiffré en SSE-S3 et non par la clé du compte :

```bash
cd infra/terraform/envs/staging
terraform init -backend-config="kms_key_id=<uuid de la clé staging>"
```

### 1.2 Un certificat ACM — le prérequis qu'on découvre trop tard

**C'est la première chose à poser, et la plus facile à oublier.**

`envs/staging` fabrique un certificat auto-signé de repli quand
`certificate_arn` est nul. Ce repli n'existe que pour que le **tout premier**
`apply` aboutisse avant qu'un domaine n'existe — sans quoi il n'y aurait rien sur
quoi poser le vrai certificat. Tant qu'il est en place :

- l'environnement se déploie, l'ALB répond, `/health` passe ;
- **et la recette de bout en bout ne se joue pas.** Les Server Components du
  front rappellent l'API par l'ALB public et `fetch` refuse un certificat qui ne
  se vérifie pas ; les trois Lambda de la chaîne de notifications refusent aussi,
  sans contournement.

Le contrôle, en une commande :

```bash
terraform output tls_certificate_is_self_signed   # doit valoir false
```

Poser `certificate_arn` **et** `public_base_url` ensemble : les deux décrivent le
même passage à un vrai domaine, et une origine annoncée sur un certificat qui ne
la couvre pas fait échouer chaque appel du front vers l'API.

Les poser dans le **`.tfvars` de l'environnement**, jamais en `-var` sur un
`apply` manuel — et reporter ce fichier dans la variable de dépôt
`STAGING_TFVARS` (§1.4). `terraform` ne garde aucune trace des variables passées
en ligne de commande : le déploiement suivant, qui applique depuis la CI, les
ramènerait à leur défaut et remplacerait le vrai certificat par le repli
auto-signé — sans plan relu, `-auto-approve` étant posé.

### 1.3 Le secret d'exécution de l'API

Terraform crée le **conteneur** du secret, jamais sa valeur (skill aws-infra §7).
Le JSON attendu est celui décrit dans `infra/terraform/envs/dev/README.md`, avec
six clés — `API_URL`, `APP_URL`, `DATABASE_URL`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `REDIS_URL` —, plus `NOTIFICATIONS_INTERNAL_TOKEN` dès
qu'une des routes internes de la chaîne de notifications est branchée.

```bash
terraform output api_runtime_secret_arn
terraform output database_endpoint
terraform output database_master_user_secret_arn   # le mot de passe est là, jamais dans l'état
terraform output redis_primary_endpoint
terraform output redis_auth_token_secret_arn
```

`REDIS_URL` est en `rediss://` — le chiffrement en transit est activé.

### 1.4 Les variables de dépôt du déploiement

`deploy-staging.yml` est ignoré tant que les trois ne sont pas posées :
`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `AWS_TERRAFORM_ROLE_ARN`. `APP_URL` s'y
ajoute pour le contrôle de santé post-déploiement (`terraform output app_url`).

`STAGING_TFVARS` s'y ajoute aussi, et c'est celle qu'on oublie : elle porte le
**contenu** du `.tfvars` de l'environnement, que le workflow dépose en
`ci.auto.tfvars` avant d'appliquer.

```hcl
certificate_arn     = "arn:aws:acm:eu-west-3:…:certificate/…"
public_base_url     = "https://recette.reservation.exemple.fr"
notification_domain = "staging.mail.exemple.fr"
budget_alert_emails = ["exploitation@exemple.fr"]
```

Sans elle, le déploiement applique les **défauts** de `envs/staging` : le
certificat auto-signé revient sur le listener 443, et `module.notifications`
repasse à `count = 0` — c'est-à-dire que la CI détruit l'identité SES, la file,
la DLQ et les trois Lambda. Le workflow le dit en avertissement quand la variable
est absente ; il ne peut pas le deviner autrement, `.gitignore` écartant
`*.tfvars` du dépôt.

Toute valeur ajoutée au `.tfvars` local se reporte donc **aussi** ici, sous peine
d'être annulée au déploiement suivant.

---

## 2. Le premier `apply`

```bash
cd infra/terraform/envs/staging
terraform plan  -out=tfplan
terraform apply tfplan
```

Le plan est long : c'est un environnement complet. Trois choses à y regarder
avant d'appliquer :

1. aucune **destruction** — sur un premier apply il ne doit y en avoir aucune ;
2. le nombre de NAT Gateway (1) et l'absence de réplica Redis ;
3. la classe d'instance RDS, à confronter au seuil de l'alarme de connexions —
   `local.rds_max_connections` est saisi à la main dans `main.tf`, et changer
   `instance_class` sans le corriger fausserait l'alarme.

`image_tag` reste à `bootstrap` sur ce premier apply : aucune image n'existe
encore, les tâches ECS échoueront au tirage, et c'est normal. Le premier
déploiement les corrige.

---

## 3. Le premier déploiement

Merger vers `staging` déclenche `deploy-staging.yml`, qui fait dans cet ordre :
construire et pousser les deux images étiquetées du sha, appliquer la définition
de tâche de migration, jouer `prisma migrate deploy` sur Fargate et **attendre
son code de sortie**, appliquer le reste, puis vérifier que les deux services
sont stables **et servent bien le commit déployé**.

Cette dernière garde n'est pas décorative : le disjoncteur de déploiement revient
à la révision précédente quand les nouvelles tâches ne démarrent pas, et le
service redevient parfaitement stable — sur l'ancienne image.

```bash
terraform output ecs_cluster_name
terraform output ecs_service_names
terraform output migrate_task_definition_family
```

---

## 4. Charger le jeu de données de recette

`apps/api/prisma/seed.ts` pose deux établissements, leurs comptes, leur
catalogue, leur personnel, leurs horaires, cinq rendez-vous chacun — un par
statut — et la vente du rendez-vous honoré. Détail et garde-fous :
[apps/api/prisma/README.md](../../apps/api/prisma/README.md).

La base est dans les sous-réseaux **de données**, sans route vers Internet : on
l'atteint par un port forwarding Session Manager, jamais par un bastion SSH à clé
statique (skill aws-infra §4).

```bash
# depuis apps/api, DATABASE_URL pointant sur le tunnel
DATABASE_URL="postgresql://…" SEED_TARGET=staging npm run db:seed
```

`npm run db:seed` délègue à `prisma db seed`, dont la clé `prisma.seed` du
`package.json` porte la ligne de commande complète
`node --require ts-node/register prisma/seed.ts` (#588). Celle-ci reste valable
telle quelle — elle n'est simplement plus la seule.

Le script est **idempotent** : le rejouer entre deux campagnes rafraîchit les
dates des rendez-vous sans dupliquer une seule ligne. Il **refuse** de s'exécuter
si l'hôte, la base ou l'utilisateur de `DATABASE_URL` contient `prod`.

Deux établissements, et non un : c'est ce qui rend l'isolation exerçable. Rejouer
une route avec le jeton du voisin doit rendre **404**, jamais 403, jamais la
donnée.

---

## 5. L'arrêt hors heures ouvrées

Le CDC §4.16 et le skill aws-infra §9 demandent un environnement de recette
**arrêtable hors heures ouvrées**. Il l'est, en Terraform : deux actions
planifiées par service sur la cible d'auto-scaling.

| | |
|---|---|
| Arrêt | 20 h, du lundi au vendredi |
| Reprise | 7 h, du lundi au vendredi |
| Fuseau | `Europe/Paris` |
| Week-end | éteint de lui-même — l'arrêt du vendredi n'est suivi d'aucune reprise avant lundi |

```bash
terraform output off_hours_shutdown_enabled       # true
terraform output off_hours_schedule               # les deux crons et le fuseau
terraform output off_hours_scheduled_action_names  # deux actions par service
```

### Ce qui s'arrête, et ce qui ne s'arrête pas

**Seul le calcul s'arrête** — les tâches Fargate des services `api` et `web`.
L'ALB, la base, le cache, les endpoints d'interface et la NAT Gateway continuent
d'être facturés. L'économie est d'une vingtaine de dollars par mois sur un
nominal d'environ 215 : réelle, et pas miraculeuse.

**La base reste allumée**, délibérément. Deux raisons, dans cet ordre :

1. RDS **redémarre de lui-même** toute instance arrêtée depuis sept jours. Un
   arrêt automatique donnerait donc une économie que personne ne vérifie et un
   redémarrage que personne n'attend ;
2. un merge vers `staging` déclenche une tâche de migration, à n'importe quelle
   heure. Contre une base éteinte, elle échoue — et le déploiement avec elle.

Pour une pause longue et assumée — plusieurs semaines sans campagne —, l'arrêt
manuel reste possible et se note dans le journal d'exploitation :

```bash
aws rds stop-db-instance --db-instance-identifier spa-staging-rds
```

### Un `terraform apply` réveille l'environnement

Une action planifiée modifie la **cible** d'auto-scaling : après l'arrêt du soir,
elle porte `0/0` là où l'état Terraform déclare les capacités du service. Le
`apply` suivant les rétablit, et Application Auto Scaling redémarre les tâches
manquantes.

C'est le comportement voulu — un déploiement lancé à 23 h doit aboutir — mais il
a deux conséquences visibles :

- `terraform plan` montre cette dérive **toutes les nuits**. Ce n'est pas une
  modification à instruire ;
- un déploiement de nuit laisse l'environnement allumé jusqu'à l'arrêt du
  lendemain soir.

### Lever l'arrêt le temps d'une campagne

Ponctuellement, sans toucher au code — la prochaine action planifiée reprendra la
main d'elle-même :

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id "service/spa-staging-cluster/spa-staging-api" \
  --min-capacity 1 --max-capacity 2
# idem pour spa-staging-web
```

Durablement : `off_hours_shutdown = null` dans le `.tfvars` de l'environnement —
et dans `STAGING_TFVARS` avec lui (§1.4), sans quoi le déploiement suivant
rétablirait l'arrêt. **Cela se paie** : le coût nominal passe alors à
environ 237 USD, à un cheveu du seuil d'alerte de 80 % du plafond de 300. Une
campagne qui doit tourner en continu se paie d'un relèvement du plafond, pas
d'une alerte qu'on apprend à ignorer.

### « Le service a disparu »

Un service ECS à `0/0` un lundi matin avant 7 h, ou un week-end, n'est pas une
panne : c'est cette planification. Le réflexe est de lire
`off_hours_schedule` **avant** de chercher ailleurs. `deploy-staging.yml` le dit
lui-même quand il rencontre le cas, plutôt que de laisser lire « 0/0 tâche(s) »
comme un succès muet.

---

## 6. Ce qui reste à exercer — et exige une session humaine

Ces gestes ne sont **jouables par aucun agent** de ce dépôt : il n'y a ni CLI
`aws`, ni identifiants, ni compte à atteindre. Ils sont la moitié non
automatisable de l'issue #76, et font l'objet de l'issue de suivi **#588**.

#588 portait aussi deux points de câblage qui, eux, ne demandaient pas AWS :
`npm run db:seed` et `prisma db seed` invoquent désormais le seed, et
`npm run typecheck` le couvre. Ils sont faits ; le tableau ci-dessous est tout
ce qui reste de l'issue.

| # | Geste | Ce qu'il prouve |
|---|---|---|
| 1 | `terraform apply` réel sur `envs/staging` | Que la composition tient face à l'API AWS — quotas, dépendances, ordre de création |
| 2 | Chargement du jeu de recette dans la base déployée | Que le schéma migré et le seed s'accordent hors du poste de développement |
| 3 | Parcours « réserver → confirmer → encaisser » de bout en bout | Le critère du CDC §4.13, et le seul qui vaille |
| 4 | Un arrêt et une reprise observés | Que les actions planifiées se déclenchent, et que le matin d'après le service revient |
| 5 | Le runbook de restauration, joué ici | Le « restauration effectivement testée » du CDC §4.14 (#82) |

Le cinquième se joue sur cet environnement et pas ailleurs : il porte de vraies
données de recette, et il n'a pas de cliente au bout.
[pra-restauration-rds.md](pra-restauration-rds.md) porte la procédure et son
tableau de relevé de temps.
