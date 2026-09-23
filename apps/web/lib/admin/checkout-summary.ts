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
  Locale,
  Money,
  PaymentMethod,
  PaymentStatus,
} from '@spa/shared';
import { CAPTURED_PAYMENT_STATUSES, ERROR_CODES, PAYMENT_ERROR_CODES } from '@spa/shared';

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
 * Les deux moyens que le comptoir propose, dans l'ordre où l'écran les montre.
 *
 * Ni « lien de paiement » ni Stripe Terminal : la maquette de #30 les dessine,
 * l'API ne les sert pas. Un troisième bouton qui ne mènerait à rien coûterait
 * plus cher au comptoir que son absence.
 */
export const CHECKOUT_METHODS = ['cash', 'card'] as const satisfies readonly PaymentMethod[];

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

/**
 * Statuts sur lesquels le tunnel de paiement en ligne refuse d'ouvrir une
 * intention — `APPOINTMENT_NOT_PAYABLE`, côté API.
 *
 * `completed` et `no_show` en font partie : une fois la prestation passée, le
 * paiement en ligne n'a plus d'objet, et le CDC range l'encaissement de ces
 * cas-là au comptoir. C'est exactement l'asymétrie que documente
 * `payments.errors.ts` — le règlement en espèces, lui, les accepte.
 */
const NOT_PAYABLE_ONLINE: readonly AppointmentStatus[] = ['cancelled', 'completed', 'no_show'];

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
 * ## Quatre états, et pas un booléen
 *
 * La table `payments` porte au plus une ligne par rendez-vous
 * (`@@unique([tenantId, appointmentId])`), mais cette ligne a cinq statuts
 * possibles, et ils n'appellent pas la même conduite au comptoir :
 *
 * | Statut de la ligne | État | Ce que le comptoir peut encore faire |
 * |---|---|---|
 * | aucune ligne | `du` | encaisser, par l'un ou l'autre moyen |
 * | `succeeded`, `refunded`, `partially_refunded` | `regle` | rien — l'argent a été pris |
 * | `pending` | `ouvert` | reprendre la carte ; les espèces sont refusées en 409 |
 * | `failed` | `echoue` | reprendre la carte ; les espèces sont refusées en 409 |
 *
 * Les deux dernières lignes ne sont pas une subtilité : `replayOrRefuse` côté
 * API refuse un règlement en espèces dès qu'une intention carte existe, quel
 * que soit son sort. Un booléen « réglé ou non » aurait laissé l'écran proposer
 * les espèces sur une intention en échec — et le refus serait revenu après le
 * clic, ce que ce ticket corrige précisément.
 */
export type SettlementState =
  | { readonly kind: 'du' }
  | { readonly kind: 'regle'; readonly payment: PaymentTransaction }
  | { readonly kind: 'ouvert'; readonly payment: PaymentTransaction }
  | { readonly kind: 'echoue'; readonly payment: PaymentTransaction };

/** `true` si de l'argent a réellement été pris — la liste close du contrat. */
export function isCapturedPayment(status: PaymentStatus): boolean {
  return (CAPTURED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(status);
}

/**
 * L'état de règlement d'un rendez-vous, lu dans les encaissements de la journée.
 *
 * Le rapprochement se fait sur `appointmentId` et il est **sans ambiguïté** :
 * la contrainte d'unicité de la table n'autorise qu'une ligne par rendez-vous.
 * `find` plutôt qu'un filtre suivi d'un tri n'est donc pas un raccourci — il n'y
 * a rien à départager.
 */
export function settlementOf(
  payments: readonly PaymentTransaction[],
  appointmentId: string,
): SettlementState {
  const payment = payments.find((one) => one.appointmentId === appointmentId);

  if (payment === undefined) {
    return { kind: 'du' };
  }

  if (isCapturedPayment(payment.status)) {
    return { kind: 'regle', payment };
  }

  return payment.status === 'failed' ? { kind: 'echoue', payment } : { kind: 'ouvert', payment };
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
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string | null {
  const words = checkoutWords(locale).blocker;

  switch (settlement.kind) {
    case 'regle':
      return words.alreadySettled;
    case 'ouvert':
      return method === 'cash' ? words.cardOpenBlocksCash : null;
    case 'echoue':
      return method === 'cash' ? words.cardFailedBlocksCash : null;
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
  method: PaymentMethod,
  settlement: SettlementState = { kind: 'du' },
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string | null {
  const words = checkoutWords(locale).blocker;

  if (NOT_SETTLEABLE.includes(status)) {
    return words.cancelled;
  }

  const settled = settlementBlocker(settlement, method, locale);

  if (settled !== null) {
    return settled;
  }

  if (method === 'card' && NOT_PAYABLE_ONLINE.includes(status)) {
    return words.cardNotPayable;
  }

  return null;
}

/** `true` si au moins un moyen de paiement reste ouvert pour ce statut. */
export function isSettleable(status: AppointmentStatus): boolean {
  return CHECKOUT_METHODS.some((method) => checkoutBlocker(status, method) === null);
}

/** Le libellé du moyen de paiement, tel que le fieldset l'annonce. */
export function methodLabel(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).method;

  return method === 'cash' ? words.cash : words.card;
}

/**
 * Le même moyen, mais **dans une phrase** — « réglé par carte », « réglé en
 * espèces ».
 *
 * Deux formes plutôt qu'une parce que la première est un libellé de case à
 * cocher et la seconde un complément : « Réglé par Espèces » se lit comme une
 * chaîne concaténée, ce qu'elle est, et un bandeau d'encaissement est ce que
 * l'opérateur montre à sa cliente.
 *
 * Les deux langues portent la distinction : « en espèces » / « par carte » et
 * « in cash » / « by card ». Elle n'est donc pas une particularité du français
 * qu'on pourrait laisser tomber à la traduction.
 */
export function methodPhrase(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).method;

  return method === 'cash' ? words.cashPhrase : words.cardPhrase;
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

/**
 * Ce que le reçu peut affirmer, selon le moyen employé.
 *
 * C'est la règle la plus importante de l'écran, et elle vient de
 * payments-stripe §2 : **le navigateur n'a jamais autorité pour déclarer un
 * paiement abouti.** Une carte acceptée par Stripe l'est *auprès de Stripe* ; ce
 * qui inscrit l'encaissement chez nous est le webhook signé, reçu côté serveur,
 * et il arrive après. Le reçu carte est donc explicitement provisoire.
 *
 * Les espèces sont l'inverse : il n'y a aucun tiers dont on attende quoi que ce
 * soit, la route d'encaissement rend la ligne déjà `SUCCEEDED`, et le reçu est
 * définitif au moment où il s'imprime.
 */
export function receiptIsProvisional(method: PaymentMethod): boolean {
  return method === 'card';
}

/**
 * Ce que l'écran dit du passage en « honoré », que l'API ne sert pas encore.
 *
 * Le quatrième critère de #59 demande deux choses : confirmer l'encaissement —
 * fait — et faire passer le rendez-vous en `completed`. La seconde suppose une
 * route de transition de statut qui n'existe pas : `AppointmentsController`
 * n'expose que `GET /appointments`, `GET /appointments/mine` et
 * `POST /appointments/{id}/cancel`, et `changeAppointmentStatusRequestSchema` du
 * contrat partagé n'a aucun contrôleur en face. L'ouvrir relève d'`apps/api`,
 * hors de l'empreinte de ce ticket.
 *
 * L'écran le **dit** plutôt que de le taire, comme le planning dit que l'agenda
 * n'est pas encore servi : un encaissement qui laisse le rendez-vous en
 * `confirmed` doit s'expliquer au comptoir, faute de quoi l'opérateur cherche
 * l'erreur de son côté.
 *
 * ## Deux phrases, parce que les deux moyens ne sont pas au même point
 *
 * Sur un règlement en espèces, la ligne est inscrite et aboutie : le seul reste
 * est le statut du rendez-vous. Sur une carte, **rien n'est encore inscrit** —
 * c'est le webhook signé qui le fera —, et affirmer le contraire sous un reçu
 * que la ligne du dessus vient de déclarer provisoire contredirait la seule
 * règle que payments-stripe §2 interdit de brouiller.
 */
export function completionUnavailableMessage(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).completion;

  return receiptIsProvisional(method) ? words.card : words.cash;
}

/** La mention que le reçu porte sous son total, selon le moyen employé. */
export function receiptDisclaimer(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale).receipt;

  return receiptIsProvisional(method) ? words.provisionalDisclaimer : words.cashDisclaimer;
}

/**
 * La mention d'un reçu **réimprimé** depuis un encaissement déjà inscrit (#828).
 *
 * Elle diffère de la précédente sur le seul cas qui compte, et l'écart n'est pas
 * cosmétique : un reçu carte imprimé juste après la confirmation du navigateur
 * est provisoire — le webhook signé n'a pas encore inscrit la capture —, tandis
 * qu'un reçu réimprimé depuis une ligne `succeeded` relue de l'historique est
 * **définitif**, puisque c'est précisément le webhook qui a écrit cette ligne
 * (payments-stripe §2). Réutiliser la mention provisoire ferait dire à l'écran
 * qu'il ne sait pas ce qu'il vient de lire en base.
 */
export function settledReceiptDisclaimer(
  method: PaymentMethod,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  return method === 'card'
    ? checkoutWords(locale).receipt.settledCardDisclaimer
    : receiptDisclaimer('cash', locale);
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
