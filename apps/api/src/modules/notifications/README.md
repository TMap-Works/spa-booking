# Module `notifications`

Confirmations, rappels J-1 et avis d'annulation (CDC §2.3). Trois messages, deux
canaux, rien de plus — le marketing et les campagnes sont hors périmètre MVP.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #68 | La table `notifications` complétée, l'**index unique partiel** qui porte l'idempotence, l'ordre d'écriture `PENDING → fournisseur → SENT`, et la reprise d'un envoi échoué |
| #70 | La **confirmation de réservation** — abonnement à `appointment.created`, rendu du message (récapitulatif, lien d'annulation, heure dans le fuseau du salon), choix des canaux, et `GET /notifications` pour le back-office |
| #71 | Le **rappel J-1** — la fenêtre `[+24 h, +25 h)` en UTC, le balayage inter-tenant, la revérification du rendez-vous au moment de l'envoi, le modèle de rappel, et la route interne que le planning EventBridge appelle |
| #73 | Les **rebonds et les plaintes** — le classement des événements de remise SES, la suppression des adresses mortes dans tous les établissements qui les connaissent, et le respect de cette suppression aux trois endroits qui composent ou expédient un e-mail |

À venir : les passerelles SES et SNS, les modèles de message par établissement
(#69) et l'avis d'annulation (#72).

## Les rebonds et les plaintes (#73)

```
SES ──► topic spa-{env}-ses-events ──► SQS ──► Lambda ──► POST /notifications/delivery-events
 (Bounce, Complaint,                                                    │
  Reject, Rendering Failure)                                    ce module : classement
                                                                        │
                                                      users.email_suppressed_at ◄─┘
```

Le ticket répond à une phrase du CDC §6 : « continuer à écrire à une adresse
morte dégrade la réputation d'envoi de tout le domaine ». Le mot **domaine** est
ce qui rend le traitement inter-tenant : la réputation SES est partagée par tous
les établissements, et un salon qui écrit à une boîte inexistante fait finir en
spam les rappels J-1 de tous les autres.

### Les trois issues, et pourquoi trois et pas deux

`delivery-event.ts` est une fonction pure, sans base ni horloge, et c'est là que
se prend la seule décision qui ne dépende d'aucun état.

| Issue | Ce qu'elle veut dire | Effet en base |
|---|---|---|
| `suppress` | rebond **permanent** ou plainte — l'adresse est morte, ou son titulaire ne veut plus rien recevoir | l'adresse cesse d'être sollicitée |
| `transient` | rebond `Transient` ou `Undetermined`, retard de livraison | rien |
| `ignored` | `Reject`, `Rendering Failure`, remise, ouverture — l'événement ne dit rien de l'adresse | rien |

`Reject` et `Rendering Failure` sont définitifs mais **innocents** : SES a refusé
le message ou n'a pas su rendre le modèle, et supprimer l'adresse punirait la
cliente d'un défaut qui est le nôtre.

`Undetermined` est traité comme transitoire, délibérément : dans le doute, on
préfère réécrire une fois de trop à une adresse peut-être vivante plutôt que
couper définitivement les confirmations d'une cliente sur une réponse SMTP que
SES lui-même n'a pas su interpréter.

### La suppression est portée par `users`, pas par une table

Deux colonnes nullables — `email_suppressed_at` et `email_suppression_reason` —
et rien d'autre. Une table `email_suppressions` aurait dû **recopier l'adresse**
pour être utile : une liste de suppression se consulte par adresse, et sans la
colonne `email` elle n'aurait su répondre qu'« ce compte-ci est supprimé », ce que
deux colonnes disent déjà sans dupliquer une donnée personnelle dans une seconde
table à faire vivre au même rythme (RGPD, CDC §5.1).

C'est aussi ce qui donne l'isolation gratuitement : la ligne `users` porte déjà
son `tenant_id` non nullable, et l'unique `(tenant_id, email)` de la migration
initiale **est** la clé de lecture dont l'ingestion a besoin.

### L'ingestion traverse les établissements ; ses écritures ne le font pas

Un événement SES ne porte que des adresses. Pas d'établissement, pas de compte :
SES ne connaît rien de notre découpage. Or la même personne peut être cliente de
trois salons, et sa fiche existe alors trois fois.

`DeliveryEventRepository` est donc le **second et dernier** endroit du module où
le client non scopé est injecté — comme `ReminderSweepRepository`, et sous la
même discipline : la dérogation s'arrête à une liste d'identifiants de tenants,
et toute lecture ou écriture de `users` passe par le client scopé, dans une
portée ouverte établissement par établissement.

### « N'est plus jamais sollicitée » se tient en trois endroits

Le mot **jamais** est ce qui impose le troisième.

| Où | Quand | Ce que cela évite |
|---|---|---|
| `findRecipientContact` | le producteur compose les canaux d'une confirmation | aucune enveloppe e-mail n'est publiée |
| `ReminderSweepRepository.findDueAppointments` | le balayage horaire sélectionne | la file ne se remplit pas de rappels sans objet |
| `NotificationDispatchService.emailSuppressed` | juste avant l'appel au fournisseur | le rebond tombé **entre** la publication et la consommation |

Le troisième n'est pas une redite : entre la composition et l'appel à SES il y a
une file, une Lambda, un appel HTTP et jusqu'à cinq réceptions. Et le cas est le
plus probable des trois — un rebond arrive *après* un envoi, donc précisément
quand la chaîne travaille.

Le canal SMS n'est concerné par aucun des trois : SES ne dit rien d'un numéro de
téléphone, et SNS n'expose pas d'équivalent au périmètre du MVP.

### Le corps de la route n'est pas validé

`POST /api/v1/notifications/delivery-events` reçoit le JSON de SES tel quel,
l'enveloppe SNS ayant été retirée par la remise brute. Ce corps ne nous
appartient pas : nous ne le dessinons pas, nous ne le versionnons pas, et AWS y
ajoute des champs sans prévenir. Le valider contre un schéma de notre cru ferait
rejeter en 400 le premier rebond enrichi — lequel finirait en file d'attente
morte. La lecture est donc défensive, et ce qui ne se lit pas rend
`outcome: "unreadable"` avec un statut **200** : rien ne se répare en rejouant un
message que rien ne réparera.

### Ce que le ticket ne fait pas

- **Il ne touche à aucune ligne de `notifications`.** Un rebond arrive *après*
  l'envoi : la ligne est déjà `SENT`, et la repasser en `FAILED` réécrirait
  l'histoire — le message *est* parti, c'est sa remise qui a échoué.
- **Il ne remet aucune adresse en service.** Une adresse supprimée le reste. Le
  jour où une route permettra de modifier `users.email`, elle devra remettre les
  deux colonnes à nul : la suppression porte sur une **adresse**, et une nouvelle
  adresse n'a rien fait pour la mériter.
- **Il n'affiche rien sur la fiche cliente.** Le quatrième critère d'acceptation
  demande au back-office de signaler une adresse supprimée ; cela relève du
  module `crm`, qui sert `GET /customers/:id`, et du contrat partagé. Une issue
  de suivi le porte.

## Le rappel J-1, de bout en bout (#71)

```
EventBridge Scheduler        Lambda de balayage              ce module
 cron(0 * * * ? *) UTC              │                            │
        │                           │                            │
        └──── invoke ───────────────┤                            │
                                    ├── POST /notifications/reminders/sweep ──┐
                                    │                            │            │
                                    │                    ReminderSweepService │
                                    │                    · fenêtre [+24, +25) │
                                    │                    · une portée par salon
                                    │                    · une enveloppe par canal
                                    │                            │            │
                                    ◄──────── enveloppes ────────┘◄───────────┘
                                    │
                                    └── SendMessageBatch ──► SQS ──► Lambda d'envoi
                                                                          │
                                                                 NotificationDispatchService
                                                                 · revérifie le rendez-vous
                                                                 · claim → render → send → SENT
```

### Les quatre critères, et où chacun se décide

| Critère | Où | Ce qui le prouve |
|---|---|---|
| fenêtre `now+24h → now+25h` **en UTC** | `reminder-window.ts` | `__tests__/reminder-window.spec.ts` |
| un rendez-vous pris à moins de 24 h n'a jamais de rappel | `reminder-window.ts` | la même suite : l'écart ne fait que décroître, et vingt-quatre balayages successifs sont éprouvés |
| revérification du statut **au moment de l'envoi** | `NotificationDispatchService.reminderStillDue` | `__tests__/notification-dispatch.service.spec.ts` |
| aucun rappel envoyé en retard | `reminderTiming` | la même suite, et l'écart de tolérance y est nommé |

### La fenêtre est en UTC, et il n'y a rien à convertir

`reminder-window.ts` ne manipule que des `Date`, c'est-à-dire des **instants**.
Il n'appelle ni `getHours()`, ni `Intl` : « dans 24 heures » vaut 24 heures
partout, y compris la nuit où le salon en vit 23 ou 25. C'est le rendu du
message, et lui seul, qui passe par le fuseau de l'établissement.

### Le balayage est inter-tenant ; ses lectures ne le sont pas

`ReminderSweepRepository` est le seul fichier du module qui injecte le client non
scopé — et il ne s'en sert que pour lire **la liste des identifiants de salons**.
Les rendez-vous, eux, se lisent salon par salon, dans une portée ouverte par
`ReminderSweepService`, exactement comme dans une requête HTTP.

Deux raisons, et la seconde n'est pas la moindre : une requête inter-tenant sur
`starts_at` aurait été un parcours complet de table — tous les index
d'`appointments` sont préfixés de `tenant_id` — et elle aurait mis dans la chaîne
d'envoi un `where` écrit à la main dont l'oubli serait une fuite.

### La revérification à l'envoi passe avant la prise de droit

Un rappel supprimé ne laisse **aucune ligne**. La placer après `claim()` aurait
inscrit un `PENDING` qu'il aurait fallu défaire, et le seul statut disponible
pour cela est `FAILED` — qui affiche « échec » au comptoir pour une décision qui
n'en est pas un. Le schéma ne connaît pas de `SUPPRESSED`, et l'ajouter serait
une migration.

Elle ne rouvre aucune fenêtre d'idempotence : la prise de droit précède toujours
l'appel au fournisseur.

### Ce que la route interne n'est pas

`POST /api/v1/notifications/reminders/sweep` n'écrit rien, n'envoie rien, et
n'est pas une route de back-office. Elle est gardée par un **jeton partagé**
(`x-internal-token`), pas par un rôle : l'appelant est une fonction Lambda sans
compte, sans rôle et sans établissement, et le balayage les traverse tous. Voir
`internal-caller.guard.ts`, qui explique aussi pourquoi la comparaison se fait à
temps constant sur des condensats.

Sans jeton configuré, elle répond **503** — défaut fermé. C'est le même régime
que `UnconfiguredNotificationSender`, et non un refus de démarrer : une variable
de notifications n'a pas à conditionner le démarrage des sept autres modules.

## La confirmation, de bout en bout (#70)

```
appointments.service           notifications
       │                             │
   COMMIT                            │
       │                             │
       ├─ appointmentCreated() ──────┤ BookingConfirmationListener
       │   (bus en mémoire, #37)     │   runWithTenant(event.tenantId)
       │                             │   canaux = f(coordonnées du compte)
       │                             │
       │                             ├─ dispatch(EMAIL) ─┐
       │                             └─ dispatch(SMS) ───┤ NotificationDispatchService
       │                                                 │   1. claim()   → PENDING
       │                                                 │   2. render()  → contenu
       │                                                 │   3. send()    → SES/SNS
       │                                                 │   4. markSent()→ SENT
```

### Ce que l'abonnement garantit

**Aucune réservation n'échoue parce qu'un message n'est pas parti.** Trois
barrières, et chacune ferme un mode de défaillance distinct :

| Barrière | Ce qu'elle rattrape |
|---|---|
| `AppointmentEvents.subscribe` | la levée synchrone **et** le rejet différé d'un abonné `async` |
| `BookingConfirmationListener.handle` | tout ce que la portée de tenant englobe |
| `dispatchOne` | l'échec d'un canal, qui ne doit pas priver le suivant de son tour |

La troisième n'est pas redondante : sans elle, un SMS en échec interromprait la
boucle et l'e-mail — celui qui porte la preuve du rendez-vous — ne partirait
jamais.

### Le choix des canaux

L'e-mail part **toujours** : `notificationPreferencesSchema` du contrat partagé
pose la règle — « le SMS se désactive, l'e-mail non » — et elle tient à ce que la
confirmation est la preuve du rendez-vous.

Le SMS ne part que si `users.phone` porte un numéro **E.164 exploitable**
(`isDialableNumber`). C'est la seule préférence que le schéma sache exprimer :
`users.sms_enabled` n'existe pas, et l'ajouter demanderait une migration. Un
`06 12 34 56 78` n'a pas de sens pour SNS, qui ne connaît pas le pays d'où il est
composé ; l'envoyer produirait un échec permanent, facturé.

`marketing_consent` **n'entre pas** dans la décision : une confirmation relève de
l'exécution du contrat (CDC §5.1), pas de la prospection.

### Le rendu, et pourquoi il a lieu si tard

Le contenu est composé **entre** la prise de droit et l'appel au fournisseur, par
`NOTIFICATION_RENDERER`. Ni avant — un rejeu nominal ne doit rien lire — ni
ailleurs : un message de file survit à sa file, et un contenu figé à la
publication annoncerait une heure plus tard un rendez-vous qui n'existe plus.

Un échec de rendu est traité exactement comme un échec d'expédition : inscrit
`FAILED`, puis relevé. Sans cela la ligne resterait `PENDING`, donc vivante dans
`notifications_live_once`, et le rejeu serait pris pour un doublon.

### Les données personnelles ne persistent nulle part

La règle du module n'est pas « aucune donnée personnelle nulle part » — un e-mail
de confirmation sans nom ni prestation ne serait pas une confirmation. Elle est
**aucune donnée personnelle qui persiste** :

| Où | Ce qu'on y trouve |
|---|---|
| `notifications` (table) | des identifiants, un statut, un motif d'échec |
| `NotificationMessage` (file) | des identifiants |
| journal structuré | l'identifiant de notification et celui du fournisseur |
| `AppointmentMessageContext` | tout le reste — **relu à chaque tentative, jamais conservé** |

## `GET /api/v1/notifications`

Le journal d'envois du back-office, derrière `@AuthAtLeast('STAFF')` : la
question « ma cliente dit n'avoir rien reçu » se pose au comptoir, pendant que la
cliente attend.

Filtres : `appointmentId`, `type`, `channel`, `statuses` — exactement ceux de
`notificationListQuerySchema`, et pas un de plus. Le vocabulaire de la route est
celui du contrat partagé, en minuscules ; la conversion vers l'énumération
PostgreSQL vit dans `dto/list-notifications.dto.ts`.

**Aucun verbe d'écriture**, et notamment aucun « renvoyer » : la reprise
appartient à SQS et à son backoff natif (notifications §4). Un bouton au comptoir
doublerait la file et masquerait la profondeur de DLQ sur laquelle repose
l'alarme de supervision.

## Le problème que ce module résout

SQS garantit **au-moins-une-fois**, jamais exactement-une-fois. Une livraison se
répète parce que la Lambda a dépassé son délai de visibilité, parce que le
balayage horaire du rappel se chevauche, ou sans raison visible. L'idempotence
est donc notre responsabilité, pas celle de la file (notifications §2).

Et elle ne peut pas être portée par le code. « Existe-t-il déjà une
notification ? sinon, en créer une » est structurellement faux sous concurrence :
deux consommateurs lisent tous les deux « non », insèrent tous les deux,
appellent tous les deux SES. C'est le même défaut que la vérification applicative
de disponibilité qu'ADR 0002 interdit au moteur de réservation, et il se règle de
la même façon — **la base tranche, le code traduit**.

## Les deux uniques, et ce qui les distingue

| Unique | Ce qu'il identifie | Portée |
|---|---|---|
| `notifications_tenant_id_dedupe_key_key` | **la livraison** — « ce message SQS-là, une fois » | tous les statuts |
| `notifications_live_once` | **la donnée** — « ce rappel-là, une fois » | `PENDING` et `SENT` seulement |

Le premier vient de la migration initiale et dépend de la façon dont le
producteur compose sa clé. Le second est posé par #68 :

```sql
CREATE UNIQUE INDEX "notifications_live_once"
  ON "notifications" ("tenant_id", "appointment_id", "type", "channel")
  WHERE "status" IN ('PENDING', 'SENT');
```

Il ne dépend d'aucune convention de clé : deux producteurs qui ne se coordonnent
pas — l'événement `appointment.confirmed` d'un côté, le balayage EventBridge de
l'autre — composeraient deux `dedupe_key` différentes pour un même rappel. Le
premier unique laisserait passer les deux ; celui-ci les sérialise.

Prisma n'exprime pas les index partiels : il est écrit en SQL brut dans
`prisma/migrations/20260906120000_add_notification_idempotency`, dont l'en-tête
détaille chaque décision (api-module §6).

### Pourquoi `FAILED` n'occupe pas la place

C'est le point le plus important du `WHERE`. Un échec transitoire — throttling
SES, panne fournisseur — doit pouvoir se réessayer. Si `FAILED` occupait la
place, la première erreur réseau condamnerait le rappel pour de bon : SQS
rejouerait dans le vide jusqu'à la DLQ, et la cliente ne recevrait rien.

C'est le raisonnement que `appointments_no_overlap` tient sur les statuts de
rendez-vous — un rendez-vous annulé libère son créneau — appliqué aux statuts
d'envoi.

## L'ordre d'écriture

```
1. inscrire la ligne en PENDING     ← la prise de droit ; la base tranche
2. appeler le fournisseur           ← le seul effet irréversible
3. passer la ligne à SENT           ← avec l'accusé du fournisseur
```

Aucune permutation ne tient :

- **inscrire après l'appel** rouvre la fenêtre que l'index ferme : deux
  consommateurs simultanés appelleraient SES avant que l'un ne voie le doublon.
  La marque doit précéder l'effet, sans quoi elle n'est qu'un journal ;
- **passer à `SENT` avant l'appel** ferait passer pour envoyé un message qui ne
  partirait jamais — et `SENT` occupant la place, aucun rejeu ne le rattraperait.

Un échec est inscrit **avant** d'être relevé, pour la même raison : une ligne
laissée `PENDING` reste vivante dans l'index, et le rejeu que SQS s'apprête à
faire serait pris pour un doublon.

## La reprise d'un envoi échoué

Une transition `FAILED → PENDING` sur la ligne existante, jamais une seconde
insertion : `(tenant_id, dedupe_key)` l'interdirait, et c'est aussi la seule
forme qui donne un sens à `attempt_count` — un compteur qui repartirait de zéro à
chaque essai ne compterait rien.

La transition est un test-et-pose atomique (`WHERE status = 'FAILED'`), doublé du
rattrapage de la violation d'unicité : un envoi neuf a pu prendre la place entre
la relecture et l'écriture, et c'est `notifications_live_once` qui l'arrête.

## Structure

| Fichier | Rôle |
|---|---|
| `notifications.types.ts` | Le vocabulaire du domaine |
| `notifications.repository.ts` | Le seul fichier qui connaisse le schéma ; porte `claim()` |
| `notification-dispatch.service.ts` | L'ordre d'écriture, et la revérification du rappel à l'envoi |
| `reminder-window.ts` | La règle horaire du rappel J-1 — fonctions pures, UTC |
| `reminder-sweep.repository.ts` | Le balayage : la **seule** injection du client non scopé du module |
| `reminder-sweep.service.ts` | Une portée par salon, une enveloppe par canal |
| `internal-caller.guard.ts` | La garde à jeton partagé des routes internes |
| `notifications.config.ts` | Le jeton d'appel interne, résolu et validé |
| `notification-sender.ts` | Le **port** vers SES/SNS, et son implémentation par défaut qui refuse |
| `notification-renderer.ts` | Le **port** de rendu, et son implémentation pour les messages de rendez-vous |
| `notification-content.ts` | Les modèles — des fonctions pures, sans Nest ni Prisma |
| `booking-confirmation.listener.ts` | L'abonné à `appointment.created` |
| `notifications.service.ts` | La lecture du journal, et son plafond |
| `notifications.controller.ts` | `GET /notifications` et la route interne de balayage |
| `notifications.errors.ts` | Le catalogue d'erreurs du module |

## Ce que ce module ne fait pas, délibérément

- **Aucune reprise maison.** Un échec remonte à SQS, qui réessaie avec son
  backoff natif avant la DLQ (notifications §4). Boucler ici doublerait la file
  et masquerait la profondeur de DLQ sur laquelle repose l'alarme CloudWatch.
- **Aucun appel depuis un chemin de requête HTTP.** « L'API ne parle jamais
  directement à SES ou SNS » (notifications §1) : une réservation ne doit pas
  échouer parce qu'un e-mail n'est pas parti.
- **Aucune coordonnée en base ni dans les messages de file.** Le destinataire est
  désigné par l'identifiant de son compte ; l'adresse se relit dessus au moment
  de l'envoi (CDC §5.1, notifications §7).
- **Aucune revérification du statut hors du rappel J-1.** #68 renvoyait cette
  règle au « producteur » ; #71 l'a instruite là où elle se décide — à l'envoi,
  dans `NotificationDispatchService`, et pour le seul type `REMINDER_24H`. Une
  confirmation part même si le rendez-vous vient d'être annulé : elle est la
  preuve d'une réservation qui a bien eu lieu. Le rendu, lui, ne juge toujours
  pas du statut : il lit le rendez-vous pour son heure et sa prestation, c'est
  une lecture d'affichage.
- **Aucun lien d'annulation signé.** Le lien de la confirmation pointe l'espace
  client (`/{slug}/compte`), où chaque rendez-vous à venir porte son bouton
  « Annuler ». Une URL signée qui annulerait en un clic ajouterait un secret à
  faire tourner, une durée de validité à choisir et une route publique de plus :
  c'est une décision de conception à part entière, qui appartient à son issue.
- **Aucun envoi réel.** `UnconfiguredNotificationSender` refuse tout en 503 tant
  que les passerelles SES et SNS ne sont pas branchées. Le refus laisse la ligne
  `FAILED`, donc reprenable — ce qu'un faux `SENT` aurait rendu impossible.

## Ce que les tests prouvent

`__tests__/notification-dispatch.service.spec.ts` compte les appels à
l'expéditeur : deux livraisons du même message SQS n'en produisent **qu'un**.
Le double de dépôt y reproduit les deux uniques de la table, ce qui rend le
comptage significatif plutôt que tautologique.

`__tests__/notifications.migration.spec.ts` relit le SQL de migration et vérifie
que l'index existe, sur ces colonnes-là, avec ce filtre-là — le lecteur d'index
de `prisma-schema.spec.ts` ne reconnaissant que les index totaux.
