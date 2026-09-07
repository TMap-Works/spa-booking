import type { ExecutionContext } from '@nestjs/common';

import { InternalCallerGuard } from '../internal-caller.guard';
import {
  INTERNAL_TOKEN_HEADER,
  INTERNAL_TOKEN_MIN_LENGTH,
  NOTIFICATIONS_INTERNAL_TOKEN_ENV,
  NotificationsConfig,
  resolveInternalToken,
} from '../notifications.config';
import {
  InternalCallerRejectedError,
  InternalCallerUnconfiguredError,
} from '../notifications.errors';

/**
 * Le jeton d'appel interne de la chaîne de notifications — #71.
 *
 * C'est la seule chose qui sépare la route de balayage d'un anonyme, et cette
 * route lit les rendez-vous de **tous** les établissements : elle mérite ses
 * propres cas de refus.
 */

/** Un jeton de longueur défendable, sans jamais réutiliser un vrai secret. */
const TOKEN = 'a'.repeat(INTERNAL_TOKEN_MIN_LENGTH);

function context(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function guardWith(source: NodeJS.ProcessEnv): InternalCallerGuard {
  return new InternalCallerGuard(new NotificationsConfig(source));
}

describe('resolveInternalToken — la résolution du secret', () => {
  it('rend le jeton quand il est posé', () => {
    expect(resolveInternalToken({ [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: TOKEN })).toBe(TOKEN);
  });

  it.each([
    ['absente', {}],
    // `''` est ce qu'ECS produit pour une variable déclarée sans valeur : c'est
    // « pas posée », pas « mal posée ».
    ['vide', { [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: '' }],
  ])('rend `null` sur une variable %s — la capacité est hors service, pas l’API', (_label, env) => {
    expect(resolveInternalToken(env)).toBeNull();
  });

  it('refuse un jeton trop court, dans **tout** environnement', () => {
    // Même régime que les préfixes de `StripeConfig` : une valeur présente et
    // dangereuse ne devient pas inoffensive en développement.
    expect(() => resolveInternalToken({ [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: 'trop-court' })).toThrow(
      NOTIFICATIONS_INTERNAL_TOKEN_ENV,
    );
  });

  it('ne cite jamais la valeur reçue dans son message — c’est un secret', () => {
    const secret = 'devinable';

    expect(() =>
      resolveInternalToken({ [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: secret }),
    ).toThrow(expect.not.stringContaining(secret) as unknown as string);
  });
});

describe('InternalCallerGuard — le défaut est fermé', () => {
  it('refuse tout appel quand aucun jeton n’est configuré', () => {
    const guard = guardWith({});

    expect(() => guard.canActivate(context({ [INTERNAL_TOKEN_HEADER]: TOKEN }))).toThrow(
      InternalCallerUnconfiguredError,
    );
  });

  it('laisse passer le bon jeton', () => {
    const guard = guardWith({ [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: TOKEN });

    expect(guard.canActivate(context({ [INTERNAL_TOKEN_HEADER]: TOKEN }))).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['vide', { [INTERNAL_TOKEN_HEADER]: '' }],
    ['faux', { [INTERNAL_TOKEN_HEADER]: 'b'.repeat(INTERNAL_TOKEN_MIN_LENGTH) }],
    ['d’une autre longueur', { [INTERNAL_TOKEN_HEADER]: `${TOKEN}suffixe` }],
    // Un en-tête répété arrive sous forme de tableau. Deux valeurs pour un
    // secret est une requête malformée, pas une requête à interpréter.
    ['répété', { [INTERNAL_TOKEN_HEADER]: [TOKEN, TOKEN] }],
  ])('refuse un jeton %s', (_label, headers) => {
    const guard = guardWith({ [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: TOKEN });

    expect(() => guard.canActivate(context(headers))).toThrow(InternalCallerRejectedError);
  });

  it('ne dit pas, dans son refus, si le jeton était absent ou faux', () => {
    const guard = guardWith({ [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: TOKEN });

    const absent = capture(() => guard.canActivate(context({})));
    const faux = capture(() =>
      guard.canActivate(context({ [INTERNAL_TOKEN_HEADER]: 'c'.repeat(64) })),
    );

    // Même code, même message, aucun détail : tout écart renseignerait qui
    // cherche à deviner le secret.
    expect(absent).toEqual(faux);
  });
});

/** Le code, le message et les détails d'une erreur levée — pour les comparer. */
function capture(run: () => unknown): { code: string; message: string; details: unknown } {
  try {
    run();
  } catch (error) {
    const rejected = error as InternalCallerRejectedError;
    return { code: rejected.code, message: rejected.message, details: rejected.details };
  }

  throw new Error('aucune erreur levée');
}
