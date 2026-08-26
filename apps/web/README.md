# apps/web — Front Next.js

Deux produits dans une seule application. Conventions détaillées :
[.claude/skills/web-frontend/SKILL.md](../../.claude/skills/web-frontend/SKILL.md).

```
app/
  (booking)/     parcours client public — rendu serveur, indexable, mobile-first
  (admin)/       tableau de bord — authentifié, non indexable, dense
components/
  ui/            design system partagé
lib/
  api-client.ts  seul point d'accès à l'API, types importés de @spa/shared
styles/          jetons et composants de base — voir styles/README.md
  admin/         chrome du tableau de bord — voir styles/admin/README.md
mockups/admin/   maquettes HTML statiques des cinq écrans du back-office
tests/           suites node:test du design system et des maquettes
```

Server Components par défaut. `"use client"` est une décision, ajoutée aussi bas
que possible dans l'arbre.

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
npm run test:unit --workspace @spa/web   # ou : node --test apps/web/tests/
```

Contraste AA, intégrité des jetons, et cohérence entre les maquettes et leurs
feuilles de style — y compris la garantie que l'écran d'encaissement n'offre
nulle part où saisir un numéro de carte.
