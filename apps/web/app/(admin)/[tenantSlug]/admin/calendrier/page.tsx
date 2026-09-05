import type { Appointment, Tenant } from '@spa/shared';

import { ApiClientError, fetchAppointments, fetchTenantSettings } from '@/lib/api-client';
import { calendarFailureMessage } from '@/lib/admin/calendar-failure';
import {
  anchorOf,
  parseCalendarDate,
  parseCalendarView,
  rangeKey,
  rangeOf,
  shiftAnchor,
  todayInTimeZone,
  type CalendarView,
} from '@/lib/admin/calendar-range';

import { CalendarBoard } from '../components/calendar-board';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';

/**
 * Le planning du salon — l'écran le plus regardé du back-office (#49, CDC §1.4).
 *
 * ## Ce que la page fait, et ce qu'elle laisse au planning
 *
 * Elle garde la session, lit le fuseau de l'établissement, et **amorce le
 * cache** : la période demandée par l'URL, plus les deux périodes voisines. Le
 * reste — navigation, bascule jour/semaine, virtualisation, préchargement des
 * périodes suivantes — vit dans `CalendarBoard`, un Client Component, parce que
 * ce sont des états qui n'ont pas de raison de repasser par le serveur
 * (web-frontend §1).
 *
 * Charger les voisines **ici** plutôt qu'au montage du composant fait tenir le
 * deuxième critère du ticket dès le premier écran : la flèche « jour suivant »
 * répond instantanément au tout premier clic, pas seulement au second.
 *
 * `force-dynamic` parce que la page lit un cookie de session : la mettre en
 * cache servirait le planning du premier arrivé à tout le monde.
 *
 * ## L'agenda que l'API ne sert pas encore
 *
 * `packages/shared` publie le contrat de l'agenda du comptoir —
 * `appointmentListQuerySchema` et `appointmentSchema` — mais `apps/api` n'expose
 * que `GET /appointments/mine` et `POST /appointments/:id/cancel`. La grille, la
 * navigation et la virtualisation sont donc complètes et exercées, et le
 * chargement des rendez-vous **dégrade** : l'écran s'affiche, dit ce qui manque,
 * et se remplira le jour où la route existera, sans une ligne à changer ici.
 */

export const dynamic = 'force-dynamic';

interface CalendarPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{ readonly vue?: string; readonly date?: string }>;
}

export default async function CalendarPage({ params, searchParams }: CalendarPageProps) {
  const { tenantSlug } = await params;
  const { vue, date } = await searchParams;
  const accessToken = await requireAdminAccessToken(tenantSlug);

  let tenant: Tenant;
  try {
    tenant = await fetchTenantSettings(accessToken);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'Le planning est réservé aux comptes du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Planning indisponible',
    });
  }

  const view: CalendarView = parseCalendarView(vue);
  // La journée par défaut est celle du **salon**, pas celle du navigateur : une
  // gérante qui consulte depuis un autre fuseau doit ouvrir sur le jour que son
  // équipe travaille.
  const anchor = anchorOf(view, parseCalendarDate(date) ?? todayInTimeZone(tenant.timezone));

  const loaded = await Promise.all(
    [anchor, shiftAnchor(view, anchor, -1), shiftAnchor(view, anchor, 1)].map(async (target) => {
      try {
        return {
          key: rangeKey(view, target),
          appointments: await fetchAppointments(accessToken, rangeOf(view, target)),
        };
      } catch (error) {
        return { key: rangeKey(view, target), error };
      }
    }),
  );

  const periods: Record<string, readonly Appointment[]> = {};
  let loadError: string | null = null;

  for (const result of loaded) {
    if ('appointments' in result) {
      periods[result.key] = result.appointments;
      continue;
    }

    // L'échec d'un **préchargement** ne se montre pas : personne ne l'a demandé,
    // et la période affichée est intacte. Seul celui de la période ouverte parle.
    if (result.key === rangeKey(view, anchor)) {
      loadError = describeLoadFailure(result.error);
    }
  }

  return (
    <section aria-labelledby="planning-titre">
      <h1 className="spa-admin__title" id="planning-titre">
        Planning
      </h1>

      <CalendarBoard
        date={anchor}
        initialPeriods={periods}
        loadError={loadError}
        tenantSlug={tenantSlug}
        timeZone={tenant.timezone}
        view={view}
      />
    </section>
  );
}

/**
 * Ce qu'on affiche quand le chargement des rendez-vous échoue.
 *
 * La traduction elle-même vit dans `lib/admin/calendar-failure.ts`, parce que
 * les navigations suivantes échouent par l'action serveur et doivent dire
 * exactement la même chose.
 *
 * Ce qui n'est pas une erreur d'API est **relancé** : une panne de rendu n'est
 * pas un refus métier, et l'avaler la ferait passer pour un agenda vide.
 */
function describeLoadFailure(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    throw error;
  }

  return calendarFailureMessage(error.code, error.message);
}
