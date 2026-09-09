/**
 * Garde d'origine publique au démarrage (#345).
 *
 * Le critère d'acceptation dit : « une vérification au démarrage échoue si
 * l'origine publique est absente ou vaut `localhost` hors développement ». Ce
 * sont donc les deux axes éprouvés ici — ce qui est refusé, et où cela l'est —
 * plutôt que le fait que `register()` soit appelé, qui appartient à Next.
 *
 * L'environnement est passé en paramètre et jamais posé sur `process.env` :
 * Vitest exécute ces fichiers dans le même processus, et deux suites qui
 * écriraient la même variable ne seraient reproductibles que par chance.
 */

import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_PUBLIC_ORIGIN,
  assertPublicOrigin,
  publicOriginProblem,
  resolvePublicOrigin,
} from '@/lib/public-origin';

/** Un environnement déployé : c'est `NODE_ENV` qui arme la garde. */
function deployed(appUrl?: string): Record<string, string | undefined> {
  return appUrl === undefined
    ? { NODE_ENV: 'production' }
    : { NODE_ENV: 'production', APP_URL: appUrl };
}

describe('resolvePublicOrigin', () => {
  it('rend le repli de développement quand la variable est absente', () => {
    expect(resolvePublicOrigin({})).toBe(DEVELOPMENT_PUBLIC_ORIGIN);
  });

  it('rend le repli de développement quand la variable est vide', () => {
    expect(resolvePublicOrigin({ APP_URL: '   ' })).toBe(DEVELOPMENT_PUBLIC_ORIGIN);
  });

  it('retire la barre oblique finale — une canonique n en porte pas', () => {
    expect(resolvePublicOrigin({ APP_URL: 'https://reservation.exemple.fr//' })).toBe(
      'https://reservation.exemple.fr',
    );
  });
});

describe('publicOriginProblem', () => {
  it('nomme la variable absente', () => {
    expect(publicOriginProblem({})).toContain('APP_URL');
  });

  it('refuse une valeur qui n est pas une URL absolue', () => {
    expect(publicOriginProblem({ APP_URL: 'reservation.exemple.fr' })).toContain(
      "n'est pas une URL absolue",
    );
  });

  it('refuse un schéma qui n est ni http ni https', () => {
    expect(publicOriginProblem({ APP_URL: 'ftp://reservation.exemple.fr' })).toContain('schéma');
  });

  it.each([
    'http://localhost:3000',
    'http://LOCALHOST:3000',
    'https://spa.localhost',
    'http://127.0.0.1:3000',
    'http://127.10.20.30',
    'http://0.0.0.0:3000',
    'http://[::1]:3000',
  ])('refuse « %s », qui ne désigne que la machine courante', (value) => {
    expect(publicOriginProblem({ APP_URL: value })).toContain('machine courante');
  });

  it('refuse une origine qui porte des identifiants', () => {
    expect(publicOriginProblem({ APP_URL: 'https://robot:motdepasse@reservation.exemple.fr' })).toContain(
      'identifiants',
    );
  });

  it.each(['https://reservation.exemple.fr/app', 'https://reservation.exemple.fr/?a=1'])(
    'refuse « %s » : une origine ne porte ni chemin, ni requête',
    (value) => {
      expect(publicOriginProblem({ APP_URL: value })).toContain('chemin');
    },
  );

  it('accepte une origine publique réelle', () => {
    expect(publicOriginProblem({ APP_URL: 'https://reservation.exemple.fr' })).toBeNull();
  });

  it('accepte la barre oblique finale, que `resolvePublicOrigin` retire', () => {
    expect(publicOriginProblem({ APP_URL: 'https://reservation.exemple.fr/' })).toBeNull();
  });

  it("accepte le nom DNS d'un ALB, qui est ce que pose Terraform en dev", () => {
    expect(
      publicOriginProblem({ APP_URL: 'https://spa-dev-alb-123456789.eu-west-3.elb.amazonaws.com' }),
    ).toBeNull();
  });
});

describe('assertPublicOrigin', () => {
  it('laisse passer le développement sans origine publique', () => {
    expect(() => assertPublicOrigin({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('laisse passer le développement sur localhost', () => {
    expect(() =>
      assertPublicOrigin({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000' }),
    ).not.toThrow();
  });

  it('laisse passer les tests, qui tournent aussi sur localhost', () => {
    expect(() =>
      assertPublicOrigin({ NODE_ENV: 'test', APP_URL: 'http://localhost:3100' }),
    ).not.toThrow();
  });

  it('arme la garde quand NODE_ENV est absente — le doute ne relâche rien', () => {
    expect(() => assertPublicOrigin({ APP_URL: 'http://localhost:3000' })).toThrow(
      /machine courante/,
    );
  });

  it('refuse une origine absente en déployé', () => {
    expect(() => assertPublicOrigin(deployed())).toThrow(/s'arrête au lieu de servir/);
  });

  it('refuse localhost en déployé', () => {
    expect(() => assertPublicOrigin(deployed('http://localhost:3000'))).toThrow(
      /machine courante/,
    );
  });

  it('laisse passer une origine publique en déployé', () => {
    expect(() => assertPublicOrigin(deployed('https://reservation.exemple.fr'))).not.toThrow();
  });
});
