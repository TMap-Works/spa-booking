import { DEFAULT_LOCALE, type Locale } from '@spa/shared';

/**
 * La **locale de mise en forme** de la pièce imprimée — langue de la demande,
 * région du pays de l'établissement (#1325).
 *
 * ## La règle, en une phrase
 *
 * > Ce qui décide de l'écriture d'une date, d'une heure, d'un nombre et d'un
 * > montant est l'étiquette BCP 47 `{langue}-{pays de l'établissement}`, où la
 * > langue est celle de la demande et le pays celui de l'adresse du salon
 * > (`tenants.country_code`, ISO 3166-1 alpha-2). Quand le salon n'a pas publié
 * > de pays, la région est celle du marché de la langue — `fr` → `FR`,
 * > `en` → `US`. Rien d'autre n'intervient : ni le fuseau, ni la devise, ni la
 * > région du serveur.
 *
 * ## Pourquoi cette fonction existe en double
 *
 * Le premier critère de #1325 demande **une seule** fonction de locale de mise
 * en forme, « utilisée par le front ET le PDF de l'API ». La place d'un contrat
 * partagé front/back est `packages/shared` (`CLAUDE.md`) — mais ce répertoire est
 * hors de l'empreinte de ce ticket, et y écrire aurait exposé deux autres agents
 * de la même vague à un conflit sur un module que ni l'un ni l'autre ne
 * recette.
 *
 * La convergence est donc livrée autrement, et elle est **vérifiable** :
 *
 * - une seule fonction **par côté** — celle-ci, et `formattingLocale` de
 *   `apps/web/lib/format.ts` ;
 * - la **même règle**, écrite ci-dessus et reprise mot pour mot dans l'en-tête de
 *   `apps/web/lib/format.ts` : même source de la région, même table de repli,
 *   même refus d'une valeur mal formée ;
 * - des **tests miroir** qui épinglent les mêmes chaînes littérales des deux
 *   côtés, pour un salon parisien et pour un salon new-yorkais, en français et en
 *   anglais : `receipt-pdf.format.spec.ts` ici, `format.test.ts` et
 *   `receipt-ticket.test.ts` là-bas. Une divergence d'un côté fait rougir les
 *   deux suites, ce qu'une simple consigne de relecture n'aurait pas donné.
 *
 * La mutualisation dans `packages/shared` reste la forme voulue, et fait l'objet
 * d'une issue de suivi : le jour où elle arrive, les deux implémentations
 * disparaissent au profit de l'unique, sans qu'aucune chaîne attendue ne change.
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

/** Ce qui décide de la mise en forme : une langue, et le pays de l'émetteur. */
export interface ReceiptDisplay {
  readonly locale: Locale;
  /** `tenants.country_code` — ISO 3166-1 alpha-2, ou rien. */
  readonly countryCode?: string | null | undefined;
}

/**
 * Les régions de repli, quand l'établissement n'a pas publié son pays.
 *
 * Identiques à celles du front (`FALLBACK_REGION` de `apps/web/lib/format.ts`) :
 * ce sont les régions des deux marchés du produit, et deviner autre chose — la
 * région de l'ICU embarquée, celle du conteneur ECS — ferait dépendre une pièce
 * comptable d'une valeur qui n'est écrite nulle part.
 */
const FALLBACK_REGION: Readonly<Record<Locale, string>> = { fr: 'FR', en: 'US' };

/**
 * L'étiquette BCP 47 complète à passer à `Intl` — « fr-FR », « en-US », « en-FR ».
 *
 * Une valeur de pays qui n'a pas la forme ISO 3166-1 alpha-2 est **ignorée**
 * plutôt que recopiée : `Intl` lève un `RangeError` sur une étiquette mal formée,
 * et une adresse mal saisie ferait alors échouer l'impression d'un ticket au
 * comptoir au lieu de le dater autrement. Même arbitrage, même formulation, que
 * `formattingLocale` du front.
 */
export function receiptFormattingLocale(
  locale: Locale = DEFAULT_LOCALE,
  countryCode?: string | null | undefined,
): string {
  const region =
    typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode)
      ? countryCode.toUpperCase()
      : FALLBACK_REGION[locale];

  return `${locale}-${region}`;
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

/**
 * Ce que la langue emploie pour séparer les décimales et les milliers d'un
 * nombre **ordinaire** — jumeau de `separatorsOf` dans `apps/web/lib/format.ts`.
 *
 * Le résultat est **retenu par étiquette**, comme là-bas : un rouleau porte une
 * ligne de montant par prestation, par taxe, par règlement et par avoir, et
 * chacune reconstruisait un `Intl.NumberFormat` pour relire deux caractères qui
 * ne dépendent que de l'étiquette.
 */
const SEPARATORS = new Map<string, { readonly decimal: string; readonly group: string }>();

function separatorsOf(intlTag: string): { readonly decimal: string; readonly group: string } {
  const retained = SEPARATORS.get(intlTag);

  if (retained !== undefined) {
    return retained;
  }

  const parts = new Intl.NumberFormat(intlTag).formatToParts(12345.6);
  const separators = {
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    group: parts.find((part) => part.type === 'group')?.value ?? '',
  };

  SEPARATORS.set(intlTag, separators);

  return separators;
}

/**
 * Un nombre écrit avec les séparateurs **du nombre ordinaire** de son étiquette,
 * et non avec ceux que CLDR réserve à la monnaie (#1325).
 *
 * ## Le fait
 *
 * ```
 * new Intl.NumberFormat('en-FR').format(1234.5)                            // 1 234,5
 * new Intl.NumberFormat('en-FR', { style: 'currency', currency: 'EUR' })
 *   .format(1234.5)                                                        // €1,234.50
 * ```
 *
 * CLDR déclare pour `en-FR` — comme pour `en-DE` — des symboles
 * `currencyDecimal` et `currencyGroup` distincts de ceux du nombre ordinaire :
 * l'anglais de France y écrit ses nombres à la française et sa monnaie à
 * l'anglaise. Ce n'est ni un défaut d'ICU ni une étiquette mal formée.
 *
 * ## Pourquoi la pièce refuse cette distinction
 *
 * Parce qu'un ticket porte les deux formes sur le même rouleau — un total en
 * monnaie, un taux de TVA en pourcentage — et parce que l'écran de caisse qui
 * vient de l'imprimer a tranché dans l'autre sens : `formatMoney` de
 * `apps/web/lib/format.ts` aligne déjà les séparateurs monétaires sur ceux du
 * nombre ordinaire. Laisser `Intl` décider deux fois ici rouvrirait, entre le
 * papier et l'écran, la divergence que #1325 ferme.
 *
 * Tout le reste est repris à CLDR part par part : le symbole étroit de la
 * devise, sa place, l'espace qui l'accompagne, le nombre de chiffres, le signe,
 * le groupement. Seules les parts `decimal` et `group` sont remplacées, et par
 * des valeurs qu'`Intl` a rendues — aucune table locale n'est écrite.
 */
export function withPlainSeparators(
  value: number,
  intlTag: string,
  options: Intl.NumberFormatOptions,
): string {
  const plain = separatorsOf(intlTag);

  return new Intl.NumberFormat(intlTag, options)
    .formatToParts(value)
    .map((part) => {
      if (part.type === 'decimal') {
        return plain.decimal;
      }

      return part.type === 'group' && plain.group !== '' ? plain.group : part.value;
    })
    .join('');
}
