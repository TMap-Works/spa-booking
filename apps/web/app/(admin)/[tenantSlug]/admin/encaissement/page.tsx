import type { Appointment, CalendarDate, PublicTenant, TimeZone } from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import { fetchAppointments, fetchPublicTenant } from '@/lib/api-client';
import { statusModifier } from '@/lib/admin/calendar-grid';
import { appointmentOutcomeLabel } from '@/lib/appointment-status';
import {
  parseCalendarDate,
  rangeLabel,
  rangeOf,
  shiftAnchor,
  todayInTimeZone,
} from '@/lib/admin/calendar-range';
import {
  amountDue,
  isSettleable,
  isSettled,
  settlementBadge,
  settlementOf,
  type SettlementState,
} from '@/lib/admin/checkout-summary';
import {
  formatCalendarDate,
  formatDuration,
  formatMoney,
  formatTimeInTimeZone,
} from '@/lib/format';
import type { PaymentTransaction } from '@/lib/admin/payment-contract';

import { CheckoutPanel } from '../components/checkout-panel';
import { PeriodNav } from '../components/period-nav';
import { adminCheckoutPath } from '../paths';
import { adminLoadFailure, redirectWithoutPermission, requireAdminAccessToken } from '../guard';
import { readDaySettlements } from './settlements';

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
 *
 * ## Ce que la journée a déjà encaissé, lu **avec** elle (#828)
 *
 * Une seconde lecture, `GET /payments` sur la journée de caisse, jointe aux
 * rendez-vous par `appointmentId`. Sans elle, l'écran ouvrait un rendez-vous
 * déjà réglé avec « À encaisser » et un bouton actif, et le refus n'arrivait
 * qu'après le clic : le CDC §1.4 range l'historique des ventes dans le
 * périmètre Paiements, et un règlement inscrit doit se voir avant qu'on essaie
 * d'en créer un second.
 *
 * Elle est **facultative par construction** — voir `settlements.ts` : la route
 * est au seuil `MANAGER` quand cet écran est ouvert à `STAFF`, et son refus
 * rend `null`, c'est-à-dire « inconnu ». L'écran tait alors le règlement au
 * lieu de l'affirmer, et l'encaissement reste possible.
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
  // L'encaissement n'est pas ouvert au praticien : il arrive sur son planning (#813).
  await redirectWithoutPermission(tenantSlug, 'checkout:collect');

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

  // Lue **après** l'agenda et jamais avant : elle est facultative, et un
  // encaissement doit rester possible quand l'historique ne répond pas.
  const settlements = await readDaySettlements(accessToken, anchor, tenant.timezone);
  const settlementFor = (appointmentId: string): SettlementState | null =>
    settlements === null ? null : settlementOf(settlements, appointmentId);

  return (
    <section aria-labelledby="encaissement-titre">
      <h1 className="spa-admin__title" id="encaissement-titre">
        Encaissement
      </h1>

      {/* La même barre que le planning, et le même composant (#629) : deux
       * chevrons encadrés encadrant la date, plus le retour au jour courant qui
       * manquait ici. Les contrôles sont des **liens** — cette page est rendue
       * côté serveur et changer de jour n'a aucune raison d'embarquer du
       * JavaScript (web-frontend §1). Le jour courant est celui du salon, comme
       * l'ancre par défaut : on encaisse la journée que l'équipe travaille. */}
      <nav aria-label="Journée encaissée" className="spa-admin-toolbar">
        <PeriodNav
          label={rangeLabel('jour', anchor)}
          next={{
            href: adminCheckoutPath(tenantSlug, { date: shiftAnchor('jour', anchor, 1) }),
          }}
          nextLabel="Jour suivant"
          previous={{
            href: adminCheckoutPath(tenantSlug, { date: shiftAnchor('jour', anchor, -1) }),
          }}
          previousLabel="Jour précédent"
          today={{
            href: adminCheckoutPath(tenantSlug, { date: todayInTimeZone(tenant.timezone) }),
          }}
        />
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
          settlements={settlements}
          tenantSlug={tenantSlug}
          timeZone={tenant.timezone}
        />
      ) : (
        <div className="spa-admin-checkout">
          <AppointmentRecap
            appointment={selected}
            settlement={settlementFor(selected.id)}
            timeZone={tenant.timezone}
          />
          <CheckoutPanel
            appointment={selected}
            settlement={settlementFor(selected.id)}
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
 * La pastille de règlement d'une ligne — « réglé », « à encaisser », ou l'état
 * intermédiaire d'une carte ouverte (#828).
 *
 * Le libellé est écrit en toutes lettres, la couleur ne fait qu'accélérer le
 * balayage : une journée se lit d'un coup d'œil, et l'information ne doit jamais
 * tenir à la seule teinte (WCAG 1.4.1).
 */
function SettlementBadge({ settlement }: { readonly settlement: SettlementState }) {
  const badge = settlementBadge(settlement);

  return (
    <span className={`spa-admin-badge spa-admin-badge--settlement-${badge.modifier}`}>
      {badge.label}
    </span>
  );
}

/**
 * Le récapitulatif du rendez-vous et du montant dû — premier critère de #59.
 *
 * Le montant est rendu **une fois**, en gros, sous la ligne des totaux : c'est
 * le seul chiffre que l'opérateur annonce à voix haute, et le chercher dans un
 * tableau devant une cliente est exactement ce qui fait dire un mauvais prix.
 *
 * Sur un rendez-vous déjà réglé, ce chiffre reste le même et **son libellé
 * change** : « Réglé » et non « À encaisser » (#828). C'est la ligne que
 * l'opérateur lit en premier, et lui faire annoncer une somme due sur une
 * prestation déjà payée est ce qui l'amenait à cliquer.
 */
function AppointmentRecap({
  appointment,
  settlement,
  timeZone,
}: {
  readonly appointment: Appointment;
  /** `null` quand l'historique n'a pas répondu — l'état est alors inconnu. */
  readonly settlement: SettlementState | null;
  readonly timeZone: TimeZone;
}) {
  const due = amountDue(appointment);
  const settled = settlement !== null && isSettled(settlement);

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
          {appointmentOutcomeLabel(appointment)}
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
          <span className="spa-admin-checkout__total-label">{settled ? 'Réglé' : 'À encaisser'}</span>
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

/**
 * La journée, du premier rendez-vous au dernier, avec un lien par ligne.
 *
 * ## La colonne « Règlement », et pourquoi elle n'est pas toujours là (#828)
 *
 * Elle dit d'un coup d'œil ce qui est réglé et ce qui reste dû — ce que la
 * liste taisait, obligeant à ouvrir chaque rendez-vous pour l'apprendre. Elle
 * n'apparaît que lorsque l'historique a répondu : une colonne remplie de tirets
 * ferait croire à une journée sans recette, et une colonne « à encaisser »
 * partout serait un mensonge pur et simple.
 *
 * Une ligne réglée **reste cliquable** : c'est par là qu'on retrouve son reçu
 * pour le réimprimer.
 */
function AppointmentsToSettle({
  anchor,
  appointments,
  settlements,
  tenantSlug,
  timeZone,
}: {
  readonly anchor: CalendarDate;
  readonly appointments: readonly Appointment[];
  /** `null` quand l'historique n'a pas répondu — la colonne est alors tue. */
  readonly settlements: readonly PaymentTransaction[] | null;
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
          {/* « Client » — le nom que le CDC §2.4 donne à l'entité, et celui que
              le rail, le fichier et le tiroir du planning emploient déjà. Le
              féminin d'avant était faux la moitié du temps : le produit vise
              aussi barbershops et studios de massage (CDC §1.2), et un comptoir
              ne choisit pas ses clients (#761). */}
          <th className="spa-admin-table__head" scope="col">
            Client
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
          {settlements === null ? null : (
            <th className="spa-admin-table__head" scope="col">
              Règlement
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {appointments.map((appointment) => {
          const settlement =
            settlements === null ? null : settlementOf(settlements, appointment.id);

          return (
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
                    {/* Le nom accessible dit ce que le lien fait **ici** : sur
                     * une ligne réglée il n'ouvre plus un encaissement, il ouvre
                     * le règlement et son ticket. Promettre « encaisser » à un
                     * lecteur d'écran sur un rendez-vous soldé serait le même
                     * écart que celui que ce ticket corrige, un cran plus bas. */}
                    <span className="spa-visually-hidden">
                      {settlement !== null && isSettled(settlement)
                        ? ' — voir le règlement'
                        : ' — encaisser ce rendez-vous'}
                    </span>
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
                  {appointmentOutcomeLabel(appointment)}
                </span>
              </td>
              {settlement === null ? null : (
                <td className="spa-admin-table__cell">
                  <SettlementBadge settlement={settlement} />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
