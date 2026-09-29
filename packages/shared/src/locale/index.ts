// Baril de la famille `locale`. Réexports **nommés un par un**, comme les
// quatre autres familles du contrat : un symbole ajouté à `locale.ts` sans sa
// ligne ici ne remonte pas jusqu'à `@spa/shared`, et c'est
// `src/__tests__/contract-surface.spec.ts` qui garde la propriété.
export { DEFAULT_LOCALE, LOCALES, isLocale, localeSchema, submittedLocaleSchema } from './locale';
export type { Locale } from './locale';
// La règle de mise en forme (#1343) : l'étiquette BCP 47 de l'écriture, et
// l'alignement des séparateurs monétaires sur ceux du nombre ordinaire. Elle
// **doit** traverser le baril : `apps/web/lib/format.ts` et le PDF du reçu n'ont
// que `@spa/shared` pour l'atteindre, et sans lui ils la réécriraient chacun de
// son côté — ce qui est exactement le doublon que ce ticket ferme.
export { formattingLocale, separatorsOf, withPlainSeparators } from './formatting';
export type { NumberSeparators } from './formatting';
