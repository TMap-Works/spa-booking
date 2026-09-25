import type { Locale } from '@spa/shared';

import type { Money } from '../payments.types';
import type { ReceiptSettlement } from '../receipt.types';
import { receiptVocabulary } from './receipt-pdf.vocabulary';

/**
 * La mise en forme de ce qui s'imprime — #819, cinquième et septième critères ;
 * #1230 pour la langue.
 *
 * Tout est **pur** : des entiers et des `Date` entrent, des chaînes sortent.
 * Aucune de ces fonctions ne connaît PDFKit, ce qui est la raison pour laquelle
 * elles sont ici et non dans les gabarits — la justesse d'un montant sur une
 * pièce comptable se prouve par un test unitaire, pas en relisant un PDF.
 *
 * ## Le fuseau n'a pas de défaut
 *
 * Chaque fonction de date prend son `timeZone` en argument et n'en invente
 * aucun. Le fuseau du serveur est celui d'ECS — UTC —, et dater une pièce de
 * caisse en UTC la ferait tomber la veille pour un salon de Tananarive dès
 * 21 h 00 locales. C'est la faute de sévérité haute que CLAUDE.md nomme.
 *
 * ## La langue n'en a pas davantage — #1230
 *
 * Chaque fonction prend sa `Locale` en argument. `LOCALE = 'fr-FR'` était figé
 * ici : un salon dont la session est en anglais recevait une pièce entièrement
 * française, alors que le produit sert l'anglais par défaut depuis #844. La
 * langue vient donc de l'appelant — le paramètre `?locale=` de la route, à
 * défaut `tenants.default_locale` —, et jamais du fuseau ni de la devise, qui
 * répondent à deux autres questions (`receipt-pdf.vocabulary.ts`).
 *
 * **Ce que la langue ne change pas** : les montants restent des entiers en plus
 * petite unité monétaire, accompagnés de leur code devise, et c'est la devise —
 * pas la langue — qui décide du nombre de décimales.
 */

/**
 * L'espace fine insécable — U+202F — que `Intl` glisse entre les milliers en
 * `fr-FR`, et que **Roboto ne porte pas**.
 *
 * Sans cette substitution, « 6 500 Ar » s'imprime avec un rectangle vide à la
 * place de la séparation des milliers : fontkit ne trouve pas de glyphe et tombe
 * sur `.notdef`. La panne est invisible en test de chaîne — la chaîne, elle, est
 * correcte — et ne se voit que sur le papier, c'est-à-dire chez la cliente.
 *
 * U+00A0, l'espace insécable ordinaire, est dans la police et occupe la même
 * fonction typographique. C'est donc une substitution de rendu, jamais une
 * correction du formatage : `Intl` reste seul juge de *où* va une séparation.
 */
const NARROW_NO_BREAK_SPACE = '\u202F';
const NO_BREAK_SPACE = '\u00A0';

/** Ce qu'une police embarquée sait rendre — voir la constante ci-dessus. */
export function printable(text: string): string {
  return text.replaceAll(NARROW_NO_BREAK_SPACE, NO_BREAK_SPACE);
}

/**
 * Un montant, tel que la pièce l'imprime — cinquième critère.
 *
 * Deux garanties, et elles viennent toutes deux d'`Intl` :
 *
 * - **le nombre de décimales est celui de la devise**, et non un `/100` en dur.
 *   L'ariary malgache n'a pas de sous-unité : `650000` MGA vaut six cent
 *   cinquante mille ariary, pas six mille cinq cents ;
 * - **le symbole est le symbole étroit** — `€` et `Ar`, ceux que le deuxième
 *   critère nomme —, là où le symbole par défaut rendrait `MGA`.
 *
 * L'entier ne devient un flottant qu'**à l'intérieur** de l'appel au formateur,
 * sur une valeur déjà destinée à être écrite : aucun montant ne circule en
 * flottant dans le domaine, et aucun total n'est jamais calculé ici
 * (payments-stripe §5).
 */
export function formatMoney(money: Money, locale: Locale): string {
  const formatter = new Intl.NumberFormat(receiptVocabulary(locale).intl, {
    style: 'currency',
    currency: money.currency,
    currencyDisplay: 'narrowSymbol',
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return printable(formatter.format(money.amountMinor / 10 ** digits));
}

/**
 * Un taux en points de base, en pourcentage — « 2000 » donne « 20 % ».
 *
 * La division par 100 est exacte ici et le restera : un taux est un ratio, pas
 * un montant, et `maximumFractionDigits: 2` couvre les taux au centième de point
 * sans imprimer « 20,00 % » là où « 20 % » suffit.
 */
export function formatTaxRate(rateBps: number, locale: Locale): string {
  return printable(
    new Intl.NumberFormat(receiptVocabulary(locale).intl, {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(rateBps / 10_000),
  );
}

/**
 * La date seule, dans le fuseau du salon et l'ordre de la langue — « 17/09/2026 »
 * en français, « 09/17/2026 » en anglais.
 *
 * Les deux formes datent **le même jour** : c'est le fuseau, et lui seul, qui
 * décide duquel. L'ordre des composantes est une convention d'écriture, au même
 * titre que le séparateur des milliers d'un montant.
 */
export function formatDate(instant: Date, timeZone: string, locale: Locale): string {
  return printable(
    new Intl.DateTimeFormat(receiptVocabulary(locale).intl, {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(instant),
  );
}

/**
 * La date et l'heure, dans le fuseau du salon — « 17/09/2026 à 08:30 »,
 * « 09/17/2026 at 8:30 AM ».
 *
 * Le cycle horaire suit la langue (`ReceiptVocabulary.hourCycle`) : 24 heures en
 * français, 12 heures en anglais, comme l'un et l'autre s'écrivent. Le `printable`
 * n'est pas décoratif sur l'heure anglaise non plus — certaines versions d'ICU
 * glissent une espace fine insécable avant « AM », que Roboto ne porte pas.
 */
export function formatDateTime(instant: Date, timeZone: string, locale: Locale): string {
  const words = receiptVocabulary(locale);
  const time = new Intl.DateTimeFormat(words.intl, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: words.hourCycle,
  }).format(instant);

  return `${formatDate(instant, timeZone, locale)} ${words.at} ${printable(time)}`;
}

/**
 * Le moyen de règlement, en toutes lettres — **septième critère**.
 *
 * ## Ce qui n'y est pas, et ne peut pas y être
 *
 * Ni PAN, ni quatre derniers chiffres, ni marque de carte, ni date
 * d'expiration. Ce n'est pas une omission de mise en forme : `ReceiptSettlement`
 * ne porte aucun de ces champs, `receipt.repository.ts` n'en lit aucun, et il
 * n'y a donc rien ici à filtrer. C'est la seule forme de garantie qui tienne —
 * un masquage se contourne, une donnée absente non (payments-stripe §1).
 *
 * ## Le libellé se décide sur le **canal**, pas sur le moyen — #1027
 *
 * `method` ne dit que « carte » ; il ne dit pas par quel tuyau elle est passée.
 * La fonction libellait pourtant toute carte « Carte bancaire (TPE) », canal
 * compris, si bien qu'un règlement Stripe **en ligne** s'imprimait comme un
 * passage au terminal — et le rapprochement allait chercher sur le relevé du
 * TPE une ligne qui n'y est pas.
 *
 * Ce n'était pas une régression de #834 : le comportement date de #819, quand
 * le canal n'existait pas. Et la `terminalReference` que #834 a ajoutée ne
 * suffisait pas à le lever — elle est facultative, et un passage au terminal
 * dont le caissier n'a pas relevé la référence restait indiscernable d'une
 * carte en ligne.
 *
 * | Canal | Ce qui s'imprime |
 * |---|---|
 * | `TERMINAL` | « Carte bancaire (TPE) », suivie de la référence si elle est là |
 * | `STRIPE` | « Carte bancaire (en ligne) » |
 * | `null` | « Carte bancaire (en ligne) » — une carte antérieure à #834, donc une intention du tunnel : le TPE n'existait pas |
 *
 * ## La référence du ticket TPE
 *
 * Le septième critère de #819 la veut « suivie de la référence du ticket TPE si
 * le caissier l'a saisie ». Elle n'est lue **que** sur le canal `TERMINAL` :
 * `payments_terminal_reference_check` interdit déjà d'en porter une ailleurs, et
 * ne pas s'y fier ici éviterait d'imprimer « en ligne — réf. … » le jour où une
 * reprise de données poserait l'une sans l'autre. La chaîne blanche est absorbée
 * — une référence vide et une référence absente sont le même fait sur le papier.
 *
 * ## Ni PAN, ni quatre derniers chiffres, ici non plus
 *
 * Le canal est le nom d'un tuyau, pas une donnée de carte : ni marque, ni
 * porteur, ni chiffre (payments-stripe §1). Ce qu'il ajoute à la pièce est ce
 * qui permet de la rapprocher du **bon** relevé.
 */
export function formatSettlementMethod(
  settlement: Pick<ReceiptSettlement, 'method' | 'cardChannel' | 'terminalReference'>,
  locale: Locale,
): string {
  const words = receiptVocabulary(locale);

  if (settlement.method === 'CASH') {
    return words.cash;
  }

  if (settlement.cardChannel !== 'TERMINAL') {
    return words.cardOnline;
  }

  const label = words.cardTerminal;
  const reference = settlement.terminalReference;

  return reference === null || reference.trim() === ''
    ? label
    : `${label} ${words.terminalReferencePrefix} ${reference}`;
}

/**
 * Le lien de réservation du salon — celui que le QR code du pied porte.
 *
 * Il pointe le tunnel public (`apps/web/app/(booking)/[tenantSlug]/reservation`)
 * et non la vitrine : une cliente qui scanne le pied d'un ticket vient de sortir
 * du salon, et ce qu'on lui propose est de reprendre rendez-vous, pas de lire
 * les horaires.
 *
 * L'origine vient d'`AppConfigService.appUrl`, validée au démarrage, et le slug
 * de la ligne `tenants` — jamais d'un en-tête de requête. C'est la même règle
 * que `cancellationUrl` chez `notifications`, et pour la même raison : un lien
 * imprimé sous le nom du salon ne doit pas pouvoir être composé par un appelant.
 */
export function bookingUrl(appBaseUrl: string, tenantSlug: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(tenantSlug)}/reservation`;
}

/**
 * Le nom de fichier de la pièce — sixième critère, troisième point.
 *
 * Il **porte le numéro de pièce** : c'est ce qui fait qu'un dossier de
 * téléchargements reste lisible après trente tickets, et ce qu'un comptoir
 * retrouve quand une cliente réclame. Un ticket encore ouvert n'a pas de
 * numéro (#818) : il tombe sur `proforma`, ce qu'il est.
 *
 * Les caractères sont bornés à l'ASCII sûr : un numéro de pièce est composé d'un
 * préfixe d'établissement — que le salon saisit — et de chiffres, et rien ne
 * garantit que ce préfixe ne contienne jamais d'accent ni de séparateur de
 * chemin.
 *
 * ## Le nom suit la langue du document — #1230
 *
 * `facture-…` / `ticket-…` en français, `invoice-…` / `receipt-…` en anglais :
 * le fichier qu'on télécharge est le document lui-même, et un dossier de
 * téléchargements qui mêle les deux nommages n'aide personne. Le **numéro de
 * pièce**, lui, ne bouge pas d'une langue à l'autre — c'est ce qui permet de
 * retrouver la même vente quelle que soit la langue dans laquelle on l'a
 * imprimée.
 *
 * `proforma` reste tel quel dans les deux langues : le mot est latin, et il est
 * le même en français comme en anglais sur une pièce commerciale.
 */
export function receiptFileName(
  receiptNumber: string | null,
  format: 'ticket-80' | 'a4',
  locale: Locale,
): string {
  const words = receiptVocabulary(locale);
  const stem = (receiptNumber ?? 'proforma').replaceAll(/[^A-Za-z0-9._-]/g, '-');
  const suffix = format === 'a4' ? words.invoiceFileStem : words.ticketFileStem;

  return `${suffix}-${stem}.pdf`;
}

/**
 * L'en-tête qui fait proposer un téléchargement sous ce nom — RFC 6266.
 *
 * Deux formes dans le même en-tête : `filename` en ASCII pour les clients
 * anciens, `filename*` encodé pour les autres. Les guillemets et les antislashs
 * sont retirés de la forme brute — ce sont les deux caractères qui
 * refermeraient la chaîne citée et permettraient d'injecter un second en-tête.
 *
 * Le même raisonnement, et la même forme, que `contentDisposition` chez
 * `reporting`. Il est **réécrit** plutôt qu'importé : un module n'importe pas
 * l'interne d'un autre (api-module §3), et les six lignes que cela duplique
 * coûtent moins qu'une dépendance de `payments` vers `reporting`.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/["\\]/g, '');

  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
