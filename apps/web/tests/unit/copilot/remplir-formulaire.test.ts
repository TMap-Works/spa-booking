// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { isAuthPath, remplirFormulaire } from '@/components/copilot/remplir-formulaire';

const listeners: string[] = [];

beforeEach(() => {
  listeners.length = 0;
  document.body.innerHTML = `
    <form>
      <input id="register-first-name" /><input id="register-last-name" />
      <input id="register-email" type="email" /><input id="register-phone" type="tel" />
      <input id="register-password" type="password" />
    </form>`;
  document.querySelectorAll('input').forEach((input) =>
    input.addEventListener('input', () => listeners.push(input.id)),
  );
});

const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe('remplirFormulaire', () => {
  it("pose les champs donnés et déclenche l'événement que React écoute", () => {
    const result = remplirFormulaire({ prenom: 'Toky', nom: 'Rakotonirina', email: 'toky@example.org' });

    expect(result.remplis).toEqual(['prenom', 'nom', 'email']);
    expect(value('register-first-name')).toBe('Toky');
    expect(value('register-email')).toBe('toky@example.org');
    expect(listeners).toEqual(['register-first-name', 'register-last-name', 'register-email']);
  });

  it('ne touche jamais au mot de passe, même demandé, et ne valide rien', () => {
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', () => (submitted = true));

    remplirFormulaire({ prenom: 'Toky', password: 'secret' } as never);

    expect(value('register-password')).toBe('');
    expect(submitted).toBe(false);
  });

  it("signale un champ absent de l'écran, et lit l'e-mail de la connexion", () => {
    document.body.innerHTML = '<input id="login-email" type="email" />';
    const result = remplirFormulaire({ email: 'a@b.fr', prenom: 'Toky' });

    expect(result).toEqual({ remplis: ['email'], absents: ['prenom'] });
    expect(value('login-email')).toBe('a@b.fr');
  });

  it("n'agit que sur la connexion et l'inscription du salon", () => {
    expect(isAuthPath('/spa-lumiere/compte/inscription', 'spa-lumiere')).toBe(true);
    expect(isAuthPath('/spa-lumiere/compte/connexion', 'spa-lumiere')).toBe(true);
    expect(isAuthPath('/spa-lumiere/compte/coordonnees', 'spa-lumiere')).toBe(false);
    expect(isAuthPath('/autre/compte/inscription', 'spa-lumiere')).toBe(false);
    expect(isAuthPath('/spa-lumiere/admin', 'spa-lumiere')).toBe(false);
  });
});
