# network — VPC, sous-réseaux, NAT, endpoints

Socle réseau d'un environnement (CDC §4.3). Tout le reste de l'infrastructure s'y
pose : c'est la segmentation décrite ici qui rend applicables les règles de
groupes de sécurité, l'isolation de la base et la maîtrise du coût de sortie.

Le module ne porte **aucune valeur spécifique à un environnement** : ce qui varie
est une variable. La composition se fait dans `envs/{dev,staging,prod}`.

## Ce qu'il crée

| Ressource | Nombre | Rôle |
|---|---|---|
| VPC `/16` | 1 | `spa-{env}-vpc`, DNS et noms d'hôtes activés |
| Sous-réseaux `/20` | 3 niveaux × N zones | publics, privés applicatifs, privés données |
| Internet Gateway | 1 | Entrée et sortie du niveau public |
| NAT Gateway + Elastic IP | `nat_gateway_count` | Sortie du niveau applicatif |
| Tables de routage | 2 + N | publique, données, et une par zone applicative |
| Endpoint de passerelle | 1 | S3 |
| Endpoints d'interface | 4 | `ecr.api`, `ecr.dkr`, `secretsmanager`, `logs` |
| Groupe de sécurité | 1 | HTTPS depuis les sous-réseaux privés vers les endpoints d'interface |

Le groupe de sécurité par défaut du VPC et sa table de routage principale sont
repris et vidés : rien ne les référence, mais toute ressource créée sans choix
explicite y atterrit.

## Les trois niveaux

```
                    Internet
                        │
                   ┌────┴────┐
                   │   IGW   │
                   └────┬────┘
    public       ┌──────┴──────┐        ALB, NAT Gateway
    10.x.0.0/20  │  0.0.0.0/0 → IGW
                 └──────┬──────┘
                    ┌───┴───┐
                    │  NAT  │
                    └───┬───┘
    app          ┌──────┴──────┐        ECS Fargate, Lambda
    10.x.64.0/20 │  0.0.0.0/0 → NAT
                 └─────────────┘

    data         ┌─────────────┐        RDS, ElastiCache
    10.x.128.0/20│  aucune route sortante
                 └─────────────┘
```

**Le niveau données n'a aucune route vers Internet.** Ni directe, ni par NAT.
`routes.tf` ne déclare aucune ressource `aws_route` sur sa table : ce qui la
traverse se limite à la route locale du VPC et à la liste de préfixes de
l'endpoint S3, dont le trafic ne quitte jamais le réseau AWS. Une ressource qui
a besoin d'un accès sortant relève du niveau applicatif, pas du niveau données —
et si un plan fait apparaître une route de plus sur `spa-{env}-rtb-data`, c'est
un défaut à corriger avant l'`apply`, pas un détail de revue.

## Plan d'adressage

Le `/16` est découpé en seize `/20`, quatre réservés par niveau. Le rang de la
zone détermine le bloc à l'intérieur du niveau.

| Niveau | Blocs réservés | Zone A | Zone B |
|---|---|---|---|
| public | 0 – 3 | `10.x.0.0/20` | `10.x.16.0/20` |
| app | 4 – 7 | `10.x.64.0/20` | `10.x.80.0/20` |
| data | 8 – 11 | `10.x.128.0/20` | `10.x.144.0/20` |

Ajouter une troisième zone consomme un bloc déjà réservé et ne renumérote rien.
C'est l'intérêt de la réservation : renuméroter forcerait la recréation de tous
les sous-réseaux, donc de tout ce qui y est attaché.

Les environnements occupent des plages disjointes — `10.10/16` en dev,
`10.20/16` en staging, `10.30/16` en production — pour qu'un appairage reste
possible sans renumérotation.

## Le nombre de NAT Gateway est un arbitrage de coût

`nat_gateway_count` vaut **1 en dev et staging, 2 en production**. Une NAT
Gateway se facture à l'heure *et* au gigaoctet traité : c'est l'un des postes les
plus chers du CDC §4.16, et l'un de ceux qui gonflent sans bruit. Avec une seule
passerelle, la perte de sa zone coupe la sortie Internet des deux zones
applicatives — acceptable hors production, pas en production, où chaque zone
garde la sienne.

Les endpoints jouent dans le même sens : sans eux, chaque démarrage de tâche
Fargate tire son image ECR et pousse ses logs à travers la NAT.

## Variables

| Variable | Type | Défaut | Rôle |
|---|---|---|---|
| `environment` | `string` | — | Préfixe de nom, `spa-{environment}-…` |
| `vpc_cidr` | `string` | — | `/16` de l'environnement |
| `availability_zone_count` | `number` | `2` | 2 ou 3 |
| `availability_zones` | `list(string)` | `[]` | Zones figées ; vide = les premières de la région |
| `nat_gateway_count` | `number` | `1` | Ne peut pas dépasser le nombre de zones |

Deux préconditions portées par le VPC refusent un `apply` incohérent : plus de
passerelles que de zones, ou une liste de zones plus courte que le nombre
demandé.

## Sorties

`vpc_id`, `vpc_cidr_block`, `availability_zones`, `public_subnet_ids`,
`app_subnet_ids`, `data_subnet_ids`, `public_route_table_id`,
`app_route_table_ids`, `data_route_table_id`, `nat_gateway_ids`,
`nat_gateway_public_ips`, `vpc_endpoint_security_group_id`, `s3_vpc_endpoint_id`,
`interface_vpc_endpoint_ids`.

Les listes de sous-réseaux suivent l'ordre de `availability_zones`, pas l'ordre
de parcours d'une map : un consommateur qui indexe par rang obtient deux fois la
même réponse.

## Utilisation

```hcl
module "network" {
  source = "../../modules/network"

  environment        = "prod"
  vpc_cidr           = "10.30.0.0/16"
  availability_zones = ["eu-west-3a", "eu-west-3b"]
  nat_gateway_count  = 2
}
```

Les trois environnements figent leurs zones. Ce n'est pas facultatif en
pratique : sans cela, une zone déclarée dégradée pendant un incident, ou une zone
nouvellement ouverte au compte qui se trierait avant les autres, décale le rang
de chaque sous-réseau et fait planifier la destruction puis la recréation des
six — donc de tout ce qui y est attaché.

## À savoir avant de modifier

- Les routes sont des ressources `aws_route` autonomes, jamais des blocs `route`
  imbriqués dans `aws_route_table`. Un bloc imbriqué rendrait Terraform
  propriétaire de la liste complète des routes de la table et supprimerait à
  chaque `apply` celle qu'y installe l'endpoint S3 de passerelle.
- Les sous-réseaux sont indexés par **nom de zone**, pas par rang : une réponse
  d'API réordonnée ne doit pas les recréer. `availability_zones`, renseignée par
  chaque environnement, fige ce choix pour de bon.
- La description d'un groupe de sécurité et celle d'une règle sont les deux seuls
  champs du module où l'accent et l'apostrophe sont interdits : l'API EC2 les
  rejette et fait échouer l'`apply`. Les étiquettes, elles, acceptent l'Unicode.
- Le module ne déclare pas de `provider` : les étiquettes obligatoires
  (`Project`, `Environment`, `ManagedBy`, `Owner`) viennent du `default_tags` de
  l'environnement appelant.
