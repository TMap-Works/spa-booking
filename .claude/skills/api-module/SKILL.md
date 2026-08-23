---
name: api-module
description: Conventions du backend NestJS — structure d'un module métier du monolithe modulaire, découpage contrôleur/service/repository, DTO et validation, contrats partagés, gestion d'erreurs, migrations Prisma. À charger avant de créer ou modifier quoi que ce soit dans apps/api.
---

# Backend NestJS — monolithe modulaire

Le CDC §2.1 impose un **monolithe modulaire** : un backend unique, découpé en
modules métier découplés, extractibles plus tard en services distincts. La
discipline de découplage se joue maintenant, pas au moment de l'extraction.

## 1. Les huit modules

Le découpage est celui du CDC §2.3 et ne s'improvise pas. Un nouveau besoin
trouve sa place dans un module existant ; créer un neuvième module se justifie
en ADR.

| Module | Responsabilité |
|---|---|
| `identity` | Auth clients/staff/admin, rôles, permissions, tenants |
| `catalog` | Services, catégories, durée, prix, affectation aux praticiens |
| `availability` | Créneaux libres, horaires du staff, plages bloquées, buffers |
| `appointments` | Cycle de vie du RDV, report, annulation, no-show |
| `crm` | Profils clients, coordonnées, notes, historique de visites |
| `payments` | Encaissement, tokenisation, ventes retail, transactions |
| `notifications` | Confirmations, rappels, annulations, modèles, planification |
| `reporting` | Agrégation revenu, volume de RDV, no-shows, exports |

## 2. Structure d'un module

```
apps/api/src/modules/appointments/
  appointments.module.ts        déclaration Nest, imports explicites
  appointments.controller.ts    HTTP uniquement : routes, codes, sérialisation
  appointments.service.ts       règles métier — le seul endroit qui décide
  appointments.repository.ts    accès Prisma — le seul endroit qui connaît le schéma
  dto/
    create-appointment.dto.ts
    reschedule-appointment.dto.ts
  events/
    appointment-confirmed.event.ts
  __tests__/
    appointments.service.spec.ts
    appointments.e2e-spec.ts
    appointments.isolation-spec.ts   ← test de fuite inter-tenant, obligatoire
```

Règles de couche :

- Le **contrôleur** ne contient aucune règle métier. Il traduit HTTP ↔ service.
- Le **service** ne connaît ni `Request`, ni `Response`, ni Prisma. Il est testable
  sans HTTP ni base.
- Le **repository** est le seul à importer le client Prisma. Il renvoie des
  entités du domaine, pas des types générés par Prisma.

## 3. Couplage entre modules

Un module **n'importe jamais le repository d'un autre module**. Deux voies
autorisées :

1. **Appel de service** pour une lecture synchrone nécessaire :
   `AppointmentsService` injecte `CatalogService` pour connaître la durée d'un
   service. L'import se fait via le `Module`, pas par un chemin relatif profond.
2. **Événement** pour tout ce qui est réaction asynchrone :
   `appointments` émet `appointment.confirmed` ; `notifications` l'écoute.
   `appointments` ne doit rien savoir de l'existence des notifications.

Un import du type `../../payments/payments.repository` est un défaut à corriger,
pas un raccourci acceptable.

## 4. DTO, validation et contrats

- Toute entrée est un DTO annoté `class-validator`, avec
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` en global.
  Le `whitelist` est ce qui empêche l'injection de champs non prévus — dont
  `tenantId`.
- Toute sortie passe par un DTO de réponse explicite. Ne jamais renvoyer une
  entité Prisma brute : c'est ainsi qu'on fuite `passwordHash`, `tenantId` ou
  les notes internes du staff.
- **Les types partagés vivent dans `packages/shared`.** Le front importe depuis
  `@spa/shared`, il ne redéclare jamais un type d'API. Un changement de contrat
  se fait dans `packages/shared` en premier ; les erreurs de compilation qui en
  découlent sont la liste de travail.
- L'API est versionnée par URI : `/api/v1/...`. Un changement cassant crée `v2`,
  il ne modifie pas `v1`.
- OpenAPI est généré depuis les décorateurs `@nestjs/swagger`, exposé en dev et
  recette sur `/api/docs`, désactivé en production.

## 5. Erreurs

Les exceptions métier sont des classes du domaine, converties en HTTP par un
filtre global. Un service ne lève jamais une `HttpException`.

| Situation | Exception domaine | HTTP |
|---|---|---|
| Ressource absente ou hors tenant | `NotFoundError` | 404 |
| Créneau pris entre-temps | `SlotNoLongerAvailableError` | 409 |
| Transition de statut interdite | `InvalidStateTransitionError` | 422 |
| Règle métier violée | `BusinessRuleError` | 422 |
| Droits insuffisants | `ForbiddenError` | 403 |

Le corps d'erreur est stable et documenté :

```json
{ "code": "SLOT_NO_LONGER_AVAILABLE", "message": "...", "details": {} }
```

Le front réagit sur `code`, jamais sur `message` — le message est traduisible et
peut changer.

## 6. Migrations Prisma

- Une migration par PR, nommée en clair : `20260901_add_appointment_exclusion`.
- Les migrations sont **additives par défaut**. Supprimer une colonne se fait en
  deux déploiements (cesser de lire, puis supprimer) pour ne pas casser la
  version en cours d'exécution pendant un déploiement progressif.
- Toute table métier : `tenant_id` non nullable, `created_at`, `updated_at`.
- Ce que Prisma ne sait pas exprimer (contrainte d'exclusion `EXCLUDE USING gist`,
  index partiels) s'écrit en SQL brut dans le fichier de migration, avec un
  commentaire expliquant pourquoi.
- Jamais de `prisma db push` ni de `migrate reset` sur une base partagée.

## 7. Configuration et secrets

- Toute variable d'environnement est déclarée et validée au démarrage (schéma
  Zod ou Joi). L'application **refuse de démarrer** si une variable manque —
  mieux vaut échouer au déploiement qu'à la première requête client.
- En local : `.env.local`, non versionné. En déployé : AWS Secrets Manager, lu
  via le rôle IAM de la tâche ECS. Aucun secret dans le code, les logs ou les
  images Docker.

## 8. Avant d'ouvrir la PR

- [ ] Tests unitaires du service
- [ ] Test d'intégration des endpoints
- [ ] Test d'isolation inter-tenant
- [ ] Migration relue (réversible, additive)
- [ ] Types exposés ajoutés à `packages/shared`
- [ ] Aucune entité Prisma renvoyée directement
- [ ] Décorateurs Swagger à jour
