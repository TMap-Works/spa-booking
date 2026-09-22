import type { Locale as IntlLocale } from 'next-intl';

/**
 * La garde du typage des clés de messages — #845, troisième critère
 * d'acceptation : *« une clé absente ou mal orthographiée fait échouer
 * `tsc` »*.
 *
 * ## Pourquoi un test de types, et pas un test unitaire
 *
 * Parce que la panne qu'il surveille est **muette**. L'augmentation de
 * `next-intl` vit dans `i18n/catalog.d.ts` ; si ce fichier sort du programme du
 * compilateur — il a suffi qu'il s'appelle `messages.d.ts` à côté d'un
 * `messages.ts` pour que TypeScript l'écarte comme déclaration générée —, alors
 * `Locale` retombe à `string`, `Messages` à `Record<string, any>`, et **tout
 * passe** : une clé inventée, un namespace qui n'existe pas. Aucune erreur,
 * aucun avertissement. Le critère d'acceptation ne tient plus et rien ne le
 * dit.
 *
 * Un test d'exécution ne verrait rien : à l'exécution, `next-intl` rend la clé
 * brute et le rendu « marche ». Seul le compilateur sait.
 *
 * ## Comment il échoue
 *
 * `@ts-expect-error` est une assertion à double sens : si l'expression cesse
 * d'être erronée, TypeScript signale `TS2578: Unused '@ts-expect-error'
 * directive`. Les trois directives ci-dessous deviennent donc trois erreurs de
 * compilation le jour où le typage redevient inerte — et `npm run typecheck`
 * s'arrête dessus.
 *
 * Ce fichier n'est exécuté par aucun lanceur de tests : l'extension
 * `.test-d.ts` le dit, et c'est voulu. Son seul lecteur est `tsc`, via le
 * `include` de `tsconfig.json`.
 */

// 1. La langue est celle du contrat partagé, pas `string`.
const _french: IntlLocale = 'fr';
const _english: IntlLocale = 'en';
// @ts-expect-error — `zz` n'est pas une langue du contrat (LOCALES).
const _unknownLocale: IntlLocale = 'zz';

// 2. Le catalogue connaît ses namespaces.
const _knownNamespace: keyof SpaMessages.Catalog = 'ui';
// @ts-expect-error — aucun `messages/<langue>/namespace-inexistant.json`.
const _unknownNamespace: keyof SpaMessages.Catalog = 'namespace-inexistant';

// 3. Le catalogue connaît les clés d'un namespace.
const _knownKey: keyof SpaMessages.Catalog['ui'] = 'sheet';
// @ts-expect-error — clé absente de `messages/en/ui.json`.
const _unknownKey: keyof SpaMessages.Catalog['ui'] = 'cle-qui-nexiste-pas';

export type Guarded = [
  typeof _french,
  typeof _english,
  typeof _unknownLocale,
  typeof _knownNamespace,
  typeof _unknownNamespace,
  typeof _knownKey,
  typeof _unknownKey,
];
