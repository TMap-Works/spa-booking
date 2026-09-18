// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  RETURN_QUERY_KEY,
  safeReturnPath,
  withReturnPath,
} from '@/app/(account)/[tenantSlug]/compte/connexion/return-path';

/**
 * Le paramètre de retour des écrans d'identité, et surtout ce qu'il refuse
 * (#1087).
 *
 * Un écran de connexion est le pire endroit du produit où poser une redirection
 * ouverte : c'est la page où l'on tape son mot de passe, et celle qu'un courriel
 * d'hameçonnage a tout intérêt à faire ouvrir sous notre domaine avant de
 * renvoyer ailleurs. Le troisième critère d'acceptation de #1087 exige qu'une
 * suite le prouve — la voici.
 *
 * Même exigence, mêmes pièges que `safeAdminNext` (`admin-navigation.test.ts`)
 * et que le `next` de `session/refresh` : la destination se juge sur sa forme
 * **normalisée** (#856), pas sur celle qu'elle affiche.
 */

const SLUG = 'maison-lotus';
const SALON = `/${SLUG}`;

describe('safeReturnPath — ce qui est accepté', () => {
  it.each([
    `${SALON}/reservation`,
    `${SALON}/reservation?etape=coordonnees`,
    `${SALON}/compte/rendez-vous`,
    SALON,
  ])('laisse passer une destination du salon courant : %s', (target) => {
    expect(safeReturnPath(target, SLUG)).toBe(target);
  });

  it('rend la forme normalisée, celle qui partira dans la navigation', () => {
    expect(safeReturnPath(`${SALON}/compte/../reservation`, SLUG)).toBe(`${SALON}/reservation`);
    expect(safeReturnPath(`${SALON}/reservation?q=é`, SLUG)).toBe(`${SALON}/reservation?q=%C3%A9`);
  });
});

describe('safeReturnPath — ce qui est refusé', () => {
  it('rend null quand l’adresse ne porte aucun retour', () => {
    expect(safeReturnPath(null, SLUG)).toBeNull();
  });

  it.each([
    // Une URL absolue : le tremplin que ce garde-fou existe pour fermer.
    'https://exemple.test/piege',
    'http://exemple.test/piege',
    // Protocole-relative : elle commence bien par `/` et mène pourtant ailleurs.
    '//exemple.test/piege',
    '/\\exemple.test/piege',
    // Le bon préfixe, et pourtant `//exemple.test` une fois les `..` résolus.
    `${SALON}/compte/../..//exemple.test`,
    // Pas un chemin du tout.
    'javascript:alert(1)',
    'reservation',
  ])('refuse ce qui n’est pas un chemin de ce site : %s', (hostile) => {
    expect(safeReturnPath(hostile, SLUG)).toBeNull();
  });

  it.each([
    '/autre-salon/reservation',
    // Le préfixe de chaînes qui piège : `/maison-lotus-bis` commence bien par
    // `/maison-lotus`, et c'est pourtant un autre établissement.
    `${SALON}-bis/reservation`,
    '/',
  ])('refuse une destination hors du salon courant : %s', (elsewhere) => {
    expect(safeReturnPath(elsewhere, SLUG)).toBeNull();
  });

  it.each([
    `${SALON}/compte/connexion`,
    `${SALON}/compte/connexion?motif=session-expiree`,
    `${SALON}/compte/inscription`,
  ])('refuse les écrans d’identité eux-mêmes, qui boucleraient : %s', (loop) => {
    expect(safeReturnPath(loop, SLUG)).toBeNull();
  });

  it.each([
    // Segment encodé : le routeur décode avant d'apparier, la comparaison de
    // chaînes brutes ne le voyait pas.
    `${SALON}/compte/%63onnexion`,
    `${SALON}/compte/%69nscription`,
    `${SALON}/compte/%73ession/refresh`,
    // Barre redoublée : elle ne crée aucun segment, et mène au même écran.
    `${SALON}/compte//connexion`,
    `${SALON}//compte/connexion`,
  ])('refuse une écriture détournée du même écran d’identité : %s', (disguised) => {
    expect(safeReturnPath(disguised, SLUG)).toBeNull();
  });

  it.each([`${SALON}/compte/session/refresh?next=${SALON}/compte`, `${SALON}/compte/session/fin`])(
    'refuse les routes de session, qui repartent aussitôt : %s',
    (route) => {
      expect(safeReturnPath(route, SLUG)).toBeNull();
    },
  );
});

describe('withReturnPath', () => {
  it('laisse le chemin intact quand il n’y a pas de retour à porter', () => {
    expect(withReturnPath(`${SALON}/compte/inscription`, null)).toBe(`${SALON}/compte/inscription`);
  });

  it('ajoute le retour, encodé', () => {
    expect(withReturnPath(`${SALON}/compte/inscription`, `${SALON}/reservation`)).toBe(
      `${SALON}/compte/inscription?${RETURN_QUERY_KEY}=${encodeURIComponent(`${SALON}/reservation`)}`,
    );
  });

  it('s’ajoute à une query string existante au lieu de l’écraser', () => {
    const composed = withReturnPath(
      `${SALON}/compte/connexion?motif=session-expiree`,
      `${SALON}/reservation`,
    );

    const search = new URLSearchParams(composed.slice(composed.indexOf('?')));

    expect(search.get('motif')).toBe('session-expiree');
    expect(search.get(RETURN_QUERY_KEY)).toBe(`${SALON}/reservation`);
  });

  it('fait l’aller-retour : ce qu’il écrit, le garde-fou le relit tel quel', () => {
    const target = `${SALON}/reservation?etape=coordonnees`;
    const href = withReturnPath(`${SALON}/compte/connexion`, target);
    const search = new URLSearchParams(href.slice(href.indexOf('?')));

    expect(safeReturnPath(search.get(RETURN_QUERY_KEY), SLUG)).toBe(target);
  });
});
