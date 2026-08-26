import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { AppConfigService } from '../../../config/app-config.service';
import type { Env, NodeEnv } from '../../../config/env.schema';
import {
  clearRefreshCookie,
  readRefreshCookie,
  refreshCookieOptions,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  setRefreshCookie,
} from '../refresh-cookie';

/** Requête minimale — seuls les en-têtes comptent ici. */
function requestWithCookie(header: string | undefined): Request {
  return { headers: header === undefined ? {} : { cookie: header } } as Request;
}

/** `AppConfigService` sur un seul `NODE_ENV` — c'est tout ce que le drapeau lit. */
function appConfigFor(nodeEnv: NodeEnv): AppConfigService {
  return new AppConfigService({ get: () => nodeEnv } as unknown as ConfigService<Env, true>);
}

describe('cookie de rafraîchissement', () => {
  describe('attributs', () => {
    it('est httpOnly, SameSite=Lax et borné aux routes d’authentification', () => {
      const options = refreshCookieOptions({ secure: true, maxAgeSeconds: 604800 });

      // `httpOnly` retire le jeton de portée de JavaScript : une XSS ne peut plus
      // l'exfiltrer pour le rejouer ailleurs et plus tard.
      expect(options.httpOnly).toBe(true);
      // `lax` ferme le CSRF sur `/auth/refresh` sans casser le retour depuis un
      // lien externe.
      expect(options.sameSite).toBe('lax');
      expect(options.path).toBe(REFRESH_COOKIE_PATH);
      expect(options.maxAge).toBe(604800 * 1000);
    });

    it('exige HTTPS dès qu’on est déployé', () => {
      expect(refreshCookieOptions({ secure: true, maxAgeSeconds: 1 }).secure).toBe(true);
    });

    it('relâche `secure` hors déploiement — sinon le cookie ne reviendrait jamais en local', () => {
      expect(refreshCookieOptions({ secure: false, maxAgeSeconds: 1 }).secure).toBe(false);
    });

    it('couvre `staging` autant que `production` — les deux servent en HTTPS', () => {
      // Le drapeau vient de `AppConfigService.isDeployed`, pas de `isProduction` :
      // `staging` sert derrière le même ALB TLS, et un cookie sans `Secure` y
      // partirait en clair au premier appel `http://` que le navigateur émettrait.
      for (const nodeEnv of ['staging', 'production'] as const) {
        expect(appConfigFor(nodeEnv).isDeployed).toBe(true);
      }
      for (const nodeEnv of ['development', 'test'] as const) {
        expect(appConfigFor(nodeEnv).isDeployed).toBe(false);
      }
    });

    it('couvre la déconnexion autant que le rafraîchissement', () => {
      // La déconnexion a besoin du jeton pour savoir quelle session éteindre : un
      // chemin borné à `/auth/refresh` la priverait du cookie.
      expect('/api/v1/auth/logout'.startsWith(REFRESH_COOKIE_PATH)).toBe(true);
      expect('/api/v1/auth/refresh'.startsWith(REFRESH_COOKIE_PATH)).toBe(true);
    });
  });

  describe('écriture', () => {
    it('pose le cookie sous son nom, avec ses options', () => {
      const cookie = jest.fn();
      setRefreshCookie({ cookie } as unknown as Response, 'le-jeton', {
        secure: true,
        maxAgeSeconds: 60,
      });

      expect(cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'le-jeton',
        expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax' }),
      );
    });

    it('efface avec les mêmes `path` et `sameSite`, sans quoi le cookie survivrait', () => {
      const clearCookie = jest.fn();
      clearRefreshCookie({ clearCookie } as unknown as Response, { secure: true });

      expect(clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.objectContaining({ path: REFRESH_COOKIE_PATH, sameSite: 'lax', httpOnly: true }),
      );
      // `maxAge` n'a pas de sens sur un effacement et brouillerait la
      // correspondance d'attributs que fait le navigateur.
      const options = clearCookie.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('maxAge');
    });
  });

  describe('lecture', () => {
    it('retrouve le jeton parmi d’autres cookies', () => {
      const request = requestWithCookie(`theme=dark; ${REFRESH_COOKIE_NAME}=le-jeton; lang=fr`);
      expect(readRefreshCookie(request)).toBe('le-jeton');
    });

    it('lit un jeton seul, sans espaces', () => {
      expect(readRefreshCookie(requestWithCookie(`${REFRESH_COOKIE_NAME}=le-jeton`))).toBe(
        'le-jeton',
      );
    });

    it('décode la valeur — le navigateur la perceve encodée', () => {
      expect(readRefreshCookie(requestWithCookie(`${REFRESH_COOKIE_NAME}=a%2Bb`))).toBe('a+b');
    });

    it.each([
      ['aucun en-tête', undefined],
      ['en-tête vide', ''],
      ['un autre cookie seulement', 'theme=dark'],
      ['un cookie vidé par le navigateur', `${REFRESH_COOKIE_NAME}=`],
      // `decodeURIComponent` **lève** là-dessus. La lecture est appelée par le
      // contrôleur hors de tout `try` : sans la garde, l'`URIError` remonterait
      // au filtre et répondrait 500 sur `/auth/logout`, dont le contrat est de
      // ne jamais échouer.
      ['un échappement mal formé', `${REFRESH_COOKIE_NAME}=%E0%A4%A`],
      ['un pourcent isolé', `${REFRESH_COOKIE_NAME}=%`],
    ])('rend `null` sur %s', (_cas, header) => {
      expect(readRefreshCookie(requestWithCookie(header))).toBeNull();
    });

    it('ne se laisse pas accrocher par un nom qui contient le sien', () => {
      // `autre_spa_refresh_token` contient `spa_refresh_token` : une expression
      // rationnelle naïve sur le nom y accrocherait et lirait la mauvaise valeur.
      const request = requestWithCookie(
        `autre_${REFRESH_COOKIE_NAME}=piege; ${REFRESH_COOKIE_NAME}=le-vrai`,
      );
      expect(readRefreshCookie(request)).toBe('le-vrai');
    });

    it('ne confond pas le jeton avec la valeur d’un autre cookie', () => {
      const request = requestWithCookie(`decoy=${REFRESH_COOKIE_NAME}=piege`);
      expect(readRefreshCookie(request)).toBeNull();
    });
  });
});
