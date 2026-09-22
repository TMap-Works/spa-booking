'use client';

import type { AppointmentFeedEvent, TimeZone } from '@spa/shared';
import { usePathname } from 'next/navigation';

import { useAppointmentFeed } from '@/components/live/appointment-feed';
import { calendarDateInTimeZone } from '@/lib/booking/calendar';
import { formatDateTimeInTimeZone } from '@/lib/format';

import { adminCalendarPath, adminMyPlanningPath } from '../paths';
import { useAdminAnnouncement, type AdminAnnouncementKind } from './admin-announcement';

interface AdminLiveAnnouncementsProps {
  readonly tenantSlug: string;
  /** Fuseau du salon — `null` quand la vitrine n'a pas répondu : rien ne s'annonce. */
  readonly timeZone: TimeZone | null;
  /**
   * `true` quand le compte lit l'agenda de tout le salon : le lien mène au
   * planning du salon. Sinon, à « Mon planning » — le praticien n'a pas accès à
   * l'autre, et le flux ne lui annonce de toute façon que ses rendez-vous.
   */
  readonly readsEstablishmentAgenda: boolean;
}

/**
 * Ce que le planning temps réel annonce au back-office — sans rien afficher
 * lui-même : il écrit dans la région d'annonce du layout (`admin-announcement.tsx`).
 *
 * Deux faits seulement, ceux qui arrivent **sans** que l'équipe les ait faits et
 * qui appellent un geste :
 *
 * - une réservation vient d'arriver — elle attend d'être confirmée ;
 * - une cliente vient d'annuler — le créneau est libre, et quelqu'un attendait
 *   peut-être à l'accueil.
 *
 * Le reste — une confirmation, un report, un « honoré » posé par une collègue —
 * se voit sur le planning qui se relit, sans bandeau : l'annoncer à chaque fois
 * ferait d'un écran ouvert toute la journée un fil de notifications.
 */
export function AdminLiveAnnouncements({
  tenantSlug,
  timeZone,
  readsEstablishmentAgenda,
}: AdminLiveAnnouncementsProps) {
  const announce = useAdminAnnouncement();
  const path = usePathname();

  useAppointmentFeed((notice) => {
    if (notice.kind !== 'change' || timeZone === null) {
      return;
    }

    const { event } = notice;
    const kind = announcedKind(event);

    if (kind === null || event.startsAt === undefined) {
      return;
    }

    const date = calendarDateInTimeZone(new Date(event.startsAt), timeZone);

    announce({
      kind,
      subject: formatDateTimeInTimeZone(event.startsAt, timeZone),
      path,
      href: readsEstablishmentAgenda
        ? adminCalendarPath(tenantSlug, { date })
        : adminMyPlanningPath(tenantSlug, { date }),
    });
  });

  return null;
}

function announcedKind(
  event: AppointmentFeedEvent,
): Extract<AdminAnnouncementKind, 'appointment-booked' | 'appointment-cancelled'> | null {
  if (event.change === 'created') {
    return 'appointment-booked';
  }

  if (event.change === 'cancelled' && event.cancelledBy === 'client') {
    return 'appointment-cancelled';
  }

  return null;
}
