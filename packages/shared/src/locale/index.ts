// Baril de la famille `locale`. Réexports **nommés un par un**, comme les
// quatre autres familles du contrat : un symbole ajouté à `locale.ts` sans sa
// ligne ici ne remonte pas jusqu'à `@spa/shared`, et c'est
// `src/__tests__/contract-surface.spec.ts` qui garde la propriété.
export { DEFAULT_LOCALE, LOCALES, isLocale, localeSchema, submittedLocaleSchema } from './locale';
export type { Locale } from './locale';
