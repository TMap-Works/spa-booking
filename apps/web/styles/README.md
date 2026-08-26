# Design system — jetons et composants de base

Socle visuel partagé par les deux produits de `apps/web` : le parcours client
public (`app/(booking)/`) et le tableau de bord admin (`app/(admin)/`). Les deux
consomment les mêmes jetons et les mêmes composants ; ce sont leurs mises en page
et leurs densités qui diffèrent, pas leur vocabulaire visuel.

Conventions du front : [.claude/skills/web-frontend/SKILL.md](../../../.claude/skills/web-frontend/SKILL.md).

```
styles/
  index.css            point d'entrée unique — importe tout, dans l'ordre
  tokens.css           jetons : primitives + rôles sémantiques
  base.css             défauts d'éléments, focus, squelettes, état vide partagé
  components/
    button.css         bouton
    field.css          champ de saisie
    select.css         sélecteur
    card.css           carte
    modal.css          modale
    notification.css   notification
```

## Mise en service

Un seul import, dans le layout racine :

```tsx
import '../styles/index.css';
```

`index.css` liste ses imports à la main plutôt que par un glob : l'ordre de
cascade reste lisible, et un fichier oublié se voit. Un test le vérifie, pour que
ce choix ne coûte pas un oubli silencieux.

## 1. Les deux couches de jetons

C'est la raison d'être du système, et la promesse de l'issue #29 : *« un salon
personnalisera ses couleurs plus tard sans réécriture des pages »*.

| Couche | Préfixe | Contenu | Qui la lit |
|---|---|---|---|
| Primitives | `--spa-palette-*` | valeurs littérales (`#2a7268`) | `tokens.css` seul |
| Sémantique | `--spa-color-*` | un rôle d'interface, valant toujours un `var(--spa-palette-*)` | composants et pages |

**Une page ou un composant n'emploie jamais une primitive, et jamais une couleur
littérale.** Les deux règles sont vérifiées par `tokens.test.mjs` : ce ne sont pas
des recommandations, elles font rougir la suite.

### Personnaliser les couleurs d'un salon

Redéfinir la rampe de marque suffit — les rôles sémantiques suivent par cascade,
et aucune page ne change :

```css
:root[data-spa-theme='maison-lotus'] {
  --spa-palette-brand-500: #7a4b8f;
  --spa-palette-brand-600: #633b74;
  --spa-palette-brand-700: #4c2d59;
}
```

Toute rampe substituée doit conserver les rapports de contraste vérifiés par
`contrast.test.mjs` — c'est le contrat, pas une suggestion. Les trois nuances
ci-dessus sont celles que les composants peignent sous du texte blanc ; les
vérifier avant de livrer un thème évite un bouton « Réserver » illisible.

### Familles disponibles

| Famille | Préfixe | Échelle |
|---|---|---|
| Couleur | `--spa-color-*` | surfaces, texte, bordures, accent, états, focus |
| Typographie | `--spa-font-*`, `--spa-line-height-*`, `--spa-letter-spacing-*` | `xs` → `3xl` |
| Espacement | `--spa-space-*` | base 4 px, `0` → `16` |
| Rayons | `--spa-radius-*` | `none` → `full` |
| Support | `--spa-shadow-*`, `--spa-z-*`, `--spa-duration-*`, `--spa-target-min-size` | — |

Deux valeurs ne se négocient pas :

- `--spa-font-size-md` vaut 16 px et **aucun contrôle de saisie ne descend en
  dessous** : sous ce seuil, iOS zoome à la mise au point et casse le parcours
  mobile.
- `--spa-target-min-size` vaut 2.75 rem — la cible tactile minimale (WCAG 2.5.8).
  Tout contrôle interactif s'y conforme, y compris une croix de fermeture.

## 2. Les six composants

Chacun a **un état de chargement et un état vide** — c'est un critère
d'acceptation de l'issue, et la règle §6 de la skill `web-frontend` : *un écran
vide sans explication est un bug d'UX*.

La distinction qui compte : **« ça charge » et « il n'y a rien » ne sont pas le
même écran.** Un sélecteur vide parce que la requête est en vol et un sélecteur
vide parce qu'aucun praticien ne propose ce service demandent deux réponses
différentes de l'utilisateur.

| Composant | Classe racine | État de chargement | État vide |
|---|---|---|---|
| Bouton | `.spa-button` | `--loading` : spinner centré, libellé masqué **à largeur conservée** | `--empty` : l'action n'a rien sur quoi s'exercer |
| Champ | `.spa-field` | `__skeleton` à la boîte exacte du contrôle | `--empty` : rien à saisir, et le message dit pourquoi |
| Sélecteur | `.spa-select` | `__skeleton`, chevron retiré | `--empty` : liste chargée, zéro option |
| Carte | `.spa-card` | `--loading` : silhouette titre + lignes + pied | `--empty` : bordure en tirets + `.spa-empty-state` |
| Modale | `.spa-modal` | `__body--loading` : titre affiché, corps en squelette, actions inertes | `__body--empty` : contenu disparu ou sans objet |
| Notification | `.spa-notification` | `--loading` (action en vol) · `--skeleton` (liste) | `.spa-notification-empty` |

### Bouton

```html
<button class="spa-button spa-button--accent" type="submit">
  <span class="spa-button__label">Réserver</span>
</button>

<button class="spa-button spa-button--accent spa-button--loading" type="submit" disabled>
  <span class="spa-button__label">Réserver</span>
  <span class="spa-spinner spa-button__spinner" aria-hidden="true"></span>
  <span class="spa-visually-hidden">Réservation en cours…</span>
</button>
```

Variantes : `--accent` (action principale), `--neutral`, `--quiet`, `--danger`
(destructif, toujours précédé d'une confirmation), `--block` (pleine largeur).

En chargement, le libellé reste dans le flux et devient seulement invisible : le
bouton garde sa largeur. Sans cela la mise en page saute au moment précis où le
client vient de cliquer. Le bouton se désactive dès le premier clic — un double
clic ne doit jamais produire deux réservations.

### Champ

```html
<div class="spa-field">
  <label class="spa-field__label" for="tel">
    Téléphone<span class="spa-field__required" aria-hidden="true">*</span>
  </label>
  <input id="tel" class="spa-field__control" type="tel"
         required aria-describedby="tel-hint">
  <p id="tel-hint" class="spa-field__hint">Format international, +261…</p>
</div>
```

En erreur : `aria-invalid="true"` sur le contrôle, message en
`.spa-field__error` avec `role="alert"`, référencé par `aria-describedby`. La
couleur ne porte jamais l'information seule — il y a toujours un texte.

### Sélecteur

Bâti sur un `<select>` natif, délibérément : la navigation clavier, la recherche
par frappe et le rendu tactile de la plateforme viennent gratuitement. Le
sélecteur est le contrôle le plus souvent raté en accessibilité.

```html
<div class="spa-select">
  <label class="spa-select__label" for="praticien">Praticien</label>
  <div class="spa-select__shell">
    <select id="praticien" class="spa-select__control">…</select>
    <span class="spa-select__chevron" aria-hidden="true"></span>
  </div>
</div>
```

### Carte

`.spa-card` pour la présentation, `.spa-card--selectable` pour un choix du
parcours. Une carte cliquable est un `<button>` ou un `<a>` — jamais une `<div>`
avec un gestionnaire de clic, qui sortirait de l'ordre de tabulation. L'état
sélectionné est exposé par `aria-pressed` ou `aria-checked`, et marqué par la
bordure **et** l'aplat : deux repères, pour ne pas faire porter l'information par
la seule couleur.

### Modale

Bâtie sur `<dialog>` ouvert par `showModal()`. Le natif fournit le piège de
focus, la fermeture par Échap, l'inertie du fond et le calque supérieur — quatre
comportements qu'une implémentation en `div` doit réécrire et rate presque
toujours. `aria-labelledby` pointe le titre, sans quoi la modale s'annonce sans
nom.

### Notification

```html
<div class="spa-notification spa-notification--warning" role="status">
  <span class="spa-notification__icon" aria-hidden="true">…</span>
  <div class="spa-notification__content">
    <p class="spa-notification__title">Ce créneau vient d'être réservé</p>
    <p>Les disponibilités ont été rechargées. Vos autres informations sont conservées.</p>
  </div>
</div>
```

Sémantique d'annonce — la partie invisible, et celle qui compte :

- variante `danger` → `role="alert"` (interrompt, annonce immédiatement) ;
- autres variantes → `role="status"` (annonce au prochain répit).

La région flottante `.spa-notification-region` porte `aria-live` et **existe dans
le DOM avant d'avoir un enfant** : une région insérée en même temps que son
message n'est pas annoncée. C'est pourquoi l'état vide vide son contenu sans
retirer la région.

Le 409 `SLOT_NO_LONGER_AVAILABLE` du parcours de réservation s'affiche ici, en
variante `warning` : sous concurrence, c'est un cas normal, pas une panne.

## 3. Accessibilité

- **Contraste AA vérifié par exécution**, pas à l'œil : 39 paires de jetons —
  29 au seuil 4.5:1 du texte (WCAG 1.4.3), 10 au seuil 3:1 des éléments non
  textuels, bordures de contrôle et anneau de focus (WCAG 1.4.11).
- **Focus** — `:focus-visible` et non `:focus` : un clic souris ne laisse pas
  d'anneau, une tabulation le laisse toujours. L'anneau est décalé
  (`outline-offset`) pour se dessiner sur la surface de la page, ce qui lui
  garantit son rapport même par-dessus un bouton d'accent.
- **`prefers-reduced-motion`** neutralise squelettes et spinner. Ce n'est pas un
  confort : un mouvement continu peut déclencher un trouble vestibulaire.
- **`.spa-visually-hidden`** porte les annonces de chargement et de vide pour les
  lecteurs d'écran.
- Trois exemptions assumées, chacune fondée sur la norme : les contrôles
  désactivés (1.4.3 les exempte), les squelettes (décoratifs, l'annonce passe par
  `aria-busy`), et `--spa-color-scrim` (translucide, sans rapport défini hors
  composition).

## 4. Vérifications

```bash
node --test apps/web/tests/
```

| Suite | Ce qu'elle empêche |
|---|---|
| `contrast.test.mjs` | qu'une teinte passe sous le seuil AA — y compris après substitution de rampe par un tenant |
| `tokens.test.mjs` | qu'une couleur littérale ou une primitive entre dans un composant, et qu'une feuille échappe à `index.css` |

Les paires de contraste sont énoncées en **noms sémantiques** et résolues
jusqu'aux primitives : changer un `--spa-palette-*` sous un rôle fait donc
échouer la suite. C'est ce qui donne sa valeur au contrat de personnalisation.
`contrast.test.mjs` refuse en outre qu'un rôle de texte soit ajouté à
`tokens.css` sans paire correspondante — sans ce garde-fou, « contraste AA
vérifié » deviendrait faux sans que rien ne rougisse.

Aucune dépendance : `node:test` et `node:assert` sont fournis par la plateforme.

> **Non rattachées à `npm run test:unit` à ce jour — donc non exécutées par la
> CI.** Le rattachement tient en une ligne (`"test:unit": "node --test tests/"`
> dans `apps/web/package.json`), mais ce fichier est hors de l'empreinte de
> l'issue #29, qui a été traitée en parallèle d'autres tickets écrivant ailleurs
> dans le dépôt. « Contraste AA vérifié » n'est donc, à cette étape, tenu que par
> une exécution manuelle. C'est le premier geste de l'amorçage npm du front.

## 5. Portée actuelle et suite

Livré ici : **la couche CSS pilotée par jetons**, sans dépendance ajoutée.
`apps/web` ne porte aujourd'hui ni `react`, ni `next`, ni `next.config.*` — son
`package.json` n'a aucun script, et la CI l'ignore de bout en bout.

Reste à faire, à l'amorçage npm du front :

1. rattacher les deux suites à `npm run test:unit` (voir l'encadré ci-dessus) ;
2. installer `react` / `next` et poser `next.config.*` ;
3. envelopper ces six composants dans `components/ui/` (React), en Server
   Components par défaut, `"use client"` uniquement pour la modale et les
   contrôles qui portent un état.

Les classes ci-dessus sont la source de vérité visuelle : les composants React
les porteront sans redéfinir un seul style.
