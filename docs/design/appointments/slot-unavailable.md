# Créneau devenu indisponible

Le créneau affiché au client peut avoir été réservé par quelqu'un d'autre entre
le moment où il s'affiche et celui où le client valide. **Ce n'est pas une
erreur exceptionnelle, c'est un cas normal sous concurrence** (`booking-engine`
§1, `web-frontend` §3). L'API répond alors `409 Conflict` avec le code
`SLOT_NO_LONGER_AVAILABLE`. L'UX doit le traiter avec calme et sans jamais faire
perdre au client ce qu'il a déjà saisi.

## Principe directeur

> Ne jamais punir le client d'une collision qui n'est pas de son fait. On
> explique, on recharge, on repropose — on ne renvoie **jamais** vers une page
> d'erreur générique et on ne perd **aucune** autre saisie.

Trois exigences non négociables :

1. **Conserver le contexte** — service, praticien, coordonnées, et le montant à
   payer restent en place. Seul le choix du créneau est invalidé.
2. **Recharger les créneaux** — la liste est immédiatement rafraîchie pour
   refléter la réalité, le créneau pris apparaissant désormais désactivé.
3. **Message clair et non alarmant** — ton neutre, action évidente. Pas de rouge
   « erreur système ».

## Où le cas peut survenir

| Moment | Déclencheur | Ce que voit le client |
|---|---|---|
| À l'étape créneau | Le client clique un créneau qu'un autre vient de prendre | Le créneau se grise, message en ligne, focus déplacé |
| Expiration du verrou | Le verrou Redis (120 s) expire pendant la saisie des coordonnées ou du paiement | Bandeau « créneau libéré », retour guidé à l'étape créneau |
| À la validation du paiement | La contrainte d'exclusion rejette la création (`409`) au moment de confirmer | Le paiement **n'est pas capturé** ; retour à l'étape créneau avec message |

Le cas au paiement est le plus sensible : la barrière de vérité est la
**contrainte d'exclusion en base**, pas le verrou Redis ni une vérification
applicative. On ne capture le paiement qu'après création réussie du rendez-vous.
Si la création échoue en `409`, aucun montant n'est débité.

## Traitement A — collision à la sélection

Le client clique un créneau qui vient d'être pris. La grille se recharge et le
créneau bascule en état désactivé.

```
┌────────────────────────────┐
│ Choisir un créneau         │
├────────────────────────────┤
│ ! Ce créneau vient d'être  │   région aria-live="assertive"
│   réservé. Voici les       │   ton neutre, pas d'écran d'erreur
│   disponibilités à jour.   │
│                            │
│ Après-midi                 │
│  ┌─────┐┌╌╌╌╌╌┐┌─────┐     │
│  │14:00││14:30││15:00│     │  ╌ 14:30 : désormais indisponible
│  └─────┘└╌╌╌╌╌┘└─────┘     │      (barré, non focusable, aria-disabled)
│         ▲ focus déplacé ici │  le focus va au créneau adjacent le plus proche
├────────────────────────────┤
│ Massage pierres · 75 min   │  ← service et prix conservés
│ [ Choisir un autre créneau]│  CTA désactivé tant que rien n'est resélectionné
└────────────────────────────┘
```

- Le message s'affiche **en ligne, au-dessus de la grille**, dans une région
  `aria-live="assertive"` pour être annoncé aux lecteurs d'écran.
- Le créneau pris devient `aria-disabled`, retiré de l'ordre de tabulation ; le
  **focus est déplacé** vers le créneau disponible le plus proche pour que la
  navigation clavier ne se retrouve pas sur un élément mort (cf.
  [keyboard-navigation.md](keyboard-navigation.md)).
- Aucune modale bloquante : le client reste dans le flux, il lui suffit de
  choisir un autre créneau.

## Traitement B — expiration du verrou pendant la saisie

Le client a réservé le créneau (verrou Redis 120 s) puis prend son temps sur les
coordonnées ou le paiement. Le verrou expire.

```
┌────────────────────────────┐
│ Paiement                   │
├────────────────────────────┤
│ ┌────────────────────────┐ │
│ │ ! Votre créneau de 14:00│ │  bandeau non destructif, en tête
│ │   a expiré. Confirmez-le│ │
│ │   à nouveau pour        │ │
│ │   continuer.            │ │
│ │   [ Revoir les créneaux]│ │
│ └────────────────────────┘ │
│                            │
│ (le formulaire de paiement │  saisies conservées, action bloquée
│  reste rempli, désactivé)  │  tant que le créneau n'est pas re-confirmé
├────────────────────────────┤
│ [   Payer et confirmer    ]│  désactivé
└────────────────────────────┘
```

- On **anticipe** l'expiration : à ~20 s de la fin du verrou, un rappel discret
  invite à finaliser (« Plus que 20 s pour confirmer votre créneau »).
- À l'expiration, le paiement est bloqué (on ne débite pas pour un créneau non
  garanti) mais **toutes les saisies restent** ; « Revoir les créneaux » ramène à
  l'étape 3, le créneau initial resélectionné s'il est encore libre.

## Traitement C — collision à la confirmation du paiement

Le client valide le paiement mais la création du rendez-vous est refusée en
`409` par la contrainte d'exclusion (concurrence gagnée par un autre).

Séquence :

```
Client clique [Payer et confirmer]
        │
        ▼
Bouton → « Traitement… » (désactivé)          ← anti-double-clic
        │
        ▼
API crée le RDV → 409 SLOT_NO_LONGER_AVAILABLE ← paiement NON capturé
        │
        ▼
Retour étape Créneau + message + créneaux rechargés
Coordonnées et intention de paiement conservées
```

```
┌────────────────────────────┐
│ Choisir un créneau         │
├────────────────────────────┤
│ ! Le créneau de 14:00 a été│
│   pris à l'instant. Aucun  │   rassure : rien n'a été débité
│   montant n'a été débité.  │
│   Choisissez un nouveau    │
│   créneau, vos coordonnées │
│   sont conservées.         │
│                            │
│  … grille rechargée …      │
├────────────────────────────┤
│ [ Choisir un autre créneau]│
└────────────────────────────┘
```

- Le message dit **explicitement qu'aucun montant n'a été débité** — c'est la
  première inquiétude du client.
- On revient à l'étape créneau (pas au paiement), créneaux rechargés ; une fois
  un nouveau créneau choisi, le client repasse au paiement avec ses coordonnées
  intactes.

## Distinction avec les vraies erreurs

Le `409 SLOT_NO_LONGER_AVAILABLE` **n'est pas** une erreur système et ne doit
jamais être présenté comme telle. Les vraies erreurs (réseau, `5xx`, paiement
refusé par la banque) relèvent des **états d'erreur** décrits dans
[states.md](states.md). Le composant réagit sur le **`code`** de l'erreur, jamais
sur son `message` (`web-frontend` §2) :

| `code` | Nature | Traitement |
|---|---|---|
| `SLOT_NO_LONGER_AVAILABLE` | Concurrence, cas normal | Ce document : recharger + message neutre |
| `PAYMENT_DECLINED` | Carte refusée | [states.md](states.md) : message sur l'étape paiement, réessai |
| réseau / `5xx` | Panne | [states.md](states.md) : état d'erreur avec « Réessayer » |
