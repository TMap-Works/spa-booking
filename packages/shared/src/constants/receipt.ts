/**
 * Le ticket de caisse — numérotation et identité légale de l'établissement
 * (#818, CDC §1.4 « encaissement au comptoir », payments-stripe §4).
 *
 * Ce fichier porte ce qui doit être **vrai des deux côtés** : la forme d'un
 * numéro de pièce, la forme d'un identifiant d'entreprise, et les bornes des
 * colonnes qui les stockent. Le front ne redéclare aucune de ces règles — il les
 * importe, exactement comme il importe `APPOINTMENT_REFERENCE_PATTERN`.
 *
 * ## Ce qu'il ne porte pas
 *
 * Aucune donnée de carte, aucun secret, aucun montant : un ticket de caisse est
 * une pièce comptable, et la frontière PCI passe ailleurs (payments-stripe §1).
 */

/**
 * Les natures d'identifiant d'entreprise que le MVP reconnaît — #818, troisième
 * critère.
 *
 * Deux pays sont servis aujourd'hui, et ils ne nomment pas la même chose :
 * la France identifie l'établissement par son **SIRET** (14 chiffres) et
 * l'entreprise par son **SIREN** (9 chiffres) ; Madagascar identifie le
 * contribuable par son **NIF** et l'établissement par son numéro **STAT**.
 * `OTHER` — le « AUTRE » du critère — couvre tous les autres pays sans
 * prétendre connaître leur plan de numérotation : c'est un format libre borné,
 * et c'est délibérément tout ce que le MVP en dit.
 *
 * En majuscules, comme `counterPaymentMethodSchema` et pour la même raison :
 * c'est la valeur que la colonne `tenants.legal_id_type` porte, et une
 * traduction de casse à la frontière n'aurait servi qu'à créer deux
 * orthographes d'une même valeur.
 */
export const LEGAL_ID_TYPES = ['SIRET', 'SIREN', 'NIF', 'STAT', 'OTHER'] as const;

export type LegalIdType = (typeof LEGAL_ID_TYPES)[number];

/** `true` si `value` est une nature d'identifiant connue. */
export function isLegalIdType(value: unknown): value is LegalIdType {
  return typeof value === 'string' && (LEGAL_ID_TYPES as readonly string[]).includes(value);
}

/** `VARCHAR(160)` — raison sociale, largeur de `tenants.legal_name`. */
export const LEGAL_NAME_MAX_LENGTH = 160;

/** `VARCHAR(32)` — largeur de `tenants.legal_id` et de `tenants.vat_number`. */
export const LEGAL_ID_MAX_LENGTH = 32;

/**
 * `VARCHAR(500)` — mentions de pied de ticket, borne du troisième critère.
 *
 * Cinq cents caractères : de quoi porter les mentions légales qu'un salon
 * imprime (conditions de remboursement, médiation de la consommation), pas de
 * quoi faire du ticket un support de communication.
 */
export const RECEIPT_FOOTER_MAX_LENGTH = 500;

/** Longueurs du préfixe de numérotation — `VARCHAR(8)`, jamais vide. */
export const RECEIPT_PREFIX_MIN_LENGTH = 2;
export const RECEIPT_PREFIX_MAX_LENGTH = 8;

/**
 * Le préfixe d'un salon qui n'en a pas choisi.
 *
 * La colonne est `NOT NULL` avec ce défaut, et non nullable : le format du
 * deuxième critère — `{PRÉFIXE}-{AAAA}-{000123}` — doit être rendu pour
 * **toute** vente close, y compris celle d'un établissement qui n'a jamais
 * ouvert son écran de réglages.
 */
export const DEFAULT_RECEIPT_PREFIX = 'TIC';

/**
 * Lettres majuscules et chiffres, deux à huit caractères.
 *
 * Ni espace, ni tiret : le tiret est le **séparateur** du format, et un préfixe
 * qui en porterait rendrait `TI-C-2026-000123` indécomposable. La casse est
 * normalisée à la saisie pour la même raison qu'un code pays l'est —
 * « tic », « Tic » et « TIC » sont trois chaînes pour un seul préfixe.
 */
export const RECEIPT_PREFIX_PATTERN = /^[A-Z0-9]{2,8}$/;

/** `true` si `value` est un préfixe de numérotation acceptable. */
export function isReceiptPrefix(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_PREFIX_PATTERN.test(value);
}

/**
 * Nombre de chiffres du rang dans le numéro affiché — `000123`.
 *
 * Six chiffres, et le rang **déborde** au-delà plutôt que d'être tronqué :
 * un salon qui dépasse le million de pièces doit lire `1234567`, pas `234567`.
 * Un numéro tronqué désignerait deux ventes à la fois, ce que l'unique en base
 * interdit précisément de représenter.
 */
export const RECEIPT_SEQUENCE_PAD = 6;

/**
 * La forme affichée d'un numéro de pièce — deuxième critère de #818.
 *
 * `TIC-2026-000123` : le préfixe de l'établissement, l'année **de la pièce**, et
 * le rang dans la suite de l'établissement.
 *
 * ## L'année n'est pas une clé de remise à zéro
 *
 * Le compteur est **continu par établissement** : `sales.receipt_number` est
 * unique par `(tenant_id, receipt_number)` — premier critère —, et une remise à
 * zéro annuelle produirait deux ventes de même rang dans deux années, que cet
 * unique refuse d'écrire. L'année affichée est donc une **lecture** de la date
 * de la pièce, jamais un compartiment du compteur. C'est aussi ce qui garantit
 * qu'un ticket ne peut pas changer de numéro parce qu'il a été clos le 1er
 * janvier à 00 h 05 dans le fuseau du salon et le 31 décembre à 23 h 05 en UTC.
 *
 * @param prefix le préfixe de l'établissement, déjà normalisé.
 * @param year l'année **civile de l'établissement**, résolue dans son fuseau par
 * l'appelant : cette fonction ne connaît aucun fuseau, et n'en invente pas.
 * @param sequence le rang, strictement positif.
 */
export function formatReceiptNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${String(year).padStart(4, '0')}-${String(sequence).padStart(RECEIPT_SEQUENCE_PAD, '0')}`;
}

/**
 * La pièce d'avoir d'un remboursement — sixième critère de #818.
 *
 * `TIC-2026-000123-R1` : **la vente garde son numéro**, et le remboursement
 * produit sa propre pièce, qui cite celui-ci.
 *
 * ## Pourquoi un rang et non un second compteur
 *
 * Parce que le premier critère attache la suite sans trou à `sales` et à elle
 * seule. Un second compteur aurait été une seconde suite à tenir sans trou, avec
 * son propre verrou, pour numéroter des pièces qui n'existent **que** par la
 * vente qu'elles annulent. Le rang, lui, se déduit d'un ordre total et
 * immuable — les remboursements d'une vente, du plus ancien au plus récent — et
 * il ne peut ni sauter, ni collisionner : deux avoirs d'une même vente ont deux
 * rangs, deux avoirs de deux ventes ont deux numéros d'origine.
 *
 * @param receiptNumber le numéro affiché de la vente d'origine.
 * @param rank le rang du remboursement sur cette vente, à partir de 1.
 */
export function formatRefundReceiptNumber(receiptNumber: string, rank: number): string {
  return `${receiptNumber}-R${String(rank)}`;
}

/**
 * Le SIRET — 14 chiffres dont le dernier est une clé de Luhn (quatrième
 * critère).
 *
 * La clé n'est pas une coquetterie : c'est ce qui distingue une saisie fautive
 * d'un établissement réel. Un ticket qui porte un SIRET faux est un ticket
 * qu'aucune comptabilité ne peut rapprocher, et l'erreur ne se découvre qu'au
 * contrôle — des mois après la première impression.
 *
 * ## L'exception La Poste, et pourquoi elle n'est pas traitée
 *
 * Les SIRET de La Poste (SIREN `356000000`) ne satisfont pas Luhn et se
 * vérifient par une somme de chiffres modulo 5. Le MVP ne sert pas La Poste, et
 * coder une exception pour un établissement unique reviendrait à affaiblir la
 * règle pour tous. Le jour où le cas se présente, `OTHER` accepte la valeur en
 * format libre — c'est exactement ce que cette nature existe pour absorber.
 */
export function isValidSiret(value: string): boolean {
  return /^\d{14}$/.test(value) && passesLuhn(value);
}

/**
 * La clé de Luhn d'une suite de chiffres, quelle que soit sa longueur.
 *
 * Écrite **une fois** et partagée par le SIRET et le SIREN : les deux
 * identifiants ne diffèrent que par leur longueur, et deux implémentations
 * auraient fini par diverger sur le seul point qui compte, le sens de lecture.
 *
 * Le rang est lu depuis la **droite** : le chiffre de contrôle est le dernier,
 * et Luhn double un chiffre sur deux en partant de lui.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;

  for (let position = 0; position < digits.length; position += 1) {
    const digit = Number(digits[digits.length - 1 - position]);
    const doubled = position % 2 === 1 ? digit * 2 : digit;

    sum += doubled > 9 ? doubled - 9 : doubled;
  }

  return sum % 10 === 0;
}

/**
 * Le SIREN — les neuf premiers chiffres du SIRET, même clé de Luhn.
 *
 * Écrit à partir du même calcul plutôt qu'en le recopiant : les deux
 * identifiants ne diffèrent que par leur longueur, et deux implémentations
 * auraient fini par diverger sur le seul point qui compte, le sens de lecture.
 */
export function isValidSiren(value: string): boolean {
  return /^\d{9}$/.test(value) && passesLuhn(value);
}

/**
 * Le numéro de TVA intracommunautaire **français** — quatrième critère.
 *
 * `FR` suivi d'une clé de deux caractères puis du SIREN. La clé est
 * `(12 + 3 × (SIREN modulo 97)) modulo 97` quand elle est numérique ; les clés
 * alphabétiques — attribuées aux entreprises créées depuis 2009 — ne se
 * recalculent pas et sont acceptées sur leur seule forme, le SIREN qui les suit
 * restant vérifié par Luhn.
 *
 * Les numéros des autres pays ne sont pas jugés ici : ils suivent vingt-six
 * plans de numérotation distincts, et refuser un numéro belge valide coûterait
 * plus cher que d'accepter une saisie libre. Le contrat les borne en longueur et
 * en alphabet, rien de plus — c'est ce que le critère demande.
 */
export function isValidFrenchVatNumber(value: string): boolean {
  const match = /^FR([0-9A-HJ-NP-Z]{2})(\d{9})$/.exec(value);

  if (match === null) {
    return false;
  }

  const key = match[1] ?? '';
  const siren = match[2] ?? '';

  if (!isValidSiren(siren)) {
    return false;
  }

  if (!/^\d{2}$/.test(key)) {
    // Clé alphabétique : non recalculable, acceptée sur sa forme.
    return true;
  }

  return Number(key) === (12 + 3 * (Number(siren) % 97)) % 97;
}

/**
 * Le motif d'un identifiant légal en format libre — les pays que le MVP ne sait
 * pas juger.
 *
 * Majuscules, chiffres, tiret et barre oblique : l'alphabet des identifiants
 * d'entreprise en usage, sans espace — un identifiant se recopie, il ne se
 * met pas en page.
 */
export const FREE_FORM_LEGAL_ID_PATTERN = /^[A-Z0-9/-]{4,32}$/;

/**
 * `true` si `value` est un identifiant acceptable **pour cette nature**.
 *
 * Le jugement dépend de la nature, et c'est le cœur du quatrième critère :
 * un SIRET se vérifie, un NIF malgache ne se vérifie pas — et le prétendre
 * reviendrait à refuser des établissements réels sur une règle inventée.
 */
export function isValidLegalId(type: LegalIdType, value: string): boolean {
  switch (type) {
    case 'SIRET':
      return isValidSiret(value);
    case 'SIREN':
      return isValidSiren(value);
    default:
      return FREE_FORM_LEGAL_ID_PATTERN.test(value);
  }
}

/**
 * Le motif d'un numéro de TVA, toutes origines confondues.
 *
 * Deux lettres de pays puis huit à treize caractères alphanumériques : la forme
 * commune à tous les plans de l'Union. Le numéro **français** est vérifié plus
 * loin que sa forme par {@link isValidFrenchVatNumber} ; les autres ne le sont
 * pas, faute d'une règle unique à appliquer.
 */
export const VAT_NUMBER_PATTERN = /^[A-Z]{2}[0-9A-Z]{8,13}$/;

/** `true` si `value` est un numéro de TVA acceptable. */
export function isValidVatNumber(value: string): boolean {
  if (!VAT_NUMBER_PATTERN.test(value)) {
    return false;
  }

  return value.startsWith('FR') ? isValidFrenchVatNumber(value) : true;
}
