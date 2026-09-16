# Benchmark — langage visuel, filtres et comportements communs

Relevé le 2026-09-16. S'applique à **tous les écrans** — c'est ici que se
trouve ce qui fait qu'un produit « paraît » moderne et professionnel, réduit à
ce qui se constate. Règles de lecture et de citation : [README.md](README.md).

Les motifs de langage visuel ont été **observés** sur les tunnels publics de
Fresha, Planity, Treatwell, Booker et Square (voir le tableau des pages dans
[parcours-client.md](parcours-client.md)). Aucun back-office n'a été vu : pour
les écrans d'administration, ces motifs se transposent, ils ne se citent pas
comme une observation du back-office d'une référence.

Chaque motif de ce fichier se réalise **avec nos jetons et nos composants** :
`apps/web/styles/tokens.css`, `apps/web/components/ui/`. Il dit une structure
et une hiérarchie, jamais une couleur, une police ou une forme empruntée.

## Langage visuel

### BM-VISUEL-01 — Un fond neutre, et une seule couleur d'accent, réservée

- **Étape** : tous les écrans — couleur
- **Ce que voit l'utilisateur** : un fond blanc ou gris très clair, du texte presque noir, et une seule couleur d'accent, employée pour l'état sélectionné, les liens et l'action principale — nulle part ailleurs.
- **Pourquoi** : quand l'accent est rare, il désigne ; quand il est partout, il ne dit plus rien.
- **À vérifier chez nous** : sur la capture, la couleur d'accent désigne-t-elle seulement la sélection et l'action principale ? Des aplats de couleur décoratifs se disputent-ils l'œil ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

Treatwell fait exception, avec une palette marine, corail et turquoise : le
motif est majoritaire, pas universel.

### BM-VISUEL-02 — Un seul bouton plein par écran

- **Étape** : tous les écrans — actions
- **Ce que voit l'utilisateur** : une seule action principale, en bouton plein et contrasté (« Réserver », « Continuer ») ; les actions secondaires en contour ou en lien (« Créer mon compte », « Modifier »).
- **Pourquoi** : on sait en une seconde où cliquer.
- **À vérifier chez nous** : l'écran porte-t-il deux boutons pleins de même poids ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-VISUEL-03 — Le prix en gras, la durée en retrait

- **Étape** : listes de prestations et récapitulatifs — typographie
- **Ce que voit l'utilisateur** : le prix en graisse forte (souvent aligné à droite), la durée et les précisions en gris secondaire, plus petites ; les montants d'un récapitulatif alignés en colonne.
- **Pourquoi** : l'œil trouve le chiffre qui décide sans lire la ligne entière.
- **À vérifier chez nous** : prix et durée ont-ils deux niveaux typographiques distincts ? Les montants d'un total sont-ils alignés ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-VISUEL-04 — Les photos sur la vitrine et les visages, pas dans les listes

- **Étape** : tous les écrans — images
- **Ce que voit l'utilisateur** : des photos en tête de vitrine et sur les portraits de l'équipe ; aucune dans les lignes de prestation, qui restent textuelles.
- **Pourquoi** : l'image rassure là où l'on choisit un lieu et une personne, et encombre là où l'on compare des prix.
- **À vérifier chez nous** : les listes de prestations restent-elles denses et lisibles, sans vignettes qui les allongent ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-VISUEL-05 — Un statut s'écrit ; la couleur l'appuie

- **Étape** : tous les écrans — statuts
- **Ce que voit l'utilisateur** : chaque statut est un mot (« Remboursée », « Annulée », « Terminé »), éventuellement dans une pastille colorée ; jamais une couleur seule.
- **Pourquoi** : lisible sans percevoir les couleurs, et sans confusion entre deux verts (WCAG 1.4.1).
- **À vérifier chez nous** : un statut quelconque est-il porté par la seule couleur, sur une liste ou au planning ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941474-orders-and-closeout
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/368-refund-a-sale
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018094500-How-do-I-undo-a-sale-transaction

### BM-VISUEL-06 — Dates et heures à la française

- **Étape** : tous les écrans — formats
- **Ce que voit l'utilisateur** : la semaine commence le lundi, les heures sont sur 24 h (« 10:30 »), les dates longues s'écrivent « jeudi 17 septembre 2026 », et rien ne reste en anglais.
- **Pourquoi** : une interface française qui affiche « Tuesday, Sep 22 · 11:00 am » paraît inachevée — c'est la friction relevée chez Booker.
- **À vérifier chez nous** : tous les calendriers commencent-ils le lundi ? Une date ou une heure s'affiche-t-elle quelque part au format anglais ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

## Filtres et recherche

### BM-FILTRE-01 — Filtres et recherche réunis en tête de liste

- **Étape** : listes (ventes, clients, rapports) — barre de filtres
- **Ce que voit l'utilisateur** : une seule zone au-dessus de la liste regroupe le champ de recherche et les filtres (période, statut, praticien, moyen de paiement) ; la liste se réduit à chaque choix.
- **Pourquoi** : toute la sélection se lit et se règle au même endroit.
- **À vérifier chez nous** : sur chaque liste du back-office, la recherche et les filtres sont-ils au même endroit, et au même endroit d'une liste à l'autre ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5145-transaction-search
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/347-payment-transactions-article-1
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018125499-How-do-I-reprint-a-client-s-receipt
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941372-verifying-payments

Les filtres propres à chaque écran sont décrits avec lui : BM-VENTE-01,
BM-RAPPORT-01 ([encaissement-reporting.md](encaissement-reporting.md)),
BM-CLIENT-02 ([back-office.md](back-office.md)).

## Comportements communs

### BM-ECRAN-01 — Pendant le chargement, la page a déjà sa forme

- **Étape** : tous les écrans — chargement
- **Ce que voit l'utilisateur** : des blocs gris aux formes des cartes, du récapitulatif et du bouton final, remplacés en place par le contenu.
- **Pourquoi** : l'attente paraît plus courte, et la page ne saute pas à l'affichage.
- **À vérifier chez nous** : un écran lent affiche-t-il un squelette fidèle, ou un indicateur seul puis un saut de mise en page ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-ECRAN-02 — Un bouton répété nomme ce qu'il vise

- **Étape** : tous les écrans — accessibilité
- **Ce que voit l'utilisateur** : (lecteur d'écran) « Sélectionner Evelyn », « Choisir le jeudi 17 septembre », « Modifier : massage 60 min » — pas dix « Sélectionner » identiques.
- **Pourquoi** : un bouton répété n'a de sens que s'il nomme son objet (WCAG 2.4.6).
- **À vérifier chez nous** : dans une liste, les boutons d'action portent-ils un nom accessible qui inclut leur objet ?
- **Sources** :
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-ECRAN-03 — Un changement se voit partout, tout de suite

- **Étape** : tous les écrans — synchronisation
- **Ce que voit l'utilisateur** : un changement de statut recolore aussitôt la carte au planning ; un horaire modifié se retrouve aussitôt dans la réservation en ligne.
- **Pourquoi** : l'accueil, les praticiens et les clientes voient le même état.
- **À vérifier chez nous** : après une action, l'écran se met-il à jour sans rechargement manuel ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/600-update-appointment-statuses
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8443-manage-staff-schedules-and-availability-with-square-appointments

## À confirmer

- **Filtres actifs affichés en pastilles, avec « Réinitialiser »** — une seule
  source (Fresha, au planning). Aucune plateforme ne documente ce motif sur
  les listes.
- **Filtres enregistrés** (Fresha, Square, Boulevard) — au-delà du MVP.
- **Menu principal à gauche, sous-menus par domaine** — une seule source
  (Fresha).
- **États vides d'un back-office** (« aucune vente sur la période », « aucune
  cliente ») — aucune plateforme ne les documente : `ds:etats` les juge sans
  benchmark, contre `.claude/skills/web-frontend/SKILL.md` §6.
- **Montants au format français** (espace insécable, virgule, « € » en
  suffixe) — aucune source de plateforme ; c'est l'usage de
  `Intl.NumberFormat('fr-FR')`, qui n'a pas besoin du benchmark pour faire foi.
