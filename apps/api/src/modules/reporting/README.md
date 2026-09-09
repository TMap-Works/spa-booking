# Module `reporting`

Agrégation du revenu, du volume de rendez-vous et des no-shows (CDC §2.3). C'est
le module que le gérant ouvre en fin de mois — et le seul du monolithe qui ne
possède **aucune table**.

Il n'écrit jamais **en base**. Depuis #563, il dépose un fichier : l'export CSV
des trois rapports, rangé dans un bucket S3 sous une clé préfixée par le
`tenant_id`, servi par URL présignée de quinze minutes au plus, et purgé par le
cycle de vie du bucket au bout de quelques jours. Un objet éphémère et
reproductible n'est pas un état métier — c'est une photographie de lectures.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #74 | Les trois rapports, leurs agrégats SQL et les deux index qui les servent |
| #563 | L'export CSV servi par URL présignée : sérialisation serveur, dépôt S3, deux routes |

Hors périmètre MVP, et donc non livré : insights de performance, reporting
transactionnel détaillé, comparaisons entre périodes, objectifs, prévisions. Le
CDC §1.4 borne le module à un « reporting de base : revenu, volume, no-shows » et
range explicitement les *insights de performance* dans ce qui est reporté aux
phases ultérieures.

L'écran est côté `apps/web` : c'est #75. L'export, lui, a commencé là-bas — #75
fabriquait le fichier dans le navigateur — et a été rapatrié ici par #563, la
seconde moitié de son cinquième critère (« servi par URL présignée ») ne pouvant
pas être tenue depuis un navigateur.

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/reports/revenue` | `MANAGER` |
| `GET` | `/api/v1/reports/appointments` | `MANAGER` |
| `GET` | `/api/v1/reports/no-shows` | `MANAGER` |
| `POST` | `/api/v1/reports/export` | `MANAGER` |
| `GET` | `/api/v1/reports/export/:exportId` | `MANAGER` |

**Aucune route publique, aucune route ouverte à `STAFF` ni à `CLIENT`.** Ces
routes rendent la performance de l'établissement : son chiffre d'affaires
jour par jour, et le rendement de chaque praticien. La personne qui décroche le
téléphone n'a besoin ni de l'un ni de l'autre, et une surface anonyme donnerait
le chiffre d'affaires d'un salon à qui connaît son slug.

Le seuil est celui de `GET /customers/:id/export` et de
`PATCH /customers/:id/status` chez `crm` : ce qui relève de la **conduite** du
salon plutôt que de sa tenue quotidienne. `ADMIN` aurait été trop haut — le CDC
range le reporting dans le back-office, et un gérant n'est pas toujours
l'administrateur du compte.

**Aucun identifiant d'établissement en chemin, nulle part.** Les trois routes de
lecture ne prennent aucun identifiant du tout : il n'y a rien à confondre entre
deux salons, et pas un 404 de traversée à écrire.

`GET /reports/export/:exportId` est la seule ressource adressable du module, et
elle ne relâche rien — voir « L'export » ci-dessous.

## La fenêtre

`from` **inclus**, `to` **exclu** — la convention de l'historique de
rapprochement (#62), et la seule qui permette de poser deux périodes bout à bout
sans compter deux fois l'écriture de minuit ni l'oublier.

Les deux bornes sont **obligatoires** et la fenêtre est plafonnée à **366 jours**
(`MAX_REPORT_WINDOW_DAYS`). Le plafond n'est pas là pour brider un usage — un
tableau de bord regarde une journée, une semaine, un mois, au plus un exercice —
mais pour qu'aucune requête n'échappe au dimensionnement sur lequel les index
ont été choisis : sans lui, `?from=1970-01-01T00:00:00Z` est un déni de service
à une requête, sur les trois routes à la fois.

366 et non 365 : « l'année 2028 », du 1er janvier au 1er janvier suivant, fait
366 jours sur une année bissextile.

Une fenêtre inversée, vide ou trop large répond **422** et non 400 : les deux
bornes sont individuellement bien formées, c'est leur relation ou leur étendue
qui est refusée (api-module §5).

## Le fuseau décide des journées

Les trois rapports lisent `tenants.timezone` avant toute chose, et le rendent
dans leur réponse. Une journée de caisse est celle que le salon vit : à Papeete,
la recette du 3 mars n'est pas celle qu'UTC appelle le 3 mars. Le découpage est
fait par PostgreSQL — `captured_at AT TIME ZONE $tz` — et le fuseau est un
paramètre lié, jamais une chaîne concaténée.

## Les trois définitions qui se discutent

Tout le reste du module est mécanique. Ces trois-là sont des décisions, et elles
sont rendues visibles à dessein — dans `ReportingService`, jamais enfouies dans
du SQL.

### 1. Ce qui fait recette

`SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`. Une intention `PENDING` n'est pas
de l'argent entré en caisse, une carte `FAILED` non plus. Un encaissement
remboursé, en revanche, **a bien eu lieu** : il reste au relevé, et c'est
`refunded_amount_minor` qui le retranche du net. L'écarter aurait fait
disparaître la vente *et* son remboursement, si bien qu'un encaissement remboursé
de moitié aurait pesé zéro au lieu de la moitié.

Le jour de caisse se lit sur `captured_at`, jamais sur `created_at` : un
règlement ouvert à 23 h 58 et capturé à 00 h 03 appartient au lendemain.

### 2. Le dénominateur du taux de no-show

`noShows / (honored + noShows)` — les rendez-vous **arrivés à échéance**.

Les annulations en sont exclues : un créneau annulé a été rendu, et souvent
revendu. Le compter au dénominateur diluerait le taux de tout ce que le salon a
su replacer — un établissement qui gère bien ses annulations verrait son taux
*baisser* sans qu'une seule personne se soit présentée en plus. Les rendez-vous
encore `PENDING` ou `CONFIRMED` sur la fenêtre n'ont pas encore été jugés.

Le taux vaut `null` — et non `0` — quand le dénominateur est nul : « aucun
rendez-vous à honorer sur la période » n'est pas « aucun no-show », et un 0 %
affiché sur un salon fermé se lirait comme une performance. Les quatre comptes
voyagent à côté et font foi : un écran qui préfère une autre définition la
recalcule sans redemander la fenêtre.

### 3. La date sur laquelle porte le volume

`starts_at` — la date du rendez-vous, pas celle de sa prise. « Combien de
rendez-vous en mars » se lit sur les rendez-vous de mars, pas sur les
réservations faites en mars pour avril.

## Les agrégats sont en SQL

C'est une exigence du ticket, et non une préférence de style : « les agrégats
s'appuient sur SQL, pas sur du code applicatif ». Trois raisons distinctes,
détaillées en tête de `reporting.repository.ts` :

- le revenu groupe sur une **expression** — la date civile d'un `timestamptz`
  ramené dans le fuseau du salon —, que `groupBy` de Prisma ne sait pas exprimer ;
- le volume croise **l'axe et le statut**, et joint pour le libellé ;
- les no-shows se comptent par `COUNT(*) FILTER (WHERE …)`, cinq compteurs en un
  seul balayage et sur un état cohérent.

Ce qui reste en TypeScript est **de la transposition, pas de l'agrégation** : le
repli des lignes `(groupe, statut)` en une ligne par groupe, et le cumul du
revenu depuis des jours déjà agrégés et jamais tronqués.

### Ce que cela impose

Le SQL brut **ne repasse pas par l'extension de scoping** (ADR 0006, angle mort
n°1) : chaque requête porte son propre `WHERE tenant_id = …`, dont la valeur vient
de `requireTenantId()`, donc du contexte de requête. Le module n'a **aucune**
dérogation à `tenant/raw-sql-tenant-filter`, et aucun `prismaUnscoped`.

Les jointures vers `staff` et `services` portent sur le couple `(tenant_id, id)`,
jamais sur l'identifiant seul : même si une ligne d'un salon référençait celle
d'un autre, la jointure ne la trouverait pas.

## Les index

Deux, posés par `20260906180000_add_reporting_indexes` — migration purement
additive, deux `CREATE INDEX`, aucune donnée touchée.

| Index | Ce qu'il sert |
|---|---|
| `payments (tenant_id, status, captured_at)` | le revenu quotidien : statut d'abord, la recette n'étant qu'un sous-ensemble des lignes |
| `appointments (tenant_id, service_id, starts_at)` | le volume par prestation, le troisième axe |

Les deux autres axes du volume étaient déjà servis par la migration initiale :
`(tenant_id, starts_at)` pour la période, `(tenant_id, staff_id, starts_at)` pour
le praticien.

`payments_tenant_id_status_created_at_idx` reste : il sert l'historique de
rapprochement de #62, qui trie bien par `created_at`. Les deux index ne répondent
pas à la même question.

## L'export (#563)

`POST /api/v1/reports/export?from=…&to=…` sérialise les **trois** rapports de la
fenêtre en un seul CSV, le dépose, et rend `{ id, url, expiresAt, filename }`.
`GET /api/v1/reports/export/:exportId` re-signe un export déjà produit sans le
reproduire.

`POST` et non `GET` sur la première : l'appel **crée** un objet dans un bucket.
Servie en `GET`, elle aurait fabriqué un fichier à chaque préchargement de
navigateur, à chaque rejeu de cache et à chaque bouton « précédent ».

### La clé, et l'isolation qu'elle porte

```
exports/{tenant_id}/{export_id}.csv
```

Le premier segment est l'établissement du **jeton vérifié**. Aucune route
n'accepte de `tenant_id`, aucune n'accepte de clé, et la clé n'est jamais reçue :
elle est **reconstruite** à chaque appel (`export/report-export.key.ts`).

C'est là — et nulle part ailleurs — que se joue le 404 exigé par le cinquième
critère de #563. Aucun code ne compare le propriétaire d'un export à l'appelant :
le voisin qui présente l'identifiant d'un export de A fait chercher
`exports/{B}/{id}.csv`, qui n'existe pas. Le refus est **404**, jamais 403 — un
403 confirmerait l'existence de l'export (tenant-isolation §4) — et jamais l'URL.

L'`export_id` est un UUID **tiré au sort**, pour deux raisons : deux exports de
la même période ne s'écrasent pas, et une clé devinable est une clé qu'on tente.

### L'URL présignée

Quinze minutes au plus (`MAX_REPORT_EXPORT_TTL_SECONDS`, contrat partagé), et
`REPORT_EXPORT_URL_TTL_SECONDS` ne sait que **raccourcir** — une valeur au-delà
du plafond fait échouer le démarrage plutôt que d'être rabotée en silence.

Une URL présignée est un **porteur** : quiconque la détient lit le fichier, sans
jeton, sans rôle et sans trace côté application. Elle transite par un journal de
navigateur, un historique, un presse-papier ; la seule chose qui borne les dégâts
est le temps qu'elle reste valable.

L'existence de l'objet est vérifiée **avant** la signature, et ce n'est pas une
politesse : `getSignedUrl` ne parle à personne — il calcule localement — et
signerait la clé d'un objet absent. Sans ce contrôle, la route rendrait une URL
à tout le monde, et la fuite ne se verrait qu'au moment de la suivre.

### Le fichier

Une table longue, `section;cle;libelle;mesure;valeur;devise`, en UTF-8 avec sa
marque d'ordre d'octets, séparée par des points-virgules (locale française) et
échappée selon RFC 4180.

Les sections sont, dans l'ordre : `periode`, `revenu_jour`, `revenu_total`,
`volume_day`, `volume_staff`, `volume_service`, `no_shows`. **Les trois axes de
volume y sont tous**, alors que l'export de #75 ne portait que celui que la
gérante avait filtré à l'écran : le fichier ne dépend donc plus du filtre, et un
seul export répond aux trois questions. Chaque axe porte son propre total, à clé
vide — une section `volume_total` commune, répétée trois fois avec le même nombre,
se serait lue comme trois totaux qui se contredisent.

**Les montants restent entiers**, en plus petite unité monétaire, avec leur code
devise dans la colonne prévue (`brut_minor`, `rembourse_minor`, `net_minor`).
Convertir en unité principale pour faire joli dans le tableur aurait introduit
exactement le flottant que CLAUDE.md interdit. Le taux de no-show est la seule
valeur non entière du fichier, et c'en est une par nature : c'est un ratio.

Ce que l'export **perd** par rapport à celui de #75, et il faut le dire : le
fichier n'est plus garanti identique à ce que l'écran affiche, puisqu'il est
relu côté serveur. Ce qu'il gagne : le détail complet des trois rapports plutôt
que ce qu'un écran a bien voulu peindre, et deux exports de la même fenêtre qui
disent la même chose.

### Sans bucket, 503

`REPORT_EXPORT_BUCKET` absente — un poste local, un environnement où le module
Terraform `reporting-export` n'est pas composé —, la route répond **503**
(`REPORT_EXPORT_UNAVAILABLE`) et les trois routes de lecture continuent de
servir. Défaut fermé, par requête, comme l'expéditeur de notifications non
configuré : l'export échoue visiblement plutôt que de rendre une URL qui ne mène
nulle part.

### L'infrastructure

`infra/terraform/modules/reporting-export` : bucket chiffré, non public, refusant
le transport en clair et tout principal hors du compte, avec un cycle de vie qui
purge les exports. La politique qu'il rend accorde `PutObject` et `GetObject` sur
`exports/*` — ni `ListBucket`, qui donnerait à l'API le droit d'énumérer les
exports de **tous** les établissements, ni `DeleteObject`, la purge étant
l'affaire du cycle de vie.

## Ce que ce module n'importe pas

Ni `PaymentsModule`, ni `AppointmentsModule`, ni `CatalogModule`, alors qu'il
agrège leurs trois tables. Le couplage aurait été à contresens : un rapport est
une projection en lecture seule qui ne décide d'aucune règle de cycle de vie, et
un agrégat sur un an de rendez-vous ne se compose pas d'appels de service — la
voie « appel de service » d'api-module §3 sert une lecture unitaire, pas un
balayage.

Il n'exporte rien non plus. Un module qui ne fait que lire n'a rien à offrir aux
autres, et ouvrir une porte ici reviendrait à offrir à n'importe quel module le
chiffre d'affaires de l'établissement.

## Ce qu'aucune réponse ne porte

Aucun nom de cliente, aucune adresse, aucune note interne, aucune référence de
prestataire, aucune ligne d'encaissement. Un rapport est un tableau de chiffres ;
le détail transaction par transaction existe sous `GET /payments` (#62), derrière
ses propres gardes.

Les seuls libellés rendus sont le nom **public** du praticien — celui que
l'agenda affiche déjà — et le nom de la prestation au mur.

## Les suites

| Suite | Ce qu'elle garde |
|---|---|
| `__tests__/reporting.service.spec.ts` | les trois définitions ci-dessus, et le 404 sur établissement disparu |
| `__tests__/reporting.repository.spec.ts` | que chaque requête lie le tenant **du contexte**, et refuse de lire hors portée |
| `__tests__/reporting.vocabulary.spec.ts` | que les listes recopiées disent ce que disent les `enum` PostgreSQL, et que les deux index existent |
| `test/reporting.integration-spec.ts` | que les trois routes sont servies, gardées, et que la fenêtre est refusée là où il faut |
| `test/reporting-tenant.isolation-spec.ts` | qu'aucun chiffre de A ne compte une ligne de B — avec deux salons dont la journée est identique |
| `__tests__/report-export.key.spec.ts` | que la clé commence par l'établissement, et que le nom du fichier dit la période réellement couverte |
| `__tests__/report-export.csv.spec.ts` | la forme du fichier : montants entiers, marque d'ordre d'octets, échappement RFC 4180 |
| `__tests__/report-export.config.spec.ts` | qu'un environnement nu laisse démarrer, et qu'une durée de vie hors bornes est refusée |
| `__tests__/report-export.service.spec.ts` | le préfixe de clé, le 422 qui ne dépose rien, et le 404 du voisin |
| `test/reporting-export.integration-spec.ts` | que les deux routes sont servies, gardées au rang `MANAGER`, et que l'échéance est bornée |
| `test/reporting-export.isolation-spec.ts` | que le jeton du voisin rend 404 — et qu'aucune URL, clé ni chiffre de A ne fuit |
