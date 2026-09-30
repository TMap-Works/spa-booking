import { ERROR_CODES, errorMessage } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientPicker } from '@/app/(admin)/[tenantSlug]/admin/components/client-picker';
// Les deux phrases du sélecteur sont **lues** dans son catalogue, jamais
// recopiées : une suite qui citerait le littéral resterait verte le jour où
// l'écran cesserait de consulter la table.
import planningFr from '@/messages/fr/admin-planning.json';

/**
 * Le sélecteur de fiche cliente ne prête ses phrases qu'à ses propres refus — #1369.
 *
 * ## Le défaut que cette suite ferme
 *
 * `client-picker.tsx` range son refus avec un discriminant de geste depuis
 * #1354 : il dit **laquelle** des deux phrases de l'écran s'applique — « la
 * recherche est invalide » ou « la fiche client est invalide » —, parce que les
 * deux gestes partagent un seul emplacement d'erreur. Il ne disait pas que le
 * refus était bien celui que l'action avait opposé **avant tout appel** :
 * `searchDeskClientsAction` et `createDeskClientAction` rapportent aussi les 400
 * de l'API, qui portent exactement le même `VALIDATION_ERROR`. Un champ du corps
 * refusé par le DTO s'affichait donc sous la phrase de l'écran, qu'il n'était
 * pas.
 *
 * Ce qui les sépare est le `details` : `invalid()` n'en pose aucun, quand
 * `failure()` transporte toujours celui du corps d'erreur de l'API
 * (`action-result.ts`). C'est la garde que #1367 a posée sur les trois autres
 * écrans, et ces quatre cas l'éprouvent des deux côtés, geste par geste.
 *
 * ## Une suite à elle, plutôt que des cas ajoutés au tiroir
 *
 * Le composant est monté **directement**, et non par `AppointmentPanel` : ce qui
 * est éprouvé ici est la phrase d'un refus, et la traverser par le tiroir aurait
 * demandé un créneau, un praticien et une prestation qui n'y sont pour rien.
 */

const searchDeskClientsAction = vi.fn();
const createDeskClientAction = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  searchDeskClientsAction: (...args: unknown[]) => searchDeskClientsAction(...args),
  createDeskClientAction: (...args: unknown[]) => createDeskClientAction(...args),
}));

const SLUG = 'maison-lotus';

/** La tournure générique du contrat — celle qui avalait les phrases de l'écran. */
const GENERIQUE = errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr');

/** Le refus que l'action oppose elle-même : `invalid()` ne pose aucun `details`. */
const REFUS_DE_SAISIE = {
  ok: false,
  code: ERROR_CODES.VALIDATION_ERROR,
  message: GENERIQUE,
} as const;

/**
 * Le 400 que l'API a rendu et que l'action n'a fait que rapporter.
 *
 * `details` est ce que `failure()` transporte du corps d'erreur — ici les
 * violations que le DTO a nommées. Ce n'est pas l'écran qui les affiche : c'est
 * leur **présence** qui dit que le refus vient de l'API, et donc que la phrase à
 * rendre est celle du contrat partagé et non celle du geste.
 */
const REFUS_DE_L_API = {
  ...REFUS_DE_SAISIE,
  details: { violations: ['email : adresse électronique attendue'] },
} as const;

function renderPicker() {
  const onSelect = vi.fn();
  const onExpired = vi.fn();

  render(
    <ClientPicker
      onExpired={onExpired}
      onSelect={onSelect}
      selected={null}
      tenantSlug={SLUG}
    />,
  );

  return { onSelect, onExpired };
}

/** Lance la recherche : le champ est différé de 300 ms, et borné à deux caractères. */
async function chercher(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/^Client/), 'Rina');
}

/**
 * Ouvre le formulaire de création et le soumet.
 *
 * Il n'est atteignable que par une recherche qui ne rend rien — c'est l'état
 * vide qui porte le bouton « Créer la fiche » —, d'où la recherche passante en
 * amont. Le téléphone reste vide : il est facultatif, et le laisser de côté
 * évite que le verdict de `e164PhoneSchema` n'arrête la soumission avant l'appel.
 */
async function creerLaFiche(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [] } });
  await chercher(user);

  await user.click(await screen.findByRole('button', { name: planningFr.client.createRecord }));
  await user.type(screen.getByLabelText(/^Prénom/), 'Rina');
  await user.type(screen.getByLabelText(/^Nom/), 'Andriamana');
  await user.type(screen.getByLabelText(/^E-mail/), 'rina@example.com');
  await user.click(screen.getByRole('button', { name: planningFr.client.save }));
}

beforeEach(() => {
  searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [] } });
  createDeskClientAction.mockResolvedValue({ ok: true, data: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('la recherche', () => {
  it('garde la phrase du sélecteur quand l’action refuse le terme avant tout appel', async () => {
    const user = userEvent.setup();
    searchDeskClientsAction.mockResolvedValue(REFUS_DE_SAISIE);
    renderPicker();

    await chercher(user);

    expect((await screen.findByRole('alert')).textContent).toBe(planningFr.actions.invalidSearch);
    expect(screen.queryByText(GENERIQUE)).toBeNull();
  });

  it('rend la phrase du contrat partagé à un 400 que l’API a rendu', async () => {
    const user = userEvent.setup();
    searchDeskClientsAction.mockResolvedValue(REFUS_DE_L_API);
    renderPicker();

    await chercher(user);

    expect((await screen.findByRole('alert')).textContent).toBe(GENERIQUE);
    expect(screen.queryByText(planningFr.actions.invalidSearch)).toBeNull();
  });
});

describe('la création de fiche', () => {
  it('garde la phrase du sélecteur quand l’action refuse la fiche avant tout appel', async () => {
    const user = userEvent.setup();
    createDeskClientAction.mockResolvedValue(REFUS_DE_SAISIE);
    renderPicker();

    await creerLaFiche(user);

    expect((await screen.findByRole('alert')).textContent).toBe(planningFr.actions.invalidClient);
    expect(screen.queryByText(GENERIQUE)).toBeNull();
  });

  it('rend la phrase du contrat partagé à un 400 que l’API a rendu', async () => {
    const user = userEvent.setup();
    createDeskClientAction.mockResolvedValue(REFUS_DE_L_API);
    renderPicker();

    await creerLaFiche(user);

    expect((await screen.findByRole('alert')).textContent).toBe(GENERIQUE);
    expect(screen.queryByText(planningFr.actions.invalidClient)).toBeNull();
  });
});
