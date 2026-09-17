# ADR 0015 — Carte au comptoir par TPE

- **Statut** : Accepté
- **Date** : 2026-09-17
- **Décideurs** : PO (arbitrage du 16/09/2026, tracé dans #832), équipe backend
- **Contexte CDC** : §1.3 (gestion de caisse hors périmètre), §1.4 « POS de base :
  services + produits retail, **carte ou espèces** », §2.4 « Payment — Transaction
  (montant, moyen, statut) », §4.9 (délégation du traitement des cartes à un
  prestataire PCI-DSS niveau 1, réconciliation)

## Contexte

Le CDC §4.9 délègue le traitement des cartes à un prestataire PCI-DSS niveau 1,
ce qui ramène notre obligation à une auto-évaluation **SAQ A**. Cette réduction
de périmètre est conditionnelle : elle disparaît à la seconde où un numéro de
carte traverse notre code.

Au 16/09/2026, l'encaissement au comptoir la faisait disparaître. « Payer X €
par carte » sur l'écran d'encaissement du back-office faisait deux choses :

- il ouvrait une intention Stripe, par `POST /public/{slug}/payments/intents`
  (`apps/web/lib/api-client.ts`) ;
- il affichait le **formulaire de carte de Stripe dans la page d'encaissement**
  (`apps/web/app/(admin)/[tenantSlug]/admin/encaissement/.../checkout-card-form.tsx`).

La carte se saisissait donc sur l'écran du salon, au comptoir, sous la dictée de
la cliente. C'est précisément ce que la skill du dépôt interdit, et elle le dit
sans détour (`.claude/skills/payments-stripe/SKILL.md` §4, « Carte au
comptoir ») :

> Ne jamais saisir un numéro de carte dicté par le client dans un formulaire —
> c'est exactement ce que SAQ A interdit.

Trois faits achèvent de fermer la question :

1. **le comptoir était le seul usage de Stripe dans le produit.** Le tunnel
   client n'a pas d'étape de paiement : on réserve sans payer (#37). Stripe ne
   servait donc, en pratique, qu'à ce formulaire-là ;
2. **Stripe n'ouvre pas de compte marchand pour un établissement installé à
   Madagascar** (vérifié sur stripe.com/global au moment de la rédaction). C'est
   le cas de Barber Tana, l'un des deux salons du jeu d'essai : le produit ne
   pouvait pas encaisser une carte chez la moitié de ses établissements de
   recette ;
3. **le salon a déjà un terminal.** Le TPE fourni par sa banque est l'objet par
   lequel une carte se règle au comptoir dans ce métier, et il fonctionne sans
   nous.

La question n'est donc pas « comment intégrer proprement un formulaire de carte
au back-office » mais « qu'est-ce que l'application a à faire d'un paiement
qu'elle n'exécute pas ».

## Options envisagées

### Option A — Stripe Terminal, avec lecteur physique

Un lecteur Stripe (BBPOS, Verifone) piloté par notre application : le montant est
poussé au lecteur, la carte ne traverse jamais notre code, et le webhook conclut.
C'est la solution que payments-stripe §4 nomme en premier.

Écartée pour deux raisons de fait, pas de goût : elle suppose un compte marchand
Stripe — indisponible à Madagascar — et l'achat d'un lecteur par établissement,
alors que le salon possède déjà un TPE qui marche. Elle ferait dépendre le
lancement d'un matériel à commander.

### Option B — Lien de paiement envoyé à la cliente

L'autre branche de payments-stripe §4. Elle tient la frontière PCI, mais déplace
le geste : la cliente reçoit un lien et paie sur son téléphone, au comptoir,
devant la caisse. Cela ajoute une attente, un échec possible (réseau, e-mail non
reçu) et une dépendance au compte marchand — le même obstacle qu'en A.

### Option C — TPE autonome, règlement **déclaré**

L'application n'exécute aucun paiement par carte au comptoir. La carte se règle
sur le TPE de la banque du salon, et l'application **enregistre** ce que le
caissier déclare : le moyen, le montant, l'opérateur, l'horodatage, et le numéro
du ticket du terminal s'il l'a relevé.

Inconvénient réel et assumé : la saisie n'est pas **prouvée**. Rien ne garantit
côté serveur que le terminal a bien autorisé l'opération — c'est une déclaration
d'opérateur, comme l'est déjà l'encaissement en espèces. L'écart se constate au
rapprochement de fin de journée, contre le relevé que le terminal imprime, et
c'est exactement le régime que le CDC §4.9 décrit pour la réconciliation.

### Option D — TPE intégré, qui pousse le montant au terminal

Le montant part de notre application vers le terminal, qui rend l'autorisation.
C'est la bonne solution à terme — elle supprime la faute de frappe et la
déclaration de complaisance — mais elle demande une intégration par banque et par
modèle de terminal, et elle sort du périmètre MVP figé. Renvoyée en post-MVP
(#833).

## Décision

**Au MVP, la carte au comptoir se règle sur un TPE autonome, et l'application
enregistre un règlement déclaré.**

1. **Le TPE est autonome.** C'est le terminal de la banque du salon ; il n'est
   pas relié à l'application, et l'application ne lui parle pas.
2. **L'application n'appelle aucun prestataire sur ce chemin, et ne reçoit
   jamais de donnée de carte.** Le règlement s'inscrit `SUCCEEDED` à l'écriture,
   avec l'opérateur du jeton et l'horodatage — le même régime que les espèces,
   pour la même raison : il n'y a aucun tiers dont on attende la confirmation.
3. **Stripe n'est plus utilisé au comptoir.** Le module Stripe reste en place —
   intentions, webhooks signés, remboursements — pour le paiement **en ligne** du
   tunnel public, qui est le seul endroit du produit où Stripe touche une carte.
   `POST /public/{slug}/payments/intents` reste servie et son README dit
   désormais explicitement qu'elle ne sert pas le comptoir.
4. **Le TPE intégré est post-MVP** (#833).
5. **Le schéma distingue les deux cartes par un canal, non par un moyen de
   plus.** `PaymentCardChannel { STRIPE, TERMINAL }` et `payments.card_channel`.

Le cinquième point est le seul où l'issue laissait un choix ouvert — « soit une
valeur d'énumération `CARD_TERMINAL`, soit une colonne de canal » — et il mérite
d'être justifié.

### Pourquoi un canal plutôt que `CARD_TERMINAL` dans `PaymentMethod`

Parce que les deux faits sont **orthogonaux** : ce que la cliente a présenté (un
billet, une carte) et par quel tuyau cela est passé (le terminal du salon, une
intention Stripe). `method` est lu par des consommateurs qui n'ont aucune raison
de connaître le tuyau :

| Qui lit `method` | Ce qu'il en fait |
|---|---|
| `reporting` | la ventilation du revenu par moyen |
| le reçu (#818, #819) | le libellé « Espèces » ou « Carte bancaire (TPE) » |
| le rapprochement (`GET /payments?method=`) | isoler ce qui doit se retrouver sur un relevé |
| le front (`packages/shared`) | les mêmes deux valeurs, en minuscules |

Ajouter une troisième valeur à l'énumération aurait **changé le sens de leur
filtre `CARD` du jour au lendemain, en silence** : un écran qui demandait « les
cartes » aurait cessé d'en voir une partie, sans qu'aucun type ne s'en plaigne.
Le canal, lui, est un fait nouveau qui s'ajoute sans rien redéfinir — et le TPE
intégré de #833 entrera comme un troisième canal, toujours sans toucher au moyen.

Deux contraintes de base bornent le couple, plutôt que de le laisser à une
convention d'écriture :

- `payments_card_channel_check` — `"card_channel" IS NULL OR "method" = 'CARD'` :
  un canal n'existe que sur une carte, si bien qu'un billet ne peut pas se voir
  attribuer un tuyau ;
- `payments_terminal_reference_check` : une référence de terminal n'existe que
  sur un règlement passé au terminal.

### Pourquoi une implication et non une équivalence, et pourquoi aucune reprise

La première écriture de cette décision exigeait le canal de **toute** carte —
l'équivalence `("method" = 'CARD') = ("card_channel" IS NOT NULL)` — et
reprenait les lignes existantes par un `UPDATE … SET card_channel = 'STRIPE'
WHERE method = 'CARD'`, au motif qu'elles *sont* des intentions Stripe, le TPE
n'ayant pas existé avant.

Elle a échoué à l'application, sur `spa_dev` :

```
ERROR: new row for relation "payments" violates check constraint
       "payments_sale_required_check"
```

La cause est `payments_sale_required_check`, que #817 a posé **`NOT VALID`** :
PostgreSQL ne relit pas l'existant à la pose, mais il applique la contrainte à
**toute mise à jour** d'une ligne ancienne. Un règlement inscrit avant #817 n'a
pas de vente ; le toucher, même pour une colonne sans rapport, le rend
irrecevable. La reprise aurait donc échoué sur toute base où
`pos.sale-backfill.ts` n'a pas encore tourné — ce qui est le cas de `spa_dev`
aujourd'hui, et rien ne garantit que ce ne soit pas celui de la recette.

Ce défaut était **invisible en CI** : elle rejoue les migrations sur un
PostgreSQL neuf, où la table est vide et la reprise un geste sans effet. Il n'est
apparu qu'en appliquant la migration à une base qui porte des données.

La décision est donc : **la migration n'écrit aucune ligne**, et la contrainte
est une implication, posée valide. Ce qu'elle laisse représentable — une carte au
canal nul — n'est écrit par aucun chemin du code (`payments.repository.ts` pose
`STRIPE`, `settlement.repository.ts` pose `TERMINAL`) et ne peut donc qu'être
antérieur à ce ticket, c'est-à-dire une intention Stripe. C'est ce que
`settlementMeanOf` énonce en la repliant sur `CARD_ONLINE`, et ce que le filtre
de `GET /sales?method=CARD_ONLINE` accepte explicitement.

Bénéfice secondaire, qui n'était pas cherché : un retour arrière du **code**
seul reste sans effet de bord. La version antérieure n'écrit pas le canal, et
l'implication ne le lui demande pas — là où l'équivalence aurait fermé
l'encaissement par carte au premier `git revert`.

### Le vocabulaire du fil, et pourquoi il diffère de celui du schéma

Le **contrat HTTP** nomme les combinaisons légitimes : `CASH`, `CARD_TERMINAL`,
`CARD_ONLINE`. Le corps de `POST /v1/sales/{saleId}/payments` n'accepte que les
deux premières, et c'est ainsi que « Stripe n'est plus utilisé au comptoir »
devient un fait de typage plutôt qu'un contrôle à écrire : il n'existe pas de
valeur à refuser.

Le **domaine**, lui, continue de parler de `PaymentMethod`. Au comptoir, « carte »
n'a plus qu'un sens depuis cette décision — celui du terminal —, si bien que le
canal se déduit de la route (`counterSettlementOf`) au lieu de traverser quatre
couches en double orthographe. La conversion se fait une fois, dans
`toSettlementRequest`. C'est le même partage, documenté au même titre, que la
casse des statuts entre l'énumération PostgreSQL et le fil public.

### La référence du ticket du terminal

`payments.terminal_reference`, `VARCHAR(32)`, facultative : c'est le numéro
d'opération ou d'autorisation que le TPE imprime, et c'est par lui que le
rapprochement part de notre ligne pour retrouver la sienne. C'est un identifiant
opaque émis par la banque du salon, du même rang qu'un `pi_…` — rien n'interdit
de le conserver.

Ce qu'un texte libre sur le chemin de l'argent rend en revanche possible, et que
la frontière HTTP ferme : qu'un caissier y saisisse le **numéro de carte** de la
cliente. Deux barrières, et il en faut deux :

| Barrière | Ce qu'elle arrête |
|---|---|
| 32 caractères alphanumériques au plus | un PAN espacé ou tirets compris, un nom de porteur, une phrase |
| la clé de Luhn sur 13 à 19 chiffres | un PAN collé, la saisie la plus probable |

Le refus est un **400 du `ValidationPipe`** : avant le contrôleur, avant le
service, avant toute écriture, et avant tout journal — ce qui est la seule façon
de garantir qu'un numéro saisi par mégarde ne laisse aucune trace.

Ce contrôle ne prétend pas rendre impossible d'écrire un PAN en base : un numéro
mal recopié échoue à Luhn, et rien ne le distingue alors d'une référence
légitime. La garantie structurelle reste celle du module depuis #57 — **il
n'existe aucun champ de carte**, donc rien à quoi une carte serait destinée.

### La clé d'idempotence

`Idempotency-Key` est **obligatoire** sur `POST /v1/sales/{saleId}/payments`.
Cette route n'est pas rejouable par construction et ne peut pas l'être : deux
règlements de 25,00 € sur le même ticket sont deux gestes distincts, et les
confondre effacerait l'un des deux du rapprochement. Rien du côté serveur ne
distingue donc la double soumission du double geste — l'appelant seul le sait.

L'unique est **par ticket** (`@@unique([tenantId, saleId, idempotencyKey])`) et
non par établissement : la clé dédoublonne une soumission à *ce* ticket, et la
même clé employée sur deux ventes décrit deux opérations différentes. La portée
par établissement aurait exigé un code d'erreur de conflit inter-ventes que le
contrat partagé ne porte pas.

La relecture vit **dans la transaction**, sous le verrou de la ligne `sales`, et
avant tout refus : une double soumission ne doit pas recevoir le 409 « déjà
soldé » que son propre premier appel a provoqué. C'est le même ordre que celui de
la marque d'idempotence des webhooks (payments-stripe §3), et pour la même
raison — un test préalable hors transaction laisserait passer les deux
concurrentes.

## Conséquences

**Ce que cela facilite.**

- La frontière SAQ A redevient vraie **partout** : plus aucun formulaire de carte
  dans une page que nous servons, et le module `payments` n'a toujours aucune
  colonne où ranger un PAN.
- Un salon encaisse la carte sans compte marchand Stripe, donc à Madagascar comme
  ailleurs. Le lancement ne dépend plus de la géographie du prestataire.
- Le règlement mixte de #817 accepte le nouveau moyen sans rien changer : 50,00 €
  d'espèces puis 28,00 € au terminal soldent un ticket de 78,00 €, et les deux
  lignes se lisent séparément au rapprochement.
- La relève de fin de journée est possible : `GET /v1/sales?method=CARD_TERMINAL`
  posé sur une journée rend les tickets passés au terminal.

**Ce que cela coûte.**

- **Le règlement par carte n'est plus prouvé.** C'est une déclaration
  d'opérateur, et l'écart se constate au rapprochement. Un caissier peut
  déclarer un règlement au terminal qui n'a pas eu lieu — exactement comme il
  peut déclarer un billet qu'il n'a pas pris. La traçabilité (opérateur,
  horodatage, référence) est ce qui rend l'écart imputable, pas ce qui l'empêche.
- **La réconciliation devient manuelle sur cette moitié.** Le relevé du terminal
  n'est pas une API : c'est un ticket papier. Là où les lignes `CARD_ONLINE` se
  rapprochent par `pi_…` et `ch_…`, les lignes `CARD_TERMINAL` se rapprochent à
  l'œil. La gestion de caisse — clôture, écarts, tiroir — reste hors MVP
  (CDC §1.3).
- **Un règlement au terminal ne se rembourse pas par cette API.** Il ne porte
  aucune référence d'intention, et `POST /payments/:id/refunds` le refuse en 422.
  Rendre l'argent d'un passage au TPE est un geste qui se fait sur le terminal,
  au comptoir. La route de remboursement reste celle des paiements en ligne.
- **Deux vocabulaires cohabitent** — `CASH`/`CARD` en base et dans le domaine,
  `CASH`/`CARD_TERMINAL`/`CARD_ONLINE` sur le fil. La conversion est à un seul
  endroit, et les deux témoins de `payments.types.spec.ts` vérifient qu'elle est
  bijective ; c'est le prix de n'avoir pas redéfini `method` sous ses lecteurs.
- **Une carte au canal nul reste représentable** — les lignes antérieures à ce
  ticket. Tout lecteur du canal doit donc traiter le nul comme `STRIPE`, et un
  seul endroit le fait (`settlementMeanOf`). Le jour où `pos.sale-backfill.ts`
  aura été joué partout, une migration ultérieure pourra valider
  `payments_sale_required_check` puis reprendre le canal et resserrer la
  contrainte en équivalence ; cela se décide sur l'état réel des bases, pas ici.

**Ce que cela ferme.**

- Toute réintroduction d'un formulaire de carte dans le back-office : elle ne
  serait pas un ajout de fonctionnalité mais une sortie de SAQ A, donc un ADR à
  remplacer.
- Le pilotage d'un lecteur depuis l'application, jusqu'à #833.

**Ce qui reste à faire, et n'est pas dans l'empreinte de #834.**

L'écran d'encaissement du back-office appelle encore
`POST /public/{slug}/payments/intents` et monte encore le formulaire de carte de
Stripe : `apps/web/lib/api-client.ts` et
`apps/web/app/(admin)/[tenantSlug]/admin/encaissement/`. **Tant que ce front
n'est pas reprisé, la faute constatée le 16/09 est toujours à l'écran** — l'API
ne la sert plus, mais la page existe. Une issue de suivi porte la reprise : elle
doit remplacer le formulaire par le choix « Espèces / Carte (TPE) », un champ de
référence facultatif, et l'envoi d'un `Idempotency-Key`.
