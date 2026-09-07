# ADR 0008 — Le contrat Zod valide, la classe DTO documente

- **Statut** : Accepté
- **Date** : 2026-09-07
- **Contexte CDC** : §2.3 Découpage modulaire, §4.2 Contrats d'API
- **Issues** : #26 (dépendance `@spa/shared`), #314 / PR #401 (inventaire des
  écarts), #404 (substitution), #403 (version d'UUID), #66 (E.164)

## Contexte

`packages/shared` est déclaré source de vérité des contrats d'API (CLAUDE.md,
api-module §4). Il décrit chaque forme entrante et sortante en **Zod**.

`apps/api` décrit **les mêmes formes une seconde fois**, en classes annotées
`class-validator` + `@nestjs/swagger`. Cinquante-six fichiers portaient un
`TODO(#26)` disant que la seconde écriture disparaîtrait le jour où l'API
dépendrait du paquet partagé. Cette dépendance existe depuis #463 ; la
substitution, elle, n'avait jamais été instruite.

Le doublon n'est pas gratuit. #401 y a trouvé une divergence réelle :
`emailSchema` acceptait des adresses que `@IsEmail()` refuse, sur les deux bornes
de longueur de la RFC 5321. Le contrat était donc **plus permissif que l'API
qu'il décrit** — le sens dangereux : un formulaire déclare l'adresse bonne,
l'envoie, et récolte un 400 qu'il venait d'annoncer impossible.

Ce qui a empêché la substitution jusqu'ici n'est pas la dépendance, c'est un fait
technique précis : **le schéma OpenAPI de `/api/docs` est produit par les
décorateurs `@nestjs/swagger` posés sur les classes DTO.** Zod ne les porte pas.
Supprimer les classes supprimerait la documentation de l'API — que le CDC exige
et dont dépend la recette fonctionnelle par MCP (ADR 0005, dont l'étape
`api_openapi` lit ce document pour vérifier qu'une route est bien servie).

## Options envisagées

### Option A — Garder `class-validator`, n'importer que les constantes

On remplace les littéraux recopiés (`NAME_MAX_LENGTH`, motifs de date) par les
constantes de `@spa/shared`, et on laisse les décorateurs de validation en place.

C'est peu coûteux et cela referme les divergences de **bornes**. Mais cela laisse
intactes les divergences de **règle** — E.164 contre format libre, version
d'UUID, normalisation d'une adresse —, qui sont précisément celles que #401 a
trouvées. Deux moteurs de validation continuent de décrire la même frontière, et
rien n'empêche l'un de bouger sans l'autre. On garde le doublon en croyant
l'avoir traité.

### Option B — Générer les décorateurs OpenAPI depuis Zod

Une bibliothèque (`@anatine/zod-openapi`, `nestjs-zod`, `zod-to-openapi`) dérive
un schéma OpenAPI d'un schéma Zod, et fabrique au besoin une classe DTO
synthétique pour Nest.

C'est la voie la plus complète : une seule écriture, documentation comprise. Elle
coûte une dépendance de plus au périmètre PCI-adjacent de l'API, un couplage à un
paquet tiers dont la compatibilité suit Zod **et** Nest, et une réécriture de
tous les DTO d'un seul tenant. Elle fait aussi disparaître les descriptions
françaises longues que portent aujourd'hui les `@ApiProperty` — ce sont elles qui
rendent `/api/docs` lisible par autre chose qu'un générateur de client.

Elle est écartée **pour le MVP**, pas sur le fond : la reprise est possible plus
tard sans rien casser de ce qui est décidé ici, les schémas Zod étant déjà la
source de vérité.

### Option C — Zod valide, la classe documente

La classe DTO survit, dépouillée de ses décorateurs `class-validator` : elle ne
porte plus que `@ApiProperty` et sert **uniquement** à produire le schéma
OpenAPI. La validation est faite par le schéma Zod de `@spa/shared`, monté sur le
paramètre du handler par un `ZodValidationPipe`. Le handler déclare le type
inféré du schéma, jamais la classe.

Le coût est que la classe et le schéma restent deux objets, et qu'on pourrait
donc encore documenter autre chose que ce qu'on valide. C'est un risque de
**documentation**, plus une divergence de comportement : la règle appliquée à la
requête n'a plus qu'une écriture.

## Décision

**Option C.** Sur toute route substituée :

1. **Le schéma Zod de `@spa/shared` est le seul validateur.** Il est monté par
   `ZodValidationPipe` (`apps/api/src/common/validation/`), qui traduit un refus
   en `BadRequestException` portant un tableau de messages — exactement la forme
   que `ValidationPipe` produit, donc exactement le corps
   `{ code: "VALIDATION_ERROR", message, details.violations }` que
   `DomainExceptionFilter` sert déjà. Aucun client ne voit la différence.
2. **La classe DTO ne porte plus aucun décorateur `class-validator`.** Elle garde
   ses `@ApiProperty` et n'est plus référencée que par `@ApiBody` /
   `@ApiOkResponse`. Le paramètre du handler est typé par `z.infer<…>`.
3. **Le `.strict()` du contrat remplace `forbidNonWhitelisted`.** C'est ce qui
   maintient la propriété d'isolation : un `tenantId` glissé dans un corps JSON
   est refusé par le schéma au lieu de l'être par le pipe global
   (tenant-isolation §2). Un schéma d'entrée **non** `.strict()` ne peut donc pas
   être substitué : la vérification est explicite dans `ZodValidationPipe`.
4. **Le pipe global reste en place** et continue de servir les DTO non encore
   substitués. Il ignore les paramètres typés par un alias de type, dont la
   métadonnée émise est `Object`. Les deux régimes cohabitent sans se gêner.
5. **En sortie, la classe reste la forme servie**, et le contrat la garde par une
   **assertion de compilation** plutôt que par une validation à l'exécution. La
   raison est que les schémas de sortie du contrat *transforment* : ils décrivent
   la forme **lue par le front**, pas celle émise par l'API — `status` y est en
   minuscules, l'API émettant la casse de l'énumération PostgreSQL. Valider notre
   propre sortie contre eux exigerait de changer le format du fil.
   `apps/api/src/modules/appointments/dto/book-appointment.dto.ts` porte donc
   deux assertions : jeu de clés identique à celui du schéma, et champ par champ
   assignable à `z.input<…>`. Un champ ajouté d'un côté et pas de l'autre casse
   la compilation.

### Ce que la substitution tranche au passage

Substituer, c'est faire passer l'API du comportement de ses décorateurs à celui
du contrat. Deux écarts que #314 avait laissés ouverts se referment donc
mécaniquement, et le sens dans lequel ils se referment est une décision :

- **Téléphone.** `guestContactSchema` valide `phone` avec `e164PhoneSchema`, qui
  **normalise** et **refuse un numéro national**. Le tunnel public passe donc à
  l'E.164. C'est la répartition déjà arrêtée par #66 : les surfaces qui
  **composent** un numéro (le rappel SMS J-1 part de là) l'exigent en E.164 ;
  celles qui l'**enregistrent** ou l'**affichent** — fiche cliente, inscription,
  profil, compte staff, `contactPhone` d'un établissement — gardent
  `phoneSchema`, format libre borné. `users.phone` n'est donc **pas** en E.164
  pour tous ses écrivains, et c'est délibéré : durcir la colonne rendrait
  illisible le stock écrit avant la règle (`storedPhoneSchema`).
- **Version d'UUID.** `uuidSchema` acceptait n'importe quelle version là où
  `@IsUUID('4')` exige la v4. Le contrat est **resserré sur la v4**, et non les
  DTO relâchés : c'est le sens qui laisse le comportement de l'API inchangé, et
  le seul des deux qui refuse l'UUID nil. Tous les identifiants du produit sont
  générés par `@default(uuid())` de Prisma, qui est une v4. Cela répond au
  premier critère de #403.

## Conséquences

**Ce que cela facilite.** Une règle d'entrée n'a plus qu'une écriture. Un
formulaire d'`apps/web` qui valide avec le contrat produit exactement ce que la
route accepte — plus de 400 annoncé impossible. Les suites qui existaient pour
tenir les deux moitiés d'accord (`guest-contract.spec.ts`) n'ont plus d'objet et
disparaissent : leur disparition est la preuve que la substitution a eu lieu.

**Ce que cela coûte.** Trois choses, et aucune n'est cosmétique :

- **La documentation peut mentir là où le comportement ne le peut plus.** Une
  `@ApiProperty` décrit encore à la main ce que le schéma impose. C'est un recul
  par rapport à l'option B, assumé pour ne pas ajouter de dépendance. Les
  assertions de compilation du point 5 couvrent la sortie ; l'entrée reste
  couverte par la recette MCP, qui exerce un refus de validation par route.
- **api-module §4 est amendée.** « Toute entrée est un DTO annoté
  `class-validator` » devient : toute entrée est validée par le schéma du contrat
  quand il en existe un ; la classe reste pour OpenAPI. La skill est hors de
  l'empreinte de #404 et part en issue de suivi.
- **La migration est progressive, donc l'état intermédiaire est hétérogène.** Le
  tunnel public d'`appointments` est substitué ; les routes de back-office, et
  les modules `availability`, `catalog`, `crm`, `identity`, `notifications`,
  `payments`, `reporting` ne le sont pas encore. Un lecteur croise donc les deux
  régimes. C'est le prix d'une reprise qui ne se fait pas en un seul diff de
  cinquante-six fichiers, et l'issue de suivi nomme ce qui reste.

**Ce que cela ferme.** L'idée qu'on puisse « aligner » les deux écritures en les
gardant toutes les deux. #401 a montré qu'une divergence de bornes tient des mois
sans se voir ; deux moteurs de validation sur une même frontière finissent
toujours par décrire deux frontières.
