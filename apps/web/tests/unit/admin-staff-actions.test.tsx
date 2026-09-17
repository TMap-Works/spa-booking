import type { StaffAccountState, StaffMember, SessionUser } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Les actions de l'écran du personnel — audit `d20260916-1`, issue #766.
 *
 * ## Ce que l'audit a relevé
 *
 * À 1280 px, rien au-dessus de la ligne de flottaison de /personnel n'était une
 * action : l'écran ouvrait sur deux listes. Les deux boutons accentués — « Créer
 * la fiche » et « Inviter » — concluaient deux formulaires déployés en
 * permanence à quelque 700 et 1 050 px de défilement, de poids visuel identique
 * et sans hiérarchie entre eux. La maquette du dépôt
 * (`mockups/admin/personnel.html`) pose pourtant, à côté du `<h1>`, une barre
 * d'actions à **un seul** bouton accentué, et c'est aussi ce que /catalogue fait
 * avec « Nouvelle prestation ».
 *
 * ## Ce que ces cas tiennent
 *
 * Trois choses, et ce sont exactement les trois que l'audit demandait :
 *
 * - **une action est en tête d'écran**, avant la première liste — c'est le
 *   critère `ds:hierarchie`, et il se prouve par l'ordre du document plutôt que
 *   par un décompte de pixels qu'aucun test unitaire ne sait mesurer ;
 * - **une seule est accentuée**, l'autre est secondaire ;
 * - **les formulaires ne sont plus sur la liste** : ils ont leur écran, et ces
 *   écrans relisent le rang, parce qu'une adresse se saisit et qu'un signet se
 *   garde.
 *
 * Les rendus sont ceux de Server Components : on les appelle, puis on rend ce
 * qu'ils ont produit. Le transport — jetons, redirections — est doublé.
 */

const fetchOwnProfile = vi.fn();
const fetchStaffAccounts = vi.fn();
const fetchStaffMembers = vi.fn();
const adminLoadFailure = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées : les écrans
// s'appuient sur `ApiClientError`, qui doit rester la vraie classe.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchStaffAccounts: (...args: unknown[]) => fetchStaffAccounts(...args),
  fetchStaffMembers: (...args: unknown[]) => fetchStaffMembers(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-du-comptoir'),
  adminLoadFailure: (...args: unknown[]) => {
    adminLoadFailure(...args);
    return null;
  },
}));

// Les trois composants client de ces écrans appellent des actions serveur, qui
// n'existent pas hors du serveur.
vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  changeStaffAccountRoleAction: vi.fn(),
  createStaffMemberAction: vi.fn(),
  inviteStaffAccountAction: vi.fn(),
  reissueStaffInvitationAction: vi.fn(),
  setStaffAccountStatusAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/${SLUG}/admin/personnel`,
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

import InviteStaffPage from '@/app/(admin)/[tenantSlug]/admin/personnel/inviter/page';
import StaffPage from '@/app/(admin)/[tenantSlug]/admin/personnel/(liste)/page';
import NewStaffMemberPage from '@/app/(admin)/[tenantSlug]/admin/personnel/nouveau/page';

const SLUG = 'salon-lotus';
const PERSONNEL = `/${SLUG}/admin/personnel`;

const LEA: StaffAccountState = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'lea@salon-lotus.test',
  role: 'staff',
  firstName: 'Léa',
  lastName: 'Praticienne',
  phone: null,
  isActive: true,
};

const HANTA: StaffMember = {
  id: '33333333-3333-4333-8333-333333333333',
  displayName: 'Hanta R.',
  isActive: true,
};

function profil(role: SessionUser['role']): SessionUser {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    email: `${role}@salon-lotus.test`,
    role,
    firstName: 'Hasina',
    lastName: 'Rakoto',
    phone: null,
  } as SessionUser;
}

async function ouvrirLaListe(role: SessionUser['role'] = 'admin'): Promise<void> {
  fetchOwnProfile.mockResolvedValue(profil(role));
  render(await StaffPage({ params: Promise.resolve({ tenantSlug: SLUG }) }));
}

beforeEach(() => {
  fetchStaffAccounts.mockResolvedValue([LEA]);
  fetchStaffMembers.mockResolvedValue([HANTA]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('/personnel — l’action principale est en tête d’écran', () => {
  it('pose la barre d’outils entre le titre et la première liste', async () => {
    await ouvrirLaListe();

    const barre = document.querySelector('.spa-admin-toolbar');
    const titre = screen.getByRole('heading', { level: 1, name: 'Personnel et horaires' });
    const premiereListe = screen.getByRole('heading', { level: 2, name: /^Praticiens/ });

    expect(barre).not.toBeNull();
    // `DOCUMENT_POSITION_FOLLOWING` — la barre suit le titre et précède la
    // première liste. C'est la lecture de l'audit : « rien au-dessus de la ligne
    // de flottaison n'est une action ».
    expect(titre.compareDocumentPosition(barre as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      (barre as Node).compareDocumentPosition(premiereListe) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('accentue la création de fiche et laisse l’invitation en second', async () => {
    await ouvrirLaListe();

    const barre = document.querySelector('.spa-admin-toolbar') as HTMLElement;
    const creer = within(barre).getByRole('link', { name: 'Créer une fiche praticien' });
    const inviter = within(barre).getByRole('link', { name: 'Inviter un membre' });

    expect(creer.getAttribute('href')).toBe(`${PERSONNEL}/nouveau`);
    expect(creer.className).toContain('spa-button--accent');
    expect(inviter.getAttribute('href')).toBe(`${PERSONNEL}/inviter`);
    expect(inviter.className).toContain('spa-button--neutral');
    // Le défaut relevé était deux actions de même poids : une seule accentuée.
    expect(barre.querySelectorAll('.spa-button--accent')).toHaveLength(1);
  });

  it('ne déploie plus aucun formulaire sous les listes', async () => {
    await ouvrirLaListe();

    expect(screen.queryByRole('button', { name: /Créer la fiche/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Inviter$/ })).toBeNull();
    expect(screen.queryByLabelText(/Adresse électronique/)).toBeNull();
  });

  it('n’offre à la gérante que le geste que l’API lui accorde', async () => {
    await ouvrirLaListe('manager');

    expect(screen.getByRole('link', { name: 'Créer une fiche praticien' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Inviter un membre' })).toBeNull();
  });

  it('dit au rang praticien pourquoi la barre est vide, plutôt que de disparaître', async () => {
    await ouvrirLaListe('staff');

    expect(screen.queryByRole('link', { name: 'Créer une fiche praticien' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Inviter un membre' })).toBeNull();
    expect(
      screen.getByText(/réservées aux rangs gérant et administrateur/),
    ).toBeDefined();
  });

  it('amorce l’état vide des praticiens par l’action, et non par « ci-dessous »', async () => {
    fetchStaffMembers.mockResolvedValue([]);
    await ouvrirLaListe();

    const amorce = screen.getAllByRole('link', { name: 'Créer une fiche praticien' });

    // Deux au total : celle de la barre d'outils et celle de l'état vide.
    expect(amorce).toHaveLength(2);
    expect(document.body.textContent).not.toContain('ci-dessous');
  });
});

describe('/personnel/nouveau — le formulaire a son écran', () => {
  async function ouvrir(role: SessionUser['role']): Promise<void> {
    fetchOwnProfile.mockResolvedValue(profil(role));
    render(await NewStaffMemberPage({ params: Promise.resolve({ tenantSlug: SLUG }) }));
  }

  it('titre l’écran du libellé exact de l’action qui y mène', async () => {
    await ouvrir('manager');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Créer une fiche praticien' }),
    ).toBeDefined();
    // Un seul titre pour une seule chose : la carte du formulaire n'en redit pas
    // un second.
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByLabelText(/Compte à rendre réservable/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Retour au personnel' }).getAttribute('href')).toBe(
      PERSONNEL,
    );
  });

  it('ne propose pas les comptes clients au rattachement', async () => {
    fetchStaffAccounts.mockResolvedValue([LEA, { ...LEA, id: 'cliente', role: 'client' }]);
    await ouvrir('manager');

    const choix = screen.getByLabelText(/Compte à rendre réservable/) as HTMLSelectElement;

    // Le choix vide « Choisissez un compte… » plus le seul compte interne.
    expect(choix.options).toHaveLength(2);
  });

  it('dit au rang praticien que le geste ne lui revient pas, avant la première frappe', async () => {
    await ouvrir('staff');

    expect(screen.getByText(/réservée au rang gérant/)).toBeDefined();
    expect(screen.queryByLabelText(/Compte à rendre réservable/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Revenir au personnel' })).toBeDefined();
  });
});

describe('/personnel/inviter — l’invitation a son écran', () => {
  async function ouvrir(role: SessionUser['role']): Promise<void> {
    fetchOwnProfile.mockResolvedValue(profil(role));
    render(await InviteStaffPage({ params: Promise.resolve({ tenantSlug: SLUG }) }));
  }

  it('rend le formulaire d’invitation sous son propre titre', async () => {
    await ouvrir('admin');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Inviter un membre du personnel' }),
    ).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByLabelText(/Adresse électronique/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Retour au personnel' }).getAttribute('href')).toBe(
      PERSONNEL,
    );
  });

  it('borne la colonne de saisie, comme partout dans le back-office', async () => {
    await ouvrir('admin');

    expect(document.querySelector('.spa-admin-form')).not.toBeNull();
  });

  it('refuse le rang gérant, que l’API refuserait aussi', async () => {
    await ouvrir('manager');

    expect(screen.getByText(/réservée au rang administrateur/)).toBeDefined();
    expect(screen.queryByLabelText(/Adresse électronique/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Revenir au personnel' })).toBeDefined();
  });
});
