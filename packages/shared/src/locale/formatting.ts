/**
 * La **locale de mise en forme** — l'unique règle qui décide de l'écriture d'une
 * date, d'une heure, d'un nombre et d'un montant (#1325, mutualisée par #1343).
 *
 * ## La règle, en une phrase
 *
 * > Ce qui décide de l'écriture est l'étiquette BCP 47
 * > `{langue}-{pays de l'établissement}`, où la langue est celle de la demande et
 * > le pays celui de l'adresse du salon (`tenants.country_code`, ISO 3166-1
 * > alpha-2). Quand le salon n'a pas publié de pays, la région est celle du
 * > marché de la langue — `fr` → `FR`, `en` → `US`. Rien d'autre n'intervient :
 * > ni le fuseau, ni la devise, ni la région du serveur, ni celle du navigateur.
 *
 * ## Pourquoi elle vit ici, et non deux fois
 *
 * Le premier critère de #1325 demandait **une seule** fonction de locale de mise
 * en forme, « utilisée par le front ET le PDF de l'API ». `packages/shared` était
 * hors de l'empreinte de ce ticket-là : la règle a donc été écrite deux fois —
 * `apps/web/lib/format.ts` et `receipt-pdf.locale.ts` —, tenues en phase par des
 * tests miroir qui épinglent les mêmes chaînes littérales des deux côtés.
 *
 * C'était une garantie de test, pas de compilateur, et c'est ce que #1343 ferme :
 * la règle est ici, les deux fichiers en sont désormais des **points d'emploi**.
 * Les tests miroir restent en place — ils ne comparent plus deux implémentations
 * mais deux points d'emploi, ce qui reste ce qui se casse : une surface qui
 * repasserait un `hourCycle` ou un séparateur par-dessus `Intl` les ferait
 * rougir.
 *
 * Sa place est la famille `locale` et non `common/` pour la raison énoncée dans
 * `locale.ts` : elle ne décrit aucune donnée métier, elle décrit la
 * **présentation** de toutes.
 *
 * ## Ce que la région décide, et ce qu'elle ne décide pas
 *
 * Elle décide de l'**écriture** : l'ordre des composantes d'une date, le cycle
 * horaire, les séparateurs d'un nombre, la place d'un symbole monétaire. Elle ne
 * décide ni du **fuseau** — celui de l'établissement, toujours passé
 * explicitement par l'appelant, et un instant mal fuseau-horairé est une faute de
 * sévérité haute (`CLAUDE.md`) —, ni de la **devise**, ni du nombre de décimales
 * qu'elle impose, ni des **mots**, qui restent ceux de la langue.
 *
 * ## Aucune table locale, sauf celle du repli
 *
 * Tout ce qui s'écrit ici est lu d'`Intl` : les séparateurs, le symbole, sa
 * place, le groupement. La seule valeur codée en dur est la région de repli, et
 * c'est délibéré — deviner autre chose (la région de l'ICU embarquée, celle du
 * conteneur ECS, celle du navigateur) ferait varier l'affichage d'une machine à
 * l'autre pour un même salon.
 */

import { DEFAULT_LOCALE, type Locale } from './locale';

/**
 * Les régions de repli, quand l'établissement n'a pas publié son pays.
 *
 * Ce sont les régions des deux marchés du produit, et ce repli est **documenté et
 * figé** — c'est le dixième critère d'acceptation de #845. Il n'est pas exporté :
 * la région ne se lit que par {@link formattingLocale}, faute de quoi une surface
 * pourrait composer son étiquette autrement, ce qui est exactement la divergence
 * que #1325 a fermée.
 */
const FALLBACK_REGION: Readonly<Record<Locale, string>> = { fr: 'FR', en: 'US' };

/**
 * L'étiquette BCP 47 complète à passer à `Intl` — « fr-FR », « en-US », « en-FR ».
 *
 * `countryCode` est celui de l'établissement (ISO 3166-1 alpha-2). Une valeur qui
 * n'a pas cette forme est **ignorée** plutôt que recopiée : `Intl` lève un
 * `RangeError` sur une étiquette mal formée, et une adresse mal saisie ferait
 * alors tomber l'écran entier ou l'impression d'un ticket au comptoir au lieu de
 * dater autrement.
 *
 * La langue a un défaut — {@link DEFAULT_LOCALE}, la langue par défaut du
 * produit — pour les appelants qui ne l'ont pas encore résolue ; il ne promet
 * aucune langue en particulier au-delà de cette décision-là.
 */
export function formattingLocale(
  locale: Locale = DEFAULT_LOCALE,
  countryCode?: string | null | undefined,
): string {
  const region =
    typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode)
      ? countryCode.toUpperCase()
      : FALLBACK_REGION[locale];

  return `${locale}-${region}`;
}

/** Ce qu'une étiquette emploie pour séparer les décimales et les milliers. */
export interface NumberSeparators {
  readonly decimal: string;
  readonly group: string;
}

/**
 * Le résultat de {@link separatorsOf}, **retenu par étiquette**.
 *
 * Depuis #1325 chaque montant affiché le demande : une liste de cent lignes, ou
 * un rouleau qui porte une ligne par prestation, par taxe, par règlement et par
 * avoir, construisait autant d'`Intl.NumberFormat` pour relire deux caractères
 * qui ne dépendent que de l'étiquette.
 */
const SEPARATORS = new Map<string, NumberSeparators>();

/**
 * Ce que l'étiquette emploie pour séparer les décimales et les milliers d'un
 * nombre **ordinaire** — « , » et l'espace fine insécable en `fr-FR`, « . » et
 * « , » en `en-US`.
 *
 * Lu d'`Intl` plutôt que codé en dur : une table locale finirait par diverger de
 * CLDR. Et la région y change bel et bien quelque chose, contrairement à ce
 * qu'on pourrait supposer des deux seules langues du produit : `fr-FR` et `fr-CA`
 * groupent tous deux à l'espace fine, mais `en-CH` groupe à l'apostrophe
 * typographique (« 1’200.00 ») et `en-ZA` prend la virgule décimale du français.
 *
 * Le groupe est rendu tel quel, espace comprise : c'est la forme textuelle — « , »
 * ou « . » — qui décide de la lecture groupée d'une saisie, et l'analyse se
 * débarrasse des blancs avec les autres.
 */
export function separatorsOf(intlTag: string): NumberSeparators {
  const retained = SEPARATORS.get(intlTag);

  if (retained !== undefined) {
    return retained;
  }

  const parts = new Intl.NumberFormat(intlTag).formatToParts(12345.6);
  const separators: NumberSeparators = {
    // Les replis ne devraient jamais servir — toute locale a un séparateur
    // décimal —, mais `formatToParts` les déclare optionnels et un `undefined`
    // glissé dans une expression régulière refuserait tous les montants.
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
 * ## Le fait, vérifiable en une ligne de Node
 *
 * ```
 * new Intl.NumberFormat('en-FR').format(1234.5)                            // 1 234,5
 * new Intl.NumberFormat('en-FR', { style: 'currency', currency: 'EUR' })
 *   .format(1234.5)                                                        // €1,234.50
 * ```
 *
 * Ce n'est ni un défaut d'ICU ni une étiquette mal formée : CLDR déclare pour
 * `en-FR` — comme pour `en-DE` — des symboles `currencyDecimal` et `currencyGroup`
 * **distincts** de ceux du nombre ordinaire. L'anglais de France y écrit ses
 * nombres à la française et sa monnaie à l'anglaise.
 *
 * ## Pourquoi le produit refuse cette distinction
 *
 * Parce qu'elle place les deux formes **côte à côte sur le même support**. Le
 * tableau de bord du back-office écrivait « 50,0 % » et « 1 234 » à trois
 * centimètres de « €140.00 », et un rouleau porte un total en monnaie sous un
 * taux de TVA en pourcentage : c'est le deuxième constat de #1325, et son
 * deuxième critère — *« sur un même écran, les dates, heures, nombres,
 * pourcentages et montants suivent la même convention »* — ne peut pas être tenu
 * en laissant `Intl` décider deux fois.
 *
 * Et le support n'était pas seul en cause : un champ de saisie pré-rempli avec le
 * séparateur **ordinaire** refusait le total qu'on venait de recopier de l'écran.
 *
 * ## Ce qui est repris à CLDR, et ce qui ne l'est pas
 *
 * Tout, sauf les deux séparateurs : le symbole de la devise, sa place, l'espace
 * qui l'accompagne, le nombre de chiffres, le signe, la notation compacte, le
 * groupement — tout cela reste rendu part par part. Seules les parts `decimal` et
 * `group` sont remplacées par celles du nombre ordinaire de la **même** étiquette,
 * et par des valeurs qu'`Intl` a rendues (voir {@link separatorsOf}) : aucune
 * table locale n'est écrite, et c'est la même source qui décide des deux côtés.
 *
 * Le groupe n'est remplacé que s'il existe : une langue sans séparateur de
 * milliers ne doit pas voir disparaître celui de sa monnaie.
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
