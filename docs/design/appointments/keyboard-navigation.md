# Navigation clavier — sélecteur de créneau

Le sélecteur de créneau est « le point le plus souvent raté : il doit être
utilisable sans souris » (`web-frontend` §7). Ce document fixe son comportement
clavier et ses attributs d'accessibilité, ainsi que celui de la barre de dates
qui l'accompagne. Cible : conformité **WCAG 2.1 AA**, opérable entièrement au
clavier, annoncé correctement par les lecteurs d'écran.

## Structure sémantique

La grille de créneaux est un **`grid` composite** avec gestion du focus par
`roving tabindex` : un seul élément est dans l'ordre de tabulation à la fois, les
flèches déplacent le focus à l'intérieur.

```
role="grid"           conteneur du sélecteur, aria-label="Créneaux disponibles
                      le mercredi 27 août"
 └ role="row"         une ligne = un regroupement (Matin / Après-midi / Soir)
    └ role="gridcell" une cellule
       └ button       le créneau lui-même : <button> natif, pas un <div>
```

- Chaque créneau est un **`<button>` natif** (pas un `<div role="button">`) :
  activation clavier, sémantique et gestion du `disabled` gratuites.
- Un seul créneau porte `tabindex="0"` (le créneau sélectionné, ou à défaut le
  premier disponible) ; tous les autres portent `tabindex="-1"`. C'est le
  **roving tabindex**.
- Les créneaux indisponibles portent `aria-disabled="true"` et sont **retirés du
  parcours des flèches** (on saute par-dessus), afin que le clavier ne se pose
  jamais sur un élément inactif.

## Ordre de tabulation général de l'étape

`Tab` traverse les grands blocs ; les **flèches** naviguent *dans* la grille.

```
Tab →  [ Fuseau/aide ]
Tab →  [ ‹ Mois précédent ]
Tab →  [ Barre de dates ]     ← flèches ←/→ pour changer de jour
Tab →  [ Mois suivant › ]
Tab →  [ Grille de créneaux ] ← flèches pour naviguer les créneaux
Tab →  [ Voir plus de jours ]
Tab →  [ Continuer ]          ← barre collante
```

Entrer dans la grille en `Tab` pose le focus sur le créneau actif (roving). En
ressortir avec `Tab` va au bloc suivant, **sans** parcourir chaque créneau —
c'est tout l'intérêt du `grid` par rapport à une longue liste de boutons.

## Touches dans la grille de créneaux

| Touche | Action |
|---|---|
| `→` | Créneau disponible suivant (saute les indisponibles) |
| `←` | Créneau disponible précédent |
| `↓` | Créneau de la ligne suivante (Matin → Après-midi → Soir), même colonne si possible |
| `↑` | Créneau de la ligne précédente |
| `Début` (Home) | Premier créneau disponible de la ligne |
| `Fin` (End) | Dernier créneau disponible de la ligne |
| `Ctrl+Début` | Tout premier créneau disponible de la grille |
| `Ctrl+Fin` | Tout dernier créneau disponible de la grille |
| `Entrée` / `Espace` | Sélectionne le créneau focalisé |
| `Tab` | Sort de la grille vers le bloc suivant |

- Le déplacement **ne boucle pas** en bord de grille (pas de retour du dernier au
  premier) : le comportement reste prévisible.
- Les créneaux indisponibles sont **traversés silencieusement** — jamais focus,
  jamais sélectionnables.

## Barre de dates

Même logique de roving tabindex, sur une seule ligne :

| Touche | Action |
|---|---|
| `←` / `→` | Jour précédent / suivant |
| `Entrée` / `Espace` | Sélectionne le jour → recharge la grille de créneaux |
| `PageSuiv` / `PagePréc` | Semaine suivante / précédente |

Changer de jour **recharge la grille** ; le focus part alors sur le premier
créneau disponible du nouveau jour, et un message `aria-live` annonce le nombre
de créneaux (« 6 créneaux disponibles le jeudi 28 août »).

## Focus visible

- Anneau de focus **toujours visible** au clavier (`:focus-visible`), contraste
  AA contre le fond, non supprimé par un `outline: none` non compensé.
- Le focus n'est jamais masqué par la barre de résumé collante : la grille
  défile pour garder le créneau focalisé dans le viewport (`scroll-margin` sous
  l'en-tête et au-dessus de la barre collante).

## États et attributs par créneau

| État | Rendu visuel | Attributs |
|---|---|---|
| Disponible | Bordure neutre, texte lisible | `<button>`, `tabindex=-1` (ou `0` si actif) |
| Focalisé | Anneau de focus AA | `:focus-visible` |
| Sélectionné | Surbrillance + coche | `aria-pressed="true"` (ou `aria-selected` dans le grid) |
| Indisponible | Barré/atténué, curseur interdit | `aria-disabled="true"`, hors roving |
| Retenu pour un autre | Identique à indisponible | idem, avec libellé « déjà réservé » via `aria-label` |

- L'information « indisponible » **ne repose pas sur la seule couleur** : motif
  barré + libellé `aria` (« 14:30, indisponible »).
- Le libellé accessible de chaque créneau porte l'heure complète et le fuseau
  implicite du jour affiché (« 14 h 00 »), pas seulement « 14:00 » hors contexte.

## Annonces dynamiques (`aria-live`)

Une région `aria-live="polite"` (et `assertive` pour les collisions) annonce les
changements que le client ne voit pas forcément :

- Chargement terminé : « 6 créneaux disponibles le mercredi 27 août ».
- Jour sans créneau : « Aucun créneau ce jour, prochaine disponibilité jeudi 28 à
  9 h 00 ».
- **Créneau devenu indisponible** (cf. [slot-unavailable.md](slot-unavailable.md))
  : « Ce créneau vient d'être réservé, liste mise à jour » — annonce `assertive`,
  et le focus est déplacé vers le créneau disponible le plus proche pour ne pas
  laisser le clavier sur un bouton disparu.

## Cohérence avec les autres étapes

Le principe s'étend à tout le tunnel (`web-frontend` §7) :

- Étapes Service et Praticien : les listes de choix sont des `radiogroup`,
  navigables aux flèches, `Espace`/`Entrée` pour choisir.
- Formulaire Coordonnées : ordre de tabulation = ordre visuel ; à la soumission,
  le focus va au **premier champ en erreur**.
- Paiement : le Payment Element Stripe gère son propre focus interne ; on
  s'assure que `Tab` y entre et en ressort proprement vers le bouton « Payer ».
- Le bouton primaire de chaque étape est atteignable au clavier sans traverser
  toute la page (il suit immédiatement le contenu de l'étape dans l'ordre DOM).

## Liste de vérification (pour l'implémentation `apps/web`)

- [ ] Grille de créneaux en `role="grid"` avec roving tabindex.
- [ ] Flèches, Home/End, Ctrl+Home/End opérationnelles ; indisponibles sautés.
- [ ] `<button>` natifs, jamais de `<div>` cliquable.
- [ ] Focus visible AA, non masqué par la barre collante.
- [ ] Indisponibilité portée par motif + `aria`, pas seulement la couleur.
- [ ] Région `aria-live` pour chargement, jour vide et collision.
- [ ] Focus déplacé intelligemment quand un créneau disparaît.
- [ ] Barre de dates navigable aux flèches, recharge + annonce au changement.
- [ ] Parcours complet réalisable sans souris, de l'étape 1 à la confirmation.
