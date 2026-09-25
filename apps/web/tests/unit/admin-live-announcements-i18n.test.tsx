import type { AppointmentFeedEvent, Locale, TimeZone, UtcInstant } from '@spa/shared';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import {
  AdminAnnouncementProvider,
  AdminAnnouncementRegion,
} from '@/app/(admin)/[tenantSlug]/admin/components/admin-announcement';
import { AdminLiveAnnouncements } from '@/app/(admin)/[tenantSlug]/admin/components/admin-live-announcements';
import type { AppointmentFeedNotice } from '@/components/live/appointment-feed';

/**
 * Le sujet des deux annonces du planning temps réel suit la langue de la
 * session — #1275.
 *
 * ## Ce qui n'allait pas
 *
 * #1192 a porté les trois motifs de la région d'annonce au catalogue : les
 * **phrases** suivent depuis la langue de la session. Le **sujet** qu'elles
 * insèrent, non — pour les deux motifs du temps réel, c'est un jour et une
 * heure, et `formatDateTimeInTimeZone` était appelé sans son `DisplayLocale`.
 * `lib/format.ts` se rabat alors sur le français, et une session anglaise lisait
 * « New appointment: vendredi 2 octobre 2026 à 14:00 » — une phrase anglaise et
 * une date française dans le même bandeau.
 *
 * ## Ce que cette suite éprouve, et pourquoi ainsi
 *
 * Le **même** composant rendu dans les deux langues, sur le même événement de
 * flux : c'est le troisième critère d'acceptation, et la seule forme qui
 * distingue « la date est en anglais » de « la suite est écrite en anglais ».
 * D'où la langue mobile de `tests/support/langue-mobile.ts` — l'amorce des
 * suites fixe `fr` pour toutes, et un `NextIntlClientProvider` posé autour du
 * rendu n'y changerait rien.
 *
 * Les attendus sont construits par un `Intl.DateTimeFormat` **explicite**, dont
 * l'étiquette est écrite en toutes lettres dans le test (`fr-FR`, `en-FR`,
 * `en-US`). Rappeler `formatDateTimeInTimeZone` pour bâtir l'attendu aurait rendu
 * la suite verte quelle que soit la langue passée — c'est-à-dire verte sur le
 * défaut qu'elle protège.
 *
 * La région de mise en forme est éprouvée pour elle-même : « en » sans pays
 * s'écrit `en-US` (« October 2, 2026 at 2:00 PM »), « en » dans un salon français
 * s'écrit `en-FR` (« 2 October 2026 at 14:00 »). Les deux sont de l'anglais, et
 * seule la seconde prouve que le `countryCode` du shell est bien descendu
 * jusqu'au formateur.
 */

vi.mock('next-intl', () => nextIntlMobile());

const TENANT = 'salon-des-lilas';
const CALENDRIER = `/${TENANT}/admin/calendrier`;
const TIME_ZONE = 'Europe/Paris' as TimeZone;
/** Vendredi 2 octobre 2026, 14:00 à Paris. */
const DEBUT = '2026-10-02T12:00:00.000Z' as UtcInstant;

let pathname = CALENDRIER;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => pathname,
}));

/**
 * L'écouteur que le composant abonne au flux, capturé plutôt que nourri par une
 * vraie connexion : `EventSource` n'existe pas sous jsdom, et monter la chaîne
 * de bout en bout pour éprouver **des mots** ferait dépendre la suite de tout
 * autre chose que ce qu'elle vérifie. Le vrai fournisseur est éprouvé par
 * `appointment-feed-live.test.ts`.
 */
let ecouteur: ((notice: AppointmentFeedNotice) => void) | null = null;

vi.mock('@/components/live/appointment-feed', () => ({
  useAppointmentFeed: (listener: (notice: AppointmentFeedNotice) => void) => {
    ecouteur = listener;
  },
}));

afterEach(() => {
  cleanup();
  pathname = CALENDRIER;
  ecouteur = null;
  fixerLangue('fr');
});

function evenement(change: AppointmentFeedEvent['change']): AppointmentFeedEvent {
  return {
    change,
    appointmentId: 'a0f1c2d3-3333-4c53-8f0e-1b2c3d4e5f60',
    startsAt: DEBUT,
    occurredAt: '2026-10-01T09:00:00.000Z' as UtcInstant,
    ...(change === 'cancelled' ? { cancelledBy: 'client' as const } : {}),
  };
}

function backOffice(countryCode: string | null): ReactNode {
  return (
    <AdminAnnouncementProvider>
      <AdminAnnouncementRegion />
      <AdminLiveAnnouncements
        countryCode={countryCode}
        readsEstablishmentAgenda
        tenantSlug={TENANT}
        timeZone={TIME_ZONE}
      />
    </AdminAnnouncementProvider>
  );
}

/** Le texte de la région après qu'un changement est arrivé du flux. */
function annonce(
  locale: Locale,
  change: AppointmentFeedEvent['change'],
  countryCode: string | null = 'FR',
): string {
  fixerLangue(locale);
  const { container } = render(backOffice(countryCode));

  if (ecouteur === null) {
    throw new Error('le composant ne s’est pas abonné au flux');
  }

  const recevoir = ecouteur;

  act(() => {
    recevoir({ kind: 'change', event: evenement(change) });
  });

  const region = container.querySelector<HTMLElement>('[aria-live="polite"]');

  if (region === null) {
    throw new Error('aucune région aria-live dans le back-office');
  }

  return region.textContent ?? '';
}

/** Le jour et l'heure tels qu'`Intl` les écrit sous une étiquette donnée. */
function moment(tag: string): string {
  return new Intl.DateTimeFormat(tag, {
    timeZone: TIME_ZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(DEBUT));
}

describe('back-office — le sujet des annonces du temps réel suit la langue (#1275)', () => {
  it('écrit la date en anglais sur une session anglaise, pour un rendez-vous arrivé', () => {
    const lu = annonce('en', 'created');

    expect(lu).toContain(moment('en-FR'));
    // Le défaut lui-même : la date française sous une phrase anglaise.
    expect(lu).not.toContain(moment('fr-FR'));
    // Et la phrase est bien celle du bandeau attendu, faute de quoi l'assertion
    // du dessus passerait sur une région restée vide.
    expect(lu).toContain('New appointment');
  });

  it('écrit la date en anglais sur une session anglaise, pour une annulation cliente', () => {
    const lu = annonce('en', 'cancelled');

    expect(lu).toContain(moment('en-FR'));
    expect(lu).not.toContain(moment('fr-FR'));
    expect(lu).toContain('cancelled by the client');
  });

  it('ne change rien sur une session française', () => {
    for (const change of ['created', 'cancelled'] as const) {
      const lu = annonce('fr', change);

      expect(lu).toContain(moment('fr-FR'));
      cleanup();
    }
  });

  it('prend la région du salon, et non celle du repli de la langue', () => {
    // `en` seul s'écrit `en-US` — « October 2, 2026 at 2:00 PM ». Le salon est en
    // France : c'est `en-FR` qu'on doit lire, et les deux diffèrent sur l'ordre
    // des chiffres comme sur l'horloge. Sans cette assertion, passer la langue
    // sans le pays suffirait à faire verdir la suite.
    const lu = annonce('en', 'created', 'FR');

    expect(lu).toContain(moment('en-FR'));
    expect(lu).not.toContain(moment('en-US'));
  });

  it('se rabat sur la région documentée quand le salon n’a pas publié d’adresse', () => {
    // `null` — la vitrine n'a pas répondu, ou le salon n'a pas d'adresse. Le
    // repli de `lib/format.ts` est figé et documenté : `en` → `en-US`.
    const lu = annonce('en', 'created', null);

    expect(lu).toContain(moment('en-US'));
  });
});
