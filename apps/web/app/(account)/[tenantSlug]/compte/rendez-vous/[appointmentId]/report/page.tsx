import { MY_APPOINTMENTS_MAX_LIMIT, uuidSchema } from '@spa/shared';
import { notFound } from 'next/navigation';

import { calendarDateInTimeZone } from '@/lib/booking/calendar';
import { bookingWindow, isNavigableMonth, monthOf, monthRange } from '@/lib/booking/month-grid';
import { fetchAvailability, fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

import { RescheduleForm } from '../../../components/reschedule-form';
import { accountPath } from '../../../paths';
import { readAccountData } from '../../../session';
import { accountTenant } from '../../../tenant';

/**
 * Report d'un rendez-vous depuis l'espace client (#47, troisième critère).
 *
 * ## Le rendez-vous est retrouvé dans l'historique, jamais lu par identifiant
 *
 * Il n'existe pas de `GET /appointments/:id` — et il n'en faut pas un pour cet
 * écran. La liste « à venir » est déjà bornée à la cliente du jeton et à son
 * établissement : y chercher l'identifiant demandé rend impossible, par
 * construction, d'ouvrir cet écran sur le rendez-vous de quelqu'un d'autre. Un
 * identifiant absent de cette liste rend **404**, qu'il désigne un rendez-vous
 * inexistant, celui d'une autre cliente, ou l'un des siens déjà passé — les
 * trois doivent être indiscernables (tenant-isolation §4).
 *
 * Ce 404-là est rendu par `not-found.tsx`, posé à côté de cette page (#627) :
 * sans lui, l'appel remontait jusqu'au 404 des adresses publiques, qui renvoie la
 * cliente vers « le lien que le salon vous a communiqué » — alors qu'elle est
 * dans son propre espace — et qui ne porte aucun lien de retour.
 *
 * ## La fenêtre de créneaux part d'aujourd'hui, dans le fuseau du salon
 *
 * Une date civile n'est pas un instant : « aujourd'hui » n'est pas la même
 * journée à Antananarivo et à Papeete. La borne se calcule donc avec le fuseau de
 * l'établissement, comme dans le tunnel.
 *
 * ## Le rendez-vous déplacé ne s'occupe pas lui-même (#442)
 *
 * C'est le seul écran du produit qui interroge le calendrier **en sachant qu'un
 * rendez-vous va disparaître**. Sans le dire, il se voit refuser tous les
 * créneaux qui chevauchent celui qu'il déplace : un soin d'une heure ne peut plus
 * bouger de moins d'une heure, alors que c'est le report le plus courant. La
 * réponse à cette question-là n'est vraie que pour cette cliente et pour ce
 * geste, et l'API l'écarte donc de son cache — voir le README du module
 * `availability`.
 *
 * ## … et elle suit le mois qu'on regarde (#738, #827)
 *
 * Le choix de la date est devenu un **calendrier mensuel** : la fenêtre de
 * créneaux n'est plus une profondeur en journées qu'on élargit, c'est le mois
 * affiché, rogné à aujourd'hui d'un côté et à la fin de la fenêtre de
 * réservation de l'autre. Un mois civil ne dépasse jamais les trente et un jours
 * que `availabilityQuerySchema` plafonne.
 *
 * Le mois passe par l'**adresse** et non par un état de composant, pour la même
 * raison que « Voir plus de jours » le faisait : c'est le serveur qui lit le
 * calendrier, et c'est donc lui qu'il faut reposer la question. L'adresse a de
 * surcroît le mérite de survivre au rafraîchissement et de se partager — un
 * `useState` aurait ramené la visiteuse au mois courant au premier F5.
 */

export const dynamic = 'force-dynamic';

/**
 * Le paramètre par lequel l'écran retient le mois regardé, `YYYY-MM`.
 *
 * Il remplace le `?jours=31` de la fenêtre élargie (#738), qui n'a plus d'objet :
 * on ne creuse plus une profondeur, on tourne une page de calendrier.
 */
const MONTH_PARAM = 'mois';

/**
 * La forme d'un mois dans l'adresse — tout le reste retombe sur le mois courant.
 *
 * Le quantième de mois est borné à `01`–`12` et non laissé à `\d{2}` : la
 * comparaison de `isNavigableMonth` est lexicographique, si bien qu'un
 * `?mois=2026-99` tombe entre « 2026-12 » et « 2027-01 » dès que la fenêtre
 * franchit le nouvel an. Il serait alors déclaré atteignable, et la requête
 * partirait avec un `from` de « 2026-99-01 » que `calendarDateSchema` refuse —
 * une page d'erreur au lieu du repli qu'on vient d'écrire.
 */
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

interface ReschedulePageProps {
  readonly params: Promise<{
    readonly tenantSlug: string;
    readonly appointmentId: string;
  }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReschedulePage({ params, searchParams }: ReschedulePageProps) {
  const { tenantSlug, appointmentId } = await params;
  const query = await searchParams;

  /**
   * Le mois demandé par l'adresse, tel qu'il s'écrit — validé plus bas contre la
   * fenêtre de réservation, une fois le fuseau du salon connu.
   *
   * Le paramètre vient du visiteur : un `?mois=jamais` ou un `?mois=1970-01`
   * demanderait au moteur de disponibilité une plage qu'il refuserait par un 400
   * que cet écran rendrait en page d'erreur. Tout ce qui n'est pas atteignable
   * retombe donc sur le mois courant.
   */
  const requestedMonth = query[MONTH_PARAM];
  const askedMonth =
    typeof requestedMonth === 'string' && MONTH_PATTERN.test(requestedMonth)
      ? requestedMonth
      : null;

  const id = uuidSchema.safeParse(appointmentId);
  if (!id.success) {
    // Un identifiant mal formé ne désigne aucun rendez-vous : inutile d'ouvrir
    // une session pour le constater.
    notFound();
  }

  const here = accountPath(tenantSlug, `/rendez-vous/${id.data}/report`);

  const [tenant, services, upcoming] = await Promise.all([
    accountTenant(tenantSlug),
    fetchPublicServices(tenantSlug),
    readAccountData(
      tenantSlug,
      here,
      async (accessToken) =>
        fetchMyAppointments(accessToken, { scope: 'upcoming', limit: MY_APPOINTMENTS_MAX_LIMIT }),
      // Le marqueur de renouvellement, s'il est là : c'est ce qui borne la
      // tentative à une seule et empêche la chaîne de redirections (#861).
      isRenewalReturn(query[RENEWAL_PARAM]),
    ),
  ]);

  const appointment = upcoming.find((candidate) => candidate.id === id.data);
  if (appointment === undefined) {
    notFound();
  }

  const today = calendarDateInTimeZone(new Date(), tenant.timezone);
  const bounds = bookingWindow(today);
  // Un mois hors de la fenêtre de réservation n'est pas une erreur de la
  // visiteuse : c'est une adresse d'hier, ou trafiquée. On la ramène au mois
  // courant plutôt que de rendre une page d'erreur.
  const month =
    askedMonth !== null && isNavigableMonth(askedMonth, bounds) ? askedMonth : monthOf(today);
  // Non `null` par construction : `month` est atteignable, donc il coupe la
  // fenêtre. Le repli n'existe que pour le compilateur.
  const range = monthRange(month, bounds) ?? { from: today, to: today };

  const availability = await fetchAvailability(tenantSlug, {
    serviceId: appointment.serviceId,
    // Le même praticien : reporter ne change pas de praticien de lui-même, cela
    // déplacerait une cliente chez quelqu'un qu'elle n'a pas choisi.
    staffId: appointment.staffId,
    from: range.from,
    to: range.to,
    // Le rendez-vous en cours de déplacement n'a pas à se barrer la route : c'est
    // lui qu'on libère. Sans cette exclusion, un soin d'une heure ne pourrait
    // jamais être décalé de moins d'une heure.
    excludeAppointmentId: appointment.id,
  });

  return (
    <RescheduleForm
      tenantSlug={tenantSlug}
      appointmentId={appointment.id}
      currentStartsAt={appointment.startsAt}
      serviceName={services.find((service) => service.id === appointment.serviceId)?.name ?? null}
      availability={availability}
      timeZone={tenant.timezone}
      month={month}
      bounds={bounds}
      // Changer de mois repose la question au serveur : c'est lui qui lit le
      // calendrier. Le formulaire construit l'adresse à partir de ce gabarit
      // plutôt que de connaître la route qui le rend.
      monthHref={`${here}?${MONTH_PARAM}=`}
    />
  );
}
