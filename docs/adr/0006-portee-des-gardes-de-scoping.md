# ADR 0006 — Portée des gardes de scoping : heuristique de position, et confinement plutôt qu'inspection typée

- **Statut** : Accepté
- **Date** : 2026-08-27
- **Décideurs** : équipe TMap-Works (#268, suivi de #169)
- **Contexte CDC** : §2.1 isolation multi-tenant, §2.3 découpage modulaire,
  §4.12 CI/CD

## Contexte

L'isolation multi-tenant repose sur trois couches successives, chacune couvrant
ce que la précédente laisse passer :

1. le schéma — `tenant_id` non nullable, clés uniques composites, clés étrangères
   `(tenant_id, id)` ;
2. `tenant-scope.extension.ts` — le filtre injecté dans le pipeline
   `$allOperations` de Prisma, qui rend le scoping mécanique pour toute
   opération de modèle ;
3. le plugin ESLint local `tenant` — les échappatoires au pipeline.

La troisième couche a été posée par #169 avec deux règles, et **deux bords
déclarés ouverts** dans l'en-tête de `raw-sql-tenant-filter.js` :

- la garde vérifie que `tenant_id` est *mentionné*, pas qu'il *filtre* :
  `SELECT tenant_id, count(*) FROM appointments GROUP BY tenant_id` est une
  lecture de tous les établissements, et elle la satisfaisait ;
- le pool `pg` de `DatabaseConnection` expose PostgreSQL entièrement hors de
  Prisma, et son `client.query(…)` n'était couvert par rien.

Ces deux bords devaient être tranchés **maintenant** plutôt que découverts plus
tard : le moteur de disponibilité écrit son premier SQL brut au même jalon (#31,
contrainte d'exclusion anti-double-réservation de l'[ADR 0002](0002-anti-double-reservation.md)).
C'est ce calendrier qui pèse le plus lourd dans ce qui suit — une garde qui
casserait rétroactivement du SQL brut légitime coûterait plus qu'elle ne
rapporte.

## Décision 1 — La position du `tenant_id`

### Options envisagées

**A. Statu quo.** La garde force l'auteur à écrire la colonne au site d'appel,
donc à y penser ; la revue lit la requête. Coût nul, mais le contre-exemple
ci-dessus reste vrai, et il est écrit noir sur blanc dans une issue — c'est-à-dire
qu'il est connu de qui voudrait le retourner.

**B. Analyseur SQL.** Construire l'arbre de la requête et vérifier que la table
lue porte un prédicat sur `tenant_id`. C'est la seule option qui *prouve*
quelque chose. Elle apporte une dépendance d'analyse SQL, un dialecte à tenir
(PostgreSQL, `EXCLUDE USING gist`, verrous consultatifs), et un mode d'échec
désagréable : un SQL que l'analyseur ne sait pas lire bloque la CI d'un tiers
sans que le SQL soit fautif.

**C. Heuristique de position.** Exiger que `tenant_id` apparaisse dans une
position qui *contraint* la requête — comparaison, `USING`, liste de colonnes
d'`INSERT` — et non seulement quelque part dans le texte.

### Décision

**Option C.** La garde distingue désormais deux diagnostics : `missingTenantFilter`
(la colonne est absente) et `tenantNotFiltering` (elle est là, mais nulle part où
elle contraigne la requête).

La liste des positions reconnues est **délibérément généreuse**, et c'est le
cœur de l'arbitrage. Les deux erreurs possibles ne coûtent pas le même prix :

- un cas légitime oublié refuse une requête correcte et bloque la CI d'un autre
  ticket du jalon — un coût immédiat, sur du travail en cours ;
- un cas accepté à tort laisse passer une requête que la revue lit de toute
  façon, et que la couche 1 (clés étrangères composites) contraint encore.

On accepte donc large, et on nomme les bords. Les trois formes légitimes que
#268 identifiait — jointures `USING (tenant_id)` et `ON a.tenant_id = b.tenant_id`,
`INSERT INTO … (tenant_id, …)`, transtypages `tenant_id::text = $1` — sont
couvertes par des tests, comme la forme `tenant_id WITH =` qu'exige la contrainte
d'exclusion de l'ADR 0002 et la comparaison de n-uplet
`(tenant_id, id) = ($1, $2)`, que la clé composite du schéma rend naturelle.

Une seule forme *ressemblant* à un prédicat est refusée exprès : `tenant_id IS
[NOT] NULL`. Sur une colonne `NOT NULL`, `IS NOT NULL` est toujours vrai et lit
tous les établissements — l'accepter aurait donné à la garde la forme d'un
filtre sans la fonction. `IS NOT DISTINCT FROM $1`, lui, reste accepté.

Un effet de bord a été corrigé au passage : `collectLiteralSql` rendait les
fragments de gabarit dans l'ordre des clés de l'AST et non dans celui du source.
Sans conséquence tant que la garde cherchait une sous-chaîne, mais une lecture de
position exige que la colonne et l'opérateur qui la suit restent voisins — et un
`TemplateLiteral` de `typescript-eslint` porte `expressions` avant `quasis`. Les
fragments sont désormais triés sur leur position réelle (`range[0]`), seule
information indépendante de la forme du nœud et de la version du parseur.

### Ce que cela laisse ouvert, explicitement

L'heuristique reconnaît une position par motif ; elle ne construit pas d'arbre.
Elle ne sait donc dire ni **à quelle table** ni **à quel niveau de sous-requête**
le prédicat s'applique :

- `… FROM appointments WHERE id IN (SELECT id FROM x WHERE tenant_id = $1)` — le
  filtre est dans la sous-requête, la table externe n'en a pas ;
- `UPDATE t SET tenant_id = $1 WHERE id = $2` — la colonne est écrite, la ligne
  visée n'est pas bornée.

Ces deux formes passent, et c'est assumé : les fermer demanderait l'option B.

## Décision 2 — Le pool `pg` de service

### Options envisagées

**A. Règle typée sur `.query`.** Viser le type plutôt que le nom : un appel
`.query` sur une valeur typée `DatabaseConnection` / `PoolClient`. C'est la piste
que #268 proposait. Elle suppose `parserOptions.project`.

**B. Exemption seulement documentée.** Écrire dans `database.connection.ts` que
ce pool échappe aux gardes, et s'en remettre à la revue.

**C. Confiner plutôt qu'inspecter.** Ne pas chercher à lire ce qui passe par
`.query`, mais rendre mécaniquement impossible l'apparition d'un second accès
`pg` dans le code applicatif.

### Ce que la mesure a donné

Trois relevés sur ce dépôt, à la date de la décision :

| Mesure | Valeur |
|---|---|
| Temps de lint d'`apps/api`, à chaud, sans type | 2,9 s |
| Le même avec `parserOptions.project` sur `src/**` et `test/**` | 5,8 s (**×2**) |
| Appels `.query(…)` dans le dépôt | 4, **tous légitimement sans tenant** |
| Appels `$queryRaw` / `$executeRaw` dans `src/` et `test/` | 0 |

Les quatre appels `.query(…)` sont le `SELECT 1` de la sonde `/health`, et les
`CREATE DATABASE`, `DROP DATABASE` et rejeu de migration du harnais de base
jetable. Une garde sur `.query` serait donc aujourd'hui à **100 % de faux
positifs** : elle n'existerait que par ses exemptions. À quoi s'ajoute le
troisième obstacle nommé par #268, qu'aucune lecture du SQL ne lève : un verrou
consultatif (`pg_advisory_xact_lock`) dérive sa clé du tenant sans jamais nommer
la colonne.

Le ×2 n'est pas rédhibitoire en soi sur 118 fichiers. Ce qui tranche est
ailleurs : **le pool est déjà fermé par construction**. `DatabaseConnection.pool`
est privé, et la classe n'expose aucune méthode qui exécute du SQL fourni par
l'appelant — seulement `ping()`. Il n'existe aucun chemin par lequel un
repository atteindrait `client.query` sans d'abord modifier
`database.connection.ts`. Une règle typée surveillerait donc, à ×2 sur chaque
lint de chaque contributeur, un site d'appel injoignable.

### Décision

**Option C**, l'exemption étant actée et documentée comme l'exigeait le critère
d'acceptation.

1. `database.connection.ts` porte une section « Exemption de lint, actée » et une
   section « Ce que cette exemption suppose » : le `client.query(…)` de `ping()`
   n'est inspecté par aucune garde, et cela ne tient que sous deux conditions.
2. Une troisième règle, `tenant/service-pool-confinement`, interdit d'importer
   `pg`, `pg-pool` ou `pg-native` **ailleurs que dans `database.connection.ts`**
   — sous-chemins compris (`pg/lib/client` exporte le même `Client` que `pg`),
   et sous les quatre formes d'importation de TypeScript. Un second chemin brut
   vers le schéma ne peut plus apparaître sans que le lint le refuse — au coût
   de zéro milliseconde, la règle étant purement syntaxique.
3. `database.module.ts` et l'en-tête de `database.connection.ts` cessent de
   présenter ce pool comme « le chemin du SQL brut que Prisma n'exprime pas ».
   C'était une invitation à écrire ce qu'il y a de plus sensible là où rien ne
   regarde. Ce SQL s'écrit en migration, ou via `$queryRaw` / `$executeRaw` sur
   le client Prisma — où la décision 1 l'inspecte.

La règle est branchée sur `src/**` seulement. Le harnais de test jetable ouvre
légitimement un client `pg` pour créer et détruire des bases : ce n'est pas un
accès au schéma métier, et l'exclure par la portée vaut mieux que par trois
`eslint-disable` dispersés.

### Ce que cela laisse ouvert, explicitement

Une méthode de passe-plat ajoutée *à l'intérieur* de `database.connection.ts` —
un `query(sql: string)` public — rouvrirait le trou en entier, et aucune garde
automatique ne le verrait. Le fichier tient en une centaine de lignes dont
l'essentiel est ce commentaire, et son en-tête le dit ; c'est le seul point que
la relecture doit tenir, et c'est le prix assumé de ne pas typer le lint.

## Conséquences

**Ce que cela facilite.** Les trois gardes du plugin restent **syntaxiques** :
`npm run lint` garde son temps, et une règle se teste avec le `RuleTester` sans
projet TypeScript de fixture. Le SQL brut du moteur de disponibilité arrive dans
un cadre déjà tranché, avec ses formes légitimes couvertes par des tests plutôt
que découvertes en CI.

**Ce que cela coûte.** Deux angles morts nommés ci-dessus, qui ne se ferment
qu'en payant respectivement un analyseur SQL et un lint typé. Ils sont écrits
ici et dans le code, à l'endroit exact où quelqu'un les rencontrera.

**Ce que cela ferme.** L'idée que `DatabaseConnection` soit un chemin d'écriture
de SQL métier. Et, pour la durée du MVP, l'introduction de `parserOptions.project`
au seul motif du scoping : si le lint typé revient, ce sera pour une autre raison,
et cet ADR sera à relire — le ×2 mesuré ici croîtra avec le dépôt.

**Quand rouvrir.** Si un `tenantNotFiltering` se met à être désactivé
régulièrement par `eslint-disable`, c'est que l'heuristique est trop serrée et
qu'il faut élargir la liste des positions. Si à l'inverse une fuite passe la
garde en revue, c'est l'option B qu'il faut rouvrir.
