import type { PaymentMethod } from './payments.types';

/**
 * L'arithmétique du règlement d'un ticket — #817, quatrième et cinquième
 * critères.
 *
 * Pure et synchrone : ni base, ni horloge, ni contexte de requête. C'est
 * délibéré, et c'est ce qui permet de l'exercer centime par centime comme le
 * reste des calculs d'argent du module (`pos.totals.ts`).
 *
 * ## Ce qu'elle décide, et ce qu'elle ne décide pas
 *
 * Elle décide **combien** ce geste engage sur le ticket et **ce qu'il faut
 * rendre**. Elle ne décide pas si le geste est possible : deux comptoirs qui
 * appellent cette fonction au même instant obtiennent tous deux le même plan,
 * et c'est la base qui tranche — `sales_settled_amount_minor_check` refuse
 * l'écriture de trop, le verrou de la ligne `sales` refuse la course. Ce
 * fichier ne tient aucun invariant de concurrence, et ne prétend pas le faire :
 * « zéro double encaissement » se tient en base, jamais par une vérification
 * applicative (CLAUDE.md, contrainte n°4).
 *
 * Le plan qu'elle rend est donc une **proposition**, relue par la transaction
 * sur l'état réellement verrouillé. Les deux refus qu'elle sait déjà formuler —
 * ticket soldé, dépassement — évitent seulement un aller-retour à la base dans
 * les cas où l'état lu suffit à conclure.
 *
 * ## Aucun montant de l'appelant ne fait autorité
 *
 * `total` et `settled` viennent de la ligne `sales`, écrite par le serveur
 * (cinquième critère). Ce que l'appelant fournit est une **part** de ce total,
 * bornée par lui : jamais le total lui-même, qu'aucun champ de requête ne peut
 * porter.
 */

/** L'état d'un ticket, réduit à ce dont le règlement a besoin. */
export interface SaleBalance {
  /** Ce que la cliente doit, tel que le serveur l'a composé. */
  readonly totalAmountMinor: number;
  /** Ce qui a déjà été **capturé** — les intentions carte en vol n'y sont pas. */
  readonly settledAmountMinor: number;
  /** Non nul dès que le ticket est soldé. */
  readonly settledAt: Date | null;
}

/**
 * Le geste demandé au comptoir.
 *
 * `amountMinor` et `tenderedAmountMinor` s'excluent : désigner une part **et**
 * tendre un billet seraient deux instructions pour un seul geste, et rien ne
 * dirait laquelle l'emporte.
 */
export interface SettlementRequest {
  /**
   * Le moyen, tel que le domaine le connaît : un billet ou une carte.
   *
   * `CARD` désigne ici le **terminal du salon**, et il n'y a pas d'ambiguïté à
   * lever : depuis l'ADR 0014, le comptoir n'a plus d'autre chemin pour une
   * carte — il n'ouvre plus d'intention Stripe. Le canal en est déduit par
   * `counterSettlementOf`, et la frontière HTTP nomme la valeur
   * `CARD_TERMINAL` pour que le contrat, lui, ne laisse rien à déduire.
   */
  readonly method: PaymentMethod;
  /** La part réglée maintenant. Omise, c'est **tout le reste dû**. */
  readonly amountMinor?: number;
  /** Ce que la cliente a tendu — espèces seulement. */
  readonly tenderedAmountMinor?: number;
  /**
   * Le numéro du ticket du TPE, quand le caissier l'a saisi — TPE seulement.
   *
   * Il n'entre dans aucun calcul : cette fonction ne le lit pas, et il est
   * recopié tel quel par le dépôt. Il vit ici parce qu'il fait partie du
   * **geste demandé** — « j'ai passé la carte au terminal, voici la référence de
   * l'opération » —, et que le séparer en aurait fait un second paramètre à
   * faire traverser les mêmes quatre couches.
   */
  readonly terminalReference?: string;
}

/** Ce que la transaction doit écrire, ou la raison de ne rien écrire. */
export type SettlementPlan =
  | {
      readonly outcome: 'apply';
      /** Ce qui s'inscrit en `payments` et s'ajoute au ticket. */
      readonly appliedAmountMinor: number;
      /** La monnaie à rendre — `0` partout sauf sur un billet trop grand. */
      readonly changeAmountMinor: number;
      /** `true` si ce geste solde le ticket. */
      readonly settlesSale: boolean;
    }
  | { readonly outcome: 'already-settled'; readonly settledAt: Date | null }
  | { readonly outcome: 'overpayment'; readonly remainingAmountMinor: number };

/** Ce qui reste dû sur un ticket — jamais négatif, la base l'interdit. */
export function remainingOf(balance: SaleBalance): number {
  return Math.max(0, balance.totalAmountMinor - balance.settledAmountMinor);
}

/**
 * `true` si ce moyen rend la monnaie.
 *
 * Les espèces, et elles seules. Un passage au terminal débite un montant exact,
 * et un « excédent » y serait une faute de frappe qu'il vaut mieux refuser que
 * constater au rapprochement — le terminal n'a pas de tiroir-caisse à ouvrir.
 */
export function givesChange(method: PaymentMethod): boolean {
  return method === 'CASH';
}

/**
 * Le plan d'un règlement, à partir de l'état lu du ticket.
 *
 * Trois issues, dans l'ordre où elles comptent :
 *
 * 1. **le ticket est soldé** — 409, et rien n'est écrit. Que la date soit posée
 *    ou que le reste dû soit tombé à zéro donne le même verdict : les deux
 *    disent « il n'y a plus rien à encaisser », et le `CHECK` de la base ne les
 *    distingue pas davantage ;
 * 2. **le billet tendu dépasse** — ce n'est pas un dépassement mais de la
 *    monnaie : le geste n'engage que le reste dû, et la différence est rendue ;
 * 3. **la part désignée dépasse** — 422, avec le reste dû dans `details`. Le
 *    serveur ne rogne jamais un montant en silence : une caisse qui encaisse
 *    moins que ce qu'on lui a dit est une caisse qu'on ne peut plus lire.
 */
export function planSettlement(
  balance: SaleBalance,
  request: SettlementRequest,
): SettlementPlan {
  const remaining = remainingOf(balance);

  if (balance.settledAt !== null || remaining === 0) {
    return { outcome: 'already-settled', settledAt: balance.settledAt };
  }

  if (request.tenderedAmountMinor !== undefined) {
    // L'excédent d'un billet est la monnaie rendue, pas une recette : seul le
    // reste dû s'inscrit en base, et la différence repart dans la main de la
    // cliente sans jamais être encaissée.
    const applied = Math.min(request.tenderedAmountMinor, remaining);

    return {
      outcome: 'apply',
      appliedAmountMinor: applied,
      changeAmountMinor: request.tenderedAmountMinor - applied,
      settlesSale: balance.settledAmountMinor + applied === balance.totalAmountMinor,
    };
  }

  const applied = request.amountMinor ?? remaining;

  if (applied > remaining) {
    return { outcome: 'overpayment', remainingAmountMinor: remaining };
  }

  return {
    outcome: 'apply',
    appliedAmountMinor: applied,
    changeAmountMinor: 0,
    settlesSale: balance.settledAmountMinor + applied === balance.totalAmountMinor,
  };
}
