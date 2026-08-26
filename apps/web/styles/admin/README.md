# Tableau de bord admin — maquettes et contrats de balisage

Les cinq écrans du back-office (issue #30), bâtis sur les jetons et les six
composants de base du design system ([../README.md](../README.md), issue #29).
Rien n'est redéfini ici : ce sont les mêmes jetons, les mêmes boutons, les mêmes
champs. Ce qui change, c'est la mise en page et la densité.

Conventions du front : [.claude/skills/web-frontend/SKILL.md](../../../../.claude/skills/web-frontend/SKILL.md).

```
styles/admin/
  index.css        point d'entrée du back-office — importe les six feuilles ci-dessous
  shell.css        coquille, barre d'outils, sélecteur segmenté, badge, tableau, tiroir, métrique
  calendar.css     calendrier jour et semaine
  appointment.css  création et édition manuelle d'un rendez-vous
  client.css       fiche client, notes internes, historique
  staff.css        personnel, horaires hebdomadaires, exceptions
  checkout.css     encaissement et POS

mockups/admin/
  index.html       sommaire
  calendrier.html · rendez-vous.html · fiche-client.html · personnel.html · encaissement.html
```

## Les maquettes s'ouvrent

`apps/web/mockups/admin/index.html` se lit dans un navigateur, sans serveur et
sans build : ce sont des pages statiques, sans une ligne de JavaScript. Chaque
écran y montre son état nominal, **puis son état de chargement et son état vide**
— trois écrans distincts, pas trois nuances du même.

C'est le même parti pris que #29, et pour la même raison : `apps/web` ne porte à
ce jour ni `react`, ni `next`, ni `next.config.*`. Des `.tsx` y seraient du code
mort, non compilé et non linté. Les composants React porteront ces classes sans
redéfinir un seul style.

## 1. Deux points d'entrée

```tsx
// app/layout.tsx — les deux produits
import '../styles/index.css';

// app/(admin)/layout.tsx — le back-office seul
import '../../styles/admin/index.css';
```

L'ordre est contraint : l'entrée partagée déclare les jetons que le chrome admin
consomme.

Pourquoi ne pas tout mettre dans `styles/index.css` : le parcours client public
vise un LCP < 2,5 s en 4G, et il n'affiche jamais un calendrier de planning, une
grille d'horaires ni un écran d'encaissement. Lui faire porter ce chrome serait
un coût pur pour la surface qui génère le revenu. `tokens.test.mjs` vérifie qu'
aucune feuille `admin/` n'est atteignable depuis l'entrée partagée.

## 2. Jetons ajoutés

Tous déclarés dans [`../tokens.css`](../tokens.css) — il n'y a toujours qu'un
seul fichier de jetons.

| Famille | Jetons | Pourquoi |
|---|---|---|
| Statuts de rendez-vous | `--spa-color-status-{confirmed,pending,completed,cancelled,no-show}` et leur `-surface` | « annulé » n'est pas « erreur », « honoré » n'est pas « information » : les fondre dans les rôles d'état interdirait de repeindre l'agenda sans repeindre les messages d'erreur |
| Heure courante | `--spa-color-now` | « maintenant » n'est pas une erreur ; un salon doit pouvoir déplacer l'un sans l'autre |
| Fond sombre | `--spa-color-surface-inverse-raised`, `--spa-color-text-inverse-muted`, `--spa-color-accent-inverse` | la barre latérale est sombre ; sans ces rôles, son survol et ses libellés secondaires s'écriraient en littéraux |
| Densité | `--spa-admin-{rail-width,topbar-height,panel-width,row-height,slot-height,time-gutter}` | la densité du back-office, réunie en un endroit |

`--spa-color-accent` n'atteint que **3.09:1** sur la surface inversée : assez
pour un repère, trop juste pour porter un libellé et trop juste pour survivre à
une rampe substituée par un salon. D'où `--spa-color-accent-inverse`, à 7.24:1.

**La densité ne se gagne pas sur les cibles cliquables.** `--spa-admin-row-height`
et `--spa-admin-slot-height` valent `var(--spa-target-min-size)` : une ligne de
tableau ouvre une fiche, une maille de 30 min ouvre la création d'un rendez-vous,
et ni l'une ni l'autre ne descend sous la cible minimale. La densité vient des
gouttières, du chrome minimal et de corps de texte plus petits.

## 3. Les cinq écrans

Toutes les heures affichées sont dans **le fuseau du salon**, écrit en clair dans
le pied de la barre latérale et sous les champs d'horaire. Le stockage est en UTC.
Tous les montants viennent d'entiers en plus petite unité monétaire accompagnés
de leur code devise, formatés au dernier moment — le front ne fait jamais
l'arithmétique d'un total.

### 3.1 Calendrier — `calendar.css`

Une gouttière d'heures, puis N colonnes dont les rangées valent 30 minutes.
Vue jour : une colonne par praticien, c'est le cas par défaut et il ne porte
aucun modificateur. Vue semaine : `--week`, une colonne par jour.

```html
<ul class="spa-admin-calendar__column" aria-labelledby="col-hasina">
  <li class="spa-admin-calendar__cell spa-admin-calendar__cell--span-2">
    <button class="spa-admin-calendar__event spa-admin-calendar__event--confirmed" type="button">
      <span class="spa-admin-calendar__event-time">09:00 – 10:00</span>
      <span class="spa-admin-calendar__event-client">Rina Andriamana</span>
      <span class="spa-admin-calendar__event-service">Massage suédois · 60 min</span>
      <span class="spa-visually-hidden">Statut : confirmé. Ouvrir la fiche.</span>
    </button>
  </li>
  <li class="spa-admin-calendar__cell">
    <button class="spa-admin-calendar__slot" type="button">
      <span class="spa-visually-hidden">10 h 30, libre — créer un rendez-vous avec Hasina</span>
    </button>
  </li>
</ul>
```

Les cellules se suivent **dans l'ordre chronologique** et couvrent autant de
rangées que le rendez-vous dure (`--span-2` … `--span-8`). Rien n'est positionné
en absolu, donc rien ne se désaligne quand la police grossit. La colonne est une
liste nommée par son en-tête ; tout ce qui est cliquable est un `<button>`, si
bien que la tabulation parcourt la journée dans l'ordre des heures.

- **Créneau libre** — bouton sans libellé visible (la grille en serait illisible),
  avec un nom accessible complet en `.spa-visually-hidden`.
- **Statut** — liseré `--confirmed` / `--pending` / `--completed` / `--cancelled`
  / `--no-show`, **plus** le libellé dans le nom accessible et dans la légende.
  Jamais la couleur seule. Un rendez-vous annulé reste affiché, barré : il
  explique le trou dans le planning.
- **Temps indisponible** — `__blocked`, hachuré et non cliquable. Le proposer à
  la réservation serait un bug.
- **Heure courante** — `__slot--now`. La position fine vient d'une propriété
  `--now-offset` injectée par le composant ; elle est délibérément **hors du
  préfixe `--spa-`**, parce que c'est une donnée d'exécution et non un jeton.

Reste à la charge du composant React (skill web-frontend §5) : virtualiser la vue
semaine, et traiter le glisser-déposer comme un **report** — pas un `UPDATE` —
avec état optimiste puis retour en arrière visible sur 409.

### 3.2 Rendez-vous — `appointment.css`

Le formulaire vit dans un `.spa-admin-panel` accolé au calendrier : le tiroir
plutôt que la modale, pour que le planning reste lisible pendant la saisie.
Création et édition sont le même écran, à trois différences près — titre, libellé
de validation, actions destructives.

```html
<form id="rdv-creation" class="spa-admin-appointment">
  <div class="spa-admin-appointment__grid">
    <div class="spa-field spa-admin-appointment__span">…</div>
    <p class="spa-admin-appointment__timezone">Indian/Antananarivo (UTC+3) — fuseau du salon.</p>
  </div>
  <div class="spa-admin-appointment__summary">
    <div class="spa-admin-appointment__summary-row spa-admin-appointment__summary-row--buffer">…</div>
    <div class="spa-admin-appointment__summary-row spa-admin-appointment__summary-row--total">…</div>
  </div>
</form>

<div class="spa-admin-panel__footer">
  <button type="submit" form="rdv-creation" class="spa-button spa-button--accent">…</button>
</div>
```

- **Le pied du tiroir vit hors du `<form>`** — le bouton de validation doit donc
  porter `form="…"`. Sans cet attribut il n'est rattaché à aucun formulaire et ne
  soumet rien : la panne est silencieuse, et se voit seulement à l'usage.

- **Fin, durée, tampon et montant ne se saisissent pas** — ils découlent de la
  prestation. Saisissables, ils ouvriraient la porte à une fin incohérente avec
  le début, donc à un chevauchement que la contrainte d'exclusion refuserait
  après la saisie, trop tard pour l'opérateur.
- **Le tampon est affiché à part** : c'est ce qui explique pourquoi le créneau
  suivant n'est pas libre à l'heure attendue.
- **Conflit** — un 409 `SLOT_NO_LONGER_AVAILABLE` se pose dans
  `__conflict` en `.spa-notification--warning`. Sous concurrence c'est un cas
  normal, pas une panne : les disponibilités sont rechargées, **toutes** les
  autres saisies sont conservées, et le champ fautif porte `aria-invalid="true"`
  avec son message en `role="alert"`.

### 3.3 Fiche client — `client.css`

Liste à gauche, fiche à droite : le front-desk cherche un client pendant qu'il
l'a au téléphone, la liste ne disparaît donc jamais.

```html
<h3 class="spa-admin__section-title">
  Notes <span class="spa-admin-notes__private">Internes au salon</span>
</h3>
```

- **Les notes sont internes, et c'est écrit** — pas seulement suggéré par une
  teinte. C'est la seule garantie qu'un opérateur qui tourne son écran vers le
  client sait ce qu'il montre, et la seule qui survive à un daltonisme ou à une
  impression en gris.
- **L'historique montre les annulations et les absences** (`__amount--void`,
  montant barré) : c'est exactement ce qu'on vient y chercher avant d'accorder un
  créneau du samedi matin.
- **Une fiche appartient à un salon.** Deux homonymes chez deux salons sont deux
  fiches sans lien ; aucun écran ne doit laisser croire à un carnet partagé.

### 3.4 Personnel et horaires — `staff.css`

Deux moitiés : « qui travaille ici » et « quand ». Cette grille est **l'entrée du
moteur de disponibilité** — ce qui est saisi ici détermine les créneaux que le
parcours client proposera.

- **Fermé est un état**, pas une plage vide (`__closed`) : sans quoi « pas encore
  saisi » et « le salon ferme le mercredi » se confondent.
- **La pause est un creux** (`__range--break`), pas un second horaire.
- **Les exceptions sont datées** (`__exceptions`) et priment sur la règle
  hebdomadaire ; elles ne peuvent pas vivre dans la même liste.
- L'interrupteur ouvert/fermé est une **case à cocher native** : le design system
  n'a pas d'interrupteur parmi ses six composants, et en improviser un pour sept
  lignes coûterait plus qu'il ne rapporte.

### 3.5 Encaissement — `checkout.css`

**Cet écran ne contient aucun champ de numéro de carte, de CVC ou d'expiration,
et il n'en contiendra jamais.** Ce n'est pas un oubli de la maquette : c'est la
condition qui maintient le projet en auto-évaluation PCI **SAQ A**. Le jour où un
numéro de carte traverse notre code, l'obligation devient SAQ D et un audit
annuel.

Ce qui est dessiné, et rien d'autre :

- **Espèces** — aucun appel Stripe ; la vente est enregistrée avec son opérateur,
  son horodatage et son montant.
- **Carte** — le montant part vers un lecteur Stripe Terminal, dont l'état est
  affiché en permanence (`__terminal`, `--offline`). Le client compose son code
  sur le lecteur.
- **Lien de paiement** — quand il n'y a pas de lecteur.

Un numéro dicté au téléphone et saisi dans un formulaire est exactement ce que
SAQ A interdit ; la maquette n'offre nulle part où le taper, et
`.spa-admin-checkout__pci` écrit la règle sur l'écran, à l'intention de
l'opérateur autant que du prochain contributeur.

Taxes et remises sont des lignes distinctes (`__total-row`), jamais fondues dans
un prix — c'est ce qui rend le ticket vérifiable par le client et réconciliable
par le salon.

## 4. Accessibilité

- **Rien n'est porté par la seule couleur** (WCAG 1.4.1) : chaque statut affiche
  son libellé, chaque état vide son texte, chaque note interne sa mention.
- **Tout ce qui est cliquable est un `<button>` ou un `<a>`** — jamais une `<div>`
  avec un gestionnaire de clic, qui sortirait de l'ordre de tabulation.
- **Les groupes d'options sont des boutons radio natifs** dans un `<fieldset>`
  nommé par sa `<legend>` : navigation par flèches et annonce « 1 sur 2 » sans
  rien déclarer.
- **L'état courant s'appuie sur l'attribut** (`aria-current`), jamais sur une
  classe `--active` : l'état visuel ne peut alors pas diverger de l'état annoncé.
- **Contraste AA vérifié par exécution** — les rôles ajoutés ici ont leurs paires
  dans `contrast.test.mjs`, dérivées par statut pour qu'un sixième statut ne
  puisse pas arriver sans être vérifié.
- Les cibles cliquables respectent `--spa-target-min-size`, y compris la plus
  petite maille du calendrier.

## 5. Vérifications

```bash
npm run test:unit --workspace @spa/web   # ou : node --test apps/web/tests/
```

| Suite | Ce qu'elle empêche |
|---|---|
| `contrast.test.mjs` | qu'une teinte passe sous le seuil AA, statuts d'agenda et barre latérale sombre compris |
| `tokens.test.mjs` | qu'une couleur littérale ou une primitive entre dans une feuille, qu'une feuille échappe aux points d'entrée, et que le chrome admin fuie vers le parcours public |
| `admin-mockups.test.mjs` | que maquettes et CSS dérivent l'un de l'autre, qu'un écran perde son état vide ou son état de chargement, qu'un contrôle perde son libellé — **et qu'un champ de saisie de carte apparaisse sur l'écran d'encaissement** |

La vérification dans les deux sens est le cœur du dispositif : aucune classe
inventée dans une maquette, **et** aucun style admin que plus aucune maquette
n'exerce. Sans le second sens, une règle survivrait à l'écran qui la motivait et
la feuille grossirait de code mort que plus rien ne montre.

## 6. Ce qui reste à faire

À l'amorçage npm du front, et pas avant :

1. installer `react` / `next`, poser `next.config.*` ;
2. porter ces écrans en `app/(admin)/`, en Server Components par défaut —
   `"use client"` pour le calendrier, le tiroir d'édition et les contrôles qui
   portent un état, aussi bas que possible dans l'arbre ;
3. brancher `lib/api-client.ts` et les types de `@spa/shared` : **le front ne
   redéclare jamais un type que l'API expose** ;
4. virtualiser la vue semaine et implémenter le report par glisser-déposer.

Les classes documentées ici sont la source de vérité visuelle : les composants
React les porteront sans redéfinir un seul style.
