# États : chargement, vide, erreur

Chaque écran du tunnel a trois états non nominaux à concevoir explicitement — un
écran vide sans explication est un bug d'UX (`web-frontend` §6). Ce document les
définit étape par étape. Le cas particulier « créneau devenu indisponible »
(`409`) a son propre document : [slot-unavailable.md](slot-unavailable.md).

## Règles générales

- **Chargement** : squelettes qui reprennent la forme du contenu à venir, jamais
  un simple spinner centré qui masque tout. La structure de la page reste stable
  (pas de saut de mise en page à l'arrivée des données).
- **Vide** : toujours accompagné d'une explication et d'**au moins une action**
  pour sortir de l'impasse. Un cul-de-sac muet fait abandonner.
- **Erreur** : réagir sur le **`code`** de l'erreur typée (`{ code, message,
  details }`), jamais sur le `message` (`web-frontend` §2). Message compréhensible,
  action « Réessayer », et **conservation des saisies** en cours.
- Toute apparition d'un état vide ou d'erreur dynamique est annoncée via une
  région `aria-live` pour les lecteurs d'écran.
- `prefers-reduced-motion` respecté : les squelettes ne pulsent pas si l'option
  est active.

## Étape 1 — Service

```
CHARGEMENT                    VIDE                        ERREUR
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ · · · · · ·      │  │   Aucune         │  │ ! Impossible de  │
│ ┌──────────────┐ │  │   prestation     │  │   charger les    │
│ │ ⟳ · · · ·    │ │  │   n'est          │  │   prestations.   │
│ │ ⟳ · ·        │ │  │   disponible     │  │                  │
│ └──────────────┘ │  │   pour ce salon. │  │ [  Réessayer  ]  │
│ ┌──────────────┐ │  │                  │  │                  │
│ │ ⟳ · · · ·    │ │  │ ( Contacter le   │  │                  │
│ └──────────────┘ │  │   salon )        │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

- **Vide** : le salon n'a aucun service actif → proposer de contacter le salon
  (téléphone). Le tunnel ne peut pas démarrer sans service.
- **Erreur** : « Réessayer » relance la requête ; l'en-tête et l'indicateur
  d'étape restent visibles.

## Étape 2 — Praticien

```
CHARGEMENT                    VIDE (aucun nommé)          ERREUR
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ ┌──────────────┐ │  │ Aucun praticien  │  │ ! Chargement des │
│ │ ⟳ · · ·      │ │  │ dédié : nous     │  │   praticiens     │
│ ├──────────────┤ │  │ affecterons le   │  │   impossible.    │
│ │ ⟳ · ·        │ │  │ premier          │  │                  │
│ └──────────────┘ │  │ disponible.      │  │ [  Réessayer  ]  │
│                  │  │ [  Continuer  ]  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

- **Vide** : si aucun praticien nommé n'est proposable, on ne bloque pas — on
  bascule sur « premier disponible » et on l'explique. L'étape peut être passée
  automatiquement.
- **Erreur** : réessai ; la sélection de service en amont est conservée.

## Étape 3 — Créneau

L'étape la plus riche en états. À combiner avec
[slot-unavailable.md](slot-unavailable.md) pour le `409`.

```
CHARGEMENT                    VIDE (jour sans créneau)    ERREUR
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  ‹ août 2026  ›  │  │  ‹ août 2026  ›  │  │  ‹ août 2026  ›  │
│  25 [26] 27 …    │  │  25 [26] 27 …    │  │  25 [26] 27 …    │
│                  │  │                  │  │                  │
│ Matin            │  │ Aucun créneau le │  │ ! Impossible de  │
│ ┌───┐┌───┐┌───┐  │  │ mer. 27 août.    │  │   charger les    │
│ │⟳··││⟳··││⟳··│  │  │                  │  │   créneaux.      │
│ └───┘└───┘└───┘  │  │ Prochaine dispo :│  │                  │
│ ┌───┐┌───┐       │  │ [ jeu. 28 → 9:00]│  │ [  Réessayer  ]  │
│ │⟳··││⟳··│       │  │ ( Voir + de jours)│  │                  │
│ └───┘└───┘       │  │ ( Changer de     │  │                  │
│                  │  │   praticien )    │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

- **Chargement** : grille de créneaux en squelette, en gardant la barre de dates
  interactive pour changer de jour sans attendre.
- **Vide (jour complet)** : ne pas laisser le client dans le vide — proposer la
  **prochaine date disponible** en un clic, « voir plus de jours », et « changer
  de praticien » (souvent une autre personne a de la place). C'est le levier
  anti-abandon principal de cette étape.
- **Vide (aucune dispo sur toute la plage)** : proposer d'élargir la plage, de
  choisir « premier disponible », ou de contacter le salon.
- **Erreur** : réessai ; le jour et le praticien sélectionnés sont conservés.

## Étape 4 — Coordonnées

Pas de chargement de données (formulaire local). Les états sont ceux de la
**validation** et de la **soumission**.

```
VALIDATION (erreur de champ)         SOUMISSION EN COURS
┌──────────────────┐        ┌──────────────────┐
│ Téléphone        │        │ … formulaire figé │
│ [ +261 6        ]│        │                   │
│ ! Numéro         │        │ [ Enregistrement… ]│  bouton désactivé
│   incomplet      │        │                    │  spinner dans le bouton
│                  │        │                    │
│ E-mail           │        └──────────────────┘
│ [ jean@          ]│
│ ! Adresse e-mail │        + si le verrou de créneau expire ici :
│   invalide       │          voir slot-unavailable.md (traitement B)
└──────────────────┘
```

- **Validation** : erreurs **sous chaque champ**, pas en bloc en haut ; message
  issu du schéma Zod partagé. Le premier champ en erreur reçoit le focus à la
  tentative de soumission.
- **Soumission** : bouton désactivé + libellé de progression dès le premier clic
  (anti-double-clic). En cas d'erreur serveur de validation, les messages sont
  réinjectés sur les champs concernés.

## Étape 5 — Paiement

```
CHARGEMENT (Stripe)           TRAITEMENT                  ERREUR (refus)
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ À régler 70,00 € │  │ À régler 70,00 € │  │ À régler 70,00 € │
│ ┌──────────────┐ │  │ ┌──────────────┐ │  │ ! Paiement       │
│ │ ⟳ Chargement │ │  │ │ (Element figé)│ │  │   refusé par     │
│ │   du paiement│ │  │ └──────────────┘ │  │   votre banque.  │
│ │   sécurisé…  │ │  │                  │  │   Vérifiez vos   │
│ └──────────────┘ │  │ [ Traitement…  ] │  │   informations   │
│ [  ·  désactivé ]│  │   désactivé      │  │   ou changez de  │
└──────────────────┘  └──────────────────┘  │   carte.         │
                                             │ [  Réessayer  ]  │
                                             └──────────────────┘
```

- **Chargement** : le Payment Element Stripe met un instant à s'initialiser ; le
  bouton reste désactivé tant qu'il n'est pas prêt, avec un squelette dans le
  conteneur.
- **Traitement** : dès le clic, bouton désactivé + « Traitement… » ; l'Element se
  fige (anti-double-encaissement).
- **Erreur `PAYMENT_DECLINED`** : message sur l'étape paiement, **sans quitter la
  page** ni perdre le créneau ; le client corrige et réessaie. Le refus vient de
  Stripe/banque, pas d'une donnée de carte que nous stockerions (aucune donnée de
  carte côté serveur).
- **Erreur `SLOT_NO_LONGER_AVAILABLE` au moment de confirmer** : cas dédié,
  paiement non capturé → [slot-unavailable.md](slot-unavailable.md) (traitement
  C).

## Étape 6 — Confirmation

```
CHARGEMENT (post-paiement)    ERREUR (confirmation retardée)
┌──────────────────┐  ┌──────────────────┐
│      ⟳           │  │ Paiement accepté.│
│ Finalisation de  │  │ La confirmation  │
│ votre réservation│  │ prend un peu de  │
│ …                │  │ temps. Vous      │
│                  │  │ recevrez l'e-mail│
│                  │  │ sous peu.        │
│                  │  │ Réf. RDV-8F3K-27 │
└──────────────────┘  └──────────────────┘
```

- **Chargement** : bref, le temps que le webhook de paiement soit traité et le
  rendez-vous confirmé.
- **Erreur / latence** : si la confirmation tarde (traitement asynchrone du
  webhook), **ne pas inquiéter** — le paiement est passé ; afficher la référence
  et annoncer l'e-mail à venir plutôt qu'une erreur. Le rendez-vous existe même
  si l'écran n'a pas encore reçu sa confirmation.

## Synthèse

| Étape | Chargement | Vide | Erreur |
|---|---|---|---|
| 1 Service | Squelettes de cartes | Aucun service → contacter le salon | Réessayer |
| 2 Praticien | Squelettes de cartes | Aucun nommé → « premier disponible » | Réessayer |
| 3 Créneau | Grille en squelette, dates actives | Jour vide → prochaine dispo / autre praticien | Réessayer, jour conservé |
| 4 Coordonnées | — (local) | — | Erreurs sous les champs, saisies conservées |
| 5 Paiement | Element Stripe en cours d'init | — | `PAYMENT_DECLINED` → réessai ; `409` → slot-unavailable |
| 6 Confirmation | Finalisation brève | — | Latence webhook → rassurer, montrer la réf. |
