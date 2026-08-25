# bootstrap — état distant et verrouillage

Ce module crée ce dont **tous** les autres modules Terraform dépendent : un état
distant chiffré, versionné et verrouillé, isolé par environnement.

Il s'applique **une fois**, avant tout le reste. Sans lui, deux `apply` concurrents
écrivent l'état l'un par-dessus l'autre et laissent des ressources orphelines —
toujours facturées, mais que plus aucun code ne sait nommer.

## Ce qu'il crée, par environnement

| Ressource | Nom | Rôle |
|---|---|---|
| Bucket S3 | `spa-booking-{env}-tfstate` | Héberge l'état, versionné et chiffré |
| Table DynamoDB | `spa-{env}-tflock` | Verrou d'écriture (clé de partition `LockID`) |
| Clé KMS + alias | `alias/spa-{env}-tfstate` | Chiffre le bucket **et** la table |

Trois environnements par défaut — `dev`, `staging`, `prod` — donc trois états
strictement étanches. Les clés étant distinctes, une politique IAM qui n'autorise
`kms:Decrypt` que sur la clé de `dev` interdit de lire l'état de `prod` — la
séparation est offerte par ce module, mais c'est IAM qui la rend effective (voir
« Choix de sécurité »).

### Pourquoi un seul état pour les trois environnements

C'est la seule entorse à la règle « un état par environnement », et elle est
inévitable : ce module *fabrique* cette séparation, il ne peut pas encore en
bénéficier. Il reste le seul dans ce cas — `envs/{dev,staging,prod}` ont chacun le
leur dès l'amorçage terminé.

## Amorçage

À faire une fois, par une identité disposant des droits d'administration sur le
compte AWS cible. Depuis ce répertoire :

```bash
terraform init            # état local — les buckets n'existent pas encore
terraform plan
terraform apply
terraform output backend_configuration
```

La dernière commande affiche, pour chaque environnement, les valeurs exactes
attendues par son bloc `backend`. **Elles doivent correspondre trait pour trait à
ce qui est déjà versionné dans `envs/<env>/backend.tf`.** Un écart signifie qu'un
environnement pointe vers un état inexistant : corriger avant d'appliquer quoi que
ce soit d'autre.

### Migrer l'état de l'amorçage

L'état produit ci-dessus est local, donc ni partagé ni verrouillé. Une fois les
buckets créés, le ranger dans celui de production — ajouter un `backend.tf` dans ce
répertoire :

```hcl
terraform {
  backend "s3" {
    bucket         = "spa-booking-prod-tfstate"
    key            = "bootstrap/terraform.tfstate"
    region         = "eu-west-3"
    dynamodb_table = "spa-prod-tflock"
    encrypt        = true
  }
}
```

puis :

```bash
# Identifiant de la clé prod, relevé sur l'état local avant migration
terraform output -json state_kms_key_ids

terraform init -migrate-state -backend-config="kms_key_id=<uuid de la clé prod>"
```

> **`kms_key_id` n'est jamais versionné dans un bloc `backend`.** Le backend S3
> n'accepte qu'un identifiant de clé KMS (UUID) ou un ARN de clé : il **rejette les
> alias**, y compris sous forme d'ARN, et `terraform init` échoue sur
> « Invalid KMS Key ARN ». Or l'identifiant n'existe qu'après l'amorçage. Il se
> relève dans la sortie `state_kms_key_ids` et se passe en `-backend-config`.
> Sans lui, `encrypt = true` pose l'en-tête `AES256`, qui l'emporte sur le
> chiffrement par défaut du bucket : l'état est alors chiffré en SSE-S3 et non par
> la clé de l'environnement.

Supprimer ensuite `terraform.tfstate` local. Il est déjà couvert par le
`.gitignore` du dépôt — il ne doit dans tous les cas **jamais** être versionné : il
contient des valeurs sensibles en clair.

### Collision de nom de bucket

Les noms de bucket S3 sont uniques au niveau **mondial**, pas par compte. Si
`spa-booking-{env}-tfstate` est déjà pris, surcharger `state_bucket_prefix` dans un
`terraform.tfvars` (voir `terraform.tfvars.example`) et **reporter le nouveau nom
dans les trois `envs/*/backend.tf`** — un bloc `backend` n'accepte ni variable ni
interpolation, la valeur y est nécessairement littérale.

## Choix de sécurité

- **Chiffrement par clé gérée par le client** (KMS), et non par clé S3 par défaut :
  l'état contient des identifiants, des ARN et des paramètres de connexion. Une clé
  propre à chaque environnement donne une frontière de déchiffrement en plus de la
  frontière d'accès. Rotation annuelle automatique activée.
  Ces clés portent la **politique KMS par défaut**, qui délègue entièrement à IAM :
  la frontière n'est donc effective que si les politiques IAM ciblent l'ARN d'une
  clé précise. Un rôle disposant de `kms:Decrypt` sur `*` lit les trois états. Le
  rôle OIDC de #14 doit être écrit en conséquence.
- **`bucket_key_enabled`** réduit d'environ deux ordres de grandeur le nombre
  d'appels KMS facturés, sans changer la protection.
- **Accès public bloqué** par les quatre interrupteurs de
  `aws_s3_bucket_public_access_block` — trois sur quatre laissent une porte ouverte.
- **ACL désactivées** (`BucketOwnerEnforced`) : la politique de bucket devient le
  seul mécanisme d'autorisation, ce qui supprime une source classique d'exposition
  accidentelle.
- **Politique de bucket** : refus du transport en clair (`aws:SecureTransport`) et
  refus de tout principal extérieur au compte. Les refus sont évalués avant les
  autorisations IAM — un rôle trop permissif ne suffit donc pas à passer outre.
- **Destruction empêchée** : `prevent_destroy` sur les buckets et les tables,
  `deletion_protection_enabled` sur DynamoDB, fenêtre de suppression KMS à 30 jours.
  Un `destroy` accidentel ici coûterait l'ensemble de l'infrastructure.
- **Journaux d'accès S3 non activés** — exception assumée, annotée dans le code :
  ils exigeraient un bucket de destination soumis au même contrôle, et la règle se
  mord la queue. La traçabilité repose sur les **événements de données CloudTrail**
  — qui couvrent en plus les lectures faites hors S3, mais qui ne sont **pas activés
  par défaut** et ne sont créés par aucun module de ce dépôt à ce jour. Tant que le
  trail dédié n'existe pas, l'exemption `tfsec` laisse les accès à l'état sans
  journal : c'est une dette à solder avec l'observabilité (#16).

## Coût

Environ **3 à 5 USD par mois** au total : trois clés KMS à 1 USD chacune — soit
3 USD de plancher incompressible —, un stockage S3 de quelques mégaoctets et une
table DynamoDB en facturation à la demande dont le volume se compte en dizaines de
requêtes par `apply`.

Deux règles de cycle de vie tiennent le stockage : expiration des versions
antérieures au bout de 90 jours (`noncurrent_version_retention_days`) et abandon des
envois multipart incomplets au bout de 7 jours.

## Ce qui n'est pas ici

- **Le rôle OIDC GitHub Actions** qui permet aux workflows d'obtenir des
  identifiants AWS sans clé statique — c'est #14. Tant que le secret
  `AWS_TERRAFORM_ROLE_ARN` et la variable `AWS_REGION` ne sont pas posés,
  `terraform.yml` échoue à l'étape `configure-aws-credentials`, avant même
  `terraform init` : le job `Plan` est rouge sur toute PR touchant
  `infra/terraform/**`, y compris celle-ci. Rendre ce workflow tolérant à
  l'absence de rôle — `terraform init -backend=false` puis `validate`, sans étape
  AWS — relève de #14, qui possède `ci:workflows`.
- **Le contenu des environnements** — VPC, ECS, RDS, cache, observabilité. Les
  répertoires `envs/*` ne portent volontairement que leur `backend.tf` : ce sont #11,
  #12, #13 et #16 qui les composeront.
- **L'`apply` sur un compte réel.** Ce module n'a jamais été appliqué : la
  vérification en recette relève de #16, « déployer l'environnement dev de bout en
  bout ».
