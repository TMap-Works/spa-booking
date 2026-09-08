# Module `crm`

Fiches clientes, coordonnées, notes internes, historique de visites (CDC §2.3).
C'est le module que le front-desk ouvre le plus souvent — et le seul dont la
totalité du contenu est une **donnée personnelle**. Tout ce qui suit découle de
ce fait.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #56 | Le CRUD des fiches, la note interne, la recherche indexée et l'historique agrégé |
| #313 | `ClientDirectoryService`, la porte par laquelle `appointments` obtient la fiche d'une cliente qui réserve sans compte |
| #465 | `assertBookableWithin`, le second battant de cette porte : confirmer qu'une fiche **désignée** par le comptoir est bien du fichier client |
| #81 | Les droits des personnes : export, anonymisation, consentement marketing — et le [registre des traitements](../../../../../docs/registre-des-traitements.md) |
| #525 | La projection de l'état de suppression d'adresse sur la fiche — le module lit ce que `notifications` écrit |

Hors périmètre MVP, et donc non livré : fusion de doublons, segmentation,
campagnes. Le CDC §1.4 borne le module à un « CRM client de base » ; chacun de
ces besoins est une décision de produit à part entière.

L'export RGPD figurait sur cette liste jusqu'à #81, et il en est sorti pour une
raison qui n'est pas un élargissement de périmètre : le CDC §5.1 range les
« mécanismes d'accès, de rectification, d'export et de suppression » dans les
exigences transverses, au même rang que le chiffrement et le cloisonnement
multi-tenant. Ce n'est pas une fonctionnalité de CRM, c'est une obligation
légale sur les données que ce module détient.

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/customers` | `STAFF` |
| `GET` | `/api/v1/customers/:id` | `STAFF` |
| `GET` | `/api/v1/customers/:id/history` | `STAFF` |
| `GET` | `/api/v1/customers/:id/export` | `MANAGER` |
| `POST` | `/api/v1/customers` | `STAFF` |
| `POST` | `/api/v1/customers/:id/anonymize` | `ADMIN` |
| `PATCH` | `/api/v1/customers/:id` | `STAFF` |
| `PATCH` | `/api/v1/customers/:id/status` | `MANAGER` |

**Aucune route publique, aucune route ouverte au rôle `CLIENT`.** C'est la
propriété la plus importante du module : une surface anonyme, même en lecture,
même bornée, serait un annuaire de la clientèle d'un salon offert à qui connaît
son slug. Une cliente lit et corrige son propre profil par `GET /auth/me` et
`PATCH /users/me` — des routes sans identifiant en chemin, donc sans rien à
comparer.

`STAFF` fait tout ce qui relève de la relation client au quotidien : chercher,
créer au téléphone, corriger un numéro, noter une allergie. `MANAGER` garde la
seule opération qui **retire** quelque chose des écrans — la désactivation. Même
partage que chez `identity` entre `PATCH /users/:id` et `PATCH /users/:id/status`.

Pas de `DELETE` : `appointments.client_id` référence `users` en `Restrict`, si
bien qu'une fiche ayant honoré une seule visite ne se supprime pas, et le
reporting doit continuer à la compter. Un verbe qui n'efface rien mentirait au
client autant qu'au relecteur.

#81 n'en ajoute pas davantage. Le droit à l'oubli passe par
`POST /customers/:id/anonymize`, parce que ce qui se produit n'est pas la
disparition d'une ressource — elle reste, et se relit à la même URL — mais une
transformation irréversible de son contenu. Un `DELETE` qui rendrait ensuite 200
sur la même URL aurait menti deux fois.

## Une fiche cliente **est** une ligne `users`

Le schéma initial en a décidé, et `users.password_hash` est nullable précisément
pour cela — « un client peut exister sans compte, saisi au comptoir par le
staff ». Une table `customers` parallèle aurait dédoublé le nom, l'adresse et le
téléphone, cassé la clé étrangère sur laquelle repose l'historique, et laissé
ouverte la question « laquelle des deux fait foi ? ».

Deux modules lisent donc la même table, et **chacun s'interdit ce que l'autre
sert** :

| | `identity` | `crm` |
|---|---|---|
| Ce qu'il lit | `role IN (STAFF, MANAGER, ADMIN)` | `role = CLIENT` |
| Ce qu'il rend | comptes, rôles, invitations | fiches, notes, historique |
| Ce qu'il ne voit pas | les fiches clientes (`findStaffAccountById`) | les comptes internes (`findById`) |

Le refus est symétrique et sans `if` : il est dans le `where`, et le `null`
devient un 404. `GET /users/:id` sur une cliente répond 404 ; `GET /customers/:id`
sur une praticienne aussi.

## La note interne, et ce qui la tient à l'écart

« Notes internes distinctes des informations visibles du client » est un critère
d'acceptation. Il tient par quatre choses, et non par une convention de nommage :

1. **la colonne** `users.internal_note`, écrite et lue par ce seul module ;
2. **les projections du dépôt** — `CUSTOMER_SUMMARY_SELECT` ne la lit pas. Une
   liste de deux cents fiches ne fait donc transiter aucune note, même pas
   jusqu'à la mémoire du processus ;
3. **les DTO** — `CustomerSummaryDto` ne la porte pas ; `CustomerDto`, servi au
   rang `STAFF`, si ;
4. **l'absence de toute surface publique** — aucun schéma du parcours client ne
   la référence, et il n'y a aucune route par laquelle elle pourrait sortir.

## L'adresse supprimée — un état que ce module lit et n'écrit jamais

`users.email_suppressed_at` et `users.email_suppression_reason` sont posées par
l'ingestion d'un événement de remise SES (`notifications`, #73) : un rebond
permanent ou une plainte, et l'adresse cesse d'être écrite. Un rebond
**transitoire** — boîte pleine, serveur momentanément indisponible — n'y écrit
rien, et c'est délibéré.

Le fichier client en est le seul lecteur servi à un écran (#525), et le partage
est le même que celui de la note interne : les deux champs sont sur
`CUSTOMER_SELECT` et sur `CustomerDto`, **pas** sur le résumé. Une liste de deux
cents lignes n'affiche aucun avis de délivrabilité.

Ce que le back-office en fait : la fiche signale l'adresse supprimée, avec son
motif et sa date, convertie au fuseau de l'établissement. Sans cela, un
gestionnaire voit une réservation confirmée sans jamais savoir que la cliente
n'a rien reçu et ne recevra plus rien.

Aucune route de ce module ne les écrit, et il n'y en aura pas : la suppression
est un fait constaté par le fournisseur d'envoi, pas une décision du comptoir.
Le corollaire est que l'adresse ne se corrige pas d'ici non plus —
`updateCustomerRequest` ne porte pas `email`, faute de pouvoir vérifier la
nouvelle au périmètre du MVP.

## Aucune donnée personnelle dans les logs

Cinquième critère de #56, et il tient par une règle plus simple qu'une
politique : **ce module ne journalise rien**. Pas de logger injecté, pas de
`console`, aucun nom ni adresse ni numéro dans le message ou les `details` d'une
erreur de domaine — `CustomerEmailTakenError` ne porte même pas l'adresse en
cause, contrairement au `slug` des conflits du catalogue.

`__tests__/crm.logging.spec.ts` relit les sources du module pour l'interdire, et
vérifie en second rideau que `common/logging/redaction.ts` masquerait de toute
façon `firstName`, `lastName`, `email`, `phone` et `internalNote` par nom de
champ. La ceinture est le point 1 ; la rédaction est les bretelles.

## La recherche et ses index

Un seul terme, trois axes — c'est ce que fait un front-desk qui a un nom au
téléphone, un numéro sur un SMS ou une adresse sur une confirmation :

| Axe | Prédicat | Index |
|---|---|---|
| nom, prénom | préfixe, insensible à la casse | `(tenant_id, role, last_name, first_name)` |
| e-mail | préfixe sur l'adresse canonisée | `(tenant_id, email)` — l'unique du schéma initial |
| téléphone | préfixe | `(tenant_id, phone)` |

L'e-mail est comparé **sans** `mode: 'insensitive'` : `normalizeEmail` canonise à
l'écriture, la colonne ne contient que des minuscules, et la comparaison est donc
à la fois exacte et utilisable par l'index. Les noms, stockés tels que saisis,
exigent l'insensibilité — ce qui interdit à PostgreSQL d'utiliser le B-tree pour
le préfixe. Ce qui reste, et qui est l'essentiel : l'index borne les lignes
candidates à **un établissement et à sa seule clientèle** avant que le prédicat
de nom ne filtre à l'intérieur.

La recherche est par **préfixe** et non « contient » : aucun B-tree ne sert un
`%dur%`, et le promettre aurait été promettre un balayage complet. Le passage à
`pg_trgm` est une décision à prendre sur volumétrie réelle, pas d'avance.

Le terme fait au moins deux caractères : une lettre unique ramènerait la
quasi-totalité du fichier à chaque frappe.

## L'historique agrégé

`summary` compte, borne et somme sur la **totalité** des rendez-vous de la
fiche ; `visits` n'en montre que les cinquante plus récents au plus. Un agrégat
calculé sur la fenêtre serait faux dès que la fiche la dépasse, et il le serait
en silence — le pire mode de défaillance pour un chiffre affiché à un
commerçant.

Trois décisions méritent d'être connues avant de lire les chiffres :

- **`totalSpent` ne compte que les visites `COMPLETED`.** Ni les annulations, ni
  les absences, ni ce qui n'a pas encore eu lieu : un chiffre d'affaires qui
  compterait les rendez-vous à venir se démentirait à chaque annulation ;
- **`totalSpent` vaut `null`, jamais `0`,** quand aucune visite n'a été honorée.
  Un zéro laisserait croire à une cliente venue sans rien payer ;
- **`totalSpent` vaut `null` aussi quand la fiche porte plusieurs devises.**
  Chaque rendez-vous fige la sienne à la réservation, et un établissement qui
  change de devise laisse derrière lui des lignes dans l'ancienne. Additionner
  des entiers dont les codes diffèrent produirait un nombre plausible et faux ;
  choisir « la devise dominante » serait pire. La ventilation par devise dans la
  réponse est une évolution de contrat, donc une issue.

`GET /customers/:id/history` relit la fiche avant d'agréger, et le 404 qui en
découle n'est pas une politesse : sans lui, l'historique d'un identifiant
inconnu — ou d'une fiche du salon voisin — rendrait un agrégat vide en **200**,
indiscernable de celui d'une cliente jamais venue.

## Les droits des personnes (#81)

Le CDC §5.1 les range dans les exigences transverses : « mécanismes d'accès, de
rectification, d'export et de suppression (droit à l'oubli) ». La rectification
existait depuis #56 (`PATCH /customers/:id`) ; #81 pose les trois autres, et le
consentement qui va avec. Le détail des traitements, de leurs bases légales et
de leurs durées de conservation vit dans le
[registre des traitements](../../../../../docs/registre-des-traitements.md).

### L'export — `GET /customers/:id/export`, rang `MANAGER`

Un document JSON unique et **daté**, qui porte tout ce que le salon détient sur
une personne : identité, coordonnées, consentements avec leur date, note interne
du salon, et la totalité de ses rendez-vous — textes libres compris.

Trois propriétés le distinguent de l'historique, et aucune n'est cosmétique :

| | `GET /:id/history` | `GET /:id/export` |
|---|---|---|
| Ce qu'il sert | décider, sur un écran | rendre des comptes, à une personne |
| Les visites | les cinquante plus récentes | **toutes**, du plus ancien au plus récent |
| Les textes libres | aucun | `client_note`, `staff_note`, motif d'annulation |
| Les agrégats | compteurs, bornes, total dépensé | aucun — un agrégat est une interprétation |

L'absence de borne est délibérée : un export tronqué a l'apparence d'une réponse
au titre de l'art. 15 sans en être une, et le tronquer **en silence** serait le
pire des deux mondes. La borne existe dans la nature des données — ce sont les
rendez-vous d'une personne dans un établissement.

La note interne du salon y figure. Ce n'est pas une négligence : le droit
d'accès porte sur les données *concernant* la personne, sans exception pour
celles qu'on aurait préféré garder pour soi.

Le rang est `MANAGER` et non `STAFF` : la route ne modifie rien, mais elle
produit en un appel un dossier complet exportable. Le laisser au comptoir
n'aurait pas été de la minimisation ; le monter à `ADMIN` aurait rendu le droit
d'accès impraticable.

### L'anonymisation — `POST /customers/:id/anonymize`, rang `ADMIN`

**Anonymiser, pas supprimer.** `appointments.client_id` référence `users` en
`Restrict`, et `payments` comme `sales` s'accrochent à ces rendez-vous :
retirer la ligne emporterait l'historique comptable des ventes passées, ce que
le critère d'acceptation interdit et que la base refuserait de toute façon. Ce
qui reste après le geste est une suite de montants et de dates rattachés à un
identifiant opaque ; ce qui part est la personne.

| Colonne | Ce qu'elle devient |
|---|---|
| `first_name`, `last_name` | `Client anonymisé` |
| `email` | `anonymise-{id}@anonymise.invalid` — `.invalid` est réservé par la RFC 2606 |
| `phone`, `internal_note`, `password_hash` | `NULL` |
| `is_active` | `false` |
| `marketing_consent` | `false`, sa date remise à `NULL` |
| `anonymized_at` | l'instant du geste |
| `appointments.client_note`, `staff_note`, `cancellation_reason` | `NULL` |

Le pseudonyme est **dérivé de l'identifiant** de la fiche, et il le faut :
`@@unique([tenantId, email])` aurait fait échouer la deuxième anonymisation du
salon sur un pseudonyme constant.

Trois propriétés à connaître :

- **elle est idempotente.** L'écriture est conditionnée à `anonymized_at IS
  NULL` : une seconde demande rend la fiche telle quelle, sans second pseudonyme
  ni date décalée. Deux demandes concurrentes obtiennent la même réponse ;
- **elle refuse tant qu'un rendez-vous à venir occupe l'agenda** (422,
  `CUSTOMER_HAS_UPCOMING_APPOINTMENTS`). Le salon ne peut ni préparer, ni
  confirmer, ni décommander une visite dont la cliente n'a plus de nom, et le
  RGPD n'impose pas d'effacer tant que le traitement reste nécessaire à
  l'exécution du contrat (art. 17.1.b). Le refus est temporaire et actionnable :
  honorer, ou annuler. La borne porte sur `ends_at` et non sur `starts_at` : un
  rendez-vous **commencé et non terminé** est un contrat en cours d'exécution au
  même titre qu'un rendez-vous de jeudi, et le borner par son début aurait laissé
  anonymiser la cliente installée dans le fauteuil ;
- **elle décide dans sa transaction, jamais avant.** L'`UPDATE` de la ligne
  `users` précède le compte des rendez-vous à venir, et le refus annule la
  transaction. L'ordre inverse aurait été la « vérification applicative suivie
  d'une écriture » que booking-engine §1 interdit : sous `READ COMMITTED`, un
  compte fait avant toute prise de verrou manque la réservation en cours de
  validation. C'est l'`UPDATE` qui entre en conflit avec le `FOR SHARE` que
  `AppointmentsRepository.insert` pose sur cette même ligne (#465, #468), et
  c'est donc lui qui rend le compte fiable. Symétriquement, **les deux battants
  de la porte de réservation** écartent désormais une fiche anonymisée :
  `assertBookableWithin` par le prédicat `anonymized_at IS NULL` de son SQL, et
  `resolveWithin` en jugeant la ligne rendue (409, comme pour un compte du
  personnel). Une réservation qui démarre pendant l'anonymisation attend le
  `COMMIT`, relit la ligne sous verrou, et la trouve anonymisée ;
- **elle est la seule écriture du module dans `appointments`**, et une entorse
  assumée à ce que ce README annonçait. Elle est bornée à trois colonnes de
  texte libre — ni statut, ni créneau, ni prix, ni auteur d'annulation. Une
  anonymisation qui ne toucherait que `users` laisserait « allergique au monoï,
  habite au-dessus de la pharmacie » dans une note de rendez-vous, et n'aurait
  effacé que ce qui était le plus facile à effacer.

Le rang est `ADMIN` : c'est la seule opération de tout le module qui détruise
irréversiblement une donnée. Même seuil que `PATCH /users/:id/role` chez
`identity`, pour la même raison.

### Le consentement marketing

`users.marketing_consent` et `users.marketing_consent_at`, posées alors que le
marketing est **hors périmètre MVP** (CDC §1.4). Ce n'est pas de l'anticipation
gratuite : le consentement se recueille au moment où la fiche se crée. Une base
constituée sans lui serait inexploitable a posteriori, puisqu'il faudrait
recontacter chacun pour le demander — précisément ce qu'aucune base légale
n'autorise à faire.

Trois règles le gouvernent :

1. **le défaut est le refus**, jamais l'acceptation — le consentement est un
   acte positif (RGPD art. 4.11) ;
2. **la date accompagne toute prise de position**, y compris un refus : c'est la
   preuve que l'art. 7.1 met à la charge du responsable de traitement. Elle
   reste nulle tant que personne ne s'est prononcé — « jamais demandé » n'est
   pas « refusé le 6 septembre » ;
3. **elle ne bouge que sur un changement de valeur.** Un `PATCH` qui corrige un
   numéro en recopiant le formulaire entier ne doit pas réécrire la preuve ; sans
   ce départage, elle finirait par dater du dernier changement d'adresse.

Ce que ce consentement **ne gouverne pas** : les notifications
transactionnelles — confirmation, rappel J-1, avis d'annulation. Celles-là
relèvent de l'exécution du contrat, et les subordonner à cette colonne aurait
rompu le service demandé par la cliente elle-même.

## Ce que le module lit, et ce qu'il n'importe pas

`CrmRepository` lit `users` et `appointments`. Il n'importe **aucun repository
voisin** : ce qu'api-module §3 interdit est un `../../identity/identity.repository`,
et il n'y en a pas. Les deux lectures sont argumentées en tête du fichier —
la première parce que la fiche *est* la ligne `users`, la seconde parce que
l'historique est une projection en lecture seule qui ne décide d'aucune règle de
cycle de vie. La seule écriture du module dans `appointments` est celle de
l'anonymisation (#81), bornée à trois colonnes de texte libre.

`CrmModule` n'importe qu'`IdentityModule`, et seulement pour ses gardes. Il
n'exporte que `ClientDirectoryService` — voir ci-dessous.

## La porte de la réservation sans compte (#313)

`appointments.client_id` est `NOT NULL` : poser un rendez-vous d'invité suppose
une ligne `users`. Jusqu'à #313, `AppointmentsRepository` l'écrivait lui-même,
faute de porte — la table d'un autre domaine écrite par un module qui ne la
possède pas. `CrmModule` exporte désormais `ClientDirectoryService`, et lui seul.

Ce qu'elle laisse passer est étroit à dessein : **un identifiant de fiche, jamais
une fiche**. Pas de nom, pas d'adresse, pas de note interne, aucune lecture du
fichier client. Un module qui voudrait *afficher* une cliente n'a toujours aucun
chemin pour cela.

### Elle prend une transaction, et c'est une entorse assumée

`resolveWithin(scope, contact)` reçoit la portée transactionnelle de l'appelant,
là où api-module §2 veut qu'un service ignore Prisma. C'est le prix d'un critère
qui ne se satisfait pas autrement : **un 409 de créneau ne doit laisser aucune
fiche derrière lui**. Résoudre la cliente dans une transaction et poser le
rendez-vous dans une autre laisse, à chaque course perdue, une fiche publique
sans rendez-vous au fichier du salon.

L'entorse est bornée : la portée est opaque pour le service — il la transmet, ne
l'ouvre ni ne la referme —, le SQL reste dans `CrmRepository`, et le client reçu
est le **scopé**, si bien que l'extension de tenant continue de s'appliquer mot
pour mot.

### Deux décisions produit, et ce qu'elles coûtent

**Une adresse portée par un compte `STAFF`/`MANAGER`/`ADMIN` est refusée**
(`CLIENT_EMAIL_NOT_BOOKABLE`, 409). La résolution lit sur la seule adresse — sans
filtre de rôle — puis **juge** ce qu'elle trouve : c'est ce qui transforme la
collision `@@unique([tenantId, email])` en un refus choisi, là où un filtre
`role: 'CLIENT'` dans le `where` aurait mené à une création refusée en `P2002`
nu, donc à un 500.

| | Ce que la route rend |
|---|---|
| adresse inconnue | 201, fiche créée |
| adresse déjà cliente | 201, fiche réutilisée telle quelle |
| adresse d'un compte du personnel | 409 `CLIENT_EMAIL_NOT_BOOKABLE` |
| adresse d'une fiche **anonymisée** (#81) | 409 `CLIENT_EMAIL_NOT_BOOKABLE` |

La dernière ligne est le pendant public du prédicat `anonymized_at IS NULL`
d'`assertBookableWithin`. Elle compte : le pseudonyme est
`anonymise-{id}@anonymise.invalid`, donc reconstructible par quiconque tient
l'identifiant de la fiche — qui figure dans l'export remis à la personne. Sans ce
refus, une réservation publique rattachait un rendez-vous à quelqu'un qui venait
d'exercer son droit à l'oubli, et le réinscrivait au fichier client par la bande.
Le refus est un 409 et non un silence : écarter la ligne du prédicat aurait mené à
une création que `@@unique([tenantId, email])` refuse, c'est-à-dire à la boucle de
réessais de `writingAgenda`.

Ce que ce refus laisse deviner : qu'une adresse porte un compte **non client**
dans cet établissement. C'est le coût assumé, et il est borné — les deux premières
lignes du tableau sont indiscernables, si bien que la route ne dit rien du fichier
client. Il est par ailleurs le même refus que le comptoir reçoit déjà :
`POST /customers` sur cette adresse rend `CUSTOMER_EMAIL_TAKEN`, l'unicité ne
distinguant pas les rôles. Le parcours public ne peut pas réussir en silence là où
le back-office, authentifié, est refusé.

Sa contrepartie : un membre du personnel client de son propre salon ne réserve pas
en ligne avec son adresse professionnelle. Il en utilise une autre, ou le comptoir
réserve pour lui (#50). L'alternative — réutiliser son compte — aurait accroché un
rendez-vous à une fiche que le fichier client ne montre jamais (`role = CLIENT`),
donc un rendez-vous dont le comptoir ne peut pas ouvrir la cliente.

**Une fiche désactivée est réutilisée telle quelle.** `is_active` gouverne les
écrans du back-office — la recherche l'exclut par défaut —, pas l'identité de qui
réserve. L'écarter n'aurait laissé que deux issues : créer une seconde fiche, ce
que l'unicité interdit, ou refuser — c'est-à-dire faire de cette route publique un
oracle sur le fichier client, la donnée même que ce module protège.

### Le rôle est jugé sous verrou de ligne (#468)

La lecture qui porte ce refus est un `SELECT … FOR SHARE`, dans la transaction de
l'appelant — la même conduite que le second battant, pour la même raison. Elle
était nue jusqu'à #468, et le refus n'était donc **pas atomique** par rapport à
l'insertion qu'il garde : sous `READ COMMITTED`, chaque instruction prend son
propre instantané, si bien qu'une lecture pouvait voir `CLIENT` pendant qu'une
transaction concurrente promouvait la fiche au personnel et validait. Les deux
clés étrangères de `appointments.client_id` prouvent l'existence de la ligne et
son établissement, jamais son rôle : le rendez-vous passait.

Le verrou est **partagé** : deux réservations d'invité pour la même personne chez
deux praticiens différents avancent de front, et seuls les écrivains de la ligne
attendent — ceux, précisément, qui pourraient la promouvoir. Comme au comptoir,
le SQL brut ne repasse pas par l'extension de scoping (ADR 0006), et `tenant_id`
est donc écrit à la main dans la requête, depuis le contexte de requête.

L'ordre d'acquisition ne change pas : `AppointmentsRepository.insert` prend
d'abord le verrou consultatif d'agenda, puis appelle la porte. Aucun chemin ne
détient un verrou de ligne `users` avant l'agenda, donc aucun cycle d'attente
nouveau.

**Ce que ce verrou ne ferme pas**, et il faut le dire : la fenêtre de l'adresse
**libre**. `FOR SHARE` verrouille les lignes rendues, et une lecture qui n'en rend
aucune ne verrouille rien — deux transactions peuvent constater ensemble que
l'adresse est libre. Cette course-là n'est pas laissée ouverte pour autant :
c'est celle que l'unicité arbitre, ci-dessous. La fermer par un verrou
demanderait un verrou de prédicat, c'est-à-dire `SERIALIZABLE` sur la transaction
d'agenda — des échecs de sérialisation sur des réservations sans rapport entre
elles, pour remplacer un arbitrage que la contrainte rend déjà gratuitement.

### La course sur l'adresse se rejoue chez l'appelant

Deux réservations d'invité concurrentes sur la même adresse : la perdante reçoit
`P2002`, que la porte traduit en `ClientRecordRaceError`. Elle n'est **pas**
rattrapée sur place — une violation de contrainte abandonne la transaction côté
PostgreSQL, et Prisma n'ouvre aucun point de sauvegarde : relire échouerait en
`25P02`. C'est `AppointmentsRepository.writingAgenda` qui rejoue la transaction
entière, au même titre qu'un interblocage, trois fois au plus. La tentative
suivante relit alors **sous verrou** la fiche que la gagnante vient d'écrire, et
la juge : les deux fenêtres sont donc couvertes, chacune par le mécanisme qui lui
convient.

## Le second battant : la fiche désignée par le comptoir (#465)

`resolveWithin` part de coordonnées et crée au besoin ; `assertBookableWithin`
part d'une fiche que le comptoir a **désignée** et ne crée jamais rien. Même
porte, même signature — une portée de transaction, un identifiant en retour, rien
de la fiche —, et la même question : « cette réservation peut-elle se rattacher à
cette ligne `users` ? ».

### Ce qu'elle referme

`appointments.client_id` référence `users`, où vivent aussi les comptes du
personnel. Les deux clés étrangères composites que traverse une insertion prouvent
que la ligne existe et qu'elle est du bon établissement — jamais qu'elle est du
**fichier client**. Le tunnel public refusait déjà ce cas depuis #313 ; le
comptoir désigne au lieu de résoudre, et ne traversait donc pas cette porte. Un
`STAFF` qui posait l'identifiant d'un collègue obtenait un rendez-vous valide dont
la cliente était un employé.

Une contrainte de schéma aurait été plus forte, et c'est la première voie qui a
été regardée : `users` ne porte aucune colonne dérivée sur laquelle une clé
étrangère partielle pourrait s'appuyer. La porte est donc applicative.

### Les deux lectures qui jugent un rôle sont les seules à écrire du SQL brut

Pour le `FOR SHARE`, que le client Prisma n'exprime pas — et sans lequel ce
contrôle serait exactement la « vérification applicative suivie d'un `INSERT` »
que booking-engine §1 interdit. Sous `READ COMMITTED`, une lecture nue verrait
`CLIENT`, une transaction concurrente promouvrait la fiche et validerait, et
l'insertion passerait : les clés étrangères, elles, ne regardent pas le rôle. Le
verrou de ligne ferme la fenêtre jusqu'au `COMMIT` de l'appelant.

Ce battant a porté le verrou seul de #465 à #468, où il a été étendu à
`resolveWithin`. Le module compte donc désormais **deux** lectures en SQL — celles
qui jugent un rôle avant une insertion qui en dépend, et elles seules. Tout le
reste (recherche, projections, historique, et les deux créations) passe par le
client scopé, qui pose `tenant_id` sans qu'aucune requête ait à le nommer.

Il est **partagé** et non exclusif : deux réservations pour la même cliente chez
deux praticiens différents doivent pouvoir avancer de front. Seuls les écrivains
de la ligne attendent — ceux dont il faut se prémunir.

Le SQL brut ne repasse pas par l'extension de scoping (ADR 0006) : `tenant_id`
est donc écrit à la main dans la requête, depuis le contexte de requête et de
nulle part d'autre. C'est ce qui rend une fiche du salon voisin **absente** plutôt
que refusée pour un autre motif.

### Le refus est un 404, et c'est un arbitrage

| Ce que l'identifiant désigne | Ce que la porte rend |
|---|---|
| une fiche `CLIENT` de l'établissement | l'identifiant, tel quel |
| rien du tout | `NotFoundError` — 404 |
| une fiche du salon voisin | `NotFoundError` — 404 |
| un compte `STAFF`, `MANAGER` ou `ADMIN` | `NotFoundError` — 404 |
| une fiche **anonymisée** (#81) | `NotFoundError` — 404 |

Les trois refus sont **littéralement** le même : même classe, même message. Aucun
code neuf dans `@spa/shared`, et c'est délibéré.

C'est d'abord la conduite que ce module tient déjà partout : `findById`, `update`
et `setActive` replient « inconnu ici », « d'un autre établissement » et « c'est
un compte du personnel » sur un seul `null` — *« distinguer la troisième dirait
qui travaille au salon à qui n'a que le droit de lire des fiches »*. Un 409
`CLIENT_NOT_BOOKABLE` aurait dit exactement cela, et aurait fait de
`POST /appointments` une sonde de l'annuaire du personnel.

La symétrie avec `CLIENT_EMAIL_NOT_BOOKABLE` est par ailleurs trompeuse. Ce
409-là existe parce que `@@unique([tenantId, email])` ne laisse **aucune**
troisième voie : la visiteuse ne réservera jamais sous cette adresse, et le front
doit le savoir pour ne pas la renvoyer au calendrier (#452). Ici la voie existe et
elle est triviale — le comptoir a désigné la mauvaise ligne, et le tiroir de #50
ne montre que des `CLIENT`, si bien que ce corps ne se produit jamais par la
surface prévue. « Introuvable au fichier client » est vrai et actionnable ;
« définitivement non réservable » ne le serait pas.

## Tests

| Suite | Ce qu'elle couvre |
|---|---|
| `__tests__/customers.service.spec.ts` | CRUD, recherche, pagination, portée fermée par défaut |
| `__tests__/customer-privacy.spec.ts` | #81 : l'export complet et non borné, l'anonymisation qui vide aussi les textes libres des rendez-vous sans toucher aux montants, son idempotence, son refus sur un rendez-vous à venir, et la date de consentement qui ne bouge que sur un changement |
| `__tests__/client-directory.service.spec.ts` | la porte de #313 : lecture sans filtre de rôle, refus d'une adresse du personnel, fiche désactivée réutilisée, course traduite en réessai — son verrou de #468 : `FOR SHARE`, filtre `tenant_id` écrit à la main, refus sans portée de tenant — et celle de #465 : mêmes garanties, quatre rôles, refus muet sur le rôle |
| `__tests__/customer-history.service.spec.ts` | agrégat vs fenêtre, bornes, devises multiples |
| `__tests__/crm.logging.spec.ts` | le module ne journalise rien ; la rédaction couvrirait ses champs |
| `apps/api/test/crm.integration-spec.ts` | les huit routes servies, gardes, validation, sérialisation |
| `apps/api/test/crm-tenant.isolation-spec.ts` | le protocole de fuite sur les huit routes — dont la lecture la plus large du système (l'export) et sa seule écriture irréversible (l'anonymisation) |
| `apps/api/test/appointments-exclusion.integration-spec.ts` | la porte exercée contre un vrai PostgreSQL : le `ROLLBACK` qui emporte la fiche, le refus d'une adresse du personnel sans 500, la frontière du tenant sur cette écriture, et le rôle jugé à l'instant de l'insertion (#468) |
| `apps/api/test/appointments-exclusion.concurrency-spec.ts` | les courses : deux réservations d'invité sur la même adresse inconnue (#313), et la **promotion concurrente** qui prouve que le `FOR SHARE` de #468 verrouille vraiment — la suite unitaire ne vérifie que ce que la requête demande |

Le scénario délibéré des suites d'isolation est **la même personne dans les deux
salons** : `@@unique([tenantId, email])` l'autorise expressément, et c'est là
qu'une confusion de tenant se voit.
