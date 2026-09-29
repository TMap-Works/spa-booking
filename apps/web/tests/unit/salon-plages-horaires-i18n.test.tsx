import type { PublicTenant } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { SalonInfo } from '@/components/salon/salon-info';

import { tenant } from './fixtures';

/**
 * Une plage d'horaires s'écrit dans la convention du pays du salon — #1345.
 *
 * ## Ce que cette suite protège, et pourquoi à l'écran monté
 *
 * `salon-opening-hours.test.ts` éprouve déjà `formatOpeningRange` prise seule, et
 * `admin-my-planning-i18n.test.tsx` fait de même pour les plages de travail de
 * « Mon planning ». Ce qu'aucune des deux ne voit, c'est le **chemin** : la carte
 * « Horaires » de la vitrine résout son contexte d'affichage elle-même — langue
 * de la session, pays lu sur l'adresse de l'établissement — et c'est là que le
 * défaut de #1325 s'était logé sur d'autres écrans, dans le paramètre qu'un
 * composant oublie de descendre.
 *
 * Le constat d'origine est exactement celui-là : la vitrine d'un salon de
 * Manhattan annonçait « 09:00 – 19:00 » au-dessus de créneaux proposés à
 * « 9:00 AM ».
 *
 * ## Les quatre combinaisons, et les trois qui ne doivent pas bouger
 *
 * Le troisième critère demande un salon français et un salon américain, dans les
 * deux langues. Une seule des quatre passe en 12 heures — l'anglais chez le salon
 * américain —, et c'est ce qui distingue « pays du salon » de « langue de la
 * session » : un `hourCycle` forcé, ou une étiquette composée sur la seule langue,
 * aurait fait basculer aussi le salon parisien lu en anglais.
 *
 * ## Pourquoi une langue mobile
 *
 * L'amorce des suites fixe la langue à `fr` (#845), et c'est le **couple** langue
 * × pays qui est ici en cause. La doublure mobile est celle de
 * `tests/support/langue-mobile.ts`, partagée avec une dizaine d'autres suites.
 *
 * ## Le fuseau ne bouge pas
 *
 * Le salon de référence est à Antananarivo, et son pays d'adresse varie d'un cas à
 * l'autre : c'est bien l'**écriture** que la région décide, jamais le fuseau ni
 * l'heure murale que la gérante a saisie.
 */

vi.mock('next-intl', () => nextIntlMobile());

beforeEach(() => {
  fixerLangue('fr');
});

afterEach(cleanup);

/** Un mardi à 10 h 00 chez le tenant des fixtures (UTC+3, sans heure d'été). */
const MARDI_MATIN = new Date('2026-09-15T07:00:00.000Z');

/**
 * Le salon des fixtures, doté d'une adresse dans le pays demandé et d'une semaine
 * publiée dont le samedi ferme à `24:00`.
 */
function salon(country: string): PublicTenant {
  return {
    ...tenant,
    address: {
      line1: '12 rue des Lilas',
      postalCode: '75011',
      city: 'Paris',
      country,
    },
    openingHours: [
      { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
      { weekday: 2, opensAt: '14:00', closesAt: '19:00' },
      { weekday: 6, opensAt: '10:00', closesAt: '24:00' },
    ],
  };
}

/**
 * Ce que la carte « Horaires » écrit de la journée demandée, espaces insécables
 * ramenées à des espaces ordinaires.
 *
 * `Intl` insère un blanc insécable — U+00A0 ou U+202F selon la version d'ICU —
 * devant « AM », et la plage elle-même en porte deux autour de son tiret. Une
 * assertion qui les comparerait au caractère près échouerait au prochain
 * relèvement de Node sans qu'aucune convention n'ait changé.
 */
function ligne(jour: string): string {
  const row = screen
    .getAllByRole('listitem')
    .find((item) => (item.textContent ?? '').startsWith(jour));

  return (row?.textContent ?? '').replace(/[\u00a0\u202f]/gu, ' ');
}

describe('la carte « Horaires » de la vitrine', () => {
  it('écrit ses plages en 24 heures chez un salon français, dans les deux langues', () => {
    render(<SalonInfo tenant={salon('FR')} bookable now={MARDI_MATIN} />);

    expect(ligne('Mardi')).toContain('09:00 – 12:00, 14:00 – 19:00');

    cleanup();
    fixerLangue('en');
    render(<SalonInfo tenant={salon('FR')} bookable now={MARDI_MATIN} />);

    // Le cas qui fait la différence : la phrase est anglaise, l'heure reste celle
    // du pays du salon.
    expect(ligne('Tuesday')).toContain('09:00 – 12:00, 14:00 – 19:00');
  });

  it('passe en 12 heures chez un salon américain lu en anglais', () => {
    fixerLangue('en');
    render(<SalonInfo tenant={salon('US')} bookable now={MARDI_MATIN} />);

    // Le constat de #1345, en une assertion : c'était « 09:00 – 12:00 » au-dessus
    // de créneaux à « 9:00 AM ».
    expect(ligne('Tuesday')).toContain('9:00 AM – 12:00 PM, 2:00 PM – 7:00 PM');
  });

  it('garde les 24 heures chez un salon américain lu en français', () => {
    render(<SalonInfo tenant={salon('US')} bookable now={MARDI_MATIN} />);

    // Le français écrit en 24 heures partout, y compris aux États-Unis : c'est la
    // langue qui décide du cycle ici, la région ne le contredit pas.
    expect(ligne('Mardi')).toContain('09:00 – 12:00, 14:00 – 19:00');
  });

  it('écrit « minuit » plutôt que « 00:00 » pour la borne 24:00 du contrat', () => {
    render(<SalonInfo tenant={salon('FR')} bookable now={MARDI_MATIN} />);

    expect(ligne('Samedi')).toContain('10:00 – minuit');

    cleanup();
    fixerLangue('en');
    render(<SalonInfo tenant={salon('US')} bookable now={MARDI_MATIN} />);

    expect(ligne('Saturday')).toContain('10:00 AM – midnight');
  });
});
