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
```

Server Components par défaut. `"use client"` est une décision, ajoutée aussi bas
que possible dans l'arbre.
