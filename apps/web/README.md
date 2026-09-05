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
  admin/         période et grille du planning — fonctions pures, sans React
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

### Le planning — `/{slug}/admin/calendrier` (#49)

L'écran le plus regardé du back-office, et le seul dont la logique vit **hors des
composants** : `lib/admin/calendar-range.ts` calcule la période, et
`lib/admin/calendar-grid.ts` la transforme en colonnes de cellules. Aucun des
deux n'importe React, ce qui rend testable sans navigateur ce qui casserait le
plus cher — un rendez-vous placé une demi-heure trop bas, ou un bloc qui en
recouvre un autre.

| Trait | Où il se tient |
|---|---|
| Vue jour, une colonne par praticien ; vue semaine, une par journée | `buildCalendarBoard` |
| Plage visible seule, périodes voisines préchargées | `calendrier/page.tsx` amorce, `CalendarBoard` poursuit |
| Rendu virtualisé sur l'axe des heures | `computeSlotWindow` et `cellsInWindow` |
| Codes couleur par statut, doublés d'un texte (WCAG 1.4.1) | `statusModifier` et `STATUS_LABELS` |
| Période précédente / suivante / aujourd'hui, dans l'URL | `shiftAnchor`, `adminCalendarPath` |

La vue et la date sont des paramètres d'URL (`?vue=semaine&date=2026-08-26`) : un
planning se partage et survit à un rafraîchissement. Le composant les y réécrit
avec `history.replaceState`, sans repasser par le serveur — seul le contenu des
colonnes change d'une période à l'autre.

**Ce que cet écran attend encore de l'API.** `packages/shared` publie
`appointmentListQuerySchema` et `appointmentSchema`, mais `apps/api` n'expose que
`GET /appointments/mine` : la route d'agenda du comptoir — `GET /appointments`,
bornée par dates civiles — reste à livrer. La grille, la navigation et la
virtualisation sont complètes ; le chargement des rendez-vous dégrade en un
bandeau qui nomme le manque. Faute de `GET /staff` (#421), les colonnes de la vue
jour sont **déduites des rendez-vous** : un praticien sans rendez-vous ce jour-là
n'a pas de colonne.

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
