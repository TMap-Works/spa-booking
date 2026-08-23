# Architecture

Synthèse opérationnelle du CDC §2 et §4. Les décisions et leurs alternatives
écartées sont tracées dans [docs/adr/](docs/adr/).

## Principes

1. **Monolithe modulaire d'abord.** Un backend unique, découpé en modules métier
   découplés, extractibles plus tard en services. Pas de microservices prématurés.
2. **Cloud-native managé.** Services AWS managés partout où c'est possible, pour
   minimiser la charge d'exploitation d'une petite équipe.
3. **Multi-tenant dès la conception.** Isolation logique par `tenant_id` sur toute
   table métier, dès la première migration.
4. **API-first.** Une API REST/JSON versionnée expose toutes les capacités ;
   web client, admin et future application mobile la consomment.
5. **Sécurité et conformité par défaut.** Chiffrement au repos et en transit,
   conformité PCI externalisée au prestataire de paiement, RGPD by design.

## Modules métier

| Module | Responsabilité |
|---|---|
| `identity` | Auth clients/staff/admin, rôles, permissions, tenants |
| `catalog` | Services, catégories, durée, prix, affectation aux praticiens |
| `availability` | Créneaux libres temps réel, horaires, plages bloquées, buffers |
| `appointments` | Cycle de vie du RDV, report, annulation, no-show, anti-double-réservation |
| `crm` | Profils clients, coordonnées, notes, historique de visites |
| `payments` | Encaissement, tokenisation, ventes retail, transactions |
| `notifications` | Confirmations, rappels, annulations, modèles, planification |
| `reporting` | Agrégation revenu, volume de RDV, no-shows, exports |

Un module n'importe jamais le repository d'un autre : appel de service pour une
lecture synchrone, événement de domaine pour toute réaction asynchrone.

## Modèle de données

| Entité | Description | Relations |
|---|---|---|
| `Tenant` | Établissement (salon/spa), fuseau horaire, paramètres | 1–N Staff, Service, Client, Appointment |
| `User` | Compte (client / staff / admin) + rôle | N–1 Tenant ; 1–N Appointment |
| `Service` | Prestation (nom, durée, prix, buffers, catégorie) | N–N Staff ; 1–N Appointment |
| `Staff` | Praticien, horaires récurrents, plages bloquées | N–N Service ; 1–N Appointment |
| `Appointment` | RDV (statut, créneau, praticien) | N–1 Client, Staff, Service |
| `Payment` | Transaction (montant entier, devise, moyen, statut) | 1–1 Appointment ou vente POS |
| `Notification` | Message émis (type, canal, statut, id fournisseur) | N–1 Appointment / Client |

Toutes les tables métier portent `tenant_id`, `created_at`, `updated_at`.
Tout index métier commence par `tenant_id`. Les uniques métier sont composites
avec le tenant.

## Points techniques structurants

**Anti-double-réservation.** Contrainte d'exclusion PostgreSQL
(`EXCLUDE USING gist` sur `tenant_id`, `staff_id`, `tstzrange`, filtrée sur les
statuts actifs). La garantie vient de la base, pas d'une vérification applicative.
Un verrou Redis court améliore l'UX mais ne garantit rien.

**Fuseaux horaires.** Tout est stocké en UTC (`timestamptz`). Les horaires du
personnel sont saisis en heure locale du tenant et convertis à la volée — jamais
de décalage figé, sinon les changements d'heure décalent l'agenda.

**Montants.** Entiers dans la plus petite unité monétaire, avec devise ISO 4217
explicite. Jamais de flottant.

**Notifications.** Aucun appel synchrone à SES/SNS depuis le chemin de requête
HTTP. Événement de domaine ou EventBridge → SQS → Lambda → fournisseur, avec
idempotence garantie par une contrainte d'unicité en base.

## Chaîne d'infrastructure (CDC §4.2)

```
Client / Admin
  → CloudFront (CDN) + AWS WAF
  → Application Load Balancer (HTTPS / ACM)
  → ECS Fargate (conteneurs API + web, multi-AZ)
  → RDS PostgreSQL (Multi-AZ) · ElastiCache Redis
  → S3 (médias) · SES/SNS (notifications) · EventBridge + Lambda (rappels)

Transverse : Cognito · Secrets Manager · CloudWatch/X-Ray · GitHub Actions (CI/CD)
```

Réseau : un VPC par environnement, trois niveaux de sous-réseaux sur 2 AZ
(publics / privés applicatifs / privés données). Les sous-réseaux de données
n'ont aucune route vers Internet.

## Environnements

| | Dimensionnement |
|---|---|
| **dev** | Ressources minimales, mono-AZ, données fictives, arrêtable hors heures |
| **staging** | Proche de la production à échelle réduite |
| **prod** | Multi-AZ, auto-scaling 2→8 tâches, sauvegardes 30 j, supervision complète |

Budget production cible : **430–800 USD/mois** hors SMS (CDC §4.16).
