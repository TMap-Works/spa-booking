'use client';

import type { AppointmentFeedEvent, TimeZone } from '@spa/shared';
import { usePathname } from 'next/navigation';

import { useAppointmentFeed } from '@/components/live/appointment-feed';
import { formatDateTimeInTimeZone } from '@/lib/format';

import { accountPath } from '../paths';
import { useAccountAnnouncement, type AccountAnnouncementRequest } from './account-announcement';

interface AccountLiveAnnouncementsProps {
  readonly tenantSlug: string;
  /** Fuseau du salon : les heures s'annoncent dedans, comme partout. */
  readonly timeZone: TimeZone;
}

/**
 * Ce que le temps réel annonce à la cliente — dans la région d'annonce du
 * layout, sans rien afficher lui-même.
 *
 * Les gestes **du salon** sur ses rendez-vous : une confirmation, une
 * annulation, un déplacement. Ses propres gestes s'annoncent déjà depuis les
 * écrans où elle les fait (`cancel-appointment-control.tsx`,
 * `reschedule-form.tsx`) ; les annoncer une seconde fois d'ici les ferait lire
 * deux fois.
 *
 * ## Le report, cas à part
 *
 * Le flux ne dit pas qui a déplacé le rendez-vous. L'annonce reprend donc
 * **exactement** celle du formulaire de report — même type, même heure, même
 * écran d'arrivée, la liste — : quand c'est la cliente qui vient de le faire,
 * les deux demandes sont identiques et ne se lisent qu'une fois ; quand c'est le
 * salon, elle apprend la nouvelle heure.
 */
export function AccountLiveAnnouncements({ tenantSlug, timeZone }: AccountLiveAnnouncementsProps) {
  const announce = useAccountAnnouncement();
  const path = usePathname();

  useAppointmentFeed((notice) => {
    if (notice.kind !== 'change') {
      return;
    }

    const request = announcementFor(notice.event, {
      timeZone,
      currentPath: path,
      listPath: accountPath(tenantSlug),
    });

    if (request !== null) {
      announce(request);
    }
  });

  return null;
}

/** La demande d'annonce d'un changement, ou `null` s'il ne s'annonce pas ici. */
export function announcementFor(
  event: AppointmentFeedEvent,
  context: { readonly timeZone: TimeZone; readonly currentPath: string; readonly listPath: string },
): AccountAnnouncementRequest | null {
  const when =
    event.startsAt === undefined ? '' : formatDateTimeInTimeZone(event.startsAt, context.timeZone);

  switch (event.change) {
    case 'confirmed':
      return { kind: 'salon-confirmed', when, path: context.currentPath };
    case 'cancelled':
      // Annulé par elle : son propre écran l'a déjà dit.
      return event.cancelledBy === 'client' || when === ''
        ? null
        : { kind: 'salon-cancelled', when, path: context.currentPath };
    case 'rescheduled':
      return when === '' ? null : { kind: 'appointment-rescheduled', when, path: context.listPath };
    default:
      return null;
  }
}
