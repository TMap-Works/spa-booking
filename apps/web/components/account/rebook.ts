import type { BookedAppointment, PublicService } from '@spa/shared';

import { serviceBookingHref } from '@/components/salon/booking-link';
import { BOOKING_QUERY_KEYS } from '@/lib/booking/draft';

/**
 * « Réserver à nouveau » — l'adresse qui rouvre le tunnel sur la prestation et
 * le praticien d'un rendez-vous passé (#1054, BM-HISTO-02).
 *
 * ## Pourquoi un module à part
 *
 * Il lit `BOOKING_QUERY_KEYS`, le registre de clés du tunnel, qui vit dans un
 * module portant les schémas Zod du brouillon. Le poser dans
 * `appointment-history.ts` — qui, lui, part dans le bundle du navigateur, le
 * filtre étant côté client — y aurait fait entrer Zod et les schémas partagés
 * pour trois concaténations de chaîne. Le lien est calculé **une fois, par le
 * serveur**, et la ligne n'en reçoit qu'une chaîne.
 *
 * ## Ce qu'il ne réécrit pas
 *
 * L'étape d'arrivée et la clé de prestation viennent de `serviceBookingHref`
 * (`components/salon/booking-link.ts`), déjà le point d'écriture unique de
 * « comment on ouvre le tunnel sur une prestation » pour la vitrine (#1046).
 * Réécrire ici `?etape=creneau&prestation=…` aurait produit la divergence que ce
 * module existe pour empêcher — la vitrine et l'historique retombant sur deux
 * étapes différentes au premier renommage. Ce module n'ajoute que le praticien,
 * que la vitrine n'a pas à connaître.
 */

/**
 * Les rendez-vous sur lesquels « Réserver à nouveau » est proposé.
 *
 * Un rendez-vous honoré : c'est le motif même de `BM-HISTO-02`, « la cliente
 * refait la même prestation ». Un rendez-vous **réellement annulé** : elle
 * voulait cette prestation et ne l'a pas eue, la reproposer est le geste
 * évident.
 *
 * Le prédicat regarde donc l'auteur de l'annulation et pas seulement le statut.
 * Un `cancelled` **sans auteur** n'est pas une annulation : c'est la ligne
 * d'origine d'un report, que l'espace client nomme « Déplacé »
 * (`lib/appointment-status.ts`) et dont le rendez-vous existe toujours, à une
 * autre heure. La ligne d'historique lui écrit déjà « Ce créneau a été libéré au
 * profit d'un autre rendez-vous » — lui proposer d'en reprendre un second dans
 * la foulée contredirait cette phrase et ferait doubler la réservation.
 *
 * Les trois autres cas de l'historique se taisent, et c'est délibéré. Un
 * `confirmed` ou un `pending` dont l'heure est passée attend encore que le salon
 * tranche — proposer d'en reprendre un second laisserait croire que le premier
 * est perdu. Un `no_show` est un rendez-vous manqué que le salon a constaté :
 * relancer la cliente dessus depuis son propre espace serait le lui reprocher.
 */
export function isRebookable(
  appointment: Pick<BookedAppointment, 'status' | 'cancelledBy'>,
): boolean {
  if (appointment.status === 'completed') {
    return true;
  }

  return appointment.status === 'cancelled' && (appointment.cancelledBy ?? null) !== null;
}

/**
 * Le lien de reprise, ou `null` quand il n'y a rien à rouvrir.
 *
 * `null` dans trois cas, et chacun est une promesse qu'on ne pourrait pas
 * tenir :
 *
 * - le rendez-vous ne s'y prête pas (voir `isRebookable`) ;
 * - la prestation ne figure plus au catalogue public — retirée ou désactivée
 *   depuis —, si bien que le tunnel ramènerait d'office à l'étape « prestation »
 *   (`reachableStep`) après avoir promis un créneau ;
 * - plus aucun praticien ne la tient : elle n'offre aucun créneau, exactement le
 *   cas où la vitrine elle-même n'affiche pas de lien (`service-catalog.tsx`).
 *
 * Le praticien du rendez-vous n'est passé que s'il tient **encore** cette
 * prestation. Sinon le lien s'en tient à la prestation, et le tunnel ouvre sur
 * « premier disponible » (CDC §1.4) — plutôt qu'un identifiant que le sélecteur
 * ne saurait plus nommer.
 */
export function rebookHref(
  bookingPath: string,
  appointment: Pick<BookedAppointment, 'serviceId' | 'staffId' | 'status' | 'cancelledBy'>,
  services: readonly PublicService[],
): string | null {
  if (!isRebookable(appointment)) {
    return null;
  }

  const service = services.find((candidate) => candidate.id === appointment.serviceId) ?? null;

  if (service === null || service.staff.length === 0) {
    return null;
  }

  const href = serviceBookingHref(bookingPath, service.id);
  const staff = service.staff.find((member) => member.id === appointment.staffId) ?? null;

  if (staff === null) {
    return href;
  }

  // `serviceBookingHref` pose toujours deux paramètres, donc toujours un `?` :
  // le praticien s'ajoute derrière sans avoir à redécouper l'adresse.
  const praticien = new URLSearchParams([[BOOKING_QUERY_KEYS.staff, staff.id]]);

  return `${href}&${praticien.toString()}`;
}
