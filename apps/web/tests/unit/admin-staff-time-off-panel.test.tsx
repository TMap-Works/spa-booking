import type { StaffTimeOff } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffTimeOffPanel } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-time-off-panel';

/**
 * Le retrait d'une absence, et ce qui le sépare d'une désactivation (#620).
 *
 * Ce qui est vérifié ici est ce qu'un clic de travers coûtait : `DELETE` partait
 * au premier clic, les dates et le motif disparaissaient sans trace, et le
 * praticien redevenait réservable sur ses congés. Les tests ci-dessous tiennent
 * les trois conditions qui rendent ce geste rattrapable — un second geste pour
 * confirmer, une sortie qui ne retire rien, et un focus qui revient d'où il
 * venait.
 */

const deleteStaffTimeOffAction = vi.fn();
const createStaffTimeOffAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  deleteStaffTimeOffAction: (...args: unknown[]) => deleteStaffTimeOffAction(...args),
  createStaffTimeOffAction: (...args: unknown[]) => createStaffTimeOffAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const TANA = 'Indian/Antananarivo';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';

/** Deux journées pleines, le fuseau du salon appliqué — lu « 5 oct. 2026 » à l'écran. */
const CONGE: StaffTimeOff = {
  id: '11111111-1111-4111-8111-111111111111',
  staffId: STAFF_ID,
  startsAt: '2026-10-05T00:00:00+03:00',
  endsAt: '2026-10-07T00:00:00+03:00',
  reason: 'Congés',
};

const FORMATION: StaffTimeOff = {
  id: '33333333-3333-4333-8333-333333333333',
  staffId: STAFF_ID,
  startsAt: '2026-10-12T00:00:00+03:00',
  endsAt: '2026-10-13T00:00:00+03:00',
  reason: 'Formation',
};

afterEach(() => {
  cleanup();
  deleteStaffTimeOffAction.mockReset();
  createStaffTimeOffAction.mockReset();
  refresh.mockReset();
});

function renderPanel(timeOff: readonly StaffTimeOff[] = [CONGE]): void {
  render(
    <StaffTimeOffPanel
      staffId={STAFF_ID}
      tenantSlug="spa-lumiere"
      timeOff={timeOff}
      timeZone={TANA}
      windowLabel="Absences des 90 prochains jours"
    />,
  );
}

function removeTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /Retirer l’absence du/u });
}

describe('le retrait d’une absence — la confirmation', () => {
  it('n’appelle rien au premier clic', async () => {
    // C'est le constat de #620 : un clic suffisait à effacer dates et motif.
    const user = userEvent.setup();
    renderPanel();

    await user.click(removeTrigger());

    expect(deleteStaffTimeOffAction).not.toHaveBeenCalled();
  });

  it('pose la question sur la ligne, en redonnant dates et motif', async () => {
    // Ce que le retrait ferait disparaître doit être sous les yeux au moment où
    // on décide — sans quoi la question porte sur une ligne qu'on doit deviner.
    const user = userEvent.setup();
    renderPanel([CONGE, FORMATION]);

    await user.click(
      screen.getByRole('button', { name: /Retirer l’absence du 5 oct\. 2026 – 6 oct\. 2026/u }),
    );

    const question = screen.getByRole('alertdialog');

    expect(question.textContent).toContain('5 oct. 2026 – 6 oct. 2026');
    expect(question.textContent).toContain('Congés');
    // Une seule absence est désignée à la fois.
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('retire au second geste, et lui seul', async () => {
    const user = userEvent.setup();
    deleteStaffTimeOffAction.mockResolvedValue({ ok: true, data: null });
    renderPanel();

    await user.click(removeTrigger());
    await user.click(screen.getByRole('button', { name: 'Retirer définitivement' }));

    expect(deleteStaffTimeOffAction).toHaveBeenCalledTimes(1);
    expect(deleteStaffTimeOffAction).toHaveBeenCalledWith('spa-lumiere', STAFF_ID, CONGE.id);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('le retrait d’une absence — en sortir sans rien perdre', () => {
  it('renonce sur « Annuler » sans rien appeler', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(removeTrigger());
    await user.click(screen.getByRole('button', { name: 'Annuler' }));

    expect(deleteStaffTimeOffAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // L'absence est toujours là, dates et motif compris.
    expect(screen.getByText('5 oct. 2026 – 6 oct. 2026')).toBeDefined();
  });

  it('renonce sur Échap — le geste qu’on tente d’abord', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(removeTrigger());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteStaffTimeOffAction).not.toHaveBeenCalled();
  });

  it('ne laisse pas renoncer une fois le retrait parti', async () => {
    // Le `DELETE` ne se rappelle pas : fermer la question pendant qu'il s'exécute
    // annoncerait un renoncement que rien ne tient, et l'absence disparaîtrait
    // quand même quelques centaines de millisecondes plus tard.
    const user = userEvent.setup();
    let acheve: (resultat: { ok: true; data: null }) => void = () => {};
    deleteStaffTimeOffAction.mockReturnValue(
      new Promise((resolve) => {
        acheve = resolve;
      }),
    );
    renderPanel();

    await user.click(removeTrigger());
    await user.click(screen.getByRole('button', { name: 'Retirer définitivement' }));

    // Le retrait est en vol : ni Échap ni « Annuler » ne doivent faire croire
    // qu'on y a échappé.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Annuler' })).toHaveProperty('disabled', true);

    acheve({ ok: true, data: null });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it('rend le focus au bouton d’où l’on vient', async () => {
    // Sans cela, renoncer renvoie le focus sur le `body` : au clavier la liste
    // serait à reparcourir depuis le début, alors qu'on vient d'y corriger un
    // clic de travers.
    const user = userEvent.setup();
    renderPanel([CONGE, FORMATION]);

    const trigger = screen.getByRole('button', {
      name: /Retirer l’absence du 12 oct\. 2026/u,
    });

    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(trigger);
  });
});

describe('le retrait d’une absence — quand l’API refuse', () => {
  it('le dit sous son propre titre, et laisse la question posée', async () => {
    // « Absence non enregistrée » sur un retrait raté serait un contresens, et
    // désarmer la confirmation obligerait à redésigner la bonne ligne.
    const user = userEvent.setup();
    deleteStaffTimeOffAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Session expirée.',
    });
    renderPanel();

    await user.click(removeTrigger());
    await user.click(screen.getByRole('button', { name: 'Retirer définitivement' }));

    expect(screen.getByText('Absence non retirée')).toBeDefined();
    expect(screen.getByText('Session expirée.')).toBeDefined();
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('le retrait d’une absence — au rang praticien', () => {
  it('n’offre ni bouton ni question', () => {
    // `DELETE /v1/staff-time-off` est `@AuthAtLeast('MANAGER')` : offrir un
    // bouton qui répondrait 403 n'aide personne.
    render(
      <StaffTimeOffPanel
        canManage={false}
        staffId={STAFF_ID}
        tenantSlug="spa-lumiere"
        timeOff={[CONGE]}
        timeZone={TANA}
        windowLabel="Absences des 90 prochains jours"
      />,
    );

    expect(screen.queryByRole('button', { name: /Retirer l’absence/u })).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
