import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PublicService, Service, ServiceCategory, SessionUser } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextIntlFixe, nextIntlServerFixe } from '../support/langue-figee';

/** Ce fichier, d'où part la racine d'`apps/web` lue par la garde de lint. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Le catalogue du back-office en français et en anglais — #849.
 *
 * ## Ce que cette suite protège, et que les suites françaises ne protègent pas
 *
 * - **Les écrans se rendent dans la langue de la session** : la liste, la fiche,
 *   les rubriques et l'aperçu de la vitrine.
 * - **Les durées et les prix suivent la langue** : « 1 h » contre « 1 hr »,
 *   « 35,00 € » contre « €35.00 ». Le montant, lui, reste un **entier de plus
 *   petite unité accompagné de son code devise**, de la saisie à l'appel — c'est
 *   la règle « jamais de flottant » de `CLAUDE.md`, et elle se vérifie sur ce
 *   qui part vers l'action serveur.
 * - **Le contenu saisi par le salon n'est pas traduit** : le nom d'une
 *   prestation, sa description, le nom d'une rubrique et celui d'un praticien
 *   sont rendus tels qu'ils sont enregistrés, y compris quand ils sont en
 *   français sur un écran anglais.
 * - **Les refus de saisie viennent du catalogue** et non du contrat partagé,
 *   dont les messages sont des littéraux français.
 *
 * Le rendu d'un écran en anglais demande de remplacer l'amorce de langue des
 * suites, qui les fixe toutes en français (`tests/support/next-intl.ts`) : les
 * deux doublures ci-dessous lisent le **vrai** catalogue anglais, côté crochet
 * comme côté serveur. Elles viennent de `tests/support/langue-figee.ts` (#1283),
 * où elles sont écrites une fois pour les trois suites anglaises — et sur le
 * formateur ICU que l'amorce elle-même emploie, mémoïsé par langue et par
 * namespace.
 */

vi.mock('next-intl', () => nextIntlFixe('en'));

vi.mock('next-intl/server', () => nextIntlServerFixe('en'));

const fetchServices = vi.fn();
const fetchOwnProfile = vi.fn();
const fetchPublicServices = vi.fn();
const createServiceAction = vi.fn();
const createServiceCategoryAction = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchServices: (...args: unknown[]) => fetchServices(...args),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceAction: (...args: unknown[]) => createServiceAction(...args),
  updateServiceAction: vi.fn(),
  createServiceCategoryAction: (...args: unknown[]) => createServiceCategoryAction(...args),
  updateServiceCategoryAction: vi.fn(),
  assignServiceStaffAction: vi.fn(),
  removeServiceStaffAction: vi.fn(),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-de-session-du-comptoir'),
  adminLoadFailure: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/catalogue',
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

import CatalogPage from '@/app/(admin)/[tenantSlug]/admin/catalogue/(liste)/page';
import CatalogPreviewPage from '@/app/(admin)/[tenantSlug]/admin/catalogue/apercu/page';
import { CategoryManager } from '@/app/(admin)/[tenantSlug]/admin/components/category-manager';
import { ServiceForm } from '@/app/(admin)/[tenantSlug]/admin/components/service-form';
import { ServiceStaffPanel } from '@/app/(admin)/[tenantSlug]/admin/components/service-staff-panel';

const SLUG = 'salon-lotus';

/** Le nom est en français : c'est la saisie du salon, et elle ne se traduit pas. */
const CATEGORIES: ServiceCategory[] = [
  {
    id: '0a5b1e6c-1111-4c53-8f0e-1b2c3d4e5f60',
    slug: 'soins-du-visage',
    name: 'Soins du visage',
    description: null,
    isActive: true,
  },
];

const SERVICE: Service = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  slug: 'massage-suedois',
  name: 'Massage suédois',
  description: 'Un classique.',
  category: null,
  durationMinutes: 60,
  bufferBeforeMinutes: 10,
  bufferAfterMinutes: 5,
  occupiedMinutes: 75,
  price: { amountMinor: 3500, currency: 'EUR' },
  isActive: true,
  assignedStaffCount: 1,
  activeAssignedStaffCount: 1,
};

const PROFILE = { id: 'u1', role: 'manager' } as SessionUser;

beforeEach(() => {
  fetchServices.mockResolvedValue([SERVICE]);
  fetchOwnProfile.mockResolvedValue(PROFILE);
  fetchPublicServices.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  fetchServices.mockReset();
  fetchOwnProfile.mockReset();
  fetchPublicServices.mockReset();
  createServiceAction.mockReset();
  createServiceCategoryAction.mockReset();
});

async function openCatalog(): Promise<React.ReactElement> {
  return CatalogPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve({}),
  }) as unknown as Promise<React.ReactElement>;
}

describe('la règle de lint anti-texte-en-dur couvre le périmètre du catalogue', () => {
  /**
   * Le premier critère de #849 ne demande pas seulement que les textes soient au
   * catalogue : il demande que la **règle soit active** sur ce périmètre. Sans
   * cette garde, retirer le marqueur — ou le bloc de ce ticket du marqueur
   * **partagé** de `admin/components/`, que quatre tickets d'écrans complètent —
   * ne ferait échouer aucun test : `eslint` passerait simplement sans rien
   * regarder, et le premier libellé réécrit en dur reviendrait sans un mot.
   */
  it('vise le sous-arbre des écrans et les cinq briques du catalogue', async () => {
    const { i18nLintedGlobs } = await import('../../eslint-rules/i18n-markers.mjs');
    const globs: readonly string[] = i18nLintedGlobs(path.join(here, '..', '..'));
    const admin = 'app/\\(admin\\)/\\[tenantSlug\\]/admin';

    expect(globs).toContain(`${admin}/catalogue/**/*.{ts,tsx}`);
    for (const brick of [
      'catalog-status-badge.tsx',
      'category-manager.tsx',
      'service-activation-button.tsx',
      'service-form.tsx',
      'service-staff-panel.tsx',
    ]) {
      expect(globs).toContain(`${admin}/components/${brick}`);
    }
  });
});

describe('la liste du catalogue, rendue en anglais', () => {
  it('nomme l’écran, ses filtres et ses huit colonnes dans la langue de la session', async () => {
    render(await openCatalog());

    expect(screen.getByRole('heading', { name: 'Service catalogue' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Active only' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'New service' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Buffers before / after' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Time blocked' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Price' })).toBeDefined();
  });

  it('met durées et prix en forme selon la langue, sans changer le montant', async () => {
    render(await openCatalog());

    // « 1 h » en français, « 1 hr » en anglais : les mots de la durée viennent de
    // `messages/<langue>/format.json`.
    expect(screen.getByText('1 hr')).toBeDefined();
    expect(screen.getByText('1 hr 15')).toBeDefined();
    // 3500 centimes d'euro, mis en forme en `en-US` — le montant n'a pas bougé,
    // seule son écriture suit la langue.
    expect(screen.getByText('€35.00')).toBeDefined();
    // L'unité des tampons vient du catalogue, pas du JSX.
    expect(screen.getByText('10 / 5 min')).toBeDefined();
  });

  it('rend le nom saisi par le salon tel quel, et ne traduit que « Unclassified »', async () => {
    render(await openCatalog());

    expect(screen.getByRole('link', { name: 'Massage suédois' })).toBeDefined();
    // La prestation n'a pas de rubrique : le mot manquant est celui du produit.
    expect(screen.getByText('Unclassified')).toBeDefined();
  });

  /**
   * Ce que cette suite **ne** tient **pas**, et pourquoi.
   *
   * `ServiceBookabilityBadge` est rendu par cette liste et reste en français :
   * « Aucun praticien — pas de créneau en ligne » s'affiche au milieu de colonnes
   * anglaises, constat fait au navigateur pendant la recette de #849. Le fichier
   * est hors de l'empreinte de ce ticket — l'issue ne le nomme pas, et aucun
   * ticket de l'épique #843 ne le revendique —, si bien que la correction part en
   * suivi plutôt que d'élargir ce diff. La règle de lint ne l'aurait pas attrapé
   * non plus : le libellé passe par une constante, pas par un texte de JSX.
   */
  it('dit le catalogue vide dans la langue, selon le rang qui regarde', async () => {
    fetchServices.mockResolvedValue([]);
    render(await openCatalog());

    expect(screen.getByText('Empty catalogue')).toBeDefined();
    expect(
      screen.getByText(/Create your first service so the salon’s public page/),
    ).toBeDefined();
  });
});

describe('le formulaire de prestation, rendu en anglais', () => {
  it('nomme ses champs, et porte le code devise dans l’étiquette du prix', () => {
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    expect(screen.getByLabelText(/Service name/)).toBeDefined();
    expect(screen.getByLabelText(/Treatment duration \(minutes\)/)).toBeDefined();
    // Le code devise est explicite, jamais un symbole seul : c'est ce que la
    // règle « montants entiers avec code devise » demande de l'écran.
    expect(screen.getByLabelText(/Price \(EUR\)/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create the service' })).toBeDefined();
  });

  it('annonce la durée bloquée dans la langue, l’unité comprise', () => {
    render(
      <ServiceForm
        tenantSlug={SLUG}
        currency="EUR"
        categories={CATEGORIES}
        service={SERVICE}
      />,
    );

    // 60 + 10 + 5 minutes, dites avec les mots de l'anglais.
    expect(screen.getByText('1 hr 15')).toBeDefined();
    expect(screen.getByText(/Time blocked on the agenda/)).toBeDefined();
  });

  it('propose les rubriques du salon sous leur nom saisi, jamais traduit', () => {
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    const select = screen.getByLabelText(/Section/) as HTMLSelectElement;

    expect([...select.options].map((option) => option.text)).toEqual([
      'Unclassified',
      'Soins du visage',
    ]);
  });

  it('refuse un montant hors devise dans la langue de l’écran, sur le champ', async () => {
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '35.005');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    const message = await screen.findByText(/an amount in the salon’s currency is expected/i);

    expect(screen.getByLabelText(/Price \(EUR\)/).getAttribute('aria-describedby')).toContain(
      message.id,
    );
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  /**
   * Les deux refus que le **contrat partagé** écrit lui-même — « ce champ est
   * obligatoire », « slug attendu en minuscules… ».
   *
   * `zodErrorMap` ne les traduit pas, par conception (`zod-messages.ts`) : ils
   * s'affichaient en français sous un formulaire anglais, constat fait au
   * navigateur pendant la recette de #849. Le formulaire porte donc ses propres
   * phrases pour ces deux champs, la règle restant celle du contrat.
   */
  it('dit le champ obligatoire dans la langue, et non dans celle du contrat', async () => {
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '20');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(await screen.findByText('this field is required')).toBeDefined();
    expect(screen.queryByText('ce champ est obligatoire')).toBeNull();
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  it('dit l’adresse publique mal formée dans la langue, et la normalise', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: SERVICE });
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '20');
    await user.type(screen.getByLabelText(/Public address/), 'Pas Un Slug!');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(
      await screen.findByText(
        'an address in lowercase letters, digits and single hyphens is expected',
      ),
    ).toBeDefined();
    expect(screen.queryByText(/slug attendu en minuscules/)).toBeNull();
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  /*
   * Les trois causes de refus de `slugSchema` se disent séparément : « minuscules,
   * chiffres et tirets simples » sous `www` serait faux — l'adresse n'a que des
   * minuscules —, et la gérante n'aurait aucun moyen d'apprendre qu'elle vient de
   * saisir un nom réservé de la plateforme.
   */
  it('dit le nom réservé pour ce qu’il est, et non une faute de forme', async () => {
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '20');
    await user.type(screen.getByLabelText(/Public address/), 'www');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(
      await screen.findByText('this name is reserved by the platform — choose another one'),
    ).toBeDefined();
    expect(
      screen.queryByText(
        'an address in lowercase letters, digits and single hyphens is expected',
      ),
    ).toBeNull();
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  it('dit l’adresse trop longue avec sa borne, jamais dans la langue de zod', async () => {
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '20');
    await user.type(screen.getByLabelText(/Public address/), 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(await screen.findByText('this address is 63 characters at most')).toBeDefined();
    // Le message par défaut de zod, en anglais brut, ne doit plus remonter.
    expect(screen.queryByText(/String must contain at most/)).toBeNull();
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  it('met l’adresse publique en minuscules avant de l’envoyer — la règle du contrat', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: SERVICE });
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '20');
    await user.type(screen.getByLabelText(/Public address/), 'Gommage-Corps');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    // `slugSchema` normalisait déjà ainsi : reprendre son verdict sans reprendre
    // sa mise en forme aurait envoyé « Gommage-Corps » à l'API.
    expect(createServiceAction).toHaveBeenCalledWith(
      SLUG,
      expect.objectContaining({ slug: 'gommage-corps' }),
    );
  });

  it('refuse une durée nulle dans la langue de l’écran', async () => {
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '0');
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '20');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(await screen.findByText('a duration must be strictly positive')).toBeDefined();
    expect(createServiceAction).not.toHaveBeenCalled();
  });

  it('envoie un entier et son code devise, quel que soit le séparateur saisi', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: SERVICE });
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Scrub');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    // Le point décimal de l'anglais : `parseAmountInput` accepte les deux
    // séparateurs, et rend le même entier.
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '19.90');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(createServiceAction).toHaveBeenCalledWith(SLUG, {
      name: 'Scrub',
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      price: { amountMinor: 1990, currency: 'EUR' },
    });
  });

  /**
   * L'aller-retour affichage → édition → soumission, sur un écran anglais (#1123).
   *
   * Le champ était pré-rempli avec la virgule décimale du français quelle que soit
   * la langue : la fiche annonçait « €35.00 » juste à côté d'un champ « 35,00 ».
   */
  it('pré-remplit le prix avec le séparateur décimal de la langue', () => {
    render(
      <ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} service={SERVICE} />,
    );

    const price = screen.getByLabelText(/Price \(EUR\)/) as HTMLInputElement;

    expect(price.value).toBe('35.00');
    // Le gabarit du champ emploie le même séparateur : proposer une forme pour en
    // refuser une autre est exactement ce que ce ticket corrige.
    expect(price.getAttribute('placeholder')).toBe('35.00');
  });

  it('accepte le montant recopié depuis l’affichage anglais, virgule de milliers comprise', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: SERVICE });
    const user = userEvent.setup();
    render(<ServiceForm tenantSlug={SLUG} currency="EUR" categories={CATEGORIES} />);

    await user.type(screen.getByLabelText(/Service name/), 'Day pass');
    await user.type(screen.getByLabelText(/Treatment duration/), '30');
    // « €1,200.00 » recopié depuis l'écran, symbole retiré : la virgule y groupe
    // les milliers, et le champ la refusait.
    await user.type(screen.getByLabelText(/Price \(EUR\)/), '1,200.00');
    await user.click(screen.getByRole('button', { name: 'Create the service' }));

    expect(createServiceAction).toHaveBeenCalledWith(
      SLUG,
      expect.objectContaining({ price: { amountMinor: 120000, currency: 'EUR' } }),
    );
  });
});

describe('le panneau des praticiens, rendu en anglais', () => {
  it('nomme ses états et ses bascules, et laisse les noms tels qu’ils sont saisis', () => {
    render(
      <ServiceStaffPanel
        tenantSlug={SLUG}
        serviceId={SERVICE.id}
        staff={[
          { id: 's1', displayName: 'Hanta Rakoto', isActive: true, assigned: true },
          { id: 's2', displayName: 'Émilie Durand', isActive: false, assigned: false },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Practitioners' })).toBeDefined();
    expect(screen.getByText('Assigned')).toBeDefined();
    expect(screen.getByText('Account disabled')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove Hanta Rakoto' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Assign Émilie Durand' })).toBeDefined();
  });

  it('dit l’absence de fiche praticien plutôt que de rendre une liste sans ligne', () => {
    render(<ServiceStaffPanel tenantSlug={SLUG} serviceId={SERVICE.id} staff={[]} />);

    expect(screen.getByText('No practitioner record')).toBeDefined();
  });
});

describe('les rubriques, rendues en anglais', () => {
  it('nomme le formulaire, le tableau et ses colonnes dans la langue de la session', () => {
    render(<CategoryManager tenantSlug={SLUG} categories={CATEGORIES} />);

    expect(screen.getByRole('heading', { name: 'New section' })).toBeDefined();
    expect(screen.getByLabelText(/Section name/)).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Public address' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create the section' })).toBeDefined();
    // Le nom et l'adresse de la rubrique sont la saisie du salon.
    expect(screen.getByRole('link', { name: 'Soins du visage' })).toBeDefined();
    expect(screen.getByText('soins-du-visage')).toBeDefined();
  });

  it('insère le nom saisi dans le bandeau de création, sans le traduire', async () => {
    createServiceCategoryAction.mockResolvedValue({ ok: true, data: CATEGORIES[0] });
    const user = userEvent.setup();
    render(<CategoryManager tenantSlug={SLUG} categories={[]} />);

    await user.type(screen.getByLabelText(/Section name/), 'Soins du visage');
    await user.click(screen.getByRole('button', { name: 'Create the section' }));

    expect(await screen.findByText('Section “Soins du visage” created')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open the section' })).toBeDefined();
  });

  it('dit l’état vide dans la langue', () => {
    render(<CategoryManager tenantSlug={SLUG} categories={[]} />);

    expect(screen.getByText('No section')).toBeDefined();
  });

  it('dit les refus du contrat dans la langue, comme la fiche d’une prestation', async () => {
    const user = userEvent.setup();
    render(<CategoryManager tenantSlug={SLUG} categories={[]} />);

    await user.type(screen.getByLabelText(/Public address/), 'Pas Un Slug!');
    await user.click(screen.getByRole('button', { name: 'Create the section' }));

    expect(await screen.findByText('this field is required')).toBeDefined();
    expect(
      screen.getByText('an address in lowercase letters, digits and single hyphens is expected'),
    ).toBeDefined();
    expect(createServiceCategoryAction).not.toHaveBeenCalled();
  });
});

describe('l’aperçu de la vitrine, rendu en anglais', () => {
  /** Une prestation active qu'aucun praticien ne pratique — le cas de l'encart. */
  const PUBLIC_SERVICE = {
    id: SERVICE.id,
    slug: SERVICE.slug,
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    price: { amountMinor: 3500, currency: 'EUR' },
    staff: [],
  } as unknown as PublicService;

  async function openPreview(): Promise<React.ReactElement> {
    return CatalogPreviewPage({
      params: Promise.resolve({ tenantSlug: SLUG }),
    }) as unknown as Promise<React.ReactElement>;
  }

  it('s’affiche dans la langue choisie, chrome et vitrine comprises', async () => {
    fetchPublicServices.mockResolvedValue([PUBLIC_SERVICE]);
    render(await openPreview());

    expect(screen.getByRole('heading', { name: 'Preview of the public rendering' })).toBeDefined();
    expect(screen.getByText('What the client sees')).toBeDefined();
    // `ServiceCatalog` est le composant de la vitrine : c'est lui qui prouve que
    // l'aperçu suit la langue, et non une imitation de l'aperçu.
    expect(screen.getByRole('heading', { name: 'Our services' })).toBeDefined();
    expect(screen.getByText('Massage suédois')).toBeDefined();
    expect(screen.getByText('€35.00')).toBeDefined();
  });

  it('cite la mention de la vitrine dans la langue, et non une copie française', async () => {
    fetchPublicServices.mockResolvedValue([PUBLIC_SERVICE]);
    render(await openPreview());

    // La même clé que la ligne du catalogue public : deux écritures finiraient
    // par diverger, et l'encart décrirait un état que la carte ne montre pas.
    const mention = 'No practitioner — no slot bookable online';

    expect(screen.getByText(new RegExp(`“${mention}”`))).toBeDefined();
    expect(screen.getAllByText(mention).length).toBeGreaterThan(0);
    // « Compte désactivé » est lu sur le namespace de ce ticket, où la fiche de la
    // prestation l'écrit déjà.
    expect(screen.getByText(/“Account disabled”/)).toBeDefined();
  });
});
