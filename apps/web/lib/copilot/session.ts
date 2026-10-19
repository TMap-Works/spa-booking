import { createHash } from 'node:crypto';

import { copilotSessionSchema, surfaceOf, type CopilotSession, type PublicTenant } from '@spa/shared';

import { ApiClientError, fetchOwnProfile, fetchPublicTenant, type OwnProfile } from '@/lib/api-client';
import type { ActionAccess, SessionNotice } from '@/lib/session-refresh';

/**
 * Détection de la session du copilot — spécification §5, P1-05 (#1452).
 *
 * ## À chaque message, et côté serveur seulement
 *
 * Rien n'est gardé d'un message à l'autre, hors le cache court du profil :
 * déconnexion, changement de rôle ou expiration valent dès le message suivant.
 * Le navigateur ne fournit jamais la session ; il ne fournit que le contexte de
 * page, qui reste indicatif.
 *
 * ## Pourquoi un « espace »
 *
 * Les cookies de session sont posés sur `/{salon}/admin` et `/{salon}/compte`
 * (inventaire §6.1) : une route servie ailleurs ne les reçoit pas. La route du
 * copilot est donc montée sous chaque espace, comme le flux temps réel
 * (`admin/flux/route.ts`), et c'est elle qui fournit `access` — la lecture de
 * ses propres cookies, renouvellement compris (`accessTokenForAction`).
 * L'espace public n'a pas de cookie : la personne y est toujours visiteuse.
 *
 * ## Le jeton
 *
 * Il sort de cette fonction **à côté** de la session, jamais dedans : la session
 * est décrite au modèle, le jeton ne sert qu'aux appels de l'API que le serveur
 * fait pour exécuter une action. Le cache du profil a pour clé une empreinte du
 * jeton, jamais le jeton lui-même.
 */

export type CopilotSpace = 'public' | 'compte' | 'admin';

export interface ResolvedCopilotSession {
  readonly session: CopilotSession;
  /** Jeton d'accès pour les appels de l'API ; `null` pour une visiteuse. Jamais montré au modèle. */
  readonly accessToken: string | null;
  /** Ce que le chat doit dire de la session : expirée, ou renouvellement impossible. */
  readonly notice: SessionNotice | null;
  /**
   * Qui parle, pour ranger la conversation : empreinte du compte, jamais son
   * identifiant ni son e-mail. `null` pour une visiteuse.
   */
  readonly subject: string | null;
}

export interface CopilotSessionDeps {
  /** Le jeton de l'espace, renouvelé au besoin. Absent pour l'espace public. */
  readonly access?: () => Promise<ActionAccess>;
  readonly fetchProfile?: (accessToken: string) => Promise<OwnProfile>;
  readonly fetchTenant?: (tenantSlug: string) => Promise<PublicTenant>;
  readonly profileCache?: ProfileCache;
}

/**
 * `GET /auth/me` est limité à 60 appels par minute et par compte, et le
 * back-office l'appelle déjà à chaque rendu : le profil est gardé trente
 * secondes. Un changement de rôle met donc au plus ce délai à se voir, ce que
 * la spécification accepte ; l'API, elle, revérifie chaque appel aussitôt.
 */
export class ProfileCache {
  private readonly entries = new Map<string, { profile: OwnProfile; expiresAt: number }>();

  public constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  public async get(accessToken: string, load: (accessToken: string) => Promise<OwnProfile>): Promise<OwnProfile> {
    const key = createHash('sha256').update(accessToken).digest('hex');
    const hit = this.entries.get(key);

    if (hit !== undefined && hit.expiresAt > this.now()) {
      return hit.profile;
    }

    const profile = await load(accessToken);
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      // La plus ancienne insertion part la première : un Map garde l'ordre.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { profile, expiresAt: this.now() + this.ttlMs });
    return profile;
  }
}

const sharedProfileCache = new ProfileCache();

/**
 * La session du copilot pour ce message.
 *
 * Lève l'erreur de `fetchTenant` quand le salon n'existe pas : la route en fait
 * un 404, comme le reste du site. Tout le reste se dégrade en visiteuse — une
 * session illisible ne doit jamais ouvrir plus qu'elle ne montre.
 */
export async function resolveCopilotSession(
  space: CopilotSpace,
  tenantSlug: string,
  deps: CopilotSessionDeps = {},
): Promise<ResolvedCopilotSession> {
  const fetchTenant = deps.fetchTenant ?? fetchPublicTenant;
  const fetchProfile = deps.fetchProfile ?? fetchOwnProfile;
  const cache = deps.profileCache ?? sharedProfileCache;

  const tenant = await fetchTenant(tenantSlug);
  const visitor = (notice: SessionNotice | null): ResolvedCopilotSession => ({
    session: buildSession(tenantSlug, tenant, null),
    accessToken: null,
    notice,
    subject: null,
  });

  if (space === 'public' || deps.access === undefined) {
    return visitor(null);
  }

  const access = await deps.access();
  switch (access.kind) {
    case 'expired':
      return visitor('session-expiree');
    case 'failed':
      return visitor('renouvellement-indisponible');
    case 'ready':
      break;
  }

  let profile: OwnProfile;
  try {
    profile = await cache.get(access.accessToken, fetchProfile);
  } catch (error) {
    // 401 : jeton expiré entre-temps, ou émis pour un autre salon que celui de
    // l'adresse (l'API recoupe le tenant du JWT avec le slug). Dans les deux
    // cas, la personne n'est connue de ce salon que comme visiteuse.
    if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
      return visitor('session-expiree');
    }
    throw error;
  }

  return {
    session: buildSession(tenantSlug, tenant, profile),
    accessToken: access.accessToken,
    notice: null,
    subject: createHash('sha256').update(`copilot:${profile.id}`).digest('hex').slice(0, 32),
  };
}

function buildSession(tenantSlug: string, tenant: PublicTenant, profile: OwnProfile | null): CopilotSession {
  const role = profile?.role ?? null;
  return copilotSessionSchema.parse({
    surface: surfaceOf(role),
    role,
    permissions: profile?.permissions ?? [],
    tenant: { slug: tenantSlug, timezone: tenant.timezone, currency: tenant.defaultCurrency },
    locale: profile?.locale ?? tenant.defaultLocale,
  });
}
