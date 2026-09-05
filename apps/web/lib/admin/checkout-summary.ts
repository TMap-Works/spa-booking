/**
 * Ce que l'écran d'encaissement sait dire **sans appeler personne** (#59).
 *
 * Toute la logique de présentation du comptoir est ici, en fonctions pures :
 * quel moyen de paiement est ouvert pour ce rendez-vous, pourquoi l'autre ne
 * l'est pas, et comment se lit un refus de l'API. Le composant n'en garde que le
 * rendu — c'est ce qui rend ces règles vérifiables sans monter React, et c'est
 * là qu'elles sont testées.
 *
 * ## Aucun calcul de montant, jamais
 *
 * Ce module ne fait aucune arithmétique monétaire. Le montant dû est le prix
 * **figé à la réservation**, relu tel quel du rendez-vous, et le total qui fait
 * foi est celui que le serveur recalcule (payments-stripe §4 et §5). Un front
 * qui additionnerait des lignes finirait par afficher un total que la caisse ne
 * confirme pas.
 */

import type { Appointment, AppointmentStatus, Money, PaymentMethod } from '@spa/shared';
import { ERROR_CODES } from '@spa/shared';

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
 * `calendar-failure.ts` pour le 404 de l'agenda, et rejoindront le contrat avec
 * le reste des DTO (TODO(#26)). C'est aussi la raison pour laquelle
 * `ApiClientError.code` est un `string` et non un `ErrorCode`.
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
