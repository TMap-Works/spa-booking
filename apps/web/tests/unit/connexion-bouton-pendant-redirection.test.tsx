import { type SessionUser } from '@spa/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startTransition, Suspense, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminLoginForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-login-form';

/**
 * Le bouton de connexion reste en chargement jusqu'à l'arrivée (#1362).
 *
 * Le défaut : `isSubmitting` retombait dès la réponse de l'action serveur, et le
 * bouton redevenait cliquable pendant les quelques secondes où la page de
 * destination se rendait côté serveur. `useNavigateAfterAuth` tient désormais
 * l'attente jusqu'au rendu de destination.
 *
 * La navigation de Next est simulée par ce qu'elle est pour React : une mise à
 * jour **en transition** qui suspend tant que la charge utile du serveur n'est
 * pas arrivée. L'écran courant reste affiché — c'est l'intervalle où le bouton
 * était fautif.
 *
 * La transition est posée **par le faux routeur**, comme le vrai `router.replace`
 * la pose lui-même : sans elle, l'ancien code ferait échouer ce test sur le
 * repli de `Suspense`, artefact du harnais, et non sur le bouton resté cliquable.
 */

const adminLoginAction = vi.fn();

/** Ce que la « navigation » déclenche : le harnais l'installe au rendu. */
let startDestination: () => void = () => undefined;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => startDestination(), refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLoginAction: (...args: unknown[]) => adminLoginAction(...args),
  adminLogoutAction: vi.fn(),
}));

const account: SessionUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'claire@maison-lotus.test',
  role: 'manager',
  firstName: 'Claire',
  lastName: 'Ravelo',
  phone: null,
  locale: null,
};

/** Le rendu serveur de la destination, qui n'arrive qu'à `arrive()`. */
function pendingDestination() {
  let arrive: () => void = () => undefined;
  let arrived = false;
  const payload = new Promise<void>((resolve) => {
    arrive = () => {
      arrived = true;
      resolve();
    };
  });

  function Destination() {
    if (!arrived) {
      throw payload;
    }
    return <p>destination rendue</p>;
  }

  return { Destination, arrive: () => arrive() };
}

function Harness({ Destination }: { readonly Destination: () => ReactElement }) {
  const [navigating, setNavigating] = useState(false);
  startDestination = () => startTransition(() => setNavigating(true));

  return (
    <Suspense fallback={<p>chargement de page</p>}>
      <AdminLoginForm tenantSlug="maison-lotus" notice={null} />
      {navigating ? <Destination /> : null}
    </Suspense>
  );
}

/** Le seul bouton du formulaire : celui qui soumet. */
const submitButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button');

afterEach(() => {
  cleanup();
  adminLoginAction.mockReset();
});

describe('le bouton de connexion pendant la redirection', () => {
  it('reste désactivé une fois l’action rendue, tant que la destination n’est pas arrivée', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account });
    const { Destination, arrive } = pendingDestination();
    render(<Harness Destination={Destination} />);

    await userEvent.type(screen.getByLabelText(/adresse e-mail/i), 'claire@maison-lotus.test');
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'MotDePasse123!');
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }));

    // L'action a répondu, la destination se rend encore : l'écran courant reste
    // affiché (transition), et son bouton ne se laisse pas recliquer.
    expect(adminLoginAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('chargement de page')).toBeNull();
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      arrive();
    });

    // Arrivée — et, si la destination rendait cet écran-ci, le formulaire ne
    // resterait pas figé : la transition finie, le bouton se libère.
    screen.getByText('destination rendue');
    expect(submitButton().disabled).toBe(false);
  });

  it('rend la main aussitôt sur un refus', async () => {
    adminLoginAction.mockResolvedValue({ ok: false, code: 'INVALID_CREDENTIALS', message: '' });
    const { Destination } = pendingDestination();
    render(<Harness Destination={Destination} />);

    await userEvent.type(screen.getByLabelText(/adresse e-mail/i), 'claire@maison-lotus.test');
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'MotDePasse123!');
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }));

    expect(submitButton().disabled).toBe(false);
    // … et avec son message : la main rendue sans dire pourquoi ne vaudrait rien.
    screen.getByText('Adresse e-mail ou mot de passe incorrect.');
  });
});
