/**
 * Registre d'actions du copilot IA — [spécification §6.3](../../../../docs/copilot/specification.md),
 * [ADR 0018](../../../../docs/adr/0018-copilot-ia-dans-le-produit.md).
 *
 * C'est la source de vérité de **ce que le chat peut faire** : chaque entrée dit
 * à quel domaine l'action appartient, si elle lit, mène ou écrit, ce qu'elle
 * exige de la session, et le schéma de ses paramètres. L'inventaire des écrans
 * (`docs/copilot/inventaire.md` §5) liste les mêmes identifiants, avec
 * l'endpoint de l'API sur lequel chacune s'appuie, et un test confronte les deux.
 *
 * ## Ce que le registre n'est pas
 *
 * Une autorisation. Il décide de ce qu'on **décrit au modèle** : une action non
 * permise n'apparaît pas dans ses outils. Mais l'exécution passe toujours par
 * l'API avec le jeton de la session courante, et ce sont ses gardes
 * (ADR 0013) qui tranchent. Un registre trop large ne donne donc aucun droit ;
 * un registre trop étroit ne fait que cacher une action.
 *
 * ## Les schémas de paramètres
 *
 * Ils valident **l'appel du modèle** avant toute exécution. Tous sont `.strict()`
 * — un paramètre inventé est refusé, pas ignoré — et reprennent les primitives
 * du contrat (`uuidSchema`, `calendarDateSchema`…) pour ne jamais être plus
 * permissifs que l'API. Les noms sont en français, comme les paramètres
 * d'adresse du front (`?prestation=`, `?praticien=`) : c'est le vocabulaire que
 * le modèle lit dans le contexte de page.
 */

import { z } from 'zod';

import { calendarDateSchema } from '../common/time';
import { longTextSchema, reasonSchema, uuidSchema } from '../common/identifiers';
import { PERMISSIONS, type Permission } from '../constants/permissions';
import { CUSTOMER_SEARCH_MAX_LENGTH, CUSTOMER_SEARCH_MIN_LENGTH } from '../schemas/crm';

/** Les spécialistes de la spécification §6.2 — un agent par domaine, jamais par page. */
export const COPILOT_DOMAINS = [
  'salon',
  'reservation',
  'guide',
  'rendez_vous',
  'clients',
  'encaissement',
] as const;

export type CopilotDomain = (typeof COPILOT_DOMAINS)[number];

/**
 * `lecture` appelle un endpoint de l'API et en résume le résultat ;
 * `navigation` mène à une adresse du front, préfiltrée ; `ecriture` modifie des
 * données et n'est jamais exécutée sans le clic « Valider » de l'utilisateur.
 */
export const COPILOT_ACTION_NATURES = ['lecture', 'navigation', 'ecriture'] as const;

export type CopilotActionNature = (typeof COPILOT_ACTION_NATURES)[number];

/**
 * Ce qu'une action exige de la session :
 *
 * - `public` — rien : un visiteur sans compte y a droit ;
 * - `client` — une cliente connectée, sur ses propres rendez-vous. Ce n'est pas
 *   une permission de la matrice (le rôle `CLIENT` n'en porte aucune) : les
 *   routes de l'espace client sont gardées par `@Auth('CLIENT')` ;
 * - `personnel` — tout compte de l'établissement (`STAFF`, `MANAGER`, `ADMIN`),
 *   pour les écrans que l'API garde par rang (`@AuthAtLeast('STAFF')`) ;
 * - une `Permission` de l'ADR 0013 — la session doit la porter.
 */
export type CopilotRequirement = 'public' | 'client' | 'personnel' | Permission;

export const COPILOT_REQUIREMENTS: readonly CopilotRequirement[] = [
  'public',
  'client',
  'personnel',
  ...PERMISSIONS,
];

export function isCopilotRequirement(value: unknown): value is CopilotRequirement {
  return typeof value === 'string' && (COPILOT_REQUIREMENTS as readonly string[]).includes(value);
}

export interface CopilotActionDefinition {
  readonly domaine: CopilotDomain;
  readonly nature: CopilotActionNature;
  readonly exige: CopilotRequirement;
  /** Ce que lit le modèle pour choisir l'outil : une phrase, au présent. */
  readonly description: string;
  readonly parametres: z.ZodTypeAny;
  /** `true` pour toute écriture, et pour elles seules (test de cohérence). */
  readonly confirmation: boolean;
}

/** Plage horaire d'une journée, dans le fuseau du salon (ADR 0006). */
export const COPILOT_DAY_PARTS = ['matin', 'apres-midi', 'soir'] as const;

export type CopilotDayPart = (typeof COPILOT_DAY_PARTS)[number];

const plage = z.enum(COPILOT_DAY_PARTS);

/** Instant avec décalage explicite, comme l'exige le corps des écritures de l'API. */
const instant = z.string().datetime({ offset: true });

/** Mois affiché par le report : `?mois=AAAA-MM`. */
const mois = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const aucun = z.object({}).strict();

const unRendezVous = z.object({ rendezVous: uuidSchema }).strict();

/**
 * Destinations de `guide.mener`. Le registre ne propose une route qu'à qui peut
 * l'ouvrir : chacune porte sa propre exigence, plus fine que celle de l'action.
 * Les chemins sont relatifs au salon (`/{salon}` est ajouté à l'exécution).
 */
export const COPILOT_GUIDE_ROUTES = {
  politique_donnees: { chemin: '/politique-donnees', exige: 'public' },
  connexion: { chemin: '/compte/connexion', exige: 'public' },
  inscription: { chemin: '/compte/inscription', exige: 'public' },
  coordonnees: { chemin: '/compte/coordonnees', exige: 'client' },
  historique: { chemin: '/compte/historique', exige: 'client' },
  catalogue: { chemin: '/admin/catalogue', exige: 'personnel' },
  catalogue_rubriques: { chemin: '/admin/catalogue/rubriques', exige: 'personnel' },
  catalogue_apercu: { chemin: '/admin/catalogue/apercu', exige: 'personnel' },
  personnel: { chemin: '/admin/personnel', exige: 'accounts:read' },
  reglages: { chemin: '/admin/reglages', exige: 'settings:write' },
  // L'abonnement est réservé à `ADMIN` ; `settings:write` est la permission
  // que seul ce rôle porte (ADR 0013).
  abonnement: { chemin: '/admin/abonnement', exige: 'settings:write' },
} as const satisfies Record<string, { chemin: string; exige: CopilotRequirement }>;

export type CopilotGuideRoute = keyof typeof COPILOT_GUIDE_ROUTES;

const GUIDE_ROUTE_IDS = Object.keys(COPILOT_GUIDE_ROUTES) as [CopilotGuideRoute, ...CopilotGuideRoute[]];

export const COPILOT_ACTIONS = {
  // --- Salon et catalogue (public) -----------------------------------------
  'salon.infos': {
    domaine: 'salon',
    nature: 'lecture',
    exige: 'public',
    description: "Lit les informations publiques du salon : nom, adresse, téléphone, horaires d'ouverture.",
    parametres: aucun,
    confirmation: false,
  },
  'salon.politique_donnees': {
    domaine: 'guide',
    nature: 'lecture',
    exige: 'public',
    description: 'Lit la politique de données personnelles du salon : finalités et durées de conservation.',
    parametres: aucun,
    confirmation: false,
  },
  'catalogue.chercher': {
    domaine: 'reservation',
    nature: 'lecture',
    exige: 'public',
    description:
      'Cherche dans les prestations du salon par mot-clé (« massage », « barbe ») et rend leur durée, leur prix et leurs praticiens.',
    parametres: z.object({ recherche: z.string().trim().min(1).max(80).optional() }).strict(),
    confirmation: false,
  },
  'disponibilite.creneaux': {
    domaine: 'reservation',
    nature: 'lecture',
    exige: 'public',
    description: "Liste les créneaux libres d'une prestation pour un jour donné, éventuellement avec un praticien et sur une plage.",
    parametres: z
      .object({
        prestation: uuidSchema,
        praticien: uuidSchema.optional(),
        jour: calendarDateSchema,
        plage: plage.optional(),
      })
      .strict(),
    confirmation: false,
  },
  'reservation.ouvrir_tunnel': {
    domaine: 'reservation',
    nature: 'navigation',
    exige: 'public',
    description: 'Ouvre le tunnel de réservation, préfiltré sur une prestation, un praticien, un jour et une plage.',
    // Les clés sont celles de l'adresse du tunnel (lib/booking/draft.ts) ;
    // `jour` et `plage` y arrivent avec P2-02.
    parametres: z
      .object({
        prestation: uuidSchema.optional(),
        praticien: uuidSchema.optional(),
        jour: calendarDateSchema.optional(),
        plage: plage.optional(),
      })
      .strict(),
    confirmation: false,
  },
  'guide.mener': {
    domaine: 'guide',
    nature: 'navigation',
    exige: 'public',
    description: "Mène l'utilisateur à un écran du site pour qu'il y fasse lui-même le geste.",
    parametres: z.object({ route: z.enum(GUIDE_ROUTE_IDS) }).strict(),
    confirmation: false,
  },

  // --- Rendez-vous, côté cliente --------------------------------------------
  'rendez_vous.mes_prochains': {
    domaine: 'rendez_vous',
    nature: 'lecture',
    exige: 'client',
    description: 'Liste les prochains rendez-vous de la cliente connectée.',
    parametres: z.object({ limite: z.number().int().min(1).max(20).optional() }).strict(),
    confirmation: false,
  },
  'rendez_vous.mon_historique': {
    domaine: 'rendez_vous',
    nature: 'lecture',
    exige: 'client',
    description: 'Liste les rendez-vous passés de la cliente connectée.',
    parametres: z.object({ limite: z.number().int().min(1).max(20).optional() }).strict(),
    confirmation: false,
  },
  'rendez_vous.ouvrir_report': {
    domaine: 'rendez_vous',
    nature: 'navigation',
    exige: 'client',
    description: "Ouvre l'écran de report d'un rendez-vous de la cliente, sur un mois donné.",
    parametres: z.object({ rendezVous: uuidSchema, mois: mois.optional() }).strict(),
    confirmation: false,
  },
  'rendez_vous.reporter': {
    domaine: 'rendez_vous',
    nature: 'ecriture',
    exige: 'client',
    description: "Reporte un rendez-vous de la cliente à un nouveau créneau libre, après sa validation.",
    parametres: z
      .object({ rendezVous: uuidSchema, debut: instant, praticien: uuidSchema.optional() })
      .strict(),
    confirmation: true,
  },
  'rendez_vous.annuler': {
    domaine: 'rendez_vous',
    nature: 'ecriture',
    exige: 'client',
    description: 'Annule un rendez-vous de la cliente, après sa validation.',
    parametres: z.object({ rendezVous: uuidSchema, motif: reasonSchema.optional() }).strict(),
    confirmation: true,
  },

  // --- Planning, côté praticien et gérance ----------------------------------
  'planning.ma_journee': {
    domaine: 'rendez_vous',
    nature: 'lecture',
    exige: 'agenda:read:own',
    description: 'Lit les rendez-vous du praticien connecté pour un jour donné.',
    parametres: z.object({ jour: calendarDateSchema }).strict(),
    confirmation: false,
  },
  'rendez_vous.marquer_honore': {
    domaine: 'rendez_vous',
    nature: 'ecriture',
    exige: 'appointment:write:own',
    description: 'Marque un rendez-vous passé comme honoré, après validation.',
    parametres: unRendezVous,
    confirmation: true,
  },
  'rendez_vous.marquer_absent': {
    domaine: 'rendez_vous',
    nature: 'ecriture',
    exige: 'appointment:write:own',
    description: "Marque la cliente d'un rendez-vous passé comme absente, après validation.",
    parametres: unRendezVous,
    confirmation: true,
  },
  'planning.ouvrir': {
    domaine: 'rendez_vous',
    nature: 'navigation',
    exige: 'agenda:read:all',
    description: 'Ouvre le planning du salon sur un jour ou une semaine.',
    parametres: z
      .object({ vue: z.enum(['jour', 'semaine']).optional(), date: calendarDateSchema.optional() })
      .strict(),
    confirmation: false,
  },
  'planning.creneaux_libres': {
    domaine: 'rendez_vous',
    nature: 'lecture',
    exige: 'agenda:read:all',
    description: "Liste les créneaux libres d'une prestation pour un jour, côté salon.",
    parametres: z
      .object({
        prestation: uuidSchema,
        praticien: uuidSchema.optional(),
        jour: calendarDateSchema,
        plage: plage.optional(),
      })
      .strict(),
    confirmation: false,
  },
  'rendez_vous.poser': {
    domaine: 'rendez_vous',
    nature: 'ecriture',
    exige: 'appointment:write:all',
    description: 'Pose un rendez-vous pour une cliente sur un créneau libre, après validation.',
    parametres: z
      .object({
        prestation: uuidSchema,
        praticien: uuidSchema.optional(),
        debut: instant,
        cliente: uuidSchema.optional(),
        note: longTextSchema.optional(),
      })
      .strict(),
    confirmation: true,
  },

  // --- Encaissement et reporting --------------------------------------------
  'encaissement.a_regler': {
    domaine: 'encaissement',
    nature: 'lecture',
    exige: 'checkout:collect',
    description: "Liste les rendez-vous d'une journée qui restent à régler, avec le montant dû.",
    parametres: z.object({ jour: calendarDateSchema.optional() }).strict(),
    confirmation: false,
  },
  'encaissement.ouvrir': {
    domaine: 'encaissement',
    nature: 'navigation',
    exige: 'checkout:collect',
    description: "Ouvre l'encaissement d'une journée, éventuellement sur un rendez-vous. Le règlement reste au geste de l'utilisateur.",
    parametres: z.object({ date: calendarDateSchema.optional(), rendezVous: uuidSchema.optional() }).strict(),
    confirmation: false,
  },
  'tableau_de_bord.resumer': {
    domaine: 'encaissement',
    nature: 'lecture',
    exige: 'reporting:read',
    description: "Résume la journée du salon : rendez-vous, chiffre d'affaires, absences, demandes en attente.",
    parametres: aucun,
    confirmation: false,
  },
  'reporting.lire': {
    domaine: 'encaissement',
    nature: 'lecture',
    exige: 'reporting:read',
    description: "Lit les indicateurs d'activité sur une période : chiffre d'affaires, volume de rendez-vous, absences.",
    parametres: z
      .object({
        du: calendarDateSchema,
        au: calendarDateSchema,
        regroupement: z.enum(['jour', 'praticien', 'prestation']).optional(),
      })
      .strict(),
    confirmation: false,
  },
  'reporting.ouvrir': {
    domaine: 'encaissement',
    nature: 'navigation',
    exige: 'reporting:read',
    description: 'Ouvre le reporting sur une période.',
    parametres: z.object({ du: calendarDateSchema.optional(), au: calendarDateSchema.optional() }).strict(),
    confirmation: false,
  },

  // --- Clients ---------------------------------------------------------------
  'clients.chercher': {
    domaine: 'clients',
    nature: 'lecture',
    exige: 'customers:read:all',
    description: 'Cherche une cliente par nom, e-mail ou téléphone.',
    parametres: z
      .object({
        recherche: z.string().trim().min(CUSTOMER_SEARCH_MIN_LENGTH).max(CUSTOMER_SEARCH_MAX_LENGTH),
      })
      .strict(),
    confirmation: false,
  },
  'clients.ouvrir_fiche': {
    domaine: 'clients',
    nature: 'navigation',
    exige: 'customers:read:all',
    description: "Ouvre la fiche d'une cliente.",
    parametres: z.object({ cliente: uuidSchema }).strict(),
    confirmation: false,
  },
} as const satisfies Record<string, CopilotActionDefinition>;

export type CopilotActionId = keyof typeof COPILOT_ACTIONS;

export const COPILOT_ACTION_IDS = Object.keys(COPILOT_ACTIONS) as CopilotActionId[];

/** Paramètres validés d'une action, tels que l'exécution les reçoit. */
export type CopilotActionParams<Id extends CopilotActionId> = z.infer<(typeof COPILOT_ACTIONS)[Id]['parametres']>;

export function isCopilotActionId(value: unknown): value is CopilotActionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COPILOT_ACTIONS, value);
}
