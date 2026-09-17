/**
 * La référence du ticket du TPE, et la seule chose qu'elle n'a pas le droit
 * d'être — #834, deuxième critère.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le TPE du salon imprime un ticket portant un numéro d'opération ou
 * d'autorisation. Le caissier le recopie pour que le rapprochement de fin de
 * journée puisse partir de notre ligne et retrouver la sienne. C'est un
 * identifiant opaque émis par la banque du salon, du même rang qu'un `pi_…` :
 * rien n'interdit de le conserver.
 *
 * Ce qu'un champ de texte libre sur le chemin de l'argent rend en revanche
 * possible, et qu'il faut fermer : qu'un caissier y saisisse le **numéro de
 * carte** de la cliente. Ce serait un PAN dans notre base, nos journaux et nos
 * sauvegardes — c'est-à-dire la sortie du périmètre SAQ A, un audit annuel, et
 * exactement ce que payments-stripe §1 énonce comme la ligne à ne jamais
 * franchir.
 *
 * ## Deux barrières, et pourquoi il en faut deux
 *
 * | Barrière | Ce qu'elle arrête |
 * |---|---|
 * | la **forme** — 32 caractères alphanumériques au plus | un PAN espacé ou tirets compris, un nom de porteur, une phrase |
 * | la **clé de Luhn** — 13 à 19 chiffres qui la vérifient | un PAN collé, la saisie la plus probable |
 *
 * Ni l'une ni l'autre ne suffit. La forme laisse passer `4242424242424242`,
 * qui est alphanumérique et tient en 16 caractères. Luhn seul laisserait passer
 * `4242 4242 4242 4242`, qui n'est plus une suite de chiffres. Les deux
 * ensemble ne laissent passer aucune des deux saisies qu'un caissier pressé
 * ferait réellement.
 *
 * ## Ce que ce fichier ne prétend pas être
 *
 * Il ne prétend pas rendre impossible d'écrire un PAN en base : un numéro de
 * carte échoue à Luhn dans un cas sur dix s'il est mal recopié, et rien ne
 * distingue alors la faute de frappe d'une référence légitime. La garantie
 * structurelle est ailleurs, et elle est celle du module depuis #57 : **il n'y
 * a aucun champ de carte**, donc rien à quoi une carte serait *destinée*. Cette
 * fonction ferme le seul champ libre que le comptoir ait à saisir, et c'est
 * tout ce qu'un contrôle peut faire honnêtement.
 *
 * ## Pure, synchrone, sans dépendance
 *
 * Ni base, ni horloge, ni contexte de requête — comme `settlement.rules.ts` et
 * `pos.totals.ts`. C'est ce qui permet de l'exercer numéro par numéro, et c'est
 * ce qui permet au DTO de l'appeler depuis un validateur de `class-validator`,
 * donc de rendre **400** avant qu'aucun code métier ne s'exécute.
 */

/** La borne de la colonne — `payments.terminal_reference VARCHAR(32)`. */
export const MAX_TERMINAL_REFERENCE_LENGTH = 32;

/**
 * La forme admise : des lettres et des chiffres, et rien d'autre.
 *
 * Pas d'espace, pas de tiret, pas de barre oblique. Ce n'est pas une contrainte
 * de confort : les séparateurs sont précisément ce qui rend un PAN méconnaissable
 * à un contrôle de Luhn, et aucun terminal n'imprime de référence qui en ait
 * besoin. Le critère de l'issue dit « 32 caractères alphanumériques au plus ».
 */
const TERMINAL_REFERENCE_SHAPE = /^[A-Za-z0-9]+$/;

/** Les longueurs sur lesquelles un numéro de carte se joue (ISO/IEC 7812). */
const PAN_MIN_DIGITS = 13;
const PAN_MAX_DIGITS = 19;

/**
 * `true` si la valeur a la forme d'une référence de terminal.
 *
 * La longueur nulle n'en est pas une : un champ laissé vide doit être **absent**
 * du corps, pas présent et vide — sans quoi « le caissier n'a pas saisi la
 * référence » et « le caissier a saisi une chaîne vide » deviendraient deux
 * états indiscernables d'une même colonne.
 */
export function isTerminalReferenceShape(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TERMINAL_REFERENCE_LENGTH &&
    TERMINAL_REFERENCE_SHAPE.test(value)
  );
}

/**
 * `true` si la valeur ressemble à un numéro de carte : 13 à 19 chiffres dont la
 * clé de Luhn est juste.
 *
 * L'algorithme est parcouru **de droite à gauche**, en doublant un chiffre sur
 * deux à partir de l'avant-dernier et en repliant tout doublement supérieur à 9
 * par une soustraction de 9 — ce qui est équivalent à sommer ses deux chiffres,
 * sans former de chaîne intermédiaire. La somme totale est un multiple de dix
 * pour tout numéro valide.
 */
export function looksLikeCardNumber(value: string): boolean {
  if (!/^[0-9]+$/.test(value) || value.length < PAN_MIN_DIGITS || value.length > PAN_MAX_DIGITS) {
    return false;
  }

  let sum = 0;
  let double = false;

  for (let index = value.length - 1; index >= 0; index -= 1) {
    // Le chiffre est lu par son code de caractère : `charCodeAt` ne peut pas
    // rendre `NaN` ici, la forme ayant déjà été vérifiée ci-dessus.
    let digit = value.charCodeAt(index) - 48;

    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/** Le verdict d'un contrôle de référence — et, s'il refuse, ce qui est fautif. */
export type TerminalReferenceVerdict = 'ok' | 'mal-formee' | 'ressemble-a-une-carte';

/**
 * Juge une référence de terminal.
 *
 * L'ordre des deux refus compte, et c'est la **forme** qui passe d'abord : le
 * verdict `ressemble-a-une-carte` est le seul dont le message apprendrait à
 * l'appelant ce qui est reconnu comme un numéro, et le réserver aux valeurs
 * déjà bien formées est ce qui l'empêche de servir de sonde. Une valeur qui est
 * à la fois mal formée et un PAN — `4242-4242-4242-4242` — est donc annoncée
 * comme mal formée, ce qui est vrai et ne dit rien de plus.
 */
export function judgeTerminalReference(value: string): TerminalReferenceVerdict {
  if (!isTerminalReferenceShape(value)) {
    return 'mal-formee';
  }

  return looksLikeCardNumber(value) ? 'ressemble-a-une-carte' : 'ok';
}
