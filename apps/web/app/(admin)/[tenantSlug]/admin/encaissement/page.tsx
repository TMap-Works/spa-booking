import type { Appointment, CalendarDate, PublicTenant, TimeZone } from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import { fetchAppointments, fetchPublicTenant } from '@/lib/api-client';
import { STATUS_LABELS, statusModifier } from '@/lib/admin/calendar-grid';
import { parseCalendarDate, rangeOf, shiftAnchor, todayInTimeZone } from '@/lib/admin/calendar-range';
import { amountDue, isSettleable } from '@/lib/admin/checkout-summary';
import {
  formatCalendarDate,
  formatDuration,
  formatMoney,
  formatTimeInTimeZone,
} from '@/lib/format';

import { CheckoutPanel } from '../components/checkout-panel';
import { adminCheckoutPath } from '../paths';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';

/**
 * L'encaissement au comptoir — CDC §1.4, « encaissement en fin de prestation »
 * (#59).
 *
 * ## Un seul écran, et le rendez-vous dans l'URL
 *
 * `?date=` choisit la journée, `?rdv=` le rendez-vous à régler. Les deux sont
 * dans l'URL plutôt que dans un état local pour la raison qui les y met dans le
 * planning : l'écran reste ouvert toute la journée, et un rafraîchissement ne
 * doit pas ramener l'opérateur à la liste alors qu'il a une cliente devant lui.
 *
 * C'est aussi ce qui permet à cette page de se passer d'un `GET /appointments/{id}`
 * que l'API ne sert pas : le rendez-vous à encaisser est **choisi dans la
 * journée déjà chargée**, en une requête au lieu de deux. Un rendez-vous d'un
 * autre jour se rejoint en changeant de date, ce qui est le geste naturel d'un
 * comptoir — on encaisse ce qu'on vient de rendre.
 *
 * ## Ce qui est rendu côté serveur, et ce qui ne l'est pas
 *
 * Le **récapitulatif** — cliente, praticien, prestation, horaire, montant dû —
 * est un Server Component : il n'a aucun état, et le sortir du serveur
 * coûterait un aller-retour pour afficher ce que la page connaît déjà
 * (web-frontend §1). Le choix du moyen de paiement, le montage de Stripe
 * Elements et le reçu vivent dans `CheckoutPanel`, aussi bas que possible dans
 * l'arbre.
 *
 * `force-dynamic` parce que la page lit un cookie de session : la mettre en
 * cache servirait la journée du premier arrivé à tout le monde.
 *
 * ## Aucun montant n'est calculé ici
 *
 * Le montant dû est le **prix figé à la réservation**, relu du rendez-vous. Le
 * front ne fait jamais l'arithmétique d'un total : celui qui fait foi est
 * recalculé par le serveur (payments-stripe §4 et §5).
 */

export const dynamic = 'force-dynamic';

interface CheckoutPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{ readonly date?: string; readonly rdv?: string }>;
}

export default async function CheckoutPage({ params, searchParams }: CheckoutPageProps) {
  const { tenantSlug } = await params;
  const { date, rdv } = await searchParams;

  // La journée et le rendez-vous en cours de règlement sont lus **avant** la
  // garde : ils ne demandent aucun jeton, et c'est ce qui permet de dire à la
  // garde où revenir après un renouvellement de session. Sans eux, l'opérateur
  // repartait de la liste du jour avec une cliente devant lui (#458).
  const requested = parseCalendarDate(date);
  const accessToken = await requireAdminAccessToken(
    tenantSlug,
    adminCheckoutPath(tenantSlug, {
      ...(requested === null ? {} : { date: requested }),
      ...(rdv === undefined ? {} : { appointmentId: rdv }),
    }),
  );

  const denial = {
    deniedTitle: 'Accès réservé',
    deniedHint:
      'L’encaissement est réservé aux comptes du salon. Demandez l’accès à l’administrateur.',
    failedTitle: 'Encaissement indisponible',
  };

  // Le fuseau vient de la **vitrine publique** et non de `GET /tenant`, qui est
  // au seuil `ADMIN` : l'encaissement est un geste de comptoir, ouvert à `STAFF`
  // comme l'est la route d'agenda et celle du règlement en espèces. Demander les
  // réglages de l'établissement pour n'y lire que le fuseau aurait fermé cet
  // écran à ceux qui l'utilisent — et le fuseau du salon est de toute façon
  // public, il est affiché sur la page de réservation.
  let tenant: PublicTenant;
  try {
    tenant = await fetchPublicTenant(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, denial);
  }

  // La journée par défaut est celle du **salon**, pas celle du navigateur : on
  // encaisse la journée que l'équipe travaille.
  const anchor = requested ?? todayInTimeZone(tenant.timezone);

  let appointments: Appointment[];
  try {
    appointments = await fetchAppointments(accessToken, rangeOf('jour', anchor));
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, denial);
  }

  const selected = rdv === undefined ? undefined : appointments.find((one) => one.id === rdv);

  return (
    <section aria-labelledby="encaissement-titre">
      <h1 className="spa-admin__title" id="encaissement-titre">
        Encaissement
      </h1>

      <nav aria-label="Journée encaissée" className="spa-admin-toolbar">
        <div className="spa-admin-toolbar__group">
          <Link
            className="spa-button spa-button--quiet"
            href={adminCheckoutPath(tenantSlug, { date: shiftAnchor('jour', anchor, -1) })}
          >
            <span className="spa-button__label">Jour précédent</span>
          </Link>
          <Link
            className="spa-button spa-button--quiet"
            href={adminCheckoutPath(tenantSlug, { date: shiftAnchor('jour', anchor, 1) })}
          >
            <span className="spa-button__label">Jour suivant</span>
          </Link>
        </div>
        <p className="spa-admin-toolbar__caption">{formatCalendarDate(anchor)}</p>
        <span className="spa-admin-toolbar__spacer" />
        <p className="spa-admin-toolbar__hint">Heures affichées dans le fuseau du salon.</p>
      </nav>

      {rdv !== undefined && selected === undefined ? (
        <Notification tone="warning" title="Rendez-vous introuvable dans cette journée">
          <p>
            Le rendez-vous demandé n’est pas au planning du {formatCalendarDate(anchor)}. Changez
            de jour, ou choisissez-en un dans la liste ci-dessous.
          </p>
        </Notification>
      ) : null}

      {selected === undefined ? (
        <AppointmentsToSettle
          anchor={anchor}
          appointments={appointments}
          tenantSlug={tenantSlug}
          timeZone={tenant.timezone}
        />
      ) : (
        <div className="spa-admin-checkout">
          <AppointmentRecap appointment={selected} timeZone={tenant.timezone} />
          <CheckoutPanel
            appointment={selected}
            tenantSlug={tenantSlug}
            timeZone={tenant.timezone}
          />
        </div>
      )}

      {selected === undefined ? null : (
        <p className="spa-admin-toolbar__hint">
          <Link href={adminCheckoutPath(tenantSlug, { date: anchor })}>
            Revenir à la liste de la journée
          </Link>
        </p>
      )}
    </section>
  );
}

/**
 * Le récapitulatif du rendez-vous et du montant dû — premier critère de #59.
 *
 * Le montant est rendu **une fois**, en gros, sous la ligne des totaux : c'est
 * le seul chiffre que l'opérateur annonce à voix haute, et le chercher dans un
 * tableau devant une cliente est exactement ce qui fait dire un mauvais prix.
 */
function AppointmentRecap({
  appointment,
  timeZone,
}: {
  readonly appointment: Appointment;
  readonly timeZone: TimeZone;
}) {
  const due = amountDue(appointment);

  return (
    <div className="spa-admin-checkout__ticket">
      <div className="spa-admin-checkout__origin">
        <span>Rattaché au rendez-vous de</span>
        <strong>
          {appointment.client.firstName} {appointment.client.lastName} —{' '}
          {formatTimeInTimeZone(appointment.startsAt, timeZone)}
        </strong>
        <span
          className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}
        >
          {STATUS_LABELS[appointment.status]}
        </span>
      </div>

      <table className="spa-admin-table">
        <caption className="spa-visually-hidden">Prestation à encaisser</caption>
        <thead>
          <tr>
            <th className="spa-admin-table__head" scope="col">
              Prestation
            </th>
            <th className="spa-admin-table__head" scope="col">
              Praticien
            </th>
            <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="spa-admin-table__row">
            <td className="spa-admin-table__cell">
              {appointment.service.name} — {formatDuration(appointment.service.durationMinutes)}
            </td>
            <td className="spa-admin-table__cell">{appointment.staff.displayName}</td>
            <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
              {formatMoney(due)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="spa-admin-checkout__totals">
        <div className="spa-admin-checkout__total-row">
          <span className="spa-admin-checkout__total-label">Horaire</span>
          <span className="spa-admin-checkout__total-value">
            {formatTimeInTimeZone(appointment.startsAt, timeZone)} –{' '}
            {formatTimeInTimeZone(appointment.endsAt, timeZone)}
          </span>
        </div>
        <div className="spa-admin-checkout__total-row spa-admin-checkout__total-row--grand">
          <span className="spa-admin-checkout__total-label">À encaisser</span>
          <span className="spa-admin-checkout__total-value">{formatMoney(due)}</span>
        </div>
      </div>

      <p className="spa-admin-toolbar__hint">
        Montant figé à la réservation. Le total qui fait foi est celui que le serveur recalcule à
        la validation — le front n’en fait jamais l’arithmétique.
      </p>
    </div>
  );
}

/** La journée, du premier rendez-vous au dernier, avec un lien par ligne. */
function AppointmentsToSettle({
  anchor,
  appointments,
  tenantSlug,
  timeZone,
}: {
  readonly anchor: CalendarDate;
  readonly appointments: readonly Appointment[];
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
}) {
  // Les annulés restent affichés — ils expliquent le trou dans la journée — mais
  // leur ligne n'ouvre rien : il n'y a plus de prestation à encaisser.
  if (appointments.length === 0) {
    return (
      <div className="spa-empty-state">
        <p className="spa-empty-state__title">Aucun rendez-vous ce jour-là</p>
        <p className="spa-empty-state__description">
          Rien à encaisser au {formatCalendarDate(anchor)}. Changez de jour pour retrouver une
          prestation rendue.
        </p>
      </div>
    );
  }

  return (
    <table className="spa-admin-table">
      <caption className="spa-visually-hidden">Rendez-vous de la journée</caption>
      <thead>
        <tr>
          <th className="spa-admin-table__head" scope="col">
            Heure
          </th>
          <th className="spa-admin-table__head" scope="col">
            Cliente
          </th>
          <th className="spa-admin-table__head" scope="col">
            Prestation
          </th>
          <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
            Montant
          </th>
          <th className="spa-admin-table__head" scope="col">
            Statut
          </th>
        </tr>
      </thead>
      <tbody>
        {appointments.map((appointment) => (
          <tr className="spa-admin-table__row" key={appointment.id}>
            <td className="spa-admin-table__cell">
              {formatTimeInTimeZone(appointment.startsAt, timeZone)}
            </td>
            <td className="spa-admin-table__cell">
              {isSettleable(appointment.status) ? (
                <Link
                  href={adminCheckoutPath(tenantSlug, {
                    date: anchor,
                    appointmentId: appointment.id,
                  })}
                >
                  {appointment.client.firstName} {appointment.client.lastName}
                  <span className="spa-visually-hidden"> — encaisser ce rendez-vous</span>
                </Link>
              ) : (
                <>
                  {appointment.client.firstName} {appointment.client.lastName}
                </>
              )}
            </td>
            <td className="spa-admin-table__cell">{appointment.service.name}</td>
            <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
              {formatMoney(amountDue(appointment))}
            </td>
            <td className="spa-admin-table__cell">
              <span
                className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}
              >
                {STATUS_LABELS[appointment.status]}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
