# Cahier de recette — MVP Spa & Salon Booking

**Ce document se joue à la main, par un humain, sur l'environnement de recette,
avant la mise en production.** Il couvre les **six domaines fonctionnels** du
CDC §1.4 et la boucle de valeur du MVP — réserver → confirmer → honorer →
encaisser → mesurer.

Il ne décrit **que ce qui existe**. Chaque cas a été écrit en relisant le code
qui le sert : un comportement qui n'est pas implémenté n'y figure pas, et ce que
le MVP ne fait pas est dit au §10 plutôt que passé sous silence. Un cahier qui
inventerait un comportement ferait échouer la recette sur une attente que
personne n'a jamais codée — et ferait douter de tout le reste.

| | |
|---|---|
| Environnement cible | `staging` — [runbooks/recette-staging.md](../runbooks/recette-staging.md) |
| Jeu de données | `apps/api/prisma/seed.ts` — [apps/api/prisma/README.md](../../apps/api/prisma/README.md) |
| Durée indicative d'un passage complet | une demi-journée à deux personnes |
| Verdict | bloquant : aucun cas en échec ne se contourne |

---

## 0. Avant de commencer

### 0.1 Ce qu'il faut avoir sous la main

1. L'environnement de recette **déployé et servi sur un vrai certificat**.
   `terraform output tls_certificate_is_self_signed` doit valoir `false` : sous
   certificat auto-signé, les Server Components du front et les trois Lambda de
   notification refusent d'appeler l'API, et la moitié de ce cahier est
   injouable. Le montage complet est décrit par
   [recette-staging.md](../runbooks/recette-staging.md) ; les gestes AWS qui
   restent à poser sont recensés par **#588**.
2. Le **jeu de données de recette chargé** (`SEED_TARGET=staging npm run db:seed`).
3. L'URL publique du front et celle de l'API, et de quoi émettre des appels HTTP
   à la main (`curl`, un client REST) pour les cas qui n'ont pas d'écran.
4. Le **tableau de bord Stripe** en mode test, pour les cas du domaine
   « Paiements » — sans lui, ni le webhook ni le remboursement ne se prouvent.
5. La valeur de `NOTIFICATIONS_INTERNAL_TOKEN` du secret d'exécution, pour les
   deux routes internes du domaine « Notifications ».

### 0.2 Le jeu de données, et pourquoi il compte

Le seed pose **deux établissements**, et ce n'est pas une commodité : c'est ce
qui rend l'isolation exerçable (§9). Ils diffèrent par ce qui casse en silence
quand on se trompe — le fuseau, le taux de taxe, le pas de créneau, le préavis.

| | Spa Lumière | Barber Tana |
|---|---|---|
| Slug (segment d'URL) | `spa-lumiere` | `barber-tana` |
| Fuseau | `Europe/Paris` | `Indian/Antananarivo` |
| Taxe | 20 % (2000 points de base) | **0 %** |
| Pas de créneau | 15 min | 30 min |
| Préavis minimum | 120 min | 60 min |
| Devise | EUR | EUR *(l'ariary n'a pas de sous-unité — le jeu de recette n'est pas l'endroit où éprouver ce cas)* |
| Praticiens | Claire F., Yanis B. | Tojo R., Mamy A. |
| Clientes | Alice Marchand, Bruno Nguyen, Carla Sow | Faniry Rasoa, Herizo Randria, Nirina Ravalo |

**Comptes** — toutes les adresses suivent la forme `<clé>@<slug>.test`, mot de
passe `Recette-2026!` par défaut (`SEED_PASSWORD`) :

| Rôle | Spa Lumière | Barber Tana |
|---|---|---|
| Administrateur | `admin@spa-lumiere.test` | `admin@barber-tana.test` |
| Gérant | `manager@spa-lumiere.test` | `manager@barber-tana.test` |
| Praticien | `claire@spa-lumiere.test`, `yanis@spa-lumiere.test` | `tojo@barber-tana.test`, `mamy@barber-tana.test` |
| Cliente | `alice@spa-lumiere.test`, `bruno@…`, `carla@…` | `faniry@barber-tana.test`, `herizo@…`, `nirina@…` |

**Cinq rendez-vous par établissement, un par statut**, ancrés sur le jour courant
et rejoués à chaque exécution du seed : un honoré (J−7), un confirmé **demain**,
un à confirmer (J+2), une absence (J−3), une annulation (J+3). Le rendez-vous
honoré porte sa vente et son encaissement. Les praticiens travaillent du **lundi
au vendredi, 09:00–13:00 et 14:00–19:00**, heure du salon.

> **Le seed est idempotent.** Le rejouer entre deux passages rafraîchit les dates
> sans dupliquer une ligne — et c'est la bonne façon de repartir propre. Il refuse
> de s'exécuter si l'hôte, la base ou l'utilisateur de `DATABASE_URL` contient
> `prod`.

### 0.3 Comment se lit un cas

Chaque cas porte un identifiant stable, ses préconditions, ses gestes, et **un
résultat attendu observable** — quelque chose qu'on voit à l'écran ou qu'on lit
dans une réponse HTTP, jamais « le système fonctionne ». La case à cocher est le
verdict, et elle ne se coche qu'après avoir vu.

Les URL du front s'écrivent `/{slug}/…`. Celles de l'API sont préfixées de
`/api/v1/`, à l'exception de `GET /health`.

### 0.4 Ce qui vaut échec

- un cas dont le résultat observé diffère de l'attendu ;
- **une erreur dans la console du navigateur**, le `404` de `favicon.ico` mis à
  part ;
- **un 403 là où le cahier attend un 404** sur une frontière de tenant : c'est
  une fuite d'existence, et elle est bloquante quel que soit le reste ;
- un montant affiché avec une décimale calculée côté navigateur ;
- une heure affichée dans le fuseau du poste plutôt que dans celui du salon.

Un cas en échec se consigne avec sa capture, son horodatage et l'identifiant du
rendez-vous ou de la ressource en cause. **Il ne se contourne pas.**

---

## 1. Domaine 1 — Réservation client

> CDC §1.4 : catalogue de services, choix du praticien ou « premier disponible »,
> calendrier de disponibilité temps réel, réservation / report / annulation,
> confirmations et rappels, compte client avec historique.

**RC-01 · La vitrine publique sert le catalogue actif**
- *Préconditions* : aucune session.
- *Gestes* : ouvrir `/spa-lumiere`.
- *Attendu* : le nom du salon en `h1`, un lien « Prendre rendez-vous », les
  prestations groupées par rubrique (Soins du visage, Massages) avec durée, prix
  et praticiens, puis l'adresse postale, les horaires d'ouverture et le fuseau.
  **Aucun tampon de remise en état n'est affiché**, aucune prestation désactivée
  n'apparaît.
- [ ] Verdict

**RC-02 · Un salon inconnu ou désactivé est indistinct**
- *Gestes* : ouvrir `/salon-qui-nexiste-pas`.
- *Attendu* : la page « Page introuvable ». La réponse d'API sous-jacente est un
  **404 sans code métier** : rien ne permet de dire si le salon n'existe pas ou
  s'il est désactivé.
- [ ] Verdict

**RC-03 · Le tunnel propose des créneaux réels**
- *Gestes* : `/spa-lumiere/reservation` → choisir « Soin éclat 45 min » →
  « Choisir un créneau ».
- *Attendu* : une pastille par journée sur **14 jours**, portant le nombre de
  créneaux (`complet` à zéro) ; la grille des heures groupée en matin /
  après-midi / soir ; la mention du fuseau du salon si le navigateur est ailleurs.
  Les journées de **samedi et dimanche sont vides** — les praticiens du seed ne
  travaillent que du lundi au vendredi.
- [ ] Verdict

**RC-04 · Un praticien qui ne pratique pas la prestation n'est jamais proposé**
- *Gestes* : à l'étape 1, choisir « Soin éclat 45 min », dérouler le sélecteur de
  praticien.
- *Attendu* : **Claire F. seule** y figure ; Yanis B. en est absent. Changer pour
  « Massage suédois 60 min » inverse la liste.
- [ ] Verdict

**RC-05 · « Premier disponible » affecte un praticien**
- *Gestes* : laisser le praticien sur « Premier disponible », réserver un créneau.
- *Attendu* : la confirmation nomme un praticien précis. Le rendez-vous créé
  porte toujours un `staffId` — la notion de rendez-vous sans praticien n'existe
  pas en base.
- [ ] Verdict

**RC-06 · Le préavis minimum écarte les créneaux trop proches**
- *Préconditions* : Spa Lumière, préavis de **120 minutes**, un jour ouvré en
  cours d'heures d'ouverture.
- *Gestes* : ouvrir la journée du jour dans le tunnel.
- *Attendu* : aucun créneau ne commence dans les deux heures qui suivent
  l'instant présent.
- [ ] Verdict

**RC-07 · Une réservation d'invitée aboutit**
- *Gestes* : choisir prestation et créneau, saisir prénom, nom, adresse e-mail
  **inconnue du salon**, téléphone au format international, un mot pour le salon,
  puis « Vérifier ma réservation » et « Confirmer la réservation ».
- *Attendu* : l'écran de confirmation « Votre rendez-vous est enregistré », le
  récapitulatif, et une **référence** (l'identifiant du rendez-vous). Le
  rendez-vous apparaît immédiatement au planning du back-office, au statut
  **« à confirmer »** : un rendez-vous public naît `PENDING` et **occupe déjà**
  l'agenda.
- [ ] Verdict

**RC-08 · Le double clic ne produit pas deux rendez-vous**
- *Gestes* : sur le récapitulatif, cliquer deux fois de suite, très vite, sur
  « Confirmer la réservation ».
- *Attendu* : le bouton se désactive au premier clic et affiche « Réservation en
  cours… » ; **un seul** rendez-vous existe au planning.
- [ ] Verdict

**RC-09 · Un créneau pris entre-temps est refusé sans perdre la saisie**
- *Gestes* : ouvrir le tunnel dans deux onglets sur le **même créneau**, aller
  jusqu'au récapitulatif dans les deux, confirmer l'un puis l'autre.
- *Attendu* : le second reçoit un bandeau d'avertissement « Ce créneau n'est plus
  disponible » **nommant l'horaire perdu**, revient à l'étape « Créneau » avec
  les disponibilités rechargées, et **conserve prestation et coordonnées**. Aucun
  second rendez-vous n'est posé.
- [ ] Verdict

**RC-10 · Une adresse du personnel est refusée**
- *Gestes* : réserver en saisissant `claire@spa-lumiere.test` comme adresse.
- *Attendu* : bandeau « Cette adresse e-mail ne peut pas être utilisée ici », on
  **reste** sur le récapitulatif. Aucun rendez-vous n'est rattaché au compte de
  la praticienne.
- [ ] Verdict

**RC-11 · L'annulation depuis l'écran de confirmation libère le créneau**
- *Gestes* : sur l'écran de confirmation, « Annuler ce rendez-vous » →
  « Confirmer l'annulation ».
- *Attendu* : « Votre rendez-vous est annulé », un bouton « Prendre un nouveau
  rendez-vous », et le **créneau redevient proposable** à la lecture suivante des
  disponibilités (au plus 60 s de cache).
- [ ] Verdict

**RC-12 · Inscription et connexion de l'espace client**
- *Gestes* : `/spa-lumiere/compte/inscription`, créer un compte (mot de passe
  d'au moins douze caractères), puis se déconnecter et se reconnecter.
- *Attendu* : redirection vers `/spa-lumiere/compte`. Une seconde inscription sur
  la même adresse rend un message dédié, pas une erreur générique.
- [ ] Verdict

**RC-13 · L'historique de la cliente sépare l'à-venir du passé**
- *Gestes* : se connecter en `alice@spa-lumiere.test`, ouvrir `/spa-lumiere/compte`.
- *Attendu* : deux sections, « à venir » et « passés ». Alice porte un rendez-vous
  **honoré** (J−7) et une **absence** (J−3) : les badges disent « Honoré » et
  « Non honoré ». Les boutons « Reporter » et « Annuler » n'apparaissent **que**
  sur les lignes à venir en statut à confirmer ou confirmé.
- [ ] Verdict

**RC-14 · Le report déplace le rendez-vous et laisse une trace**
- *Préconditions* : Bruno porte le rendez-vous confirmé de **demain**.
- *Gestes* : se connecter en `bruno@spa-lumiere.test`, « Reporter », choisir un
  autre créneau, valider.
- *Attendu* : le créneau **actuel** apparaît désactivé avec la mention
  « (actuel) » avant validation. Après validation : un rendez-vous à la nouvelle
  date, et l'ancien passe au badge **« Déplacé »** — pas « Annulé par vous ». Un
  report n'a pas d'auteur d'annulation.
- [ ] Verdict

**RC-15 · Un rendez-vous n'est reportable qu'une fois**
- *Gestes* : tenter de reporter à nouveau la **ligne d'origine** (celle marquée
  « Déplacé »).
- *Attendu* : elle n'offre plus ni report ni annulation.
- [ ] Verdict

**RC-16 · Les coordonnées se modifient, l'adresse non**
- *Gestes* : `/spa-lumiere/compte/coordonnees`, changer le téléphone, enregistrer.
- *Attendu* : « Coordonnées enregistrées ». Le champ **adresse e-mail est en
  lecture seule**, avec la mention « Contactez le salon pour en changer ».
  Vider le téléphone le retire.
- [ ] Verdict

**RC-17 · Le quota public protège le tunnel**
- *Gestes* : émettre onze `POST /api/v1/public/spa-lumiere/appointments` en moins
  d'une minute depuis la même adresse.
- *Attendu* : le onzième rend **429**. Le même exercice sur
  `GET /api/v1/public/spa-lumiere/availability` tient jusqu'à **120 appels par
  minute**.
- [ ] Verdict

**RC-18 · Une session expirée ramène à la connexion, en le disant**
- *Gestes* : supprimer les cookies `spa_account_*` puis recharger
  `/spa-lumiere/compte`.
- *Attendu* : retour à `/spa-lumiere/compte/connexion` avec la bannière
  « Votre session a expiré » (`?motif=session-expiree`).
- [ ] Verdict

---

## 2. Domaine 2 — Back-office / Admin

> CDC §1.4 : vue calendrier jour/semaine, création et édition manuelle de RDV,
> catalogue de services, CRM client de base.

**BO-01 · La connexion du back-office et le refus de rôle**
- *Gestes* : `/spa-lumiere/admin/connexion`, se connecter en
  `manager@spa-lumiere.test` ; se déconnecter, recommencer en
  `alice@spa-lumiere.test`.
- *Attendu* : le gérant arrive sur **`/spa-lumiere/admin/reglages`** ; la cliente
  obtient une session mais voit « Accès réservé » — la garde est celle de l'API,
  pas celle de l'écran. `/spa-lumiere/admin` **ne sert aucune page** : ne pas
  l'utiliser comme point d'entrée.
- [ ] Verdict

**BO-02 · Le planning du jour**
- *Gestes* : « Planning » dans le rail.
- *Attendu* : une colonne **par praticien actif**, y compris ceux sans
  rendez-vous ; une gouttière d'heures ; le trait de l'heure courante ; la
  légende des cinq statuts ; et la mention « Heures affichées dans le fuseau du
  salon (`Europe/Paris`) ».
- [ ] Verdict

**BO-03 · La vue semaine et la navigation**
- *Gestes* : basculer sur « Semaine », naviguer avec `‹` et `›`, revenir par
  « Aujourd'hui ».
- *Attendu* : une colonne par journée ; l'URL suit (`?vue=semaine&date=…`) **sans
  rechargement** ; les rendez-vous du seed apparaissent aux bonnes heures du
  salon.
- [ ] Verdict

**BO-04 · Créer un rendez-vous depuis une case libre**
- *Gestes* : cliquer une cellule libre de la colonne de Claire F.
- *Attendu* : le tiroir s'ouvre en création, **pré-rempli** du jour, de l'heure et
  du praticien de la colonne.
- [ ] Verdict

**BO-05 · Choisir ou créer la fiche cliente**
- *Gestes* : dans le tiroir, taper « mar » dans la recherche de client ; puis
  chercher un nom absent et « Créer la fiche ».
- *Attendu* : la recherche part à **deux caractères**, annonce « N fiche(s)
  trouvée(s) » ; le mini-formulaire crée la fiche et la sélectionne. Le bouton
  « Créer le rendez-vous » reste **désactivé tant qu'aucun client n'est choisi**.
- [ ] Verdict

**BO-06 · Le récapitulatif est calculé, jamais saisi**
- *Gestes* : choisir « Soin éclat 45 min » et une heure de début.
- *Attendu* : Début, **Fin calculée**, « Tampon de remise en état — 10 min, libre
  à HH:MM », et le montant. Aucun de ces champs n'est modifiable.
- [ ] Verdict

**BO-07 · La prestation d'un rendez-vous posé ne se change pas**
- *Gestes* : ouvrir un rendez-vous existant.
- *Attendu* : le sélecteur de prestation est **désactivé**, avec l'aide « son prix
  et sa durée sont figés à la réservation ».
- [ ] Verdict

**BO-08 · Le report par glisser-déposer, et au clavier**
- *Gestes* : déplacer un bloc vers une case libre à la souris ; recommencer au
  clavier via la poignée `⠿`, puis annuler par `Échap`.
- *Attendu* : le déplacement est immédiat à l'écran puis confirmé par le serveur ;
  la région d'annonce dit « … est saisi : choisissez un créneau libre, ou Échap
  pour reposer ». `Échap` repose le bloc sans rien écrire.
- [ ] Verdict

**BO-09 · Changer de praticien demande confirmation**
- *Gestes* : déposer un bloc dans la colonne d'un **autre** praticien.
- *Attendu* : une boîte de dialogue « Changer de praticien ? » nommant les deux
  praticiens, le jour et l'heure, avec « Annuler » et « Confirmer le changement ».
- [ ] Verdict

**BO-10 · Un report refusé remet le bloc en place**
- *Gestes* : depuis deux postes, déplacer deux rendez-vous vers le **même** créneau.
- *Attendu* : le perdant revient à sa position d'origine avec le bandeau
  « Créneau déjà pris — rendez-vous remis en place », rappelant l'heure et le
  praticien d'origine.
- [ ] Verdict

**BO-11 · Les transitions de statut respectent le cycle de vie**
- *Gestes* : ouvrir successivement le rendez-vous **à confirmer** (J+2) et le
  rendez-vous **confirmé** (demain).
- *Attendu* : sur le confirmé, « Marquer honoré » et « Marquer non présenté » ;
  sur celui à confirmer, **aucun des deux** — on ne solde pas un soin non
  confirmé. Sur un rendez-vous honoré, annulé ou non présenté, aucun bouton de
  statut. Un appel direct `POST /api/v1/appointments/{id}/status` avec
  `{"status":"completed"}` sur un rendez-vous `pending` rend **422
  `INVALID_STATE_TRANSITION`** avec `details = { from, to }`.
- [ ] Verdict

**BO-12 · Le catalogue se filtre et se désactive, jamais ne se supprime**
- *Gestes* : « Prestations », basculer sur « Actives seulement », puis
  « Désactiver » une prestation, puis « Réactiver ».
- *Attendu* : la bascule est immédiate et sans confirmation ; **aucun bouton de
  suppression n'existe** ; les états vides sont distincts selon le filtre
  (« Aucune prestation en ligne » / « Catalogue vide »).
- [ ] Verdict

**BO-13 · Créer une prestation, et le conflit d'adresse publique**
- *Gestes* : « Nouvelle prestation », saisir un nom, une durée, des tampons et un
  prix ; enregistrer. Recommencer en réutilisant le **slug** d'une prestation
  existante.
- *Attendu* : la ligne « Durée bloquée sur l'agenda » se recalcule **à la frappe** ;
  après création, redirection vers la fiche. Le conflit pose son message **sur le
  champ slug**, pas en haut de page.
- [ ] Verdict

**BO-14 · Les rubriques**
- *Gestes* : « Rubriques », créer, modifier en ligne, désactiver.
- *Attendu* : une seule rubrique éditable à la fois ; aucune suppression.
- [ ] Verdict

**BO-15 · L'aperçu public montre ce que voit la cliente**
- *Gestes* : « Aperçu public » depuis le catalogue.
- *Attendu* : le rendu du catalogue **public** — donc sans les prestations
  désactivées ni les tampons — sous le bandeau « Ce que voit la cliente ».
- [ ] Verdict

**BO-16 · Le fichier client : recherche, pagination, fiche**
- *Gestes* : « Clients », chercher « sow », ouvrir la fiche de Carla, parcourir
  les pages, revenir par le bouton du navigateur.
- *Attendu* : la recherche porte sur nom, téléphone **et** e-mail ; l'état vit
  dans l'URL et la saisie se resynchronise au retour ; la fiche affiche les
  compteurs — Visites honorées, À venir, Annulés, **Absences non prévenues**,
  Total honoré — et l'historique des visites avec le montant **barré** sur une
  visite non honorée.
- [ ] Verdict

**BO-17 · La note interne reste interne**
- *Gestes* : ouvrir la fiche d'Alice (le seed y pose « Cliente fidèle — préfère
  les créneaux du matin. »), modifier la note, enregistrer ; puis ouvrir
  `/spa-lumiere` et la page de réservation.
- *Attendu* : la note est enregistrée et affichée au back-office ; elle
  n'apparaît **nulle part** côté public, et n'est pas rendue par la liste paginée
  des fiches.
- [ ] Verdict

**BO-18 · Les réglages de l'établissement**
- *Gestes* : en `admin@spa-lumiere.test`, « Réglages » : modifier le nom, saisir
  une adresse **incomplète** (rue sans ville), puis complète ; ajouter une plage
  d'ouverture qui en recouvre une autre le même jour.
- *Attendu* : l'adresse publique (slug) est en **lecture seule** ; l'adresse
  postale est acceptée « les trois ensemble ou rien » ; le recouvrement de deux
  plages est refusé en **422** ; « Réglages enregistrés » sur le cas nominal.
- [ ] Verdict

---

## 3. Domaine 3 — Gestion du personnel

> CDC §1.4 : comptes staff avec rôles et permissions, affectation de services par
> praticien, disponibilités et plages bloquées.

**GP-01 · Deux listes, délibérément non appariées**
- *Gestes* : « Personnel ».
- *Attendu* : une liste **Praticiens** (les fiches qui portent un agenda) et une
  liste **Comptes** (les identités et leurs rôles). La colonne « Actions » des
  comptes n'apparaît **qu'à un administrateur**. La création d'une fiche
  praticien n'est pas servie par l'API, et l'écran le dit.
- [ ] Verdict

**GP-02 · Inviter un compte, puis l'activer**
- *Gestes* : en administrateur, remplir le formulaire d'invitation (prénom, nom,
  adresse, rôle) et « Inviter ». Reprendre le **jeton** affiché et appeler
  `POST /api/v1/auth/invitations/accept` avec ce jeton et un mot de passe d'au
  moins douze caractères.
- *Attendu* : aucun mot de passe n'est saisi à l'invitation ; le jeton est rendu
  dans un champ en lecture seule ; l'acceptation ouvre une session. **Rejouer le
  même jeton une seconde fois rend 401** — l'usage est unique.
- [ ] Verdict

**GP-03 · Réémettre une invitation**
- *Gestes* : « Réémettre l'invitation » sur le compte invité mais **non encore
  activé**, puis sur un compte **déjà activé**.
- *Attendu* : un nouveau jeton dans le premier cas ; **409** dans le second.
- [ ] Verdict

**GP-04 · Changer un rôle révoque les sessions**
- *Gestes* : en administrateur, passer un compte de praticien à gérant pendant
  qu'il est connecté sur un autre navigateur. Puis tenter de changer **son
  propre** rôle.
- *Attendu* : la session de l'autre navigateur est invalidée à la requête
  suivante ; se viser soi-même rend **422**.
- [ ] Verdict

**GP-05 · Désactiver un compte**
- *Gestes* : désactiver un compte du personnel connecté ailleurs, puis le
  réactiver.
- *Attendu* : la désactivation **révoque ses sessions**, la réactivation non ; le
  bouton est **absent de sa propre ligne** (« Votre propre compte ») ; l'appel est
  idempotent.
- [ ] Verdict

**GP-06 · Les horaires hebdomadaires se remplacent en entier**
- *Gestes* : fiche de Claire F. → « Horaires hebdomadaires ». Retirer la plage de
  l'après-midi du mardi, enregistrer ; ajouter deux plages qui se **recouvrent**
  le mercredi, enregistrer.
- *Attendu* : la semaine est **remplacée**, pas fusionnée ; le total saisi est
  rappelé en tête ; le recouvrement est refusé en **422
  `OVERLAPPING_SCHEDULE_RANGES`**, avec les deux plages fautives ; « minuit » pose
  bien le littéral `24:00`.
- [ ] Verdict

**GP-07 · Le rang praticien est en lecture seule**
- *Gestes* : se connecter en `claire@spa-lumiere.test`, ouvrir sa propre fiche.
- *Attendu* : horaires et absences sont **affichés mais inertes**, avec la mention
  « réservée au rang gérant ».
- [ ] Verdict

**GP-08 · La saisie d'horaires se voit dans les créneaux proposés**
- *Gestes* : après GP-06, lire la section « Créneaux proposés » de la fiche, puis
  ouvrir le tunnel public sur la prestation de cette praticienne.
- *Attendu* : les deux montrent la **même** disponibilité — le mardi après-midi
  retiré n'y figure plus. Compter jusqu'à 60 s si le cache de disponibilité
  n'a pas encore été chassé.
- [ ] Verdict

**GP-09 · Poser une absence retire les créneaux**
- *Gestes* : « Plages bloquées et congés » : premier jour d'absence = demain,
  jour de reprise = après-demain, motif « Formation ». Puis relire le tunnel.
- *Attendu* : l'absence apparaît dans la liste ; **le jour de reprise est exclu**
  (c'est le jour où le praticien retravaille) ; les créneaux de la journée bloquée
  ont disparu du tunnel ; le motif n'apparaît **jamais** côté public.
- [ ] Verdict

**GP-10 · Retirer l'absence rend les créneaux**
- *Gestes* : « Retirer » sur l'absence posée, relire le tunnel.
- *Attendu* : les créneaux reviennent.
- [ ] Verdict

**GP-11 · Affecter et retirer des prestations**
- *Gestes* : « Prestations pratiquées » : affecter « Massage suédois 60 min » à
  Claire F., puis tenter de l'affecter une seconde fois, puis la retirer.
- *Attendu* : la seconde affectation rend **409** avec le message « Cette
  prestation lui est déjà affectée » ; après l'affectation, Claire F. **apparaît**
  dans le sélecteur de praticien du tunnel pour cette prestation ; après le
  retrait, elle en disparaît.
- [ ] Verdict

**GP-12 · Les jours de fermeture de l'établissement** *(sans écran — API)*
- *Gestes* : en gérant, `PUT /api/v1/closing-days` avec `{"weekdays":[7,6]}`,
  puis `GET`.
- *Attendu* : la lecture rend `[6,7]` — **croissants**, numérotation ISO
  (1 = lundi). Aucun créneau n'est plus proposé ces jours-là. `{"weekdays":[]}`
  rouvre sept jours sur sept. Le MVP n'expose pas cet écran : c'est une lacune
  connue, notée au §10.
- [ ] Verdict

---

## 4. Domaine 4 — Paiements

> CDC §1.4 : encaissement au checkout (carte/espèces), POS de base (services +
> produits retail), historique des ventes.
> **Contrainte non négociable n°3 : aucune donnée de carte ne touche notre code.**

**PA-01 · L'écran d'encaissement liste la journée**
- *Gestes* : « Encaissement », naviguer d'un jour à l'autre.
- *Attendu* : un tableau Heure / Cliente / Prestation / Montant / Statut ; le lien
  « encaisser ce rendez-vous » n'apparaît **que** sur un statut encaissable — pas
  sur un rendez-vous annulé.
- [ ] Verdict

**PA-02 · L'encaissement en espèces ne parle à personne**
- *Gestes* : ouvrir un rendez-vous encaissable, choisir « Espèces », encaisser.
  Observer l'onglet réseau du navigateur.
- *Attendu* : le reçu s'affiche (« Encaissement enregistré — `<montant>` »), le
  bouton « Imprimer le ticket » fonctionne, et **aucun appel n'est émis vers
  Stripe**. Le montant est celui **figé à la réservation**, relu en base.
- [ ] Verdict

**PA-03 · L'encaissement par carte passe par Stripe**
- *Gestes* : sur un autre rendez-vous, choisir « Carte », « Payer », puis saisir
  une carte de test dans le cadre Stripe et encaisser.
- *Attendu* : le champ de carte est un **iframe servi par Stripe** ; le paiement
  accepté affiche « Paiement accepté par le prestataire », explicitement
  **provisoire**.
- [ ] Verdict

**PA-04 · Aucune donnée de carte ne traverse notre API**
- *Gestes* : pendant PA-03, filtrer l'onglet réseau sur le domaine de **notre**
  API et relire chaque requête.
- *Attendu* : le seul corps émis vers notre API est
  `{"appointmentId":"<uuid>"}`. **Aucun numéro, aucun cryptogramme, aucune date
  d'expiration** ne s'y trouve, ni en requête ni en réponse. C'est le cas le plus
  important de ce domaine : un échec ici est une sortie du périmètre PCI SAQ A.
- [ ] Verdict

**PA-05 · Seul le webhook confirme le rendez-vous**
- *Gestes* : après PA-03, relire le statut du rendez-vous **avant** l'arrivée du
  webhook, puis après.
- *Attendu* : le rendez-vous reste **`pending`** tant que
  `payment_intent.succeeded` n'a pas été traité, et passe **`confirmed`** ensuite.
  Aucun autre chemin ne confirme un rendez-vous par le paiement.
- [ ] Verdict

**PA-06 · Le webhook refuse une signature invalide, et se rejoue sans dommage**
- *Gestes* : depuis le tableau de bord Stripe, renvoyer le **même** événement une
  seconde fois. Puis émettre à la main un `POST` sur
  `/api/v1/payments/webhooks/stripe` avec une signature bidon.
- *Attendu* : le rejeu est acquitté **sans second effet** (idempotence) ; la
  signature invalide rend **400** et le corps n'est jamais désérialisé. Un corps
  re-sérialisé par un outil échouera toujours : la signature porte sur le **corps
  brut**.
- [ ] Verdict

**PA-07 · Un rendez-vous ne s'encaisse pas deux fois**
- *Gestes* : rejouer l'encaissement espèces de PA-02 ; puis tenter un
  encaissement **carte** sur ce même rendez-vous.
- *Attendu* : le rejeu espèces rend le **même** règlement, tel quel ; la tentative
  carte rend **409 `PAYMENT_ALREADY_SETTLED`**.
- [ ] Verdict

**PA-08 · Un rendez-vous annulé ne s'encaisse pas**
- *Gestes* : `POST /api/v1/payments/cash` sur le rendez-vous **annulé** du seed.
- *Attendu* : **422**. À l'inverse, un rendez-vous **honoré** ou **non présenté**
  reste encaissable en espèces — c'est délibéré : la cliente absente peut devoir
  régler.
- [ ] Verdict

**PA-09 · Le remboursement est borné et tracé**
- *Préconditions* : un encaissement **carte** abouti, en gérant.
- *Gestes* : `POST /api/v1/payments/{id}/refunds` avec un montant partiel et un
  motif ; puis le solde ; puis un euro de plus ; puis un remboursement sur un
  encaissement **espèces**.
- *Attendu* : les deux premiers aboutissent ; le troisième rend **422** avec le
  **solde restant** dans `details` ; le quatrième rend **422** — les espèces ne se
  remboursent pas par ce chemin. Le motif est **obligatoire**. Le statut de
  l'encaissement passe à `PARTIALLY_REFUNDED` puis `REFUNDED` **par le webhook
  `charge.refunded`**, pas par l'appel de remboursement.
- [ ] Verdict

**PA-10 · L'historique de rapprochement**
- *Gestes* : `GET /api/v1/payments?from=…&to=…&method=CASH&status=SUCCEEDED` ;
  puis avec `from` postérieur à `to`.
- *Attendu* : la liste, plus récent d'abord, paginée ; la fenêtre inversée rend
  **422**.
- [ ] Verdict

**PA-11 · Le POS recalcule ses totaux**
- *Gestes* : `POST /api/v1/sales` sur Spa Lumière avec une ligne `SERVICE`, une
  ligne `PRODUCT` (`HUILE-ARGAN-100`) et une ligne `TIP`. Recommencer sur Barber
  Tana. Puis tenter deux lignes `TIP`, puis une ligne `TAX`.
- *Attendu* : les totaux sont **recalculés côté serveur** — taxe à 20 % chez Spa
  Lumière, **0 %** chez Barber Tana ; le pourboire est **hors assiette de taxe** ;
  deux pourboires rendent **400** ; une ligne `TAX` demandée est refusée. Aucun
  montant n'est accepté sur les lignes `SERVICE` et `PRODUCT`.
- [ ] Verdict

---

## 5. Domaine 5 — Notifications

> CDC §1.4 : confirmation automatique, rappel 24 h avant, avis d'annulation au
> staff et au client.

**NO-01 · La confirmation part à la réservation**
- *Gestes* : réserver (RC-07), puis
  `GET /api/v1/notifications?appointmentId=<id>` en praticien.
- *Attendu* : une ligne `booking_confirmation` / `email`. Une ligne
  `booking_confirmation` / `sms` **en plus** si et seulement si le compte porte un
  numéro au format international composable. Vérifier l'arrivée réelle du message
  dans la boîte de réception de recette.
- [ ] Verdict

**NO-02 · Le journal ne divulgue rien**
- *Gestes* : relire la réponse de NO-01.
- *Attendu* : type, canal, statut, dates, nombre de tentatives, motif d'échec —
  et **aucune adresse, aucun numéro, aucun contenu de message**.
- [ ] Verdict

**NO-03 · Le tiroir du planning montre les envois**
- *Gestes* : ouvrir le rendez-vous au planning, section « Messages envoyés ».
- *Attendu* : une ligne par envoi avec type, canal, badge de statut et
  horodatage **dans le fuseau du salon**. **Aucun bouton « renvoyer »**, aucun
  destinataire, aucun contenu.
- [ ] Verdict

**NO-04 · Le balayage du rappel J-1 sélectionne la bonne fenêtre**
- *Gestes* : `POST /api/v1/notifications/reminders/sweep` avec l'en-tête
  `x-internal-token`.
- *Attendu* : la réponse porte `from` et `to` distants d'**une heure**, à
  **24 heures** de l'instant présent, et la liste des messages à émettre. Le
  rendez-vous confirmé « de demain » du seed y figure **quand l'heure courante le
  place dans la fenêtre**, et pas autrement. La route **n'écrit rien et n'envoie
  rien** : elle décrit le travail.
- [ ] Verdict

**NO-05 · Les routes internes sont fermées par défaut**
- *Gestes* : rejouer NO-04 sans en-tête, puis avec un jeton faux.
- *Attendu* : **401**. Si l'API n'a **aucun** jeton configuré, la réponse est
  **503** — la route se ferme plutôt que de s'ouvrir.
- [ ] Verdict

**NO-06 · L'avis d'annulation ne revient pas à celui qui a décidé**
- *Gestes* : annuler un rendez-vous **depuis l'espace client**, relire le journal.
  Puis annuler un autre rendez-vous **depuis le back-office**, relire.
- *Attendu* : annulation par la cliente → avis au **praticien seul** ; annulation
  par le salon → avis à **la cliente et au praticien**.
- [ ] Verdict

**NO-07 · Un même message ne part pas deux fois**
- *Gestes* : provoquer deux fois le même déclenchement (par exemple deux
  balayages de rappel consécutifs sur le même rendez-vous).
- *Attendu* : **une seule** ligne vivante dans le journal, et un seul message reçu.
- [ ] Verdict

**NO-08 · Un rejet dur coupe les envois vers l'adresse**
- *Gestes* : depuis la console SES de recette, provoquer un rejet dur
  (`bounce@simulator.amazonses.com`), puis ouvrir la fiche CRM de la cliente
  concernée et tenter un nouvel envoi.
- *Attendu* : la fiche porte le bandeau **« Adresse e-mail supprimée — plus aucun
  envoi »** avec la date et le motif ; les envois e-mail suivants vers cette
  adresse sont **sautés**, sans échec.
- [ ] Verdict

**NO-09 · Les modèles se personnalisent, et se valident avant écriture**
- *Gestes* : lire un modèle
  (`GET /api/v1/notification-templates/booking_confirmation/email`), le
  personnaliser en gérant, puis tenter d'en enregistrer un qui contient une
  variable inconnue `{{inexistante}}` ou une section `{{#x}}` non refermée. Puis
  `DELETE` la personnalisation.
- *Attendu* : le modèle effectif indique son **origine** (`platform` ou `tenant`) ;
  les deux modèles fautifs sont **refusés avant écriture** ; la suppression rend
  le modèle de plateforme effectif et est idempotente.
- [ ] Verdict

---

## 6. Domaine 6 — Reporting de base

> CDC §1.4 : synthèse du revenu quotidien, volume de rendez-vous, suivi des
> no-shows.

**RE-01 · Les trois indicateurs**
- *Gestes* : en `manager@spa-lumiere.test`, « Reporting ».
- *Attendu* : **Revenu net** par devise avec « N encaissements · remboursé
  `<montant>` », **Rendez-vous** (nombre), **No-shows** (taux, et « N sur M
  arrivés à échéance »). Sans encaissement sur la période : « aucun
  encaissement », pas un zéro trompeur.
- [ ] Verdict

**RE-02 · Les périodes**
- *Gestes* : parcourir les cinq périodes, puis saisir une période personnalisée
  dont la fin précède le début.
- *Attendu* : les journées sont celles **du salon** ; la période impossible rend
  « Période impossible » **en conservant la barre de filtres** — on doit pouvoir
  corriger sans repartir de zéro.
- [ ] Verdict

**RE-03 · Le filtre est exclusif, et il le dit**
- *Gestes* : filtrer sur un praticien, puis sur une prestation.
- *Attendu* : un seul filtre à la fois ; dès qu'un filtre est posé, le bandeau
  **« Ce qu'un filtre ne peut pas ventiler »** rappelle que le revenu reste celui
  de l'établissement entier.
- [ ] Verdict

**RE-04 · Les graphiques sont doublés d'un tableau**
- *Gestes* : parcourir les graphiques au lecteur d'écran, ou inspecter le DOM.
- *Attendu* : chaque graphique SVG est accompagné d'un **tableau portant toutes
  les valeurs**, et la part « dont no-shows » est distinguée.
- [ ] Verdict

**RE-05 · Le taux de no-show a le bon dénominateur**
- *Préconditions* : sur le jeu de recette, Spa Lumière porte **un honoré** (J−7)
  et **une absence** (J−3).
- *Gestes* : période « 30 derniers jours ».
- *Attendu* : le taux vaut **50 %** — `noShows / (honored + noShows)`. Les
  annulations et les rendez-vous non encore jugés **n'entrent pas** au
  dénominateur. Sur une période sans rien à honorer, le taux est **vide**, pas
  zéro.
- [ ] Verdict

**RE-06 · L'export CSV**
- *Gestes* : « Exporter en CSV », ouvrir le fichier dans un tableur et dans un
  éditeur de texte.
- *Attendu* : le téléchargement passe par une **URL présignée** valable au plus
  **15 minutes** ; le fichier est en UTF-8 **avec BOM**, séparé par **`;`**, en
  forme longue à six colonnes `section;cle;libelle;mesure;valeur;devise` ; les
  sections `periode`, `revenu_jour`, `revenu_total`, `volume_day`, `volume_staff`,
  `volume_service`, `no_shows` sont présentes dans cet ordre ; **tous les montants
  sont des entiers** en plus petite unité, avec la devise en colonne ; le taux est
  la seule valeur non entière, et vide quand il est indéfini. Les accents
  s'affichent correctement dans le tableur.
- [ ] Verdict

**RE-07 · Un export ne traverse pas la frontière**
- *Gestes* : relever l'identifiant d'un export de Spa Lumière, puis appeler
  `GET /api/v1/reports/export/{id}` avec un jeton de **Barber Tana**.
- *Attendu* : **404** — indistinct d'un export inexistant.
- [ ] Verdict

**RE-08 · La fenêtre est bornée**
- *Gestes* : `GET /api/v1/reports/revenue` sur une fenêtre de plus de 366 jours.
- *Attendu* : **422**.
- [ ] Verdict

**RE-09 · Le reporting est réservé au rang gérant**
- *Gestes* : se connecter en `claire@spa-lumiere.test`, ouvrir « Reporting ».
- *Attendu* : l'entrée n'apparaît pas dans le rail ; l'URL forcée affiche « Accès
  réservé ».
- [ ] Verdict

---

## 7. La boucle de valeur, de bout en bout

C'est le cas du CDC §4.13, et le seul qui compte vraiment : il se joue **d'une
traite**, sur des données neuves, en chronométrant.

**BV-01 · Réserver → confirmer → honorer → encaisser → mesurer**
- *Préconditions* : environnement fraîchement semé, boîte de réception de recette
  ouverte, tableau de bord Stripe en mode test ouvert.
- *Gestes* :
  1. **Réserver** — depuis `/spa-lumiere/reservation`, en invitée, sur une adresse
     inconnue. Noter la référence et l'heure.
  2. **Confirmer** — au back-office, ouvrir le rendez-vous et le passer à
     « confirmé » ; **ou** encaisser par carte et laisser le webhook le confirmer
     (PA-05). Jouer les deux chemins au moins une fois dans la campagne.
  3. **Honorer** — le jour venu (ou en déplaçant le rendez-vous au passé),
     « Marquer honoré ».
  4. **Encaisser** — depuis « Encaissement », régler le rendez-vous, imprimer le
     ticket.
  5. **Mesurer** — ouvrir « Reporting » sur la période qui contient la journée :
     le revenu net doit avoir augmenté du montant encaissé, et le volume de
     rendez-vous d'une unité.
- *Attendu* : les cinq étapes s'enchaînent sans reprise manuelle en base ; le
  **message de confirmation est réellement reçu** ; les montants concordent à
  l'unité près entre le ticket et le reporting ; toutes les heures affichées sont
  celles du salon.
- [ ] Verdict

**BV-02 · Le même parcours, sur le second établissement**
- *Gestes* : rejouer BV-01 sur `barber-tana`, avec ses comptes.
- *Attendu* : les heures sont dans `Indian/Antananarivo`, et le ticket ne porte
  **aucune ligne de taxe** — le taux de cet établissement vaut zéro. C'est ce que
  ce second passage établit : rien n'est câblé sur le premier salon.
- [ ] Verdict

---

## 8. Charge et concurrence

Deux niveaux, et ils ne prouvent pas la même chose.

### 8.1 Ce que le dépôt mesure tout seul

```bash
npm run test:concurrency --workspace @spa/api   # la propriété : un succès par créneau
npm run test:load        --workspace @spa/api   # la mesure : débit, latences, taux de conflit
SPA_LOAD_FACTOR=5 npm run test:load --workspace @spa/api   # campagne
```

`test:concurrency` est joué à chaque pull request par la CI : il établit qu'une
course sur un créneau produit **exactement un rendez-vous**. `test:load` est
joué **délibérément**, avant une mise en production : il charge le moteur de
disponibilité et le tunnel de réservation contre un vrai PostgreSQL et **imprime
un tableau** — tentatives, abouties, refusées, débit, p50/p95/p99, taux de
conflit. Les trois scénarios du tunnel prédisent leur taux de conflit à l'unité
près (0 %, 87,5 %, 96,88 %) : un écart signale soit une double réservation, soit
une réservation perdue sur un créneau libre.

Le relevé se consigne dans la feuille de verdict (§11) et se compare à celui de
la campagne précédente. Ces tirs **ne couvrent ni le réseau, ni l'ALB, ni la
sérialisation HTTP, ni le cache Redis** : ils chargent le moteur, pas
l'application servie.

### 8.2 Ce qui reste à tirer sur l'environnement déployé

**CH-01 · Deux postes du salon se disputent le même créneau**
- *Gestes* : depuis deux navigateurs, ouvrir le tiroir de création sur le **même**
  créneau et le **même** praticien, et valider les deux le plus simultanément
  possible.
- *Attendu* : un rendez-vous, et un seul. Le perdant reçoit « Ce créneau vient
  d'être réservé » et **conserve sa saisie**.
- [ ] Verdict

**CH-02 · La limite de débit du WAF est celle de la production**
- *Gestes* : lancer une rafale soutenue sur la page publique de réservation.
- *Attendu* : la limitation se déclenche à **2 000 requêtes** par fenêtre — c'est
  la valeur de production, posée ici délibérément pour qu'un parcours de recette
  qui la déclenche la déclenche **ici** et pas chez une cliente. Une campagne de
  tirs qui doit la dépasser la relève explicitement pour sa durée, en sachant
  qu'elle change ce qu'elle mesure.
- [ ] Verdict

---

## 9. Isolation inter-tenant — transverse et bloquant

C'est la contrainte non négociable n°2. Elle se rejoue sur **chaque famille de
routes**, avec le jeton de l'établissement voisin, et la réponse attendue est
**404** — jamais 403, jamais la donnée. Un 403 confirmerait l'existence de la
ressource : c'est déjà une fuite.

Obtenir un jeton de Barber Tana (`manager@barber-tana.test`), relever un
identifiant de Spa Lumière, et rejouer :

| # | Route rejouée avec le jeton du voisin | Attendu | Verdict |
|---|---|---|---|
| IT-01 | `GET /api/v1/services/{id}` | 404 | [ ] |
| IT-02 | `GET /api/v1/customers/{id}` et `/history` | 404 | [ ] |
| IT-03 | `POST /api/v1/appointments/{id}/status` | 404 | [ ] |
| IT-04 | `GET /api/v1/staff/{id}/schedule` | 404 | [ ] |
| IT-05 | `GET /api/v1/staff-time-off/{id}` | 404 | [ ] |
| IT-06 | `POST /api/v1/payments/cash` sur un rendez-vous voisin | 404 | [ ] |
| IT-07 | `GET /api/v1/reports/export/{id}` | 404 | [ ] |
| IT-08 | `GET /api/v1/notifications?appointmentId=<voisin>` | liste **vide**, jamais la ligne | [ ] |
| IT-09 | `POST /api/v1/public/barber-tana/appointments` avec un `serviceId` de Spa Lumière | 404 | [ ] |

**IT-10 · Les deux salons peuvent porter la même adresse e-mail**
- *Gestes* : créer une cliente sur la même adresse dans les deux établissements.
- *Attendu* : les deux créations aboutissent — l'unicité de l'adresse est **par
  établissement**, et l'un ne peut pas deviner l'existence de l'autre.
- [ ] Verdict

---

## 10. Ce que ce cahier ne couvre pas, et pourquoi

Ces points ne sont **pas** des cas en échec : ils ne sont pas dans le périmètre
livré. Les consigner ici évite qu'un relecteur les prenne pour des oublis.

| Ce qui n'est pas recetté | Pourquoi |
|---|---|
| Délai, franchise ou pénalité d'annulation | **Non implémenté.** L'annulation est possible à tout moment tant que le rendez-vous est à confirmer ou confirmé ; ce qui la borne est la table des transitions, et rien d'autre |
| Lien durable d'annulation reçu par e-mail | Le tunnel n'annule que depuis son écran de confirmation, qui ne survit pas au changement d'onglet |
| Écran de caisse multi-lignes (produits, pourboire) | La logique existe côté API et côté front, **aucun écran ne l'expose** : seul l'encaissement rattaché à un rendez-vous est servi |
| Passage automatique en « honoré » après encaissement | Non servi par l'API — l'écran de reçu le dit lui-même |
| Création d'une fiche praticien | Non servie par l'API : on invite un **compte**, ce qui est autre chose |
| Écran des jours de fermeture de l'établissement | La route existe (GP-12), l'écran non |
| Abonnements, cartes cadeaux, marketing, payroll, multi-établissement, inventaire, assistant IA, marketplace | **Hors périmètre MVP** — CDC §1.4. Voir [backlog-post-mvp.md](../backlog-post-mvp.md) |

---

## 11. Feuille de verdict

À remplir et à joindre au compte rendu de campagne.

| | |
|---|---|
| Date de la campagne | |
| Commit déployé (sha) | |
| Environnement | staging |
| Recetteurs | |

| Domaine | Cas | Conformes | En échec | Non joués |
|---|---:|---:|---:|---:|
| 1 — Réservation client | 18 | | | |
| 2 — Back-office / Admin | 18 | | | |
| 3 — Gestion du personnel | 12 | | | |
| 4 — Paiements | 11 | | | |
| 5 — Notifications | 9 | | | |
| 6 — Reporting de base | 9 | | | |
| 7 — Boucle de valeur | 2 | | | |
| 8 — Charge | 2 | | | |
| 9 — Isolation inter-tenant | 10 | | | |
| **Total** | **91** | | | |

**Relevé des tirs de charge** — tableau imprimé par `npm run test:load` :

| Scénario | Tentatives | Abouties | Refusées | Débit (op/s) | p95 (ms) | Taux de conflit |
|---|---:|---:|---:|---:|---:|---:|
| Semaine complète | | | | | | |
| Journée seule | | | | | | |
| Lecture sous écriture | | | | | | |
| Débit nominal | | | | | | |
| Contention ordinaire | | | | | | 87,5 % attendu |
| Contention maximale | | | | | | 96,88 % attendu |

**Verdict de campagne** — un seul cas bloquant en échec suffit à le refuser :

- [ ] **Recette validée** — la mise en production peut être demandée
- [ ] **Recette refusée** — motif, cas en cause et correctifs attendus ci-dessous

---

*Ce cahier est vivant : toute fonctionnalité livrée y ajoute son cas, toute
régression trouvée en production y ajoute le cas qui l'aurait attrapée.*
