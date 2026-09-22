import {
  PLATFORM_TENANT_SEARCH_MAX_LENGTH,
  TENANT_BILLING_STATUSES,
  type Locale,
  type PlatformTenant,
  type PlatformTenantDetail,
  type PlatformTenantEvent,
  type PlatformTenantListQuery,
  type PlatformTenantState,
  type TenantBillingStatus,
} from '@spa/shared';

import en from '@/messages/en/platform.json';
import fr from '@/messages/fr/platform.json';

import { formattingLocale, type DisplayLocale } from './format';

/**
 * La console de l'éditeur, ce qui se décide sans DOM — libellés, mise en route,
 * filtres de la liste, export CSV.
 *
 * ## Les mots viennent du catalogue, lu directement (#1106)
 *
 * Ces fonctions sont **pures** : elles servent un Server Component (le tableau
 * de bord, la fiche), un Client Component (la liste), une route d'export et des
 * tests sans DOM. Aucun crochet de `next-intl` n'y est disponible, d'où l'import
 * des deux fichiers de langue — le même parti que `lib/format.ts` et
 * `lib/admin/calendar-messages.ts`. Ce sont **les mêmes fichiers** que ceux
 * qu'`useTranslations('platform')` sert aux écrans : ce vocabulaire n'est écrit
 * qu'une fois, et le test de parité des catalogues le garde entier dans les deux
 * langues.
 *
 * Pas de formateur ICU pour autant : les messages lus ici n'ont que des
 * paramètres nommés, et les deux comptages portent une clé par forme
 * (`doneOne` / `doneOther`) plutôt qu'une règle de pluriel — la forme du
 * singulier n'est pas celle du pluriel dans les deux langues, et l'export CSV
 * n'a pas à monter un formateur ICU pour écrire neuf en-têtes.
 *
 * ## La langue est un paramètre, pas un défaut de module
 *
 * Chaque fonction la reçoit. Les dates passent par un {@link DisplayLocale} —
 * langue **et** pays — pour la même raison que dans `lib/format.ts` : `en-US`
 * écrit « 9/1/2026 » là où `en-GB` écrit « 01/09/2026 ». La console de l'éditeur
 * n'a pas d'établissement de référence, elle passe donc la seule langue et
 * laisse le repli documenté de `lib/format.ts` choisir la région.
 */

/** Les deux catalogues, dans l'ordre où le front les sert. */
const CATALOG = { fr, en } as const;

/**
 * Le catalogue de la console, dans la langue demandée.
 *
 * La langue est **obligatoire** partout dans ce module, et c'est ce qui
 * distingue son parti de celui de `lib/format.ts` : celui-là garde un défaut
 * français pour ses quarante appelants restés hors de l'épique #843, celui-ci
 * n'a que les écrans de `app/plateforme/`, tous traduits par #1106. Un paramètre
 * facultatif y aurait laissé `tsc` muet sur l'appel qui oublie sa langue —
 * exactement l'oubli que ce ticket doit rendre impossible.
 */
function words(locale: Locale): typeof en {
  return CATALOG[locale];
}

/**
 * Le remplacement des paramètres d'un message lu hors de React.
 *
 * Même fonction que celle de `lib/format.ts`, et pour la même raison : ces
 * messages n'ont que des paramètres nommés, et `String.replaceAll` les pose sans
 * qu'un formateur ait à être monté.
 */
function fill(message: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    message,
  );
}

/** La teinte d'une pastille, dans le vocabulaire des badges du back-office. */
export type BadgeTone = 'completed' | 'pending' | 'confirmed' | 'no-show' | 'cancelled';

/** Le libellé court d'un statut de facturation, tel qu'un filtre le propose. */
export function billingStatusLabel(status: TenantBillingStatus, locale: Locale): string {
  return words(locale).billingStatus[status];
}

const BILLING_STATUS_TONES: Readonly<Record<TenantBillingStatus, BadgeTone>> = {
  managed: 'completed',
  pending: 'pending',
  trialing: 'confirmed',
  active: 'confirmed',
  past_due: 'no-show',
  canceled: 'cancelled',
};

/** « 25 sept. 2026 » / « Sep 25, 2026 » dans le fuseau du salon. */
export function formatPlatformDate(
  instant: string,
  timeZone: string,
  display: DisplayLocale,
): string {
  return new Intl.DateTimeFormat(intlTag(display), { timeZone, dateStyle: 'medium' }).format(
    new Date(instant),
  );
}

/** « 25/09/2026 14:32 » dans le fuseau donné. */
export function formatPlatformDateTime(
  instant: string,
  timeZone: string,
  display: DisplayLocale,
): string {
  return new Intl.DateTimeFormat(intlTag(display), {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(instant));
}

/**
 * « 25 septembre 2026 à 14:32 UTC » — l'horodatage de la vue d'ensemble.
 *
 * Ce n'est pas l'instant d'un rendez-vous mais celui du **calcul** des agrégats,
 * et la console de l'éditeur n'a pas d'établissement dont emprunter le fuseau.
 * Le fuseau est donc **UTC, et nommé** : cette fonction est appelée depuis un
 * Server Component, où un `Intl.DateTimeFormat` sans `timeZone` prend celui du
 * serveur — l'heure d'un conteneur, que personne ne lit et qui changerait d'un
 * environnement à l'autre. C'est l'arbitrage déjà rendu dans `i18n/request.ts`
 * (« un instant UTC, ce qui se voit, plutôt que l'heure du serveur, ce qui ne se
 * voit pas »), et `timeZoneName` est ce qui le rend lisible plutôt que
 * silencieux.
 *
 * Les composants sont énumérés plutôt que demandés par `dateStyle` / `timeStyle` :
 * `Intl` **lève** quand on joint `timeZoneName` à un style (ECMA-402,
 * `InitializeDateTimeFormat`), et l'énumération rend mot pour mot ce que les
 * styles rendaient — « 23 septembre 2026 à 12:32 », « September 23, 2026 at
 * 12:32 PM » — suivi du fuseau.
 */
export function formatPlatformStamp(instant: Date, display: DisplayLocale): string {
  return new Intl.DateTimeFormat(intlTag(display), {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}

/**
 * L'étiquette BCP 47 d'un contexte d'affichage — « fr-FR », « en-US ».
 *
 * Le calcul vit dans `lib/format.ts` (`formattingLocale`), avec ses replis
 * documentés ; l'appeler ici plutôt que de le refaire garantit que la console et
 * le back-office écrivent une date de la même façon pour une même langue.
 */
function intlTag(display: DisplayLocale): string {
  return formattingLocale(display.locale, display.countryCode);
}

/**
 * La pastille de facturation d'un salon. L'essai porte sa date de fin : c'est
 * ce que l'éditeur surveille.
 */
export function billingBadge(
  tenant: PlatformTenant,
  display: DisplayLocale,
): { label: string; tone: BadgeTone } {
  const catalog = words(display.locale);

  if (tenant.billingStatus === 'trialing' && tenant.trialEndsAt !== null) {
    return {
      label: fill(catalog.badge.trialEnds, {
        date: new Intl.DateTimeFormat(intlTag(display), {
          timeZone: tenant.timezone,
          dateStyle: 'short',
        }).format(new Date(tenant.trialEndsAt)),
      }),
      tone: 'confirmed',
    };
  }
  if (tenant.billingStatus === 'past_due') {
    return { label: catalog.badge.pastDue, tone: 'no-show' };
  }
  return {
    label: catalog.billingStatus[tenant.billingStatus],
    tone: BILLING_STATUS_TONES[tenant.billingStatus],
  };
}

/** L'origine d'un salon, en toutes lettres. */
export function originLabel(tenant: PlatformTenant, locale: Locale): string {
  return words(locale).origin[tenant.origin];
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

/**
 * Les étapes qui mènent un salon à sa première réservation, dans l'ordre où
 * on les franchit. C'est la liste qu'un opérateur déroule au téléphone.
 */
export function setupSteps(
  detail: PlatformTenantDetail,
  display: DisplayLocale,
): readonly SetupStep[] {
  const { setup } = detail;
  const catalog = words(display.locale).setup;

  return [
    {
      key: 'admin',
      label: catalog.admin.label,
      done: setup.adminActivated,
      detail: setup.adminActivated ? catalog.admin.done : catalog.admin.todo,
    },
    {
      key: 'adresse',
      label: catalog.address.label,
      done: setup.address,
      detail: setup.address ? catalog.address.done : catalog.address.todo,
    },
    {
      key: 'horaires',
      label: catalog.openingHours.label,
      done: setup.openingHours,
      detail: setup.openingHours ? catalog.openingHours.done : catalog.openingHours.todo,
    },
    {
      key: 'prestations',
      label: catalog.services.label,
      done: setup.activeServices > 0,
      detail:
        setup.activeServices === 0
          ? catalog.services.todo
          : fill(setup.activeServices === 1 ? catalog.services.doneOne : catalog.services.doneOther, {
              count: String(setup.activeServices),
            }),
    },
    {
      key: 'praticiens',
      label: catalog.staff.label,
      done: setup.staffWithSchedule > 0,
      detail:
        setup.activeStaff === 0
          ? catalog.staff.todo
          : // Le nom s'accorde avec le **nombre de praticiens actifs** et non avec
            // ceux qui ont des horaires. Les deux catalogues placent donc le nom
            // après `{active}` — « 1 sur 3 praticien·ne·s actif·ve·s », « 1 of 3
            // active practitioners » : un nom posé après `{withSchedule}` se
            // serait accordé sur le nombre qui ne dicte pas la forme choisie.
            fill(setup.activeStaff === 1 ? catalog.staff.doneOne : catalog.staff.doneOther, {
              withSchedule: String(setup.staffWithSchedule),
              active: String(setup.activeStaff),
            }),
    },
    {
      key: 'legal',
      label: catalog.legal.label,
      done: setup.legalIdentity,
      detail: setup.legalIdentity ? catalog.legal.done : catalog.legal.todo,
    },
    {
      key: 'premier-rdv',
      label: catalog.firstAppointment.label,
      done: setup.firstAppointmentAt !== null,
      detail:
        setup.firstAppointmentAt === null
          ? catalog.firstAppointment.todo
          : fill(catalog.firstAppointment.done, {
              date: formatPlatformDate(setup.firstAppointmentAt, detail.tenant.timezone, display),
            }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

/** Le titre d'une ligne d'historique. */
export function eventTitle(event: PlatformTenantEvent, locale: Locale): string {
  const catalog = words(locale).events;

  switch (event.kind) {
    case 'provisioned':
      return catalog.provisioned;
    case 'note':
      return catalog.note;
    case 'suspended':
      return catalog.suspended;
    case 'reactivated':
      return catalog.reactivated;
    case 'invitation_reissued':
      return catalog.invitationReissued;
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

/**
 * Les filtres, réécrits en paramètres d'adresse.
 *
 * Les **noms** de ces paramètres restent en français, quelle que soit la langue
 * de l'interface : une adresse partagée doit se relire à l'identique par qui
 * n'affiche pas la console dans la même langue, et un paramètre qui changerait
 * de nom avec la langue ferait de deux liens vers la même liste deux liens
 * différents.
 */
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
 * Les salons en CSV — séparateur point-virgule et BOM UTF-8, pour qu'Excel
 * l'ouvre en colonnes et avec ses accents.
 *
 * Les **en-têtes suivent la langue de l'interface au moment de l'export**
 * (#1106) : c'est la langue que la personne lit quand elle clique, et le fichier
 * atterrit sur son poste. Les cellules, elles, restent des données du salon —
 * son nom, son adresse, son fuseau, sa devise — à l'exception des trois valeurs
 * que la console **nomme** : l'origine, le statut de facturation et l'état.
 *
 * Les dates y sont en ISO (`2026-09-20`), inchangées : une colonne de dates se
 * trie et se recalcule, et une date localisée deviendrait du texte dans un
 * tableur configuré autrement.
 */
export function tenantsCsv(tenants: readonly PlatformTenant[], locale: Locale): string {
  const catalog = words(locale).csv;
  const header = [
    catalog.name,
    catalog.address,
    catalog.origin,
    catalog.billing,
    catalog.trialEnd,
    catalog.state,
    catalog.openedOn,
    catalog.timezone,
    catalog.currency,
  ];
  const origins: Readonly<Record<PlatformTenant['origin'], string>> = {
    console: catalog.originConsole,
    signup: catalog.originSignup,
    legacy: catalog.originLegacy,
  };
  const rows = tenants.map((tenant) => [
    tenant.name,
    tenant.slug,
    origins[tenant.origin],
    billingStatusLabel(tenant.billingStatus, locale),
    tenant.trialEndsAt === null ? '' : tenant.trialEndsAt.slice(0, 10),
    tenant.isActive ? catalog.stateActive : catalog.stateSuspended,
    tenant.createdAt.slice(0, 10),
    tenant.timezone,
    tenant.defaultCurrency,
  ]);

  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}
