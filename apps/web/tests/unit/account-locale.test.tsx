import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachAccountLocaleCookies,
  attachProfileLocaleCookies,
  clearAccountLocaleCookie,
  setAccountLocaleMirror,
} from '@/app/(account)/[tenantSlug]/compte/account-locale';
import { AccountLocaleSync } from '@/app/(account)/[tenantSlug]/compte/components/account-locale-sync';
import { clearSessionCookies } from '@/app/(account)/[tenantSlug]/compte/session';
import { ACCOUNT_LOCALE_COOKIE, LOCALE_COOKIE } from '@/i18n/cookies';

/**
 * La langue enregistrée sur le compte — #847, quatrième et cinquième critères
 * d'acceptation.
 *
 * ## Ce que cette suite protège
 *
 * Deux gestes, et une règle qui les relie.
 *
 * 1. **À l'ouverture de session**, la préférence du compte doit *prendre* :
 *    l'ordre de résolution de #845 met le choix explicite du sélecteur
 *    **avant** elle (`i18n/resolve.ts`), si bien que poser le seul miroir ne
 *    changerait rien tant qu'un cookie de sélecteur traîne sur ce navigateur.
 *    C'est pourquoi celui-ci est effacé — et non réécrit, ce qui ferait passer
 *    pour un choix de sélecteur une préférence qui vient du compte.
 * 2. **Au changement de langue**, le choix doit remonter *vers* le compte. La
 *    décision se prend sur le **cookie explicite** et non sur la langue
 *    affichée : celle-ci peut venir d'un `Accept-Language` que personne n'a
 *    demandé, et l'enregistrer ferait naître une préférence par accident, là où
 *    le contrat lit `locale: null` comme « aucune » (#844).
 *
 * Elles se testent sans serveur : les fonctions de cookies reçoivent un magasin
 * factice, et l'îlot ne rend rien — il n'a qu'un effet.
 */

const saveAccountLocaleAction = vi.fn();

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  saveAccountLocaleAction: (...args: unknown[]) => saveAccountLocaleAction(...args),
}));

afterEach(() => {
  cleanup();
  saveAccountLocaleAction.mockReset();
});

/**
 * Un magasin de cookies qui retient ce qu'on lui pose — et qui rend, en
 * lecture, l'état du navigateur **avant** l'appel.
 *
 * La lecture est figée à cet état de départ : les fonctions éprouvées ici lisent
 * toutes avant d'écrire, et un magasin qui se relirait lui-même masquerait
 * précisément l'ordre qu'on veut garantir.
 */
function magasin(depart: Readonly<Record<string, string>> = {}): {
  readonly set: ReturnType<typeof vi.fn>;
  get(nom: string): { readonly value: string } | undefined;
  pose(nom: string): boolean;
  valeur(nom: string): string | undefined;
  duree(nom: string): number | undefined;
} {
  const set = vi.fn();
  /** Le dernier appel visant ce cookie — le dernier écrit est celui qui vaut. */
  const dernier = (nom: string): unknown[] | undefined =>
    [...(set.mock.calls as unknown[][])].reverse().find((call) => call[0] === nom);

  return {
    set,
    get: (nom) => {
      const value = depart[nom];

      return value === undefined ? undefined : { value };
    },
    pose: (nom) => dernier(nom) !== undefined,
    valeur: (nom) => dernier(nom)?.[1] as string | undefined,
    duree: (nom) => (dernier(nom)?.[2] as { maxAge: number } | undefined)?.maxAge,
  };
}

describe('les cookies de langue du compte', () => {
  it('pose la préférence et efface le choix du sélecteur, pour qu’elle prenne', () => {
    const cookies = magasin();

    attachAccountLocaleCookies(cookies, 'en');

    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('en');
    // Effacé, et non réécrit à « en » : l'étape « compte » de l'ordre de
    // résolution doit prendre la main d'elle-même.
    expect(cookies.valeur(LOCALE_COOKIE)).toBe('');
    expect(cookies.duree(LOCALE_COOKIE)).toBe(0);
  });

  it('laisse le choix du sélecteur en place quand le compte n’a pas de préférence', () => {
    // `locale: null` se lit « aucune préférence » (#844) : une cliente qui avait
    // demandé le français avant de se connecter ne doit pas retomber dans la
    // langue de l'établissement pour s'être identifiée.
    const cookies = magasin();

    attachAccountLocaleCookies(cookies, null);

    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('');
    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
    expect(cookies.pose(LOCALE_COOKIE)).toBe(false);
  });

  it('remet le miroir à jour sans toucher au sélecteur, quand le choix vient de lui', () => {
    // C'est le cas de `saveAccountLocaleAction` : le cookie explicite est déjà
    // posé, c'est lui qui a déclenché l'appel. L'effacer ferait perdre à la
    // déconnexion un choix que #845 promet de garder un an.
    const cookies = magasin();

    setAccountLocaleMirror(cookies, 'fr');

    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('fr');
    expect(cookies.pose(LOCALE_COOKIE)).toBe(false);
  });

  it('emporte le miroir avec la session, jamais le choix du navigateur', () => {
    // Il n'annonce qu'une préférence, mais il l'annonce pour **quelqu'un** : le
    // laisser derrière ferait lire à la visiteuse suivante de ce navigateur la
    // langue de la précédente, sans session pour l'expliquer.
    const cookies = magasin();

    clearSessionCookies(cookies, 'maison-lotus');

    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('');
    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
    expect(cookies.pose(LOCALE_COOKIE)).toBe(false);
  });

  it('emporte le choix du sélecteur quand l’écran des coordonnées retire la préférence', () => {
    /*
     * Sans cela, le cookie du sélecteur survivrait à l'effacement et
     * `AccountLocaleSync` le reporterait au rendu suivant sur le compte —
     * réinstallant en silence la préférence que la cliente vient de retirer.
     */
    const cookies = magasin({ [ACCOUNT_LOCALE_COOKIE]: 'en', [LOCALE_COOKIE]: 'en' });

    attachProfileLocaleCookies(cookies, null);

    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
    expect(cookies.duree(LOCALE_COOKIE)).toBe(0);
  });

  it('ne touche pas au sélecteur quand le compte n’avait aucune préférence à retirer', () => {
    // Le formulaire des coordonnées envoie son champ `locale` à chaque
    // enregistrement, y compris ceux qui ne parlent que du téléphone : effacer
    // sans condition ferait perdre à la visiteuse la langue qu'elle lisait.
    const cookies = magasin({ [LOCALE_COOKIE]: 'fr' });

    attachProfileLocaleCookies(cookies, null);

    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
    expect(cookies.pose(LOCALE_COOKIE)).toBe(false);
  });

  it('efface le miroir seul, sur demande', () => {
    const cookies = magasin();

    clearAccountLocaleCookie(cookies);

    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
  });
});

describe('le report du choix de langue sur le compte (#847)', () => {
  it('enregistre le choix du sélecteur quand il diffère de la préférence du compte', async () => {
    render(<AccountLocaleSync tenantSlug="maison-lotus" chosen="en" recorded="fr" />);

    await waitFor(() => {
      expect(saveAccountLocaleAction).toHaveBeenCalledWith('maison-lotus', 'en');
    });
  });

  it('enregistre aussi un premier choix, sur un compte qui n’avait rien', async () => {
    render(<AccountLocaleSync tenantSlug="maison-lotus" chosen="en" recorded={null} />);

    await waitFor(() => {
      expect(saveAccountLocaleAction).toHaveBeenCalledTimes(1);
    });
  });

  it('n’écrit rien quand le compte porte déjà ce choix', async () => {
    render(<AccountLocaleSync tenantSlug="maison-lotus" chosen="fr" recorded="fr" />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saveAccountLocaleAction).not.toHaveBeenCalled();
  });

  it('n’invente pas de préférence quand personne n’a choisi', async () => {
    // Sans cookie de sélecteur, la langue affichée vient de l'`Accept-Language`
    // du navigateur ou de l'établissement : l'enregistrer ferait naître une
    // préférence que personne n'a exprimée.
    render(<AccountLocaleSync tenantSlug="maison-lotus" chosen={null} recorded={null} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saveAccountLocaleAction).not.toHaveBeenCalled();
  });

  it('n’appelle qu’une fois pour un même choix, quels que soient les rendus', async () => {
    // L'action remet le miroir à jour, mais la page n'est pas rejouée pour
    // autant : sans le garde-fou, chaque rendu de l'espace aurait redemandé la
    // même écriture à l'API.
    const { rerender } = render(
      <AccountLocaleSync tenantSlug="maison-lotus" chosen="en" recorded="fr" />,
    );

    await waitFor(() => {
      expect(saveAccountLocaleAction).toHaveBeenCalledTimes(1);
    });

    rerender(<AccountLocaleSync tenantSlug="maison-lotus" chosen="en" recorded="fr" />);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(saveAccountLocaleAction).toHaveBeenCalledTimes(1);
  });

  it('ne peint rien', () => {
    const { container } = render(
      <AccountLocaleSync tenantSlug="maison-lotus" chosen="en" recorded="fr" />,
    );

    expect(container.innerHTML).toBe('');
  });
});
