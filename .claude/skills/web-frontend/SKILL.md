---
name: web-frontend
description: Conventions du front Next.js — séparation parcours client public / tableau de bord admin, Server vs Client Components, accès à l'API et types partagés, gestion des états de réservation, formulaires, accessibilité et design system. À charger avant de créer ou modifier quoi que ce soit dans apps/web.
---

# Front Next.js

`apps/web` sert **deux produits distincts** dans une seule application :

- Le **parcours client public** (`app/(booking)/`) — rendu serveur, indexable, doit
  charger vite sur mobile en réseau dégradé. C'est la surface qui génère le revenu.
- Le **tableau de bord admin** (`app/(admin)/`) — derrière authentification, non
  indexable, densité d'information élevée, confort desktop.

Ne pas mélanger leurs composants ni leurs conventions. Ce qui est partagé vit
dans `components/ui/` (design system) ou `lib/`.

## 1. Server Components par défaut

`"use client"` est une décision, pas un réflexe. On l'ajoute uniquement pour :
état local, effets, écouteurs d'événements, ou une API navigateur.

- Le catalogue de services, la fiche salon, les pages SEO : **Server Components**.
- Le sélecteur de créneau, le formulaire de réservation, le calendrier admin :
  Client Components, mais aussi bas que possible dans l'arbre. Un `"use client"`
  en haut d'une page fait basculer toute la page côté client et coûte le SEO.
- Les appels API en Server Component se font directement côté serveur, sans
  passer par une route interne — un aller-retour réseau en moins.

## 2. Accès à l'API

- **Un seul client HTTP**, dans `lib/api-client.ts`. Aucun `fetch` direct vers
  l'API dispersé dans les composants.
- Il importe ses types depuis `@spa/shared`. **Le front ne redéclare jamais un
  type que l'API expose.** Si un type manque, l'ajouter dans `packages/shared`,
  pas en local.
- Le client traduit le corps d'erreur standard (`{ code, message, details }`) en
  erreur typée. Les composants réagissent sur `code`, jamais sur `message`.
- Le jeton d'authentification est dans un **cookie httpOnly**, jamais dans
  `localStorage` — un XSS ne doit pas pouvoir exfiltrer la session.

## 3. Le parcours de réservation

C'est le chemin critique du produit. Étapes : service → praticien → créneau →
coordonnées → paiement → confirmation.

Points à ne pas rater :

- **Le créneau affiché peut avoir été pris.** Une réponse 409
  `SLOT_NO_LONGER_AVAILABLE` n'est pas une erreur exceptionnelle, c'est un cas
  normal sous concurrence. L'UI recharge les créneaux, signale clairement ce qui
  s'est passé et conserve toutes les autres saisies du client.
- **Les créneaux se rafraîchissent** pendant que le client hésite : revalidation
  à intervalle court ou au retour de focus sur l'onglet.
- **L'état de l'étape en cours survit à un rafraîchissement** de page (URL ou
  stockage de session). Un client qui recharge et perd sa progression abandonne.
- **Le bouton de soumission se désactive dès le premier clic.** Un double clic ne
  doit jamais produire deux tentatives de réservation.
- Les heures sont affichées dans le **fuseau du salon**, avec la mention explicite
  du fuseau si le visiteur est ailleurs.

## 4. Formulaires et validation

- `react-hook-form` + le schéma Zod importé de `@spa/shared` : **la même règle de
  validation des deux côtés**, écrite une fois. Le front valide pour le confort,
  le back valide pour la sécurité — jamais l'un sans l'autre.
- Les erreurs de champ retournées par l'API sont réinjectées sur les champs
  correspondants, pas affichées en bloc en haut de page.
- Téléphone en E.164 (`+261...`), normalisé à la saisie.

## 5. Le calendrier admin

- Vues jour et semaine (CDC §1.4). La vue semaine peut afficher plusieurs
  centaines de rendez-vous : virtualiser, ne pas monter tous les nœuds.
- Ne charger que la plage visible, avec un préchargement de la période adjacente.
- Le glisser-déposer d'un rendez-vous déclenche un **report** (voir la skill
  `booking-engine` : ce n'est pas un simple `UPDATE`). Appliquer un état optimiste
  puis **revenir en arrière visiblement** si l'API renvoie 409.
- Les actions destructives (annulation) demandent confirmation et sont réversibles
  tant que possible.

## 6. Design system

- Tailwind + composants dans `components/ui/`. Aucun style inline ad hoc, aucune
  valeur de couleur en dur dans une page.
- Les couleurs, espacements et rayons passent par des **tokens** — un salon
  personnalisera ses couleurs plus tard, et cela ne doit pas exiger de réécrire
  les pages.
- Chaque composant partagé a un état de chargement et un état vide définis. Un
  écran vide sans explication est un bug d'UX.

## 7. Accessibilité et performance

- Navigation complète au clavier sur le parcours de réservation, focus visible,
  ordre de tabulation cohérent. Le sélecteur de créneau est le point le plus
  souvent raté : il doit être utilisable sans souris.
- Contraste AA minimum, libellés `aria` sur les contrôles non textuels.
- Images via `next/image`, jamais de `<img>` brut pour les médias de services.
- Budget : le parcours de réservation vise un LCP < 2,5 s en 4G. Vérifier avant
  le go-live, pas après.

## 8. Tests

- Unitaires (Vitest) : logique de présentation, formatage des dates et montants.
- Composants (Testing Library) : le sélecteur de créneau, y compris le cas 409.
- E2E (Playwright) : le parcours complet « réserver → confirmer → encaisser » ne
  doit jamais casser. C'est le test qui bloque une mise en production.
