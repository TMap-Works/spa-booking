import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile, nextIntlServerMobile } from '../support/langue-mobile';

import HomePage from '@/app/page';
import { PHOTOS, type PhotoName } from '@/lib/photos';
import en from '@/messages/en/booking.json';
import fr from '@/messages/fr/booking.json';

/**
 * #1233 — les textes alternatifs des photographies de l'accueil.
 *
 * Les huit descriptions étaient écrites en français dans `lib/photos.ts`. Le
 * registre n'en garde plus que la **clé** ; c'est l'accueil qui la traduit, dans
 * le namespace `booking`, sous `home.photos`.
 *
 * Deux choses à éprouver, et elles ne se recouvrent pas :
 *
 * - la **cohérence du registre** — chaque entrée porte sa propre clé, et cette
 *   clé existe dans les deux catalogues. Sans cela, `alt` rendrait le nom de la
 *   clé, ce qu'un lecteur d'écran annoncerait tel quel ;
 * - le **rendu**, dans les deux langues. Une clé présente partout ne prouve pas
 *   que l'écran la lit : c'était précisément le cas avant ce ticket, où `alt`
 *   venait d'une constante française.
 *
 * L'amorce des suites fixe la langue à `fr` (`tests/support/next-intl.ts`) ; le
 * second point demande de rendre le **même** écran en anglais. Il y faut **deux**
 * doublures déplacées ensemble : l'accueil est un Server Component et lit ses
 * messages par `getTranslations`, mais le formulaire qu'il monte est un Client
 * Component et passe par les crochets. Les deux viennent désormais de la langue
 * mobile partagée (`tests/support/langue-mobile.ts`, #1277), où elles lisent la
 * **même** variable : un seul `fixerLangue()` les déplace, et aucune ne peut
 * rester en arrière.
 */

const readSalonIdentity = vi.fn();

vi.mock('@/lib/salon-identity', () => ({
  readSalonIdentity: (...args: unknown[]) => readSalonIdentity(...args),
}));

vi.mock('@/app/actions', () => ({ openSalonAction: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: vi.fn() }),
}));

vi.mock('next-intl', () => nextIntlMobile());

vi.mock('next-intl/server', () => nextIntlServerMobile());

/** Les descriptions, telles que les catalogues les écrivent. */
const LEGENDES = { fr: fr.home.photos, en: en.home.photos } as const;

/** Les photographies que l'accueil pose en `<img>` — celles qui portent un `alt`. */
const RENDUES: readonly PhotoName[] = [
  'spaInterieur',
  'soinVisage',
  'salonInterieur',
  'barbier',
  'natureMorteSpa',
  'coiffureBrushing',
];

afterEach(() => {
  cleanup();
  readSalonIdentity.mockReset();
  fixerLangue('fr');
});

describe('le registre des photographies', () => {
  it('nomme chaque entrée par sa propre clé', () => {
    for (const [nom, photo] of Object.entries(PHOTOS)) {
      expect(photo.altKey, nom).toBe(nom);
    }
  });

  it('a sa description dans les deux catalogues, et deux fois différente', () => {
    for (const nom of Object.keys(PHOTOS) as PhotoName[]) {
      expect(LEGENDES.fr[nom], `fr/${nom}`).toBeTypeOf('string');
      expect(LEGENDES.en[nom], `en/${nom}`).toBeTypeOf('string');
      expect(LEGENDES.en[nom], nom).not.toBe(LEGENDES.fr[nom]);
    }
  });

  it('n’écrit plus aucune phrase — il ne porte que des clés', () => {
    for (const photo of Object.values(PHOTOS)) {
      // Une clé du catalogue est un identifiant, pas une phrase : ni espace,
      // ni ponctuation. C'est ce qui distingue « barbier » d'« Un rasage en
      // cours chez le barbier ».
      expect(photo.altKey).toMatch(/^[a-zA-Z]+$/);
    }
  });
});

describe('l’accueil de la plateforme', () => {
  it('décrit ses photographies en français', async () => {
    render(await HomePage());

    for (const nom of RENDUES) {
      expect(screen.getByAltText(LEGENDES.fr[nom]), nom).toBeDefined();
    }
  });

  it('les décrit en anglais quand la requête est en anglais', async () => {
    fixerLangue('en');

    render(await HomePage());

    for (const nom of RENDUES) {
      expect(screen.getByAltText(LEGENDES.en[nom]), nom).toBeDefined();
      expect(screen.queryByAltText(LEGENDES.fr[nom]), nom).toBeNull();
    }
  });

  it('ne laisse aucune image sans description', async () => {
    const { container } = render(await HomePage());

    for (const image of container.querySelectorAll('img')) {
      expect(image.getAttribute('alt')?.trim()).toBeTruthy();
    }
  });
});
