import { ERROR_CODES, LOCALES, errorMessage, type Locale, type Service } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * Un écran par module reprend la phrase qui nomme l'établissement — #1375.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * `etablissement-inconnu-cinq-modules.test.ts` exerce les **vraies** actions des
 * cinq modules : elle prouve qu'elles rendent `TENANT_NOT_FOUND`. Celle-ci monte
 * un écran de chacun et lui tend ce refus : elle prouve qu'il le **nomme**, dans
 * la langue de son rendu. Aucune des deux ne suffit seule — la première laisse
 * ouverte la possibilité d'un écran qui écraserait la phrase, la seconde celle
 * d'un refus qu'aucune action ne produit.
 *
 * ## Un écran par module, et pourquoi c'est la bonne maille
 *
 * Dix-neuf composants consomment ces cinq modules, et **aucun** ne fait le tri
 * sur `VALIDATION_ERROR` : tous rangent le seul `code` du refus et en réécrivent
 * la phrase au rendu par `refusalMessage` (`lib/refusal.ts`, #1327 et #1354),
 * dont le repli est `errorMessage(code, locale)`. Ce qui décide de la phrase est
 * donc le **code**, en un seul point, et non dix-neuf tables locales. Monter les
 * dix-neuf mesurerait dix-neuf fois la même règle ; en monter un par module
 * mesure ce que le module rend, ce qui est ce que ce ticket change.
 *
 * Les cinq retenus sont ceux dont le refus est le plus court à atteindre, un par
 * module : le bouton d'activation du catalogue, le formulaire de note d'une
 * fiche cliente, le panneau des prestations d'un praticien, le bouton d'export
 * du reporting, et les coordonnées de l'espace client — soit les deux surfaces
 * du produit, back-office et espace client.
 *
 * ## Deux moitiés par cas
 *
 * La phrase qui nomme l'établissement **et** l'absence de la tournure générique
 * du refus de validation — celle que ces écrans affichaient jusqu'ici, faute
 * d'un code qui dise autre chose. La première seule laisserait passer un écran
 * qui affiche les deux ; la seconde seule, un écran qui n'affiche plus rien.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat,
 * les catalogues du dépôt pour les libellés — et jamais recopiées : un littéral
 * resterait vert le jour où l'écran cesserait de consulter la table.
 */

const updateServiceAction = vi.fn();
const updateCustomerAction = vi.fn();
const assignStaffServiceAction = vi.fn();
const removeStaffServiceAction = vi.fn();
const createReportExportAction = vi.fn();
const updateProfileAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  updateServiceAction: (...args: unknown[]) => updateServiceAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/clients/actions', () => ({
  updateCustomerAction: (...args: unknown[]) => updateCustomerAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  assignStaffServiceAction: (...args: unknown[]) => assignStaffServiceAction(...args),
  removeStaffServiceAction: (...args: unknown[]) => removeStaffServiceAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/reporting/actions', () => ({
  createReportExportAction: (...args: unknown[]) => createReportExportAction(...args),
  refreshReportExportAction: vi.fn(),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  updateProfileAction: (...args: unknown[]) => updateProfileAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace }),
}));

vi.mock('next-intl', () => nextIntlMobile());

import { ClientNoteForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-note-form';
import { ServiceActivationButton } from '@/app/(admin)/[tenantSlug]/admin/components/service-activation-button';
import { ReportExportButton } from '@/app/(admin)/[tenantSlug]/admin/components/report-export-button';
import { StaffServicesPanel } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-services-panel';
import { ProfileForm } from '@/app/(account)/[tenantSlug]/compte/components/profile-form';

const SLUG = 'maison-lotus';
const CUSTOMER_ID = 'dddddddd-0000-4000-8000-000000000001';

/**
 * Le refus tel que les cinq modules le rendent — code du contrat, aucun
 * `details`.
 *
 * L'absence de `details` n'est pas un oubli : c'est la propriété d'un refus
 * opposé par l'action avant tout appel, et c'est ce qui l'empêche d'être pris
 * pour un refus rapporté de l'API.
 */
function refusEtablissement(locale: Locale) {
  return {
    ok: false,
    code: ERROR_CODES.TENANT_NOT_FOUND,
    message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
  } as const;
}

/** La phrase du contrat pour ce code, dans la langue du rendu. */
function phraseAttendue(locale: Locale): string {
  return errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);
}

/** Celle que ces écrans disaient à sa place, faute d'un code qui le nomme. */
function phraseEvincee(locale: Locale): string {
  return errorMessage(ERROR_CODES.VALIDATION_ERROR, locale);
}

/**
 * Un libellé du catalogue, lu là où l'écran le lit.
 *
 * Les composants de ces cinq écrans n'ont pas de table de mots hors React — à la
 * différence du planning et du comptoir, qui ont `planningWords` et
 * `checkoutWords`. Le catalogue est donc lu directement, par le même
 * `loadMessages` que le serveur emploie.
 */
function libelle(locale: Locale, chemin: string): string {
  const trouve = chemin
    .split('.')
    .reduce<string | MessageTree | undefined>(
      (noeud, cle) => (typeof noeud === 'object' ? noeud[cle] : undefined),
      loadMessages(locale),
    );

  if (typeof trouve !== 'string') {
    throw new Error(`libellé absent du catalogue « ${locale} » : ${chemin}`);
  }

  return trouve;
}

/** Un libellé transformé en motif, pour un nom accessible qui porte autre chose. */
function debut(texte: string): RegExp {
  return new RegExp(`^${texte.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
}

const MASSAGE: Service = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  slug: 'massage-suedois',
  name: 'Massage suédois',
  description: null,
  category: null,
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  occupiedMinutes: 75,
  price: { amountMinor: 3500, currency: 'EUR' },
  isActive: true,
  assignedStaffCount: 1,
  activeAssignedStaffCount: 1,
};

/** Septembre 2026 tel qu'un salon parisien le vit — ce que la page calcule. */
const FENETRE = { from: '2026-08-31T22:00:00.000Z', to: '2026-09-30T22:00:00.000Z' };

const CAMILLE = {
  id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
  email: 'camille@example.test',
  role: 'client',
  firstName: 'Camille',
  lastName: 'Rakoto',
  phone: '+261341234567',
  locale: null,
} as const;

/**
 * La zone d'état du bouton d'export — la seule surface où son refus s'écrit.
 *
 * Lue par sa classe, comme `admin-report-export-button.test.tsx` le fait : son
 * contenu change, son rôle non.
 */
function statutExport(): HTMLElement {
  const element = document.querySelector('.spa-admin-report-export__status');

  if (element === null) {
    throw new Error('la zone d’état du bouton d’export est absente du rendu');
  }

  return element as HTMLElement;
}

/** Les clics d'ancre sont neutralisés : jsdom n'a pas de gestionnaire de téléchargement. */
let clicAncre: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clicAncre = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  clicAncre.mockRestore();
  cleanup();
  vi.clearAllMocks();
  fixerLangue('fr');
});

describe.each([...LOCALES])('l’établissement inconnu, en « %s »', (locale) => {
  it('le bouton d’activation du catalogue le nomme', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    updateServiceAction.mockResolvedValue(refusEtablissement(locale));

    render(<ServiceActivationButton service={MASSAGE} tenantSlug={SLUG} />);
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-catalog.activation.deactivate')) }),
    );

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    expect(alerte.textContent).not.toContain(phraseEvincee(locale));
  });

  it('la note d’une fiche cliente le nomme', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    updateCustomerAction.mockResolvedValue(refusEtablissement(locale));

    render(<ClientNoteForm customerId={CUSTOMER_ID} internalNote={null} tenantSlug={SLUG} />);
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-clients.note.save')) }),
    );

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    expect(alerte.textContent).not.toContain(phraseEvincee(locale));
  });

  it('le panneau des prestations d’un praticien le nomme, plutôt que le conflit', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    assignStaffServiceAction.mockResolvedValue(refusEtablissement(locale));

    render(
      <StaffServicesPanel
        services={[{ id: MASSAGE.id, name: MASSAGE.name, isActive: true, assigned: false }]}
        staffId="staff-hasina"
        tenantSlug={SLUG}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-staff.services.assign')) }),
    );

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    expect(alerte.textContent).not.toContain(phraseEvincee(locale));
    // Le seul refus que ce panneau nomme lui-même est le conflit d'affectation :
    // il ne doit pas déborder sur un refus qui n'est pas le sien.
    expect(alerte.textContent).not.toContain(libelle(locale, 'admin-staff.services.conflict'));
  });

  it('le bouton d’export du reporting le nomme, dans son gabarit d’échec', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    createReportExportAction.mockResolvedValue(refusEtablissement(locale));

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'admin-reporting.export.label')) }),
    );

    // L'écran enveloppe la phrase du code dans « L'export n'a pas pu être
    // produit : {message} » : c'est bien la phrase du contrat qui y entre.
    expect(statutExport().textContent).toContain(phraseAttendue(locale));
    expect(statutExport().textContent).not.toContain(phraseEvincee(locale));
    expect(statutExport().textContent).not.toContain(
      libelle(locale, 'admin-reporting.export.unavailable'),
    );
  });

  it('les coordonnées de l’espace client le nomment', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    updateProfileAction.mockResolvedValue(refusEtablissement(locale));

    render(<ProfileForm profile={CAMILLE} tenantSlug={SLUG} />);
    await user.type(screen.getByLabelText(debut(libelle(locale, 'account.profile.firstName'))), 'e');
    await user.click(
      screen.getByRole('button', { name: debut(libelle(locale, 'account.profile.submit')) }),
    );

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    expect(alerte.textContent).not.toContain(phraseEvincee(locale));
  });
});

/**
 * …et le refus de saisie de chaque geste n'a rien perdu.
 *
 * Ce ticket ajoute un code, il ne change pas ce que les écrans font des autres.
 * Un seul suffit à le prouver — la règle est la même pour les dix-neuf, puisque
 * c'est le repli de `refusalMessage` qui décide, et il est écrit une fois.
 */
describe('le refus de saisie du geste garde sa phrase', () => {
  it('le catalogue dit toujours la tournure du refus de validation', async () => {
    const user = userEvent.setup();
    updateServiceAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'),
    });

    render(<ServiceActivationButton service={MASSAGE} tenantSlug={SLUG} />);
    await user.click(
      screen.getByRole('button', { name: debut(libelle('fr', 'admin-catalog.activation.deactivate')) }),
    );

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseEvincee('fr'));
    expect(alerte.textContent).not.toContain(phraseAttendue('fr'));
  });
});
