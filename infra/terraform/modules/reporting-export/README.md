# Module `reporting-export`

Le bucket qui reçoit les exports CSV du reporting, et la politique qui permet à
l'API de les y déposer et de les signer — [#563](https://github.com/TMap-Works/spa-booking/issues/563).

## Ce qu'il crée

| Ressource | Rôle |
|---|---|
| `aws_s3_bucket` | `spa-{env}-reporting-exports-{compte}` — le nom d'un bucket est unique à l'échelle du monde, d'où le suffixe |
| chiffrement par défaut | `AES256`, ou `aws:kms` si `kms_key_arn` est fourni |
| blocage d'accès public | les quatre drapeaux, sans exception |
| propriété des objets | `BucketOwnerEnforced` — les ACL sont hors jeu |
| cycle de vie | expiration des exports à `retention_days`, abandon des multipart incomplets à 1 jour |
| politique de bucket | refus du transport en clair, refus de tout principal hors du compte |
| `aws_iam_policy` | `PutObject` + `GetObject` sur `exports/*`, et rien d'autre |

## Ce qu'il ne crée pas

- **aucune clé KMS.** Une clé créée par un module et détruite avec lui emporte la
  lisibilité de tout ce qu'elle a chiffré, et c'est ici le module d'un
  environnement qu'on recrée. `kms_key_arn` prend une clé du compte quand on en
  veut une ;
- **aucun rattachement de rôle.** Le module rend `producer_policy_arn` ;
  l'environnement l'attache au service `api` de `ecs-service`. C'est le sens
  habituel du dépôt — un module déclare ce qu'il offre, l'environnement compose ;
- **aucune alarme.** Il n'y a pas de chaîne asynchrone ici : un export qui échoue
  échoue *dans la requête*, avec son code d'erreur, et se voit dans les journaux
  de l'API.

## Composition

```hcl
module "reporting_export" {
  source = "../../modules/reporting-export"

  environment    = local.environment
  retention_days = 7
}
```

Puis, sur le service `api` du module `ecs-service` :

```hcl
environment = {
  AWS_REGION           = data.aws_region.current.name
  REPORT_EXPORT_BUCKET = module.reporting_export.bucket_name
}

task_role_policy_arns = [module.reporting_export.producer_policy_arn]
```

`AWS_REGION` n'est pas facultative : contrairement à Lambda, ECS n'injecte
**aucune** variable de région dans le conteneur, et le SDK JS v3 ne la résout que
depuis `AWS_REGION`, `AWS_DEFAULT_REGION` ou un profil de configuration. Sans
elle, le bucket est bien là, la politique est bien attachée, et chaque export
échoue sur « Region is missing » — un 500, pas un 503.

Sans `REPORT_EXPORT_BUCKET`, l'API démarre et sert ses trois routes de rapport ;
seule la route d'export répond **503**. C'est le défaut fermé retenu partout
ailleurs dans le dépôt pour une capacité non branchée.

## L'isolation entre établissements ne vient pas d'ici

C'est le point à ne pas se tromper en relisant ce module.

La clé d'un export est `exports/{tenant_id}/{export_id}.csv`, et le `tenant_id`
vient du **jeton vérifié**, côté application
([`report-export.key.ts`](../../../../apps/api/src/modules/reporting/export/report-export.key.ts)).
Aucune politique IAM statique ne saurait reproduire cette frontière : elle
devrait nommer des établissements qui n'existent pas encore, et changer à chaque
inscription.

Ce que la politique de ce module borne, c'est l'**usage** : l'API ne peut ni
énumérer le bucket (`ListBucket` n'est pas accordé), ni effacer un objet, ni
toucher quoi que ce soit hors du préfixe `exports/`. La frontière entre salons,
elle, est tenue par la forme de la clé et prouvée par
`apps/api/test/reporting-export.isolation-spec.ts`.

## Variables

| Nom | Défaut | Rôle |
|---|---|---|
| `environment` | — | entre dans le nom du bucket et de la politique |
| `retention_days` | `7` | purge des exports, entre 1 et 90 jours |
| `kms_key_arn` | `null` | clé client ; à défaut, chiffrement géré par S3 |

## Deux exemptions `tfsec`, et leur raison

- **journaux d'accès S3** — ils exigeraient un bucket de destination soumis au
  même contrôle, et la règle se mord la queue. Les événements de données du trail
  du compte couvrent les accès aux objets, URL présignées comprises ;
- **versionnement** — un objet est écrit une fois sous une clé tirée au sort et
  n'est jamais réécrit. Le versionnement ajouterait une population d'objets non
  courants à purger par une seconde règle, et c'est ainsi qu'un bucket « purgé »
  finit par contenir cinq ans de chiffre d'affaires.
