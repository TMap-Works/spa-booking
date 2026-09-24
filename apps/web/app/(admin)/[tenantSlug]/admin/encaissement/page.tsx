import type { Appointment, CalendarDate, Locale, PublicTenant, TimeZone } from '@spa/shared';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

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
  type DisplayLocale,
} from '@/lib/format';
import type { PaymentTransaction, SaleSummary } from '@/lib/admin/payment-contract';

import { CheckoutPanel } from '../components/checkout-panel';
import { PeriodNav } from '../components/period-nav';
import { adminCheckoutPath } from '../paths';
import { adminLoadFailure, redirectWithoutPermission, requireAdminAccessToken } from '../guard';
import { readAppointmentTicket, readDaySettlements, readDayTickets } from './settlements';

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
 *
 * ## Ce que la journée **doit encore**, et non ce qu'elle a pris (#1240)
 *
 * `GET /payments` dit qu'une somme a été prise ; il ne dit pas s'il en reste.
 * Depuis le règlement mixte (#817), une part de 50,00 € sur un ticket de 78,00 €
 * y inscrit une ligne aboutie, et la pastille en concluait « réglé ». Seul le
 * **ticket** tranche — `remaining`, recalculé par le serveur —, d'où une seconde
 * lecture, `readDayTickets`, bornée aux rendez-vous dont la journée porte déjà un
 * encaissement abouti et servie à la **liste seule** : le rendez-vous ouvert à
 * l'écran a déjà son ticket, juste en dessous. Le coût est donc nul tant que rien
 * n'est encaissé, et borné ensuite.
 *
 * ## La langue (#850)
 *
 * Les mots viennent du namespace `admin-checkout` — sauf le statut du
 * rendez-vous, qui vient de `lib/appointment-status.ts`, seul endroit du front
 * où ce vocabulaire s'écrit, et sauf les refus de l'API, que
 * `lib/admin/checkout-summary.ts` traduit sur leur **code**.
 *
 * Le **fuseau reste celui du salon** dans les deux langues, et la journée de
 * caisse avec lui : la langue et la région — le pays de l'établissement, lu sur
 * sa vitrine — ne disent que la façon d'écrire une heure et un montant, jamais
 * quelle heure il est ni combien la cliente doit (`CLAUDE.md`). Un montant reste
 * un entier accompagné d'un code devise de bout en bout ; sa seule mise en forme
 * a lieu dans `lib/format.ts`.
 */

export const dynamic = 'force-dynamic';

type CheckoutTranslator = Awaited<ReturnType<typeof getTranslations<'admin-checkout'>>>;

interface CheckoutPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{ readonly date?: string; readonly rdv?: string }>;
}

export default async function CheckoutPage({ params, searchParams }: CheckoutPageProps) {
  const { tenantSlug } = await params;
  const { date, rdv } = await searchParams;
  const t = await getTranslations('admin-checkout');
  const locale = await getLocale();

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
    deniedTitle: t('denied.title'),
    deniedHint: t('denied.hint'),
    failedTitle: t('denied.failedTitle'),
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
  // La région vient du pays de l'établissement, déjà lu sur la vitrine ci-dessus :
  // elle ne dit que la façon d'écrire une date et un montant (#850).
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };

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
  // Le ticket déjà ouvert sur le rendez-vous en cours de règlement, s'il y en a
  // un : c'est ce qui permet à un règlement mixte de survivre à un
  // rafraîchissement au lieu d'ouvrir une seconde pièce (#835). Lecture seule —
  // la composition est au premier règlement, jamais à l'affichage.
  const ticket = selected === undefined ? null : await readAppointmentTicket(accessToken, selected.id);
  // Le reste dû des rendez-vous **déjà encaissés** de la journée — sans lui, la
  // pastille disait « réglé » d'un ticket à moitié payé (#1240). Lu pour la
  // **liste seule** : un rendez-vous ouvert à l'écran a son ticket juste
  // au-dessus, et relire toute la journée en pure perte serait le contraire du
  // coût que le premier critère demande de tenir.
  //
  // `null` d'une lecture comme de l'autre veut dire « inconnu », et un état
  // inconnu se **tait** : la colonne disparaît plutôt que d'affirmer un
  // règlement que rien n'a vérifié. C'est la conduite que l'écran tenait déjà
  // quand l'historique ne répondait pas, étendue à la seconde lecture.
  //
  // Bornée aux rendez-vous **affichés** : la journée de caisse en couvre trois
  // (la veille et le lendemain avec celle-ci, voir `readDaySettlements`), et
  // relire les tickets de deux journées qu'aucune ligne ne montre aurait coûté
  // autant de requêtes inutiles — et fait franchir le plafond de
  // `readDayTickets` à une journée qui, à elle, ne l'atteint pas.
  const tickets =
    selected !== undefined
      ? null
      : await readDayTickets(
          accessToken,
          settlements,
          new Set(appointments.map((one) => one.id)),
        );
  /**
   * L'état du rendez-vous **ouvert à l'écran**, et lui seul.
   *
   * Il n'a pas besoin de la journée de tickets — celle-ci n'est pas lue dans
   * cette branche — parce qu'il a mieux : `ticket`, la pièce exacte de ce
   * rendez-vous, déjà relue juste au-dessus. La lui donner n'ajoute **aucune**
   * requête, et c'est ce qui empêche le récapitulatif d'annoncer « Réglé » sur
   * une prestation dont 28,00 € restent dus — le même mensonge que celui de la
   * liste, un écran plus loin (#1240).
   */
  const ownTicket =
    selected === undefined || ticket === null ? undefined : new Map([[selected.id, ticket]]);
  const settlementFor = (appointmentId: string): SettlementState | null =>
    settlements === null ? null : settlementOf(settlements, appointmentId, ownTicket);

  return (
    <section aria-labelledby="encaissement-titre">
      <h1 className="spa-admin__title" id="encaissement-titre">
        {t('title')}
      </h1>

      {/* La même barre que le planning, et le même composant (#629) : deux
       * chevrons encadrés encadrant la date, plus le retour au jour courant qui
       * manquait ici. Les contrôles sont des **liens** — cette page est rendue
       * côté serveur et changer de jour n'a aucune raison d'embarquer du
       * JavaScript (web-frontend §1). Le jour courant est celui du salon, comme
       * l'ancre par défaut : on encaisse la journée que l'équipe travaille. */}
      <nav aria-label={t('day.navLabel')} className="spa-admin-toolbar">
        <PeriodNav
          label={rangeLabel('jour', anchor, display)}
          next={{
            href: adminCheckoutPath(tenantSlug, { date: shiftAnchor('jour', anchor, 1) }),
          }}
          nextLabel={t('day.next')}
          previous={{
            href: adminCheckoutPath(tenantSlug, { date: shiftAnchor('jour', anchor, -1) }),
          }}
          previousLabel={t('day.previous')}
          today={{
            href: adminCheckoutPath(tenantSlug, { date: todayInTimeZone(tenant.timezone) }),
          }}
        />
        <span className="spa-admin-toolbar__spacer" />
        <p className="spa-admin-toolbar__hint">{t('day.timeZoneHint')}</p>
      </nav>

      {rdv !== undefined && selected === undefined ? (
        <Notification tone="warning" title={t('notInDay.title')}>
          <p>{t('notInDay.body', { date: formatCalendarDate(anchor, display) })}</p>
        </Notification>
      ) : null}

      {selected === undefined ? (
        <AppointmentsToSettle
          anchor={anchor}
          appointments={appointments}
          display={display}
          settlements={settlements}
          t={t}
          tenantSlug={tenantSlug}
          tickets={tickets}
          timeZone={tenant.timezone}
        />
      ) : (
        <div className="spa-admin-checkout">
          <AppointmentRecap
            appointment={selected}
            display={display}
            settlement={settlementFor(selected.id)}
            t={t}
            timeZone={tenant.timezone}
          />
          <CheckoutPanel
            appointment={selected}
            countryCode={tenant.address?.country ?? null}
            settlement={settlementFor(selected.id)}
            tenantSlug={tenantSlug}
            ticket={ticket}
            timeZone={tenant.timezone}
          />
        </div>
      )}

      {selected === undefined ? null : (
        <p className="spa-admin-toolbar__hint">
          <Link href={adminCheckoutPath(tenantSlug, { date: anchor })}>{t('day.backToList')}</Link>
        </p>
      )}
    </section>
  );
}

/**
 * La pastille de règlement d'une ligne — « réglé », « partiellement réglé »,
 * « à encaisser », ou l'état intermédiaire d'une carte ouverte (#828, #1240).
 *
 * Le libellé est écrit en toutes lettres, la couleur ne fait qu'accélérer le
 * balayage : une journée se lit d'un coup d'œil, et l'information ne doit jamais
 * tenir à la seule teinte (WCAG 1.4.1).
 *
 * « Partiellement réglé » est le libellé que #1240 a ajouté, et il a une raison
 * d'être précise : la pastille disait « réglé » dès qu'une ligne aboutie se
 * rattachait au rendez-vous, alors qu'une part de 50,00 € sur un ticket de
 * 78,00 € en inscrit une. Un gérant qui relisait sa journée voyait « réglé » sur
 * une prestation à moitié payée.
 */
function SettlementBadge({
  locale,
  settlement,
}: {
  readonly locale: Locale;
  readonly settlement: SettlementState;
}) {
  const badge = settlementBadge(settlement, locale);

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
 *
 * Sur un rendez-vous **partiellement** réglé, c'est le chiffre lui-même qui
 * change, et pour la même raison (#1240) : le prix figé à la réservation n'est
 * plus ce que la cliente doit dès qu'une part a été prise. Annoncer 78,00 €
 * quand 28,00 € restent dus serait le même écart que d'annoncer « Réglé » sur la
 * même pièce, à un mot près. Le reste dû vient du **ticket** que porte l'état —
 * `remaining`, recalculé par le serveur —, jamais d'une soustraction faite ici.
 */
function AppointmentRecap({
  appointment,
  display,
  settlement,
  t,
  timeZone,
}: {
  readonly appointment: Appointment;
  readonly display: DisplayLocale;
  /** `null` quand l'historique n'a pas répondu — l'état est alors inconnu. */
  readonly settlement: SettlementState | null;
  readonly t: CheckoutTranslator;
  readonly timeZone: TimeZone;
}) {
  const due = amountDue(appointment);
  const settled = settlement !== null && isSettled(settlement);
  // Le ticket à moitié réglé, s'il y en a un : c'est lui qui porte le montant à
  // annoncer, et non le prix figé à la réservation.
  const outstanding = settlement?.kind === 'partiel' ? settlement.ticket.remaining : null;

  return (
    <div className="spa-admin-checkout__ticket">
      <div className="spa-admin-checkout__origin">
        <span>{t('recap.attachedTo')}</span>
        <strong>
          {appointment.client.firstName} {appointment.client.lastName} —{' '}
          {formatTimeInTimeZone(appointment.startsAt, timeZone, display)}
        </strong>
        <span
          className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}
        >
          {appointmentOutcomeLabel(appointment, 'desk', display.locale)}
        </span>
      </div>

      <table className="spa-admin-table">
        <caption className="spa-visually-hidden">{t('recap.caption')}</caption>
        <thead>
          <tr>
            <th className="spa-admin-table__head" scope="col">
              {t('recap.service')}
            </th>
            <th className="spa-admin-table__head" scope="col">
              {t('recap.staff')}
            </th>
            <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
              {t('recap.total')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="spa-admin-table__row">
            <td className="spa-admin-table__cell">
              {appointment.service.name} —{' '}
              {formatDuration(appointment.service.durationMinutes, display)}
            </td>
            <td className="spa-admin-table__cell">{appointment.staff.displayName}</td>
            <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
              {formatMoney(due, display)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="spa-admin-checkout__totals">
        <div className="spa-admin-checkout__total-row">
          <span className="spa-admin-checkout__total-label">{t('recap.schedule')}</span>
          <span className="spa-admin-checkout__total-value">
            {formatTimeInTimeZone(appointment.startsAt, timeZone, display)} –{' '}
            {formatTimeInTimeZone(appointment.endsAt, timeZone, display)}
          </span>
        </div>
        <div className="spa-admin-checkout__total-row spa-admin-checkout__total-row--grand">
          <span className="spa-admin-checkout__total-label">
            {settled
              ? t('recap.settled')
              : outstanding === null
                ? t('recap.due')
                : t('ticket.remainingLabel')}
          </span>
          <span className="spa-admin-checkout__total-value">
            {formatMoney(outstanding ?? due, display)}
          </span>
        </div>
      </div>

      <p className="spa-admin-toolbar__hint">{t('recap.fixedPrice')}</p>
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
 *
 * ## Elle exige désormais **deux** lectures, et se tait s'il en manque une (#1240)
 *
 * Les encaissements du jour disent qu'une somme a été prise ; seul le **ticket**
 * dit s'il en reste. Faute de l'un ou de l'autre, la pastille ne pourrait
 * affirmer « réglé » que sur la foi d'une ligne d'encaissement — et c'est
 * exactement ce qu'elle faisait d'un ticket à moitié payé. La colonne disparaît
 * alors, au même titre et pour la même raison qu'elle disparaissait déjà quand
 * l'historique refusait de répondre.
 */
function AppointmentsToSettle({
  anchor,
  appointments,
  display,
  settlements,
  t,
  tenantSlug,
  tickets,
  timeZone,
}: {
  readonly anchor: CalendarDate;
  readonly appointments: readonly Appointment[];
  readonly display: DisplayLocale;
  /** `null` quand l'historique n'a pas répondu — la colonne est alors tue. */
  readonly settlements: readonly PaymentTransaction[] | null;
  readonly t: CheckoutTranslator;
  readonly tenantSlug: string;
  /** `null` quand le reste dû des tickets n'a pas pu être relu — même conduite. */
  readonly tickets: ReadonlyMap<string, SaleSummary> | null;
  readonly timeZone: TimeZone;
}) {
  // Les annulés restent affichés — ils expliquent le trou dans la journée — mais
  // leur ligne n'ouvre rien : il n'y a plus de prestation à encaisser.
  if (appointments.length === 0) {
    return (
      <div className="spa-empty-state">
        <p className="spa-empty-state__title">{t('list.emptyTitle')}</p>
        <p className="spa-empty-state__description">
          {t('list.emptyBody', { date: formatCalendarDate(anchor, display) })}
        </p>
      </div>
    );
  }

  // Les deux lectures, ramenées à une seule question : la colonne peut-elle dire
  // la vérité ? Les deux `null` se rejoignent ici plutôt que sur cinq tests
  // dispersés dans le tableau.
  const stated = settlements === null || tickets === null ? null : { settlements, tickets };

  return (
    <table className="spa-admin-table">
      <caption className="spa-visually-hidden">{t('list.caption')}</caption>
      <thead>
        <tr>
          <th className="spa-admin-table__head" scope="col">
            {t('list.time')}
          </th>
          {/* « Client » — le nom que le CDC §2.4 donne à l'entité, et celui que
              le rail, le fichier et le tiroir du planning emploient déjà. Le
              féminin d'avant était faux la moitié du temps : le produit vise
              aussi barbershops et studios de massage (CDC §1.2), et un comptoir
              ne choisit pas ses clients (#761). L'anglais dit « Client » lui
              aussi, pour la même raison qu'il le dit dans le reste du
              back-office : c'est le mot du contrat partagé. */}
          <th className="spa-admin-table__head" scope="col">
            {t('list.client')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('list.service')}
          </th>
          <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
            {t('list.amount')}
          </th>
          <th className="spa-admin-table__head" scope="col">
            {t('list.status')}
          </th>
          {stated === null ? null : (
            <th className="spa-admin-table__head" scope="col">
              {t('list.settlement')}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {appointments.map((appointment) => {
          const settlement =
            stated === null
              ? null
              : settlementOf(stated.settlements, appointment.id, stated.tickets);

          return (
            <tr className="spa-admin-table__row" key={appointment.id}>
              <td className="spa-admin-table__cell">
                {formatTimeInTimeZone(appointment.startsAt, timeZone, display)}
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
                        ? t('list.openSettlement')
                        : t('list.openCheckout')}
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
                {formatMoney(amountDue(appointment), display)}
              </td>
              <td className="spa-admin-table__cell">
                <span
                  className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}
                >
                  {appointmentOutcomeLabel(appointment, 'desk', display.locale)}
                </span>
              </td>
              {settlement === null ? null : (
                <td className="spa-admin-table__cell">
                  <SettlementBadge locale={display.locale} settlement={settlement} />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
