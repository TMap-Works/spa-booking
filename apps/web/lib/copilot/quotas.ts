import { createHash } from 'node:crypto';

/**
 * Les quotas du copilot — spécification §9, P1-08 (#1455).
 *
 * Trois compteurs, en fenêtres fixes, comptés à **chaque exécution** de
 * l'agent (un message, ou la relance qui suit un outil du navigateur) :
 *
 * - par compte — une personne connectée ne fait pas tourner le chat en boucle ;
 * - par visiteuse — même borne, plus serrée, sous une empreinte de son adresse ;
 * - par salon — le plafond de dépense, quoi qu'il arrive aux deux autres.
 *
 * Le dépassement ne coûte rien : la route répond par un texte fixe, sans
 * appeler le modèle. L'adresse de la visiteuse est celle que donne le premier
 * élément de `x-forwarded-for` ; elle peut être falsifiée, et c'est pourquoi le
 * plafond par salon existe — c'est lui qui borne la facture.
 */

export const COPILOT_QUOTAS = {
  compte: { limite: 40, fenetreSecondes: 10 * 60 },
  visiteur: { limite: 15, fenetreSecondes: 10 * 60 },
  salon: { limite: 3_000, fenetreSecondes: 24 * 60 * 60 },
} as const;

export type QuotaScope = keyof typeof COPILOT_QUOTAS;

export interface CounterStore {
  /** Incrémente et rend la nouvelle valeur ; la fenêtre s'ouvre au premier compte. */
  increment(key: string, ttlSeconds: number): Promise<number>;
}

/** Ce que le compteur Redis attend de la connexion. */
export interface RedisCounterLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: RedisCounterLike) {}

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.redis.incr(`quota:${key}`);
    if (value === 1) await this.redis.expire(`quota:${key}`, ttlSeconds);
    return value;
  }
}

/** Développement local, sans Redis. */
export class MemoryCounterStore implements CounterStore {
  readonly #counters = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const current = this.#counters.get(key);
    const live = current !== undefined && current.expiresAt > this.now() ? current : undefined;
    const next = { value: (live?.value ?? 0) + 1, expiresAt: live?.expiresAt ?? this.now() + ttlSeconds * 1000 };
    this.#counters.set(key, next);
    return next.value;
  }
}

export interface QuotaSubject {
  readonly tenantSlug: string;
  /** Empreinte du compte connecté, `null` pour une visiteuse. */
  readonly subject: string | null;
  /** La requête, pour l'adresse d'une visiteuse. */
  readonly request: Request;
}

export type QuotaVerdict = { readonly ok: true } | { readonly ok: false; readonly portee: QuotaScope };

function visitorKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'inconnue';
  return createHash('sha256').update(`copilot-visiteur:${forwarded}`).digest('hex').slice(0, 32);
}

export async function checkQuotas(store: CounterStore, { tenantSlug, subject, request }: QuotaSubject): Promise<QuotaVerdict> {
  const personal: [QuotaScope, string] =
    subject === null ? ['visiteur', `${tenantSlug}:visiteur:${visitorKey(request)}`] : ['compte', `${tenantSlug}:compte:${subject}`];

  for (const [scope, key] of [personal, ['salon', `${tenantSlug}:salon`] as [QuotaScope, string]]) {
    const { limite, fenetreSecondes } = COPILOT_QUOTAS[scope];
    if ((await store.increment(key, fenetreSecondes)) > limite) return { ok: false, portee: scope };
  }
  return { ok: true };
}

/** Une requête qui fait tourner l'agent — et donc le modèle. */
export function isAgentRun(request: Request, basePath: string): boolean {
  if (request.method !== 'POST') return false;
  const path = new URL(request.url).pathname;
  return path.startsWith(`${basePath}/agent/`) && path.endsWith('/run');
}
