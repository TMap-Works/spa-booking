# Les mots du produit — glossaire FR/EN

Ce répertoire est la **source unique** des textes du front (#845) : un catalogue
par namespace, un répertoire par langue, `en` faisant foi pour le typage
(`i18n/catalog.d.ts`).

Ce fichier-ci ne décrit pas la mécanique, il fixe le **vocabulaire**. Il existe
parce qu'un catalogue complet et sans clé manquante peut rester mal écrit : la
recette de traduction du 2026-09-29 a trouvé le même écran nommé « Schedule »,
« planning », « calendar » et « agenda », des statuts dits « Honoured » d'un côté
et « Completed » de l'autre, et de l'orthographe britannique dans un produit
vendu à un client américain (#1329).

## Deux règles avant le glossaire

**L'anglais du produit est l'anglais américain.** `catalog` et non
`catalogue`, `canceled` / `canceling` et non `cancelled` / `cancelling`,
`recognized`, `honor`, `favor`, `toward`, `register` et non `till`. Une
exception qui n'en est pas une : **`cancellation` garde ses deux `l`** — l'anglais
américain ne simplifie que les formes fléchies du verbe.

**Une chose, un mot, dans toutes les langues.** Le même objet ne peut pas
s'appeler autrement selon l'écran qui le montre. Quand un doute survient, c'est
ce tableau qui tranche, et non l'écran voisin.

## Le glossaire

| Ce dont on parle | Français | English |
|---|---|---|
| La grille jour/semaine du back-office, l'écran et la chose | **planning** | **schedule** |
| La même, vue par un praticien pour lui seul | mon planning | my schedule |
| Le temps qu'une prestation occupe dans cette grille | le planning | the schedule |
| Le carnet de rendez-vous du salon, vu du dehors | le planning du salon | the salon's schedule |
| Le sélecteur de date du tunnel de réservation | calendrier | calendar |
| L'agenda personnel de la cliente, où l'export ICS dépose | **agenda** | calendar |
| La liste des prestations | catalogue | **catalog** |
| Un regroupement de prestations dans ce catalogue | rubrique | **section** |
| Une prestation | prestation | service |
| La personne qui exécute la prestation | praticien | practitioner |
| La personne qui réserve | cliente / client | client |
| Un rendez-vous | rendez-vous | appointment |
| Le créneau proposé à la réservation | créneau | slot |
| Rendez-vous qui a eu lieu (statut `completed`) | honoré | **completed** |
| Rendez-vous où la cliente ne s'est pas présentée (statut `no_show`) | non honoré | **no-show** (jamais « no show ») |
| Rendez-vous annulé (statut `cancelled`) | annulé | canceled |
| Ligne d'origine d'un report — annulée sans auteur | déplacé | rescheduled |
| Déplacer un rendez-vous | reporter / déplacer | reschedule |
| L'espace de travail du salon | back-office | back office |
| L'espace de l'éditeur, au-dessus des salons (ADR 0012) | console | console |
| L'encaissement au comptoir | la caisse | the register |
| La personne qui encaisse | caissier | cashier |
| Le terminal de paiement du salon (ADR 0015) | TPE | card terminal |
| Le reçu remis à la cliente | ticket | receipt |
| L'adresse web d'une page — `/maison-lotus` | adresse de la page | page address |

`slug` n'est pas dans ce tableau : c'est un mot de développeur. À l'écran, on dit
« adresse » ou « adresse de la page », dans les deux langues.

Trois mots français pour trois choses, et c'est délibéré : la grille du salon est
un **planning** — c'est le titre de l'écran et l'entrée du rail —, le sélecteur
de date du tunnel est un **calendrier**, et l'**agenda** est celui de la cliente,
dans son téléphone. L'anglais n'a pas ce luxe : `schedule` pour les deux
premières acceptions de service, `calendar` pour les deux qui concernent un
calendrier au sens propre.

## Registre

- **Une phrase montrée à quelqu'un commence par une capitale et finit par un
  point** — refus de validation compris. « Saisissez une adresse e-mail
  valide. », et non « adresse e-mail invalide ».
- **Aucun terme d'implémentation à l'écran.** Ni « front end », ni « MVP », ni
  « slug », ni « API ». On dit ce que la personne peut en faire, pas comment
  c'est construit.
- **Les acronymes légaux ne se devinent pas.** « SIRET » sur un écran américain
  ne veut rien dire : on écrit « identifiant fiscal » / « tax identifier », et
  l'acronyme réel n'apparaît que là où la donnée est saisie.
- **Les pluriels passent par ICU**, jamais par « (s) ». `{count, plural, =0 {…}
  one {# …} other {# …}}` — et le cas `=0` se nomme, parce que « 0 fiche »
  s'écrit « Aucune fiche ».
- **Un libellé qui reçoit un nom propre ne présume pas de sa forme.** Un nom
  d'affichage abrégé finit par un point (« Yanis B. ») : la phrase qui l'insère ne
  doit pas en ajouter un second. Et le français élide — « la fiche d'Alice » —, ce
  que le message porte par un `select` sur l'argument `elision`
  (`lib/elision.ts`).

## Ce que la langue ne change pas

Les **paramètres d'URL** et les **segments de route** restent français
(`?periode=`, `/reservation`, `/calendrier`) : un lien partagé entre deux
collègues doit ouvrir le même écran quelle que soit la langue de chacun.

Ce glossaire vaut aussi pour les textes **hors de ce répertoire** qui partent chez
la cliente ou qu'elle lit : les modèles d'e-mail et de SMS de
`apps/api/src/modules/notifications/notification-default-templates.ts`, le
vocabulaire du PDF du reçu
(`apps/api/src/modules/payments/receipt-pdf/receipt-pdf.vocabulary.ts`) et les
refus de validation du contrat partagé
(`packages/shared/src/errors/zod-messages.ts`). #1356 y a porté l'orthographe
américaine et la règle de ponctuation — capitale en tête, point final —, et a
sorti « slug » des refus de validation. Ce qui reste à faire de ce côté-là est
nommé : les refus du contrat énoncent encore une faute (« Adresse e-mail
invalide. ») là où ce glossaire préfère dire quoi faire (« Saisissez une adresse
e-mail valide. »), et les catalogues de validation de ce répertoire même —
`admin-catalog.json`, `admin-staff.json`, `admin-settings.json` — sont restés
minuscules et sans point quand #1329 n'a repris que `booking.json`,
`signup.json` et `admin-auth.json`. Le test du glossaire, lui, ne lit que
`apps/web/messages` et ne juge que le vocabulaire : sur le registre, c'est la
relecture qui tient la règle.

Les **noms de clés** de ces catalogues non plus. Plusieurs reprennent une valeur
d'énumération du contrat partagé — `appointment-status.json` porte `cancelled` et
`no_show` parce que `AppointmentStatus` les nomme ainsi. Ce sont des
identifiants ; seules leurs valeurs sont du texte.
