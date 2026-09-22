# Design system — jetons et composants de base

Socle visuel partagé par les deux produits de `apps/web` : le parcours client
public (`app/(booking)/`) et le tableau de bord admin (`app/(admin)/`). Les deux
consomment les mêmes jetons et les mêmes composants ; ce sont leurs mises en page
et leurs densités qui diffèrent, pas leur vocabulaire visuel.

Conventions du front : [.claude/skills/web-frontend/SKILL.md](../../../.claude/skills/web-frontend/SKILL.md).

```
styles/
  index.css            point d'entrée partagé — importe tout ce qui suit, dans l'ordre
  tokens.css           jetons : primitives + rôles sémantiques
  base.css             défauts d'éléments, focus, squelettes, état vide partagé
  components/
    button.css         bouton
    field.css          champ de saisie
    select.css         sélecteur
    card.css           carte
    modal.css          modale
    notification.css   notification
    icon.css           pictogramme au trait (`components/ui/icon.tsx`, #927)
    auth.css           cadre des écrans de connexion et d'inscription (#927)
    home.css           page d'accueil de la plateforme (#927)
  admin/               chrome du tableau de bord — voir admin/README.md (#30)
    index.css          second point d'entrée, chargé par le seul layout admin
```

## Mise en service

```tsx
// app/layout.tsx — les deux produits
import '../styles/index.css';

// app/(admin)/layout.tsx — le back-office seul
import '../../styles/admin/index.css';
```

Deux points d'entrée, parce qu'il y a deux produits. L'entrée partagée porte les
jetons, le socle et les six composants ci-dessous : les deux en ont besoin.
L'entrée admin porte le calendrier de planning, la grille d'horaires et l'écran
d'encaissement, que le parcours client public n'affiche jamais et qui n'ont donc
pas à peser sur son LCP. L'ordre est contraint : les jetons d'abord.

Chaque entrée liste ses imports à la main plutôt que par un glob : l'ordre de
cascade reste lisible, et un fichier oublié se voit. `tokens.test.mjs` vérifie
que toute feuille de `styles/` est atteignable depuis **exactement une** des
deux, pour que ce choix ne coûte pas un oubli silencieux.

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

### Thème clair / sombre

Le jeu sombre est défini une fois, dans `tokens.css`, pour tout le produit. Sans
choix, il suit `prefers-color-scheme` ; le sélecteur `components/ui/theme-toggle.tsx`
(Système / Clair / Sombre) pose `data-theme` sur `<html>` et mémorise le choix dans
le cookie `spa-theme`, que le script d'amorçage du layout racine relit avant le
premier rendu (`lib/theme.ts`). Un seul cookie : le choix fait sur la vitrine vaut
au back-office, et inversement.

| Surface | Où vit le sélecteur |
|---|---|
| Back-office, console plateforme | la barre du haut (#1058, #1065) |
| Gabarit public du salon — vitrine, politique de données, espace client, connexion | l'en-tête au-delà de 48 rem, le pied de page en dessous (#1114) |
| Accueil `/` | le pied de page : la barre n'a pas la place de ses trois pastilles (#1114) |
| Tunnel de réservation | aucun — son en-tête se borne à revenir et quitter (BM-TUNNEL-10) ; il applique le choix fait ailleurs |

Deux exemplaires sur une même page restent d'accord : chacun suit `data-theme`
sur `<html>`, pas son propre état.

### Familles disponibles

| Famille | Préfixe | Échelle |
|---|---|---|
| Couleur | `--spa-color-*` | surfaces, texte, bordures, accent, aplat de marque et ses rôles « sur marque », états, statuts de rendez-vous, focus |
| Typographie | `--spa-font-*`, `--spa-line-height-*`, `--spa-letter-spacing-*` | `xs` → `3xl` |
| Espacement | `--spa-space-*` | base 4 px, `0` → `16` |
| Rayons | `--spa-radius-*` | `none` → `full` |
| Support | `--spa-shadow-*`, `--spa-z-*`, `--spa-duration-*`, `--spa-target-min-size` | — |
| Densité admin | `--spa-admin-*` | largeurs de coquille, hauteurs de ligne et de créneau (#30) |

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

#### Quel bouton porte `--block`, et lequel ne le porte pas (#674)

`--block` ne dit pas « ce bouton est important », il dit **« ce bouton mesure la
boîte qui le contient »**. La question n'est donc jamais quel rôle joue le
bouton, mais **ce qu'il y a autour de lui** — et le produit n'a que deux
réponses :

| Ce que le bouton conclut | Largeur | Pourquoi |
|---|---|---|
| une **colonne de saisie bornée** — un `<form>` sous `.spa-admin-form` (44 rem), la carte d'un tiroir, la colonne d'un ticket | `--block` | la borne est ce qui donne au bouton une mesure à prendre. Il finit la colonne qu'il vient de remplir, et un bouton court sous une pile de champs pleine largeur se lit comme un oubli |
| une **barre d'outils** — `.spa-admin-toolbar` | largeur automatique | une barre n'a pas de colonne : elle traverse toute la zone de contenu. Un bouton qui la prendrait mesurerait **940 px** d'un bord à l'autre — mesure au navigateur, 1280 px de fenêtre — et l'entretoise `__spacer` qui cale la rangée à droite n'aurait plus rien à pousser |

Les deux familles sont disjointes, et elles le restent par exécution :
`admin-toolbar-buttons.test.mjs` refuse la pleine largeur sous une barre
d'outils, `admin-form-width.test.mjs` tient la borne des colonnes de saisie.

Le piège est qu'une largeur automatique **ressemble** à un oubli : la campagne
de QA `20260911-1` a relevé trois largeurs pour ce qu'elle lisait comme un même
rôle — 966, 164 et 202 px. Deux l'étaient bien, et #634 les a ramenées à leur
carte. La troisième, « Enregistrer la semaine » à 202 px, ne l'est pas : la
grille des horaires occupe toute la largeur **exprès** — sept jours à deux
champs horaires ne tiennent pas en 44 rem — si bien que `--block` y poserait un
bouton de bout en bout de l'écran. La contre-épreuve a été faite au navigateur :
la classe ajoutée à la volée fait passer le bouton de **202 px à 940 px**, à un
cheveu des 966 px que la campagne reprochait justement au premier des trois. Le
défaut que #634 venait de corriger sur `/catalogue/rubriques` (926 px), pris
dans l'autre sens.

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

- **Contraste AA vérifié par exécution**, pas à l'œil : 60 paires de jetons —
  44 au seuil 4.5:1 du texte (WCAG 1.4.3), 16 au seuil 3:1 des éléments non
  textuels, bordures de contrôle et anneau de focus (WCAG 1.4.11). Les 21 paires
  ajoutées par #30 couvrent les cinq statuts de rendez-vous et la barre latérale
  sombre du tableau de bord.
- **Focus** — `:focus-visible` et non `:focus` : un clic souris ne laisse pas
  d'anneau, une tabulation le laisse toujours. L'anneau est décalé
  (`outline-offset`) pour se dessiner sur la surface de la page, ce qui lui
  garantit son rapport même par-dessus un bouton d'accent.
- **`prefers-reduced-motion`** neutralise squelettes et spinner. Ce n'est pas un
  confort : un mouvement continu peut déclencher un trouble vestibulaire.
- **`.spa-visually-hidden`** porte les annonces de chargement et de vide pour les
  lecteurs d'écran.
- **Listes** — `base.css` retire marqueur et retrait de tout `<ul>`/`<ol>` : dans
  ce produit une liste est presque toujours structurelle (#625). Deux
  conséquences. Une énumération de prose, qui veut vraiment sa puce, se déclare
  en `.spa-list`. Et une liste dont la séquence ou le décompte porte du sens doit
  écrire `role="list"` : sans marqueur, Safari lui retire sa sémantique de liste
  et VoiceOver n'annonce plus « liste de N éléments ».
- Trois exemptions assumées, chacune fondée sur la norme : les contrôles
  désactivés (1.4.3 les exempte), les squelettes (décoratifs, l'annonce passe par
  `aria-busy`), et `--spa-color-scrim` (translucide, sans rapport défini hors
  composition).

## 4. Vérifications

```bash
npm run test:unit --workspace @spa/web   # ou : node --test apps/web/tests/
```

| Suite | Ce qu'elle empêche |
|---|---|
| `contrast.test.mjs` | qu'une teinte passe sous le seuil AA — y compris après substitution de rampe par un tenant |
| `tokens.test.mjs` | qu'une couleur littérale ou une primitive entre dans un composant, qu'une feuille échappe aux points d'entrée, et que le chrome admin fuie vers le parcours client public |
| `admin-mockups.test.mjs` | que les maquettes du tableau de bord et leurs feuilles dérivent l'une de l'autre (#30) |

Les paires de contraste sont énoncées en **noms sémantiques** et résolues
jusqu'aux primitives : changer un `--spa-palette-*` sous un rôle fait donc
échouer la suite. C'est ce qui donne sa valeur au contrat de personnalisation.
`contrast.test.mjs` refuse en outre qu'un rôle de texte soit ajouté à
`tokens.css` sans paire correspondante — sans ce garde-fou, « contraste AA
vérifié » deviendrait faux sans que rien ne rougisse.

Aucune dépendance : `node:test` et `node:assert` sont fournis par la plateforme.

Ces suites sont rattachées à `npm run test:unit` (#244) : la CI les exécute, et
« contraste AA vérifié » n'est donc plus tenu par une exécution manuelle.

## 5. Portée actuelle et suite

Livré ici : **la couche CSS pilotée par jetons**, sans dépendance ajoutée.
`apps/web` ne porte toujours ni `react`, ni `next`, ni `next.config.*` — le seul
script de son `package.json` est `test:unit`.

Le tableau de bord admin (#30) reprend ce parti pris : cinq écrans en CSS et en
contrats de balisage, rendus en maquettes HTML statiques ouvrables dans un
navigateur — voir [admin/README.md](admin/README.md) et `mockups/admin/`.

Reste à faire, à l'amorçage npm du front :

1. installer `react` / `next` et poser `next.config.*` ;
2. envelopper ces six composants dans `components/ui/` (React), en Server
   Components par défaut, `"use client"` uniquement pour la modale et les
   contrôles qui portent un état ;
3. porter les cinq écrans admin en `app/(admin)/`.

Les classes ci-dessus sont la source de vérité visuelle : les composants React
les porteront sans redéfinir un seul style.
