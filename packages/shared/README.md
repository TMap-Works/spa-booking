# packages/shared — Contrats partagés

**Source de vérité du contrat d'API.** Le front n'y redéclare jamais un type que
l'API expose déjà ; l'API n'y duplique jamais un schéma de validation.

```
src/
  common/     primitives transverses — montants, instants UTC, identifiants, pagination
  constants/  statuts de RDV, rôles, canaux de notification, bornes de champs
  errors/     codes d'erreur stables et enveloppe de réponse en échec
  schemas/    entités et DTO, en schémas Zod dont les types sont inférés
  index.ts    baril racine — tout ce qu'expose `@spa/shared`
```

Un changement de contrat commence ici. Les erreurs de compilation qui en
découlent dans `apps/*` sont la liste de travail.

## Pourquoi Zod plutôt que des `interface`

Une `interface` TypeScript n'existe pas à l'exécution : elle ne dit rien de ce
qui arrive réellement dans un corps de requête. Un schéma Zod, lui, sert deux
usages à partir d'une seule déclaration :

- **côté back, pour la sécurité** — `schema.parse(body)` est ce qui empêche un
  champ non prévu d'entrer. Tous les schémas d'entrée sont `.strict()` : un
  `tenantId` ou un `role` glissé dans un corps sort en 422 nommant le champ, au
  lieu d'être ignoré en silence ;
- **côté front, pour le confort** — le même schéma valide un formulaire avant
  l'aller-retour réseau, et `z.infer` donne le type sans le réécrire.

## Ce que le contrat refuse par construction

| Invariant | Où il est tenu |
|---|---|
| Argent en entiers, devise explicite, aucune conversion implicite | `common/money.ts` |
| Instants en UTC, décalage horaire refusé en entrée | `common/time.ts` |
| `tenantId` ni en entrée ni en sortie, sauf sur l'établissement lui-même | `schemas/tenant.ts` et le `.strict()` des DTO |
| Aucun `passwordHash` dans un schéma de sortie | `schemas/identity.ts` |
| Aucune donnée de carte dans un schéma de paiement | `schemas/payment.ts` |
| Le front réagit sur `code`, jamais sur `message` | `errors/error-codes.ts` |

## Utilisation

```ts
import { createAppointmentRequestSchema, ERROR_CODES, errorCodeOf } from '@spa/shared';

const body = createAppointmentRequestSchema.parse(input);

if (errorCodeOf(await response.json()) === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE) {
  // réafficher les créneaux
}
```

Le paquet est lié par les workspaces npm, et déclaré en dépendance des deux
applications (`"@spa/shared": "*"`). `src/__tests__/contract-surface.spec.ts`
vérifie que la résolution fonctionne depuis chacune d'elles.

## Le consommer depuis un `tsconfig` qui compile avec `rootDir: src`

C'est le cas d'`apps/api`. Le pointer par le `paths` de `tsconfig.base.json`
(`./packages/shared/src/index.ts`, un chemin **direct**) fait échouer chaque
fichier du contrat en TS6059 — « file is not under rootDir » : `tsc` tente
d'absorber nos sources dans le programme de l'application.

**Ce qui marche** — la voie retenue par #462, et qu'`apps/api/tsconfig.json`
documente en détail : pointer le paquet **à travers le lien de workspace npm**.

```jsonc
// apps/api/tsconfig.json
"paths": {
  "@spa/shared": ["../../node_modules/@spa/shared/src/index.ts"],
  "@spa/shared/*": ["../../node_modules/@spa/shared/src/*"]
}
```

Cela change la *nature* de la résolution et pas seulement son chemin : ce que
`tsc` trouve sous `node_modules` est marqué comme bibliothèque externe, donc ni
vérifié contre `rootDir` ni écrit dans le `dist` de l'application. Le pointage
vise les **sources**, ce qui affranchit la compilation de tout `dist` préalable
du contrat.

**Ce qui ne marche pas, et qui a été mesuré** — la référence de projet :

```jsonc
{ "references": [{ "path": "../../packages/shared/tsconfig.build.json" }] }
```

Elle exige que `packages/shared` soit **compilé avant** l'application, sinon
TS6305. Or `tsc -p` ne construit pas ses références (seul `tsc -b` le fait), et
`npm run <cible> --workspaces` s'exécute dans l'ordre du glob — `apps/api`,
`apps/web`, `packages/shared` — et non dans celui des dépendances : `@spa/api`
compile toujours en premier. Même remarque pour la consommation par le `dist`
(`paths: {}`, résolution par `types: ./dist/index.d.ts`), qui bute sur TS2307.
Le `composite: true` de `tsconfig.build.json` reste utile — c'est lui qui produit
les `.d.ts` — mais ce n'est pas par une `references` qu'on consomme ce paquet.

## Ce que l'exécution exige en plus de la compilation

Compiler contre les sources ne dispense pas d'un `dist` **à l'exécution** : un
import de *valeur* — et non de type — émet un `require('@spa/shared')` que `node`
résout par le `main` du paquet, `./dist/index.js`. Tout ce qui exécute du code
d'une application doit donc voir ce `dist` :

| Exécutant | Ce qui le sert |
|---|---|
| `npm run verify` | `npm run build` compile les deux workspaces avant les tests |
| Jest (`apps/api`) | `moduleNameMapper` renvoie `@spa/shared` sur les sources — aucune compilation préalable |
| `start:dev` (`apps/api`) | `prestart:dev` compile le paquet — `ts-node/register` n'applique **pas** les `paths` du `tsconfig`, la résolution passe donc par le lien de workspace et exige le `dist` |
| Image `apps/api` | l'étape `build` du Dockerfile compile le paquet, `runtime` copie son `dist` |

`dist/` n'est pas versionné et aucun `prepare` ne le construit à l'installation :
après un clone neuf, `npm ci` **seul** ne le produit pas. Tout ce qui exécute du
code hors des trois voies ci-dessus doit donc lancer
`npm run build --workspace @spa/shared` au préalable.

La garde « L'image API démarre » de `.github/workflows/ci.yml` lance réellement
l'image à chaque PR : c'est elle, et non la construction seule, qui rend visible
un `MODULE_NOT_FOUND` avant le déploiement (#463).

**Le baril racine est la seule porte d'entrée.** Le champ `exports` du paquet
n'expose que `.` et `./package.json` : un import profond
(`@spa/shared/errors/error-codes`) compile — les `paths` déclarent `@spa/shared/*` —
mais échoue à l'exécution en `ERR_PACKAGE_PATH_NOT_EXPORTED`. Une règle ESLint
d'`apps/api` le refuse au lint.

## Faire évoluer le contrat

1. Modifier ou ajouter le schéma dans `src/`.
2. L'exporter depuis le baril de sa famille (`common/`, `constants/`, `errors/`,
   `schemas/`) — les réexports y sont nommés un par un, délibérément.
3. Ajouter le test qui garde l'invariant, dans `src/__tests__/`.
4. `npm run verify` à la racine : les erreurs de compilation dans `apps/*` sont
   la liste de travail.

**Retirer ou renommer un code d'erreur, un statut ou un rôle casse un front
déployé.** Ces énumérations sont des contrats, pas des détails d'implémentation :
elles s'étendent, elles ne se réécrivent pas.
