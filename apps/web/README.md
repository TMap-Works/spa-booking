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
```

Server Components par défaut. `"use client"` est une décision, ajoutée aussi bas
que possible dans l'arbre.

## Design system

Jetons de couleur, typographie, espacement et rayons, et six composants de base
(bouton, champ, sélecteur, carte, modale, notification) avec état de chargement
et état vide : [styles/README.md](styles/README.md).

Aucune page n'écrit une couleur littérale — tout passe par la couche sémantique
`--spa-color-*`, ce qui permettra à un salon de substituer sa rampe de marque
sans réécriture. Vérifié par `node --test apps/web/tests/`.
