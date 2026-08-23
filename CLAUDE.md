# Spa & Salon Booking — MVP

Plateforme SaaS de réservation pour spas, salons de beauté, barbershops et studios
de massage. Boucle de valeur du MVP : **réserver → confirmer → honorer → encaisser → mesurer**.

Cahier des charges de référence : [docs/specs/cdc-fr.txt](docs/specs/cdc-fr.txt) (v1.2, 19 août 2026).
Version anglaise : [docs/specs/cdc-en.txt](docs/specs/cdc-en.txt).

## Contraintes non négociables

1. **Périmètre MVP figé.** Six domaines seulement : réservation client, back-office,
   gestion du personnel, paiements, notifications, reporting de base. Tout le reste
   (abonnements, cartes cadeaux, marketing, payroll, multi-établissement UI,
   inventaire, assistant IA, marketplace) est **hors périmètre**. Si une demande sort
   du périmètre, le dire et ouvrir une issue `post-mvp` plutôt que de l'implémenter.
2. **Multi-tenant dès le premier jour.** Toute table métier porte `tenant_id`.
   Aucune requête ne doit pouvoir traverser la frontière d'un tenant. Voir
   [.claude/skills/tenant-isolation/SKILL.md](.claude/skills/tenant-isolation/SKILL.md).
3. **Aucune donnée de carte bancaire ne touche notre code.** Tokenisation côté client
   vers Stripe. Périmètre PCI limité à SAQ A. Voir
   [.claude/skills/payments-stripe/SKILL.md](.claude/skills/payments-stripe/SKILL.md).
4. **Zéro double réservation.** Contrainte d'exclusion en base + verrou transactionnel,
   jamais une simple vérification applicative. Voir
   [.claude/skills/booking-engine/SKILL.md](.claude/skills/booking-engine/SKILL.md).
5. **Tout en Infrastructure-as-Code.** Aucune ressource AWS créée à la main.

## Stack

| Couche | Choix |
|---|---|
| Web client + Admin | Next.js 15 (App Router) + React + TypeScript |
| Backend / API | NestJS (TypeScript), monolithe modulaire |
| ORM / migrations | Prisma sur PostgreSQL |
| Base de données | PostgreSQL 16 — Amazon RDS Multi-AZ |
| Cache / verrous | Redis — Amazon ElastiCache |
| Paiements | Stripe (tokenisation, webhooks signés) |
| E-mail / SMS | Amazon SES / Amazon SNS |
| Planification | EventBridge Scheduler → SQS → Lambda |
| Conteneurs | Docker → Amazon ECS Fargate |
| IaC | Terraform |
| CI/CD | GitHub Actions |

Décisions figées et leur justification : [docs/adr/](docs/adr/).

## Structure du monorepo

```
apps/api/          NestJS — monolithe modulaire, un dossier par module métier
apps/web/          Next.js — parcours client public + tableau de bord admin
packages/shared/   Types et contrats d'API partagés front/back (source de vérité)
infra/terraform/   Modules réutilisables + un dossier par environnement
docs/adr/          Architecture Decision Records
docs/specs/        Cahier des charges d'origine (ne pas modifier)
scripts/           Outillage projet
```

Les modules métier de `apps/api` reprennent exactement le découpage du CDC §2.3 :
`identity`, `catalog`, `availability`, `appointments`, `crm`, `payments`,
`notifications`, `reporting`.

## Workflow de contribution

GitFlow simplifié, identique aux autres dépôts TMap-Works :
`feature/*` → `develop` → `staging` → `main`. Détail dans
[BRANCHING.md](BRANCHING.md) et [CONTRIBUTING.md](CONTRIBUTING.md).

- Commits en **Conventional Commits** — validés par commitlint en CI.
  Types autorisés : `feat fix docs ci chore security perf hotfix test refactor`.
- Une branche = une issue. Le nom de branche contient le numéro d'issue :
  `feature/42-moteur-disponibilite`.
- Toute PR référence son issue (`Closes #42`) — c'est ce qui déplace
  automatiquement la carte dans le GitHub Project.
- Definition of Done : code revu, testé (unitaire + intégration), déployé en
  recette, documenté.

Pour dérouler ce flux, utiliser les commandes `/feature-start`, `/pr-open`,
`/sprint-status` définies dans [.claude/commands/](.claude/commands/).

## Règles de code

- **TypeScript strict partout.** Pas de `any` implicite, pas de `@ts-ignore` sans
  commentaire justificatif.
- **Les types d'API vivent dans `packages/shared`.** Le front ne redéclare jamais
  un type que l'API expose déjà.
- **Fuseaux horaires : tout est stocké en UTC**, converti à l'affichage selon le
  fuseau du tenant. Un rendez-vous mal fuseau-horairé est un bug de sévérité haute.
- **Argent : jamais de `float`.** Montants en entiers (plus petite unité monétaire)
  avec un code devise explicite.
- **Aucun secret dans le code ni dans `.env` versionné.** AWS Secrets Manager en
  déployé, `.env.local` non versionné en local.

## Tests

- Unitaires : logique métier pure (calcul de créneaux, règles d'annulation, montants).
- Intégration : endpoints API contre une base Postgres jetable (Testcontainers).
- Concurrence : le moteur de réservation a des tests de charge concurrente
  obligatoires — c'est le risque n°1 du projet.
- E2E : le parcours « réserver → confirmer → encaisser » ne doit jamais casser.
