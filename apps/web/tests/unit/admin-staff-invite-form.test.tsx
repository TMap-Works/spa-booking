import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffInviteForm } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-invite-form';

/**
 * Ce qu'une soumission invalide apprend, et en combien de fois (#631).
 *
 * Le formulaire ne retenait que `parsed.error.issues[0]` : trois champs
 * obligatoires vides se découvraient un par un, en trois allers-retours, chaque
 * essai n'en marquant qu'un. Les tests ci-dessous tiennent les deux conditions
 * qui referment ce défaut — la moisson complète en une soumission, et une
 * correction qui n'efface pas les marques des autres champs — sans relâcher
 * l'accessibilité que `styles/components/field.css` documente : `aria-invalid`,
 * un message référencé par `aria-describedby`, et `role="alert"` dessus. La
 * couleur ne porte jamais l'information seule (WCAG 1.4.1).
 */

const inviteStaffAccountAction = vi.fn();
const refresh = vi.fn();

// L'action serveur est un module Next qui n'existe pas hors du serveur, et le
// routeur non plus. Ce qu'on éprouve ici est le formulaire — ce qu'il signale et
// ce qu'il envoie —, pas le transport.
vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  inviteStaffAccountAction: (...args: unknown[]) => inviteStaffAccountAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  inviteStaffAccountAction.mockReset();
  refresh.mockReset();
  // La doublure du presse-papiers ne survit pas à son test : jsdom n'en fournit
  // pas, et la laisser en place ferait passer une suite voisine qui n'aurait
  // rien posé.
  Reflect.deleteProperty(navigator, 'clipboard');
});

function renderForm(): void {
  render(<StaffInviteForm tenantSlug="spa-lumiere" />);
}

/** Les trois champs obligatoires de l'invitation, par leur libellé à l'écran. */
const PRENOM = /Prénom/;
const NOM = /Nom/;
const EMAIL = /Adresse électronique/;
const TELEPHONE = /Téléphone/;

function invalide(label: RegExp): boolean {
  return screen.getByLabelText(label).getAttribute('aria-invalid') === 'true';
}

async function soumettre(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Inviter/ }));
}

/** La réponse d'une invitation acceptée par l'API, jeton compris. */
function invitationEmise(token: string) {
  return {
    ok: true,
    data: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'hanta@spa-lumiere.mg',
        firstName: 'Hanta',
        lastName: 'Rakoto',
        phone: null,
        role: 'staff',
      },
      invitationToken: token,
      expiresIn: 3600,
    },
  };
}

describe('StaffInviteForm — signalement des champs fautifs', () => {
  it('marque les trois champs obligatoires d’une seule soumission', async () => {
    renderForm();

    await soumettre();

    expect(invalide(PRENOM)).toBe(true);
    expect(invalide(NOM)).toBe(true);
    expect(invalide(EMAIL)).toBe(true);

    // Trois messages, et trois seulement : le bandeau « Invitation impossible »
    // ne double pas des marques que les champs portent déjà.
    const alertes = screen.getAllByRole('alert');
    expect(alertes).toHaveLength(3);
    expect(alertes.every((alerte) => (alerte.textContent ?? '').trim() !== '')).toBe(true);

    // Rien n'est parti : la soumission s'arrête avant l'action serveur.
    expect(inviteStaffAccountAction).not.toHaveBeenCalled();
  });

  it('rattache chaque message à son champ par aria-describedby', async () => {
    renderForm();

    await soumettre();

    for (const [label, id] of [
      [PRENOM, 'invitation-prenom-error'],
      [NOM, 'invitation-nom-error'],
      [EMAIL, 'invitation-email-error'],
    ] as const) {
      const controle = screen.getByLabelText(label);
      expect(controle.getAttribute('aria-describedby')).toContain(id);

      const message = document.getElementById(id);
      expect(message).not.toBeNull();
      expect(message?.getAttribute('role')).toBe('alert');
    }
  });

  it('signale le téléphone incomplet en même temps que les champs vides', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText(TELEPHONE), '12');
    await soumettre();

    expect(invalide(TELEPHONE)).toBe(true);
    expect(invalide(PRENOM)).toBe(true);
    expect(invalide(NOM)).toBe(true);
    expect(invalide(EMAIL)).toBe(true);
  });

  it('n’efface que la marque du champ corrigé', async () => {
    renderForm();

    await soumettre();
    await userEvent.type(screen.getByLabelText(PRENOM), 'Hanta');

    expect(invalide(PRENOM)).toBe(false);
    // C'est tout l'objet du ticket : corriger un champ ne doit pas re-cacher ce
    // que la soumission précédente venait d'apprendre sur les autres.
    expect(invalide(NOM)).toBe(true);
    expect(invalide(EMAIL)).toBe(true);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('envoie l’invitation quand tout est valide, sans marque résiduelle', async () => {
    inviteStaffAccountAction.mockResolvedValue(invitationEmise('jeton-a-recopier'));

    renderForm();

    await userEvent.type(screen.getByLabelText(PRENOM), 'Hanta');
    await userEvent.type(screen.getByLabelText(NOM), 'Rakoto');
    await userEvent.type(screen.getByLabelText(EMAIL), 'hanta@spa-lumiere.mg');
    await soumettre();

    expect(inviteStaffAccountAction).toHaveBeenCalledWith('spa-lumiere', {
      firstName: 'Hanta',
      lastName: 'Rakoto',
      email: 'hanta@spa-lumiere.mg',
      role: 'staff',
    });
    expect(invalide(PRENOM)).toBe(false);
    expect(invalide(NOM)).toBe(false);
    expect(invalide(EMAIL)).toBe(false);
  });

  it('rend le lien d’activation complet, et non le jeton nu (#1143)', async () => {
    inviteStaffAccountAction.mockResolvedValue(invitationEmise('jeton-a-recopier'));

    renderForm();

    await userEvent.type(screen.getByLabelText(PRENOM), 'Hanta');
    await userEvent.type(screen.getByLabelText(NOM), 'Rakoto');
    await userEvent.type(screen.getByLabelText(EMAIL), 'hanta@spa-lumiere.mg');
    await soumettre();

    // C'est tout l'objet du ticket : ce qui s'affiche est une adresse ouvrable,
    // celle-là même que la page d'activation attend — et non un jeton que rien
    // dans l'interface ne savait employer.
    const lien = screen.getByLabelText(/Lien d’activation/) as HTMLInputElement;
    expect(lien.value).toBe(
      'http://localhost:3000/spa-lumiere/admin/invitation?token=jeton-a-recopier',
    );
    expect(lien.readOnly).toBe(true);
  });

  it('dépose le lien dans le presse-papiers et le dit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    inviteStaffAccountAction.mockResolvedValue(invitationEmise('jeton-a-recopier'));

    renderForm();

    await userEvent.type(screen.getByLabelText(PRENOM), 'Hanta');
    await userEvent.type(screen.getByLabelText(NOM), 'Rakoto');
    await userEvent.type(screen.getByLabelText(EMAIL), 'hanta@spa-lumiere.mg');
    await soumettre();
    await userEvent.click(screen.getByRole('button', { name: /Copier le lien/ }));

    expect(writeText).toHaveBeenCalledWith(
      'http://localhost:3000/spa-lumiere/admin/invitation?token=jeton-a-recopier',
    );
    // Le bouton dit ce qu'il vient de faire : sans retour, rien ne distingue un
    // clic réussi d'un clic non enregistré.
    //
    // `find` et non `get` : l'écriture dans le presse-papiers est asynchrone, et
    // le libellé ne change qu'une fois sa promesse tenue. Un `get` synchrone lit
    // le rendu d'avant et échoue par intermittence, selon que la file de
    // micro-tâches a été vidée ou non — ce qui dépend de la charge de la machine
    // et non du code.
    expect(await screen.findByRole('button', { name: /Lien copié/ })).toBeTruthy();
  });

  it('affiche le refus du serveur en bandeau, sans marquer de champ', async () => {
    inviteStaffAccountAction.mockResolvedValue({
      ok: false,
      message: 'Cette adresse est déjà utilisée.',
    });

    renderForm();

    await userEvent.type(screen.getByLabelText(PRENOM), 'Hanta');
    await userEvent.type(screen.getByLabelText(NOM), 'Rakoto');
    await userEvent.type(screen.getByLabelText(EMAIL), 'hanta@spa-lumiere.mg');
    await soumettre();

    const alertes = screen.getAllByRole('alert');
    expect(alertes).toHaveLength(1);
    expect(alertes[0]?.textContent).toContain('Cette adresse est déjà utilisée.');
    expect(invalide(EMAIL)).toBe(false);
  });
});
