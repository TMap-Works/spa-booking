# Benchmark — back-office du gérant et de l'accueil

Relevé le 2026-09-16. Écrans concernés : sous `/[tenantSlug]/admin/` —
`calendrier`, `clients`, `catalogue` (et `nouveau`, `rubriques`, `apercu`,
`[serviceId]`), `personnel` (et `[staffId]`), `reglages`, et l'écran d'arrivée
du gérant pour les motifs de tableau de bord. L'encaissement et le reporting
sont dans [encaissement-reporting.md](encaissement-reporting.md). Règles de
lecture et de citation : [README.md](README.md).

Les back-offices sont privés : **rien ici n'est observé**. Les motifs reposent
sur les centres d'aide de Boulevard, Fresha, Square et Phorest (lus
directement), complétés par Vagaro, Timely, Booker, Zenoti et GlossGenius
(`extrait` : l'article n'a pu être lu que par l'extrait du moteur de
recherche). Ils décrivent ce qu'un écran fait et dans quel ordre ; la
finition visuelle d'un back-office ne se documente nulle part.

## Tableau de bord

### BM-DASH-01 — Les chiffres du jour en cartes : revenu, rendez-vous, absences

- **Étape** : tableau de bord — indicateurs
- **Ce que voit l'utilisateur** : une rangée de cartes en tête — revenu, nombre de rendez-vous, et à côté, les absences (no-shows) — lisibles sans ouvrir de rapport.
- **Pourquoi** : « comment se passe la journée ? » a sa réponse en une seconde, et le revenu se lit à côté de ce qui le produit.
- **À vérifier chez nous** : en arrivant, le gérant voit-il le revenu, le volume de rendez-vous et les absences du jour sans chercher ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/ca/en/article/5618-get-started-with-the-square-dashboard-app
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/100652-access-your-performance-insights
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/1500002201662-Using-the-Business-overview-on-your-Timely-Dashboard
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/12731739712667-Dashboard-Reports

### BM-DASH-02 — « Aujourd'hui » par défaut, les autres périodes à un clic

- **Étape** : tableau de bord — période
- **Ce que voit l'utilisateur** : le tableau s'ouvre sur aujourd'hui ; « Hier », « Semaine », « Mois » se choisissent d'un geste.
- **Pourquoi** : la question la plus fréquente a sa réponse par défaut.
- **À vérifier chez nous** : la synthèse s'ouvre-t-elle sur la journée en cours, dans le fuseau du salon ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/100652-access-your-performance-insights
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/7541672247698-What-is-the-Insights-dashboard-and-how-do-I-use-it

### BM-DASH-03 — Une carte mène au détail qu'elle résume

- **Étape** : tableau de bord — exploration
- **Ce que voit l'utilisateur** : un clic sur une carte ouvre le rapport ou la liste correspondante — le nombre d'absences mène aux rendez-vous concernés.
- **Pourquoi** : on passe du « combien » au « lesquels » sans chercher le bon écran.
- **À vérifier chez nous** : les chiffres de la synthèse sont-ils des portes vers le détail, ou des impasses ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/7541672247698-What-is-the-Insights-dashboard-and-how-do-I-use-it
  - Square · annoncé · 2026-09-16 · https://community.squareup.com/t5/Product-Updates/The-Dashboard-home-page-now-has-widgets/ba-p/679368
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/12731739712667-Dashboard-Reports

### BM-DASH-04 — Les chiffres ne s'affichent qu'à qui a le droit de les voir

- **Étape** : tableau de bord — droits
- **Ce que voit l'utilisateur** : sans le droit « reporting », l'entrée n'apparaît pas ; voir les chiffres des collègues demande un droit séparé.
- **Pourquoi** : un praticien ne voit ni le chiffre d'affaires du salon ni celui de ses collègues — et ne rencontre pas de lien qui mène à un refus.
- **À vérifier chez nous** : un praticien connecté voit-il une entrée « Reporting » qu'il ne peut pas ouvrir ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/100652-access-your-performance-insights
  - Booker · extrait · 2026-09-16 · https://support.mindbodyonline.com/s/article/I-cant-see-the-Reports-tab?language=en_US
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/12731739712667-Dashboard-Reports

## Planning

### BM-AGENDA-01 — Jour ou semaine, dans la barre d'outils du planning

- **Étape** : planning — vues
- **Ce que voit l'utilisateur** : un sélecteur « Jour / Semaine » dans la barre d'outils, à côté de la navigation de date ; la vue change sans quitter l'écran.
- **Pourquoi** : on passe du détail de la journée à la charge de la semaine en un geste.
- **À vérifier chez nous** : le passage jour ↔ semaine est-il dans la barre d'outils, près de la date ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/16-manage-your-calendar-display-settings-
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941397-using-the-calendar-view
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8442-set-up-calendar-view-filters-for-appointments
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360054177294-Switch-to-Calendar-Day-Week-Month-or-Agenda-View

Les vues mois et multi-jours existent aussi chez toutes ; le CDC §1.4 s'en
tient au jour et à la semaine.

### BM-AGENDA-02 — Une colonne par praticien, reconnaissable à son en-tête

- **Étape** : planning — vue jour
- **Ce que voit l'utilisateur** : en vue jour, une colonne par praticien, dont l'en-tête porte sa photo (ou ses initiales) et son nom, dans un ordre stable que le salon choisit.
- **Pourquoi** : l'accueil repère un praticien sans lire, et retrouve toujours les colonnes au même endroit.
- **À vérifier chez nous** : l'en-tête de colonne identifie-t-il le praticien d'un coup d'œil ? L'ordre est-il stable d'un jour à l'autre ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8442-set-up-calendar-view-filters-for-appointments
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/16-manage-your-calendar-display-settings-
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360017375960
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/20574085784855-Explore-our-new-calendar

### BM-AGENDA-03 — Seuls les praticiens en service ont une colonne, par défaut

- **Étape** : planning — vue jour
- **Ce que voit l'utilisateur** : un sélecteur « Équipe en service / Toute l'équipe », réglé par défaut sur l'équipe du jour.
- **Pourquoi** : pas de colonnes vides pour les absents.
- **À vérifier chez nous** : un praticien en repos occupe-t-il une colonne vide ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/16-manage-your-calendar-display-settings-
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941397-using-the-calendar-view
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8442-set-up-calendar-view-filters-for-appointments
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360017375960

### BM-AGENDA-04 — Le statut d'un rendez-vous se lit sur sa carte

- **Étape** : planning — cartes
- **Ce que voit l'utilisateur** : la carte change d'apparence selon le statut — réservé, arrivé, terminé, absent, réglé — par la couleur **et** par un pictogramme ou un motif (coche « confirmé », hachures « non confirmé », « $ » réglé).
- **Pourquoi** : absents, arrivés et non réglés se repèrent sans ouvrir les rendez-vous.
- **À vérifier chez nous** : sans ouvrir la carte, distingue-t-on un rendez-vous terminé d'un rendez-vous à venir — sans dépendre de la seule couleur (WCAG 1.4.1) ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/487-organize-appointments-by-color-in-your-calendar
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016457700-What-do-each-of-the-appointment-colors-mean
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941417-appointment-status-icons
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8442-set-up-calendar-view-filters-for-appointments
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/28544779074971-Service-Appointment-Statuses-Colors

### BM-AGENDA-05 — La légende des couleurs est dans le planning

- **Étape** : planning — légende
- **Ce que voit l'utilisateur** : une icône dans la barre du planning ouvre la légende des couleurs et des pictogrammes.
- **Pourquoi** : un nouvel employé décode le planning sans formation.
- **À vérifier chez nous** : la signification des couleurs du planning est-elle écrite quelque part à l'écran ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/4403393625490
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/204347590-Calendar-Icons-and-Appointment-Status-Colors-Legend

### BM-AGENDA-06 — Une ligne marque l'heure qu'il est

- **Étape** : planning — heure courante
- **Ce que voit l'utilisateur** : une ligne colorée traverse la grille à l'heure actuelle, et la grille s'ouvre à cette hauteur.
- **Pourquoi** : on situe « maintenant » et on repère les rendez-vous en retard. Booker consacre un article de dépannage à une ligne qui affiche la mauvaise heure : elle doit suivre le fuseau du salon (ADR 0006).
- **À vérifier chez nous** : la vue jour d'aujourd'hui montre-t-elle l'heure courante, et s'ouvre-t-elle dessus ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/4403366116370
  - Zenoti · documenté · 2026-09-16 · https://help.zenoti.com/en/configuration/appointments-configurations/personalization/interface/automatically-scroll-appointment-book-to-current-center-time.html
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/academy/run-your-business/master-your-calendar/lessons/100067
  - Booker · extrait · 2026-09-16 · https://support.mindbodyonline.com/s/article/Appointment-Troubleshooting-FAQs?language=en_US

### BM-AGENDA-07 — Un clic sur une case libre crée à cet endroit

- **Étape** : planning — création
- **Ce que voit l'utilisateur** : un clic sur une case vide de la colonne d'un praticien propose « Nouveau rendez-vous » ou « Bloquer ce créneau », avec la date, l'heure et le praticien déjà remplis.
- **Pourquoi** : la case choisie fait la moitié de la saisie.
- **À vérifier chez nous** : cliquer une case libre ouvre-t-il la création pré-remplie ? Existe-t-il un équivalent au clavier ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941397-using-the-calendar-view
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016402419
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/16-manage-your-calendar-display-settings-
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5349-schedule-and-accept-appointments

### BM-AGENDA-08 — Un bouton « Nouveau » toujours présent

- **Étape** : planning — création
- **Ce que voit l'utilisateur** : un bouton permanent dans la barre du planning (« Nouveau rendez-vous », « Créer ») qui ouvre la création sans viser de case.
- **Pourquoi** : on crée un rendez-vous hors de la vue affichée, ou sans souris.
- **À vérifier chez nous** : la création est-elle possible autrement qu'en cliquant dans la grille ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941381-adding-new-appointments
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5349-schedule-and-accept-appointments
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/576-create-and-manage-blocked-time-in-your-calendar
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360010188414-Book-a-Single-Appointment-for-a-Customer

### BM-AGENDA-09 — Un clic sur un rendez-vous ouvre un aperçu, avec les actions que permet son statut

- **Étape** : planning — détail
- **Ce que voit l'utilisateur** : sans quitter le planning, un panneau montre la cliente et son téléphone, l'horaire, la prestation, le praticien, le prix, qui a réservé et quand, les notes ; ses actions — déplacer, annuler, changer le statut, encaisser — dépendent du statut.
- **Pourquoi** : les gestes courants du comptoir se font en deux clics, et seuls les gestes possibles sont offerts.
- **À vérifier chez nous** : l'aperçu propose-t-il des actions impossibles pour ce statut (encaisser un rendez-vous déjà réglé, annuler un rendez-vous terminé) ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941373-appointment-preview-window
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/600-update-appointment-statuses
  - Zenoti · extrait · 2026-09-16 · https://help.zenoti.com/en/appointments/new-features-in-appointment-book-v2.html
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/27844504079127-A-quick-guide-to-the-Timely-calendar

### BM-AGENDA-10 — Glisser un rendez-vous montre le changement avant de l'appliquer

- **Étape** : planning — déplacement
- **Ce que voit l'utilisateur** : on glisse une carte vers une autre heure ou une autre colonne ; avant l'enregistrement, un récapitulatif « de … à … » demande confirmation et propose de prévenir la cliente. Un déplacement lointain passe par l'édition du rendez-vous.
- **Pourquoi** : replanifier vite, sans déplacement accidentel. Chez nous, la validation repasse par le verrou transactionnel (ADR 0002).
- **À vérifier chez nous** : le déplacement demande-t-il confirmation en nommant l'ancien et le nouvel horaire ? Existe-t-il un chemin sans glisser-déposer ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/6950738-rescheduling-appointments
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360017434319
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/27844504079127-A-quick-guide-to-the-Timely-calendar

### BM-AGENDA-11 — Un rendez-vous annulé quitte la grille, pas l'écran

- **Étape** : planning — annulations
- **Ce que voit l'utilisateur** : l'annulé disparaît de la grille, mais une liste « Annulations récentes » (ou un interrupteur « Afficher les annulés ») le retrouve.
- **Pourquoi** : la grille reste lisible, et une annulation faite par erreur se retrouve.
- **À vérifier chez nous** : un rendez-vous annulé encombre-t-il la grille, ou disparaît-il sans trace retrouvable ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941422-cancelled-appointments-list
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8442-set-up-calendar-view-filters-for-appointments
  - Zenoti · extrait · 2026-09-16 · https://help.zenoti.com/en/collections/80253-appointment-book

### BM-AGENDA-12 — Bloquer un créneau : motif, durée, répétition

- **Étape** : planning — plages bloquées
- **Ce que voit l'utilisateur** : un formulaire court — motif (liste ou libellé), durée, praticien, répétition — et la plage apparaît dans la colonne ; en ligne, le créneau devient simplement indisponible, sans en dire la raison.
- **Pourquoi** : pauses et formations se saisissent une fois, et la vie privée de l'équipe est préservée.
- **À vérifier chez nous** : une plage bloquée porte-t-elle son motif au planning, et reste-t-il interne ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/18-set-up-and-manage-blocked-time
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941379-time-blocks
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016476479
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360010603213-Schedule-Personal-Tasks-and-Closures-on-the-Calendar

## Rendez-vous créé au comptoir

### BM-COMPTOIR-01 — Cliente, puis prestations, puis créneau, sur un seul écran

- **Étape** : création au comptoir — enchaînement
- **Ce que voit l'utilisateur** : un seul panneau ou écran qui enchaîne le choix de la cliente, des prestations, puis de la date et de l'heure.
- **Pourquoi** : l'ordre suit la conversation au comptoir ou au téléphone.
- **À vérifier chez nous** : la création au comptoir suit-elle cet ordre, sans changer d'écran ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5349-schedule-and-accept-appointments
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016402419
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/25-create-appointments-1
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360010188414-Book-a-Single-Appointment-for-a-Customer

### BM-COMPTOIR-02 — La cliente se trouve à la frappe, ou se crée sur place

- **Étape** : création au comptoir — cliente
- **Ce que voit l'utilisateur** : un champ qui propose les fiches correspondantes dès les premières lettres (nom, téléphone) ; sans correspondance, « + Nouvelle cliente » crée la fiche sans quitter la création.
- **Pourquoi** : l'accueil n'abandonne jamais la création pour aller créer une fiche.
- **À vérifier chez nous** : peut-on créer une nouvelle cliente depuis la création du rendez-vous ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016402419
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/1500002255662-How-to-add-an-appointment-in-your-Timely-calendar
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360010188414-Book-a-Single-Appointment-for-a-Customer
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/25-create-appointments-1

### BM-COMPTOIR-03 — Les créneaux libres sont proposés, pas une heure à taper

- **Étape** : création au comptoir — créneau
- **Ce que voit l'utilisateur** : pour les prestations et le praticien choisis, la liste des créneaux réellement disponibles, calculée comme pour la réservation en ligne.
- **Pourquoi** : l'accueil ne propose jamais une heure impossible.
- **À vérifier chez nous** : la création au comptoir montre-t-elle les créneaux libres, ou demande-t-elle une heure à saisir ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5349-schedule-and-accept-appointments
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/19064238634642
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941381-adding-new-appointments

### BM-COMPTOIR-04 — Un conflit se nomme

- **Étape** : création au comptoir — conflits
- **Ce que voit l'utilisateur** : avant l'enregistrement, un message qui dit **quel** conflit : « Mégane a déjà un rendez-vous à cette heure », « Mégane ne travaille pas ce jour-là », « Mégane ne réalise pas cette prestation ».
- **Pourquoi** : l'accueil comprend pourquoi le créneau pose problème et sait quoi changer. Les références laissent ensuite forcer la double réservation ; **nous non** (ADR 0002) : on reprend les messages nommés, pas la possibilité de forcer.
- **À vérifier chez nous** : un refus pour conflit dit-il lequel, ou affiche-t-il une erreur générique ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/25305084483090-How-can-I-control-which-prompts-appear-on-my-Appointments-calendar
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5349-schedule-and-accept-appointments
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/204347690-Double-Book-Time-Slots-on-the-Calendar

### BM-COMPTOIR-05 — L'alerte de la fiche s'affiche au moment de réserver

- **Étape** : création au comptoir — alertes
- **Ce que voit l'utilisateur** : dès que la cliente est choisie, sa note d'alerte (allergie, restriction) s'affiche en bandeau dans la création et dans l'aperçu du rendez-vous.
- **Pourquoi** : l'information critique est lue avant le soin, pas découverte dans la fiche.
- **À vérifier chez nous** : une note importante de la fiche est-elle visible depuis le rendez-vous ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941470-scheduling-alerts
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360007906613-Manage-Customer-Notes
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/clients/54-add-staff-alerts-to-client-profiles
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/360062557153-How-to-add-alerts-to-customer-records

### BM-COMPTOIR-06 — Annuler ou déplacer demande un motif, et si l'on prévient la cliente

- **Étape** : annulation et déplacement au comptoir
- **Ce que voit l'utilisateur** : un motif à choisir (erreur de saisie, annulé par la cliente, par le salon, annulation tardive, absence) et une case « Prévenir la cliente ».
- **Pourquoi** : les annulations deviennent analysables, et la cliente n'est pas alertée pour une simple correction.
- **À vérifier chez nous** : l'annulation au comptoir demande-t-elle un motif ? L'accueil choisit-il de notifier ou non ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941385-canceling-appointments
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/545-manage-cancellation-reasons
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5349-schedule-and-accept-appointments

### BM-COMPTOIR-07 — « Comme la dernière fois » se réserve depuis l'historique

- **Étape** : création au comptoir — reprise
- **Ce que voit l'utilisateur** : depuis la fiche cliente ou la création, l'historique des rendez-vous propose de reprendre une prestation passée.
- **Pourquoi** : le rendez-vous le plus fréquent — le même que la fois précédente — se crée en un clic.
- **À vérifier chez nous** : depuis la fiche d'une cliente, peut-on reprendre un rendez-vous passé ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016402419
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941381-adding-new-appointments

## Clients

### BM-CLIENT-01 — On retrouve une cliente avec ce qu'elle dicte

- **Étape** : clients — recherche
- **Ce que voit l'utilisateur** : un champ qui cherche à la fois sur le nom, l'e-mail et le téléphone, et accepte une partie de la valeur ; le résultat mène à la fiche ou à un nouveau rendez-vous.
- **Pourquoi** : au téléphone, la cliente donne son nom ou son numéro, rarement les deux.
- **À vérifier chez nous** : la recherche trouve-t-elle une cliente par une partie de son numéro de téléphone ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941429-global-search-bar
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360007538953-Customer-List-Report-Search-Filter-Options

### BM-CLIENT-02 — Des filtres qui se combinent, et le nombre de résultats

- **Étape** : clients — filtres
- **Ce que voit l'utilisateur** : « + Ajouter un filtre » — dernière visite, prestation reçue, nombre de rendez-vous, absences — ; les filtres se combinent, et le nombre de clientes correspondantes s'affiche.
- **Pourquoi** : répondre à « qui n'est pas revenu depuis deux mois ? » sans tableur.
- **À vérifier chez nous** : la liste des clients se filtre-t-elle au moins par dernière visite, et dit-elle combien de fiches correspondent ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6245-manage-customer-groups-and-filters
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/9077071-clients-audiences
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360007538953-Customer-List-Report-Search-Filter-Options

Les critères marketing (consentement aux campagnes, adhésion, achats de
produits) sont hors MVP.

### BM-CLIENT-03 — La fiche s'ouvre sur ce qui qualifie la cliente

- **Étape** : clients — fiche
- **Ce que voit l'utilisateur** : en tête de fiche, quelques chiffres — nombre de rendez-vous, absences et annulations, dernière visite, prochain rendez-vous.
- **Pourquoi** : la fiabilité et l'habitude de la cliente se lisent avant d'accepter un rendez-vous.
- **À vérifier chez nous** : la fiche cliente montre-t-elle ses absences et son prochain rendez-vous sans défiler ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941460-client-profiles
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/115004392674-Manage-Customer-Profiles
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/28876456656151-See-a-client-s-no-show-history
  - Zenoti · extrait · 2026-09-16 · https://help.zenoti.com/en/appointments/manage-guest-experience/redesigned-guest-profile.html

### BM-CLIENT-04 — Des notes datées, qui distinguent l'utile au soin

- **Étape** : clients — notes
- **Ce que voit l'utilisateur** : chaque note porte sa date ; les notes de soin (allergie, formule) sont distinctes des préférences générales.
- **Pourquoi** : l'information utile au soin n'est pas noyée dans les préférences, et l'on sait si elle est récente.
- **À vérifier chez nous** : une note de fiche dit-elle quand, et par qui, elle a été écrite ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360017375880
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941455-client-notes
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360007906613-Manage-Customer-Notes

### BM-CLIENT-05 — L'historique des visites dit ce qui s'est passé

- **Étape** : clients — historique
- **Ce que voit l'utilisateur** : la liste des rendez-vous de la cliente, passés et à venir, chacun avec son statut ; le détail d'un rendez-vous montre qui l'a créé et chaque changement (statut, date, prestation).
- **Pourquoi** : un litige (« je n'ai jamais annulé ») se tranche sur des faits.
- **À vérifier chez nous** : l'historique de la fiche montre-t-il les annulations et absences, pas seulement les visites honorées ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941460-client-profiles
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/34111746631191-How-to-view-appointment-history-from-the-Client-s-profile
  - Phorest · extrait · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/4402881398802

## Catalogue

### BM-CATALOGUE-01 — L'ordre du catalogue se règle à la main, et c'est celui que voit la cliente

- **Étape** : catalogue — ordre
- **Ce que voit l'utilisateur** : un mode « Réorganiser » avec des poignées pour déplacer catégories et prestations, puis « Enregistrer » ; l'écran dit que cet ordre est celui de la réservation en ligne.
- **Pourquoi** : le salon maîtrise ce que la cliente voit en premier.
- **À vérifier chez nous** : peut-on ordonner les rubriques et les prestations — y compris au clavier — et l'écran dit-il que c'est l'ordre public ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/catalog/73-order-your-service-menu
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941383-services-and-categories
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/360062550113-How-to-categorise-and-order-services
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/22642423565211-Add-a-Custom-Service

### BM-CATALOGUE-02 — Une fiche prestation courte : nom, rubrique, description, prix, durée

- **Étape** : catalogue — fiche prestation
- **Ce que voit l'utilisateur** : un formulaire court — nom (tel que la cliente le lira), rubrique, description, type de prix (fixe ou « à partir de »), prix, durée — où la durée est présentée comme le temps bloqué au planning.
- **Pourquoi** : une prestation se crée en moins d'une minute, et la durée est saisie avec le sérieux qu'elle mérite.
- **À vérifier chez nous** : le formulaire dit-il que le nom et la description sont ceux que verra la cliente, et que la durée bloque le planning ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/catalog/284-create-services-1
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6487-create-a-service-from-the-square-appointments-app
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941383-services-and-categories

### BM-CATALOGUE-03 — Les praticiens habilités se cochent sur la prestation

- **Étape** : catalogue — habilitations
- **Ce que voit l'utilisateur** : sur la fiche prestation, la liste des praticiens avec une case ou un interrupteur chacun.
- **Pourquoi** : la réservation ne propose que des praticiens qui savent réaliser le soin.
- **À vérifier chez nous** : depuis la prestation, voit-on et règle-t-on qui peut la réaliser ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6487-create-a-service-from-the-square-appointments-app
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/1500002106542-How-to-set-up-your-services
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/22642423565211-Add-a-Custom-Service

### BM-CATALOGUE-04 — Chaque prestation se rend réservable en ligne, ou non

- **Étape** : catalogue — publication
- **Ce que voit l'utilisateur** : un interrupteur « Réservable en ligne » par prestation, activé par défaut.
- **Pourquoi** : les soins qui demandent un échange préalable restent au comptoir sans disparaître du catalogue.
- **À vérifier chez nous** : l'état public d'une prestation se lit-il et se change-t-il depuis la liste ou la fiche ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6487-create-a-service-from-the-square-appointments-app
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941383-services-and-categories

### BM-CATALOGUE-05 — La couleur de la rubrique est celle du planning

- **Étape** : catalogue — couleur
- **Ce que voit l'utilisateur** : une couleur se choisit sur la rubrique (ou la prestation), et le planning coloré par prestation la reprend.
- **Pourquoi** : le planning reste cohérent avec le catalogue.
- **À vérifier chez nous** : si le planning distingue les prestations par couleur, d'où vient cette couleur ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/487-organize-appointments-by-color-in-your-calendar
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6487-create-a-service-from-the-square-appointments-app
  - Phorest · extrait · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016456400-How-do-I-change-the-color-of-my-appointments-service-categories

## Personnel

### BM-STAFF-01 — Des rôles prédéfinis, nommés par métier

- **Étape** : personnel — rôles
- **Ce que voit l'utilisateur** : un rôle à choisir parmi quelques niveaux nommés par métier (Accueil, Praticien, Gérant, Propriétaire), avec le tableau de ce que chacun peut faire (« Oui / Non / Limité »).
- **Pourquoi** : on attribue un rôle sans régler des dizaines de cases, et l'on sait ce qu'il ouvre.
- **À vérifier chez nous** : l'écran d'attribution d'un rôle dit-il ce que ce rôle permet ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/13382959-default-roles-permission-groups
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/team/49-manage-team-permissions-and-access-levels
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/18977275541531-Configure-Access-Levels-and-Employee-Permissions

### BM-STAFF-02 — Une semaine type, et des exceptions d'un jour

- **Étape** : personnel — horaires
- **Ce que voit l'utilisateur** : un horaire récurrent saisi une fois (une ligne par jour, début et fin), et une action distincte « Modifier ce jour seulement » pour une exception datée.
- **Pourquoi** : l'horaire type se saisit une fois ; les imprévus ne le cassent pas.
- **À vérifier chez nous** : peut-on changer l'horaire d'un seul jour sans toucher à la semaine type ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/252-schedule-and-update-team-shifts
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941438-schedule-publishing-and-editing-staff-shifts
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8443-manage-staff-schedules-and-availability-with-square-appointments

### BM-STAFF-03 — Une exception se distingue de la semaine type

- **Étape** : personnel — horaires
- **Ce que voit l'utilisateur** : l'horaire récurrent, ses exceptions et les indisponibilités ont chacun leur apparence (teinte et pictogramme de répétition).
- **Pourquoi** : on voit d'un coup d'œil ce qui déroge à la semaine type.
- **À vérifier chez nous** : dans l'écran des horaires, une exception datée se repère-t-elle sans lire chaque ligne ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941438-schedule-publishing-and-editing-staff-shifts
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/360061235394-Update-staff-working-hours-from-the-Calendar

### BM-STAFF-04 — Une journée peut avoir plusieurs plages

- **Étape** : personnel — horaires
- **Ce que voit l'utilisateur** : « + Ajouter une plage » sur un jour, pour couper la journée par une pause.
- **Pourquoi** : la pause déjeuner fait partie de l'horaire, pas d'un blocage à recréer chaque jour.
- **À vérifier chez nous** : une journée coupée se saisit-elle dans l'horaire, sans plage bloquée ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/252-schedule-and-update-team-shifts
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/360061235394-Update-staff-working-hours-from-the-Calendar

### BM-STAFF-05 — Une absence porte un type et des dates

- **Étape** : personnel — absences
- **Ce que voit l'utilisateur** : « Ajouter une absence » — membre, type (congé, formation, maladie), début, fin — et l'absence apparaît comme indisponibilité.
- **Pourquoi** : les absences sont justifiées et se relisent.
- **À vérifier chez nous** : une absence de plusieurs jours se saisit-elle en une fois, avec son motif ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941438-schedule-publishing-and-editing-staff-shifts
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/21-add-time-off-for-team-members
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/21475777894811-Time-Off-Report

### BM-STAFF-06 — Chaque membre de l'équipe est réservable, ou non

- **Étape** : personnel — réservabilité
- **Ce que voit l'utilisateur** : un interrupteur « Réalise des prestations » ou « Réservable en ligne » par membre.
- **Pourquoi** : l'accueil ou le comptable n'apparaissent pas comme praticiens dans le tunnel.
- **À vérifier chez nous** : un membre sans prestation apparaît-il dans le choix du praticien ou dans les colonnes du planning ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941382-staff-roles
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360009853913-Allow-or-Block-Online-Booking-for-an-Employee
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/360060617894-How-to-add-bookable-staff

## Réglages

### BM-REGLAGE-01 — La politique d'annulation se règle, et son texte en découle

- **Étape** : réglages — annulation
- **Ce que voit l'utilisateur** : un délai (« jusqu'à 24 h avant ») et, le cas échéant, les frais ; le texte montré aux clientes est généré à partir de ces réglages, et l'écran dit où il apparaîtra (tunnel, confirmation).
- **Pourquoi** : le texte lu par la cliente ne peut pas contredire la règle appliquée.
- **À vérifier chez nous** : le délai d'annulation est-il un réglage, et le texte public en découle-t-il ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/payments/101660-set-up-payment-policies
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments

### BM-REGLAGE-02 — Le lien de réservation se copie et se partage d'un geste

- **Étape** : réglages — lien public
- **Ce que voit l'utilisateur** : l'adresse de la page de réservation, avec « Copier » et « Partager » (et souvent un QR code à imprimer), éventuellement vers une prestation précise.
- **Pourquoi** : le gérant diffuse sa page sans aide technique.
- **À vérifier chez nous** : le gérant trouve-t-il le lien de sa page publique, et peut-il le copier en un clic ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5399-invite-customers-to-book-online
  - Fresha · extrait · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/online-profile/152-add-a-book-button-to-your-website
  - Timely · extrait · 2026-09-16 · https://help.gettimely.com/hc/en-gb/articles/4409614137367-How-to-add-an-online-booking-QR-code

## À confirmer — vus, mais sans source lue directement

Ces motifs manquent d'une source observée ou documentée : ils ne sont pas
citables tant qu'un relevé ne l'aura pas apportée.

- **Rendez-vous restants de la journée** et **file « à traiter »** (rendez-vous
  passés non réglés) sur l'accueil du back-office — Timely et GlossGenius, en
  extraits seulement. C'est pourtant le cœur d'un tableau de bord d'accueil :
  premier candidat à un relevé complémentaire.
- **Horaires d'ouverture, une ligne par jour** dans les réglages — Fresha et
  Vagaro en extraits.
- **Écran bloqué qui dit quoi configurer** (« ajoutez une prestation et un
  praticien pour ouvrir la réservation ») et **mise en route guidée** — Vagaro
  et Booker en extraits, Vagaro en note de version. Le critère `ds:etats` couvre
  déjà la première utilisation sans ce motif.

## Vu, mais sans identifiant

- **Vue liste de la journée** à côté de la grille (Boulevard, Square) et
  **filtres du planning** par prestation, statut ou paiement (Fresha) — au-delà
  des vues jour et semaine du CDC §1.4.
- **Vues de clientes enregistrées**, **export de la liste**, **fusion de
  doublons**, **blocage d'une cliente** (Fresha, Square, Boulevard) — au-delà
  d'un CRM de base.
- **Prix et durée qui varient selon le praticien** (Boulevard, Phorest,
  Square) — à arbitrer contre le CDC.
- **Mois et vues multi-jours** au planning ; **zoom de la grille** (Fresha,
  Boulevard, Vagaro).

## Frictions relevées chez les références

- **Double réservation forçable** au comptoir (Square avertit seulement,
  Vagaro offre « Double Book », Booker un réglage de surbooking) — contraire à
  l'ADR 0002.
- **Absence irréversible** : chez Square, un no-show ne se corrige pas —
  demander confirmation avant de marquer une cliente absente.
- **Exceptions effacées sans prévenir** : chez Boulevard, modifier l'horaire
  récurrent supprime les exceptions posées après lui.
- **Deux notions d'horaires qui se contredisent** : Fresha doit expliquer que
  les horaires d'ouverture ne décident pas de la disponibilité en ligne — à
  éviter, ou à dire dans l'écran même.
- **Légende des icônes introuvable** : chez Phorest, elle n'existe qu'en image
  dans l'aide.
- **Glisser-déposer limité à la vue affichée** : Boulevard le déconseille au-delà
  de deux semaines — prévoir l'édition par formulaire (BM-AGENDA-10).
