/**
 * Session du copilot IA et filtrage du registre —
 * [spécification §5](../../../../docs/copilot/specification.md#5-détection-de-la-session).
 *
 * La route du copilot construit une `CopilotSession` **à chaque message**, côté
 * serveur, depuis `GET /api/v1/auth/me` : rien n'est gardé d'un message à
 * l'autre, et le navigateur ne la fournit jamais. Elle ne contient ni jeton ni
 * donnée personnelle, puisqu'elle sert aussi à décrire au modèle ce qu'il peut
 * proposer.
 *
 * Le filtrage n'est pas une autorisation (voir `actions.ts`) : il borne ce qu'on
 * montre au modèle, et l'API revérifie chaque appel avec le jeton.
 */

import { z } from 'zod';

import { currencyCodeSchema } from '../common/money';
import { slugSchema } from '../common/identifiers';
import { timeZoneSchema } from '../common/time';
import { PERMISSIONS, type Permission } from '../constants/permissions';
import { USER_ROLES, type UserRole } from '../constants/roles';
import { messageKey } from '../errors/zod-messages';
import { localeSchema } from '../locale/locale';
import {
  COPILOT_ACTIONS,
  COPILOT_ACTION_IDS,
  COPILOT_GUIDE_ROUTES,
  type CopilotActionId,
  type CopilotDomain,
  type CopilotGuideRoute,
  type CopilotRequirement,
} from './actions';

/**
 * Les quatre surfaces de la spécification §3 : qui parle au chat. Elles se
 * déduisent du rôle — jamais de l'URL, qui n'est qu'un contexte indicatif.
 */
export const COPILOT_SURFACES = ['visiteur', 'client', 'praticien', 'gerance'] as const;

export type CopilotSurface = (typeof COPILOT_SURFACES)[number];

/** `null` = aucune session vérifiée sur ce salon : la personne est une visiteuse. */
export function surfaceOf(role: UserRole | null): CopilotSurface {
  switch (role) {
    case null:
      return 'visiteur';
    case 'client':
      return 'client';
    case 'staff':
      return 'praticien';
    case 'manager':
    case 'admin':
      return 'gerance';
  }
}

export const copilotSessionSchema = z
  .object({
    surface: z.enum(COPILOT_SURFACES),
    role: z.enum(USER_ROLES).nullable(),
    /** Permissions effectives servies par `/auth/me` ; vide pour une visiteuse. */
    permissions: z.array(z.enum(PERMISSIONS)).readonly(),
    tenant: z
      .object({
        slug: slugSchema,
        timezone: timeZoneSchema,
        currency: currencyCodeSchema,
      })
      .strict(),
    locale: localeSchema,
  })
  .strict()
  .refine((session) => session.surface === surfaceOf(session.role), {
    ...messageKey('copilot.surfaceRole'),
    path: ['surface'],
  })
  .refine((session) => session.role !== null || session.permissions.length === 0, {
    ...messageKey('copilot.visitorPermissions'),
    path: ['permissions'],
  });

export type CopilotSession = z.infer<typeof copilotSessionSchema>;

/** `true` si la session satisfait l'exigence d'une action ou d'une route du guide. */
export function meetsRequirement(session: Pick<CopilotSession, 'surface' | 'permissions'>, exige: CopilotRequirement): boolean {
  switch (exige) {
    case 'public':
      return true;
    case 'client':
      return session.surface === 'client';
    case 'personnel':
      return session.surface === 'praticien' || session.surface === 'gerance';
    default:
      return (session.permissions as readonly Permission[]).includes(exige);
  }
}

/** Les actions à décrire au modèle pour cette session, dans l'ordre du registre. */
export function permittedActions(session: Pick<CopilotSession, 'surface' | 'permissions'>): CopilotActionId[] {
  return COPILOT_ACTION_IDS.filter((id) => meetsRequirement(session, COPILOT_ACTIONS[id].exige));
}

/** Les destinations de `guide.mener` que la session peut ouvrir. */
export function permittedGuideRoutes(session: Pick<CopilotSession, 'surface' | 'permissions'>): CopilotGuideRoute[] {
  return (Object.keys(COPILOT_GUIDE_ROUTES) as CopilotGuideRoute[]).filter((route) =>
    meetsRequirement(session, COPILOT_GUIDE_ROUTES[route].exige),
  );
}

/**
 * Les domaines dont au moins une action est permise. Un spécialiste dont aucun
 * outil n'est permis n'est pas exposé à l'orchestrateur (spécification §6.2) :
 * un praticien ne voit pas l'agent d'encaissement.
 */
export function exposedDomains(session: Pick<CopilotSession, 'surface' | 'permissions'>): CopilotDomain[] {
  const domains = new Set(permittedActions(session).map((id) => COPILOT_ACTIONS[id].domaine));
  return [...domains];
}
