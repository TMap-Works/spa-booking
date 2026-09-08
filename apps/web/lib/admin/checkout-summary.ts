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
 */

import type { Appointment, AppointmentStatus, Money, PaymentMethod } from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';

import type {
  CreateSaleRequest,
  SaleLineRequest,
  SaleSummary,
} from '@/lib/admin/payment-contract';

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

/**
 * Pourquoi ce moyen de paiement est fermé pour ce rendez-vous — `null` s'il est
 * ouvert.
 *
 * Le message s'adresse à l'opérateur devant sa cliente : il dit ce qui bloque
 * **et** ce qu'il reste à faire. Une case grisée sans explication renvoie la
 * question au support.
 */
export function checkoutBlocker(
  status: AppointmentStatus,
  method: PaymentMethod,
): string | null {
  if (NOT_SETTLEABLE.includes(status)) {
    return 'Ce rendez-vous est annulé : le créneau a été rendu, il n’y a plus de prestation à encaisser.';
  }

  if (method === 'card' && NOT_PAYABLE_ONLINE.includes(status)) {
    return 'Le paiement par carte n’accepte pas un rendez-vous déjà terminé ou non honoré. Encaissez en espèces, ou par le lecteur du comptoir.';
  }

  return null;
}

/** `true` si au moins un moyen de paiement reste ouvert pour ce statut. */
export function isSettleable(status: AppointmentStatus): boolean {
  return CHECKOUT_METHODS.some((method) => checkoutBlocker(status, method) === null);
}

/** Le libellé du moyen de paiement, tel que le fieldset l'annonce. */
export function methodLabel(method: PaymentMethod): string {
  return method === 'cash' ? 'Espèces' : 'Carte';
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
export function methodHint(method: PaymentMethod): string {
  return method === 'cash'
    ? 'Enregistré avec l’opérateur et l’horodatage ; la caisse fait foi au rapprochement. Aucun appel au prestataire.'
    : 'La cliente saisit sa carte dans les champs servis par Stripe. Aucun numéro n’est saisi, ni vu, ni conservé par le salon.';
}

/**
 * Codes de refus que l'API d'encaissement émet et que cet écran sait nommer.
 *
 * Ils viennent de `apps/api/src/modules/payments/payments.errors.ts` et ne sont
 * **pas** encore dans `@spa/shared` — `PAYMENT_ERROR_CODES` du contrat n'en
 * porte aucun. Ils sont donc écrits en clair ici, comme le fait déjà
 * `calendar-failure.ts` pour le 404 de l'agenda. C'est aussi la raison pour
 * laquelle `ApiClientError.code` est un `string` et non un `ErrorCode`.
 *
 * TODO(#536) : les rapatrier n'est pas un import mais le découpage par module de
 * la famille de codes du contrat, que #510 a instruit dans les six fichiers
 * `*.errors.ts` d'`apps/api` sans pouvoir le trancher depuis eux. Le jour où
 * `PAYMENT_ERROR_CODES` existe côté contrat, ces quatre constantes disparaissent
 * et `ApiClientError.code` peut redevenir un `ErrorCode`.
 */
const APPOINTMENT_NOT_PAYABLE = 'APPOINTMENT_NOT_PAYABLE';
const APPOINTMENT_NOT_SETTLEABLE = 'APPOINTMENT_NOT_SETTLEABLE';
const PAYMENT_ALREADY_SETTLED = 'PAYMENT_ALREADY_SETTLED';
const PAYMENT_PROVIDER_UNAVAILABLE = 'PAYMENT_PROVIDER_UNAVAILABLE';

/**
 * Ce que le comptoir lit quand rien n'a répondu — quel que soit le maillon.
 *
 * Un seul texte pour les trois cas qui se ressemblent du point de vue de
 * l'opérateur : Stripe muet côté API, l'action serveur injoignable, ou
 * `confirmPayment` qui échoue dans le navigateur. Ils appellent la même conduite
 * — réessayer, ou encaisser en espèces —, et deux formulations différentes pour
 * un même incident feraient croire à deux incidents.
 */
export const PROVIDER_UNREACHABLE_MESSAGE =
  'Le prestataire de paiement n’a pas répondu. Rien n’a été débité : réessayez, ou encaissez en espèces.';

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
export function checkoutFailureMessage(code: string, message: string): string {
  switch (code) {
    case PAYMENT_ALREADY_SETTLED:
    case ERROR_CODES.PAYMENT_ALREADY_CAPTURED:
    case ERROR_CODES.CONFLICT:
      return 'Ce rendez-vous a déjà été encaissé. Rechargez l’écran avant de reprendre — un second règlement créerait une pièce comptable de trop.';
    case APPOINTMENT_NOT_PAYABLE:
      return 'Le paiement par carte n’accepte pas ce rendez-vous : il est annulé, terminé ou non honoré. Encaissez en espèces si la prestation a été rendue.';
    case APPOINTMENT_NOT_SETTLEABLE:
      return 'Ce rendez-vous est annulé : il n’y a plus de prestation à encaisser.';
    case PAYMENT_PROVIDER_UNAVAILABLE:
    case ERROR_CODES.PAYMENT_PROVIDER_ERROR:
    case ERROR_CODES.SERVICE_UNAVAILABLE:
      return PROVIDER_UNREACHABLE_MESSAGE;
    case ERROR_CODES.TOO_MANY_REQUESTS:
    case 'HTTP_429':
      return 'Trop d’ouvertures de paiement en peu de temps. Patientez quelques secondes avant de réessayer.';
    case ERROR_CODES.NOT_FOUND:
    case 'HTTP_404':
      return 'Ce rendez-vous est introuvable dans cet établissement.';
    case ERROR_CODES.FORBIDDEN:
      return 'Votre compte n’a pas le droit d’encaisser. Demandez l’accès à l’administrateur du salon.';
    default:
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
export function completionUnavailableMessage(method: PaymentMethod): string {
  return receiptIsProvisional(method)
    ? 'Le passage du rendez-vous en « honoré » n’est pas encore servi par l’API : le statut suivra la confirmation du webhook, sans rien à reprendre ici.'
    : 'Le passage du rendez-vous en « honoré » n’est pas encore servi par l’API : l’encaissement est bien inscrit, le statut du rendez-vous suivra sans rien à reprendre ici.';
}

/** La mention que le reçu porte sous son total, selon le moyen employé. */
export function receiptDisclaimer(method: PaymentMethod): string {
  return receiptIsProvisional(method)
    ? 'La confirmation définitive est inscrite par le webhook signé, côté serveur : ce reçu vaut preuve de passage, pas de capture.'
    : 'Règlement en espèces inscrit et horodaté. C’est la caisse qui fait foi au rapprochement.';
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
export function saleTotalRows(sale: SaleSummary): readonly SaleTotalRow[] {
  return [
    { label: 'Sous-total', amount: sale.subtotal, isGrand: false },
    ...(sale.tax.amountMinor === 0
      ? []
      : [{ label: 'Taxe', amount: sale.tax, isGrand: false }]),
    ...(sale.tip.amountMinor === 0
      ? []
      : [{ label: 'Pourboire', amount: sale.tip, isGrand: false }]),
    { label: 'Total', amount: sale.total, isGrand: true },
  ];
}

/**
 * Codes de refus de la caisse, tels que `payments.errors.ts` les émet.
 *
 * Écrits en clair pour la même raison que ceux de l'encaissement quelques
 * centaines de lignes plus haut : `PAYMENT_ERROR_CODES` vit dans `apps/api`, et
 * le rapatrier suppose de découper par module la famille de codes du contrat —
 * TODO(#536), instruit en tête de cette section.
 */
const SALE_ITEM_UNAVAILABLE = 'SALE_ITEM_UNAVAILABLE';
const SALE_CURRENCY_MISMATCH = 'SALE_CURRENCY_MISMATCH';
const SALE_AMOUNT_OUT_OF_RANGE = 'SALE_AMOUNT_OUT_OF_RANGE';
const HISTORY_WINDOW_INVALID = 'HISTORY_WINDOW_INVALID';

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
export function saleFailureMessage(code: string, message: string): string {
  switch (code) {
    case SALE_ITEM_UNAVAILABLE:
      return 'Un article du ticket n’est plus au rayon. Retirez-le et rechargez le catalogue avant de reprendre.';
    case SALE_CURRENCY_MISMATCH:
    case ERROR_CODES.CURRENCY_MISMATCH:
      return 'Un article du ticket est libellé dans une autre devise que celle du salon. Il n’est pas vendable ici : retirez-le du ticket.';
    case SALE_AMOUNT_OUT_OF_RANGE:
      return 'Le total dépasse ce qu’un ticket peut porter. Réduisez les quantités, ou composez plusieurs tickets.';
    case HISTORY_WINDOW_INVALID:
      return 'La période demandée est vide : la fin doit suivre le début.';
    case ERROR_CODES.VALIDATION_ERROR:
      return 'Le ticket a été refusé : une ligne est incomplète ou hors bornes. Vérifiez les quantités avant de réessayer.';
    case ERROR_CODES.NOT_FOUND:
    case 'HTTP_404':
      return 'Une prestation ou un article du ticket est introuvable dans cet établissement.';
    case ERROR_CODES.FORBIDDEN:
      return 'Votre compte n’a pas le droit de tenir la caisse. Demandez l’accès à l’administrateur du salon.';
    case ERROR_CODES.SERVICE_UNAVAILABLE:
      return 'La caisse est momentanément injoignable. Le ticket n’a pas été enregistré : réessayez dans un instant.';
    default:
      return message;
  }
}
