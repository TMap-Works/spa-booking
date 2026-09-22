# ADR 0017 — Internationalisation du front : `next-intl`, catalogues par convention, langue hors de l'URL

- **Statut** : Accepté
- **Date** : 2026-09-19
- **Décideurs** : équipe produit, PO
- **Contexte CDC** : §1.4 (périmètre MVP), §2.2 (parcours client), §5.1 (données
  personnelles) · épique #843, ticket #845

## Contexte

Le front n'avait aucune notion de langue : `<html lang="fr">` en dur dans
`app/layout.tsx`, `LOCALE = 'fr-FR'` dans `lib/format.ts`, et les libellés écrits
au fil du JSX. Le PO a tranché le 2026-09-19 : **l'anglais est la langue par
défaut du système**, la clientèle visée étant nord-américaine ; le français reste
servi d'emblée à qui l'annonce.

Quatre contraintes cadrent la décision, et aucune n'est négociable.

1. **L'épique #843 compte onze tickets d'écrans** qui ajoutent chacun leurs
   libellés, menés de front par `/milestone`. Tout point d'écriture central —
   liste d'imports, déclaration de types, liste de globs de lint — les mettrait
   en conflit de fusion les uns avec les autres, et le run les sérialiserait.
2. **L'URL d'un salon est ce qu'il imprime.** Elle figure sur sa vitrine, dans
   ses e-mails de confirmation et dans ses messages ; `/{slug}/reservation` est
   l'adresse du tunnel, et c'est aussi ce qui est indexé.
3. **App Router et Server Components.** Le produit rend ses pages sur le
   serveur ; la langue doit être connue avant le premier octet, et `<html lang>`
   ne se pose que dans le layout racine.
4. **Les catalogues doivent être vérifiables par `tsc`** — une clé mal
   orthographiée ne doit pas se découvrir en production.

## Options envisagées

### Option A — `next-intl`, sans segment de langue dans l'URL

Bibliothèque pensée pour l'App Router : configuration de requête
(`getRequestConfig`), `useTranslations` dans les Server **et** Client Components,
typage des clés par `declare module 'next-intl'`. Elle sait router par préfixe
d'URL, et sait aussi ne pas le faire.

*Pour* : le rendu serveur est natif, le typage des clés est prévu par la
bibliothèque, le formatage ICU couvre les pluriels et les paramètres.
*Contre* : une dépendance de plus sur le chemin critique de la réservation, et un
greffon `next.config.mjs` qui s'ajoute au nôtre.

### Option B — `next-intl` avec segment de langue (`/fr/{slug}/reservation`)

Le mode par défaut de la bibliothèque, et celui de la plupart des sites
multilingues.

*Pour* : la langue est partageable et cachable — deux URL distinctes, deux
entrées de CDN, aucune négociation à l'exécution.
*Contre* : **chaque adresse du produit est doublée**. Le salon qui a imprimé
`/salon-des-lilas` sur sa devanture verrait son lien redirigé vers une langue
devinée ; le référencement dépendrait d'un choix d'affichage ; et les chemins
écrits en dur dans `compte/paths.ts`, `admin/paths.ts` et les cookies de session
— bornés à `/{slug}/compte` et `/{slug}/admin` — devraient tous intégrer un
segment de plus. C'est ce coût-là qui l'écarte, pas la technique.

### Option C — `react-i18next`

L'usage le plus répandu de l'écosystème React.

*Pour* : très documenté, écosystème d'outils fourni.
*Contre* : conçu pour le rendu client. En App Router, il demande soit un
fournisseur client à la racine — donc l'hydratation de tous les catalogues, et la
perte des Server Components là où les libellés sont lus —, soit une intégration
serveur écrite à la main que la bibliothèque ne garantit pas d'une version à
l'autre. Le typage des clés y est un greffon tiers.

### Option D — un module maison

Une table par langue, une fonction `t()`, rien à installer.

*Pour* : aucune dépendance, aucun greffon de build.
*Contre* : il faudrait réécrire ce que la bibliothèque donne — pluriels ICU,
paramètres, typage des clés, intégration serveur/client, formatage des nombres —
et le maintenir. Le MVP n'a pas de budget pour une bibliothèque d'i18n de plus,
il a besoin d'écrans traduits.

## Décision

**`next-intl`, sans segment de langue dans l'URL.** Le greffon
`createNextIntlPlugin('./i18n/request.ts')` est la seule ligne ajoutée à
`next.config.mjs` ; il ne met en place aucun routage.

### Les catalogues : un fichier par namespace et par langue

```
apps/web/messages/
  <namespace>.d.ts        quatre lignes — le namespace dans le type du catalogue
  fr/<namespace>.json
  en/<namespace>.json
```

Le **nom du fichier est le namespace**. `i18n/messages.ts` les découvre par
`readdirSync` : déposer `messages/fr/booking.json`, `messages/en/booking.json` et
`messages/booking.d.ts` suffit à rendre `useTranslations('booking')` utilisable
et typé.

Trois points d'écriture centraux auraient pu exister ; aucun n'existe.

| Ce qui aurait été central | Ce qui le remplace |
|---|---|
| une liste d'`import` de catalogues | `readdirSync` sur `messages/<langue>/` |
| une union de types des messages | fusion de déclarations — `SpaMessages.Catalog` est déclarée vide dans `i18n/catalog.d.ts`, chaque `messages/<namespace>.d.ts` y ajoute sa clé |
| un glob dans `eslint.config.mjs` | un fichier marqueur `.i18n-lint` déposé dans le répertoire concerné, que la configuration découvre |

L'augmentation de `next-intl` vit dans `i18n/catalog.d.ts` et **pas** dans
`i18n/messages.d.ts` : un `X.d.ts` posé à côté d'un `X.ts` est écarté du
programme par TypeScript, qui y voit la déclaration générée du second. La panne
est muette — `Locale` retombe à `string`, `Messages` à `Record<string, any>`, et
le critère « une clé mal orthographiée fait échouer `tsc` » ne tient plus sans
qu'aucun outil ne le dise. `tests/types/catalog-typing.test-d.ts` en fait une
erreur de compilation par `@ts-expect-error`.

`readdirSync` plutôt qu'un `import` dynamique de bundler : trois lecteurs doivent
voir les mêmes catalogues — le serveur Next (webpack), `tsc`, et les suites de
tests (Vitest, `node --test`). `require.context` n'existe que dans le premier,
`import.meta.glob` que dans le troisième. Le prix est un réglage unique et
définitif, `outputFileTracingIncludes: { '/**/*': ['./messages/**/*.json'] }`,
sans quoi la sortie autonome rend des clés brutes.

### La règle de résolution de la langue

Côté serveur, à chaque requête, dans cet ordre — `i18n/resolve.ts` :

1. **le choix explicite** — cookie `spa_locale`, posé par le sélecteur de langue,
   un an, `httpOnly`, `path=/` ;
2. **le compte** — cookie `spa_account_locale`, recopié de `users.locale` (#844)
   à l'ouverture de session ;
3. **`Accept-Language`** — négocié : la variante régionale compte pour sa langue
   (`fr-CA` → `fr`), `q=0` est un refus (RFC 9110 §12.5.4), `*` n'est pas une
   langue ;
4. **l'établissement** — `Tenant.defaultLocale` (#844), lu par
   `GET /public/{slug}`, et seulement si les trois signaux précédents sont muets ;
5. **`en`** — `DEFAULT_LOCALE`.

Une valeur non reconnue à une étape ne bloque pas la suivante : elle n'existe
simplement pas. Aucune panne de l'étape 4 — API éteinte, slug inconnu, réponse
hors contrat — n'empêche la page de s'afficher.

Le middleware ne fait qu'une chose pour cela : recopier le premier segment du
chemin dans l'en-tête de requête `x-spa-tenant-slug`, que le layout racine ne
peut pas lire autrement. Il ne redirige, ne réécrit et n'autorise rien.

### La langue du formatage n'est pas celle des mots

`lib/format.ts` reçoit un `DisplayLocale` — une langue et le pays de
l'établissement (`Tenant.countryCode`). La région vient donc du salon : un salon
montréalais écrit ses dates comme le Québec. Repli figé quand le pays est absent :
`en` → `en-US`, `fr` → `fr-FR`. Le **fuseau** reste celui de l'établissement,
toujours passé explicitement ; les montants restent des entiers avec un code
devise.

### Les messages d'erreur vivent auprès des codes

`packages/shared/src/errors/error-messages.ts` donne à chaque `ErrorCode` sa
phrase dans les deux langues, sous l'annotation `Record<ErrorCode, string>` : un
code ajouté sans message ne compile pas. `zod-messages.ts` traduit les refus de
validation par une carte d'erreurs zod passée **par appel** — jamais par
`z.setErrorMap`, qui est un état de module : le serveur rend des pages dans deux
langues en même temps.

**Le front continue de réagir au `code`, jamais au `message`.**

## Conséquences

**Ce que cela facilite.** Un ticket d'écran ajoute trois fichiers dans son propre
répertoire et ne touche rien d'autre : les onze tickets de l'épique #843 sont
menés de front. L'URL d'un salon ne change pas, et aucun lien imprimé ne casse.
`tsc` refuse une clé absente.

**Ce que cela coûte.**

- Le layout racine lit un cookie et un en-tête : il est **dynamique**, et toutes
  les pages avec lui. Le parcours l'était déjà — les trois gabarits de salon
  déclarent `force-dynamic` —, et une langue qui dépend de la requête ne peut de
  toute façon pas être figée à la construction.
- Une même URL sert deux langues : elle n'est donc pas cachable en l'état par un
  CDN partagé sans `Vary: Cookie, Accept-Language`. À poser le jour où CloudFront
  servira les pages (ADR 0009) ; sans cela, deux visiteurs se verraient servir la
  langue l'un de l'autre.
- `NextIntlClientProvider` est posé au layout racine : les catalogues des deux
  langues ne voyagent pas, mais celui de la langue résolue est dans la charge
  utile RSC — quelques kilo-octets.
- Les suites unitaires existantes vérifient des libellés français. Elles sont
  fixées sur `fr` par un fichier d'amorce (`tests/support/next-intl.ts`) plutôt
  que réécrites ; les variantes `en` viennent avec les tickets d'écrans.
- La transition n'est pas instantanée : `lib/format.ts`,
  `lib/appointment-status.ts`, `navigation.ts` et `public-exits.tsx` gardent un
  paramètre de langue **facultatif**, par défaut `fr`, le temps que les onze
  tickets d'écrans branchent leurs appelants. Le défaut tombe avec le dernier, et
  `tsc` nommera alors ce qui reste.

**Ce que cela ferme.** Pas de troisième langue sans repasser par `LOCALES` du
contrat partagé — c'est voulu : le MVP en sert deux. Pas de langue dans l'URL, ni
de `hreflang` par variante : si le référencement multilingue devient un besoin,
c'est cet ADR qu'il faudra remplacer, pas un réglage à ajouter.
