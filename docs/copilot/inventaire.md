# Inventaire des écrans — Copilot IA

- **Version** : 0.1 · 2026-10-08. Relevé fait sur `develop` à `7a6c2a5`.
- **Rôle du document** : dire, écran par écran et rôle par rôle, ce qu'on y fait,
  par quelle adresse, et ce que le copilot y fait. Les identifiants d'action sont
  ceux du registre `packages/shared/src/copilot/actions.ts`
  ([spécification §6.3](specification.md#63-le-registre-dactions)).
- **À tenir à jour** : un écran qui gagne un paramètre d'URL ou une action met à
  jour sa ligne ici. Une ligne marquée *(à vérifier)* est complétée par le
  ticket P0-02 du [plan](plan-implementation.md).

## Légende

**Rôle du copilot sur l'écran**

| Niveau | Sens |
|---|---|
| **Agir** | Le copilot y mène, y filtre, et peut y lancer une écriture confirmée |
| **Lire** | Il lit et résume ce que l'écran montre |
| **Guider** | Il explique l'écran et y mène ; le geste reste à l'utilisateur |
| **—** | Rien |

**Accès** : les permissions sont celles de
l'[ADR 0013](../adr/0013-matrice-de-permissions-par-role.md). `public` = sans
session ; `session` = toute identité vérifiée sur ce salon.

---

## 1. Parcours public — `(booking)`

| Écran | Route | Accès | Ce qu'on y fait | Adresse (paramètres) | Copilot | Actions |
|---|---|---|---|---|---|---|
| Vitrine | `/{salon}` | public | Présentation, catalogue des prestations, bouton « Choisir » par prestation | — | **Agir** | `salon.infos`, `catalogue.chercher`, `reservation.ouvrir_tunnel` |
| Tunnel de réservation | `/{salon}/reservation` | public | Prestation, créneau, coordonnées, récapitulatif, confirmation (Stripe si acompte) | `?etape=prestation\|creneau\|coordonnees\|recapitulatif\|confirmation` · `?prestation=<id>` · `?praticien=<id>` · `?creneau=<début>` · `?retour=` | **Agir** | `reservation.ouvrir_tunnel`, `disponibilite.creneaux` |
| Politique de données | `/{salon}/politique-donnees` | public | Finalités RGPD de l'établissement | — | **Lire** | `salon.politique_donnees` |

**Le tunnel, en détail** (`lib/booking/draft.ts`, `components/booking/`)

- Étapes : `BOOKING_STEPS = prestation → creneau → coordonnees → recapitulatif → confirmation`.
- L'état est porté par **l'adresse** (étape, prestation, praticien, créneau) et
  par un brouillon stocké. Le serveur relit l'adresse depuis #1055, donc un
  **lien profond** comme `?etape=creneau&prestation=<id>&praticien=<id>` ouvre
  directement la liste des créneaux, filtrée. La vitrine s'en sert déjà
  (`components/salon/booking-link.ts`).
- **Ce qui manque au copilot** : aucun paramètre ne porte un **jour** ni une
  **plage** (matin, après-midi, soir). « Demain après-midi » ne peut donc pas
  encore préfiltrer l'étape créneau. → ticket **P2-02** : ajouter `?jour=` et
  `?plage=` au tunnel, utilisables à la main comme par le chat.
- **Le copilot s'arrête avant le paiement.** Les étapes coordonnées,
  récapitulatif et confirmation restent à la cliente (P5).

## 2. Espace client — `(account)`

| Écran | Route | Accès | Ce qu'on y fait | Adresse (paramètres) | Copilot | Actions |
|---|---|---|---|---|---|---|
| Mes rendez-vous | `/{salon}/compte` | `CLIENT` | Rendez-vous à venir, accès au report et à l'annulation | `?annonce=` (bandeau de retour) *(à vérifier)* | **Agir** | `rendez_vous.mes_prochains`, `rendez_vous.annuler` ✋ |
| Report | `/{salon}/compte/rendez-vous/{id}/report` | `CLIENT` | Choisir un nouveau créneau pour un rendez-vous à venir | `?jours=`, `?mois=` *(à vérifier)* | **Agir** | `rendez_vous.ouvrir_report`, `rendez_vous.reporter` ✋ |
| Historique | `/{salon}/compte/historique` | `CLIENT` | Rendez-vous passés | — | **Lire** | `rendez_vous.mon_historique`, `reservation.ouvrir_tunnel` (« reprendre ») |
| Coordonnées | `/{salon}/compte/coordonnees` | `CLIENT` | Nom, e-mail, téléphone | — | **Guider** | `guide.mener` |
| Connexion | `/{salon}/compte/connexion` | public | Se connecter | `?next=`, `?motif=`, `?session=` | **Guider** | `guide.mener` |
| Inscription | `/{salon}/compte/inscription` | public | Créer son compte client | `?next=` | **Guider** | `guide.mener` |

✋ = écriture, confirmée dans le chat avant de partir.

## 3. Back-office — `(admin)`

### 3.1 Priorité 1 — ce qui fait le chiffre d'affaires

| Écran | Route | Accès | Ce qu'on y fait | Adresse (paramètres) | Copilot | Actions |
|---|---|---|---|---|---|---|
| **Calendrier** (planning salon) | `/{salon}/admin/calendrier` | `agenda:read:all` | Agenda de tout le salon, colonnes par praticien en vue jour | `?vue=jour\|semaine` · `?date=` | **Agir** | `planning.ouvrir`, `planning.creneaux_libres`, `rendez_vous.poser` ✋ (`appointment:write:all`) |
| **Mon planning** | `/{salon}/admin/mon-planning` | `agenda:read:own` | Rendez-vous, horaires et absences du praticien connecté ; marquer honoré ou absent | `?vue=` · `?date=` · `?annules=` | **Agir** | `planning.ma_journee`, `rendez_vous.marquer_honore` ✋, `rendez_vous.marquer_absent` ✋ (`appointment:write:own`) |
| **Encaissement** | `/{salon}/admin/encaissement` | `checkout:collect` | Journée à régler ; règlement déclaré au TPE (ADR 0015) ; ticket | `?date=` · `?rdv=<id>` | **Agir** (préparation seule) | `encaissement.a_regler`, `encaissement.ouvrir` — **pas** de règlement par le copilot |

### 3.2 Priorité 2 — lire et résumer

| Écran | Route | Accès | Ce qu'on y fait | Adresse (paramètres) | Copilot | Actions |
|---|---|---|---|---|---|---|
| Tableau de bord | `/{salon}/admin/tableau-de-bord` | gérance *(à vérifier)* | Quatre indicateurs du jour, prochains rendez-vous, activité de la semaine | — | **Lire** | `tableau_de_bord.resumer` |
| Reporting | `/{salon}/admin/reporting` | `reporting:read` | Indicateurs d'activité, export CSV | `?periode=` · `?du=` · `?au=` · `?filtre=` | **Lire** | `reporting.lire`, `reporting.ouvrir` |
| Clients | `/{salon}/admin/clients` | `customers:read:all` (`customers:write` pour modifier) | Recherche, liste, fiche ouverte à droite | `?recherche=` · `?fiche=<id>` · `?page=` | **Lire** | `clients.chercher`, `clients.ouvrir_fiche` |

### 3.3 Priorité 3 — guider

| Écran | Route | Accès | Ce qu'on y fait | Copilot |
|---|---|---|---|---|
| Catalogue (liste) | `/{salon}/admin/catalogue` | gérance *(à vérifier)* | Prestations, activation | **Guider** |
| Prestation | `/{salon}/admin/catalogue/{id}` · `/nouveau` | gérance *(à vérifier)* | Créer, modifier, affecter des praticiens | **Guider** |
| Rubriques | `/{salon}/admin/catalogue/rubriques` · `/{id}` | gérance *(à vérifier)* | Rubriques du catalogue, adresse publique | **Guider** |
| Aperçu public | `/{salon}/admin/catalogue/apercu` | gérance *(à vérifier)* | Le catalogue tel que la cliente le voit | **Guider** |
| Personnel (liste) | `/{salon}/admin/personnel` | `accounts:read` | Fiches praticiens, comptes | **Guider** |
| Fiche praticien | `/{salon}/admin/personnel/{id}` | `accounts:read` *(à vérifier)* | Horaires, absences, prestations, suspension | **Guider** |
| Nouveau praticien, inviter | `/{salon}/admin/personnel/nouveau` · `/inviter` | `accounts:write` | Créer une fiche, inviter un compte | **Guider** — **jamais d'action** sur les comptes ni les rôles |
| Réglages | `/{salon}/admin/reglages` | `settings:write` | Adresse, horaires, langue | **Guider** |
| Abonnement | `/{salon}/admin/abonnement` | `ADMIN` | Abonnement du salon (Stripe, ADR 0016) | **Guider** |

Toutes ces lignes passent par une seule action : `guide.mener`, avec la route
cible en paramètre. Le registre ne propose une route qu'à qui a la permission
de l'ouvrir.

### 3.4 Sans copilot

| Écran | Route | Pourquoi |
|---|---|---|
| Connexion back-office | `/{salon}/admin/connexion` | Pas de session |
| Activation d'invitation | `/{salon}/admin/invitation?token=` | Lien à jeton : rien ne doit le lire |

## 4. Hors tenant

| Écran | Route | Copilot |
|---|---|---|
| Inscription d'un salon | `/inscription` | — (hors V1) |
| Console plateforme | `/plateforme/…` | — (ADR 0012, hors V1) |

## 5. Récapitulatif des actions de la V1

| Action | Nature | Exige | Agent | Phase |
|---|---|---|---|---|
| `salon.infos` | lecture | public | Réservation | 2 |
| `salon.politique_donnees` | lecture | public | Guide | 2 |
| `catalogue.chercher` | lecture | public | Réservation | 2 |
| `disponibilite.creneaux` | lecture | public | Réservation | 2 |
| `reservation.ouvrir_tunnel` | navigation | public | Réservation | 2 |
| `guide.mener` | navigation | selon la route | Guide | 2 |
| `rendez_vous.mes_prochains` | lecture | session (`CLIENT`) | Rendez-vous | 3 |
| `rendez_vous.mon_historique` | lecture | session (`CLIENT`) | Rendez-vous | 3 |
| `rendez_vous.ouvrir_report` | navigation | session (`CLIENT`) | Rendez-vous | 3 |
| `rendez_vous.reporter` ✋ | écriture | session (`CLIENT`) | Rendez-vous | 3 |
| `rendez_vous.annuler` ✋ | écriture | session (`CLIENT`) | Rendez-vous | 3 |
| `planning.ma_journee` | lecture | `agenda:read:own` | Rendez-vous | 3 |
| `rendez_vous.marquer_honore` ✋ | écriture | `appointment:write:own` | Rendez-vous | 3 |
| `rendez_vous.marquer_absent` ✋ | écriture | `appointment:write:own` | Rendez-vous | 3 |
| `planning.ouvrir` | navigation | `agenda:read:all` | Rendez-vous | 3 |
| `planning.creneaux_libres` | lecture | `agenda:read:all` | Rendez-vous | 3 |
| `rendez_vous.poser` ✋ | écriture | `appointment:write:all` | Rendez-vous | 3 |
| `encaissement.a_regler` | lecture | `checkout:collect` | Encaissement | 4 |
| `encaissement.ouvrir` | navigation | `checkout:collect` | Encaissement | 4 |
| `tableau_de_bord.resumer` | lecture | gérance *(à vérifier)* | Encaissement et reporting | 4 |
| `reporting.lire` | lecture | `reporting:read` | Encaissement et reporting | 4 |
| `reporting.ouvrir` | navigation | `reporting:read` | Encaissement et reporting | 4 |
| `clients.chercher` | lecture | `customers:read:all` | Clients | 4 |
| `clients.ouvrir_fiche` | navigation | `customers:read:all` | Clients | 4 |

Chaque action **lecture** ou **écriture** s'appuie sur un endpoint existant de
l'API. Le ticket P0-02 en relève le chemin exact, ligne par ligne. Une action
sans endpoint existant ne se code pas en contournant l'API : elle ouvre un
ticket dans le module concerné.
