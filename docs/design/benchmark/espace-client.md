# Benchmark — espace client, report, annulation et messages

Relevé le 2026-09-16. Écrans concernés : `/[tenantSlug]/compte` et ses pages
(`connexion`, `inscription`, `coordonnees`,
`rendez-vous/[appointmentId]/report`), et les e-mails et SMS que reçoit la
cliente. Règles de lecture et de citation : [README.md](README.md).

Aucun espace client n'a été observé connecté — aucun compte n'a été créé. Les
motifs reposent sur les centres d'aide destinés aux clientes, et sur deux pages
publiques de l'ancien site de réservation Booker. Les centres d'aide de
Booker, Mindbody et Treatwell ne se lisent pas directement : leurs apports sont
des `extrait`.

## Compte et connexion

### BM-COMPTE-01 — La cliente sait qu'elle est connectée, et où trouver ses rendez-vous

- **Étape** : espace client — en-tête
- **Ce que voit l'utilisateur** : en haut à droite, « Se connecter » tant qu'elle ne l'est pas ; une fois connectée, son prénom ou ses initiales, qui ouvrent un menu « Mes rendez-vous », « Mes informations », « Se déconnecter ».
- **Pourquoi** : la cliente sait dans quel état elle est, et le chemin vers ses rendez-vous est toujours au même endroit.
- **À vérifier chez nous** : depuis la vitrine et le tunnel, la cliente connectée le voit-elle ? L'accès à « Mes rendez-vous » est-il visible sans chercher ?
- **Sources** :
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6439-manage-your-client-profile-with-square-appointments
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal
  - Booker · observé · 2026-09-16 · https://www.secure-booker.com/g1imp/MakeAppointment/HelpTextPopup.aspx

### BM-COMPTE-02 — Les rendez-vous pris au comptoir apparaissent dans le compte

- **Étape** : espace client — premier accès
- **Ce que voit l'utilisateur** : en créant son compte avec l'e-mail ou le téléphone que le salon connaît déjà, la cliente retrouve dans « Mes rendez-vous » ceux que l'accueil a posés pour elle.
- **Pourquoi** : pas de seconde fiche pour la même personne, et pas d'historique vide à la première connexion.
- **À vérifier chez nous** : une cliente enregistrée au comptoir qui crée son compte voit-elle ses rendez-vous existants ? (L'écart, s'il existe, se corrige probablement côté API : `--workstream Backend`.)
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/115003685133
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8025-get-started-with-square-go
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/28-reschedule-appointments

## Rendez-vous à venir

### BM-RDV-01 — « À venir » d'abord, « Passés » à part

- **Étape** : espace client — liste des rendez-vous
- **Ce que voit l'utilisateur** : en arrivant, les rendez-vous à venir ; les passés sont dans un onglet ou une section distincte.
- **Pourquoi** : l'action la plus fréquente — voir ou gérer le prochain rendez-vous — est immédiate.
- **À vérifier chez nous** : le prochain rendez-vous est-il la première chose visible à 360 px ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360021195373-View-Your-Upcoming-Appointments-and-Classes-for-Customers-of-a-Vagaro-Business
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6439-manage-your-client-profile-with-square-appointments
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client

### BM-RDV-02 — Une carte de rendez-vous dit quoi, avec qui, quand, où, combien, et son statut

- **Étape** : espace client — carte de rendez-vous
- **Ce que voit l'utilisateur** : sur chaque carte, sans l'ouvrir : la prestation, le praticien, la date et l'heure, le lieu, le prix et le statut.
- **Pourquoi** : la cliente reconnaît le bon rendez-vous d'un coup d'œil. Planity se voit reprocher par ses clientes de ne pas nommer le praticien réservé.
- **À vérifier chez nous** : la carte nomme-t-elle le praticien et le prix ? Le statut est-il écrit ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360021195373-View-Your-Upcoming-Appointments-and-Classes-for-Customers-of-a-Vagaro-Business
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6439-manage-your-client-profile-with-square-appointments
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/online-profile/599-learn-how-clients-book-appointments-online

### BM-RDV-03 — Le rendez-vous s'ajoute à l'agenda personnel

- **Étape** : espace client — détail du rendez-vous
- **Ce que voit l'utilisateur** : une action « Ajouter à mon agenda » sur le rendez-vous à venir.
- **Pourquoi** : le rendez-vous rejoint l'agenda du téléphone, ce qui réduit les oublis.
- **À vérifier chez nous** : depuis un rendez-vous à venir, peut-on l'ajouter à son agenda ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360021195373-View-Your-Upcoming-Appointments-and-Classes-for-Customers-of-a-Vagaro-Business
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal

### BM-RDV-04 — L'adresse et l'itinéraire sont à un geste du rendez-vous

- **Étape** : espace client — détail du rendez-vous
- **Ce que voit l'utilisateur** : l'adresse du salon, son téléphone, et un lien « Itinéraire » qui ouvre la carte du téléphone.
- **Pourquoi** : le jour J, la cliente n'a pas à chercher le salon ailleurs.
- **À vérifier chez nous** : l'adresse du salon est-elle sur le rendez-vous, et mène-t-elle à un itinéraire ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360021195373-View-Your-Upcoming-Appointments-and-Classes-for-Customers-of-a-Vagaro-Business
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal
  - Fresha · annoncé · 2026-09-16 · https://www.fresha.com/blog/making-the-most-of-freshas-notifications

### BM-RDV-05 — Reporter et annuler n'apparaissent que s'ils sont possibles, sinon la raison et le salon

- **Étape** : espace client — actions du rendez-vous
- **Ce que voit l'utilisateur** : les boutons « Déplacer » et « Annuler » n'existent que si le salon l'autorise et que le délai n'est pas dépassé ; sinon, une phrase dit pourquoi (« Ce rendez-vous est trop proche pour être modifié en ligne ») et donne le téléphone du salon.
- **Pourquoi** : la cliente ne se voit ni proposer une action qui échouera, ni laisser devant un bouton grisé sans explication.
- **À vérifier chez nous** : un rendez-vous hors délai affiche-t-il la raison et un moyen de joindre le salon ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/6950738-rescheduling-appointments
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/102042-cancel-appointments
  - Booker · extrait · 2026-09-16 · https://support.mindbodyonline.com/s/article/Online-booking-FAQs-and-troubleshooting?language=en_US

### BM-RDV-06 — L'heure affichée est celle du salon, et le dit quand il le faut

- **Étape** : espace client et messages — heures
- **Ce que voit l'utilisateur** : les heures sont celles du fuseau de l'établissement, verrouillé par le salon, et le fuseau est nommé quand la cliente pourrait se trouver ailleurs.
- **Pourquoi** : un rendez-vous compris avec une heure d'écart est un rendez-vous manqué — l'ADR 0006 le range parmi les bugs graves.
- **À vérifier chez nous** : l'heure d'un rendez-vous est-elle la même dans l'espace client, le tunnel et les messages ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5351-manage-your-square-appointments-account-settings
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360008506194-Rebook-a-Service-or-Class-for-Customers-of-a-Vagaro-Business

## Historique

### BM-HISTO-01 — Un rendez-vous honoré reste consultable

- **Étape** : espace client — historique
- **Ce que voit l'utilisateur** : les rendez-vous passés restent listés avec leur prestation, leur praticien et leur date ; ils ne disparaissent pas le jour même.
- **Pourquoi** : la cliente retrouve une prestation ou la prouve. Planity se voit reprocher qu'un rendez-vous « disparaît » de l'agenda à l'arrivée au salon.
- **À vérifier chez nous** : un rendez-vous du jour, puis d'hier, reste-t-il visible et lisible ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6439-manage-your-client-profile-with-square-appointments
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/online-profile/599-learn-how-clients-book-appointments-online

### BM-HISTO-02 — « Réserver à nouveau » depuis un rendez-vous passé

- **Étape** : espace client — historique
- **Ce que voit l'utilisateur** : sur la carte d'un rendez-vous passé, un bouton « Réserver à nouveau » ouvre le tunnel avec la même prestation (et le même praticien) déjà choisis, directement au choix du créneau.
- **Pourquoi** : la cliente refait la même prestation sans refaire tout le tunnel.
- **À vérifier chez nous** : depuis l'historique, combien d'étapes pour reprendre la même prestation ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360008506194-Rebook-a-Service-or-Class-for-Customers-of-a-Vagaro-Business
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/online-profile/599-learn-how-clients-book-appointments-online
  - Square · annoncé · 2026-09-16 · https://apps.apple.com/us/app/square-go/id1623896123

## Report

### BM-REPORT-01 — On déplace un rendez-vous, on ne l'annule pas pour en recréer un

- **Étape** : report — geste
- **Ce que voit l'utilisateur** : « Déplacer » sur le rendez-vous ouvre le choix d'un nouveau créneau, puis une confirmation ; le rendez-vous garde son identité.
- **Pourquoi** : le rendez-vous conserve son paiement et son historique. Planity se voit reprocher un libellé qui remplace un rendez-vous au lieu de le déplacer.
- **À vérifier chez nous** : le libellé dit-il « déplacer » ? Le rendez-vous reporté est-il le même, avec sa référence ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/6950738-rescheduling-appointments
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/28-reschedule-appointments
  - Treatwell · documenté · 2026-09-16 · https://www.treatwell.fr/info/reservation-termes-et-conditions/

### BM-REPORT-02 — Le report obéit au délai de l'annulation, et le dit

- **Étape** : report — délai
- **Ce que voit l'utilisateur** : trop près du rendez-vous, le report en ligne n'est plus proposé ; un message dit pourquoi et invite à appeler le salon.
- **Pourquoi** : un report de dernière minute ne contourne pas la politique d'annulation.
- **À vérifier chez nous** : l'écran de report annonce-t-il le délai avant que la cliente ne choisisse un créneau ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/6950738-rescheduling-appointments
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/101218-manage-online-bookings-settings
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Treatwell · documenté · 2026-09-16 · https://www.treatwell.fr/info/reservation-termes-et-conditions/

### BM-REPORT-03 — Le praticien ne change jamais à l'insu de la cliente

- **Étape** : report — praticien
- **Ce que voit l'utilisateur** : les créneaux proposés sont ceux du praticien d'origine, ou le praticien est un champ visible et modifiable de l'écran de report.
- **Pourquoi** : Planity se voit reprocher un report « avec un autre coiffeur sans que je puisse le savoir ».
- **À vérifier chez nous** : l'écran de report nomme-t-il le praticien des créneaux proposés ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/6950738-rescheduling-appointments
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business

### BM-REPORT-04 — Le paiement déjà versé suit le rendez-vous déplacé

- **Étape** : report — paiement
- **Ce que voit l'utilisateur** : un acompte ou un prépaiement ne bloque pas le report ; l'écran dit que le paiement reste attaché au rendez-vous déplacé.
- **Pourquoi** : pas de remboursement suivi d'un nouveau paiement.
- **À vérifier chez nous** : pour un rendez-vous prépayé, l'écran de report dit-il ce que devient le paiement ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/28-reschedule-appointments
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/28168892345874

### BM-REPORT-05 — Le succès d'un report ou d'une annulation se voit à l'écran

- **Étape** : report et annulation — retour
- **Ce que voit l'utilisateur** : après l'action, un message explicite (« Votre rendez-vous a bien été déplacé au jeudi 18 à 10 h ») et la liste à jour.
- **Pourquoi** : la cliente sait que l'action a abouti et ne recommence pas.
- **À vérifier chez nous** : après un report, l'écran confirme-t-il le nouvel horaire ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Booker · extrait · 2026-09-16 · https://support.mindbodyonline.com/s/article/About-Cancelling-Appointments-via-SMS?language=en_US

Planity décrit l'état final dans son article d'aide ; ce n'est pas forcément le
texte exact de l'écran.

## Annulation

### BM-ANNUL-01 — La politique d'annulation se lit avant de réserver, et se relit ensuite

- **Étape** : tunnel (récapitulatif), confirmation et espace client
- **Ce que voit l'utilisateur** : la politique d'annulation — délai et conséquence — est affichée avant de réserver, puis rappelée dans la confirmation et sur le rendez-vous.
- **Pourquoi** : la cliente ne découvre pas la règle au moment d'annuler.
- **À vérifier chez nous** : la politique est-elle visible avant le bouton de réservation, et retrouvable depuis le rendez-vous ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments
  - Treatwell · documenté · 2026-09-16 · https://www.treatwell.fr/info/reservation-termes-et-conditions/
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/28251675841298-Comment-activer-et-g%C3%A9rer-le-pr%C3%A9paiement-des-r%C3%A9servations-en-ligne
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360008506194-Rebook-a-Service-or-Class-for-Customers-of-a-Vagaro-Business
  - Booker · observé · 2026-09-16 · https://www.secure-booker.com/zenblend/ViewCancellationPolicy.aspx

### BM-ANNUL-02 — La conséquence financière est annoncée avant de confirmer l'annulation

- **Étape** : annulation — confirmation
- **Ce que voit l'utilisateur** : l'écran d'annulation dit ce qui arrive à l'argent — remboursé, acompte conservé, frais retenus — avant le bouton final, qui peut porter le montant (« Annuler — 15,00 € de frais »).
- **Pourquoi** : pas de frais découverts après coup, donc moins de litiges.
- **À vérifier chez nous** : pour un rendez-vous prépayé ou tardif, l'écran dit-il ce que la cliente perd avant qu'elle confirme ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/102042-cancel-appointments
  - Booker · extrait · 2026-09-16 · https://support.mindbodyonline.com/s/article/Messenger-ai-Preferences-settings-Booker?language=en_US

### BM-ANNUL-03 — Annuler se fait en deux temps

- **Étape** : annulation — geste
- **Ce que voit l'utilisateur** : « Annuler le rendez-vous », puis un écran ou une fenêtre qui récapitule le rendez-vous et demande « Confirmer l'annulation ».
- **Pourquoi** : une annulation est irréversible ; un clic distrait ne doit pas y suffire.
- **À vérifier chez nous** : l'annulation demande-t-elle une confirmation qui nomme le rendez-vous ?
- **Sources** :
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27795258020242-Comment-annuler-ou-d%C3%A9placer-un-rendez-vous-en-tant-que-client
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4852515855643-Cancel-or-Reschedule-Services-and-Classes-for-Customers-of-a-Vagaro-Business

## Messages — e-mails et SMS

### BM-NOTIF-01 — La confirmation se suffit à elle-même le jour J

- **Étape** : message de confirmation
- **Ce que voit l'utilisateur** : la prestation, le praticien, la date et l'heure, l'adresse, le prix, la politique d'annulation et un bouton pour gérer le rendez-vous.
- **Pourquoi** : la cliente n'a besoin de rien d'autre pour venir. Planity se voit reprocher une confirmation qui ne nomme pas le praticien.
- **À vérifier chez nous** : l'e-mail de confirmation nomme-t-il le praticien, le prix et la politique d'annulation ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8447995-appointment-booking-confirmations
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5493-set-a-custom-cancellation-policy-with-square-appointments
  - Fresha · annoncé · 2026-09-16 · https://www.fresha.com/blog/making-the-most-of-freshas-notifications

### BM-NOTIF-02 — Confirmation et rappel mènent au rendez-vous en un geste

- **Étape** : messages — lien d'action
- **Ce que voit l'utilisateur** : un bouton « Gérer mon rendez-vous » dans la confirmation et dans le rappel, qui ouvre directement le rendez-vous et ses actions (déplacer, annuler).
- **Pourquoi** : la cliente agit au moment où elle lit, sans chercher sa connexion. Des clientes de Fresha se plaignent que ce lien ait disparu des rappels.
- **À vérifier chez nous** : le rappel J-1 contient-il un lien vers le rendez-vous ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8447995-appointment-booking-confirmations
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941385-canceling-appointments
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/clients/183-complete-forms
  - Treatwell · documenté · 2026-09-16 · https://www.treatwell.fr/info/reservation-termes-et-conditions/

### BM-NOTIF-03 — Un rappel la veille, et un rattrapage pour les réservations tardives

- **Étape** : messages — rappel
- **Ce que voit l'utilisateur** : un rappel environ 24 h avant ; une réservation prise moins de 24 h avant reçoit son rappel peu après la réservation plutôt que jamais.
- **Pourquoi** : moins d'absences, y compris pour les réservations de dernière minute.
- **À vérifier chez nous** : que reçoit une cliente qui réserve à 18 h pour le lendemain 9 h ?
- **Sources** :
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27847088525586
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8448164-appointment-reminder-notifications
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/167-send-appointment-reminders

### BM-NOTIF-04 — Chaque changement d'état donne un message

- **Étape** : messages — report, annulation
- **Ce que voit l'utilisateur** : un message distinct quand le rendez-vous est déplacé (avec le nouvel horaire) ou annulé ; s'il y a des frais, un reçu les accompagne.
- **Pourquoi** : ce que la cliente lit correspond toujours à l'état réel du rendez-vous.
- **À vérifier chez nous** : un report fait par l'accueil prévient-il la cliente, avec le nouvel horaire ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/130-send-appointment-updates
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6729-customer-confirmations-with-square-appointments
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941385-canceling-appointments
  - Planity · documenté · 2026-09-16 · https://support.planity.com/hc/fr/articles/27937296963602

## Coordonnées et préférences

### BM-PROFIL-01 — La cliente corrige elle-même ses coordonnées

- **Étape** : espace client — mes informations
- **Ce que voit l'utilisateur** : un écran « Mes informations » modifiable ; ce qu'elle corrige est ce que le salon voit et ce qui sert aux rappels.
- **Pourquoi** : une seule source de vérité pour joindre la cliente.
- **À vérifier chez nous** : une modification faite par la cliente est-elle celle que voit l'accueil ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/8648439-client-portal
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/115003183914

### BM-PROFIL-02 — La cliente choisit par quel canal elle est prévenue

- **Étape** : espace client — préférences
- **Ce que voit l'utilisateur** : un réglage des rappels par canal — e-mail, SMS —, et le lien de désinscription d'un e-mail ouvre ces préférences au lieu de tout couper.
- **Pourquoi** : le consentement se règle par canal, et la cliente garde ses rappels en refusant ce dont elle ne veut pas.
- **À vérifier chez nous** : la cliente peut-elle refuser les SMS sans perdre les e-mails ?
- **Sources** :
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/26945292866075-Manage-Your-Notification-Settings-for-Customers-of-a-Vagaro-Business
  - Vagaro · documenté · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/115003412914
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8447-troubleshoot-customer-appointment-communications
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/calendar/167-send-appointment-reminders

## Vu, mais sans identifiant

Pratiques réelles et sourcées qui n'ouvrent pas de ticket `ds:standard`, pour
la raison dite :

- **Réserver sans compte, compte proposé à la fin** (Boulevard documenté,
  Booker observé) — **contesté** : Fresha et Vagaro imposent un compte. Deux
  pratiques du marché coexistent ; ce n'est pas un standard.
- **Connexion sans mot de passe, par code** (Boulevard, Square) — un choix
  d'authentification, qui relève d'un ADR, pas d'une reprise d'écran.
- **Demande de confirmation de présence**, par lien ou réponse au SMS
  (Boulevard, Vagaro, Square ; Booker en extrait) — fonctionnalité non listée au
  CDC §1.4 ; la réponse par SMS suppose en plus des SMS entrants.
- **Consignes pratiques** dans la confirmation (Boulevard, Fresha) — réglage
  propre au salon, non listé.
- **Remboursement automatique calculé selon le délai** (Planity, Treatwell,
  Square) — règle métier, pas écran.
- **Désinscription SMS par « STOP »** (Vagaro, Square) — comportement du canal
  SMS, à traiter côté notifications.
- **Cartes enregistrées gérées par la cliente** (Vagaro, Square) — hors MVP.
- **Invitation à reprendre rendez-vous après une annulation** (Booker en
  extrait, Fresha annoncé) — aucune source observée ni documentée.

## Frictions relevées chez les références

- Planity : confirmation qui ne nomme pas le praticien ; report qui change de
  praticien sans le dire ; « Reprendre un rendez-vous » qui remplace le
  rendez-vous existant ; rendez-vous qui disparaît de l'agenda à l'arrivée
  (avis App Store FR, 2021-2025 —
  https://apps.apple.com/fr/app/planity/id1434056190?see-all=reviews).
- Fresha : le lien vers la réservation a disparu des SMS de rappel ; les SMS ne
  permettent pas de répondre
  (https://apps.apple.com/us/app/fresha-for-customers/id1297230801).
- Square Go : le SMS est remplacé par une notification push chez les clientes
  qui ont l'application, sans qu'elles le sachent
  (https://squareup.com/help/us/en/article/6729-customer-confirmations-with-square-appointments).
- Aucune plateforme ne documente le **rappel de l'ancien créneau** pendant un
  report (ancien et nouvel horaire côte à côte), ni un état vide « aucun
  rendez-vous à venir » précis : c'est une occasion de faire mieux, pas un
  standard à citer.
