# Inventaire des écrans — Copilot IA

- **Version** : 0.2 · 2026-10-19. Écrans relevés sur `develop` à `7a6c2a5` ;
  accès, paramètres et endpoints vérifiés dans le code à `053eeb4` (P0-02, #1446).
- **Rôle du document** : dire, écran par écran et rôle par rôle, ce qu'on y fait,
  par quelle adresse, et ce que le copilot y fait. Les identifiants d'action sont
  ceux du registre `packages/shared/src/copilot/actions.ts`
  ([spécification §6.3](specification.md#63-le-registre-dactions)).
- **À tenir à jour** : un écran qui gagne un paramètre d'URL ou une action met à
  jour sa ligne ici. Les lignes autrefois marquées *(à vérifier)* ont été
  vérifiées par le ticket P0-02 du [plan](plan-implementation.md).

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
session ; `session` = toute identité vérifiée sur ce salon ; `rang ≥ X` = garde
de l'API par rôle (`@AuthAtLeast`) plutôt que par permission. Côté web, seules
les pages Calendrier et Encaissement vérifient une permission
(`redirectWithoutPermission`) ; les autres pages du back-office n'exigent qu'une
session, et la frontière réelle est l'API (§6).

---

## 1. Parcours public — `(booking)`

| Écran | Route | Accès | Ce qu'on y fait | Adresse (paramètres) | Copilot | Actions |
|---|---|---|---|---|---|---|
| Vitrine | `/{salon}` | public | Présentation, catalogue des prestations, bouton « Choisir » par prestation | — | **Agir** | `salon.infos`, `catalogue.chercher`, `reservation.ouvrir_tunnel` |
| Tunnel de réservation | `/{salon}/reservation` | public | Prestation, créneau, coordonnées, récapitulatif, confirmation (Stripe si acompte) | `?etape=prestation\|creneau\|coordonnees\|recapitulatif\|confirmation` · `?prestation=<id>` · `?praticien=<id>` · `?creneau=<début UTC>` · `?jour=AAAA-MM-JJ` · `?plage=matin\|apres-midi\|soir` | **Agir** | `reservation.ouvrir_tunnel`, `disponibilite.creneaux` |
| Politique de données | `/{salon}/politique-donnees` | public | Finalités RGPD de l'établissement | — | **Lire** | `salon.politique_donnees` |

**Le tunnel, en détail** (`lib/booking/draft.ts`, `components/booking/`)

- Étapes : `BOOKING_STEPS = prestation → creneau → coordonnees → recapitulatif → confirmation`.
- L'état est porté par **l'adresse** (étape, prestation, praticien, créneau) et
  par un brouillon stocké. Le serveur relit l'adresse depuis #1055, donc un
  **lien profond** comme `?etape=creneau&prestation=<id>&praticien=<id>` ouvre
  directement la liste des créneaux, filtrée. La vitrine s'en sert déjà
  (`components/salon/booking-link.ts`).
- `?jour=` ouvre l'étape créneau sur ce jour, `?plage=` n'en garde que les
  créneaux du matin (avant 12 h), de l'après-midi (12 h à 18 h) ou du soir,
  **dans le fuseau du salon** (P2-02, `lib/booking/slot-view.ts`). Ce sont des
  filtres d'affichage, hors du brouillon. La rangée « Toute la journée · Matin ·
  Après-midi · Soir » les pose à la main : « demain après-midi » demandé au chat
  et le même filtre posé au clic donnent la même adresse et le même écran.
- Toute valeur illisible est ignorée (`lib/booking/draft.ts`). Le tunnel ne lit
  pas `?retour=` : il l'**émet** vers la connexion et l'inscription de l'espace
  client.
- **Le copilot s'arrête avant le paiement.** Les étapes coordonnées,
  récapitulatif et confirmation restent à la cliente (P5).

## 2. Espace client — `(account)`

| Écran | Route | Accès | Ce qu'on y fait | Adresse (paramètres) | Copilot | Actions |
|---|---|---|---|---|---|---|
| Mes rendez-vous | `/{salon}/compte` | `CLIENT` | Rendez-vous à venir, accès au report et à l'annulation | `?session=renouvelee` seulement (marqueur de renouvellement) ; l'annonce d'un report passe par une région `aria-live`, pas par l'adresse | **Agir** | `rendez_vous.mes_prochains`, `rendez_vous.annuler` ✋ |
| Report | `/{salon}/compte/rendez-vous/{id}/report` | `CLIENT` | Choisir un nouveau créneau pour un rendez-vous à venir | `?mois=` (mois affiché, mois courant si invalide) | **Agir** | `rendez_vous.ouvrir_report`, `rendez_vous.reporter` ✋ |
| Historique | `/{salon}/compte/historique` | `CLIENT` | Rendez-vous passés | — | **Lire** | `rendez_vous.mon_historique`, `reservation.ouvrir_tunnel` (« reprendre ») |
| Coordonnées | `/{salon}/compte/coordonnees` | `CLIENT` | Nom, e-mail, téléphone | — | **Guider** | `guide.mener` |
| Connexion | `/{salon}/compte/connexion` | public | Se connecter | `?retour=` · `?motif=` | **Guider** | `guide.mener` |
| Inscription | `/{salon}/compte/inscription` | public | Créer son compte client | `?retour=` | **Guider** | `guide.mener` |

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
| Tableau de bord | `/{salon}/admin/tableau-de-bord` | `reporting:read` (menu) ; API : `agenda:read:all` et rang ≥ `MANAGER` | Quatre indicateurs du jour, prochains rendez-vous, activité de la semaine | — | **Lire** | `tableau_de_bord.resumer` |
| Reporting | `/{salon}/admin/reporting` | `reporting:read` | Indicateurs d'activité, export CSV | `?periode=` · `?du=` · `?au=` · `?filtre=` | **Lire** | `reporting.lire`, `reporting.ouvrir` |
| Clients | `/{salon}/admin/clients` | `customers:read:all` (`customers:write` pour modifier) | Recherche, liste, fiche ouverte à droite | `?recherche=` · `?fiche=<id>` · `?page=` | **Lire** | `clients.chercher`, `clients.ouvrir_fiche` |

### 3.3 Priorité 3 — guider

| Écran | Route | Accès | Ce qu'on y fait | Copilot |
|---|---|---|---|---|
| Catalogue (liste) | `/{salon}/admin/catalogue` | rang ≥ `STAFF` en lecture, ≥ `MANAGER` pour gérer | Prestations, activation | **Guider** |
| Prestation | `/{salon}/admin/catalogue/{id}` · `/nouveau` | rang ≥ `STAFF` en lecture, ≥ `MANAGER` pour créer ou modifier | Créer, modifier, affecter des praticiens | **Guider** |
| Rubriques | `/{salon}/admin/catalogue/rubriques` · `/{id}` | rang ≥ `STAFF` en lecture, ≥ `MANAGER` pour gérer | Rubriques du catalogue, adresse publique | **Guider** |
| Aperçu public | `/{salon}/admin/catalogue/apercu` | session (lit l'API publique) | Le catalogue tel que la cliente le voit | **Guider** |
| Personnel (liste) | `/{salon}/admin/personnel` | `accounts:read` | Fiches praticiens, comptes | **Guider** |
| Fiche praticien | `/{salon}/admin/personnel/{id}` | `accounts:read` (menu) ; API : rang ≥ `STAFF` en lecture, ≥ `MANAGER` en écriture | Horaires, absences, prestations, suspension | **Guider** |
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

| Action | Nature | Exige | Endpoint (préfixe `/api/v1`) | Agent | Phase |
|---|---|---|---|---|---|
| `salon.infos` | lecture | public | `GET /public/:slug` | Réservation | 2 |
| `salon.politique_donnees` | lecture | public | aucun : texte du front (`lib/booking/consent.tsx`) et `GET /public/:slug` | Guide | 2 |
| `catalogue.chercher` | lecture | public | `GET /public/:slug/services` (sans filtre : le tri se fait côté copilot) | Réservation | 2 |
| `disponibilite.creneaux` | lecture | public | `GET /public/:slug/availability?serviceId&staffId&from&to` | Réservation | 2 |
| `reservation.ouvrir_tunnel` | navigation | public | — (adresse du tunnel) | Réservation | 2 |
| `guide.mener` | navigation | selon la route | — (adresse cible) | Guide | 2 |
| `rendez_vous.mes_prochains` | lecture | session (`CLIENT`) | `GET /appointments/mine?scope=upcoming` | Rendez-vous | 3 |
| `rendez_vous.mon_historique` | lecture | session (`CLIENT`) | `GET /appointments/mine?scope=past` | Rendez-vous | 3 |
| `rendez_vous.ouvrir_report` | navigation | session (`CLIENT`) | — (`/compte/rendez-vous/{id}/report?mois=`) | Rendez-vous | 3 |
| `rendez_vous.reporter` ✋ | écriture | session (`CLIENT`) | `POST /public/:slug/appointments/:id/reschedule` | Rendez-vous | 3 |
| `rendez_vous.annuler` ✋ | écriture | session (`CLIENT`) | `POST /public/:slug/appointments/:id/cancel` | Rendez-vous | 3 |
| `planning.ma_journee` | lecture | `agenda:read:own` | `GET /me/appointments?from&to` | Rendez-vous | 3 |
| `rendez_vous.marquer_honore` ✋ | écriture | `appointment:write:own` | `POST /appointments/:id/status` `{status: completed}` | Rendez-vous | 3 |
| `rendez_vous.marquer_absent` ✋ | écriture | `appointment:write:own` | `POST /appointments/:id/status` `{status: no_show}` | Rendez-vous | 3 |
| `planning.ouvrir` | navigation | `agenda:read:all` | — (`/admin/calendrier?vue&date`) | Rendez-vous | 3 |
| `planning.creneaux_libres` | lecture | `agenda:read:all` | `GET /availability?serviceId&staffId&from&to` (rang ≥ `STAFF`) | Rendez-vous | 3 |
| `rendez_vous.poser` ✋ | écriture | `appointment:write:all` | `POST /appointments` | Rendez-vous | 3 |
| `encaissement.a_regler` | lecture | `checkout:collect` | composé : `GET /appointments` + `GET /payments` + `GET /sales?appointmentId` | Encaissement | 4 |
| `encaissement.ouvrir` | navigation | `checkout:collect` | — (`/admin/encaissement?date&rdv`) | Encaissement | 4 |
| `tableau_de_bord.resumer` | lecture | `reporting:read` (API : `agenda:read:all` et rang ≥ `MANAGER`) | composé : `GET /appointments`, `GET /reports/revenue`, `/reports/appointments`, `/reports/no-shows` | Encaissement et reporting | 4 |
| `reporting.lire` | lecture | `reporting:read` (API : rang ≥ `MANAGER`) | `GET /reports/revenue` · `/reports/appointments?groupBy` · `/reports/no-shows` (rang ≥ `MANAGER`) | Encaissement et reporting | 4 |
| `reporting.ouvrir` | navigation | `reporting:read` (API : rang ≥ `MANAGER`) | — (`/admin/reporting?periode&du&au`) | Encaissement et reporting | 4 |
| `clients.chercher` | lecture | `customers:read:all` | `GET /customers?q&page&pageSize` | Clients | 4 |
| `clients.ouvrir_fiche` | navigation | `customers:read:all` | — (`/admin/clients?fiche=<id>`) | Clients | 4 |

Chaque action **lecture** ou **écriture** s'appuie sur un endpoint existant de
l'API ; le préfixe réel est `/api/v1` (`apps/api/src/bootstrap.ts`). Une action
sans endpoint existant ne se code pas en contournant l'API : elle ouvre un
ticket dans le module concerné. Deux actions **composent** des endpoints
existants au lieu d'en appeler un seul, exactement comme le font leurs pages :
`encaissement.a_regler` (comme `admin/encaissement/page.tsx`, avec
`isSettleable` et `amountDue` de `lib/admin/checkout-summary.ts`) et
`tableau_de_bord.resumer` (comme `admin/tableau-de-bord/page.tsx`). Le copilot
réutilise ces fonctions du front plutôt que d'en écrire une copie.

## 6. Ce que P0-02 a relevé dans le code

### 6.1 Session, pour P1-05

| Élément | Fait |
|---|---|
| Qui est connecté | `GET /api/v1/auth/me` → `authenticatedAccountSchema` (`packages/shared/src/schemas/identity.ts`) : id, e-mail, rôle, nom, téléphone, langue, `permissions[]`, `billing?`. **Aucun champ tenant** : le tenant est dans le JWT, et l'API rend 401 si celui-ci contredit le slug de l'URL. |
| Jeton | L'API ne lit que `Authorization: Bearer` (`identity/jwt-auth.guard.ts`). Le front l'envoie **depuis le serveur seulement** (`lib/api-client.ts`, `authorizedRequest`). |
| Cookies du back-office | `spa_admin_access` et `spa_admin_refresh`, httpOnly, `path=/{slug}/admin` (`app/(admin)/[tenantSlug]/admin/session.ts`). |
| Cookies de l'espace client | `spa_account_access` et `spa_account_refresh`, httpOnly, `path=/{slug}/compte` (`app/(account)/[tenantSlug]/compte/session.ts`). |
| Renouvellement | Accès expiré mais refresh présent : passage par `/{slug}/admin/session/refresh?next=` ou `/{slug}/compte/session/refresh?next=`, retour marqué `?session=renouvelee`. Côté action serveur : `accessTokenForAction` (`lib/session-refresh.ts`). |

**Conséquence pour la route du copilot** (d'abord `/api/copilotkit`, au spike). Les deux paires de
cookies sont posées sur des chemins (`/{slug}/admin`, `/{slug}/compte`) que la
route n'emprunte pas : **le navigateur ne les lui envoie pas**. P1-05 doit donc
servir la route sous chacun de ces chemins, ou passer la session par un autre
canal, côté serveur. Elle ne doit jamais faire transiter le jeton par le
navigateur ni par le modèle.

### 6.2 Écarts entre la matrice et le code

Ils ne bloquent pas la V1, mais le registre (P1-02) doit les connaître.
L'action exige ce que dit le §5, et l'API reste la seule frontière.

| Écart | Effet sur le copilot |
|---|---|
| `reporting:read`, `settings:write` et `accounts:write` ne sont portées par aucun `@AuthWith` : `/reports/*` est gardé par le rang `MANAGER`, `/tenant` par `ADMIN`. | Aucun aujourd'hui : la matrice donne ces permissions aux mêmes rôles. |
| `GET /availability` (back-office) est gardé par le rang `STAFF`, pas par `agenda:read:all`. | Le registre exige `agenda:read:all` pour `planning.creneaux_libres` : il est plus strict que l'API, ce qui est voulu. |
| Le catalogue et le personnel sont gardés par rang (`@AuthAtLeast`), et leurs pages ne vérifient qu'une session. | `guide.mener` filtre les routes par permission **et** par rang. |
| Les types de réponse du reporting (`DailyRevenueReportDto`, `AppointmentVolumeReportDto`, `NoShowReportDto`) **ne sont pas dans `packages/shared`** : le web les redéclare dans `lib/admin/reporting-contract.ts`. | À corriger avant P4-01 (règle « les types d'API vivent dans `packages/shared` »). |
| `salon.politique_donnees` n'a pas d'endpoint : la page assemble des textes du front et `GET /public/:slug`. | Le spécialiste Guide lit la même source que la page, sans endpoint nouveau. |
| `catalogue.chercher` : `GET /public/:slug/services` n'accepte aucun filtre. | La recherche par nom ou par famille se fait sur la liste complète, côté serveur du copilot. |
