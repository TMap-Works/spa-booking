import type { Appointment, PublicTenant, Service } from '@spa/shared';
import { redirect } from 'next/navigation';

import {
  ApiClientError,
  fetchAppointments,
  fetchPublicTenant,
  fetchServices,
} from '@/lib/api-client';
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
import { adminCalendarPath, adminLoginPath } from '../paths';

/**
 * Le planning du salon — l'écran le plus regardé du back-office (#49, CDC §1.4).
 *
 * ## Ce que la page fait, et ce qu'elle laisse au planning
 *
 * ## Le fuseau vient de la vitrine publique, et c'est ce qui ouvre l'écran
 *
 * `GET /public/{slug}` sert le nom et le fuseau du salon **sans jeton** ; c'est
 * ce que fait déjà le shell de ce back-office, et c'est ce que fait
 * l'encaissement. La page lisait auparavant `GET /v1/tenant`, qui est au seuil
 * `ADMIN` : tout rang inférieur recevait « Accès réservé » sur l'écran que le CDC
 * destine au front-desk, alors que l'agenda lui-même — `GET /v1/appointments` —
 * s'ouvre dès le rang `staff`, et que le rail annonce « Planning » à ce rang-là
 * (#458). Demander les réglages de l'établissement pour n'y lire que le fuseau
 * fermait donc l'écran à ceux qui l'utilisent, et le fuseau est de toute façon
 * public : il est affiché sur la page de réservation.
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
 * ## Le catalogue voyage avec le planning (#50)
 *
 * Les prestations sont lues **ici**, une fois, et non à chaque ouverture du
 * tiroir de rendez-vous : elles ne changent pas entre deux clics, et les
 * charger au clic ferait attendre l'opérateur au moment précis où ce chemin doit
 * être plus rapide que le tunnel client. Leur échec ne casse pas le planning —
 * consulter l'agenda et poser un rendez-vous sont deux gestes, et le premier
 * n'a pas à tomber parce que le second est indisponible.
 *
 * ## Les écritures que l'API ne sert pas encore
 *
 * `GET /appointments` existe depuis #444, et cette page la consomme. Les
 * **écritures** du comptoir, elles, sont décrites par le contrat partagé —
 * `createAppointmentRequestSchema.clientId` est annoté « réservé au back-office »,
 * `changeAppointmentStatusRequestSchema` dit « changement de statut par le
 * back-office » — mais `apps/api` n'expose ni `POST /appointments`, ni
 * `/:id/reschedule`, ni `/:id/status`. Le tiroir est donc complet et **dégrade**,
 * exactement comme la grille l'a fait avant #444 : il s'affiche, il valide, il
 * dit ce qui manque, et il enregistrera le jour où les routes existeront sans
 * une ligne à changer ici. Voir `lib/admin/appointment-desk.ts`.
 */

export const dynamic = 'force-dynamic';

interface CalendarPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{ readonly vue?: string; readonly date?: string }>;
}

export default async function CalendarPage({ params, searchParams }: CalendarPageProps) {
  const { tenantSlug } = await params;
  const { vue, date } = await searchParams;

  // La vue et la date sont lues **avant** la garde : elles ne demandent aucun
  // jeton, et c'est ce qui permet de dire à la garde où revenir après un
  // renouvellement de session. Sans elles, l'opérateur repartait de la journée
  // courante en vue jour, quelle que soit la période qu'il regardait (#458).
  const view: CalendarView = parseCalendarView(vue);
  const requested = parseCalendarDate(date);
  const accessToken = await requireAdminAccessToken(
    tenantSlug,
    adminCalendarPath(tenantSlug, { view, ...(requested === null ? {} : { date: requested }) }),
  );

  let tenant: PublicTenant;
  try {
    tenant = await fetchPublicTenant(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint: 'La vitrine publique de ce salon n’a pas pu être lue avec ce compte.',
      failedTitle: 'Planning indisponible',
    });
  }

  // La journée par défaut est celle du **salon**, pas celle du navigateur : une
  // gérante qui consulte depuis un autre fuseau doit ouvrir sur le jour que son
  // équipe travaille.
  const anchor = anchorOf(view, requested ?? todayInTimeZone(tenant.timezone));

  // Les prestations actives seules : le tiroir sert à **poser** un rendez-vous,
  // et une prestation retirée du catalogue n'est plus vendable. Un échec ne
  // remonte pas — le planning se consulte très bien sans catalogue, et le tiroir
  // dira lui-même qu'il n'a rien à proposer.
  //
  // Menée **de front** avec les trois périodes : le catalogue et l'agenda ne se
  // conditionnent pas, et les enchaîner ferait payer la somme des deux
  // allers-retours à l'écran dont le ticket demande justement qu'il soit plus
  // rapide que le tunnel public.
  const [services, loaded] = await Promise.all([
    fetchServices(accessToken, { activeOnly: true }).catch((): readonly Service[] => []),
    Promise.all(
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
    ),
  ]);

  const periods: Record<string, readonly Appointment[]> = {};
  let loadError: string | null = null;

  for (const result of loaded) {
    if ('appointments' in result) {
      periods[result.key] = result.appointments;
      continue;
    }

    // Un 401 ne se raconte pas dans une bannière : le cookie d'accès est là,
    // mais l'API refuse le jeton — session révoquée en base, ou secret changé.
    // Le renouvellement échouerait pour la même raison, et laisser l'écran se
    // peindre autour du refus donnerait un planning vide sans dire pourquoi.
    // C'est `fetchTenantSettings` qui rendait ce verdict jusqu'à ce que le
    // fuseau vienne de la vitrine publique : l'appel qui reste est le premier à
    // porter le jeton, et c'est à lui de le rendre (voir `adminLoadFailure`).
    if (result.error instanceof ApiClientError && result.error.status === 401) {
      redirect(adminLoginPath(tenantSlug));
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
        services={services}
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
