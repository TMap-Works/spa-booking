# apps/api — Backend NestJS

Monolithe modulaire. Conventions détaillées :
[.claude/skills/api-module/SKILL.md](../../.claude/skills/api-module/SKILL.md).

```
src/
  modules/
    identity/        auth, rôles, permissions, tenants
    catalog/         services, catégories, prix, affectations
    availability/    calcul des créneaux, horaires, plages bloquées
    appointments/    cycle de vie du RDV, report, annulation, no-show
    crm/             profils clients, notes, historique
    payments/        encaissement, Stripe, POS, transactions
    notifications/   confirmations, rappels, modèles
    reporting/       revenu, volume, no-shows
  common/            guards, filtres, décorateurs, contexte tenant
  config/            validation des variables d'environnement
prisma/
  schema.prisma
  migrations/
```

Chaque module suit la même structure : `*.module.ts`, `*.controller.ts`
(HTTP uniquement), `*.service.ts` (règles métier), `*.repository.ts` (seul à
connaître Prisma), `dto/`, `events/`, `__tests__/` incluant un test d'isolation
inter-tenant.
