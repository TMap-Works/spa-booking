import {
  PLATFORM_TENANT_SEARCH_MAX_LENGTH,
  TENANT_BILLING_STATUSES,
  type PlatformTenant,
  type PlatformTenantDetail,
  type PlatformTenantEvent,
  type PlatformTenantListQuery,
  type PlatformTenantState,
  type TenantBillingStatus,
} from '@spa/shared';

/**
 * La console de l'éditeur, ce qui se décide sans DOM — libellés, mise en route,
 * filtres de la liste, export CSV.
 */

/** La teinte d'une pastille, dans le vocabulaire des badges du back-office. */
export type BadgeTone = 'completed' | 'pending' | 'confirmed' | 'no-show' | 'cancelled';

/** Le libellé court d'un statut de facturation, tel qu'un filtre le propose. */
export const BILLING_STATUS_LABELS: Readonly<Record<TenantBillingStatus, string>> = {
  managed: 'Géré par la plateforme',
  pending: 'Paiement en attente',
  trialing: 'Essai',
  active: 'Abonné',
  past_due: 'Impayé',
  canceled: 'Résilié',
};

const BILLING_STATUS_TONES: Readonly<Record<TenantBillingStatus, BadgeTone>> = {
  managed: 'completed',
  pending: 'pending',
  trialing: 'confirmed',
  active: 'confirmed',
  past_due: 'no-show',
  canceled: 'cancelled',
};

/** « 25 sept. 2026 » dans le fuseau du salon. */
export function formatPlatformDate(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone, dateStyle: 'medium' }).format(
    new Date(instant),
  );
}

/** « 25/09/2026 14:32 » dans le fuseau donné. */
export function formatPlatformDateTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(instant));
}

/**
 * La pastille de facturation d'un salon. L'essai porte sa date de fin : c'est
 * ce que l'éditeur surveille.
 */
export function billingBadge(tenant: PlatformTenant): { label: string; tone: BadgeTone } {
  if (tenant.billingStatus === 'trialing' && tenant.trialEndsAt !== null) {
    return {
      label: `Essai · fin le ${new Intl.DateTimeFormat('fr-FR', {
        timeZone: tenant.timezone,
        dateStyle: 'short',
      }).format(new Date(tenant.trialEndsAt))}`,
      tone: 'confirmed',
    };
  }
  if (tenant.billingStatus === 'past_due') {
    return { label: 'Impayé — relance', tone: 'no-show' };
  }
  return {
    label: BILLING_STATUS_LABELS[tenant.billingStatus],
    tone: BILLING_STATUS_TONES[tenant.billingStatus],
  };
}

const ORIGIN_LABELS: Readonly<Record<PlatformTenant['origin'], string>> = {
  console: 'Ouvert par la console',
  signup: 'Inscrit en ligne',
  legacy: 'Créé hors console',
};

/** L'origine d'un salon, en toutes lettres. */
export function originLabel(tenant: PlatformTenant): string {
  return ORIGIN_LABELS[tenant.origin];
}

/** Jours entiers restants jusqu'à un instant — `0` le jour même, jamais négatif. */
export function daysUntil(instant: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(instant) - now.getTime()) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Mise en route
// ---------------------------------------------------------------------------

/** Une étape de la mise en route d'un salon. */
export interface SetupStep {
  readonly key: string;
  readonly label: string;
  readonly done: boolean;
  /** Ce qu'on voit quand l'étape est faite, ou ce qu'il reste à faire. */
  readonly detail: string;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count > 1 ? pluralForm : singular}`;
}

/**
 * Les étapes qui mènent un salon à sa première réservation, dans l'ordre où
 * on les franchit. C'est la liste qu'un opérateur déroule au téléphone.
 */
export function setupSteps(detail: PlatformTenantDetail): readonly SetupStep[] {
  const { setup } = detail;

  return [
    {
      key: 'admin',
      label: 'Compte administrateur activé',
      done: setup.adminActivated,
      detail: setup.adminActivated
        ? 'Le gérant a posé son mot de passe.'
        : 'Invitation non acceptée — renvoyer les liens d’accès.',
    },
    {
      key: 'adresse',
      label: 'Adresse du salon',
      done: setup.address,
      detail: setup.address ? 'Affichée sur la vitrine.' : 'À saisir dans les réglages du salon.',
    },
    {
      key: 'horaires',
      label: 'Horaires d’ouverture',
      done: setup.openingHours,
      detail: setup.openingHours ? 'Renseignés.' : 'Aucun horaire saisi.',
    },
    {
      key: 'prestations',
      label: 'Prestations en ligne',
      done: setup.activeServices > 0,
      detail:
        setup.activeServices > 0
          ? plural(setup.activeServices, 'prestation active', 'prestations actives')
          : 'Aucune prestation active.',
    },
    {
      key: 'praticiens',
      label: 'Praticiens avec horaires',
      done: setup.staffWithSchedule > 0,
      detail:
        setup.activeStaff === 0
          ? 'Aucun praticien actif.'
          : `${plural(setup.staffWithSchedule, 'praticien')} avec horaires sur ${String(setup.activeStaff)} actif${setup.activeStaff > 1 ? 's' : ''}`,
    },
    {
      key: 'legal',
      label: 'Identité légale (ticket de caisse)',
      done: setup.legalIdentity,
      detail: setup.legalIdentity
        ? 'Raison sociale et identifiant renseignés.'
        : 'Raison sociale ou SIRET / NIF manquant.',
    },
    {
      key: 'premier-rdv',
      label: 'Premier rendez-vous',
      done: setup.firstAppointmentAt !== null,
      detail:
        setup.firstAppointmentAt === null
          ? 'Aucun rendez-vous pour l’instant.'
          : `Le ${formatPlatformDate(setup.firstAppointmentAt, detail.tenant.timezone)}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

/** Le titre d'une ligne d'historique. */
export function eventTitle(event: PlatformTenantEvent): string {
  switch (event.kind) {
    case 'provisioned':
      return 'Salon ouvert depuis la console';
    case 'note':
      return 'Note';
    case 'suspended':
      return 'Salon suspendu';
    case 'reactivated':
      return 'Salon réactivé';
    case 'invitation_reissued':
      return 'Liens d’accès renvoyés';
  }
}

// ---------------------------------------------------------------------------
// Filtres de la liste
// ---------------------------------------------------------------------------

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Les filtres de la liste, relus de l'adresse. Une valeur inconnue est ignorée
 * plutôt que d'envoyer à l'API une requête qu'elle refuserait en 400 : une
 * adresse bricolée rend la liste entière, pas une erreur.
 */
export function readTenantFilters(params: SearchParams): PlatformTenantListQuery {
  const q = single(params['q'])?.trim().slice(0, PLATFORM_TENANT_SEARCH_MAX_LENGTH);
  const status = single(params['facturation']);
  const state = single(params['etat']);
  const page = Number(single(params['page']) ?? '1');

  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    ...(q === undefined || q === '' ? {} : { q }),
    ...(status !== undefined && (TENANT_BILLING_STATUSES as readonly string[]).includes(status)
      ? { billingStatus: status as TenantBillingStatus }
      : {}),
    ...(state === 'active' || state === 'suspended' ? { state: state as PlatformTenantState } : {}),
  };
}

/** Les filtres, réécrits en paramètres d'adresse — en français, comme le reste du back-office. */
export function tenantFilterSearch(filters: PlatformTenantListQuery): URLSearchParams {
  const search = new URLSearchParams();

  if (filters.q !== undefined && filters.q !== '') {
    search.set('q', filters.q);
  }
  if (filters.billingStatus !== undefined) {
    search.set('facturation', filters.billingStatus);
  }
  if (filters.state !== undefined) {
    search.set('etat', filters.state);
  }
  if (filters.page !== undefined && filters.page > 1) {
    search.set('page', String(filters.page));
  }

  return search;
}

/** Vrai si au moins un filtre est posé — la liste dit alors « aucun résultat », pas « aucun salon ». */
export function hasTenantFilters(filters: PlatformTenantListQuery): boolean {
  return filters.q !== undefined || filters.billingStatus !== undefined || filters.state !== undefined;
}

// ---------------------------------------------------------------------------
// Export CSV
// ---------------------------------------------------------------------------

/** Une cellule CSV : guillemets doublés, et une formule neutralisée. */
function csvCell(value: string): string {
  // Une cellule qui commence par `=`, `+`, `-` ou `@` est une formule pour un
  // tableur : un nom de salon saisi en libre-service ne doit pas s'exécuter
  // sur le poste de l'éditeur (injection CSV).
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * Les salons en CSV — séparateur point-virgule et BOM UTF-8, pour qu'Excel en
 * français l'ouvre en colonnes et avec ses accents.
 */
export function tenantsCsv(tenants: readonly PlatformTenant[]): string {
  const header = ['Salon', 'Adresse', 'Origine', 'Facturation', 'Fin d’essai', 'État', 'Ouvert le', 'Fuseau', 'Devise'];
  const rows = tenants.map((tenant) => [
    tenant.name,
    tenant.slug,
    { console: 'Console', signup: 'Libre-service', legacy: 'Hors console' }[tenant.origin],
    BILLING_STATUS_LABELS[tenant.billingStatus],
    tenant.trialEndsAt === null ? '' : tenant.trialEndsAt.slice(0, 10),
    tenant.isActive ? 'Actif' : 'Suspendu',
    tenant.createdAt.slice(0, 10),
    tenant.timezone,
    tenant.defaultCurrency,
  ]);

  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}
