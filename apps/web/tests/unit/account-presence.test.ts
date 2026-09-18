import { describe, expect, it, vi } from 'vitest';

import {
  attachSessionCookies,
  clearSessionCookies,
} from '@/app/(account)/[tenantSlug]/compte/session';
import { PRESENCE_COOKIE, parsePresence, presenceCookieValue } from '@/lib/account-presence';
import type { ApiSession } from '@/lib/api-client';

/*
 * Le cookie de présence (#1045, élargi par #1086) — ce que le salon sait de la
 * cliente hors de l'espace client, où les jetons ne voyagent pas.
 *
 * Ce que la suite protège :
 * - il porte **les coordonnées du compte et rien d'autre** — jamais un jeton,
 *   jamais l'identifiant du compte, jamais son rôle ;
 * - il vit sur tout le salon (`/{slug}`), là où les jetons restent bornés à
 *   `/{slug}/compte` ;
 * - il part avec la session ;
 * - relu du navigateur, il est validé : une valeur trafiquée ne s'affiche pas —
 *   et depuis #1088 elle n'emporte plus la présence entière avec elle ;
 * - un cookie posé **avant #1086** se relit encore, sans quoi toutes les
 *   clientes connectées au déploiement cesseraient d'être saluées.
 */

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

const opened: ApiSession = {
  session: {
    accessToken: 'jeton-d-acces-de-test',
    expiresIn: 900,
    user: {
      id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
      email: 'alice@maison-lotus.test',
      role: 'client',
      firstName: 'Alice',
      lastName: 'Marchand',
      phone: null,
    },
  },
  refreshToken: 'jeton-de-rafraichissement-de-test',
  refreshTokenMaxAge: 604800,
};

function magasin() {
  const set = vi.fn();
  return { set, cookies: { set } };
}

describe('cookie de présence', () => {
  it('se pose avec la session, sur tout le salon, sans jeton', () => {
    const { set, cookies } = magasin();

    attachSessionCookies(cookies, 'maison-lotus', opened);

    const presence = set.mock.calls.find(([name]) => name === PRESENCE_COOKIE);
    expect(presence).toBeDefined();
    const [, value, options] = presence as [string, string, { path: string; httpOnly: boolean; maxAge: number }];
    // Les quatre coordonnées depuis #1086 — et l'égalité stricte est le fond de
    // l'assertion : c'est elle qui refuserait l'identifiant du compte ou son
    // rôle, que `sessionUserSchema` porte à côté et qu'un `...user` ferait
    // voyager sur chaque page du salon sans que rien ne le signale.
    expect(JSON.parse(value)).toEqual({
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@maison-lotus.test',
      phone: '',
    });
    expect(value).not.toContain('jeton');
    expect(value).not.toContain(opened.session.user.id);
    expect(options).toMatchObject({ path: '/maison-lotus', httpOnly: true, maxAge: 604800 });

    // Les jetons, eux, restent bornés à l'espace client.
    for (const [name, , tokenOptions] of set.mock.calls) {
      if (name !== PRESENCE_COOKIE) {
        expect(tokenOptions.path).toBe('/maison-lotus/compte');
      }
    }
  });

  /**
   * `sessionUserSchema` émet `phone: null` quand le compte n'a pas de numéro, et
   * le cookie écrit `''` — la convention de `lastName` depuis #1045, et celle de
   * `ContactDraft` côté tunnel. C'est `presenceCookieValue` qui fait la
   * traduction, pour que ni `session.ts` ni `compte/actions.ts` n'aient à la
   * refaire chacun de son côté.
   */
  it('écrit le numéro du compte, et la chaîne vide quand il n’y en a pas', () => {
    const avecNumero = presenceCookieValue({
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@maison-lotus.test',
      phone: '+33612345678',
    });
    const sansNumero = presenceCookieValue({
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@maison-lotus.test',
      phone: null,
    });

    expect(JSON.parse(avecNumero)).toMatchObject({ phone: '+33612345678' });
    expect(JSON.parse(sansNumero)).toMatchObject({ phone: '' });
    expect(sansNumero).not.toContain('null');
  });

  it('part avec la session', () => {
    const { set, cookies } = magasin();

    clearSessionCookies(cookies, 'maison-lotus');

    expect(set).toHaveBeenCalledWith(
      PRESENCE_COOKIE,
      '',
      expect.objectContaining({ path: '/maison-lotus', maxAge: 0 }),
    );
  });

  it('se relit, et refuse ce qui n’en a pas la forme', () => {
    const alice = {
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@maison-lotus.test',
      phone: '+33612345678',
    };

    expect(parsePresence(presenceCookieValue(alice))).toEqual(alice);
    expect(parsePresence(undefined)).toBeNull();
    expect(parsePresence('')).toBeNull();
    expect(parsePresence('pas du json')).toBeNull();
    expect(parsePresence(JSON.stringify({ ...alice, firstName: '' }))).toBeNull();
    expect(parsePresence(JSON.stringify({ ...alice, firstName: 'A'.repeat(500) }))).toBeNull();
  });

  /**
   * L'adresse et le numéro sont relus avec les schémas du contrat, ceux-là mêmes
   * dont dépend le formulaire du tunnel : préremplir un champ que
   * `guestContactSchemaFor` refuserait aussitôt afficherait une erreur sur une
   * saisie que la cliente n'a pas faite. Ce que #1088 change, c'est la **portée**
   * du refus : un champ hors contrat ne vaut plus que lui-même.
   *
   * #1086 relisait l'objet en tout-ou-rien, et une seule valeur illisible — un
   * numéro dans un format que `storedPhoneSchema` resserre plus tard, un cookie
   * d'une version antérieure — annulait la présence entière, prénom compris :
   * l'en-tête cessait de saluer sur **toutes** les pages du salon pour un champ
   * qu'il ne lit même pas. Or l'en-tête doit saluer coûte que coûte : c'est la
   * raison d'être du cookie.
   *
   * Le repli est celui de l'absence, et l'étape « Coordonnées » sait exactement
   * le traiter — elle rouvre le champ au lieu de le résumer. La garantie de
   * #1086 tient donc entière : rien n'est jamais prérempli d'une valeur que le
   * formulaire refuserait.
   */
  it('vide le champ illisible sans emporter le reste de la présence', () => {
    const alice = {
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@maison-lotus.test',
      phone: '+33612345678',
    };

    expect(parsePresence(JSON.stringify({ ...alice, email: 'pas-une-adresse' }))).toEqual({
      ...alice,
      email: '',
    });
    expect(parsePresence(JSON.stringify({ ...alice, phone: 'appelez-moi' }))).toEqual({
      ...alice,
      phone: '',
    });
    // Les deux noms gardent le tout-ou-rien : ce sont eux que l'en-tête rend, et
    // `firstName` vide ne laisse personne à saluer — ce n'est plus une présence
    // dégradée, c'est l'absence de présence.
    expect(parsePresence(JSON.stringify({ ...alice, firstName: 42 }))).toBeNull();
  });

  /**
   * Le cookie d'avant #1086 ne porte que les deux noms. Exiger les deux nouveaux
   * champs le rendrait illisible, et l'en-tête du salon cesserait de saluer
   * toutes les clientes déjà connectées à l'instant du déploiement — jusqu'à ce
   * qu'elles se reconnectent, ce qu'elles n'ont aucune raison de faire.
   *
   * Le repli est la chaîne vide, et c'est exactement ce que l'étape
   * « Coordonnées » sait traiter : elle rouvre alors le champ concerné au lieu
   * de le résumer.
   */
  it('relit encore un cookie posé avant que l’adresse n’y entre', () => {
    expect(parsePresence(JSON.stringify({ firstName: 'Alice', lastName: 'Marchand' }))).toEqual({
      firstName: 'Alice',
      lastName: 'Marchand',
      email: '',
      phone: '',
    });
  });
});
