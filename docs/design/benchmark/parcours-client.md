# Benchmark — vitrine et tunnel de réservation

Relevé le 2026-09-16. Écrans concernés : `/[tenantSlug]` (vitrine) et
`/[tenantSlug]/reservation` (tunnel : service → praticien → créneau →
coordonnées → paiement → confirmation). Règles de lecture et de citation :
[README.md](README.md).

Ces motifs ont été **observés** dans le navigateur, à 390 px puis à 1280 px,
sur les pages publiques de cinq plateformes, sans jamais aller au-delà de
l'étape qui précède la saisie des coordonnées :

| Plateforme | Établissement consulté | Pages |
|---|---|---|
| Fresha | La Cour Des Anges, Paris | vitrine `https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3`, tunnel `…/booking` |
| Planity | Studio Beauté, Paris 8e | vitrine `https://www.planity.com/studio-beaute-75008-paris`, tunnel `…/reservation` |
| Treatwell | L-Institut Parisien, Paris 12e | vitrine `https://www.treatwell.fr/salon/l-institut-parisien/`, créneaux et paiement |
| Booker | Rain Wellness Spa | catalogue `https://go.booker.com/location/RainWellnessSpaV2/service-menu`, praticien, créneaux, contact |
| Square | Sun and Moon Massage and Facial Spa | `https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services`, créneaux, paiement |

Vagaro bloque la navigation automatisée ; Mindbody n'a pas été visité. L'écran
de confirmation n'a été atteint nulle part — on ne réserve pas chez un vrai
salon : ses motifs sont documentés.

## Vitrine

### BM-VITRINE-01 — Une identité compacte en tête : nom, adresse, ouverture

- **Étape** : vitrine — en-tête
- **Ce que voit l'utilisateur** : sous la photo ou en tête, le nom du salon en titre principal, puis sur une ou deux lignes l'adresse (cliquable) et l'état d'ouverture ; à 1280 px, tout tient sur une ligne sous le titre.
- **Pourquoi** : la cliente vérifie en un coup d'œil qu'elle est au bon endroit avant de choisir.
- **À vérifier chez nous** : à 360 px, le nom, l'adresse et l'état d'ouverture sont-ils visibles sans défiler ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

La note et le nombre d'avis, affichés au même endroit chez les trois, relèvent
des avis clients : hors MVP.

### BM-VITRINE-02 — L'état d'ouverture est calculé pour maintenant

- **Étape** : vitrine — ouverture
- **Ce que voit l'utilisateur** : une ligne d'état — « Ouvert · ferme à 20:00 », « Ouvert demain : 10:00 - 22:00 » — plutôt qu'un tableau à interpréter.
- **Pourquoi** : la cliente sait tout de suite si elle peut venir, et quand.
- **À vérifier chez nous** : la vitrine dit-elle si le salon est ouvert maintenant, dans le fuseau du salon ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-VITRINE-03 — Les horaires de la semaine, jours fermés écrits

- **Étape** : vitrine — horaires
- **Ce que voit l'utilisateur** : sept lignes « Lundi … 10:00 - 20:00 » ; un jour fermé porte « Fermé » au lieu d'être omis ; le jour courant est mis en évidence.
- **Pourquoi** : la question la plus fréquente trouve sa réponse sans appeler.
- **À vérifier chez nous** : les horaires sont-ils sur la vitrine, jours fermés compris ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/contact

### BM-VITRINE-04 — L'accès à la réservation ne quitte jamais l'écran

- **Étape** : vitrine — appel à l'action
- **Ce que voit l'utilisateur** : à 390 px, une barre collée en bas avec le nombre de prestations et « Réserver » ; à 1280 px, une carte latérale collante qui porte le bouton, l'ouverture et l'adresse ; ou un « Réserver » permanent dans l'en-tête.
- **Pourquoi** : l'action principale reste à portée de pouce, quel que soit le défilement.
- **À vérifier chez nous** : à 360 px, après avoir défilé jusqu'aux horaires, le bouton de réservation est-il encore visible ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/contact

### BM-VITRINE-05 — Le catalogue commence sur la vitrine

- **Étape** : vitrine — prestations
- **Ce que voit l'utilisateur** : la page publique liste déjà des prestations, chacune avec son bouton (« Choisir », « Sélectionner ») ; quelques-unes par catégorie, puis « Voir les 30 autres prestations ».
- **Pourquoi** : l'intention « réserver telle prestation » se déclare dès l'arrivée, sans étape intermédiaire.
- **À vérifier chez nous** : depuis la vitrine, peut-on choisir une prestation directement, ou faut-il d'abord entrer dans le tunnel ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3

### BM-VITRINE-06 — L'équipe se présente : visage ou initiales, prénom, métier

- **Étape** : vitrine — équipe
- **Ce que voit l'utilisateur** : une rangée de portraits ronds avec le prénom et la fonction (« Lila — Esthéticienne »).
- **Pourquoi** : le choix du praticien, plus loin, se prépare ici.
- **À vérifier chez nous** : la vitrine présente-t-elle l'équipe, avec le nom et le métier de chacun ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-VITRINE-07 — L'adresse mène à l'itinéraire

- **Étape** : vitrine — accès
- **Ce que voit l'utilisateur** : un lien « Itinéraire » à côté de l'adresse, ou une carte intégrée qui propose « Obtenir un itinéraire ».
- **Pourquoi** : l'adresse sert à venir, pas seulement à être lue.
- **À vérifier chez nous** : l'adresse de la vitrine ouvre-t-elle la carte du téléphone ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/contact

### BM-VITRINE-08 — La réservation annonce ce qu'elle promet

- **Étape** : vitrine — réassurance
- **Ce que voit l'utilisateur** : près des prestations, une ligne courte — « 24h/24 · Gratuit · Confirmation immédiate ».
- **Pourquoi** : les doutes sur le coût et le délai de confirmation tombent avant le premier clic.
- **À vérifier chez nous** : la vitrine dit-elle que la réservation est immédiate et sans frais de service ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3

## Choix du service

### BM-SERVICE-01 — Une prestation, c'est une ligne : nom, durée, prix, action

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : sur chaque ligne ou carte, le nom, la durée et le prix côte à côte, et un bouton d'action ; aucune photo dans la ligne.
- **Pourquoi** : le prix et la durée ne se découvrent jamais après coup, et la liste reste lisible.
- **À vérifier chez nous** : à 360 px, chaque prestation montre-t-elle sa durée et son prix sans ouvrir de détail ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-SERVICE-02 — Des catégories en onglets défilants, et la liste complète à un geste

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : une rangée horizontale de pastilles de catégories qui défile, et un bouton qui ouvre la liste de toutes les catégories.
- **Pourquoi** : un catalogue de 50 à 150 prestations se parcourt vite sans perdre la vue d'ensemble.
- **À vérifier chez nous** : avec plus de trois catégories, peut-on sauter à l'une d'elles sans défiler tout le catalogue ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-SERVICE-03 — « À partir de » quand le prix dépend d'une option

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : « à partir de 12 € », « 45 min - 1 h » quand le prix ou la durée varient ; un prix exact sinon.
- **Pourquoi** : l'affichage reste honnête quand le montant final dépend d'un choix.
- **À vérifier chez nous** : un prix variable est-il annoncé comme tel ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu

### BM-SERVICE-04 — Une description courte, qui se déplie

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : la description coupée à une ou deux lignes, et « Plus de détails » pour la lire en entier, sur place ou sur une fiche dédiée.
- **Pourquoi** : la liste reste lisible sans cacher l'information.
- **À vérifier chez nous** : une longue description allonge-t-elle la ligne au point de repousser les suivantes ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/detail-summary/4834976
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-SERVICE-05 — Chaque catégorie dit combien elle contient

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : un compteur — « Épilation (3) », « Voir les 30 autres prestations ».
- **Pourquoi** : la cliente sait ce qu'elle ne voit pas encore.
- **À vérifier chez nous** : une catégorie repliée ou tronquée annonce-t-elle son volume ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3

### BM-SERVICE-06 — La prestation choisie se voit sans ambiguïté

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : la carte choisie prend une bordure d'accent et son « + » devient une coche, ou le bouton devient « Sélectionné » ; la catégorie porte aussi la marque.
- **Pourquoi** : le choix est confirmé sur place, sans ouvrir le panier.
- **À vérifier chez nous** : après avoir choisi, la prestation se distingue-t-elle des autres — autrement que par la seule couleur ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-SERVICE-07 — Chaque prestation a son adresse

- **Étape** : tunnel — service
- **Ce que voit l'utilisateur** : une URL stable par prestation, qui ouvre le tunnel sur cette prestation déjà choisie.
- **Pourquoi** : le salon peut partager « réserver un soin visage » en un lien, sur un réseau social ou dans un e-mail.
- **À vérifier chez nous** : peut-on ouvrir le tunnel sur une prestation précise par son URL ?
- **Sources** :
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/detail-summary/4834976
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

Aucune des cinq plateformes n'offre de **recherche plein texte** dans le
catalogue d'un établissement : son absence chez nous n'est pas un écart au
standard.

## Choix du praticien

### BM-PRATICIEN-01 — « Sans préférence » d'abord, avec ce qu'il rapporte

- **Étape** : tunnel — praticien
- **Ce que voit l'utilisateur** : la première option est « Sans préférence » (ou « Premier disponible »), souvent accompagnée de son bénéfice : « le plus de créneaux disponibles » ; c'est parfois la valeur par défaut.
- **Pourquoi** : la cliente est orientée vers le choix qui lui offre le plus d'horaires.
- **À vérifier chez nous** : « premier disponible » est-il en tête, et dit-il pourquoi le choisir ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-PRATICIEN-02 — Un visage, sinon des initiales

- **Étape** : tunnel — praticien
- **Ce que voit l'utilisateur** : un portrait rond quand il existe, sinon un disque portant les initiales.
- **Pourquoi** : la liste reste homogène même sans photo.
- **À vérifier chez nous** : un praticien sans photo a-t-il un repère visuel équivalent aux autres ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking

### BM-PRATICIEN-03 — Le prénom, et le métier en dessous

- **Étape** : tunnel — praticien
- **Ce que voit l'utilisateur** : le praticien est désigné par son prénom, sa fonction en gris dessous ; le salon choisit ce qui s'affiche.
- **Pourquoi** : le choix est humain sans exposer l'identité complète de l'équipe.
- **À vérifier chez nous** : le tunnel affiche-t-il un nom complet là où le prénom suffirait ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · documenté · 2026-09-16 · https://support.mindbodyonline.com/s/article/Online-Booking-Settings-V1-Accounts?language=en_US

### BM-PRATICIEN-04 — Le praticien se change depuis l'étape des créneaux

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : au-dessus du calendrier, un sélecteur « Sans préférence ⌄ » ; changer de praticien recalcule les créneaux sur place.
- **Pourquoi** : la cliente arbitre entre praticien et horaire sans revenir en arrière.
- **À vérifier chez nous** : pour essayer un autre praticien, faut-il revenir une étape en arrière ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation

### BM-PRATICIEN-05 — Le praticien retenu est rappelé jusqu'au paiement

- **Étape** : tunnel — récapitulatif
- **Ce que voit l'utilisateur** : sous la prestation, « avec Mégane » ou « avec le premier praticien disponible », et un lien pour le modifier.
- **Pourquoi** : le choix reste vérifiable et corrigeable jusqu'au bout.
- **À vérifier chez nous** : le récapitulatif nomme-t-il le praticien, y compris quand c'est « premier disponible » ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

## Choix du créneau

### BM-CRENEAU-01 — Une rangée de jours, puis les horaires du jour choisi

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : une rangée de jours défilante (jour abrégé, numéro, mois) avec des flèches ; le calendrier du mois complet s'ouvre à la demande ; sous la rangée, les seuls horaires du jour sélectionné.
- **Pourquoi** : les jours proches sont immédiats, une date lointaine reste accessible, et la liste d'horaires reste courte.
- **À vérifier chez nous** : à 360 px, choisit-on un jour avant de voir des horaires ? Le mois complet est-il accessible ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu

### BM-CRENEAU-02 — Le premier jour disponible est déjà sélectionné

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : à l'ouverture, le premier jour qui a des créneaux est sélectionné, parfois signalé (« 1re date disponible »).
- **Pourquoi** : la cliente ne tombe jamais sur un écran vide au premier affichage.
- **À vérifier chez nous** : si aujourd'hui est complet, l'étape s'ouvre-t-elle sur un jour vide ?
- **Sources** :
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking

### BM-CRENEAU-03 — Un jour complet propose d'aller au prochain jour libre

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : « Complet ce jour-là — prochain créneau jeudi 17 septembre », et un bouton qui y mène.
- **Pourquoi** : un jour plein devient une piste plutôt qu'une impasse.
- **À vérifier chez nous** : un jour sans créneau dit-il où est le prochain, avec un bouton pour y aller ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-CRENEAU-04 — Les jours impossibles sont visibles et inactifs

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : les jours passés, fermés, complets ou au-delà de l'horizon de réservation sont grisés ou barrés et ne se sélectionnent pas ; le jour courant est cerclé.
- **Pourquoi** : la cliente ne clique pas pour rien.
- **À vérifier chez nous** : un jour de fermeture est-il distinguable — autrement que par la seule couleur — avant d'être cliqué ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation

### BM-CRENEAU-05 — Les horaires se rangent par moment de la journée

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : les horaires groupés sous « Matin », « Après-midi », « Soir » (trois colonnes à 1280 px) ; une période sans horaire le dit.
- **Pourquoi** : on repère plus vite « un créneau en fin de journée » que dans une longue liste chronologique.
- **À vérifier chez nous** : une journée chargée produit-elle une liste d'horaires qu'il faut longuement défiler ?
- **Sources** :
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-CRENEAU-06 — Un horaire est un bouton large, et se dit comme tel

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : des pavés d'horaire de bonne taille, en grille de trois ou en rangées pleine largeur ; pour un lecteur d'écran, un groupe d'options nommé (« Horaires disponibles, après-midi »).
- **Pourquoi** : la sélection est facile au pouce et annoncée aux technologies d'assistance.
- **À vérifier chez nous** : les horaires se touchent-ils sans viser, et le groupe est-il nommé ?
- **Sources** :
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu

### BM-CRENEAU-07 — Une fois l'horaire choisi : date, heure et durée totale

- **Étape** : tunnel — créneau choisi
- **Ce que voit l'utilisateur** : en grand, « 10:30 · jeu. 17 sept. · 15 min au total », ou l'heure de début et de fin, avec « Modifier ».
- **Pourquoi** : la cliente sait combien de temps bloquer, et peut corriger.
- **À vérifier chez nous** : après le choix, la durée totale ou l'heure de fin est-elle affichée ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-CRENEAU-08 — Trop tôt ou trop loin : le calendrier le montre

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : les créneaux trop proches ne sont pas proposés et la cliente est invitée à appeler ; les dates au-delà de l'horizon de réservation sont inactives.
- **Pourquoi** : le planning du salon est protégé, et la cliente comprend pourquoi un créneau manque.
- **À vérifier chez nous** : le délai minimal de réservation est-il dit, ou les créneaux manquent-ils sans explication ?
- **Sources** :
  - Booker · documenté · 2026-09-16 · https://support.mindbodyonline.com/s/article/Online-Booking-Settings-V1-Accounts?language=en_US
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking

## Récapitulatif, coordonnées et paiement

### BM-TUNNEL-01 — L'étape finale s'ouvre sur un récapitulatif complet, corrigeable

- **Étape** : tunnel — récapitulatif
- **Ce que voit l'utilisateur** : en tête, l'établissement, la date, l'heure, la durée, la prestation, le praticien et le prix, chaque élément avec « Modifier ».
- **Pourquoi** : dernière vérification avant de s'engager, et correction sans repartir de zéro.
- **À vérifier chez nous** : le récapitulatif réunit-il ces sept informations, et chacune se corrige-t-elle sans perdre les autres ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/online-presence/101646-learn-how-clients-book-appointments-online

### BM-TUNNEL-02 — La conséquence d'une annulation est calculée pour ce rendez-vous

- **Étape** : tunnel — paiement
- **Ce que voit l'utilisateur** : en plus de la politique générale, un encadré dit ce qu'elle implique **pour ce rendez-vous-ci** : « Si vous annulez maintenant, vous ne serez pas remboursée » pour un rendez-vous à moins de 24 h.
- **Pourquoi** : la règle abstraite devient une conséquence concrète avant l'engagement.
- **À vérifier chez nous** : pour un créneau déjà dans la période d'annulation tardive, le tunnel le dit-il avant de payer ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242

Voir aussi BM-ANNUL-01 ([espace-client.md](espace-client.md)) : la politique
elle-même, visible avant de réserver.

### BM-TUNNEL-03 — Des coordonnées réduites au nécessaire, et leur usage dit

- **Étape** : tunnel — coordonnées
- **Ce que voit l'utilisateur** : nom, e-mail, téléphone (avec l'indicatif du pays), et une phrase qui dit à quoi sert le téléphone (confirmation et rappel par SMS).
- **Pourquoi** : de quoi confirmer et rappeler, rien de plus.
- **À vérifier chez nous** : le formulaire demande-t-il plus que nom, e-mail et téléphone ? Dit-il pourquoi le téléphone ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-TUNNEL-04 — Les champs de carte viennent du prestataire, et le disent

- **Étape** : tunnel — paiement
- **Ce que voit l'utilisateur** : les champs numéro, date et code sont intégrés depuis le prestataire de paiement, avec une mention de réassurance (« Paiement sécurisé par … ») et un bouclier.
- **Pourquoi** : aucune donnée de carte ne transite par le site du salon, et la cliente le sait.
- **À vérifier chez nous** : le paiement dit-il qu'il est traité par Stripe et sécurisé ? (La tokenisation côté client est déjà imposée par la contrainte n° 3 du `CLAUDE.md` et la skill `payments-stripe`.)
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-TUNNEL-05 — Ce qui est dû maintenant, et ce qui le sera sur place

- **Étape** : tunnel — paiement
- **Ce que voit l'utilisateur** : sous le total, « À payer maintenant : 0,00 € » et « À régler au salon : 70,00 € » ; le bouton final reprend le montant immédiat.
- **Pourquoi** : la cliente sait ce qui sera débité tout de suite.
- **À vérifier chez nous** : l'écran distingue-t-il le montant prélevé maintenant du montant réglé au salon ?
- **Sources** :
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/payments/613-payments-policies-overview

### BM-TUNNEL-06 — Les consentements sont séparés et décochés

- **Étape** : tunnel — coordonnées
- **Ce que voit l'utilisateur** : toute case facultative (communications, enregistrement de la carte) est décochée par défaut, séparée de l'acceptation des conditions de réservation, avec un lien vers la politique de confidentialité.
- **Pourquoi** : le consentement est libre et distinct de la réservation (RGPD).
- **À vérifier chez nous** : une case pré-cochée ou fondue dans le bouton de réservation existe-t-elle ?
- **Sources** :
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

## Le tunnel dans son ensemble

### BM-TUNNEL-07 — Le récapitulatif suit la cliente : colonne à 1280 px, barre basse à 390 px

- **Étape** : tunnel — toutes les étapes
- **Ce que voit l'utilisateur** : à 1280 px, une carte collante à droite (prestations, praticien, total, « Continuer ») ; à 390 px, une barre collée en bas (« 33 € · 1 prestation · 30 min » et « Continuer ») qui se déplie en détail.
- **Pourquoi** : le panier et le total restent visibles à chaque étape, et l'action suivante est sous le pouce.
- **À vérifier chez nous** : à 360 px, le total et le bouton « Continuer » sont-ils visibles sans défiler, à chaque étape ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-TUNNEL-08 — Un rechargement ne perd rien

- **Étape** : tunnel — toutes les étapes
- **Ce que voit l'utilisateur** : en rechargeant la page ou en rouvrant son URL, la cliente retrouve la même étape avec les mêmes choix (prestation, praticien, jour).
- **Pourquoi** : ni un rafraîchissement ni un lien partagé ne font repartir de zéro. La skill `web-frontend` §3 l'exige aussi.
- **À vérifier chez nous** : F5 à l'étape créneau ramène-t-il au même endroit ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu

### BM-TUNNEL-09 — La progression est visible

- **Étape** : tunnel — toutes les étapes
- **Ce que voit l'utilisateur** : un fil d'étapes (« Prestation › Praticien › Horaire › Confirmation ») dont l'étape courante ressort, ou des sections numérotées « 1. Prestation · 2. Date et heure · 3. Identification ».
- **Pourquoi** : la cliente sait combien il reste à faire. Fresha perd ce fil à 390 px : c'est la variante à ne pas reprendre.
- **À vérifier chez nous** : à 360 px, la cliente sait-elle à quelle étape elle est, et combien il en reste ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation

### BM-TUNNEL-10 — Dans le tunnel, l'en-tête se réduit à revenir et sortir

- **Étape** : tunnel — en-tête
- **Ce que voit l'utilisateur** : la navigation du site disparaît au profit d'un « ← » (étape précédente) et d'un « × » (quitter), en cibles tactiles larges ; le titre de l'étape reste lisible.
- **Pourquoi** : l'attention reste sur la réservation, et la sortie est claire.
- **À vérifier chez nous** : le tunnel propose-t-il un retour à l'étape précédente distinct de la sortie ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/

### BM-TUNNEL-11 — Chaque étape a pour titre ce qu'on attend de la cliente

- **Étape** : tunnel — titres
- **Ce que voit l'utilisateur** : un grand titre par écran, formulé comme une action : « Choisissez une prestation », « Choisissez un horaire », « Finaliser ».
- **Pourquoi** : chaque écran dit ce qu'il demande.
- **À vérifier chez nous** : chaque étape a-t-elle un titre d'action visible en haut ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Treatwell · observé · 2026-09-16 · https://www.treatwell.fr/salon/l-institut-parisien/
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu
  - Square · observé · 2026-09-16 · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services

### BM-TUNNEL-12 — Sur mobile, les choix secondaires montent du bas

- **Étape** : tunnel — mobile
- **Ce que voit l'utilisateur** : à 390 px, la liste des catégories, le détail du prix ou le calendrier du mois s'ouvrent en feuille depuis le bas, avec « × » et un bouton de validation.
- **Pourquoi** : le contexte reste dessous, et les contrôles sont sous le pouce.
- **À vérifier chez nous** : à 360 px, les choix secondaires ouvrent-ils une nouvelle page, ou une feuille qui garde le contexte ?
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3/booking
  - Planity · observé · 2026-09-16 · https://www.planity.com/studio-beaute-75008-paris/reservation
  - Booker · observé · 2026-09-16 · https://go.booker.com/location/RainWellnessSpaV2/service-menu

## Confirmation

### BM-CONFIRM-01 — La confirmation écrite part aussitôt, avec de quoi gérer le rendez-vous

- **Étape** : confirmation
- **Ce que voit l'utilisateur** : juste après la réservation, un e-mail (et un SMS chez certains) qui récapitule le rendez-vous et porte le lien pour le déplacer ou l'annuler.
- **Pourquoi** : preuve de réservation, et point d'entrée unique pour la suite.
- **À vérifier chez nous** : l'écran de confirmation annonce-t-il l'e-mail envoyé ? Donne-t-il le chemin vers le rendez-vous ?
- **Sources** :
  - Planity · documenté · 2026-09-16 · https://www.planity.com/
  - Treatwell · documenté · 2026-09-16 · https://www.treatwell.fr/info/reservation-termes-et-conditions/
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/online-presence/101646-learn-how-clients-book-appointments-online

Aucun écran de confirmation n'a été observé (on ne réserve pas chez un vrai
salon). Voir aussi BM-NOTIF-01, BM-NOTIF-02 et BM-RDV-03
([espace-client.md](espace-client.md)).

## Vu, mais sans identifiant

- **Galerie photo en tête de vitrine**, avec compteur (Fresha, Planity,
  Treatwell — observé). C'est ce qui rend une vitrine « attirante », mais la
  gestion des photos par le salon n'est pas listée au CDC §1.4 : à soumettre à
  `mvp-scope-guard` avant tout ticket.
- **Ajouter une autre prestation** au même rendez-vous (Planity, Booker,
  Square, Treatwell) — le rendez-vous multi-prestations n'est pas cité au
  périmètre.
- **Réservation en ligne ou compte obligatoire** — le marché est partagé :
  invité chez Treatwell et Square, compte obligatoire chez Planity, Booker et
  Fresha. Ce n'est pas un standard.
- **Empreinte de carte** pour garantir le rendez-vous (Square observé ; Booker,
  Fresha, Boulevard documentés) — non listée au CDC.
- **Note libre pour le salon** dans le tunnel (Square observé ; Fresha, Booker
  documentés) — non listée.
- **Réservation soumise à validation** du salon (Booker, Square) — le MVP vise
  la réservation temps réel.
- **Note explicative sous une catégorie** (Fresha, Planity) — champ que le
  catalogue ne porte pas.

Motifs vus sur une seule plateforme, donc sans identifiant : fuseau horaire
affiché avec les créneaux (Square — l'ADR 0006 couvre déjà la question),
créneau retenu pendant le paiement avec sa durée (Square), jours disponibles
seuls, en accordéon (Planity), repli téléphone sous les créneaux (Booker),
« Continuer » inactif tant que rien n'est choisi (Fresha), changement d'étape
annoncé aux lecteurs d'écran (Fresha).

## Frictions relevées chez les références

À ne pas reproduire :

- **Booker** : après le choix du créneau, redirection vers la connexion **sans
  rappel du créneau choisi** ; libellés en français mais dates et heures en
  anglais (« Tuesday, Sep 22 », « 11:00 am ») ; bouton retour sans nom
  accessible.
- **Fresha** : le fil de progression disparaît à 390 px ; un écran « Choisir
  une option » (rendez-vous, forfait, carte cadeau…) s'intercale avant le
  catalogue ; créneaux toutes les 5 minutes en rangées pleine largeur, d'où une
  liste interminable sur mobile.
- **Planity** : une fenêtre d'informations du salon s'intercale entre le
  créneau et l'identification ; créneaux et onglets exposés sans rôle
  sémantique.
- **Treatwell** : le premier niveau du bandeau cookies n'offre pas de refus ;
  un jour complet propose des **salons concurrents** à proximité — un motif de
  place de marché, contraire à une page de réservation à l'enseigne d'un salon.
- **Square** : la rangée de jours commence le dimanche et le mois le lundi ; un
  bouton flottant « Text us » recouvre un contrôle.
- **Quatre sur cinq n'affichent aucun fuseau horaire** — c'est un risque dès
  que la cliente n'est pas dans le fuseau du salon (ADR 0006).
