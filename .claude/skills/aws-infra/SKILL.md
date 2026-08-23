---
name: aws-infra
description: Conventions Terraform et infrastructure AWS — organisation des modules et environnements, réseau VPC, ECS Fargate, RDS, sécurité, secrets, observabilité, maîtrise des coûts. À charger avant toute modification de infra/terraform ou dès qu'une tâche parle d'AWS, Terraform, déploiement, VPC, ECS, RDS ou coûts d'infrastructure.
---

# Infrastructure AWS (Terraform)

Le CDC §4 fixe l'architecture cible. Ce document dit **comment on l'écrit**.
Principe non négociable : **aucune ressource AWS créée à la main**. Une ressource
créée dans la console est invisible pour l'équipe, absente des revues, et disparaît
au prochain `terraform apply`.

## 1. Organisation

```
infra/terraform/
  modules/            modules réutilisables, sans valeur en dur
    network/          VPC, sous-réseaux, NAT, endpoints
    ecs-service/      cluster, service, tâche, auto-scaling, ALB
    database/         RDS PostgreSQL, groupes de paramètres, sauvegardes
    cache/            ElastiCache Redis
    storage/          S3 + CloudFront + ACM
    notifications/    SES, SNS, SQS, EventBridge, Lambda
    observability/    CloudWatch, alarmes, tableaux de bord
  envs/
    dev/              main.tf + terraform.tfvars
    staging/
    prod/
```

- Un module **ne contient aucune valeur spécifique à un environnement**. Tout ce
  qui varie est une variable avec un type explicite et une description.
- Un environnement **ne déclare pas de ressource directement** : il compose des
  modules et fournit les valeurs. Si une ressource apparaît dans `envs/`, elle a
  vocation à devenir un module.
- **Un état par environnement**, backend S3 avec verrouillage DynamoDB. Jamais
  d'état local, jamais d'état partagé entre environnements.

## 2. Nommage et étiquetage

Nom des ressources : `spa-{env}-{composant}` — `spa-prod-api`, `spa-dev-rds`.

Étiquettes obligatoires sur tout, via `default_tags` du provider :

```hcl
default_tags {
  tags = {
    Project     = "spa-booking"
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = "TMap-Works"
  }
}
```

Sans ces étiquettes, Cost Explorer ne sait pas répartir la facture et le CDC §4.16
(maîtrise budgétaire) devient inapplicable.

## 3. Réseau (CDC §4.3)

- Un VPC `/16` par environnement, **trois niveaux de sous-réseaux** sur 2 AZ :
  publics (ALB, NAT), privés applicatifs (ECS, Lambda), privés données (RDS,
  ElastiCache).
- Les sous-réseaux de données **n'ont aucune route vers Internet**. Ni directe,
  ni via NAT. Si une tâche a besoin d'un accès sortant, elle est dans le niveau
  applicatif, pas données.
- **VPC Endpoints** pour S3, ECR, Secrets Manager et CloudWatch Logs. Ce n'est pas
  qu'une question de sécurité : le trafic ECR au démarrage des tâches passe sinon
  par la NAT Gateway et coûte cher.
- NAT Gateway : 1 en dev/staging, **2 en production** (une par AZ) pour la
  résilience. C'est un des postes les plus chers du CDC §4.16 — ne pas en créer
  par distraction.

## 4. Groupes de sécurité

Chaîne stricte, référencée par id de groupe et **jamais par bloc CIDR** :

```
Internet → ALB (443)  →  ECS (port applicatif)  →  RDS (5432) / Redis (6379)
```

- Aucune règle entrante `0.0.0.0/0` sauf sur l'ALB en 80/443.
- Aucune base de données joignable depuis Internet. Jamais, même en dev.
- L'accès administrateur à la base passe par un bastion SSM ou du port forwarding
  Session Manager — pas de bastion SSH avec clé statique.

## 5. Compute (CDC §4.4)

- ECS **Fargate** uniquement. Pas d'instances EC2 à administrer.
- Le **rôle de tâche** (permissions de l'application) est distinct du **rôle
  d'exécution** (tirage d'image, écriture de logs). Les confondre donne à
  l'application des droits qu'elle n'a pas besoin d'avoir.
- Chaque politique IAM est **au moindre privilège** et cible des ARN précis.
  `Resource: "*"` doit être justifié en commentaire ou refusé.
- Auto-scaling sur cible d'utilisation CPU ~60 %, 2 → 8 tâches en production.
- Health check ALB sur un endpoint `/health` qui vérifie réellement la base et
  le cache, pas un `200` inconditionnel — sinon une tâche cassée reste en service.
- Déploiement **rolling** avec `minimumHealthyPercent: 100` : aucune coupure.

## 6. Données (CDC §4.5)

- RDS PostgreSQL **Multi-AZ en production**, mono-AZ ailleurs.
- `storage_encrypted = true` et clé KMS partout, y compris en dev.
- `deletion_protection = true` en production, `skip_final_snapshot = false`.
- Sauvegardes automatiques 7 jours en dev/staging, **30 jours en production**.
- `performance_insights_enabled = true` : diagnostiquer une requête lente sans
  cela coûte des heures.
- Le mot de passe maître est généré par Terraform et écrit dans Secrets Manager.
  Il n'apparaît **jamais** dans un `.tfvars`, un dépôt ou une variable CI.
- ElastiCache Redis chiffré en transit et au repos, 1 réplica en production.

## 7. Secrets

- Toute valeur sensible vit dans **AWS Secrets Manager**, lue par le rôle de tâche
  ECS au démarrage.
- Terraform crée le **conteneur du secret**, pas sa valeur. La valeur est
  renseignée hors code, et `lifecycle { ignore_changes = [secret_string] }` évite
  qu'un `apply` l'écrase.
- Ne jamais mettre un secret dans les `environment` d'une définition de tâche :
  elle est lisible par toute personne ayant accès à la console ECS. Utiliser
  `secrets` avec un ARN.
- `terraform.tfstate` contient des valeurs sensibles : chiffrement du bucket
  activé, accès restreint, jamais de state versionné dans Git.

## 8. Observabilité (CDC §4.11)

Alarmes CloudWatch minimales avant tout go-live, notifiées sur un topic SNS :

| Alarme | Seuil |
|---|---|
| ALB 5xx | > 1 % des requêtes sur 5 min |
| Latence p99 ALB | > 2 s |
| CPU ECS | > 80 % sur 10 min |
| Connexions RDS | > 80 % du maximum |
| Espace disque RDS | < 20 % |
| Profondeur DLQ notifications | > 0 |
| Erreurs Lambda | > 0 sur 5 min |

Rétention des logs CloudWatch : 30 jours en dev, 90 jours en production. Sans
rétention explicite, les logs sont conservés indéfiniment et la facture grimpe
silencieusement.

## 9. Coûts (CDC §4.16 — cible 430–800 USD/mois en production)

- `AWS Budgets` avec alerte à 80 % et 100 % du budget mensuel, dès le premier jour.
- Dev et staging **dimensionnés a minima** et arrêtables hors heures ouvrées.
- Attention aux postes qui gonflent sans bruit : NAT Gateway (transfert de
  données), logs CloudWatch sans rétention, snapshots RDS orphelins, adresses IP
  élastiques non attachées.
- Envisager Savings Plans / instances réservées seulement **après 1 à 2 mois** de
  métriques réelles — s'engager sur un mauvais dimensionnement coûte plus cher
  que de ne rien faire.

## 10. Flux de travail

1. `terraform fmt` et `terraform validate` — appliqués en CI, une PR non formatée
   est rejetée.
2. `terraform plan` sur la PR, **le plan est publié en commentaire** et fait
   partie de la revue.
3. `apply` uniquement après merge, via GitHub Actions avec un rôle OIDC — **aucune
   clé d'accès AWS statique dans les secrets GitHub**.
4. Un `apply` en production requiert une approbation manuelle (environnement
   GitHub protégé).
5. Toute suppression ou remplacement de ressource dans un plan de production est
   signalée explicitement en revue. Un `destroy` non intentionnel sur RDS est
   irréversible.
