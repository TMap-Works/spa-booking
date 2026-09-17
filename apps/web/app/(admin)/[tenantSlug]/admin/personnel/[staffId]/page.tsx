import {
  hasAtLeastRole,
  uuidSchema,
  type AvailabilityResponse,
  type SessionUser,
  type StaffMember,
  type StaffSchedule,
  type StaffTimeOff,
} from '@spa/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ApiClientError,
  fetchAdminAvailability,
  fetchOwnProfile,
  fetchServiceStaff,
  fetchServices,
  fetchStaffMembers,
  fetchStaffSchedule,
  fetchStaffTimeOff,
} from '@/lib/api-client';
import { todayInTimeZone } from '@/lib/admin/calendar-range';
import { staffInitials } from '@/lib/admin/staff-directory';
import { timeOffWindow } from '@/lib/admin/staff-time-off';
import { addCalendarDays } from '@/lib/booking/calendar';
import { formatCalendarDate, formatTimeInTimeZone } from '@/lib/format';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { StaffScheduleEditor } from '../components/staff-schedule-editor';
import { StaffServicesPanel, type StaffServiceChoice } from '../components/staff-services-panel';
import { StaffTimeOffPanel } from '../components/staff-time-off-panel';
import { adminStaffMemberPath, adminStaffPath } from '../paths';
import { StaffProfilePanel } from './staff-profile-panel';

/**
 * La fiche d'un praticien — horaires, absences, prestations (#53, critères 2 à 5).
 *
 * ## Et, depuis #705, la fiche elle-même
 *
 * `PATCH /v1/staff/:id` était servi sans écran : le nom d'affichage ne se
 * corrigeait pas et une fiche ne se suspendait que par le jeu d'essai Prisma.
 * `StaffProfilePanel` ouvre les deux, ici et pas dans la liste — c'est sur cette
 * page que vit déjà tout ce qui concerne cette personne, et l'encart « Cette
 * fiche est suspendue » ci-dessous annonçait un état dont rien ne permettait de
 * sortir.
 *
 * ## Ce que cette page prouve, et qu'aucun test ne prouve à sa place
 *
 * Le cinquième critère — « les modifications se reflètent immédiatement dans les
 * créneaux proposés » — est le seul qui ne se vérifie pas en lisant du code. La
 * page rend donc, à côté de la grille, **les créneaux réellement calculés** par
 * le moteur pour ce praticien, lus — depuis #676 — par la route **gardée** de
 * disponibilité, celle du back-office, avec le jeton de la session. Les
 * actions d'écriture périment cette page (`revalidatePath`), si bien qu'un
 * horaire enregistré ou un congé posé déplace visiblement cette liste, sans
 * recharger la fenêtre.
 *
 * Ce n'est pas un doublon du planning : le planning montre les rendez-vous
 * **pris**, celui-ci montre les créneaux **libres**, c'est-à-dire l'effet direct
 * de ce qui vient d'être saisi juste au-dessus.
 *
 * ## La fenêtre d'absences est bornée, et elle doit l'être
 *
 * `GET /v1/staff-time-off` exige `from` et `to`, bornés à un an : sans eux, un
 * salon de dix ans d'historique rendrait dix ans d'absences à chaque ouverture.
 * Six mois couvrent le horizon de réservation d'un spa sans faire de cette fiche
 * une archive.
 *
 * ## Pourquoi une lecture par prestation
 *
 * L'API relie praticien et prestation dans un seul sens —
 * `GET /v1/services/{id}/staff`. Il n'existe pas de « prestations de ce
 * praticien », et le catalogue public, qui porterait l'information, omet les
 * prestations désactivées et les praticiens suspendus : s'en servir ici ferait
 * disparaître une affectation qu'on vient précisément consulter pour la
 * corriger. Les lectures partent donc en parallèle, une par prestation, sur un
 * catalogue de back-office dont la taille est bornée par ce que le salon vend.
 *
 * ## Les trois façons de ne pas trouver la fiche n'en font qu'une
 *
 * Identifiant mal formé, identifiant inconnu, fiche d'un autre établissement :
 * les trois se répondent `notFound()`, indistinctement (tenant-isolation §4), et
 * `not-found.tsx` — la frontière posée au même segment par #696 — en rend
 * l'encart dans l'enveloppe du back-office, avec son lien de retour vers
 * Personnel.
 */

export const dynamic = 'force-dynamic';

/** Six mois d'absences — l'horizon d'un planning de salon, pas une archive. */
const TIME_OFF_WINDOW_DAYS = 180;

/** Une semaine de créneaux : de quoi voir l'effet d'une saisie, sans plus. */
const AVAILABILITY_PREVIEW_DAYS = 7;

interface StaffMemberPageProps {
  readonly params: Promise<{ readonly tenantSlug: string; readonly staffId: string }>;
  /**
   * Cette fiche n'a qu'un paramètre d'URL, et elle ne l'écrit pas elle-même : le
   * marqueur de renouvellement, posé par la route de renouvellement au retour
   * d'un 401 (#861).
   *
   * Facultatif parce que Next le passe toujours et que les doubles de test, eux,
   * ne le passent pas : l'exiger ferait échouer sur un `undefined` des rendus que
   * l'application ne produit jamais.
   */
  readonly searchParams?: Promise<{ readonly session?: string | readonly string[] }>;
}

export default async function StaffMemberPage({ params, searchParams }: StaffMemberPageProps) {
  const { tenantSlug, staffId } = await params;
  const query = (await searchParams) ?? {};
  const here = adminStaffMemberPath(tenantSlug, staffId);

  // Où revenir après un renouvellement, et si l'on en revient déjà — voir
  // `adminUnauthorizedPath`.
  const renewal = { returnTo: here, attempted: isRenewalReturn(query[RENEWAL_PARAM]) };
  const accessToken = await requireAdminAccessToken(tenantSlug, here);

  /*
   * Un identifiant mal formé ne désigne aucune fiche : il se refuse ici, avant
   * le moindre aller-retour (#696).
   *
   * Sans ce contrôle, `pas-un-uuid` partait jusqu'à `GET /v1/staff/:id/schedule`
   * dont le `ParseUUIDPipe` rend **400**. Ce statut n'est ni un 404 ni un refus
   * de rôle : il tombait donc dans la branche par défaut d'`adminLoadFailure`,
   * qui affiche `error.message` tel quel — « Validation failed (uuid is
   * expected) », en anglais, sous « Fiche indisponible », sans la moindre issue.
   *
   * Le refus vient **après** la garde, et non avant : l'écran d'introuvable est
   * celui du back-office, et une visiteuse sans session doit voir la connexion,
   * pas un 404 qui lui apprendrait la forme des identifiants du salon.
   *
   * `uuidSchema` est la v4 stricte du contrat partagé — la même que celle dont
   * l'API tire tous ses identifiants (`@default(uuid())`) : refuser ici ce
   * qu'elle refuse là-bas ne coûte qu'un refus plus tôt, du bon côté de l'écran.
   */
  if (!uuidSchema.safeParse(staffId).success) {
    notFound();
  }

  let profile: SessionUser | undefined;
  let member: StaffMember | undefined;
  let schedule: StaffSchedule | undefined;
  let timeOff: readonly StaffTimeOff[] = [];
  let services: readonly StaffServiceChoice[] = [];
  let availability: AvailabilityResponse | null = null;
  let loadError: unknown = null;

  try {
    // Le rôle, la fiche et sa semaine partent ensemble : elles ne dépendent pas
    // les unes des autres, et les enchaîner ajouterait deux allers-retours à
    // l'ouverture.
    const [loadedProfile, members, loadedSchedule] = await Promise.all([
      fetchOwnProfile(accessToken),
      fetchStaffMembers(accessToken),
      fetchStaffSchedule(accessToken, staffId),
    ]);

    profile = loadedProfile;
    member = members.find((candidate) => candidate.id === staffId);
    schedule = loadedSchedule;

    if (member !== undefined) {
      const timezone = loadedSchedule.timezone;
      const today = todayInTimeZone(timezone);
      const catalog = await fetchServices(accessToken);

      const [absences, assignments] = await Promise.all([
        fetchStaffTimeOff(accessToken, {
          staffId,
          ...timeOffWindow(today, TIME_OFF_WINDOW_DAYS, timezone),
        }),
        Promise.all(catalog.map((service) => fetchServiceStaff(accessToken, service.id))),
      ]);

      timeOff = absences;
      services = catalog.map((service, index) => ({
        id: service.id,
        name: service.name,
        isActive: service.isActive,
        assigned: (assignments[index] ?? []).some((assigned) => assigned.id === staffId),
      }));

      const preview = services.find((service) => service.assigned && service.isActive);

      if (preview !== undefined) {
        /*
         * Cette lecture-ci a son propre `try` : c'est un aperçu, et il ne doit
         * pas emporter la fiche qu'il illustre.
         *
         * Elle passe par `GET /api/v1/availability` — la route gardée, seuil
         * `STAFF`, **sans quota** — et non plus par
         * `GET /public/{slug}/availability` (#676). La publique est comptée à
         * cent vingt interrogations par minute **et par adresse** ; une page
         * serveur Next sort par l'adresse du serveur Next, si bien que ce
         * back-office consommait le budget du tunnel de réservation, partagé par
         * tous les établissements du déploiement.
         *
         * Changer de porte change les statuts, et c'est ce que ce `catch` relit :
         *
         * - **404** — la prestation a été retirée du catalogue entre les deux
         *   appels. C'est la raison d'être de ce `try` : laissé au `try`
         *   d'ensemble, ce 404-là passerait pour « ce praticien n'existe pas »
         *   et la fiche entière disparaîtrait derrière un `notFound()`. Il ne
         *   recouvre plus « établissement inconnu » comme sur la publique :
         *   l'établissement vient du jeton, plus du slug d'URL
         *   (tenant-isolation §2) ;
         * - **422 `AVAILABILITY_RANGE_TOO_WIDE`** — plage inversée ou de plus de
         *   trente et un jours. Les sept jours d'ici ne l'atteignent pas, mais
         *   l'aperçu se tait plutôt que de parier sur une constante ;
         * - **403** — rang sous le seuil `STAFF`. Inatteignable tant que ce seuil
         *   égale celui de `GET /v1/staff/:id/schedule`, lu plus haut avec le
         *   même jeton. S'il montait, un compte qui a droit à la grille doit
         *   garder sa fiche et perdre le seul aperçu — la dégradation est donc
         *   ici, et non sur la page ;
         * - **401** — l'API a refusé le jeton en cours de rendu. Celui-là n'est
         *   pas un défaut d'aperçu : il périme la page entière, panneaux
         *   compris. Il est donc relancé, et `adminLoadFailure` décide — un
         *   renouvellement d'abord, la connexion ensuite (#861).
         *
         * La publique rendait en plus **429**, et la gardée jamais : c'est tout
         * l'objet du ticket.
         */
        try {
          availability = await fetchAdminAvailability(accessToken, {
            serviceId: preview.id,
            staffId,
            from: today,
            to: addCalendarDays(today, AVAILABILITY_PREVIEW_DAYS - 1),
          });
        } catch (error) {
          if (error instanceof ApiClientError && error.status === 401) {
            throw error;
          }

          availability = null;
        }
      }
    }
  } catch (error) {
    loadError = error;
  }

  // `notFound()` et `redirect()` lèvent : ils sont appelés **hors** du `try`,
  // sans quoi le `catch` avalerait la navigation qu'ils déclenchent et la page
  // rendrait une erreur à la place d'un 404.
  //
  // Ce que ce `notFound()` rend est désormais `not-found.tsx`, la frontière
  // posée au même segment (#696) : l'encart « Praticien introuvable » du
  // back-office, et non plus la page d'adresse inconnue des clientes.
  if (loadError instanceof ApiClientError && loadError.status === 404) {
    notFound();
  }

  if (loadError !== null) {
    return adminLoadFailure(loadError, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'Les horaires du personnel sont réservés aux comptes du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Fiche indisponible',
      renewal,
    });
  }

  // Une fiche absente de la liste de l'établissement est une fiche d'un autre
  // établissement, ou une fiche supprimée : les deux se répondent **404**,
  // indistinctement (tenant-isolation §4).
  if (member === undefined || schedule === undefined || profile === undefined) {
    notFound();
  }

  const timezone = schedule.timezone;
  const today = todayInTimeZone(timezone);
  // La fenêtre interrogée est `[aujourd'hui, aujourd'hui + 180[`, borne haute
  // exclue : le dernier jour qu'elle couvre est le 179e, et annoncer le 180e
  // ferait chercher une absence que la liste ne contient pas.
  const lastDay = addCalendarDays(today, TIME_OFF_WINDOW_DAYS - 1);
  const previewService = services.find((service) => service.assigned && service.isActive);
  /*
   * Le rang qui **écrit** sur cette fiche, et il n'est pas celui qui l'ouvre.
   *
   * `PUT /v1/staff/:id/schedule`, `POST` et `DELETE /v1/staff-time-off` et
   * l'affectation d'une prestation sont toutes `@AuthAtLeast('MANAGER')`, quand
   * la lecture s'ouvre dès le rang praticien. Sans cette borne, un compte
   * `staff` obtenait la grille et ses boutons — et un 403 à chaque
   * enregistrement. Comme sur la liste du personnel, ce filtrage ne protège
   * rien : la seule garde qui compte est celle de l'API.
   */
  const canManage = hasAtLeastRole(profile.role, 'manager');

  return (
    <section aria-labelledby="praticien-titre">
      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminStaffPath(tenantSlug)}>
          ← Personnel
        </Link>
      </div>

      {/* `spa-admin-staff__heading` fait de ce titre une rangée flex : la
          pastille est elle-même une boîte flex, et dans un `<h1>` en flux normal
          elle se poserait au-dessus du nom au lieu de le précéder (#632). Le
          `gap` de la règle remplace l'espace typographique qui séparait les deux
          — il ne dépend pas de la fonte et vaut celui de la liste. */}
      <h1 className="spa-admin__title spa-admin-staff__heading" id="praticien-titre">
        <span aria-hidden="true" className="spa-admin-staff__initials">
          {staffInitials(member.displayName)}
        </span>
        {member.displayName}
      </h1>

      {member.isActive ? null : (
        <p className="spa-admin-toolbar__hint">
          Cette fiche est suspendue&nbsp;: aucun créneau n’est proposé pour ce praticien, quels que
          soient les horaires ci-dessous.
        </p>
      )}

      {/* La fiche elle-même avant son agenda : on corrige qui est cette
          personne, puis quand elle travaille. C'est aussi le panneau qui répond
          à l'encart de suspension juste au-dessus — il l'annonçait sans offrir
          de quoi en sortir (#705). */}
      <StaffProfilePanel canManage={canManage} member={member} tenantSlug={tenantSlug} />

      {/* Pas de `spa-admin__split` ici : sa première colonne est bornée à 22 rem
          — elle est faite pour une liste, pas pour une grille de sept jours à
          deux champs horaires. La semaine y repliait chaque plage sur trois
          lignes. Les sections s'empilent donc sur toute la largeur, dans l'ordre
          où on les remplit : les horaires, puis ce qu'ils produisent. */}
      <StaffScheduleEditor
        canManage={canManage}
        schedule={schedule}
        staffId={member.id}
        tenantSlug={tenantSlug}
      />

      <section className="spa-admin__section" aria-labelledby="creneaux-titre">
        <h2 className="spa-admin__section-title" id="creneaux-titre">
          Créneaux proposés
        </h2>
        <p className="spa-admin-toolbar__hint">
          {previewService === undefined
            ? 'Affectez une prestation active pour voir ce que le moteur propose.'
            : `Prochains créneaux libres pour « ${previewService.name} », tels que la page de réservation les calcule.`}
        </p>

        {availability === null || availability.days.every((day) => day.slots.length === 0) ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun créneau sur les sept prochains jours</p>
            <p className="spa-empty-state__description">
              Une semaine de travail vide, une fiche suspendue, une prestation non affectée ou un
              congé couvrant la période produisent tous ce résultat.
            </p>
          </div>
        ) : (
          <ul className="spa-admin-schedule__exceptions">
            {availability.days
              .filter((day) => day.slots.length > 0)
              .map((day) => (
                <li className="spa-admin-schedule__exception" key={day.date}>
                  <span className="spa-admin-schedule__exception-date">
                    {formatCalendarDate(day.date)}
                  </span>
                  <span className="spa-admin-schedule__exception-label">
                    {day.slots
                      .slice(0, 6)
                      .map((slot) => formatTimeInTimeZone(slot.startsAt, availability.timezone))
                      .join(' · ')}
                    {day.slots.length > 6 ? ` … ${String(day.slots.length)} au total` : ''}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <StaffTimeOffPanel
        canManage={canManage}
        staffId={member.id}
        tenantSlug={tenantSlug}
        timeOff={timeOff}
        timeZone={timezone}
        windowLabel={`Absences du ${formatCalendarDate(today)} au ${formatCalendarDate(lastDay)}.`}
      />

      <StaffServicesPanel
        canManage={canManage}
        services={services}
        staffId={member.id}
        tenantSlug={tenantSlug}
      />
    </section>
  );
}
