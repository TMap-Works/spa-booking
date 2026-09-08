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
| #69 | Les **modèles par établissement** — la table `notification_templates`, le moteur de substitution à variables échappées, les défauts de la plateforme en code, la mesure GSM-7 / UCS-2 du coût d'un SMS, et les quatre routes de personnalisation |
| #72 | L'**avis d'annulation** — abonnement à `appointment.cancelled`, modèles de plateforme e-mail et SMS, mention de l'origine de la décision, et résolution du destinataire selon d'où elle vient |

À venir : les passerelles SES et SNS.

## Les modèles de message (#69)

```
modèle du salon (notification_templates)  ─┐
                                           ├─► moteur ──► subject / html / text
modèle par défaut (code, versionné)       ─┘      ▲
                                                  │
                                        variables du rendez-vous,
                                        déjà formatées dans le fuseau du salon
```

Le ticket répond à une phrase de notifications §6 : « un salon doit pouvoir
personnaliser ses messages sans déploiement ». Tant que les modèles sont des
littéraux TypeScript, changer une formule de politesse demande une pull request,
une CI et une mise en production.

### Où vivent les modèles, et pourquoi pas au même endroit

| | Où | Pourquoi |
|---|---|---|
| Personnalisation d'un salon | `notification_templates`, avec son `tenant_id` | c'est une donnée d'établissement, et elle doit changer sans déploiement |
| Défaut de la plateforme | `notification-default-templates.ts` | il n'a **pas** d'établissement : l'inscrire en base aurait demandé un `tenant_id` nullable dans la table même qui décide de ce que les clientes reçoivent |

La conséquence pratique est agréable : **une ligne absente n'est pas un manque**,
c'est un salon qui n'a rien personnalisé. Effacer la ligne *est* le retour au
défaut, sans qu'aucun contenu n'ait à être recopié — et une correction de
coquille dans un défaut est un déploiement, pas une migration de données sur tous
les tenants.

### La grammaire, et ce qu'elle refuse d'être

Deux formes, et elles n'évaluent rien :

| Forme | Ce qu'elle fait |
|---|---|
| `{{nom}}` | remplace par la valeur, **échappée** si le corps est du HTML |
| `{{#nom}}…{{/nom}}` | garde le fragment seulement si la variable est renseignée |

Pas de Handlebars, pas d'EJS : le contenu vient d'un utilisateur authentifié mais
non privilégié à l'échelle de la plateforme, et un moteur qui évalue des
expressions transforme un champ de formulaire en exécution côté serveur. La
section existe pour un besoin précis — l'adresse et le téléphone du salon sont
nullables, et un modèle sans conditionnel produirait « Adresse : » vide dans
chaque message.

Trois bornes tiennent ce que le salon ne peut pas faire :

- **la liste des variables est close** ; ce qu'elle ne nomme pas n'est pas
  substituable, donc pas exposable, et un modèle qui nomme autre chose est refusé
  à l'écriture — pas rendu à vide dans l'e-mail d'une cliente ;
- **un modèle ne calcule rien** : il nomme `{{date}}`, dont la valeur est déjà
  convertie au fuseau de l'établissement, et `{{lien_annulation}}`, composé depuis
  `APP_URL` et le slug de la ligne `tenants`. Un salon ne peut donc ni décaler une
  heure, ni faire pointer un lien signé de son nom vers un domaine qu'il aurait
  choisi ;
- **l'échappement porte sur la valeur, jamais sur le modèle** : le modèle *est* du
  HTML, l'échapper aurait rendu impossible d'en écrire. Le corps texte, lui,
  n'échappe rien — un `&amp;` y serait lu tel quel par la cliente.

### Le coût d'un SMS, mesuré et non supposé

`measureSms` compte des **septets** en GSM-7 et des unités de code UTF-16 en
UCS-2. La bascule tient à un seul caractère : `é` et `è` sont dans l'alphabet de
base, mais `ê`, `ô`, `ç` minuscule, l'apostrophe typographique `’`, le tiret
cadratin `—` et les guillemets `« »` n'y sont pas — et chacun, seul, fait tomber
la capacité de 160 à 70 caractères, donc double la facture (notifications §5).

Un modèle de SMS est mesuré **sur un rendu de référence** avant d'être
enregistré, et refusé au-delà de trois segments : mesurer la chaîne brute aurait
dit n'importe quoi, `{{date}}` faisant huit caractères et en rendant
trente-quatre. La mesure est aussi rendue par l'API, pour qu'un salon voie son
message passer de un segment à deux au moment où il ajoute l'apostrophe.

### Les routes

| Route | Rôle | Ce qu'elle fait |
|---|---|---|
| `GET /notification-templates` | `STAFF` | les modèles effectifs, et le vocabulaire des variables |
| `GET /notification-templates/:type/:channel` | `STAFF` | le modèle effectif d'un message |
| `PUT /notification-templates/:type/:channel` | `MANAGER` | écrit la personnalisation, après validation |
| `DELETE /notification-templates/:type/:channel` | `MANAGER` | revient au modèle par défaut |

Lire à `STAFF` répond à une question de comptoir — « qu'est-ce que ma cliente a
reçu, exactement ? ». Écrire engage l'établissement auprès de **toutes** ses
clientes à venir : c'est un geste de responsable.

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

### Le départ du balayage tourne d'un salon à chaque heure (#514)

Le plafond `REMINDER_SWEEP_MAX_APPOINTMENTS` est **global** — 500 rendez-vous,
tous établissements confondus — et il se consomme dans l'ordre `id asc` de
`listTenantIds()`, qui est stable. Un salon anormalement peuplé le vidait donc à
lui seul et privait **toujours les mêmes** suivants de leur rappel. Le défaut
n'est pas la troncature, que `truncated` et l'alarme `…-reminder-sweep-truncated`
signalent déjà : c'est son **déterminisme**.

`sweepStartOffset` décale le départ d'un établissement à chaque balayage. Le tour
est donc complet en `N` balayages, et un salon privé d'une heure est servi la
suivante. L'ordre relatif reste celui de `listTenantIds()` : la rotation le
décale, elle ne le mélange pas.

**Il n'y a aucun curseur.** Le décalage se déduit de l'instant du balayage —
`now / REMINDER_WINDOW_MS` est l'index de la fenêtre horaire, et les fenêtres
pavent le temps, si bien que l'index avance d'exactement un par balayage. Un
curseur retenu aurait demandé un état : en mémoire il serait propre à une
réplique ECS et remis à zéro au déploiement ; partagé, il aurait demandé une
table, donc une migration. Il aurait de plus cessé d'avancer dès qu'un balayage
échoue avant de l'écrire — la famine déterministe, reconstituée.

Un balayage rejoué dans la même heure retrouve le même décalage, donc les mêmes
salons et les mêmes `dedupeKey` : le rejeu reste inoffensif.

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

## L'avis d'annulation (#72)

```
appointments.service                notifications
       │                                  │
   COMMIT (statut CANCELLED)              │
       │                                  │
       ├─ appointmentCancelled() ─────────┤ CancellationNoticeListener
       │   (bus en mémoire, #37)          │   runWithTenant(event.tenantId)
       │   porte cancelledBy              │   destinataire = f(cancelledBy)
       │                                  │   canaux = f(coordonnées du compte)
       │                                  │
       │                                  └─ dispatch(EMAIL, SMS) ──► chaîne #68
```

Troisième et dernier message du CDC §1.4. `appointments` n'est pas modifié :
l'événement `appointment.cancelled` existe depuis #40, et il porte déjà tout ce
qu'il faut — `cancelledBy`, `clientId`, `staffId`, `tenantId`.

### Qui reçoit l'avis, et pourquoi un seul destinataire à la fois

Le CDC §1.4 veut « un avis d'annulation **au staff et au client** », et le
quatrième critère d'acceptation en retire un cas : « aucun avis envoyé si
l'annulation vient du client lui-même sur son propre rendez-vous, **hors
notification au staff** ». L'avis va donc à la partie qui **n'a pas décidé** :

| `cancelledBy` | Destinataire | Pourquoi |
|---|---|---|
| `CLIENT` | le praticien | son agenda vient de changer sans lui ; la cliente sait déjà, c'est elle qui a cliqué |
| `STAFF` | la cliente | le salon a décidé ; elle doit l'apprendre autrement qu'en se déplaçant |
| `SYSTEM` | la cliente | personne ne l'a décidé de son côté du comptoir |

**Un seul, et c'est une limite de la base, pas un choix de confort.**
`notifications_live_once` porte sur `(tenant_id, appointment_id, type, channel)` :
deux avis vivants sur le même canal pour un même rendez-vous sont impossibles.
Écrire la cliente **puis** le praticien ferait refuser le second par PostgreSQL,
`claim()` rendrait `already-live`, et le praticien ne recevrait rien — en
silence, puisque c'est exactement la forme d'un rejeu SQS légitime.

Prévenir les deux à la fois demande d'ajouter `recipient_user_id` à cet index.
Et un index ne se modifie pas : il se **remplace**, donc il se `DROP`. C'est là
que la porte se ferme, et pas là où on l'attendait — le garde « migration
purement additive » de
`src/infrastructure/database/__tests__/prisma-schema.spec.ts` refuse tout
`DROP INDEX` dans le SQL de migration, sans exception ni échappatoire. Aucun
chemin additif n'existe — tant que l'ancien index vit, il bloque, et en créer un
second à côté n'y change rien.

Le contournement — écrire l'avis du praticien avec `appointment_id` à `NULL`,
qui échappe à l'index — a été écarté délibérément : il romprait le lien avec le
rendez-vous, que le journal du back-office affiche, pour esquiver un invariant
plutôt que pour le servir.

Lever la limite demande donc d'assouplir ce garde **et** de poser la migration,
dans un ticket qui porte les deux — c'est l'objet de l'issue de suivi. La règle
ci-dessus est ce qui, sans migration, sert les deux publics **sans jamais perdre
un envoi** : à chaque annulation, un avis part vers la partie qui n'a pas décidé.

Ce que la règle ne couvre pas, et qu'il faut savoir : sur un `cancelledBy` à
`STAFF`, seule la cliente est prévenue. Une annulation posée au comptoir par une
autre personne que le praticien concerné — accueil, gérance — ne lui dit donc
rien, alors que son agenda vient de changer. C'est le second public que la
migration ci-dessus débloquera ; en attendant, le back-office reste la seule
surface où il le voit.

### La clé de livraison porte le destinataire

`appointment:{id}:CANCELLATION:{canal}:{destinataire}`, là où la confirmation et
le rappel s'arrêtent au canal. L'avis d'annulation est le seul message dont le
destinataire dépende d'une donnée du rendez-vous : sans lui dans la clé, un avis
au praticien serait pris pour un rejeu d'un avis à la cliente, et acquitté sans
être parti.

### Le modèle ne s'adresse à personne

L'unique de `notification_templates` est `(tenant_id, type, channel)` : il n'y a
**qu'un** modèle d'avis d'annulation par canal, et il sert les deux publics. D'où
sa forme — « Bonjour, » et non « Bonjour {{client}} », le nom de la cliente dans
le récapitulatif plutôt que dans la salutation, et une variable `{{origine}}`
rédigée à la troisième personne (« à la demande du client », jamais « à votre
demande »).

`{{origine}}` est **vide** sur un rendez-vous qui n'est pas annulé, ce qui la rend
utilisable en section : un modèle qui la nomme dans une confirmation n'écrit rien
plutôt qu'une phrase fausse.

### Le motif n'a pas de variable, et n'en aura pas

`appointments.cancellation_reason` est un texte libre écrit par un humain — il
peut nommer un état de santé ou un tiers. Il ne voyage pas dans l'événement
(`appointment-cancelled.event.ts` explique pourquoi), il n'est pas lu par
`loadAppointmentContext`, et le vocabulaire des modèles ne l'expose pas. Un salon
ne peut donc pas, même par mégarde, le faire partir chez sa cliente (CDC §5.1).

### Aucune revérification de statut

Contrairement au rappel J-1, l'avis d'annulation n'en demande pas : son objet
**est** un rendez-vous qui n'occupe plus rien. `NotificationDispatchService` ne
revérifie que `REMINDER_24H`, et c'est écrit dans son en-tête.

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
| `reminder-sweep.service.ts` | Une portée par salon, une enveloppe par canal, un départ qui tourne |
| `internal-caller.guard.ts` | La garde à jeton partagé des routes internes |
| `notifications.config.ts` | Le jeton d'appel interne, résolu et validé |
| `notification-sender.ts` | Le **port** vers SES/SNS, et son implémentation par défaut qui refuse |
| `notification-renderer.ts` | Le **port** de rendu : modèle du salon d'abord, défaut de la plateforme sinon |
| `notification-template.ts` | Le moteur — substitution, sections, échappement, mesure GSM-7 / UCS-2 |
| `notification-default-templates.ts` | Les modèles **par défaut** de la plateforme, versionnés en code |
| `notification-content.ts` | Le pont rendez-vous → variables : fuseau, montant, lien d'annulation |
| `notification-templates.repository.ts` | Les personnalisations en base, toujours par le client scopé |
| `notification-templates.service.ts` | La résolution du modèle effectif et la validation d'un modèle soumis |
| `notification-templates.controller.ts` | Les quatre routes de personnalisation |
| `booking-confirmation.listener.ts` | L'abonné à `appointment.created` |
| `cancellation-notice.listener.ts` | L'abonné à `appointment.cancelled`, et le choix du destinataire |
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
