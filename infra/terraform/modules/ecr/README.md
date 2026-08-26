# ecr — registre d'images, scanné et plafonné

Ce module crée le registre d'images du monorepo : un dépôt Amazon ECR par
application, `spa-{env}-api` et `spa-{env}-web`. C'est le point de passage entre
la CI, qui construit les images, et ECS Fargate, qui les exécute.

Il porte trois garanties que le reste de la chaîne suppose acquises :

- **toute image publiée est analysée** — le scan de vulnérabilités à la
  publication est activé et n'est pas désactivable ;
- **une étiquette ne bouge jamais** — ce que le scan a examiné est ce qui
  s'exécute ;
- **le stockage ne croît pas indéfiniment** — une politique de cycle de vie
  plafonne le nombre d'images conservées.

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Dépôt ECR | `spa-{env}-api` | Images de l'API NestJS |
| Dépôt ECR | `spa-{env}-web` | Images du front Next.js |
| Politique de cycle de vie | une par dépôt | Rétention des images |
| Clé KMS + alias | `alias/spa-{env}-ecr` | Chiffrement des couches au repos |

La clé KMS n'est créée que si `kms_key_arn` n'est pas fourni.

## Composition

```hcl
module "ecr" {
  source = "../../modules/ecr"

  environment = local.environment
}

module "ecs_service" {
  source = "../../modules/ecs-service"

  environment = local.environment

  services = {
    api = {
      image              = "${module.ecr.repository_urls["api"]}:${var.image_tag}"
      ecr_repository_arn = module.ecr.repository_arns["api"]
      # …
    }
  }
}
```

`repository_arns` est ce que le module `ecs-service` attend en
`ecr_repository_arn` : c'est lui qui limite le droit de tirage du rôle
d'exécution de chaque service à **son** dépôt. Sans cela, il faudrait accorder
`ecr:BatchGetImage` sur `*`, c'est-à-dire sur tout le registre du compte.

### La clé KMS ne se propage pas à `ecs-service`

`module.ecr.kms_key_arn` n'a **pas** à être passé en `kms_key_arn` au module
`ecs-service`, et ne le peut d'ailleurs pas : celui-ci n'en accepte qu'une seule,
déjà occupée par la clé des journaux et des secrets.

Ce n'est pas un manque. Contrairement à S3 en SSE-KMS, un dépôt ECR chiffré par
une clé gérée par le client **ne demande aucune permission KMS au tireur** : ECR
crée ses propres grants sur la clé au moment où le dépôt est créé, et déchiffre
les couches pour le compte de l'appelant. Les seules permissions nécessaires au
rôle d'exécution sont les quatre actions `ecr:*` que `ecs-service` accorde déjà.

Si un `CannotPullContainerError` mentionnant KMS apparaissait malgré tout,
vérifier d'abord que la politique de la clé n'a pas été restreinte au point
d'empêcher ECR d'y créer un grant — le module n'en déclare aucune, précisément
pour laisser en place la politique par défaut qui délègue à IAM.

## Le scan de vulnérabilités

`scan_on_push` est **écrit en dur**, pas exposé en variable. Un environnement où
le scan serait désactivé n'est pas un réglage légitime : le scan de base d'ECR
est gratuit, et le rendre configurable ne ferait qu'ouvrir une porte pour un gain
nul.

Ce que ce scan couvre : le système d'exploitation de l'image et ses paquets. Ce
qu'il ne couvre pas : les dépendances npm — celles-là sont analysées en amont par
le job Trivy de [`security-scan.yml`](../../../../.github/workflows/security-scan.yml),
qui lit le dépôt. Les deux sont complémentaires ; aucun ne remplace l'autre.

Les résultats ne sont pas rapatriés dans la CI : ils apparaissent dans la console
ECR et dans Security Hub. Faire échouer un déploiement sur un CVE découvert
*après* la construction demande un contrôle distinct, à l'appel de
`ecs update-service` — hors périmètre de ce module.

## Pourquoi des étiquettes immuables

`image_tag_mutability = "IMMUTABLE"` : republier une étiquette existante est
refusé par le registre.

Une définition de tâche ECS référence une image par étiquette. Si l'étiquette
peut être déplacée, deux tâches de la même révision peuvent tourner sur deux
images différentes, et le contenu que le scan a examiné n'est plus celui qui
s'exécute — sans qu'aucun plan Terraform ni aucun déploiement ne montre de
différence.

Cela n'impose rien de neuf au déroulé normal : `deploy-dev.yml` étiquette par
`github.sha`, unique par commit, et chaque push sur `develop` publie donc une
étiquette neuve.

**Republier un commit déjà publié échoue**, en revanche, avec
`ImmutableTagException` — et cela concerne deux gestes courants :

- un `workflow_dispatch` de `deploy-dev.yml` sur un commit déjà déployé ;
- la relance d'un job de déploiement qui a échoué **après** son `docker push`.

Dans les deux cas, l'échec tombe avant l'`ecs update-service` et rien n'est
déployé. Redéployer un commit déjà publié ne passe pas par une republication de
l'image — elle n'a pas changé — mais par un déploiement forcé du service :

```
aws ecs update-service --cluster spa-dev --service spa-dev-api --force-new-deployment
```

Le jour où ce détour coûte plus qu'il ne protège, c'est le workflow qu'il faut
rendre idempotent (ne pousser que si l'étiquette est absente), pas la mutabilité
qu'il faut rouvrir.

## Rétention

Deux règles, évaluées par priorité croissante :

| Priorité | Sélection | Action |
|---|---|---|
| 1 | images sans étiquette de plus de `untagged_image_retention_days` jours | supprimer |
| 2 | au-delà de `max_tagged_images` images — **étiquetées ou non** — les plus anciennes | supprimer |

La règle 2 sélectionne `any` et non `tagged`, parce qu'ECR exige un
`tagPrefixList` avec `tagged` et que les étiquettes sont des SHA sans préfixe
commun. Elle compte donc aussi les images orphelines que la règle 1 n'a pas
encore expirées : le nombre d'images **étiquetées** réellement conservées peut
descendre sous `max_tagged_images`, au pire de ce qu'une fenêtre de
`untagged_image_retention_days` jours accumule.

Une image perd son étiquette quand une construction échoue à mi-course : elle
n'est plus référencée par rien mais reste facturée. Une image d'API pèse
quelques centaines de mégaoctets et chaque push sur `develop` en publie une :
sans plafond, le poste ECR grossit sans bruit (skill `aws-infra` §9).

Le défaut — 30 images étiquetées — laisse de quoi revenir plusieurs déploiements
en arrière, ce qui est le seul usage réel des anciennes images.

## Variables

| Variable | Défaut | Remarque |
|---|---|---|
| `environment` | — | `spa-{environment}-{application}` |
| `applications` | `["api", "web"]` | Un dépôt par entrée |
| `max_tagged_images` | `30` | 5 à 1000, étiquetées ou non |
| `untagged_image_retention_days` | `7` | 1 à 90 |
| `kms_key_arn` | `null` | `null` fait créer une clé dédiée |
| `kms_deletion_window_in_days` | `30` | 7 à 30 |
| `force_delete` | `false` | Vrai autorise `destroy` sur un dépôt non vide |

## Sorties

| Sortie | Usage |
|---|---|
| `repository_urls` | Attribut `image` d'un service ECS, suffixé de `:{étiquette}` |
| `repository_arns` | `ecr_repository_arn` du module `ecs-service` |
| `repository_names` | Nom court, tel que l'emploient les workflows de déploiement |
| `registry_id` | Identifiant du compte propriétaire du registre |
| `kms_key_arn` | Clé de chiffrement — pour l'audit et la rotation, pas pour `ecs-service` |
| `image_scanning_enabled` | Toujours vrai — pour affirmer la garantie dans un contrôle |

## Ce que ce module ne fait pas

- **Il ne réplique pas les images entre régions.** Un seul environnement par
  région au MVP.
- **Il ne pousse aucune image.** C'est le rôle des workflows de déploiement, qui
  s'authentifient par OIDC (module `oidc`).
- **Il n'active pas le scan « enhanced » d'Amazon Inspector.** Ce réglage est
  celui du registre entier — un par compte et par région — et non du dépôt : le
  poser dans un module composé une fois par environnement ferait que le dernier
  `apply` gagne, en écrasant silencieusement le réglage des deux autres. Il a sa
  place dans `bootstrap`, qui est déjà le seul endroit à portée de compte.
