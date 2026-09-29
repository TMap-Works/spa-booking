import { formattingLocale, withPlainSeparators, type Locale } from '@spa/shared';

/**
 * La **locale de mise en forme** de la pièce imprimée — langue de la demande,
 * région du pays de l'établissement (#1325).
 *
 * ## La règle, et où elle vit
 *
 * > Ce qui décide de l'écriture d'une date, d'une heure, d'un nombre et d'un
 * > montant est l'étiquette BCP 47 `{langue}-{pays de l'établissement}`, où la
 * > langue est celle de la demande et le pays celui de l'adresse du salon
 * > (`tenants.country_code`, ISO 3166-1 alpha-2). Quand le salon n'a pas publié
 * > de pays, la région est celle du marché de la langue — `fr` → `FR`,
 * > `en` → `US`. Rien d'autre n'intervient : ni le fuseau, ni la devise, ni la
 * > région du serveur.
 *
 * Elle est écrite une seule fois, dans `@spa/shared` (`locale/formatting.ts`), et
 * c'est #1343 qui l'y a portée. Elle a existé en double — ici et dans
 * `apps/web/lib/format.ts` — le temps de #1325, dont l'empreinte excluait
 * `packages/shared` : deux implémentations identiques, tenues en phase par des
 * tests miroir. C'était une garantie de test, pas de compilateur.
 *
 * Ce fichier en est désormais le **point d'emploi** du PDF : il réexporte
 * {@link formattingLocale} et {@link withPlainSeparators} sous leurs noms de
 * contrat — les gabarits et les formateurs de la pièce n'ont ainsi qu'un seul
 * module à viser pour tout ce qui touche à la locale — et y ajoute ce qui est
 * propre à une pièce comptable : {@link ReceiptDisplay} et {@link receiptDisplay},
 * qui disent **d'où** le pays est lu.
 *
 * ## Ce que la région décide, et ce qu'elle ne décide pas
 *
 * Elle décide de l'**écriture** : l'ordre des composantes d'une date, le cycle
 * horaire, les séparateurs d'un nombre, la place d'un symbole monétaire. Elle ne
 * décide ni du **fuseau** — celui de l'établissement, toujours passé
 * explicitement, et une pièce mal fuseau-horairée est une faute de sévérité
 * haute (`CLAUDE.md`) —, ni de la **devise**, ni du nombre de décimales qu'elle
 * impose, ni des **mots**, qui restent ceux de la langue
 * (`receipt-pdf.vocabulary.ts`).
 */

export { formattingLocale, withPlainSeparators };

/** Ce qui décide de la mise en forme : une langue, et le pays de l'émetteur. */
export interface ReceiptDisplay {
  readonly locale: Locale;
  /** `tenants.country_code` — ISO 3166-1 alpha-2, ou rien. */
  readonly countryCode?: string | null | undefined;
}

/**
 * Le contexte d'affichage d'une pièce : la langue demandée, et le pays de son
 * **émetteur**.
 *
 * Le pays est lu sur l'émetteur et nulle part ailleurs. C'est la même valeur que
 * la pièce imprime déjà dans son adresse (`ReceiptIssuer.countryCode`, #1334) :
 * un ticket ne peut donc pas porter l'adresse d'un pays et les dates d'un autre.
 * Et rien ne vient de la requête — ni un en-tête, ni un paramètre : une pièce
 * comptable ne se fait pas dater par son appelant.
 */
export function receiptDisplay(
  locale: Locale,
  issuer: { readonly countryCode: string | null },
): ReceiptDisplay {
  return { locale, countryCode: issuer.countryCode };
}
