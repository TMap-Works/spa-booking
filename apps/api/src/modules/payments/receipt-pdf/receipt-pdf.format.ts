import type { Money } from '../payments.types';
import type { ReceiptSettlement } from '../receipt.types';

/**
 * La mise en forme de ce qui s'imprime — #819, cinquième et septième critères.
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
 */

/** La locale d'impression. Le MVP sert des salons francophones (CDC §1.2). */
const LOCALE = 'fr-FR';

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
export function formatMoney(money: Money): string {
  const formatter = new Intl.NumberFormat(LOCALE, {
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
export function formatTaxRate(rateBps: number): string {
  return printable(
    new Intl.NumberFormat(LOCALE, {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(rateBps / 10_000),
  );
}

/** « 17/09/2026 » — la date seule, dans le fuseau du salon. */
export function formatDate(instant: Date, timeZone: string): string {
  return printable(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(instant),
  );
}

/** « 17/09/2026 à 08:30 » — la date et l'heure, dans le fuseau du salon. */
export function formatDateTime(instant: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);

  return `${formatDate(instant, timeZone)} à ${printable(time)}`;
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
 * ## La référence du ticket TPE
 *
 * Le critère la veut « suivie de la référence du ticket TPE si le caissier l'a
 * saisie ». Cette saisie est l'objet de **#834**, qui n'est pas traitée : la
 * colonne n'existe pas, et aucun règlement n'en porte. La ligne s'imprime donc
 * « Carte bancaire (TPE) » seule — ce que le critère prévoit explicitement comme
 * le cas où rien n'a été saisi.
 *
 * Le paramètre `reference` est le point de couture laissé à #834 : lui passer la
 * colonne le jour où elle existe suffit, et le test qui suit fige déjà le rendu
 * attendu des deux côtés. Il n'est **pas** lu d'un champ spéculatif de
 * `ReceiptSettlement` — un champ toujours nul n'aurait été qu'une colonne morte
 * de plus à faire traverser au dépôt, au domaine et au DTO.
 */
export function formatSettlementMethod(
  method: ReceiptSettlement['method'],
  reference: string | null = null,
): string {
  if (method === 'CASH') {
    return 'Espèces';
  }

  const label = 'Carte bancaire (TPE)';

  return reference === null || reference.trim() === '' ? label : `${label} — réf. ${reference}`;
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
 */
export function receiptFileName(receiptNumber: string | null, format: 'ticket-80' | 'a4'): string {
  const stem = (receiptNumber ?? 'proforma').replaceAll(/[^A-Za-z0-9._-]/g, '-');
  const suffix = format === 'a4' ? 'facture' : 'ticket';

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
