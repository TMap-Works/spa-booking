import { MY_APPOINTMENTS_MAX_LIMIT, uuidSchema } from '@spa/shared';
import { notFound } from 'next/navigation';

import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import { fetchAvailability, fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';

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
 * ## La fenêtre de créneaux part d'aujourd'hui, dans le fuseau du salon
 *
 * Une date civile n'est pas un instant : « aujourd'hui » n'est pas la même
 * journée à Antananarivo et à Papeete. La borne se calcule donc avec le fuseau de
 * l'établissement, comme dans le tunnel.
 */

export const dynamic = 'force-dynamic';

/**
 * Profondeur de la fenêtre proposée, en journées civiles.
 *
 * Quatorze plutôt que les trente et un que l'API tolère : c'est l'horizon sur
 * lequel une cliente déplace réellement un rendez-vous, et une fenêtre plus large
 * ferait scruter au moteur de disponibilité un mois d'agenda pour des créneaux
 * que personne ne fait défiler.
 */
const RESCHEDULE_WINDOW_DAYS = 14;

interface ReschedulePageProps {
  readonly params: Promise<{
    readonly tenantSlug: string;
    readonly appointmentId: string;
  }>;
}

export default async function ReschedulePage({ params }: ReschedulePageProps) {
  const { tenantSlug, appointmentId } = await params;

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
    readAccountData(tenantSlug, here, async (accessToken) =>
      fetchMyAppointments(accessToken, { scope: 'upcoming', limit: MY_APPOINTMENTS_MAX_LIMIT }),
    ),
  ]);

  const appointment = upcoming.find((candidate) => candidate.id === id.data);
  if (appointment === undefined) {
    notFound();
  }

  const from = calendarDateInTimeZone(new Date(), tenant.timezone);

  const availability = await fetchAvailability(tenantSlug, {
    serviceId: appointment.serviceId,
    // Le même praticien : reporter ne change pas de praticien de lui-même, cela
    // déplacerait une cliente chez quelqu'un qu'elle n'a pas choisi.
    staffId: appointment.staffId,
    from,
    to: addCalendarDays(from, RESCHEDULE_WINDOW_DAYS),
  });

  return (
    <RescheduleForm
      tenantSlug={tenantSlug}
      appointmentId={appointment.id}
      currentStartsAt={appointment.startsAt}
      serviceName={services.find((service) => service.id === appointment.serviceId)?.name ?? null}
      availability={availability}
      timeZone={tenant.timezone}
    />
  );
}
