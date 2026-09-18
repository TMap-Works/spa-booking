'use client';

import type { Appointment, PaymentMethod, SaleReceipt, TimeZone } from '@spa/shared';
import { subtractMoney } from '@spa/shared';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  amountDue,
  methodLabel,
  receiptDisclaimer,
  receiptIsProvisional,
  settledReceiptDisclaimer,
} from '@/lib/admin/checkout-summary';
import type { PaymentTransaction } from '@/lib/admin/payment-contract';
import { formatDuration, formatMoney, formatTicketDateTime } from '@/lib/format';

import { loadReceiptAction } from '../encaissement/actions';
import { adminReceiptPdfPath } from '../paths';
import { ReceiptTicket } from './receipt-ticket';
import { TicketPrinter } from './ticket-printer';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

/**
 * Le ticket remis à la cliente — cinquième critère de #59.
 *
 * ## Le ticket, et non la page
 *
 * Imprimer la page donnait la page — le rail, la liste du jour, le panneau de
 * paiement. Ce qui s'imprime désormais est le **ticket de caisse** de la vente
 * que l'encaissement vient de solder, tel que l'API le compose
 * (`GET /sales/{id}/receipt`, #818) : identité légale du salon, numéro de
 * pièce, client, praticien, articles, total HT, TVA par taux, total TTC,
 * règlement. `ReceiptTicket` le met en page comme un rouleau de 80 mm, et
 * `TicketPrinter` l'imprime **seul**. Les deux PDF de l'API — rouleau 80 mm et
 * facture A4 — s'ouvrent à côté, pour l'envoyer ou l'archiver.
 *
 * Un encaissement sans vente (inscrit avant #817) ou un reçu carte encore
 * provisoire n'a pas de pièce à relire : il garde un reçu réduit, composé du
 * rendez-vous, sur le même papier et avec la même impression.
 *
 * ## Ce qu'il ne portera jamais
 *
 * **Aucune donnée de carte** : ni marque, ni quatre derniers chiffres, ni
 * référence de porteur. Le domaine n'en a pas la notion et le schéma de lecture
 * ne les déclare pas (payments-stripe §1). La référence Stripe n'y figure pas
 * davantage : elle sert le rapprochement, au seuil `MANAGER`.
 *
 * ## Pourquoi un reçu carte est explicitement provisoire
 *
 * Parce que le navigateur n'a jamais autorité pour déclarer un paiement abouti :
 * une carte acceptée l'est *auprès de Stripe*, et c'est le webhook signé, reçu
 * côté serveur, qui inscrit l'encaissement chez nous (payments-stripe §2). Le
 * règlement en espèces est l'inverse : la caisse fait foi, la ligne naît
 * aboutie, le reçu est définitif.
 *
 * ## La réimpression, et pourquoi elle n'est pas provisoire (#828)
 *
 * Ce même reçu sert à **réimprimer** celui d'un encaissement déjà inscrit,
 * relu de l'historique de la journée. `settled` dit qu'on est dans ce cas : un
 * reçu carte réimprimé depuis une ligne `succeeded` n'est pas provisoire —
 * c'est le webhook signé qui a écrit cette ligne.
 */
export function CheckoutReceipt({
  appointment,
  method,
  settled = false,
  tenantSlug,
  timeZone,
  transaction,
}: {
  readonly appointment: Appointment;
  readonly method: PaymentMethod;
  /** L'encaissement est déjà inscrit en base : le reçu est définitif. */
  readonly settled?: boolean;
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
  /** L'encaissement inscrit — `null` sur une carte, que seul le webhook conclut. */
  readonly transaction: PaymentTransaction | null;
}) {
  const due = amountDue(appointment);
  const provisional = !settled && receiptIsProvisional(method);
  // La pièce que ce règlement solde — `null` sur un reçu carte provisoire, et
  // sur les encaissements inscrits avant qu'une vente ne soit exigée (#817).
  const saleId = provisional ? null : (transaction?.saleId ?? null);

  return (
    <section aria-labelledby="recu-titre" className="spa-admin-checkout__ticket">
      <Notification
        tone={provisional ? 'info' : 'success'}
        title={
          provisional
            ? 'Paiement accepté par le prestataire'
            : `Encaissement enregistré — ${formatMoney(due)}`
        }
      >
        <p>{settled ? settledReceiptDisclaimer(method) : receiptDisclaimer(method)}</p>
      </Notification>

      <h2 className="spa-admin__section-title" id="recu-titre">
        Ticket de caisse
      </h2>

      {saleId === null ? (
        <AppointmentReceipt
          appointment={appointment}
          method={method}
          provisional={provisional}
          timeZone={timeZone}
          transaction={transaction}
        />
      ) : (
        <SaleTicket saleId={saleId} tenantSlug={tenantSlug} />
      )}
    </section>
  );
}

type TicketState =
  | { readonly kind: 'chargement' }
  | { readonly kind: 'pret'; readonly receipt: SaleReceipt }
  | { readonly kind: 'echec'; readonly message: string };

/**
 * Le ticket de caisse d'une vente : relu de l'API, affiché en aperçu,
 * imprimable seul, et ouvrable en PDF (rouleau 80 mm ou facture A4).
 */
function SaleTicket({
  saleId,
  tenantSlug,
}: {
  readonly saleId: string;
  readonly tenantSlug: string;
}) {
  const [state, setState] = useState<TicketState>({ kind: 'chargement' });
  const [attempt, setAttempt] = useState(0);
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);

  useEffect(() => {
    let live = true;

    setState({ kind: 'chargement' });
    loadReceiptAction(tenantSlug, saleId)
      .then((result) => {
        if (!live) {
          return;
        }
        if (result.ok) {
          setState({ kind: 'pret', receipt: result.data });
          return;
        }
        // Une session à renouveler n'est pas un ticket indisponible : la page
        // part se renouveler et revient telle quelle.
        if (renewIfExpired(result)) {
          return;
        }
        setState({ kind: 'echec', message: result.message });
      })
      .catch(() => {
        if (live) {
          setState({
            kind: 'echec',
            message: 'Le ticket n’a pas pu être chargé. Vérifiez la connexion et réessayez.',
          });
        }
      });

    return () => {
      live = false;
    };
  }, [attempt, renewIfExpired, saleId, tenantSlug]);

  const pdfLinks = (
    <>
      <a
        className="spa-button spa-button--neutral"
        href={adminReceiptPdfPath(tenantSlug, saleId, 'ticket-80')}
        rel="noopener"
        target="_blank"
      >
        <span className="spa-button__label">PDF ticket</span>
      </a>
      <a
        className="spa-button spa-button--neutral"
        href={adminReceiptPdfPath(tenantSlug, saleId, 'a4')}
        rel="noopener"
        target="_blank"
      >
        <span className="spa-button__label">Facture A4</span>
      </a>
    </>
  );

  if (state.kind === 'chargement') {
    return (
      <p aria-live="polite" className="spa-admin-checkout__pci" role="status">
        Préparation du ticket…
      </p>
    );
  }

  if (state.kind === 'echec') {
    return (
      <>
        <Notification tone="warning" title="Ticket indisponible">
          <p>{state.message}</p>
        </Notification>
        <div className="spa-ticket-actions">
          <Button
            onClick={() => {
              setAttempt((count) => count + 1);
            }}
            variant="accent"
          >
            Réessayer
          </Button>
          {pdfLinks}
        </div>
      </>
    );
  }

  return (
    <>
      <ReceiptTicket receipt={state.receipt} />
      <div className="spa-ticket-actions">
        <TicketPrinter>
          <ReceiptTicket receipt={state.receipt} />
        </TicketPrinter>
        {pdfLinks}
      </div>
    </>
  );
}

/**
 * Le reçu d'un encaissement **sans pièce** — composé du rendez-vous seul.
 *
 * Deux cas : la carte que Stripe vient d'accepter, dont le webhook n'a encore
 * rien inscrit (le reçu le dit provisoire), et l'encaissement antérieur à #817,
 * que la reprise n'a pas rattaché à une vente. Ni identité légale ni TVA : elles
 * vivent sur la pièce, qu'on n'a pas.
 *
 * Si l'encaissement relu porte un remboursement (#63), le reçu l'écrit :
 * « Remboursé », puis « Reste acquis » à la place du total. Un ticket se remet
 * en main propre : lui faire affirmer une somme que le prestataire a déjà
 * rendue contredirait le bandeau juste au-dessus.
 */
function AppointmentReceipt({
  appointment,
  method,
  provisional,
  timeZone,
  transaction,
}: {
  readonly appointment: Appointment;
  readonly method: PaymentMethod;
  readonly provisional: boolean;
  readonly timeZone: TimeZone;
  readonly transaction: PaymentTransaction | null;
}) {
  const due = amountDue(appointment);
  const settledAt = transaction?.capturedAt ?? transaction?.createdAt ?? null;
  // Ce que le prestataire a **rendu** sur cet encaissement (#63) — `null` tant
  // qu'il n'a rien rendu, ce qui est le cas de tout reçu imprimé au comptoir.
  const refunded =
    transaction !== null && transaction.refunded.amountMinor > 0 ? transaction.refunded : null;
  // Le montant de la ligne inscrite, moins ce qui a été rendu. `due` reste la
  // référence hors remboursement : c'est le prix figé à la réservation.
  const kept =
    refunded === null || transaction === null
      ? due
      : subtractMoney(transaction.amount, refunded);

  const receipt = (
    <article aria-label="Reçu" className="spa-ticket">
      <div className="spa-ticket__identity">
        <p className="spa-ticket__title">{provisional ? 'Reçu provisoire' : 'Reçu'}</p>
        {settledAt === null ? null : <p>{formatTicketDateTime(settledAt, timeZone)}</p>}
        {provisional ? (
          <p className="spa-ticket__note">Paiement en cours de confirmation.</p>
        ) : null}
      </div>

      <hr className="spa-ticket__rule" />

      <dl className="spa-ticket__rows">
        <div className="spa-ticket__row">
          <dt>Client</dt>
          <dd>
            {appointment.client.firstName} {appointment.client.lastName}
          </dd>
        </div>
        <div className="spa-ticket__row">
          <dt>Praticien</dt>
          <dd>{appointment.staff.displayName}</dd>
        </div>
      </dl>

      <hr className="spa-ticket__rule" />

      <table className="spa-ticket__items">
        <caption className="spa-visually-hidden">Lignes du reçu</caption>
        <thead>
          <tr>
            <th scope="col">Article</th>
            <th className="spa-ticket__num" scope="col">
              Qté
            </th>
            <th className="spa-ticket__num" scope="col">
              Montant
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {appointment.service.name} — {formatDuration(appointment.service.durationMinutes)}
            </td>
            <td className="spa-ticket__num">1</td>
            <td className="spa-ticket__num">{formatMoney(due)}</td>
          </tr>
        </tbody>
      </table>

      <hr className="spa-ticket__rule spa-ticket__rule--dashed" />

      <dl className="spa-ticket__rows">
        {refunded === null ? null : (
          <div className="spa-ticket__row">
            <dt>Remboursé</dt>
            <dd>− {formatMoney(refunded)}</dd>
          </div>
        )}
        <div className="spa-ticket__row spa-ticket__row--grand">
          <dt>{refunded === null ? 'Total' : 'Reste acquis'}</dt>
          <dd>{formatMoney(kept)}</dd>
        </div>
        <div className="spa-ticket__row">
          <dt>Règlement</dt>
          <dd>{methodLabel(method)}</dd>
        </div>
      </dl>

      <hr className="spa-ticket__rule" />

      <footer className="spa-ticket__footer">
        <p className="spa-ticket__thanks">Merci de votre visite !</p>
      </footer>
    </article>
  );

  return (
    <>
      {receipt}
      <div className="spa-ticket-actions">
        <TicketPrinter>{receipt}</TicketPrinter>
      </div>
    </>
  );
}
