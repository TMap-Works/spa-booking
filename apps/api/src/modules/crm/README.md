# Module `crm`

Fiches clientes, coordonnées, notes internes, historique de visites (CDC §2.3).
C'est le module que le front-desk ouvre le plus souvent — et le seul dont la
totalité du contenu est une **donnée personnelle**. Tout ce qui suit découle de
ce fait.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #56 | Le CRUD des fiches, la note interne, la recherche indexée et l'historique agrégé |

Hors périmètre MVP, et donc non livré : fusion de doublons, segmentation,
export RGPD, campagnes. Le CDC §1.4 borne le module à un « CRM client de
base » ; chacun de ces besoins est une décision de produit à part entière.

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/customers` | `STAFF` |
| `GET` | `/api/v1/customers/:id` | `STAFF` |
| `GET` | `/api/v1/customers/:id/history` | `STAFF` |
| `POST` | `/api/v1/customers` | `STAFF` |
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

## Ce que le module lit, et ce qu'il n'importe pas

`CrmRepository` lit `users` et `appointments`. Il n'importe **aucun repository
voisin** : ce qu'api-module §3 interdit est un `../../identity/identity.repository`,
et il n'y en a pas. Les deux lectures sont argumentées en tête du fichier —
la première parce que la fiche *est* la ligne `users`, la seconde parce que
l'historique est une projection en lecture seule qui ne décide d'aucune règle de
cycle de vie. Le module **n'écrit jamais** dans `appointments`.

`CrmModule` n'importe qu'`IdentityModule`, et seulement pour ses gardes. Il
n'exporte rien : aucun autre module du périmètre MVP n'a de décision à prendre
sur une fiche cliente.

## Tests

| Suite | Ce qu'elle couvre |
|---|---|
| `__tests__/customers.service.spec.ts` | CRUD, recherche, pagination, portée fermée par défaut |
| `__tests__/customer-history.service.spec.ts` | agrégat vs fenêtre, bornes, devises multiples |
| `__tests__/crm.logging.spec.ts` | le module ne journalise rien ; la rédaction couvrirait ses champs |
| `apps/api/test/crm.integration-spec.ts` | les six routes servies, gardes, validation, sérialisation |
| `apps/api/test/crm-tenant.isolation-spec.ts` | le protocole de fuite sur les six routes |

Le scénario délibéré des suites d'isolation est **la même personne dans les deux
salons** : `@@unique([tenantId, email])` l'autorise expressément, et c'est là
qu'une confusion de tenant se voit.
