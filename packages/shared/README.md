# packages/shared — Contrats partagés

**Source de vérité du contrat d'API.** Le front n'y redéclare jamais un type que
l'API expose déjà ; l'API n'y duplique jamais un schéma de validation.

```
src/
  common/     primitives transverses — montants, instants UTC, identifiants, pagination
  constants/  statuts de RDV, rôles, canaux de notification, bornes de champs
  errors/     codes d'erreur stables et enveloppe de réponse en échec
  schemas/    entités et DTO, en schémas Zod dont les types sont inférés
  index.ts    baril racine — tout ce qu'expose `@spa/shared`
```

Un changement de contrat commence ici. Les erreurs de compilation qui en
découlent dans `apps/*` sont la liste de travail.

## Pourquoi Zod plutôt que des `interface`

Une `interface` TypeScript n'existe pas à l'exécution : elle ne dit rien de ce
qui arrive réellement dans un corps de requête. Un schéma Zod, lui, sert deux
usages à partir d'une seule déclaration :

- **côté back, pour la sécurité** — `schema.parse(body)` est ce qui empêche un
  champ non prévu d'entrer. Tous les schémas d'entrée sont `.strict()` : un
  `tenantId` ou un `role` glissé dans un corps sort en 422 nommant le champ, au
  lieu d'être ignoré en silence ;
- **côté front, pour le confort** — le même schéma valide un formulaire avant
  l'aller-retour réseau, et `z.infer` donne le type sans le réécrire.

## Ce que le contrat refuse par construction

| Invariant | Où il est tenu |
|---|---|
| Argent en entiers, devise explicite, aucune conversion implicite | `common/money.ts` |
| Instants en UTC, décalage horaire refusé en entrée | `common/time.ts` |
| `tenantId` ni en entrée ni en sortie, sauf sur l'établissement lui-même | `schemas/tenant.ts` et le `.strict()` des DTO |
| Aucun `passwordHash` dans un schéma de sortie | `schemas/identity.ts` |
| Aucune donnée de carte dans un schéma de paiement | `schemas/payment.ts` |
| Le front réagit sur `code`, jamais sur `message` | `errors/error-codes.ts` |

## Utilisation

```ts
import { createAppointmentRequestSchema, ERROR_CODES, errorCodeOf } from '@spa/shared';

const body = createAppointmentRequestSchema.parse(input);

if (errorCodeOf(await response.json()) === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE) {
  // réafficher les créneaux
}
```

Le paquet est lié par les workspaces npm : rien à installer dans `apps/api` ni
dans `apps/web`. Le chemin `@spa/shared` est déjà déclaré dans les `paths` de
`tsconfig.base.json`, et `src/__tests__/contract-surface.spec.ts` vérifie que la
résolution fonctionne depuis les deux applications.

Consommer le paquet depuis un `tsconfig` qui compile avec `rootDir: src` demande
une référence de projet :

```jsonc
{ "references": [{ "path": "../../packages/shared/tsconfig.build.json" }] }
```

sans quoi `tsc` tente d'absorber les sources du contrat dans son propre programme
et échoue en TS6059.

## Faire évoluer le contrat

1. Modifier ou ajouter le schéma dans `src/`.
2. L'exporter depuis le baril de sa famille (`common/`, `constants/`, `errors/`,
   `schemas/`) — les réexports y sont nommés un par un, délibérément.
3. Ajouter le test qui garde l'invariant, dans `src/__tests__/`.
4. `npm run verify` à la racine : les erreurs de compilation dans `apps/*` sont
   la liste de travail.

**Retirer ou renommer un code d'erreur, un statut ou un rôle casse un front
déployé.** Ces énumérations sont des contrats, pas des détails d'implémentation :
elles s'étendent, elles ne se réécrivent pas.
