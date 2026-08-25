# Wireframes — tunnel de réservation

Wireframes basse-fidélité des six étapes du tunnel client. **Mobile d'abord** :
chaque écran est décrit en 360 px de large (colonne unique), suivi des
adaptations desktop. Légende et principes transverses : [README.md](README.md).

Structure commune à toutes les étapes :

```
┌────────────────────────────┐
│ ← Retour        Spa Zen  ⓘ │  en-tête : retour, nom du salon, aide
├────────────────────────────┤
│ ①──②──③──④──⑤──⑥           │  indicateur d'étape (étape courante mise en avant)
│ Service                    │  titre de l'étape courante
├────────────────────────────┤
│                            │
│      … contenu étape …     │
│                            │
├────────────────────────────┤
│ Résumé · 45 min · 40,00 €  │  barre de résumé collante (dès que connu)
│ [        Continuer       ] │  CTA primaire pleine largeur, au pouce
└────────────────────────────┘
```

- L'indicateur d'étape montre la progression et permet de **revenir** à une étape
  déjà franchie (les étapes futures ne sont pas cliquables).
- La barre de résumé + CTA est **collante en bas** ; le contenu défile derrière.
- Le CTA est désactivé tant que l'étape n'est pas valide, avec un libellé qui dit
  pourquoi (« Choisir un service pour continuer »).

---

## Étape 1 — Service

Le client choisit une prestation. Regroupée par catégorie (CDC catalogue).

```
┌────────────────────────────┐
│ ← Retour        Spa Zen  ⓘ │
│ ①──②──③──④──⑤──⑥           │
│ Choisir une prestation     │
├────────────────────────────┤
│ [ Rechercher…            🔎]│
│                            │
│ Massages            ▾      │
│ ┌────────────────────────┐ │
│ │[ ] Massage suédois     │ │
│ │    60 min · 55,00 €    │ │
│ │    Détente profonde…   │ │
│ ├────────────────────────┤ │
│ │[x] Massage aux pierres │ │  ← sélection = surbrillance + case
│ │    75 min · 70,00 €    │ │
│ └────────────────────────┘ │
│ Soins du visage     ▸      │  catégorie repliée
│ Épilation           ▸      │
├────────────────────────────┤
│ Massage pierres · 75 min   │
│ [        Continuer       ] │
└────────────────────────────┘
```

- Une seule prestation par réservation dans le MVP (pas de panier multi-services).
- Chaque carte affiche **durée** et **prix** (formaté depuis un entier + devise).
- La sélection est un `radiogroup` : un seul choix actif, navigable au clavier.
- **Desktop** : grille de 2–3 cartes par ligne ; le résumé passe en colonne
  latérale droite, collante, visible dès cette étape.

---

## Étape 2 — Praticien

Choix du praticien, ou « premier disponible ». Seuls les praticiens qui
réalisent la prestation choisie sont proposés (`staff_services`, cf.
`booking-engine` §3).

```
┌────────────────────────────┐
│ ← Retour        Spa Zen  ⓘ │
│ ①──②──③──④──⑤──⑥           │
│ Choisir un praticien       │
├────────────────────────────┤
│ ┌────────────────────────┐ │
│ │[x] ✦ Premier disponible│ │  ← option par défaut, recommandée
│ │    Le plus tôt possible│ │
│ ├────────────────────────┤ │
│ │[ ] (○) Awa · Massages  │ │  avatar + nom + spécialité
│ │[ ] (○) Rina · Massages │ │
│ └────────────────────────┘ │
├────────────────────────────┤
│ Massage pierres · 75 min   │
│ [        Continuer       ] │
└────────────────────────────┘
```

- « Premier disponible » est **présélectionné** : c'est le chemin qui trouve le
  plus de créneaux et réduit l'abandon.
- Choisir un praticien nommé filtrera l'étape créneau sur son agenda.
- Étape **sautable** : si le salon n'a qu'un praticien pour ce service, on la
  passe automatiquement (mais elle reste visible dans l'indicateur pour le retour
  arrière).
- **Desktop** : cartes praticiens en grille ; le résumé latéral s'enrichit du
  praticien choisi.

---

## Étape 3 — Créneau

Choix de la date puis de l'heure. **Cœur du tunnel** et point d'accessibilité le
plus délicat — l'interaction clavier complète est décrite dans
[keyboard-navigation.md](keyboard-navigation.md), les états dans
[states.md](states.md), le cas « créneau pris » dans
[slot-unavailable.md](slot-unavailable.md).

```
┌────────────────────────────┐
│ ← Retour        Spa Zen  ⓘ │
│ ①──②──③──④──⑤──⑥           │
│ Choisir un créneau         │
├────────────────────────────┤
│ Heures affichées pour      │  mention fuseau si visiteur ailleurs
│ Indian/Antananarivo (EAT)  │
│                            │
│  ‹  août 2026           ›  │  navigation de semaine/jour
│  L   M   M   J   V   S   D │
│ 25  26 [27] 28  29  30  31 │  ← date sélectionnée mise en avant
│                            │
│ Matin                      │
│  ┌─────┐┌─────┐┌─────┐     │
│  │09:00││09:30││10:00│     │  grille de créneaux (role=grid)
│  └─────┘└─────┘└─────┘     │
│ Après-midi                 │
│  ┌─────┐┌╌╌╌╌╌┐┌─────┐     │
│  │14:00││14:30││15:00│     │  ╌ = créneau indisponible (désactivé)
│  └─────┘└╌╌╌╌╌┘└─────┘     │
│                            │
│ (Voir plus de jours)       │
├────────────────────────────┤
│ … · mer. 27 août · 14:00   │
│ [        Continuer       ] │
└────────────────────────────┘
```

- Les créneaux se calculent à la demande (jamais matérialisés) et se
  **rafraîchissent** pendant que le client hésite (revalidation courte + au
  retour de focus), cf. `booking-engine` §3 et `web-frontend` §3.
- Un créneau indisponible reste visible mais **désactivé** (état visuel + `aria`),
  jamais retiré brutalement sous le doigt.
- Sélectionner un créneau pose un **verrou Redis court** côté serveur (UX, 120 s) ;
  l'UI affiche « Créneau retenu pour vous » avec un compte à rebours discret.
- **Desktop** : le calendrier passe en vue semaine (colonnes de jours), plus de
  créneaux visibles d'un coup ; le résumé latéral affiche date + heure.

---

## Étape 4 — Coordonnées

Identité du client et consentement. `react-hook-form` + schéma Zod partagé
(`@spa/shared`), cf. `web-frontend` §4.

```
┌────────────────────────────┐
│ ← Retour        Spa Zen  ⓘ │
│ ①──②──③──④──⑤──⑥           │
│ Vos coordonnées            │
├────────────────────────────┤
│ Prénom                     │
│ [__________________________]│
│ Nom                        │
│ [__________________________]│
│ Téléphone                  │
│ [ +261 __ __ ___ __       ]│  E.164, normalisé à la saisie
│ E-mail                     │
│ [__________________________]│
│                            │
│ Remarque (facultatif)      │
│ [__________________________]│
│                            │
│ [ ] J'accepte les CGV et   │  consentement RGPD explicite
│     la politique de données│
├────────────────────────────┤
│ … retenu · 14:00 · 70,00 € │  ⏱ compte à rebours du verrou
│ [    Aller au paiement    ]│
└────────────────────────────┘
```

- Erreurs de champ **réinjectées sous le champ concerné**, pas en bloc en haut.
- Téléphone en **E.164** (`+261…`), normalisé à la frappe.
- La barre de résumé rappelle le **compte à rebours** du créneau retenu : si le
  verrou expire pendant la saisie, on bascule sur le cas
  [slot-unavailable.md](slot-unavailable.md) sans perdre les champs saisis.
- Client connu : les champs sont pré-remplis, l'étape se réduit à une
  confirmation.

---

## Étape 5 — Paiement

Encaissement de l'acompte / du montant via **Stripe** (tokenisation côté client).
**Aucune donnée de carte ne touche notre code** (SAQ A) : les champs sont un
conteneur Stripe hébergé.

```
┌────────────────────────────┐
│ ← Retour        Spa Zen  ⓘ │
│ ①──②──③──④──⑤──⑥           │
│ Paiement                   │
├────────────────────────────┤
│ À régler                   │
│  Massage pierres   70,00 € │
│  ────────────────────────  │
│  Total            70,00 €  │  entiers + devise, jamais de float
│                            │
│ ┌────────────────────────┐ │
│ │  Paiement sécurisé 🔒  │ │
│ │  ┌──────────────────┐  │ │
│ │  │  Stripe Payment  │  │ │  ← iframe Stripe (hors de notre code)
│ │  │  Element         │  │ │
│ │  └──────────────────┘  │ │
│ └────────────────────────┘ │
│ Vos données de carte sont  │
│ traitées par Stripe.       │
├────────────────────────────┤
│ … · 14:00 · ⏱ 1:48 restant │
│ [   Payer et confirmer    ]│  se désactive au 1er clic
└────────────────────────────┘
```

- Le bouton passe en état « Traitement… » désactivé dès le premier clic
  (anti-double-encaissement, cf. `web-frontend` §3).
- Le montant est présenté **avant** l'action, formaté depuis un entier + devise.
- Si le verrou expire ou le créneau est pris avant capture : cas
  [slot-unavailable.md](slot-unavailable.md), sans avoir capturé le paiement.
- **Desktop** : le récapitulatif de commande reste en colonne latérale ; le
  Payment Element occupe la colonne principale.

---

## Étape 6 — Confirmation

Preuve de réservation et prochaines actions. Écran terminal du tunnel.

```
┌────────────────────────────┐
│                 Spa Zen  ⓘ │
├────────────────────────────┤
│           ✔                │
│   Réservation confirmée    │
│                            │
│  Massage aux pierres       │
│  avec Awa                  │
│  mer. 27 août · 14:00      │
│  (Indian/Antananarivo)     │
│  75 min · 70,00 € payés    │
│                            │
│  Réf. RDV-8F3K-27          │
│                            │
│  Un e-mail et un SMS de    │  notifications (skill notifications)
│  confirmation vous ont été │
│  envoyés.                  │
│                            │
│ [ Ajouter à mon agenda    ]│  .ics / lien calendrier
│ ( Modifier / annuler      )│  vers report / annulation
│ ( Réserver à nouveau      )│
└────────────────────────────┘
```

- Plus d'indicateur d'étape ni de barre collante : le tunnel est terminé.
- Récapitule prestation, praticien, **date/heure avec fuseau**, durée, montant
  payé, référence.
- Annonce l'envoi des confirmations e-mail/SMS (chaîne `notifications`).
- Actions : ajout à l'agenda (`.ics`), modification/annulation, nouvelle
  réservation. Le report passe par le cycle de vie du rendez-vous
  (`booking-engine` §5), pas par un simple `UPDATE`.
- **Desktop** : carte centrée, largeur limitée pour la lisibilité.

---

## Récapitulatif des adaptations desktop

| Étape | Mobile (colonne unique) | Desktop |
|---|---|---|
| Toutes | Barre de résumé + CTA collants en bas | Résumé en colonne latérale collante ; CTA dans le flux |
| 1 Service | Cartes empilées | Grille 2–3 colonnes |
| 2 Praticien | Cartes empilées | Grille de cartes |
| 3 Créneau | Sélecteur de jour + créneaux en grille scrollable | Vue semaine multi-colonnes |
| 4 Coordonnées | Champs pleine largeur | Formulaire 2 colonnes possible |
| 5 Paiement | Récap au-dessus, Payment Element en dessous | Récap latéral, Payment Element principal |
| 6 Confirmation | Pleine largeur | Carte centrée bornée |
