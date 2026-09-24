/**
 * Ce que le comptoir sait dire **sans appeler personne** — l'encaissement d'un
 * rendez-vous (#59), puis la composition d'un ticket de caisse (#61).
 *
 * Toute la logique de présentation du comptoir est ici, en fonctions pures :
 * quel moyen de paiement est ouvert pour ce rendez-vous, pourquoi l'autre ne
 * l'est pas, comment se compose un ticket avant d'être envoyé, et comment se lit
 * un refus de l'API. Le composant n'en garde que le rendu — c'est ce qui rend
 * ces règles vérifiables sans monter React, et c'est là qu'elles sont testées.
 *
 * ## Aucun calcul de montant, jamais
 *
 * Ce module ne fait aucune arithmétique monétaire — ni sur un rendez-vous, ni
 * sur un ticket. Le montant dû d'un rendez-vous est le prix **figé à la
 * réservation**, relu tel quel ; le total d'un ticket est celui que le serveur
 * recalcule et que la base vérifie (payments-stripe §4 et §5). Un front qui
 * additionnerait des lignes finirait par afficher un total que la caisse ne
 * confirme pas — et c'est devant la cliente que l'écart se verrait.
 *
 * ## Les mots viennent du catalogue, pas de ce fichier (#850)
 *
 * Les phrases ci-dessous sont lues dans `messages/<langue>/admin-checkout.json`,
 * par **import direct des deux fichiers** — ce sont les mêmes que ceux
 * qu'`useTranslations('admin-checkout')` sert aux trois composants du comptoir.
 * Un crochet de `next-intl` aurait rendu ce module inappelable depuis un Server
 * Component et depuis les tests sans DOM, qui sont justement là où ces règles
 * s'éprouvent.
 *
 * Ce qui ne change pas : **les montants restent des entiers accompagnés d'un
 * code devise**, et aucune fonction d'ici n'en met un en forme. C'est
 * `lib/format.ts` qui le fait, à l'affichage, et c'est le seul endroit où la
 * langue touche à un chiffre (`CLAUDE.md`).
 *
 * ## Pourquoi `locale` a une valeur par défaut, et laquelle
 *
 * `fr`, comme `lib/appointment-status.ts` et `lib/format.ts` : c'est ce que ces
 * fonctions rendaient avant ce ticket, et le défaut garde donc le comportement
 * des rares appelants qui ne la passent pas encore — aujourd'hui, uniquement des
 * suites de tests antérieures. Les quatre surfaces du comptoir, elles, la
 * passent toutes.
 */

import type {
  Appointment,
  AppointmentStatus,
  CounterSettlementMean,
  Locale,
  Money,
  PaymentMethod,
  PaymentStatus,
} from '@spa/shared';
import {
  CAPTURED_PAYMENT_STATUSES,
  ERROR_CODES,
  PAYMENT_ERROR_CODES,
  terminalReferenceSchema,
  validationErrorDetailsSchema,
} from '@spa/shared';

import type {
  CreateSaleRequest,
  PaymentTransaction,
  SaleLineRequest,
  SaleSummary,
} from '@/lib/admin/payment-contract';
import en from '@/messages/en/admin-checkout.json';
import fr from '@/messages/fr/admin-checkout.json';

/** Les deux catalogues du comptoir — la même source que les composants. */
const CATALOG = { fr, en } as const;

/** La langue employée quand l'appelant n'en passe pas — voir l'en-tête. */
export const CHECKOUT_FALLBACK_LOCALE: Locale = 'fr';

/** Le catalogue de l'encaissement, dans la langue demandée. */
export function checkoutWords(locale: Locale = CHECKOUT_FALLBACK_LOCALE): typeof en {
  return CATALOG[locale];
}

/**
 * Les deux moyens que le comptoir propose, dans l'ordre où l'écran les montre —
 * #835, premier critère.
 *
 * Ce sont les **combinaisons légitimes** du fil, celles que
 * `POST /v1/sales/{saleId}/payments` accepte : `CASH`, et `CARD_TERMINAL` pour
 * le TPE autonome de la banque du salon (ADR 0015). `CARD_ONLINE` n'y est pas et
 * ne peut pas y être — le contrat ne sait pas le taper —, ce qui est la forme la
 * plus solide de « Stripe n'est plus utilisé au comptoir » : il n'y a pas de
 * valeur à refuser.
 *
 * Ni « lien de paiement » ni lecteur piloté : la maquette de #30 les dessinait,
 * l'API ne les sert pas, et le TPE intégré est renvoyé en post-MVP (#833).
 */
export const COUNTER_MEANS = [
  'CASH',
  'CARD_TERMINAL',
] as const satisfies readonly CounterSettlementMean[];

/**
 * Le moyen **du domaine** que ce geste produira — ce que l'API rendra dans
 * `payment.method`.
 *
 * Les deux vocabulaires cohabitent délibérément (ADR 0015) : le fil nomme la
 * combinaison (`CARD_TERMINAL`), le domaine nomme le moyen (`card`) et range le
 * tuyau à part. La conversion tient en une ligne et n'existe qu'ici, côté front,
 * pour les libellés que l'écran doit écrire **avant** que l'API n'ait répondu.
 */
export function methodOfMean(mean: CounterSettlementMean): PaymentMethod {
  return mean === 'CASH' ? 'cash' : 'card';
}

/**
 * Le montant dû — le prix figé à la réservation, et rien d'autre.
 *
 * Une fonction plutôt qu'un accès direct à `appointment.price` : c'est le seul
 * endroit qui décide *quel* montant le comptoir encaisse, et le jour où un
 * ticket de caisse (#60) s'y substituera, il n'y aura qu'une ligne à déplacer.
 */
export function amountDue(appointment: Appointment): Money {
  return appointment.price;
}

// ---------------------------------------------------------------------------
// Le tarif qui a bougé entre la réservation et le comptoir — #1240
// ---------------------------------------------------------------------------

/**
 * Le tarif **courant** de la prestation, tel que le catalogue le porte
 * aujourd'hui.
 *
 * `GET /appointments` sert les deux prix côte à côte, et le dit en propres
 * termes (`appointments.repository.ts` : « le tarif **courant** du catalogue, à
 * ne pas confondre avec le prix figé […] le comptoir a besoin des deux pour le
 * dire »). Aucune lecture de plus n'est donc nécessaire pour savoir que l'un a
 * quitté l'autre — c'est ce qui permet à ce ticket de ne pas ouvrir de route.
 */
export function catalogPrice(appointment: Appointment): Money {
  return appointment.service.price;
}

/**
 * L'écart de tarif qu'il faut expliquer **avant** le clic — `null` quand les
 * deux prix coïncident (#1240, deuxième critère).
 *
 * ## Le refus qu'il fait disparaître
 *
 * Le premier règlement d'un rendez-vous compose son ticket par `POST /v1/sales`,
 * qui relit le prix **au catalogue** ; le panneau, lui, n'avait sous la main que
 * le prix figé à la réservation. Tarif baissé depuis, et le montant envoyé
 * dépassait le total du ticket qui venait de naître : `422 SALE_OVERPAYMENT`,
 * rouge, devant la cliente, pour une raison qui n'était pas du fait de
 * l'opérateur. L'échec était sans perte — rien n'était encaissé, le second clic
 * passait — mais il n'avait pas à arriver.
 *
 * ## Deux écarts, deux phrases, parce qu'ils ne se lisent pas au même moment
 *
 * | `kind` | Quand | Ce que l'écran annonce |
 * |---|---|---|
 * | `catalogue` | le ticket n'existe pas encore | le prix auquel il **sera** composé |
 * | `ticket` | le ticket existe | le total qu'il **porte**, qui fait foi |
 *
 * La seconde phrase existait déjà (`ticket.priceDrift`, #835) ; il manquait la
 * première, et c'est exactement l'instant où elle sert.
 *
 * ## Une comparaison, jamais une soustraction
 *
 * Ce module n'additionne ni ne soustrait aucun montant, et cette fonction ne
 * fait pas exception : elle **compare** deux entiers de même devise et rend
 * celui qui s'appliquera. L'écart lui-même n'est jamais calculé — l'écran montre
 * les deux prix et laisse l'opérateur lire la différence, plutôt que d'afficher
 * un troisième chiffre que la caisse ne confirmerait pas (payments-stripe §5).
 *
 * La devise est comparée avec le montant : un catalogue libellé dans une autre
 * devise que le rendez-vous est un écart, pas une coïncidence de chiffres, et
 * `POST /sales` le refusera en 422 `SALE_CURRENCY_MISMATCH`. Mieux vaut le dire
 * avant.
 */
export type PriceDrift = {
  readonly kind: 'catalogue' | 'ticket';
  /** Le montant que la caisse appliquera — celui à annoncer à voix haute. */
  readonly charged: Money;
  /** Le prix figé à la réservation, celui que la cliente a accepté. */
  readonly booked: Money;
};

/** `true` si les deux montants sont le même montant — devise comprise. */
function sameAmount(one: Money, other: Money): boolean {
  return one.currency === other.currency && one.amountMinor === other.amountMinor;
}

export function priceDriftOf(
  appointment: Appointment,
  ticket: SaleSummary | null,
): PriceDrift | null {
  const booked = amountDue(appointment);

  // Le ticket, dès qu'il existe, est la pièce : son total fait foi, pourboire et
  // articles ajoutés compris, et le catalogue n'a plus rien à dire.
  if (ticket !== null) {
    return sameAmount(ticket.total, booked)
      ? null
      : { kind: 'ticket', charged: ticket.total, booked };
  }

  const catalog = catalogPrice(appointment);

  return sameAmount(catalog, booked) ? null : { kind: 'catalogue', charged: catalog, booked };
}

/**
 * Ce que le **premier** règlement peut prendre au plus — le plafond du ticket
 * qui n'existe pas encore (#1240).
 *
 * C'est la moitié agissante du deuxième critère : expliquer l'écart évite la
 * surprise, mais seul ce plafond évite le refus. Le ticket sera composé au tarif
 * du catalogue — une ligne `SERVICE`, quantité 1, taxe **extraite** du prix
 * affiché et non ajoutée (`pos.totals.ts`, #816), donc un total égal à ce tarif —
 * et l'API refuse en 422 tout règlement qui le dépasserait. Envoyer le prix figé
 * quand le catalogue a **baissé** ne pouvait donc qu'échouer.
 *
 * Le plafond ne joue que dans ce sens-là, et c'est délibéré :
 *
 * - **catalogue plus bas** — on prend le tarif du catalogue. C'est le seul
 *   montant que la caisse accepte, et il est en faveur de la cliente.
 * - **catalogue plus haut** — on garde le prix figé. La cliente doit ce qu'elle a
 *   accepté ; le reste demeure sur le ticket, visible, et c'est au salon d'en
 *   décider — pas à cet écran de facturer en silence une hausse qu'elle n'a
 *   jamais vue.
 *
 * Un `min` par comparaison, pas une arithmétique : aucun montant n'est composé
 * ici, l'un des deux est rendu tel quel. Devises différentes : on garde le prix
 * figé, et `priceDriftOf` a déjà mis l'écart sous les yeux de l'opérateur.
 */
export function firstSettlementCeiling(appointment: Appointment): Money {
  const booked = amountDue(appointment);
  const catalog = catalogPrice(appointment);

  return catalog.currency === booked.currency && catalog.amountMinor < booked.amountMinor
    ? catalog
    : booked;
}

/*
 * ## `NOT_PAYABLE_ONLINE` n'existe plus — #835
 *
 * Il portait l'asymétrie du tunnel en ligne : `completed` et `no_show` y étaient
 * refusés en 422 alors que le comptoir devait précisément pouvoir les encaisser.
 * Le comptoir n'ouvre plus d'intention, et les deux moyens qu'il propose
 * acceptent désormais exactement les mêmes statuts — celui qui reste fermé est
 * le seul qui n'ait plus rien à encaisser.
 */

/** Le seul statut sur lequel le comptoir n'encaisse rien du tout. */
const NOT_SETTLEABLE: readonly AppointmentStatus[] = ['cancelled'];

// ---------------------------------------------------------------------------
// L'état de règlement, lu avant le clic et non après — #828
// ---------------------------------------------------------------------------

/**
 * ## Pourquoi cet état existe, et ce qu'il corrige
 *
 * L'écran ouvrait tout rendez-vous avec « À encaisser », ses deux moyens de
 * paiement et un bouton actif — y compris celui qu'une carte avait déjà réglé.
 * Le refus n'arrivait qu'**après** le clic, en 409, et le bouton restait actif :
 * l'opérateur pouvait recliquer devant sa cliente sur un règlement qui
 * n'aboutirait jamais. Le CDC §1.4 range l'historique des ventes dans le
 * périmètre Paiements ; un rendez-vous réglé doit donc **montrer** son
 * règlement, pas le taire jusqu'au refus.
 *
 * Le 409 reste en place et reste le filet : la seule autorité sur ce qui est
 * encaissé est la base, et une lecture d'écran ne peut pas gagner une course
 * contre le poste d'à côté. Ce qui change est le chemin **normal**.
 *
 * ## Cinq états, et pas un booléen
 *
 * Une ligne de `payments` a cinq statuts possibles, et ils n'appellent pas la
 * même conduite au comptoir :
 *
 * | Statut de la ligne | État | Ce que le comptoir peut encore faire |
 * |---|---|---|
 * | aucune ligne | `du` | encaisser, par l'un ou l'autre moyen |
 * | `succeeded`, `refunded`, `partially_refunded`, ticket soldé | `regle` | rien — l'argent a été pris |
 * | `succeeded`…, ticket dont le reste dû est non nul, **aucune carte en vol** | `partiel` | prendre le reste |
 * | `pending` | `ouvert` | reprendre la carte ; les espèces sont refusées en 409 |
 * | `failed` | `echoue` | reprendre la carte ; les espèces sont refusées en 409 |
 *
 * Les deux dernières lignes ne sont pas une subtilité : `replayOrRefuse` côté
 * API refuse un règlement en espèces dès qu'une intention carte existe, quel
 * que soit son sort. Un booléen « réglé ou non » aurait laissé l'écran proposer
 * les espèces sur une intention en échec — et le refus serait revenu après le
 * clic, ce que #828 corrigeait précisément.
 *
 * ## `partiel`, et pourquoi il a fallu l'ajouter — #1240
 *
 * L'unique `@@unique([tenantId, appointmentId])` de la table ne tient plus ce
 * qu'on lui faisait dire. Depuis #817 un règlement de comptoir ne porte
 * **plus** `appointment_id` : il désigne sa vente, et c'est la vente qui porte
 * le rendez-vous — `payments.repository.ts` résout l'un par l'autre avant de
 * servir la ligne. La contrainte ne couvre donc que les intentions en ligne, et
 * un même rendez-vous porte autant d'encaissements de comptoir que son ticket a
 * reçu de règlements. Une part de 50,00 € sur un ticket de 78,00 € en inscrit
 * une, aboutie : l'état se lisait « réglé », et la liste de la journée
 * l'affirmait d'une prestation à moitié payée.
 *
 * Ce qui tranche est le **reste dû du ticket**, jamais le cumul des lignes
 * d'encaissement : `SaleSummary.remaining` est `total − settled` **calculé par
 * le serveur** et relu sous verrou à chaque règlement (payments-stripe §5). Le
 * front n'additionne rien — il lirait un second reste dû, susceptible de
 * diverger de celui que la base tient, et c'est devant la cliente que l'écart se
 * verrait.
 */
export type SettlementState =
  | { readonly kind: 'du' }
  | { readonly kind: 'regle'; readonly payment: PaymentTransaction }
  /** Le ticket porte un règlement abouti **et** un reste dû non nul (#1240). */
  | {
      readonly kind: 'partiel';
      readonly payment: PaymentTransaction;
      readonly ticket: SaleSummary;
    }
  | { readonly kind: 'ouvert'; readonly payment: PaymentTransaction }
  | { readonly kind: 'echoue'; readonly payment: PaymentTransaction };

/** `true` si de l'argent a réellement été pris — la liste close du contrat. */
export function isCapturedPayment(status: PaymentStatus): boolean {
  return (CAPTURED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(status);
}

/**
 * Le ticket qui porte encore un reste dû sur ce rendez-vous — `null` sinon, et
 * `null` aussi quand aucun ticket n'a pu être lu (#1240).
 *
 * L'appelant passe ce que `readDaySettlements` a pu relire ; `undefined` veut
 * dire « pas relu », et ce n'est pas la même chose que « rien à devoir ». C'est
 * la distinction que tient `settlementOf` juste en dessous : sans ticket sous la
 * main, elle **ne conclut pas** au règlement complet — c'est la page qui tait la
 * colonne plutôt que de risquer l'affirmation que ce ticket corrige.
 */
export function outstandingTicketOf(
  tickets: ReadonlyMap<string, SaleSummary> | undefined,
  appointmentId: string,
): SaleSummary | null {
  const ticket = tickets?.get(appointmentId);

  // Le seul test, et il porte sur le champ que le serveur calcule : « il reste
  // un centime dû ». `settledAt` dit la même chose du même ticket — l'API refuse
  // alors en 409 `SALE_ALREADY_SETTLED` — mais c'est `remaining` que le critère
  // nomme, et c'est lui que la pastille doit ne jamais démentir.
  return ticket !== undefined && ticket.remaining.amountMinor > 0 ? ticket : null;
}

/**
 * L'état de règlement d'un rendez-vous, lu dans les encaissements de la journée
 * — et dans le **reste dû** du ticket, quand il a pu être relu (#1240).
 *
 * ## Le rapprochement n'est plus « une ligne par rendez-vous »
 *
 * Il l'a été, et l'en-tête de `SettlementState` dit pourquoi il ne l'est plus :
 * un rendez-vous réglé en plusieurs fois porte autant de lignes que de
 * règlements. La ligne retenue est donc la **première dans l'ordre de l'API** —
 * `GET /payments` sert du plus récent au plus ancien —, c'est-à-dire le dernier
 * règlement pris ; mais l'**état** se décide sur l'ensemble des lignes, et non
 * plus sur celle-là seule. Un `pending` qui suit un `succeeded` ne rouvre pas la
 * carte d'un ticket déjà encaissé.
 *
 * ## Sans ticket relu, l'état reste `regle`, et c'est la page qui se tait
 *
 * Conclure `partiel` faute de preuve serait l'erreur inverse — et la plus
 * courante, puisque l'écrasante majorité des rendez-vous se règlent d'un geste.
 * La prudence se joue un cran plus haut : la page n'affiche la colonne que
 * lorsque **les deux** lectures ont abouti (`page.tsx`), exactement comme elle
 * la taisait déjà quand l'historique ne répondait pas.
 *
 * ## `partiel` ne passe **pas** devant une intention carte en vol
 *
 * L'ordre des trois questions ci-dessous n'est pas cosmétique, et c'est le seul
 * endroit du module où il compte :
 *
 * 1. un encaissement abouti **et** plus rien à devoir — `regle`. Un `pending`
 *    qui suit un ticket soldé ne rouvre rien, et c'est ce que #1240 voulait ;
 * 2. une intention carte encore en vol — `ouvert`, **même s'il a déjà été pris
 *    une part au comptoir**. `hasLiveCardIntent` refuse en 409 tout règlement de
 *    comptoir sur un ticket qui porte une ligne `CARD` + `PENDING`
 *    (`settlement.repository.ts`), et le cas est atteignable depuis #817 : 50,00 €
 *    d'espèces au comptoir, puis la cliente règle le reste depuis son
 *    navigateur. Conclure `partiel` ici aurait rouvert les deux moyens pour
 *    faire retomber le refus **après** le clic — ce que #828 corrigeait ;
 * 3. un encaissement abouti et un reste dû — `partiel`, le reste se prend.
 *
 * Une intention en **échec** ne passe pas devant, elle : la garde de l'API ne
 * porte que sur `PENDING`, une carte refusée n'immobilise donc pas la pièce, et
 * le reste dû doit rester encaissable au comptoir.
 */
export function settlementOf(
  payments: readonly PaymentTransaction[],
  appointmentId: string,
  tickets?: ReadonlyMap<string, SaleSummary>,
): SettlementState {
  const own = payments.filter((one) => one.appointmentId === appointmentId);
  const captured = own.find((one) => isCapturedPayment(one.status));
  const ticket = outstandingTicketOf(tickets, appointmentId);

  if (captured !== undefined && ticket === null) {
    return { kind: 'regle', payment: captured };
  }

  const pending = own.find((one) => one.status === 'pending');

  if (pending !== undefined) {
    return { kind: 'ouvert', payment: pending };
  }

  if (captured !== undefined && ticket !== null) {
    return { kind: 'partiel', payment: captured, ticket };
  }

  const failed = own[0];

  return failed === undefined ? { kind: 'du' } : { kind: 'echoue', payment: failed };
}

/** Le rendez-vous est réglé — plus aucun encaissement à proposer. */
export function isSettled(settlement: SettlementState): boolean {
  return settlement.kind === 'regle';
}

/**
 * Ce que la pastille de la liste annonce — un libellé **et** sa nuance.
 *
 * Le libellé est toujours écrit : la couleur ne fait qu'accélérer le balayage
 * d'une journée, elle ne porte jamais l'information seule (WCAG 1.4.1). C'est
 * la règle que les pastilles de statut du planning tiennent déjà.
 *
 * ## Six libellés pour cinq nuances — #1240
 *
 * « Partiellement réglé » emprunte la nuance `open`, celle de la rampe
 * d'avertissement, plutôt que d'en réclamer une sixième. Ce n'est pas une
 * économie de feuille de style : c'est la même conduite que
 * « partiellement remboursé », qui emprunte `refunded` depuis #828, et elle
 * repose sur la propriété que la section entière garantit — **le libellé est
 * écrit en toutes lettres**, la teinte ne dit jamais rien seule. Les deux états
 * que `open` peint ont d'ailleurs la même conséquence au comptoir : un ticket
 * inachevé, sur lequel il reste un geste à faire.
 */
export function settlementBadge(
  settlement: SettlementState,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): { readonly label: string; readonly modifier: string } {
  const words = checkoutWords(locale).badge;

  switch (settlement.kind) {
    case 'regle':
      switch (settlement.payment.status) {
        case 'refunded':
          return { label: words.refunded, modifier: 'refunded' };
        case 'partially_refunded':
          return { label: words.partiallyRefunded, modifier: 'refunded' };
        default:
          return { label: words.settled, modifier: 'settled' };
      }
    case 'partiel':
      return { label: words.partiallySettled, modifier: 'open' };
    case 'ouvert':
      return { label: words.cardOpen, modifier: 'open' };
    case 'echoue':
      return { label: words.cardFailed, modifier: 'failed' };
    default:
      return { label: words.due, modifier: 'due' };
  }
}

/**
 * Pourquoi ce moyen de paiement est fermé **par l'encaissement déjà inscrit** —
 * `null` s'il reste ouvert.
 *
 * Les messages reprennent ceux que l'API rend en 409, au mot près pour le cas
 * réglé : l'opérateur doit lire la même chose avant et après le clic, faute de
 * quoi il croirait à deux incidents différents.
 */
export function settlementBlocker(
  settlement: SettlementState,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string | null {
  const words = checkoutWords(locale).blocker;

  switch (settlement.kind) {
    case 'regle':
      return words.alreadySettled;
    // Un ticket partiellement réglé ne ferme **rien** — c'est tout le sens de
    // l'état (#1240). Le reste dû se prend par l'un ou l'autre moyen, et la
    // seule chose que #828 voulait empêcher est le règlement de trop sur une
    // pièce soldée. Renvoyer `alreadySettled` ici rendait les 28,00 € restants
    // inatteignables dès que l'écran se rechargeait entre les deux gestes.
    case 'partiel':
      return null;
    // Une intention en ligne, en vol ou en échec, ferme désormais les **deux**
    // moyens du comptoir et non les seules espèces : `SettlementRepository`
    // refuse tout règlement de comptoir sur un ticket qui porte une intention
    // vivante, quel qu'en soit le moyen. Tant que le comptoir ouvrait lui-même
    // l'intention, « reprendre la carte » était une issue ; depuis #835 il n'a
    // plus rien à reprendre — c'est le tunnel en ligne qui doit conclure.
    case 'ouvert':
      return words.onlinePaymentOpen;
    case 'echoue':
      return words.onlinePaymentFailed;
    default:
      return null;
  }
}

/**
 * Pourquoi ce moyen de paiement est fermé pour ce rendez-vous — `null` s'il est
 * ouvert.
 *
 * Le message s'adresse à l'opérateur devant sa cliente : il dit ce qui bloque
 * **et** ce qu'il reste à faire. Une case grisée sans explication renvoie la
 * question au support.
 *
 * Le statut du rendez-vous passe **avant** l'encaissement déjà inscrit : sur un
 * rendez-vous annulé, c'est l'annulation qui explique tout le reste.
 */
export function checkoutBlocker(
  status: AppointmentStatus,
  settlement: SettlementState = { kind: 'du' },
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string | null {
  const words = checkoutWords(locale).blocker;

  if (NOT_SETTLEABLE.includes(status)) {
    return words.cancelled;
  }

  return settlementBlocker(settlement, locale);
}

/** `true` si le comptoir peut encore encaisser ce rendez-vous. */
export function isSettleable(status: AppointmentStatus): boolean {
  return checkoutBlocker(status) === null;
}

/** Le libellé du moyen de paiement, tel que le fieldset l'annonce. */
export function methodLabel(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).method;

  return method === 'cash' ? words.cash : words.card;
}

/** Le libellé du moyen **tel que le comptoir le choisit** — `CASH` ou `CARD_TERMINAL`. */
export function meanLabel(
  mean: CounterSettlementMean,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  return methodLabel(methodOfMean(mean), locale);
}

/** Ce que la ligne d'aide dit sous chaque moyen choisi. */
export function meanHint(
  mean: CounterSettlementMean,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  return methodHint(methodOfMean(mean), locale);
}

/**
 * Le même moyen, mais **dans une phrase** — « réglé par carte bancaire (TPE) »,
 * « réglé en espèces ».
 *
 * Deux formes plutôt qu'une parce que la première est un libellé de case à
 * cocher et la seconde un complément : « Réglé par Espèces » se lit comme une
 * chaîne concaténée, ce qu'elle est, et un bandeau d'encaissement est ce que
 * l'opérateur montre à sa cliente.
 *
 * Les deux langues portent la distinction : « en espèces » / « par carte » et
 * « in cash » / « by card ». Elle n'est donc pas une particularité du français
 * qu'on pourrait laisser tomber à la traduction.
 *
 * ## Le règlement entier, et non le seul `method` — #1245
 *
 * Elle lisait `method` seul, et c'était juste tant que la phrase ne servait qu'à
 * nommer un geste que le comptoir venait de faire : au comptoir, une carte est
 * toujours passée par le TPE du salon (`COUNTER_MEANS`, ADR 0015). Le bandeau du
 * rendez-vous réglé, lui, relit le règlement **préexistant** de la pièce, Stripe
 * compris : il annonçait « par carte bancaire (TPE) » sur un règlement pris par
 * le tunnel public, et envoyait le rapprochement de fin de journée chercher sur
 * le relevé du terminal une opération qui n'y est pas.
 *
 * La règle appliquée n'est pas nouvelle : c'est celle que #1217 a figée pour le
 * ticket affiché et le PDF du reçu — `settlementLabel`
 * (`lib/admin/receipt-ticket.ts`) et `formatSettlementMethod`
 * (`apps/api/.../receipt-pdf.format.ts`). **`cardChannel !== 'TERMINAL'`**, au
 * mot près, pour la raison qui y est écrite : le canal nul — ou absent du fil,
 * le contrat le déclarant `optional` — ne peut désigner qu'une carte antérieure
 * à #834, donc une intention du tunnel, le TPE n'existant pas alors. La
 * comparaison range ce nul du bon côté sans avoir à l'énumérer, là où un
 * `=== 'STRIPE'` aurait inventé un passage au terminal qui n'a jamais eu lieu.
 *
 * Le paramètre est le **règlement** et non deux valeurs positionnelles : c'est
 * la forme de `settlementLabel`, et elle met le canal sous les yeux de qui
 * appelle plutôt que de le laisser se perdre en route — ce qui était exactement
 * le défaut. Elle ne l'**impose** pas pour autant : le contrat déclare
 * `cardChannel` `optional`, donc `{ method }` seul compile — et rend « en
 * ligne », qui est la lecture sûre du canal inconnu, celle que le test du canal
 * absent fige juste à côté.
 *
 * Aucune donnée de carte n'entre ici : le canal est le nom d'un tuyau, ni marque,
 * ni porteur, ni chiffre (payments-stripe §1).
 */
export function methodPhrase(
  settlement: Pick<PaymentTransaction, 'method' | 'cardChannel'>,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).method;

  if (settlement.method === 'cash') {
    return words.cashPhrase;
  }

  if (settlement.cardChannel !== 'TERMINAL') {
    return words.cardOnlinePhrase;
  }

  return words.cardPhrase;
}

/**
 * Ce que la ligne d'aide dit sous chaque moyen — la conséquence du choix, pas sa
 * définition.
 *
 * La mention PCI de la carte n'est pas décorative : l'opérateur doit savoir
 * qu'il n'a **nulle part** où saisir un numéro, et le prochain contributeur doit
 * trouver la raison avant d'ajouter le champ qui semblerait manquer
 * (payments-stripe §1).
 */
export function methodHint(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).method;

  return method === 'cash' ? words.cashHint : words.cardHint;
}

/*
 * Codes de refus que l'API d'encaissement émet et que cet écran sait nommer.
 *
 * Ils étaient écrits en clair ici — quatre constantes locales — le temps que
 * `PAYMENT_ERROR_CODES` existe côté contrat. C'est fait depuis #536, et #546 les
 * y a ramenés : l'écran lit désormais `PAYMENT_ERROR_CODES.…`, comme il lisait
 * déjà `ERROR_CODES.…` pour les refus de transport, quelques lignes plus bas.
 *
 * Ce que la substitution vaut, au-delà de la cosmétique : un code renommé dans
 * `apps/api` fait maintenant échouer la **compilation** de cet écran, là où un
 * littéral l'aurait laissé compiler pour ne plus jamais correspondre à rien. Un
 * `case` mort ne se voit pas ; c'est ainsi que le contrat a pu annoncer
 * `PAYMENT_ALREADY_CAPTURED` pendant des mois quand l'API servait
 * `PAYMENT_ALREADY_SETTLED`. Le garde de `packages/shared` refuse désormais
 * qu'un littéral revienne ici (`src/__tests__/api-error-codes.spec.ts`).
 *
 * `ApiClientError.code` reste un `string` malgré tout, et ce n'est plus un
 * pis-aller : voir la note de `lib/api-client.ts`, où la question a été
 * tranchée — le filtre d'exception de l'API retombe sur `HTTP_<statut>`, une
 * valeur que `ErrorCode` ne contient pas et ne doit pas contenir.
 */

/**
 * Ce que le comptoir lit quand rien n'a répondu — quel que soit le maillon.
 *
 * Un seul texte pour les trois cas qui se ressemblent du point de vue de
 * l'opérateur : Stripe muet côté API, l'action serveur injoignable, ou
 * `confirmPayment` qui échoue dans le navigateur. Ils appellent la même conduite
 * — réessayer, ou encaisser en espèces —, et deux formulations différentes pour
 * un même incident feraient croire à deux incidents.
 *
 * Une fonction depuis #850, et non plus une constante : une constante se fige à
 * l'évaluation du module, c'est-à-dire dans une seule langue, pour tout le
 * processus — le serveur Next sert les deux, souvent dans la même seconde.
 */
export function providerUnreachableMessage(
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  return checkoutWords(locale).failure.providerUnreachable;
}

/**
 * Les refus qui disent « ce rendez-vous porte déjà un encaissement » (#828).
 *
 * ## Une seule liste, lue à deux endroits
 *
 * `isAlreadySettledRefusal` décide de l'**état** de l'écran ;
 * `checkoutFailureMessage` décide du **texte**. Les deux ont longtemps porté
 * chacun sa propre énumération, et c'est exactement par là que le défaut est
 * revenu (#1005) : un code ajouté à l'une sans l'autre donne un écran qui
 * bascule en annonçant autre chose, ou — le cas rencontré — une ligne rouge
 * sous un bouton resté actif. Une constante partagée rend la divergence
 * impossible à écrire.
 *
 * ## Deux codes, parce que la route franchit deux frontières
 *
 * `POST /payments/cash` compose la vente du rendez-vous **puis** la règle
 * (#817). Elle refuse donc en 409 pour deux raisons distinctes, et les deux
 * appellent la même conduite au comptoir :
 *
 * | Code servi | Ce qui bloque |
 * |---|---|
 * | `SALE_ALREADY_SETTLED` | le ticket du rendez-vous est **soldé** — `sales_settled_amount_minor_check` refuse le règlement de trop |
 * | `PAYMENT_ALREADY_SETTLED` | une ligne `payments` est déjà aboutie, ou une intention carte est encore en vol |
 *
 * Le premier manquait. Le refus retombait sur le `default` de
 * `checkoutFailureMessage`, qui rend le message de l'API — « Ce ticket a déjà
 * été réglé. » —, et `isAlreadySettledRefusal` rendait `false` : l'écran ne
 * basculait pas, et le bouton d'encaissement restait cliquable sur un
 * règlement qui ne pouvait qu'échouer à l'identique.
 *
 * `HTTP_409` est du lot, pour la raison même qui fait lire `HTTP_404` et
 * `HTTP_429` plus bas : le filtre d'exception de l'API retombe sur
 * `HTTP_<statut>` dès qu'un refus arrive hors de la forme d'erreur du contrat
 * (voir l'en-tête d'`ApiClientError`). Il n'a pourtant **pas** suffi à rattraper
 * le cas ci-dessus, et c'est la leçon du ticket : le repli ne se déclenche que
 * lorsque le corps n'est *pas* au contrat. Un 409 parfaitement conforme dont le
 * code est inconnu de cette liste passe devant lui sans le toucher.
 */
const ALREADY_SETTLED_REFUSAL_CODES: readonly string[] = [
  PAYMENT_ERROR_CODES.PAYMENT_ALREADY_SETTLED,
  PAYMENT_ERROR_CODES.SALE_ALREADY_SETTLED,
  ERROR_CODES.CONFLICT,
  'HTTP_409',
];

/**
 * `true` si ce refus dit « ce rendez-vous porte déjà un encaissement » (#828).
 *
 * L'écran s'en sert pour **changer d'état** plutôt que d'afficher une ligne
 * d'erreur sous un bouton resté actif : un second clic ne pourrait qu'échouer
 * de la même façon, et le proposer devant une cliente est ce que ce ticket
 * corrige. Le code est lu, jamais le message (web-frontend §2).
 */
export function isAlreadySettledRefusal(code: string): boolean {
  return ALREADY_SETTLED_REFUSAL_CODES.includes(code);
}

/**
 * Le message d'un refus d'encaissement, à partir du code rendu par l'API.
 *
 * L'écran réagit sur le **code**, jamais sur le message (web-frontend §2) : le
 * message de l'API est destiné à un humain, traduisible, et peut changer sans
 * préavis. Il reste le repli — un code inconnu vaut mieux affiché que remplacé
 * par une phrase générique qui n'apprend rien.
 *
 * Le 404 est traité comme les autres : `NOT_FOUND` couvre le rendez-vous inconnu
 * **et** celui d'un autre établissement, indistinctement, et l'écran n'a pas à
 * distinguer ce que l'API refuse de distinguer (tenant-isolation §4).
 */
export function checkoutFailureMessage(
  code: string,
  message: string,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).failure;

  // Avant le `switch`, et non parmi ses `case` : c'est ce qui garantit que le
  // texte affiché et l'état de l'écran se décident sur la **même** liste.
  if (isAlreadySettledRefusal(code)) {
    return words.alreadySettled;
  }

  switch (code) {
    case PAYMENT_ERROR_CODES.APPOINTMENT_NOT_PAYABLE:
      return words.notPayable;
    case PAYMENT_ERROR_CODES.APPOINTMENT_NOT_SETTLEABLE:
      return words.notSettleable;
    // Le reste dû a bougé entre la lecture de l'écran et le clic — un autre
    // poste a encaissé une part. Rien n'a été pris : le serveur ne rogne jamais
    // un montant en silence (#817).
    case PAYMENT_ERROR_CODES.SALE_OVERPAYMENT:
      return words.overpayment;
    case PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE:
    case ERROR_CODES.SERVICE_UNAVAILABLE:
      return words.providerUnreachable;
    case ERROR_CODES.TOO_MANY_REQUESTS:
    case 'HTTP_429':
      return words.tooManyRequests;
    case ERROR_CODES.NOT_FOUND:
    case 'HTTP_404':
      return words.notFound;
    case ERROR_CODES.FORBIDDEN:
      return words.forbidden;
    default:
      // Le message de l'API, tel qu'elle l'a rendu. Il n'est pas traduit ici :
      // c'est elle qui nomme un refus qu'aucun code connu ne couvre, et le
      // remplacer par une phrase générique n'apprendrait rien au comptoir.
      return message;
  }
}

/*
 * ## Plus aucun reçu de comptoir n'est provisoire — #835, ADR 0015
 *
 * `receiptIsProvisional` distinguait la carte des espèces, et la distinction
 * était juste tant que le comptoir confirmait auprès de Stripe : le navigateur
 * n'a jamais autorité pour déclarer un paiement abouti, et c'est le webhook
 * signé qui inscrivait l'encaissement (payments-stripe §2).
 *
 * Le comptoir n'appelle plus aucun prestataire. Espèces comme TPE, il n'y a
 * aucun tiers dont on attende une confirmation : `POST /sales/{id}/payments`
 * inscrit le règlement `SUCCEEDED` avec son opérateur et son horodatage, et le
 * ticket est définitif à la seconde où il s'imprime. La contrepartie est dite
 * dans l'ADR et sur le reçu : le règlement au terminal est une **déclaration
 * d'opérateur**, et l'écart se constate au rapprochement, contre le relevé que
 * le terminal imprime.
 */

/**
 * Ce que l'écran dit du passage en « honoré » après un encaissement.
 *
 * Le quatrième critère de #59 demandait de faire passer le rendez-vous en
 * `completed` du même geste. Ce n'est plus un manque de l'API mais une décision
 * de produit : c'est le salon qui confirme et clôt un rendez-vous, à la main,
 * depuis son planning. L'écran le dit plutôt que de le taire — un encaissement
 * qui laisse le rendez-vous en `confirmed` doit s'expliquer au comptoir, faute
 * de quoi l'opérateur cherche l'erreur de son côté.
 */
export function completionUnavailableMessage(
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  return checkoutWords(locale).completion.settled;
}

/** La mention que le reçu porte sous son total. */
export function receiptDisclaimer(locale: Locale = CHECKOUT_FALLBACK_LOCALE): string {
  return checkoutWords(locale).receipt.cashDisclaimer;
}

// ---------------------------------------------------------------------------
// Le geste de règlement : ce que l'écran vérifie avant d'appeler — #835
// ---------------------------------------------------------------------------

/**
 * Ce qui cloche dans le **numéro du ticket du TPE** saisi — `null` s'il est
 * recevable, y compris vide.
 *
 * Vide est recevable, et c'est le troisième critère de #1025 autant que le
 * deuxième de #835 : le caissier n'a pas toujours le ticket du terminal sous la
 * main, et bloquer la caisse sur un champ de confort serait un refus de service.
 * Le champ absent et le champ vide se rejoignent donc en une seule chose — rien
 * n'est envoyé.
 *
 * La forme est jugée par {@link terminalReferenceSchema}, **le schéma du contrat
 * partagé** et non une expression recopiée ici : 32 caractères alphanumériques
 * au plus, ni espace, ni tiret, ni barre oblique. Les séparateurs sont
 * précisément ce qui rend un numéro de carte méconnaissable à un contrôle, et
 * c'est pourquoi ils n'ont pas leur place dans une référence qu'aucun terminal
 * n'imprime avec.
 *
 * La **seconde** barrière — la clé de Luhn sur 13 à 19 chiffres — n'est pas ici,
 * et c'est délibéré : elle vit à un seul endroit, côté API
 * (`payments/terminal-reference.ts`), et la recopier donnerait deux
 * implémentations d'un même contrôle de conformité, donc deux à faire diverger
 * un jour. Le front borne pour le confort, l'API refuse pour la sécurité
 * (web-frontend §4) — et son refus tombe dans le `ValidationPipe`, avant toute
 * écriture et avant tout journal (payments-stripe §1).
 */
export function terminalReferenceIssue(
  value: string,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string | null {
  // La **même** valeur que celle qui partira : `terminalReferenceField` envoie
  // la chaîne détourée, et juger l'autre faisait refuser à l'écran un numéro
  // parfaitement recevable — « TPE7788A » collé depuis le ticket du terminal
  // arrive avec son espace de fin, et le caissier n'a aucun moyen de deviner
  // que c'est lui qu'on lui reproche.
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  return terminalReferenceSchema.safeParse(trimmed).success
    ? null
    : checkoutWords(locale).terminal.referenceInvalid;
}

/** Ce que le corps porte pour `terminalReference` — la clé absente quand rien n'est saisi. */
export function terminalReferenceField(
  value: string,
): { readonly terminalReference: string } | Record<string, never> {
  const trimmed = value.trim();

  // Absent, et non une chaîne vide : « le caissier n'a pas saisi la référence »
  // et « le caissier a saisi une chaîne vide » deviendraient sinon deux états
  // indiscernables d'une même colonne (`terminalReferenceSchema`).
  return trimmed === '' ? {} : { terminalReference: trimmed };
}

/**
 * Le nom du champ, tel que `class-validator` le préfixe dans ses messages.
 *
 * Les trois violations que `SettleSaleDto` peut produire sur ce champ
 * commencent toutes par lui — « chaîne attendue », « seul un passage au
 * terminal en porte une », « ce champ n'est pas celui d'un numéro de carte »
 * (`payments/dto/settlement.dto.ts`). C'est ce préfixe qui est lu, et non le
 * texte qui suit : celui-là est écrit pour un humain et peut changer sans
 * préavis (web-frontend §2).
 */
const TERMINAL_REFERENCE_FIELD = 'terminalReference';

/** `true` si cette violation de l'API parle du numéro du ticket du TPE. */
function namesTerminalReference(violation: string): boolean {
  return violation.startsWith(TERMINAL_REFERENCE_FIELD);
}

/**
 * Le refus que l'API oppose au **numéro du ticket du TPE** — `null` quand le
 * refus parle d'autre chose.
 *
 * ## Pourquoi ce chemin existe à côté de `terminalReferenceIssue`
 *
 * Les deux barrières de la référence ne sont pas au même endroit, et c'est
 * délibéré : la **forme** — 32 caractères alphanumériques — est jugée à l'écran
 * par `terminalReferenceIssue`, la **clé de Luhn** ne vit que côté API
 * (`payments/terminal-reference.ts`), pour n'avoir qu'une implémentation d'un
 * contrôle de conformité. La conséquence est qu'un numéro parfaitement bien
 * formé — seize chiffres collés, sans espace ni tiret — passe l'écran et se
 * fait refuser en 400 par le serveur.
 *
 * Ce refus-là arrivait **en bloc**, sous le bouton, avec le message générique de
 * la validation — « La requête est invalide. » Il ne disait donc ni quel champ
 * reprendre ni pourquoi, au moment précis où l'opérateur a une cliente devant
 * lui. Le troisième critère de #1025 l'exige sur le champ, et `web-frontend` §4
 * en fait la règle générale : un refus de saisie se pose là où la saisie s'est
 * faite.
 *
 * ## Ce qui est lu, et ce qui est affiché
 *
 * Lu : le **code** et le nom du champ que l'API cite dans `details.violations`.
 * Le filtre d'exception y recopie les messages de `class-validator`, qui citent
 * des noms de champs et jamais de valeurs — la valeur fautive, elle, pourrait
 * être un numéro de carte, et n'a rien à faire dans un corps d'erreur ni dans
 * un journal (`payments-stripe` §1, `domain-exception.filter.ts`).
 *
 * Affiché : la phrase **du catalogue**, dans la langue de l'écran — pas celle
 * de l'API, qui n'est traduite nulle part. C'est la même discipline que partout
 * ailleurs au comptoir : l'écran réagit sur le code, jamais sur le message.
 *
 * `HTTP_400` n'est **pas** du lot, et c'est la différence avec `HTTP_404` et
 * `HTTP_409` lus plus haut : ceux-là se décident sur le code seul, celui-ci
 * aurait besoin des violations. Or le repli `HTTP_<statut>` d'`ApiClientError`
 * n'est construit que sur la branche qui ne passe **aucun** `details` — un 400
 * dont le corps est au contrat garde son vrai code, `VALIDATION_ERROR`. Un cas
 * `HTTP_400` porteur de violations n'existe donc pas, et l'accepter ici ne
 * serait qu'une garde qui ne peut jamais se déclencher.
 *
 * La forme de `details` est jugée par {@link validationErrorDetailsSchema}, le
 * schéma du contrat partagé et non une vérification recopiée : le jour où l'API
 * changera la façon dont elle nomme un champ fautif, c'est lui qui bougera, et
 * ce chemin suivra sans qu'on ait à s'en souvenir.
 */
export function terminalReferenceRefusal(
  code: string,
  details: Record<string, unknown> | undefined,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string | null {
  if (code !== ERROR_CODES.VALIDATION_ERROR) {
    return null;
  }

  const parsed = validationErrorDetailsSchema.safeParse(details);

  // Un 400 de validation qui ne nomme pas ce champ n'est pas le sien : il
  // repart vers le bloc, où un refus qu'aucun champ ne porte doit rester
  // visible plutôt que de disparaître sous un `input` sans rapport.
  if (!parsed.success || !parsed.data.violations.some(namesTerminalReference)) {
    return null;
  }

  return checkoutWords(locale).failure.terminalReferenceRefused;
}

// ---------------------------------------------------------------------------
// La caisse : composer un ticket avant de l'envoyer — #61
// ---------------------------------------------------------------------------

/**
 * ## Ce que la composition d'un ticket n'a pas le droit de faire
 *
 * Tout ce qui suit compose une **demande**, jamais un résultat. Le brouillon
 * porte des natures, des identifiants et des quantités — c'est-à-dire ce que
 * l'opérateur a désigné —, et rien de ce que la cliente devra. Aucune fonction
 * de cette section n'additionne, ne multiplie ni ne totalise un montant : le
 * seul total qui existe est celui que `POST /sales` rend, recalculé par le
 * serveur et vérifié par une contrainte de la base (payments-stripe §4).
 *
 * Cela va jusqu'au détail qui semblerait anodin : une ligne de brouillon ne
 * porte **pas** de « total de ligne ». Le prix unitaire y figure parce qu'il
 * vient du catalogue et aide à choisir ; le multiplier par la quantité pour
 * l'afficher aurait produit un second chiffre, calculé ici, à côté du
 * `lineAmount` que le serveur rend — et deux chiffres qui peuvent diverger sur
 * un ticket, c'est un litige de comptoir.
 */

/**
 * Bornes du ticket, reprises de `SaleLineDto` côté API.
 *
 * Les rappeler ici ne dispense de rien — c'est le serveur qui refuse — mais
 * évite de composer devant une cliente un ticket que l'envoi rejettera en 400.
 * Le front borne pour le confort, l'API pour la sécurité (web-frontend §4).
 */
export const POS_MAX_LINES = 100;
export const POS_MAX_QUANTITY = 1000;

/**
 * Plafond d'un pourboire — la borne du type de la colonne, celle que
 * `SaleLineDto.amountMinor` porte en `@Max`.
 *
 * Elle est rappelée pour la même raison que les deux autres : un pourboire
 * au-delà n'est jamais une saisie volontaire — 21 474 836,47 € en EUR — et le
 * laisser partir aurait fait tomber un 400 de validation devant la cliente.
 */
export const POS_MAX_TIP_AMOUNT_MINOR = 2_147_483_647;

/** Les deux natures qu'un opérateur ajoute lui-même. `TAX` est au serveur. */
export type PosLineKind = 'SERVICE' | 'PRODUCT';

/**
 * Un élément vendable, tel que l'écran le propose — une prestation du catalogue
 * ou un article du rayon, ramenés à la même forme.
 *
 * `unitPrice` est **indicatif** : c'est le prix affiché au moment du choix, et
 * le serveur relira le sien à l'enregistrement. Les deux coïncident presque
 * toujours ; quand ils divergent — un tarif changé pendant que le ticket était
 * ouvert —, c'est celui du serveur qui fait foi, et le total rendu le dira.
 */
export interface PosCatalogItem {
  readonly kind: PosLineKind;
  /** L'identifiant de la prestation ou de l'article, selon `kind`. */
  readonly id: string;
  readonly label: string;
  readonly unitPrice: Money;
}

/** Une ligne du brouillon : l'élément choisi, et combien de fois. */
export interface PosDraftLine extends PosCatalogItem {
  readonly quantity: number;
}

/**
 * Le ticket en cours de composition.
 *
 * `appointmentId` rattache la vente à un rendez-vous, ou vaut `null` pour une
 * vente retail autonome — les deux depuis le départ, comme le modèle l'exige
 * (payments-stripe §4).
 *
 * `tipAmountMinor` est un champ et non une ligne parce que l'API n'accepte
 * **qu'un** pourboire par ticket : deux lignes envoyées par mégarde seraient
 * refusées en 400, et un brouillon qui ne sait pas en porter deux ne peut pas
 * en fabriquer deux.
 */
export interface PosDraft {
  readonly appointmentId: string | null;
  readonly lines: readonly PosDraftLine[];
  readonly tipAmountMinor: number | null;
}

/** Un ticket vide, rattaché ou non à un rendez-vous. */
export function emptyPosDraft(appointmentId: string | null = null): PosDraft {
  return { appointmentId, lines: [], tipAmountMinor: null };
}

/**
 * Le nombre de lignes que l'envoi portera — pourboire compris.
 *
 * Le pourboire compte parce qu'il **est** une ligne dans le corps envoyé : le
 * plafond de cent porte sur le tableau `lines`, pas sur ce que l'écran affiche
 * au-dessus du pourboire.
 */
export function posLineCount(draft: PosDraft): number {
  return draft.lines.length + (draft.tipAmountMinor === null ? 0 : 1);
}

/** Deux références désignent la même ligne si elles ont même nature et même identifiant. */
function isSameItem(line: PosDraftLine, kind: PosLineKind, id: string): boolean {
  return line.kind === kind && line.id === id;
}

/**
 * Ajoute un élément au ticket — ou incrémente la ligne qui le porte déjà.
 *
 * Fusionner plutôt qu'empiler est ce que le comptoir attend : deux shampooings
 * se lisent « ×2 » sur le reçu, pas sur deux lignes que la cliente compte à la
 * main. C'est aussi ce qui garde le plafond de cent lignes hors de portée d'une
 * vente réelle.
 *
 * Le ticket est rendu **inchangé** quand il n'y a plus de place, ou quand la
 * ligne est déjà à sa quantité maximale : refuser en silence vaut mieux
 * qu'écrêter en silence, et l'écran lit `posLineCount` pour le dire.
 */
export function addPosLine(draft: PosDraft, item: PosCatalogItem): PosDraft {
  const existing = draft.lines.find((line) => isSameItem(line, item.kind, item.id));

  if (existing !== undefined) {
    return existing.quantity >= POS_MAX_QUANTITY
      ? draft
      : setPosLineQuantity(draft, item.kind, item.id, existing.quantity + 1);
  }

  return posLineCount(draft) >= POS_MAX_LINES
    ? draft
    : { ...draft, lines: [...draft.lines, { ...item, quantity: 1 }] };
}

/**
 * Fixe la quantité d'une ligne — et la retire si la quantité tombe à zéro.
 *
 * Zéro **retire** au lieu de laisser une ligne vide : une ligne de quantité
 * nulle n'est pas une ligne, l'API la refuse (`Min(1)`), et une case ramenée à
 * zéro veut dire « je n'en veux plus » dans tous les logiciels de caisse. Le
 * quatrième critère du ticket — retirer une ligne — se sert donc aussi bien par
 * là que par `removePosLine`.
 *
 * Une valeur non entière est tronquée, jamais arrondie au-dessus : on ne vend
 * pas ce qui n'a pas été demandé. `NaN` retire la ligne, pour la même raison —
 * une quantité illisible n'est pas une quantité.
 */
export function setPosLineQuantity(
  draft: PosDraft,
  kind: PosLineKind,
  id: string,
  quantity: number,
): PosDraft {
  const wanted = Number.isFinite(quantity) ? Math.trunc(quantity) : 0;

  if (wanted <= 0) {
    return removePosLine(draft, kind, id);
  }

  const capped = Math.min(wanted, POS_MAX_QUANTITY);

  return {
    ...draft,
    lines: draft.lines.map((line) =>
      isSameItem(line, kind, id) ? { ...line, quantity: capped } : line,
    ),
  };
}

/** Retire une ligne du ticket. Sans effet si elle n'y est pas. */
export function removePosLine(draft: PosDraft, kind: PosLineKind, id: string): PosDraft {
  return { ...draft, lines: draft.lines.filter((line) => !isSameItem(line, kind, id)) };
}

/**
 * Pose ou efface le pourboire, en **entier**, dans la plus petite unité de la
 * devise du salon.
 *
 * Toute valeur qui n'est pas un entier strictement positif efface le pourboire
 * au lieu d'en poser un approximatif : `null`, zéro, un négatif, un `NaN` venu
 * d'un champ vidé. C'est la direction sûre — pas de pourboire vaut mieux qu'un
 * mauvais pourboire —, et c'est aussi la seule qui ne fasse jamais payer à la
 * cliente un montant que personne n'a saisi. Un montant au-delà de
 * `POS_MAX_TIP_AMOUNT_MINOR` l'efface pour la même raison, et non par
 * écrêtement : ramener une saisie qui a dérapé à 21 474 836,47 € serait le seul
 * geste de ce module capable de faire payer plus que ce qui a été demandé.
 *
 * Le montant est tronqué et non arrondi, pour la même raison qu'une quantité.
 *
 * ## Pourquoi la place est comptée ici aussi
 *
 * Le pourboire **est** une ligne du corps envoyé. Sur un ticket déjà plein, le
 * poser porterait le tableau `lines` à cent une entrées, qu'`ArrayMaxSize`
 * refuserait en 400 — après que l'écran a annoncé un ticket envoyable. Le ticket
 * est donc rendu inchangé, comme `addPosLine` le fait au même plafond. Effacer
 * un pourboire reste toujours possible : cela retire une ligne, cela n'en ajoute
 * aucune.
 */
export function setPosTip(draft: PosDraft, amountMinor: number | null): PosDraft {
  if (amountMinor === null || !Number.isFinite(amountMinor)) {
    return { ...draft, tipAmountMinor: null };
  }

  const posed = Math.trunc(amountMinor);

  if (posed < 1 || posed > POS_MAX_TIP_AMOUNT_MINOR) {
    return { ...draft, tipAmountMinor: null };
  }

  return draft.tipAmountMinor === null && draft.lines.length >= POS_MAX_LINES
    ? draft
    : { ...draft, tipAmountMinor: posed };
}

/**
 * `true` si le ticket peut partir — au moins une ligne, pourboire compris.
 *
 * Un pourboire seul est un ticket valide : `POST /sales` n'exige qu'une ligne,
 * et le comptoir doit pouvoir enregistrer un pourboire laissé après coup sans
 * refacturer la prestation.
 */
export function posDraftIsSubmittable(draft: PosDraft): boolean {
  return posLineCount(draft) > 0;
}

/**
 * Le corps de `POST /sales`, composé du brouillon.
 *
 * L'ordre de saisie est conservé — c'est celui du reçu — et le pourboire vient
 * en dernier, là où un ticket de caisse le porte.
 *
 * Relire cette fonction est la façon la plus courte de vérifier l'invariant du
 * ticket : **aucun `unitPrice`, aucun `lineAmount`, aucun total n'en sort.**
 * Seul le pourboire est un montant, et c'est le seul que l'API accepte.
 */
export function toCreateSaleRequest(draft: PosDraft): CreateSaleRequest {
  const lines: SaleLineRequest[] = draft.lines.map((line) =>
    line.kind === 'SERVICE'
      ? { kind: 'SERVICE', serviceId: line.id, quantity: line.quantity }
      : { kind: 'PRODUCT', productId: line.id, quantity: line.quantity },
  );

  if (draft.tipAmountMinor !== null) {
    lines.push({ kind: 'TIP', amountMinor: draft.tipAmountMinor });
  }

  return { appointmentId: draft.appointmentId, lines };
}

/** Une ligne de la pile de totaux, telle que l'écran et le reçu l'impriment. */
export interface SaleTotalRow {
  readonly label: string;
  readonly amount: Money;
  /** La ligne mise en avant — celle que l'opérateur annonce à voix haute. */
  readonly isGrand: boolean;
}

/**
 * Les totaux d'un ticket, **lus** de la réponse du serveur.
 *
 * Le troisième critère de ce ticket se joue entièrement ici : rien n'est
 * additionné. `total` n'est pas `subtotal + tax + tip` recomposé à l'affichage,
 * c'est le champ que le serveur a recalculé — la seule autorité sur ce que la
 * cliente doit.
 *
 * Taxe et pourboire ne s'affichent qu'à partir du moment où ils portent quelque
 * chose : une ligne « Pourboire 0,00 € » sur chaque ticket est du bruit, et le
 * bruit sur un reçu se lit comme une erreur. Sous-total et total, eux, sont
 * toujours là — y compris égaux, ce qui est précisément le cas d'un salon sans
 * taxe et d'une cliente sans pourboire.
 */
export function saleTotalRows(
  sale: SaleSummary,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): readonly SaleTotalRow[] {
  const words = checkoutWords(locale).sale;

  return [
    { label: words.subtotal, amount: sale.subtotal, isGrand: false },
    ...(sale.tax.amountMinor === 0
      ? []
      : [{ label: words.tax, amount: sale.tax, isGrand: false }]),
    ...(sale.tip.amountMinor === 0
      ? []
      : [{ label: words.tip, amount: sale.tip, isGrand: false }]),
    { label: words.total, amount: sale.total, isGrand: true },
  ];
}

/*
 * Les codes de refus de la caisse viennent du contrat, comme ceux de
 * l'encaissement quelques centaines de lignes plus haut : `PAYMENT_ERROR_CODES`
 * porte les quatre que ce `switch` nomme, et #546 a retiré les quatre
 * constantes locales qui les redoublaient. La note de la section précédente vaut
 * mot pour mot ici.
 */

/**
 * Le message d'un refus de la caisse, à partir du code rendu par l'API.
 *
 * Comme partout dans le back-office, l'écran réagit sur le **code** et jamais
 * sur le message (web-frontend §2). Chaque phrase dit ce qui bloque *et* le
 * geste qui débloque : devant une cliente, un refus qu'on ne sait pas lever
 * finit en vente perdue.
 *
 * `NOT_FOUND` couvre l'article inconnu **et** celui d'un autre établissement,
 * indistinctement — l'écran n'a pas à distinguer ce que l'API refuse de
 * distinguer (tenant-isolation §4).
 */
export function saleFailureMessage(
  code: string,
  message: string,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).sale;

  switch (code) {
    case PAYMENT_ERROR_CODES.SALE_ITEM_UNAVAILABLE:
      return words.itemUnavailable;
    case PAYMENT_ERROR_CODES.SALE_CURRENCY_MISMATCH:
    case ERROR_CODES.CURRENCY_MISMATCH:
      return words.currencyMismatch;
    case PAYMENT_ERROR_CODES.SALE_AMOUNT_OUT_OF_RANGE:
      return words.amountOutOfRange;
    case PAYMENT_ERROR_CODES.HISTORY_WINDOW_INVALID:
      return words.historyWindowInvalid;
    case ERROR_CODES.VALIDATION_ERROR:
      return words.validation;
    case ERROR_CODES.NOT_FOUND:
    case 'HTTP_404':
      return words.notFound;
    case ERROR_CODES.FORBIDDEN:
      return words.forbidden;
    case ERROR_CODES.SERVICE_UNAVAILABLE:
      return words.unavailable;
    default:
      return message;
  }
}
