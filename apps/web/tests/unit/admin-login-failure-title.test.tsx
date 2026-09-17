import { ERROR_CODES } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminLoginForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-login-form';

/**
 * Le titre de l'encart d'échec de la connexion au back-office (#759).
 *
 * ## Ce que ces vérifications protègent, et qu'aucune autre ne voyait
 *
 * Le corps de l'encart dépendait du `code` de l'erreur typée, le titre non : il
 * valait « Connexion refusée » quelle qu'ait été la cause. Sur une coupure
 * réseau, l'écran affichait donc « Connexion refusée » au-dessus de « Le service
 * est momentanément injoignable » — le titre accusant les identifiants saisis,
 * le corps le serveur. Les tests existants n'exerçaient que le refus
 * d'identifiants, seul cas où le titre constant tombait juste : le défaut était
 * invisible au vert.
 *
 * Ce qui se vérifie ici est donc la **correspondance code → titre**, à travers
 * ce que l'écran rend — pas une table exportée, qu'un composant pourrait cesser
 * de lire sans qu'aucune de ces assertions ne bouge.
 *
 * Référence : `docs/design/appointments/states.md`, « Règles générales » —
 * réagir sur le `code`, jamais sur le `message` (`web-frontend` §2).
 */

const replace = vi.fn();
const refresh = vi.fn();
const adminLoginAction = vi.fn();
const adminLogoutAction = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLoginAction: (...args: unknown[]) => adminLoginAction(...args),
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
}));

const SLUG = 'maison-lotus';

/** Saisit des identifiants valides et soumet — le refus vient de l'action, pas de la saisie. */
const signIn = async (): Promise<void> => {
  await userEvent.type(screen.getByLabelText(/adresse e-mail/i), 'claire@maison-lotus.test');
  await userEvent.type(screen.getByLabelText(/mot de passe/i), 'MotDePasse123!');
  await userEvent.click(screen.getByRole('button', { name: /se connecter/i }));
};

/** Soumet le formulaire face à ce refus, et rend l'encart affiché. */
const refus = async (code: string, message: string): Promise<HTMLElement> => {
  adminLoginAction.mockResolvedValue({ ok: false, code, message });
  render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

  await signIn();

  return screen.getByRole('alert');
};

afterEach(() => {
  cleanup();
  replace.mockReset();
  refresh.mockReset();
  adminLoginAction.mockReset();
  adminLogoutAction.mockReset();
});

describe('le titre de l’encart d’échec suit le code de l’erreur', () => {
  it('n’accuse les identifiants que sur un vrai refus d’identifiants', async () => {
    const encart = await refus(ERROR_CODES.INVALID_CREDENTIALS, 'Identifiants invalides.');

    expect(encart.textContent).toContain('Connexion refusée');
    expect(encart.textContent).toContain('Adresse e-mail ou mot de passe incorrect.');
  });

  it('nomme le service sur une API injoignable, au lieu de renvoyer au mot de passe', async () => {
    const injoignable = 'Le service est momentanément injoignable. Merci de réessayer dans un instant.';
    const encart = await refus(ERROR_CODES.SERVICE_UNAVAILABLE, injoignable);

    // Le défaut relevé par l'audit `d20260916-1` : ce couple-là se contredisait.
    expect(encart.textContent).toContain('Service indisponible');
    expect(encart.textContent).not.toContain('Connexion refusée');
    expect(encart.textContent).toContain(injoignable);
  });

  it('nomme le quota sur un excès de tentatives, que réécrire son mot de passe ne lèverait pas', async () => {
    // Dix tentatives par minute et par IP sur `POST /auth/login` : passé ce
    // quota, ce sont les essais qui sont refusés, pas le couple saisi.
    const encart = await refus(ERROR_CODES.TOO_MANY_REQUESTS, 'ThrottlerException: Too Many Requests');

    expect(encart.textContent).toContain('Trop de tentatives');
    expect(encart.textContent).not.toContain('Connexion refusée');
    // Ce que `ThrottlerGuard` répond mot pour mot : une phrase anglaise qui
    // nomme une classe d'exception. Répétée telle quelle, elle sortait le nom
    // d'un rouage interne sous un titre écrit pour une gérante.
    expect(encart.textContent).not.toContain('ThrottlerException');
    expect(encart.textContent).toContain('Patientez');
  });

  it('nomme la panne aussi quand elle vient de la passerelle', async () => {
    // `api-client.ts` ne rend le code du contrat que si le corps est
    // l'enveloppe `{ code, message, details }`. Un conteneur d'API éteint
    // derrière un ALB rend une page 503 qui ne l'est pas : le code vaut alors
    // `HTTP_503`, et c'est le cas le plus courant des deux en déployé.
    const encart = await refus('HTTP_503', 'Une erreur inattendue est survenue. Merci de réessayer dans un instant.');

    expect(encart.textContent).toContain('Service indisponible');
    expect(encart.textContent).toContain('injoignable');
    expect(encart.textContent).not.toContain('Connexion refusée');
  });

  it('nomme le quota aussi quand c’est la passerelle qui l’applique', async () => {
    const encart = await refus('HTTP_429', 'Une erreur inattendue est survenue. Merci de réessayer dans un instant.');

    expect(encart.textContent).toContain('Trop de tentatives');
    expect(encart.textContent).not.toContain('Connexion refusée');
  });

  it('retombe sur le repli neutre pour un code qui n’est aucune chaîne connue, fût-elle héritée', async () => {
    // `apiErrorSchema` accepte n'importe quelle chaîne comme `code`, à dessein.
    // Sous un objet littéral indexé, `valueOf` rendait `Object.prototype.valueOf`
    // au lieu du repli : `<Notification>` recevait une fonction là où elle
    // attend un titre, et l'encart s'affichait sans rien dire.
    const encart = await refus('valueOf', 'Une erreur inattendue est survenue.');

    expect(encart.textContent).toContain('Connexion impossible');
    expect(encart.textContent).toContain('Une erreur inattendue est survenue.');
  });

  it('reste neutre sur un code qu’il ne sait pas nommer, plutôt que d’inventer une cause', async () => {
    // `HTTP_<statut>` est le repli du filtre d'erreurs pour un statut qu'il ne
    // nomme pas : il ne dit rien des identifiants, et le titre non plus.
    const encart = await refus('HTTP_500', 'Une erreur inattendue est survenue.');

    expect(encart.textContent).toContain('Connexion impossible');
    expect(encart.textContent).not.toContain('Connexion refusée');
  });

  it('reste neutre aussi sur un refus qui n’a jamais atteint l’API', async () => {
    const encart = await refus(
      ERROR_CODES.VALIDATION_ERROR,
      'Renseignez votre adresse e-mail et votre mot de passe.',
    );

    expect(encart.textContent).toContain('Connexion impossible');
    expect(encart.textContent).not.toContain('Connexion refusée');
  });
});

describe('ce que l’encart garde par ailleurs', () => {
  it('s’annonce aux lecteurs d’écran dès son apparition', async () => {
    // `states.md` « Règles générales » : toute apparition d'un état d'erreur
    // dynamique est annoncée via une région `aria-live`. Le ton `danger` de la
    // notification porte `role="alert"` — c'est ce qui l'assure, et rien
    // d'autre ne le vérifie sur cet écran.
    const encart = await refus(ERROR_CODES.SERVICE_UNAVAILABLE, 'Injoignable.');

    expect(encart.getAttribute('role')).toBe('alert');
  });

  it('conserve les saisies et ne quitte pas l’écran', async () => {
    // Même règle : « conservation des saisies » en cours. Un refus de service
    // qui viderait le formulaire ferait ressaisir un couple qui était bon.
    await refus(ERROR_CODES.SERVICE_UNAVAILABLE, 'Injoignable.');

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>(/adresse e-mail/i).value).toBe(
      'claire@maison-lotus.test',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/mot de passe/i).value).toBe('MotDePasse123!');
  });
});
