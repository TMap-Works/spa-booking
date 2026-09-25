'use client';

import type { AppointmentFeedEvent, TimeZone } from '@spa/shared';
import { useLocale } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

import { useAppointmentFeed } from '@/components/live/appointment-feed';
import { calendarDateInTimeZone } from '@/lib/booking/calendar';
import { formatDateTimeInTimeZone, type DisplayLocale } from '@/lib/format';

import { adminCalendarPath, adminMyPlanningPath } from '../paths';
import { useAdminAnnouncement, type AdminAnnouncementKind } from './admin-announcement';

interface AdminLiveAnnouncementsProps {
  readonly tenantSlug: string;
  /** Fuseau du salon — `null` quand la vitrine n'a pas répondu : rien ne s'annonce. */
  readonly timeZone: TimeZone | null;
  /**
   * Le pays de l'établissement (`AdminShell.countryCode`, lu sur l'adresse de la
   * fiche publique) — la **région** de la mise en forme, jamais le fuseau
   * (#1275). `null` quand le salon n'a pas publié d'adresse : `lib/format.ts` se
   * rabat alors sur sa région documentée, `fr` → `fr-FR`, `en` → `en-US`.
   */
  readonly countryCode: string | null;
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
 *
 * ## Le sujet est mis en forme dans la langue du bandeau (#1275)
 *
 * Les deux motifs insèrent un **jour et une heure** dans leur phrase. La phrase
 * vient du catalogue et suit la langue de la session depuis #1192 ; le sujet,
 * lui, était mis en forme sans contexte d'affichage — `lib/format.ts` se rabat
 * alors sur le français, et une session anglaise lisait « New appointment :
 * jeudi 2 octobre à 14:00 », une phrase anglaise et une date française dans le
 * même bandeau.
 *
 * La langue se lit ici (`useLocale`) ; la région, elle, ne peut pas : elle vient
 * de la fiche publique du salon, que seul le layout a chargée — d'où la
 * propriété `countryCode`, descendue du shell. Le **fuseau** reste celui de
 * l'établissement et ne dépend d'aucune des deux.
 */
export function AdminLiveAnnouncements({
  tenantSlug,
  timeZone,
  countryCode,
  readsEstablishmentAgenda,
}: AdminLiveAnnouncementsProps) {
  const announce = useAdminAnnouncement();
  const locale = useLocale();
  const path = usePathname();
  // Mémoïsé comme ailleurs dans le back-office (`calendar-board.tsx`), pour que
  // le contexte d'affichage garde son identité d'un rendu à l'autre. Rien n'en
  // dépend ici — `useAppointmentFeed` garde l'écouteur dans une référence et ne
  // se réabonne pas —, mais c'est la forme que prendra le premier appelant qui
  // le mettra en dépendance.
  const display: DisplayLocale = useMemo(() => ({ locale, countryCode }), [locale, countryCode]);

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
      subject: formatDateTimeInTimeZone(event.startsAt, timeZone, display),
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
