# Spa & Salon Booking — MVP

Plateforme SaaS de réservation pour spas, salons de beauté, barbershops et studios
de massage : réservation en ligne pour les clients, back-office pour le salon,
gestion du personnel, encaissement, notifications automatisées et reporting.

> Boucle de valeur du MVP : **réserver → confirmer → honorer → encaisser → mesurer**

| | |
|---|---|
| **Périmètre** | MVP — 6 domaines fonctionnels (CDC §1.4) |
| **Durée cible** | 4 semaines, 4 sprints d'une semaine |
| **Organisation** | [TMap-Works](https://github.com/TMap-Works) |
| **Suivi** | [GitHub Project — Spa & Salon Booking MVP](https://github.com/orgs/TMap-Works/projects/2) |
| **Cahier des charges** | [docs/specs/](docs/specs/) — v1.2, FR et EN |

## Périmètre

**Dans le MVP** — réservation client (catalogue, praticien ou premier disponible,
calendrier temps réel, report/annulation, compte et historique) · back-office
(calendrier jour/semaine, édition manuelle des RDV, horaires du personnel, CRM de
base) · gestion du personnel (comptes, rôles, disponibilités, plages bloquées) ·
paiements (checkout carte/espèces, POS de base) · notifications (confirmation,
rappel J-1, annulation) · reporting de base (revenu, volume, no-shows).

**Hors MVP** — abonnements et forfaits · cartes cadeaux · marketing et e-mailing ·
paie · interface multi-établissement · inventaire · assistant IA · marketplace ·
application mobile native.

## Stack

Next.js 15 · NestJS · TypeScript · PostgreSQL (Prisma) · Redis · Stripe ·
Amazon SES/SNS · Docker · ECS Fargate · Terraform · GitHub Actions

Architecture : **monolithe modulaire multi-tenant**, API-first, tout en
Infrastructure-as-Code. Détail dans [ARCHITECTURE.md](ARCHITECTURE.md).

## Structure

```
apps/api/          NestJS — 8 modules métier (identity, catalog, availability,
                   appointments, crm, payments, notifications, reporting)
apps/web/          Next.js — parcours client public + tableau de bord admin
packages/shared/   Types et contrats d'API partagés (source de vérité)
infra/terraform/   Modules réutilisables + un dossier par environnement
docs/adr/          Architecture Decision Records
docs/specs/        Cahier des charges d'origine (ne pas modifier)
.claude/           Environnement Claude Code — skills, agents, commandes
```

## Démarrage

```bash
npm install
cp .env.example .env.local
docker compose up -d
npm run db:migrate
npm run dev
```

Détail dans [CONTRIBUTING.md](CONTRIBUTING.md).

## Environnements

| Environnement | Branche | Usage |
|---|---|---|
| Development | `develop` | Intégration continue, données fictives |
| Staging | `staging` | Recette, UAT, pré-production |
| Production | `main` | Multi-AZ, haute disponibilité |

## Contribuer

Lire [CONTRIBUTING.md](CONTRIBUTING.md) et [BRANCHING.md](BRANCHING.md).
En résumé : une issue → une branche `feature/<issue>-<slug>` → commits
conventionnels → PR vers `develop` avec `Closes #<issue>`.

## Jalons

| Jalon | Fin de | Critère |
|---|---|---|
| M1 — Fondations | S1 | Infra déployée, CI/CD opérationnel, auth et catalogue fonctionnels |
| M2 — Réservation client | S2 | Un client réserve, reporte, annule, consulte son historique |
| M3 — Back-office & paiements | S3 | Agenda, staff, fiches clients, encaissement et POS |
| M4 — Go-Live | S4 | Périmètre MVP livré, recette validée, durci, en production |
