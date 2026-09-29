import type { AvailabilityResponse } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { AccountDisplayLocaleProvider } from '@/app/(account)/[tenantSlug]/compte/components/account-display-locale';
import { RescheduleForm } from '@/app/(account)/[tenantSlug]/compte/components/reschedule-form';
import { AdminTopbar } from '@/app/(admin)/[tenantSlug]/admin/components/admin-topbar';
import { boundLabel } from '@/lib/admin/reporting-window';

/**
 * Une seule convention de mise en forme par écran — #1325.
 *
 * ## Ce que cette suite protège
 *
 * Deux surfaces du constat de #1325 dont la faute ne se voit qu'**à l'écran
 * monté**, et non dans un formateur pris seul :
 *
 * - **la barre du haut du back-office**, qui appelait `formattingLocale(locale)`
 *   sans le pays du salon et écrivait donc « Tuesday, September 29, 2026 » —
 *   l'écriture américaine — au-dessus d'un corps de page qui écrivait
 *   « 29 September 2026 ». Le pays descend désormais du gabarit ;
 * - **la légende du graphique de volume du reporting**, qui recopiait les bornes
 *   du contrat telles quelles : « from 2026-08-31 to 2026-09-29 inclusive », deux
 *   dates ISO au milieu d'une phrase. C'est la seule phrase de l'écran qu'un
 *   lecteur d'écran entend pour situer le graphique.
 *
 * ## Pourquoi une langue mobile
 *
 * L'amorce des suites fixe la langue à `fr` (#845) ; or c'est le **couple** langue
 * × pays qui est ici en cause, et la faute de la barre du haut n'apparaît qu'en
 * anglais. La doublure mobile est celle de `tests/support/langue-mobile.ts`,
 * partagée avec `admin-billing-panel.test.tsx` et une dizaine d'autres suites.
 *
 * ## Le fuseau ne bouge pas
 *
 * Le salon de référence est à Antananarivo (UTC+3), et la date affichée est la
 * **sienne** dans les quatre combinaisons. Une date rendue dans le fuseau du
 * lecteur annoncerait une autre journée que celle que le planning montre — la
 * faute de sévérité haute que `CLAUDE.md` nomme.
 */

vi.mock('next-intl', () => nextIntlMobile());

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  rescheduleOwnAppointmentAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

beforeEach(() => {
  fixerLangue('fr');
});

afterEach(() => {
  cleanup();
});

/** UTC+3 : un fuseau qui n'est celui d'aucune machine d'intégration. */
const TIME_ZONE = 'Indian/Antananarivo';

function barre(countryCode: string | null): void {
  render(
    <AdminTopbar
      billing={null}
      countryCode={countryCode}
      role="admin"
      salonName="Maison Lotus"
      tenantSlug="maison-lotus"
      timeZone={TIME_ZONE}
    />,
  );
}

/** La date du jour telle que la barre l'écrit — sans le nom du salon. */
function dateAffichee(): string {
  const date = screen.getByText((_, element) =>
    element?.className === 'spa-admin-topbar__date' ? true : false,
  );

  return date.textContent ?? '';
}

describe('la barre du haut du back-office écrit la date du pays du salon', () => {
  /**
   * Le constat, en une assertion : la barre écrivait le mois d'abord — l'ordre
   * américain — pour un salon dont le reste de l'écran écrivait le jour d'abord.
   * L'ordre attendu est celui du pays, pas celui de la langue.
   */
  it('garde l’ordre du salon quand la session est en anglais', () => {
    fixerLangue('en');
    barre('FR');

    const affichee = dateAffichee();

    // « Tuesday, 29 September 2026 » — le **jour avant le mois**, comme `en-FR`
    // l'écrit. C'était « Tuesday, September 29, 2026 ».
    expect(affichee).toMatch(/^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+ \d{4}$/u);
  });

  /** Un salon américain, lui, garde bien le mois d'abord. */
  it('écrit le mois d’abord pour un salon américain', () => {
    fixerLangue('en');
    barre('US');

    expect(dateAffichee()).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}$/u);
  });

  /** Et le français reste le français, pays du salon compris. */
  it('écrit la date en français avec une initiale capitale', () => {
    fixerLangue('fr');
    barre('FR');

    expect(dateAffichee()).toMatch(/^[A-Z][a-zé]+ \d{1,2} [a-zûé]+ \d{4}$/u);
  });

  /**
   * Sans pays publié, la barre retombe sur la région du marché de sa langue —
   * le repli documenté de `lib/format.ts`, et non une devinette locale. Ce qui se
   * vérifie ici est qu'elle **rend quelque chose** plutôt que de tomber : un salon
   * qui n'a pas encore saisi son adresse ouvre tout de même son back-office.
   */
  it('n’a pas besoin du pays pour rendre sa date', () => {
    fixerLangue('en');
    barre(null);

    expect(dateAffichee()).not.toBe('');
  });
});

describe('l’écran de report suit la région du salon', () => {
  const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
  const STAFF_ID = '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
  const SERVICE_ID = 'b2d5e8a1-9c3f-4d7e-8a2b-6f1c0d3e4a59';
  /** 14:10 à Paris, 08:10 à New York. */
  const CURRENT_STARTS_AT = '2026-09-29T12:10:00.000Z';

  const availability = (): AvailabilityResponse => ({
    serviceId: SERVICE_ID,
    timezone: 'Europe/Paris',
    days: [
      {
        date: '2026-09-29',
        slots: [
          {
            startsAt: '2026-09-29T12:10:00.000Z',
            endsAt: '2026-09-29T13:10:00.000Z',
            staffId: STAFF_ID,
          },
          {
            startsAt: '2026-09-29T13:10:00.000Z',
            endsAt: '2026-09-29T14:10:00.000Z',
            staffId: STAFF_ID,
          },
        ],
      },
    ],
  });

  function report(countryCode: string, timeZone: string): void {
    render(
      <AccountDisplayLocaleProvider countryCode={countryCode}>
        <RescheduleForm
          appointmentId={APPOINTMENT_ID}
          availability={availability()}
          bounds={{ first: '2026-09-29', last: '2026-10-29' }}
          currentStartsAt={CURRENT_STARTS_AT}
          month="2026-09"
          monthHref="/maison-lotus/compte/rendez-vous/x/report?mois="
          serviceName="Massage suédois"
          tenantSlug="maison-lotus"
          timeZone={timeZone}
        />
      </AccountDisplayLocaleProvider>,
    );
  }

  /**
   * Les heures que la grille de créneaux propose, dans l'ordre de la journée.
   *
   * La grille est désignée par l'identifiant de son titre plutôt que par son nom
   * accessible : celui-ci porte la date, donc la langue, et la sélection
   * dépendrait de ce que le test est précisément en train de vérifier. La bande
   * de jours est un second `role="grid"` de la même page, d'où le filtre.
   *
   * Le texte est celui du **bouton**, pas de la cellule : un créneau verrouillé
   * porte en plus son mot — « actuel » —, dans un `span` voisin de l'heure.
   */
  function heures(): string[] {
    const grille = screen
      .getAllByRole('grid')
      .find((noeud) => noeud.getAttribute('aria-labelledby') === 'report-creneaux-titre');

    return [...(grille?.querySelectorAll('[role="gridcell"] button') ?? [])].map(
      (bouton) =>
        bouton.querySelector('span[aria-hidden="true"]')?.textContent ?? bouton.textContent ?? '',
    );
  }

  /**
   * **Le premier constat de #1325.** L'écran ne passait pas `countryCode` au
   * sélecteur : celui-ci retombait sur la région de repli de sa langue, et la
   * grille affichait « 2:10 PM » sous un bouton de validation qui, lui, recevait
   * bien le pays et écrivait « 15:10 ».
   *
   * Un salon parisien lu en anglais garde donc ses 24 heures, partout sur l'écran.
   */
  it('n’écrit pas la grille en 12 heures pour un salon parisien', () => {
    fixerLangue('en');
    report('FR', 'Europe/Paris');

    expect(heures()).toEqual(expect.arrayContaining(['14:10', '15:10']));
    expect(heures().join(' ')).not.toContain('PM');
  });

  /**
   * **Le deuxième critère, côté salon américain.** Le même écran pour un salon de
   * New York passe en 12 heures — et la mention « actuel » du créneau qu'on
   * déplace le suit, puisqu'elle est composée de la même heure.
   */
  it('écrit la grille en 12 heures pour un salon américain', () => {
    fixerLangue('en');
    report('US', 'America/New_York');

    expect(heures()).toEqual(expect.arrayContaining(['8:10 AM', '9:10 AM']));
  });

  /** Et le français reste en 24 heures, pour les deux salons. */
  it('garde les 24 heures du français, quel que soit le pays', () => {
    fixerLangue('fr');
    report('US', 'America/New_York');

    expect(heures()).toEqual(expect.arrayContaining(['08:10', '09:10']));
  });
});

describe('la légende du reporting nomme ses bornes en clair', () => {
  /**
   * Le cinquième constat : la légende écrivait « from 2026-08-31 to 2026-09-29
   * inclusive ». Les bornes sont des dates civiles de l'établissement et se
   * mettent en forme **en UTC** — les reprojeter dans le fuseau du salon les
   * ferait reculer d'un jour pour tout salon à l'est de Greenwich.
   */
  it('écrit une borne dans la langue et la région du salon', () => {
    expect(boundLabel('2026-08-31', { locale: 'fr', countryCode: 'FR' })).toBe('31 août 2026');
    expect(boundLabel('2026-08-31', { locale: 'en', countryCode: 'FR' })).toBe('31 August 2026');
    expect(boundLabel('2026-08-31', { locale: 'en', countryCode: 'US' })).toBe('August 31, 2026');
  });

  it('ne laisse jamais passer la forme ISO du contrat', () => {
    for (const display of [
      { locale: 'fr', countryCode: 'FR' },
      { locale: 'en', countryCode: 'FR' },
      { locale: 'fr', countryCode: 'US' },
      { locale: 'en', countryCode: 'US' },
    ] as const) {
      expect(boundLabel('2026-09-29', display)).not.toContain('2026-09-29');
    }
  });

  /**
   * La borne ne bascule pas d'un jour selon le fuseau du salon : elle est déjà
   * civile. Un salon d'Antananarivo et un salon de Los Angeles nomment donc le
   * même 29 septembre.
   */
  it('ne décale pas la borne d’un fuseau à l’autre', () => {
    expect(boundLabel('2026-09-29', { locale: 'fr', countryCode: 'FR' })).toContain('29');
    expect(boundLabel('2026-01-01', { locale: 'fr', countryCode: 'FR' })).toBe('1 janvier 2026');
  });
});
