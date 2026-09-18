import type { BookedAppointment, PublicService } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '@/components/account/appointment-history';
import {
  groupHistoryByMonth,
  HISTORY_FILTERS,
  matchesHistoryFilter,
} from '@/components/account/appointment-history';
import { rebookHref } from '@/components/account/rebook';

import { service } from './fixtures';

/**
 * Ce qui range l'historique — #1054.
 *
 * Trois calculs, et aucun ne se prouve à l'œil sur un rendu :
 *
 * - **le regroupement par mois**, qui doit se faire dans le fuseau du salon —
 *   un rendez-vous d'un 1er du mois à 0 h 30 à Antananarivo appartient au mois
 *   précédent pour une visiteuse à Paris, et l'intertitre doit dire ce que la
 *   cliente a vécu sur place ;
 * - **le filtre**, dont le point délicat est la ligne d'origine d'un report :
 *   `cancelled` sans auteur, nommée « Déplacé », et qui doit tomber sous
 *   « Annulés » sans mériter une quatrième pastille ;
 * - **le lien de reprise**, qui promet un tunnel déjà rempli et doit donc se
 *   taire dès que la prestation n'est plus réservable (BM-HISTO-02).
 */

const OTHER_STAFF = '55555555-5555-4555-8555-555555555555';

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'completed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? OTHER_STAFF,
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-21T08:00:00.000Z',
    endsAt: '2026-09-21T09:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

/** Une ligne d'historique réduite à ce que le regroupement regarde. */
function entry(startsAt: string, id = startsAt): HistoryEntry {
  return {
    brief: {
      appointment: appointment({ id, startsAt, endsAt: startsAt }),
      serviceName: service.name,
      practitioner: 'Hery',
      durationMinutes: 60,
    },
    rebookHref: null,
  };
}

describe('le filtre de l’historique (#1054)', () => {
  it('n’offre que « Tous », « Honorés » et « Annulés »', () => {
    expect(HISTORY_FILTERS.map((item) => item.id)).toEqual(['tous', 'honores', 'annules']);
  });

  it('ne masque rien sous « Tous » — un rendez-vous honoré reste consultable (BM-HISTO-01)', () => {
    for (const status of ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'] as const) {
      expect(matchesHistoryFilter(status, 'tous')).toBe(true);
    }
  });

  it('ne retient sous « Honorés » que ce que le salon a constaté honoré', () => {
    expect(matchesHistoryFilter('completed', 'honores')).toBe(true);
    expect(matchesHistoryFilter('no_show', 'honores')).toBe(false);
    expect(matchesHistoryFilter('confirmed', 'honores')).toBe(false);
  });

  it('range la ligne d’origine d’un report sous « Annulés »', () => {
    // « Déplacé » est un `cancelled` sans auteur (`lib/appointment-status.ts`) :
    // c'est bien un rendez-vous qui n'a pas eu lieu à cette heure-là, et la
    // cliente qui cherche « ce qui n'a pas eu lieu » le cherche là.
    expect(matchesHistoryFilter('cancelled', 'annules')).toBe(true);
    expect(matchesHistoryFilter('completed', 'annules')).toBe(false);
  });
});

describe('le regroupement par mois (#1054)', () => {
  it('groupe les lignes du même mois, le mois le plus récent d’abord', () => {
    const months = groupHistoryByMonth(
      [
        entry('2026-08-03T08:00:00.000Z'),
        entry('2026-09-21T08:00:00.000Z'),
        entry('2026-09-02T08:00:00.000Z'),
      ],
      'Europe/Paris',
    );

    expect(months.map((month) => month.key)).toEqual(['2026-09', '2026-08']);
    expect(months[0]?.label).toBe('Septembre 2026');
    expect(months[0]?.entries).toHaveLength(2);
    expect(months[1]?.label).toBe('Août 2026');
  });

  it('classe les lignes d’un même mois de la plus récente à la plus ancienne', () => {
    const months = groupHistoryByMonth(
      [entry('2026-09-02T08:00:00.000Z'), entry('2026-09-21T08:00:00.000Z')],
      'Europe/Paris',
    );

    expect(months[0]?.entries.map((line) => line.brief.appointment.startsAt)).toEqual([
      '2026-09-21T08:00:00.000Z',
      '2026-09-02T08:00:00.000Z',
    ]);
  });

  it('découpe les mois dans le fuseau du salon, pas dans celui du serveur', () => {
    // 30 septembre 21 h 30 UTC : c'est encore septembre à Londres, et déjà le
    // 1er octobre à Antananarivo (UTC+3). Le même instant change donc de mois
    // selon le salon qui le lit — et c'est le salon qui a raison.
    const minuit = [entry('2026-09-30T21:30:00.000Z')];

    expect(groupHistoryByMonth(minuit, 'Europe/London')[0]?.key).toBe('2026-09');
    expect(groupHistoryByMonth(minuit, 'Indian/Antananarivo')[0]?.key).toBe('2026-10');
  });

  it('rend une liste vide sans inventer de mois', () => {
    expect(groupHistoryByMonth([], 'Europe/Paris')).toEqual([]);
  });
});

describe('« Réserver à nouveau » (#1054, BM-HISTO-02)', () => {
  const BOOKING = '/maison-lotus/reservation';
  const services: readonly PublicService[] = [service];

  it('ouvre le tunnel sur la prestation et le praticien, à l’étape du créneau', () => {
    const href = rebookHref(BOOKING, appointment(), services);

    // L'étape est celle du créneau et non celle de la prestation : elle vient
    // d'être choisie, la redemander ferait recommencer ce qu'on vient de faire.
    expect(href).not.toBeNull();
    const query = new URLSearchParams((href ?? '').split('?')[1]);
    expect(query.get('etape')).toBe('creneau');
    expect(query.get('prestation')).toBe(service.id);
    expect(query.get('praticien')).toBe(service.staff[0]?.id);
  });

  it('se propose aussi sur un rendez-vous annulé — la prestation, elle, était voulue', () => {
    expect(
      rebookHref(BOOKING, appointment({ status: 'cancelled', cancelledBy: 'client' }), services),
    ).not.toBeNull();
  });

  it('se tait sur la ligne d’origine d’un report — le rendez-vous, lui, existe toujours', () => {
    // `cancelled` **sans auteur** : c'est « Déplacé » (`lib/appointment-status.ts`),
    // et la ligne écrit déjà « Ce créneau a été libéré au profit d'un autre
    // rendez-vous ». Y proposer « Réserver à nouveau » contredirait cette phrase
    // et ferait doubler la réservation.
    expect(
      rebookHref(
        BOOKING,
        appointment({
          status: 'cancelled',
          cancelledBy: null,
          cancelledAt: '2026-09-15T10:00:00.000Z',
        }),
        services,
      ),
    ).toBeNull();
  });

  it('se tait sur les statuts qui attendent encore une décision du salon', () => {
    for (const status of ['pending', 'confirmed', 'no_show'] as const) {
      expect(rebookHref(BOOKING, appointment({ status }), services)).toBeNull();
    }
  });

  it('se tait quand la prestation a quitté le catalogue public', () => {
    // Le tunnel ramènerait d'office à l'étape « prestation » (`reachableStep`)
    // après avoir promis un créneau : mieux vaut ne rien promettre.
    expect(rebookHref(BOOKING, appointment(), [])).toBeNull();
  });

  it('se tait quand plus aucun praticien ne tient la prestation', () => {
    expect(rebookHref(BOOKING, appointment(), [{ ...service, staff: [] }])).toBeNull();
  });

  it('s’en tient à la prestation quand le praticien ne la tient plus', () => {
    const href = rebookHref(BOOKING, appointment({ staffId: OTHER_STAFF }), services);

    expect(href).not.toBeNull();
    expect(new URLSearchParams((href ?? '').split('?')[1]).has('praticien')).toBe(false);
  });
});
