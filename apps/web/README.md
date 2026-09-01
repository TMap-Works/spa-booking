# apps/web — Front Next.js

Deux produits dans une seule application. Conventions détaillées :
[.claude/skills/web-frontend/SKILL.md](../../.claude/skills/web-frontend/SKILL.md).

```
app/
  layout.tsx     layout racine — importe le point d'entrée du design system
  (booking)/     parcours client public — rendu serveur, indexable, mobile-first
    [tenantSlug]/reservation/   le tunnel : prestation → créneau → coordonnées
                               → récapitulatif → confirmation
  (admin)/       tableau de bord — authentifié, non indexable, dense
components/
  ui/            design system partagé
lib/
  api-client.ts  seul point d'accès à l'API, types importés de @spa/shared
  booking/       état du tunnel et dates civiles de l'établissement
  format.ts      heures dans le fuseau du salon, montants entiers
styles/          jetons et composants de base — voir styles/README.md
  admin/         chrome du tableau de bord — voir styles/admin/README.md
mockups/admin/   maquettes HTML statiques des cinq écrans du back-office
tests/           suites node:test du design system et des maquettes
  unit/          suites Vitest — logique de présentation et composants
```

Server Components par défaut. `"use client"` est une décision, ajoutée aussi bas
que possible dans l'arbre.

## Lancer le front

```bash
npm run dev --workspace @spa/web     # http://localhost:3000
```

Une seule variable d'environnement, `API_URL` (défaut `http://localhost:3001`) —
l'hôte de l'API, sans son préfixe `/api/v1`, que le client ajoute lui-même.

Elle n'est **pas** préfixée `NEXT_PUBLIC_`, et c'est un choix : aucun composant
client n'appelle l'API. Le navigateur passe par les *server actions* du tunnel,
qui appellent `lib/api-client.ts` côté serveur. L'adresse de l'API n'est donc pas
figée dans le bundle au moment du build — une même image se déploie en dev, en
recette et en production — et il n'y a pas de CORS à ouvrir sur le chemin
critique de la réservation.

## Le contrat d'API vient de `@spa/shared`

Aucun type d'API n'est redéclaré ici. `next.config.mjs` et `tsconfig.json`
pointent tous deux `@spa/shared` vers les **sources** du paquet plutôt que vers
son `dist` : `npm run verify` exécute `typecheck` avant `build`, et
`npm run build --workspaces` traite `apps/*` avant `packages/*` — dans les deux
cas, `packages/shared/dist` n'existerait pas encore.

## Design system

Jetons de couleur, typographie, espacement et rayons, et six composants de base
(bouton, champ, sélecteur, carte, modale, notification) avec état de chargement
et état vide : [styles/README.md](styles/README.md).

Aucune page n'écrit une couleur littérale — tout passe par la couche sémantique
`--spa-color-*`, ce qui permettra à un salon de substituer sa rampe de marque
sans réécriture.

## Tableau de bord admin

Les cinq écrans du back-office — planning jour et semaine, création et édition
d'un rendez-vous, fiche client, personnel et horaires, encaissement — sont
livrés en CSS piloté par jetons et en contrats de balisage documentés :
[styles/admin/README.md](styles/admin/README.md).

Les maquettes s'ouvrent telles quelles dans un navigateur, sans serveur et sans
build : `mockups/admin/index.html`.

## Vérifications

```bash
npm run lint --workspace @spa/web
npm run typecheck --workspace @spa/web
npm run test:unit --workspace @spa/web   # node --test tests/  puis  vitest run
```

Deux lanceurs, parce qu'il y a deux natures de suites :

- **`node:test`**, sur `tests/*.test.mjs` — contraste AA, intégrité des jetons,
  et cohérence entre les maquettes et leurs feuilles de style, y compris la
  garantie que l'écran d'encaissement n'offre nulle part où saisir un numéro de
  carte. Ces suites lisent des fichiers CSS et HTML : elles n'ont besoin ni de
  bundler ni de DOM, et n'en réclament pas ;
- **Vitest**, sur `tests/unit/**` — logique de présentation (fuseau du salon,
  montants) et composants sous jsdom, dont les deux comportements que le tunnel
  ne peut pas se permettre de perdre : le message d'erreur rendu *sur le champ*,
  et le bouton de réservation désarmé dès le premier clic.

Le motif d'inclusion de Vitest est restreint à `tests/unit/` pour cette raison :
sans lui, il ramasserait les suites `node:test`, dont les `describe` viennent de
`node:test` et ne s'y exécuteraient pas.
