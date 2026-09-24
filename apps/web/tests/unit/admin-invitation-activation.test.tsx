import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminInvitationForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-invitation-form';
import {
  adminInvitationPath,
  invitationTokenFromInput,
} from '@/app/(admin)/[tenantSlug]/admin/invitation/paths';

/**
 * L'activation d'un compte invité sans lien cliquable — #1143.
 *
 * L'écran n'acceptait qu'un jeton passé dans l'adresse, et ce lien n'était
 * fourni par aucune interface : le seul chemin connu pour activer un compte
 * était de composer l'URL à la main. Sans `?token=`, la page affichait « Lien
 * incomplet » et s'arrêtait là, formulaire désactivé.
 *
 * Ce que ces suites tiennent :
 *
 * - **on peut coller ce qu'on a** — l'adresse entière, le chemin seul, ou le
 *   code nu —, et le mot de passe devient saisissable ;
 * - **les retours à la ligne d'une messagerie ne cassent rien** : c'est le cas
 *   qui fabrique le plus de liens inutilisables, un jeton de trois cents
 *   caractères étant systématiquement replié ;
 * - **ce qui n'est pas un jeton est refusé sur le champ**, et non en bandeau
 *   ni, pire, envoyé à l'API qui répondrait « lien expiré » — le plus trompeur
 *   des refus, puisqu'il ferait croire à un lien périmé ;
 * - **le jeton ne part pas dans l'URL** : c'est un secret à usage unique, et
 *   l'écrire dans l'adresse le déposerait dans l'historique du navigateur.
 */

const adminAcceptInvitationAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminAcceptInvitationAction: (...args: unknown[]) => adminAcceptInvitationAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  adminAcceptInvitationAction.mockReset();
  replace.mockReset();
  refresh.mockReset();
});

const CHAMP_COLLE = /Lien ou code d’activation/;
const MOT_DE_PASSE = /^Mot de passe/;
const CONFIRMATION = /Confirmez le mot de passe/;

function motDePasse(): HTMLInputElement {
  return screen.getByLabelText(MOT_DE_PASSE) as HTMLInputElement;
}

describe('invitationTokenFromInput — ce qu’on peut coller', () => {
  it('tire le jeton d’une adresse complète', () => {
    expect(
      invitationTokenFromInput(
        'https://reservation.exemple.fr/maison-lotus/admin/invitation?token=abc.def.ghi',
      ),
    ).toBe('abc.def.ghi');
  });

  it('tire le jeton d’un chemin relatif', () => {
    expect(invitationTokenFromInput('/maison-lotus/admin/invitation?token=abc.def.ghi')).toBe(
      'abc.def.ghi',
    );
  });

  it('accepte le code seul', () => {
    expect(invitationTokenFromInput('abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('recoud un lien replié par une messagerie', () => {
    // Le cas qui motive le ticket : trois cents caractères sans espace, qu'un
    // client de messagerie coupe en deux lignes.
    expect(
      invitationTokenFromInput(
        '  https://reservation.exemple.fr/maison-lotus/admin/invitation?token=abc.\ndef.ghi  ',
      ),
    ).toBe('abc.def.ghi');
  });

  it('décode un jeton échappé dans l’adresse', () => {
    expect(invitationTokenFromInput('/x/admin/invitation?token=a%2Bb')).toBe('a+b');
  });

  it('refuse le vide, la prose et un lien sans jeton', () => {
    expect(invitationTokenFromInput('')).toBeNull();
    expect(invitationTokenFromInput('   ')).toBeNull();
    expect(invitationTokenFromInput('Bonjour, voici ton lien !')).toBeNull();
    expect(invitationTokenFromInput('/maison-lotus/admin/invitation?token=')).toBeNull();
  });

  it('refuse un lien tronqué avant son jeton, au lieu de le prendre pour un code', () => {
    // Ces trois-là ne portent que des caractères de l'alphabet d'un jeton : sans
    // la borne « ce qui se lit comme une adresse doit livrer son paramètre »,
    // ils étaient retenus tels quels et l'écran annonçait « code reconnu » —
    // jusqu'au « lien expiré » de l'API, le refus le plus trompeur des trois.
    expect(invitationTokenFromInput('/maison-lotus/admin/invitation')).toBeNull();
    expect(invitationTokenFromInput('maison-lotus/admin/invitation')).toBeNull();
    expect(invitationTokenFromInput('Voici ton token=abc.def.ghi')).toBeNull();
  });

  it('écrit l’adresse que la page d’activation sait lire', () => {
    expect(adminInvitationPath('maison-lotus', 'abc.def.ghi')).toBe(
      '/maison-lotus/admin/invitation?token=abc.def.ghi',
    );
    expect(adminInvitationPath('maison-lotus')).toBe('/maison-lotus/admin/invitation');
  });
});

describe('AdminInvitationForm — l’écran ouvert sans jeton', () => {
  it('offre un champ où coller, et débloque le mot de passe', async () => {
    render(<AdminInvitationForm tenantSlug="maison-lotus" token={null} />);

    // L'impasse d'avant : le formulaire désactivé, et rien pour en sortir.
    expect(motDePasse().disabled).toBe(true);

    await userEvent.type(
      screen.getByLabelText(CHAMP_COLLE),
      'https://reservation.exemple.fr/maison-lotus/admin/invitation?token=abc.def.ghi',
    );
    await userEvent.click(screen.getByRole('button', { name: /Continuer/ }));

    expect(motDePasse().disabled).toBe(false);
    expect((screen.getByLabelText(CONFIRMATION) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByLabelText(CHAMP_COLLE)).toBeNull();
    // Le jeton reste en mémoire d'écran : rien n'est écrit dans l'adresse.
    expect(replace).not.toHaveBeenCalled();
  });

  it('envoie à l’API le jeton tiré de ce qui a été collé', async () => {
    adminAcceptInvitationAction.mockResolvedValue({ ok: true, data: { role: 'staff' } });

    render(<AdminInvitationForm tenantSlug="maison-lotus" token={null} />);

    await userEvent.type(screen.getByLabelText(CHAMP_COLLE), 'abc.def.ghi');
    await userEvent.click(screen.getByRole('button', { name: /Continuer/ }));
    await userEvent.type(motDePasse(), 'motdepasse-solide');
    await userEvent.type(screen.getByLabelText(CONFIRMATION), 'motdepasse-solide');
    await userEvent.click(screen.getByRole('button', { name: /Activer mon compte/ }));

    expect(adminAcceptInvitationAction).toHaveBeenCalledWith('maison-lotus', {
      token: 'abc.def.ghi',
      password: 'motdepasse-solide',
    });
  });

  it('refuse un collage illisible sous le champ, sans rien envoyer', async () => {
    render(<AdminInvitationForm tenantSlug="maison-lotus" token={null} />);

    await userEvent.type(screen.getByLabelText(CHAMP_COLLE), 'Bonjour, voici ton lien !');
    await userEvent.click(screen.getByRole('button', { name: /Continuer/ }));

    const champ = screen.getByLabelText(CHAMP_COLLE);
    expect(champ.getAttribute('aria-invalid')).toBe('true');
    expect(champ.getAttribute('aria-describedby')).toContain('invitation-lien-colle-error');

    const message = document.getElementById('invitation-lien-colle-error');
    expect(message?.getAttribute('role')).toBe('alert');
    expect(motDePasse().disabled).toBe(true);
    expect(adminAcceptInvitationAction).not.toHaveBeenCalled();
  });

  it('accepte le collage à la touche Entrée, sans soumettre le formulaire', async () => {
    render(<AdminInvitationForm tenantSlug="maison-lotus" token={null} />);

    await userEvent.type(screen.getByLabelText(CHAMP_COLLE), 'abc.def.ghi{Enter}');

    expect(motDePasse().disabled).toBe(false);
    // Entrée vaut « Continuer », pas « Activer » : rien ne part vers l'API tant
    // qu'aucun mot de passe n'est choisi.
    expect(adminAcceptInvitationAction).not.toHaveBeenCalled();
  });

  it('rend le champ de collage quand l’API refuse le code retenu', async () => {
    adminAcceptInvitationAction.mockResolvedValue({
      ok: false,
      code: 'INVALID_INVITATION',
      message: 'invalid',
    });

    render(<AdminInvitationForm tenantSlug="maison-lotus" token={null} />);

    await userEvent.type(screen.getByLabelText(CHAMP_COLLE), 'abc.def.ghi');
    await userEvent.click(screen.getByRole('button', { name: /Continuer/ }));
    await userEvent.type(motDePasse(), 'motdepasse-solide');
    await userEvent.type(screen.getByLabelText(CONFIRMATION), 'motdepasse-solide');
    await userEvent.click(screen.getByRole('button', { name: /Activer mon compte/ }));

    // Un code bien formé mais périmé ne doit pas refermer l'écran sur lui-même :
    // sans le champ, la seule issue serait de recharger la page — l'impasse que
    // le ticket ferme, revenue par la porte de derrière.
    expect(await screen.findByLabelText(CHAMP_COLLE)).toBeTruthy();
    expect((screen.getByLabelText(CHAMP_COLLE) as HTMLInputElement).value).toBe('abc.def.ghi');
  });

  it('ne propose aucun champ de collage quand l’adresse porte déjà le jeton', () => {
    render(<AdminInvitationForm tenantSlug="maison-lotus" token="abc.def.ghi" />);

    expect(screen.queryByLabelText(CHAMP_COLLE)).toBeNull();
    expect(motDePasse().disabled).toBe(false);
  });
});
