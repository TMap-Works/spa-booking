import { randomUUID } from 'node:crypto';

import { ERROR_CODES, type CopilotActionId, type Locale } from '@spa/shared';

import { ApiClientError } from '@/lib/api-client';

import type { RedisLike } from './transcript-store';

/**
 * Les écritures du copilot — confirmées avant de partir. P3-01 (#1461),
 * spécification §6.2.3 et EF-3.
 *
 * ## Le chemin d'une écriture
 *
 * 1. Un spécialiste **prépare** l'écriture : action du registre, paramètres
 *    validés, récapitulatif lisible. Elle est gardée **côté serveur** cinq
 *    minutes, sous un identifiant lié au salon et à la personne.
 * 2. La page affiche une carte (exécutant `confirmer`) : le récapitulatif, et
 *    « Valider » ou « Refuser ».
 * 3. Le clic n'envoie **que l'identifiant**. Le serveur reprend l'écriture
 *    telle qu'il l'a gardée — le navigateur ne peut rien modifier de ce qui a
 *    été affiché —, l'exécute **une seule fois**, avec le jeton de la session
 *    courante, que l'API revérifie. Sans appel au modèle : c'est l'étage 0.
 *
 * Un refus de l'API — créneau pris, droit manquant, rendez-vous introuvable —
 * est rendu en clair (EF-3), jamais comme une panne.
 */

export const PENDING_WRITE_TTL_SECONDS = 5 * 60;

/** Ce que la carte affiche. */
export interface WriteSummary {
  readonly titre: string;
  readonly lignes: readonly string[];
}

export interface PendingWrite {
  readonly action: CopilotActionId;
  /** Paramètres **déjà validés** par le schéma du registre. */
  readonly parametres: Record<string, unknown>;
  readonly recapitulatif: WriteSummary;
}

/** Qui a préparé l'écriture : seule la même personne, dans le même salon, peut la valider. */
export interface WriteScope {
  readonly tenantSlug: string;
  readonly subject: string;
}

export interface PendingWriteStore {
  put(scope: WriteScope, write: PendingWrite): Promise<string>;
  /** Rend l'écriture et l'efface : une écriture ne s'exécute qu'une fois. */
  take(scope: WriteScope, id: string): Promise<PendingWrite | undefined>;
}

const keyOf = (scope: WriteScope, id: string) => `ecriture:${scope.tenantSlug}:${scope.subject}:${id}`;

export class MemoryPendingWriteStore implements PendingWriteStore {
  readonly #writes = new Map<string, { write: PendingWrite; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(scope: WriteScope, write: PendingWrite): Promise<string> {
    const id = randomUUID();
    this.#writes.set(keyOf(scope, id), { write, expiresAt: this.now() + PENDING_WRITE_TTL_SECONDS * 1000 });
    return id;
  }

  async take(scope: WriteScope, id: string): Promise<PendingWrite | undefined> {
    const key = keyOf(scope, id);
    const entry = this.#writes.get(key);
    this.#writes.delete(key);
    return entry !== undefined && entry.expiresAt > this.now() ? entry.write : undefined;
  }
}

/** Ce que le magasin Redis attend de la connexion. */
export interface RedisWriteLike extends RedisLike {
  getdel(key: string): Promise<string | null>;
}

export class RedisPendingWriteStore implements PendingWriteStore {
  constructor(private readonly redis: RedisWriteLike) {}

  async put(scope: WriteScope, write: PendingWrite): Promise<string> {
    const id = randomUUID();
    await this.redis.set(keyOf(scope, id), JSON.stringify(write), 'EX', PENDING_WRITE_TTL_SECONDS);
    return id;
  }

  async take(scope: WriteScope, id: string): Promise<PendingWrite | undefined> {
    // GETDEL : lire et effacer d'un seul geste, pour qu'un double clic venu
    // de deux tâches ne fasse pas partir l'écriture deux fois.
    const raw = await this.redis.getdel(keyOf(scope, id));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as PendingWrite;
    } catch {
      return undefined;
    }
  }
}

/** L'exécution d'une action d'écriture : l'appel à l'API, avec le jeton de la session. */
export type WriteExecutor = (
  parametres: Record<string, unknown>,
  context: { readonly accessToken: string; readonly tenantSlug: string },
) => Promise<string>;

export type WriteOutcome =
  | { readonly statut: 'faite'; readonly message: string }
  | { readonly statut: 'refusee'; readonly message: string }
  | { readonly statut: 'echec'; readonly message: string };

const TEXTS = {
  fr: {
    refused: "C'est noté, je n'ai rien changé.",
    expired: "Cette proposition a expiré ou a déjà été traitée. Redemandez-la si besoin.",
    session: 'Votre session a expiré : reconnectez-vous, puis redemandez cette action.',
    taken: "Ce créneau vient d'être pris. Demandez-moi les plus proches.",
    forbidden: "Vous n'avez pas le droit de faire cette action.",
    notFound: "Je ne retrouve plus ce rendez-vous : il a peut-être déjà changé.",
    invalidState: "Ce rendez-vous ne peut plus être modifié de cette façon.",
    failed: "L'action n'a pas pu aboutir. Réessayez dans un instant.",
    unknown: "Cette action n'est pas encore possible depuis le chat.",
  },
  en: {
    refused: "Noted, I haven't changed anything.",
    expired: 'This proposal has expired or was already handled. Ask again if needed.',
    session: 'Your session has expired: sign in again, then ask for this action again.',
    taken: 'This slot has just been taken. Ask me for the nearest ones.',
    forbidden: "You aren't allowed to do this.",
    notFound: "I can't find this appointment any more: it may already have changed.",
    invalidState: "This appointment can't be changed this way any more.",
    failed: "The action couldn't go through. Please try again in a moment.",
    unknown: "This action isn't available from the chat yet.",
  },
} as const;

/** Le refus de l'API, dit en clair — sur son code, jamais sur sa phrase (skill web-frontend §2). */
function apiRefusal(error: unknown, locale: Locale): string {
  const text = TEXTS[locale];
  if (!(error instanceof ApiClientError)) return text.failed;
  if (error.status === 409) return text.taken;
  if (error.status === 401) return text.session;
  if (error.status === 403) return text.forbidden;
  if (error.status === 404) return text.notFound;
  if (error.code === ERROR_CODES.INVALID_STATE_TRANSITION) return text.invalidState;
  return text.failed;
}

export interface DecideInput {
  readonly store: PendingWriteStore;
  readonly executors: Partial<Record<CopilotActionId, WriteExecutor>>;
  readonly scope: WriteScope | null;
  readonly accessToken: string | null;
  readonly id: string;
  readonly decision: 'valider' | 'refuser';
  readonly locale: Locale;
}

export async function decideWrite(input: DecideInput): Promise<WriteOutcome> {
  const text = TEXTS[input.locale];
  if (input.scope === null || input.accessToken === null) return { statut: 'echec', message: text.session };

  const write = await input.store.take(input.scope, input.id);
  if (write === undefined) return { statut: 'echec', message: text.expired };
  if (input.decision === 'refuser') return { statut: 'refusee', message: text.refused };

  const execute = input.executors[write.action];
  if (execute === undefined) return { statut: 'echec', message: text.unknown };

  try {
    const message = await execute(write.parametres, { accessToken: input.accessToken, tenantSlug: input.scope.tenantSlug });
    return { statut: 'faite', message };
  } catch (error) {
    return { statut: 'echec', message: apiRefusal(error, input.locale) };
  }
}

/** Une requête de décision ne vient que de la page du salon : même origine, sinon refus. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}
