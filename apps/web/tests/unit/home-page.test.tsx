import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #927 — la page d'accueil de la plateforme.
 *
 * Elle doit ouvrir un salon sans qu'on tape d'URL, redonner le salon de la
 * dernière visite, et ne jamais lister d'établissements (place de marché, hors
 * périmètre CDC §1.4).
 *
 * Les libellés des portes sont lus **à leur source** plutôt que réécrits ici :
 * les deux premiers dans le registre des sorties du parcours client, le
 * troisième dans le catalogue de l'écran. Une page qui les recopierait
 * laisserait ce test vert pendant que l'accueil nommerait la même destination
 * autrement que la vitrine — l'écart même que le registre existe pour empêcher
 * (#749).
 *
 * `SALON_DOOR_LABELS` les tenait jusqu'à #1233, figés en français ; la table est
 * désormais composée ici des deux mêmes sources que l'écran emploie.
 */

const readSalonIdentity = vi.fn();
const openSalonAction = vi.fn();
let storedSalon: string | undefined;

vi.mock('@/lib/salon-identity', () => ({
  readSalonIdentity: (...args: unknown[]) => readSalonIdentity(...args),
}));

vi.mock('@/app/actions', () => ({
  openSalonAction: (...args: unknown[]) => openSalonAction(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'spa_dernier_salon' && storedSalon !== undefined
          ? { name, value: storedSalon }
          : undefined,
      set: vi.fn(),
    }),
}));

import HomePage from '@/app/page';
import type { SalonDoor } from '@/app/salon-doors';
import { SalonFinder } from '@/components/home/salon-finder';
import { publicExitLabels } from '@/components/salon/public-exits';
import booking from '@/messages/fr/booking.json';

import { TEST_LOCALE } from '../support/next-intl';

/** Le nom des trois portes, composé comme l'écran le compose — voir l'en-tête. */
const PORTES: Readonly<Record<SalonDoor, string>> = {
  reservation: publicExitLabels(TEST_LOCALE).reservation,
  compte: publicExitLabels(TEST_LOCALE).compte,
  'back-office': booking.home.common.doorBackOffice,
};

async function rendreLAccueil(): Promise<HTMLElement> {
  const { container } = render(await HomePage());
  return container;
}

afterEach(() => {
  cleanup();
  storedSalon = undefined;
  readSalonIdentity.mockReset();
  openSalonAction.mockReset();
});

describe('une première visite', () => {
  it('présente le produit et ouvre un salon par son adresse', async () => {
    await rendreLAccueil();

    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
    const acces = screen.getByRole('form', { name: 'Accéder à mon salon' });
    const champ = within(acces).getByLabelText(/nom ou adresse du salon/i) as HTMLInputElement;
    expect(champ.value).toBe('');

    for (const porte of Object.values(PORTES)) {
      expect(within(acces).getByRole('button', { name: porte })).toBeDefined();
    }
    expect(readSalonIdentity).not.toHaveBeenCalled();
  });

  it('ne porte qu’une action pleine (BM-VISUEL-02)', async () => {
    const page = await rendreLAccueil();

    const pleins = page.querySelectorAll('.spa-button--accent');
    expect(pleins).toHaveLength(1);
    expect(pleins[0]?.textContent).toBe('Prendre rendez-vous');
  });

  it('ne liste aucun salon', async () => {
    const page = await rendreLAccueil();

    // Aucun lien de la page ne sort de la racine vers un établissement : les
    // seuls liens sont des ancres de la page, la page elle-même, et
    // l'inscription d'un salon (ADR 0016) — un slug réservé, jamais un salon.
    const cibles = [...page.querySelectorAll('a')].map((lien) => lien.getAttribute('href') ?? '');
    expect(
      cibles.every((cible) => cible === '/' || cible === '/inscription' || cible.startsWith('#')),
    ).toBe(true);
  });

  it('offre le choix du thème dans le pied de page, et laisse la barre à la navigation (#1114)', async () => {
    await rendreLAccueil();

    // Dans la barre, les trois pastilles faisaient passer la marque et deux
    // ancres sur deux lignes, même à 1280 px.
    const selecteur = { name: 'Thème d’affichage' };
    expect(within(screen.getByRole('contentinfo')).getByRole('group', selecteur)).toBeDefined();
    expect(within(screen.getByRole('banner')).queryByRole('group', selecteur)).toBeNull();
  });

  it('mène chaque renvoi vers le formulaire à une cible qui existe', async () => {
    const page = await rendreLAccueil();

    for (const lien of page.querySelectorAll('a[href^="#"]')) {
      const cible = lien.getAttribute('href')?.slice(1) ?? '';
      expect(page.querySelector(`[id="${cible}"]`), `#${cible}`).not.toBeNull();
    }
  });
});

describe('le salon de la dernière visite', () => {
  it('redonne ses trois portes, et laisse le champ libre pour un autre', async () => {
    storedSalon = 'maison-lotus';
    readSalonIdentity.mockResolvedValue({ status: 'found', slug: 'maison-lotus', name: 'Maison Lotus' });

    await rendreLAccueil();

    const salon = screen.getByRole('region', { name: 'Maison Lotus' });
    expect(within(salon).getByRole('link', { name: 'Maison Lotus' }).getAttribute('href')).toBe(
      '/maison-lotus',
    );
    expect(
      within(salon).getByRole('link', { name: PORTES.reservation }).getAttribute('href'),
    ).toBe('/maison-lotus/reservation');
    expect(
      within(salon).getByRole('link', { name: PORTES.compte }).getAttribute('href'),
    ).toBe('/maison-lotus/compte');
    expect(
      within(salon)
        .getByRole('link', { name: PORTES['back-office'] })
        .getAttribute('href'),
    ).toBe('/maison-lotus/admin/connexion');

    const acces = screen.getByRole('form', { name: 'Un autre salon ?' });
    expect((within(acces).getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('se contente de préremplir le champ quand l’API ne répond pas', async () => {
    storedSalon = 'maison-lotus';
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    await rendreLAccueil();

    expect(screen.queryByRole('region', { name: /maison/i })).toBeNull();
    const acces = screen.getByRole('form', { name: 'Accéder à mon salon' });
    expect((within(acces).getByRole('textbox') as HTMLInputElement).value).toBe('maison-lotus');
  });

  it('s’efface pour un salon qui n’existe plus', async () => {
    storedSalon = 'salon-ferme';
    readSalonIdentity.mockResolvedValue({ status: 'unknown' });

    await rendreLAccueil();

    const acces = screen.getByRole('form', { name: 'Accéder à mon salon' });
    expect((within(acces).getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('ignore un cookie que le contrat refuse, sans appeler l’API', async () => {
    storedSalon = '../admin';

    await rendreLAccueil();

    expect(readSalonIdentity).not.toHaveBeenCalled();
  });
});

describe('le formulaire d’accès', () => {
  it('affiche le refus sur le champ et garde la saisie', async () => {
    openSalonAction.mockResolvedValue({
      address: 'Salon Fantôme',
      fieldError: 'Aucun salon ne répond à « Salon Fantôme ».',
      formError: null,
    });
    render(<SalonFinder initialAddress="" title="Accéder à mon salon" />);

    await userEvent.type(screen.getByRole('textbox'), 'Salon Fantôme');
    await userEvent.click(screen.getByRole('button', { name: PORTES.compte }));

    const champ = await screen.findByRole('textbox', { description: /aucun salon ne répond/i });
    expect(champ.getAttribute('aria-invalid')).toBe('true');
    expect((champ as HTMLInputElement).value).toBe('Salon Fantôme');

    const envoi = openSalonAction.mock.calls[0]?.[1] as FormData;
    expect(envoi.get('adresse')).toBe('Salon Fantôme');
    expect(envoi.get('porte')).toBe('compte');
  });

  it('désactive les trois portes pendant la vérification', async () => {
    let conclure: (state: unknown) => void = () => undefined;
    openSalonAction.mockReturnValue(
      new Promise((resolve) => {
        conclure = resolve;
      }),
    );
    render(<SalonFinder initialAddress="maison-lotus" title="Accéder à mon salon" />);

    await userEvent.click(screen.getByRole('button', { name: 'Prendre rendez-vous' }));

    await waitFor(() => {
      for (const bouton of screen.getAllByRole('button')) {
        expect((bouton as HTMLButtonElement).disabled).toBe(true);
      }
    });
    conclure({ address: 'maison-lotus', fieldError: null, formError: 'Le service est momentanément injoignable.' });
    expect(await screen.findByText(/momentanément injoignable/i)).toBeDefined();
  });
});
