import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Service, ServiceCategory } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdminAnnouncementProvider,
  AdminAnnouncementRegion,
} from '@/app/(admin)/[tenantSlug]/admin/components/admin-announcement';
import { ServiceForm } from '@/app/(admin)/[tenantSlug]/admin/components/service-form';

/**
 * L'annonce d'une création menée à son terme dans le back-office — #1037.
 *
 * Le défaut relevé par l'audit `d20260917-2` (`ds:etats`) : « Créer la
 * prestation » faisait un `router.push` nu vers la fiche, qui s'ouvrait **sans un
 * mot**. Rien ne distinguait une prestation qu'on venait de créer d'une
 * prestation qu'on venait d'ouvrir depuis le catalogue.
 *
 * Ce que cette suite protège — et c'est plus étroit que « un message s'affiche » :
 *
 * - la région `aria-live` **existe avant** le message. Une région insérée avec
 *   son message n'est annoncée par aucun lecteur d'écran de façon fiable, et
 *   WCAG 2.2 AA 4.1.3 exige un message d'état *programmatiquement déterminable*.
 *   L'assertion n'est donc pas « la région contient le texte » mais **« c'est le
 *   même nœud du DOM qu'avant le geste »** — un `toBe` d'identité, la seule forme
 *   qu'une réécriture ne peut pas satisfaire par accident ;
 * - le **layout** la monte, et non la fiche : c'est ce qui la fait survivre au
 *   `router.push`. Vérifié à la source, faute de pouvoir rendre un layout qui lit
 *   un cookie de session ;
 * - la création n'annonce rien sur l'écran qu'elle quitte, et son annonce
 *   **nomme** la prestation obtenue et offre le geste suivant ;
 * - l'ancre offerte existe bien sur l'écran d'arrivée — un lien mort serait pire
 *   que pas de lien ;
 * - une annonce lue puis quittée ne se rallume pas au retour ;
 * - l'enregistrement d'une prestation **existante** reste annoncé où il l'était,
 *   dans le formulaire : l'écran ne bouge pas, et faire transiter ce bandeau-là
 *   par la région aurait déplacé un message qui allait bien.
 */

const createServiceAction = vi.fn();
const updateServiceAction = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

const TENANT = 'salon-des-lilas';
const SERVICE_ID = 'b7e1c2d3-2222-4c53-8f0e-1b2c3d4e5f60';
const NOUVEAU = `/${TENANT}/admin/catalogue/nouveau`;
const FICHE = `/${TENANT}/admin/catalogue/${SERVICE_ID}`;
const CALENDRIER = `/${TENANT}/admin/calendrier`;

/**
 * Le chemin courant, piloté par le test.
 *
 * C'est lui qui joue la navigation : `router.push` est un double, et ce qui est
 * éprouvé n'est pas le routeur mais ce que la région fait **quand le chemin
 * change sans que le layout soit démonté** — exactement ce que l'App Router fait
 * d'un écran à l'autre du segment `admin`. Un nouveau `render()` remonterait la
 * région et prouverait le contraire de ce qu'on cherche.
 */
let pathname = NOUVEAU;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  usePathname: () => pathname,
}));

// Les actions serveur sont des modules Next qui n'existent pas hors du serveur.
vi.mock('@/app/(admin)/[tenantSlug]/admin/catalogue/actions', () => ({
  createServiceAction: (...args: unknown[]) => createServiceAction(...args),
  updateServiceAction: (...args: unknown[]) => updateServiceAction(...args),
}));

afterEach(() => {
  cleanup();
  pathname = NOUVEAU;
  createServiceAction.mockReset();
  updateServiceAction.mockReset();
  push.mockReset();
  refresh.mockReset();
});

const categories: ServiceCategory[] = [
  {
    id: '0a5b1e6c-1111-4c53-8f0e-1b2c3d4e5f60',
    slug: 'soins-du-visage',
    name: 'Soins du visage',
    description: null,
    isActive: true,
  },
];

const service: Service = {
  id: SERVICE_ID,
  slug: 'gommage-corps',
  name: 'Gommage corps',
  description: null,
  category: null,
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  occupiedMinutes: 30,
  price: { amountMinor: 2000, currency: 'EUR' },
  isActive: true,
  assignedStaffCount: 0,
  activeAssignedStaffCount: 0,
};

/**
 * Le back-office tel que le layout le monte : le fournisseur au-dessus, la
 * région en tête du contenu, l'écran dessous.
 */
function backOffice(children: ReactNode): ReactNode {
  return (
    <AdminAnnouncementProvider>
      <AdminAnnouncementRegion />
      {children}
    </AdminAnnouncementProvider>
  );
}

function ecranDeCreation(): ReactNode {
  return backOffice(
    <ServiceForm tenantSlug={TENANT} currency="EUR" categories={categories} />,
  );
}

/** La fiche d'arrivée, réduite à ce que la région a besoin de traverser. */
function fiche(): ReactNode {
  return backOffice(
    <ServiceForm
      tenantSlug={TENANT}
      currency="EUR"
      categories={categories}
      service={service}
    />,
  );
}

/**
 * La région, désignée par ce qui la rend annonçable et par rien d'autre.
 *
 * Pas par un rôle ni par un texte : le bandeau qu'elle finit par contenir porte
 * lui aussi `role="status"`, et la région est vide la plupart du temps. C'est
 * l'attribut `aria-live` qui est l'objet du ticket.
 */
function region(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[aria-live="polite"]');

  if (found === null) {
    throw new Error('aucune région aria-live dans le back-office');
  }

  return found;
}

/** Remplit le minimum qu'exige le formulaire et soumet la création. */
async function creer(user: ReturnType<typeof userEvent.setup>, nom: string): Promise<void> {
  await user.type(screen.getByLabelText(/Nom de la prestation/), nom);
  await user.type(screen.getByLabelText(/Durée du soin/), '30');
  await user.type(screen.getByLabelText(/Prix/), '20');
  await user.click(screen.getByRole('button', { name: /Créer la prestation/ }));
}

function source(relative: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  return readFileSync(path.join(here, '..', '..', relative), 'utf8');
}

describe('back-office — la région d’annonce est posée d’avance (#1037)', () => {
  it('sort du rendu serveur, vide, avant tout geste', () => {
    const markup = renderToStaticMarkup(ecranDeCreation());

    // Le formulaire est bien rendu : sans cette assertion, celles du dessous
    // seraient vertes même si l'écran ne rendait rien.
    expect(markup).toContain('Créer la prestation');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    // Vide, et hors du flux : une région qui consommerait une gouttière de
    // `.spa-admin__content` poserait du blanc au-dessus du titre des sept écrans
    // du back-office, pour ne rien dire.
    expect(markup).toContain('spa-visually-hidden');
    expect(markup).not.toContain('spa-notification');
  });

  it('est montée par le layout, seul point que la navigation ne démonte pas', () => {
    // Le layout lit un cookie de session : il ne se rend pas ici. Ce qui se
    // vérifie est donc le câblage, et il est le cœur du ticket — la même région
    // posée par la fiche serait remontée à chaque navigation, donc muette.
    const layout = source('app/(admin)/[tenantSlug]/admin/layout.tsx');

    expect(layout).toContain('AdminAnnouncementProvider');
    expect(layout).toContain('<AdminAnnouncementRegion />');
  });
});

describe('back-office — la prestation créée s’annonce sur sa fiche', () => {
  it('attend la fiche, puis écrit dans la région qui a traversé la navigation', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: service });
    const { container, rerender } = render(ecranDeCreation());
    const user = userEvent.setup();

    const avant = region(container);
    expect(avant.textContent).toBe('');

    await creer(user, 'Gommage corps');

    expect(push).toHaveBeenCalledWith(FICHE);
    // Rien sur l'écran qu'on quitte : un bandeau de succès posé une demi-seconde
    // au-dessus du formulaire de création se lirait comme une seconde création.
    expect(region(container).textContent).toBe('');

    // La navigation : le chemin change, le layout reste — donc la région aussi.
    pathname = FICHE;
    rerender(fiche());

    const apres = region(container);

    // Le cœur du ticket : **le même nœud**. Une région insérée avec son message
    // passerait l'assertion de texte et raterait celle-ci — et ne serait annoncée
    // par aucun lecteur d'écran (WCAG 2.2 AA 4.1.3).
    expect(apres).toBe(avant);
    // Elle **nomme** l'objet créé : « c'est fait » ne dit pas quoi.
    expect(apres.textContent).toContain('Prestation « Gommage corps » créée');
  });

  it('offre le geste suivant, vers une ancre qui existe sur la fiche', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: service });
    const { rerender } = render(ecranDeCreation());
    const user = userEvent.setup();

    await creer(user, 'Gommage corps');
    pathname = FICHE;
    rerender(fiche());

    const lien = screen.getByRole('link', { name: 'Affecter un praticien' });

    expect(lien.getAttribute('href')).toBe('#prestation-praticiens');
    // Un lien mort serait pire que pas de lien : la cible est bien l'en-tête du
    // panneau des praticiens, rendu par la fiche sous ce même identifiant.
    expect(source('app/(admin)/[tenantSlug]/admin/components/service-staff-panel.tsx')).toContain(
      'id="prestation-praticiens"',
    );
  });

  it('nomme la prestation telle que l’API l’a enregistrée, pas telle qu’elle a été tapée', async () => {
    // Le serveur normalise — il dérive le slug, rogne les espaces. C'est sa
    // réponse qui fait foi de ce qui existe désormais au catalogue.
    createServiceAction.mockResolvedValue({ ok: true, data: { ...service, name: 'Gommage corps' } });
    const { container, rerender } = render(ecranDeCreation());
    const user = userEvent.setup();

    await creer(user, 'Gommage corps   ');
    pathname = FICHE;
    rerender(fiche());

    expect(region(container).textContent).toContain('Prestation « Gommage corps » créée');
  });

  it('n’annonce rien quand la création échoue', async () => {
    createServiceAction.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'La prestation saisie est invalide.',
    });
    const { container, rerender } = render(ecranDeCreation());
    const user = userEvent.setup();

    await creer(user, 'Gommage corps');

    expect(await screen.findByText('La prestation saisie est invalide.')).toBeDefined();
    expect(push).not.toHaveBeenCalled();

    // Même en ouvrant une fiche de son propre chef, il n'y a rien à annoncer :
    // aucune prestation n'a été créée.
    pathname = FICHE;
    rerender(fiche());

    expect(region(container).textContent).toBe('');
  });

  it('s’efface au premier détour, plutôt que de se rallumer au retour', async () => {
    createServiceAction.mockResolvedValue({ ok: true, data: service });
    const { container, rerender } = render(ecranDeCreation());
    const user = userEvent.setup();

    await creer(user, 'Gommage corps');
    pathname = FICHE;
    rerender(fiche());
    expect(region(container).textContent).toContain('Prestation « Gommage corps » créée');

    // Un détour par le planning, puis retour sur la fiche par le catalogue. Le
    // layout n'est pas démonté : sans l'oubli, le bandeau se rallumerait
    // longtemps après le geste.
    pathname = CALENDRIER;
    rerender(backOffice(null));
    expect(region(container).textContent).toBe('');

    pathname = FICHE;
    rerender(fiche());
    expect(region(container).textContent).toBe('');
  });
});

describe('back-office — l’enregistrement d’une prestation existante ne bouge pas', () => {
  it('garde son bandeau dans le formulaire, et laisse la région vide', async () => {
    // Non-régression : l'écran ne change pas, l'état local suffit, et faire
    // transiter ce bandeau-là par la région aurait déplacé un message qui allait
    // bien — et l'aurait fait disparaître au premier changement de chemin.
    updateServiceAction.mockResolvedValue({ ok: true, data: service });
    pathname = FICHE;
    const { container } = render(fiche());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(await screen.findByText('Prestation enregistrée')).toBeDefined();
    expect(region(container).textContent).toBe('');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
