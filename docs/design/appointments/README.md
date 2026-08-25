# Parcours UX du tunnel de réservation

Livrables UX du tunnel de réservation client — le chemin
`service → praticien → créneau → coordonnées → paiement → confirmation`.
C'est la surface qui génère le revenu du MVP : chaque friction se paie en
abandons.

> Périmètre : **design uniquement**. Ces documents décrivent des intentions
> d'interface (wireframes, états, comportements, accessibilité). Ils
> n'implémentent aucun code — la mise en œuvre relève des tickets `apps/web`
> correspondants, qui doivent s'y conformer. Rattaché à l'issue #28
> (`ws:design`, `mod:appointments`).

## Documents

| Fichier | Contenu | Critère d'acceptation couvert |
|---|---|---|
| [wireframes.md](wireframes.md) | Wireframes des 6 étapes, mobile d'abord + notes desktop | Wireframes des étapes ; parcours mobile d'abord |
| [slot-unavailable.md](slot-unavailable.md) | Traitement visuel du créneau devenu indisponible (409) | Cas créneau devenu indisponible |
| [states.md](states.md) | États de chargement, vides et d'erreur, étape par étape | États de chargement / vides / erreur |
| [keyboard-navigation.md](keyboard-navigation.md) | Navigation clavier et accessibilité du sélecteur de créneau | Navigation clavier sur le sélecteur de créneau |

## Correspondance avec les critères d'acceptation (#28)

- [x] **Wireframes des étapes** service → praticien → créneau → coordonnées →
  paiement → confirmation → [wireframes.md](wireframes.md)
- [x] **Traitement visuel du cas créneau devenu indisponible** →
  [slot-unavailable.md](slot-unavailable.md)
- [x] **États de chargement, états vides et états d'erreur définis** →
  [states.md](states.md)
- [x] **Parcours pensé mobile d'abord** → [wireframes.md](wireframes.md)
  (colonne unique, CTA au pouce, barre de résumé collante) et principes ci-dessous
- [x] **Navigation clavier prévue sur le sélecteur de créneau** →
  [keyboard-navigation.md](keyboard-navigation.md)

## Le modèle en six étapes

```
   1            2            3            4             5            6
Service  →  Praticien  →  Créneau  →  Coordonnées  →  Paiement  →  Confirmation
  │            │            │            │              │
  └── un indicateur d'étape persistant en haut ; retour possible sans perte de saisie
```

- Une étape par écran sur mobile (progressive disclosure). Sur desktop, le
  contenu de l'étape occupe la colonne principale et un **récapitulatif** occupe
  une colonne latérale toujours visible.
- L'étape `Praticien` peut être **sautée** si le client choisit « premier
  disponible » ; l'étape reste dans le fil pour permettre le retour arrière.
- La progression est portée par l'URL (`/book/{salon}?step=slot&service=...`) et
  doublée en `sessionStorage`, pour qu'un rafraîchissement ne perde jamais la
  saisie (cf. `web-frontend` §3).

## Principes transverses

Ces principes s'appliquent à tous les écrans et priment en cas de doute. Ils
reprennent les contraintes des skills `web-frontend` et `booking-engine` et du
CLAUDE.md.

### Mobile d'abord
- Conception à 360 px de large en premier ; le desktop est une amélioration
  progressive, pas l'inverse.
- **Colonne unique**, une décision principale par écran.
- **Action primaire au pouce** : bouton pleine largeur, ancré en bas de l'écran
  (barre collante), toujours atteignable sans remonter.
- Barre de résumé collante en bas rappelant service, praticien, date/heure et
  **prix** dès qu'ils sont connus.
- Cibles tactiles ≥ 44×44 px, espacées pour éviter les touches accidentelles
  (les créneaux voisins sont proches).
- Budget performance : LCP < 2,5 s en 4G sur l'étape d'entrée. Contenu au-dessus
  de la ligne de flottaison rendu côté serveur quand c'est possible.

### Accessibilité (AA)
- Navigation complète au clavier sur tout le tunnel, focus visible, ordre de
  tabulation cohérent. Le sélecteur de créneau est le point le plus souvent
  raté — voir [keyboard-navigation.md](keyboard-navigation.md).
- Contraste texte AA minimum ; l'information n'est jamais portée par la seule
  couleur (les créneaux indisponibles ont un état visuel *et* textuel).
- Libellés `aria` sur tous les contrôles non textuels ; les changements
  dynamiques (créneau pris, erreur) sont annoncés via une région `aria-live`.
- Respect de `prefers-reduced-motion` : les transitions d'étape se réduisent à un
  fondu court.

### Fuseau horaire et dates
- Les heures sont affichées dans le **fuseau du salon**. Si le visiteur est dans
  un autre fuseau, une mention explicite l'indique (« Heures affichées pour
  Indian/Antananarivo »).
- Aucune conversion silencieuse : un rendez-vous mal fuseau-horairé est un bug de
  sévérité haute (CLAUDE.md).

### Argent
- Les montants sont **formatés à partir d'entiers** (plus petite unité monétaire)
  avec un code devise explicite ; jamais de calcul en `float` côté présentation.
- Le prix total (service + éventuels suppléments) est visible avant le paiement,
  jamais découvert à la dernière étape.

### Paiement — frontière PCI
- Les champs de carte sont **hébergés par Stripe** (Stripe Elements / Payment
  Element dans une iframe). Aucun numéro de carte ne transite par nos formulaires
  ni notre code (SAQ A). Les wireframes de l'étape paiement représentent donc un
  **conteneur d'éléments Stripe**, pas des champs `<input>` de carte maison.

### Concurrence et anti-double-clic
- Un créneau affiché peut avoir été pris entre l'affichage et la validation :
  cas **normal**, traité en [slot-unavailable.md](slot-unavailable.md).
- Le bouton de soumission (réservation, paiement) se **désactive dès le premier
  clic** et affiche un état de progression ; un double clic ne produit jamais
  deux réservations.

### Design system
- Tokens Tailwind (couleurs, espacements, rayons) ; aucune couleur en dur. Un
  salon personnalisera ses couleurs plus tard sans réécrire les écrans.
- Chaque écran a un état de chargement et un état vide définis — voir
  [states.md](states.md).

## Conventions des wireframes

Les wireframes sont en ASCII, volontairement basse-fidélité : ils fixent la
**structure, la hiérarchie et le comportement**, pas le pixel. Légende :

```
[ Bouton ]        action primaire (pleine largeur sur mobile)
( Bouton )        action secondaire
[x] / [ ]         sélection (radio/case), état choisi / non choisi
▸ / ▾             élément repliable fermé / ouvert
⟳                 zone en cours de chargement (squelette)
!                 message d'erreur ou d'alerte
· · ·             squelette / contenu différé
────              séparateur / bord de conteneur
```
