# Module `reporting`

Agrégation du revenu, du volume de rendez-vous et des no-shows (CDC §2.3). C'est
le module que le gérant ouvre en fin de mois — et le seul du monolithe qui ne
possède **aucune table** et n'écrive **jamais**.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #74 | Les trois rapports, leurs agrégats SQL et les deux index qui les servent |

Hors périmètre MVP, et donc non livré : insights de performance, reporting
transactionnel détaillé, comparaisons entre périodes, objectifs, prévisions. Le
CDC §1.4 borne le module à un « reporting de base : revenu, volume, no-shows » et
range explicitement les *insights de performance* dans ce qui est reporté aux
phases ultérieures.

L'écran et l'export CSV n'en font pas partie non plus : c'est #75, côté
`apps/web`.

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/reports/revenue` | `MANAGER` |
| `GET` | `/api/v1/reports/appointments` | `MANAGER` |
| `GET` | `/api/v1/reports/no-shows` | `MANAGER` |

**Aucune route publique, aucune route ouverte à `STAFF` ni à `CLIENT`.** Ces
trois routes rendent la performance de l'établissement : son chiffre d'affaires
jour par jour, et le rendement de chaque praticien. La personne qui décroche le
téléphone n'a besoin ni de l'un ni de l'autre, et une surface anonyme donnerait
le chiffre d'affaires d'un salon à qui connaît son slug.

Le seuil est celui de `GET /customers/:id/export` et de
`PATCH /customers/:id/status` chez `crm` : ce qui relève de la **conduite** du
salon plutôt que de sa tenue quotidienne. `ADMIN` aurait été trop haut — le CDC
range le reporting dans le back-office, et un gérant n'est pas toujours
l'administrateur du compte.

**Aucun identifiant en chemin, nulle part.** C'est une propriété rare dans ce
dépôt et elle simplifie tout : il n'y a rien à confondre entre deux salons, et
pas un seul 404 de traversée à écrire. Le seul 404 du module est celui de
l'établissement disparu sous la requête.

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
