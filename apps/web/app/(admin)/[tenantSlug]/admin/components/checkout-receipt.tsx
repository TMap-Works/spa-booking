'use client';

import type { Appointment, PaymentMethod, TimeZone } from '@spa/shared';
import { subtractMoney } from '@spa/shared';

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
import { formatDateTimeInTimeZone, formatDuration, formatMoney } from '@/lib/format';

/**
 * Le ticket remis à la cliente — cinquième critère de #59.
 *
 * ## Ce qu'il porte, et ce qu'il ne portera jamais
 *
 * La prestation, sa durée, le montant, le moyen employé, l'instant. **Aucune
 * donnée de carte** : ni marque, ni quatre derniers chiffres, ni référence de
 * porteur. Le domaine n'en a pas la notion et le schéma de lecture ne les
 * déclare pas, si bien qu'il n'y a nulle part où en ranger une
 * (payments-stripe §1).
 *
 * La référence Stripe n'y figure pas davantage : elle sert le rapprochement, qui
 * est l'écran du journal des transactions au seuil `MANAGER`. Un ticket de
 * comptoir n'a pas à la porter.
 *
 * ## Pourquoi un reçu carte est explicitement provisoire
 *
 * Parce que le navigateur n'a jamais autorité pour déclarer un paiement abouti :
 * une carte acceptée l'est *auprès de Stripe*, et c'est le webhook signé, reçu
 * côté serveur, qui inscrit l'encaissement chez nous. Imprimer « encaissé » sur
 * la foi de la réponse du navigateur donnerait à la cliente une preuve que notre
 * base ne confirme pas encore (payments-stripe §2). Le règlement en espèces est
 * l'inverse : la caisse fait foi, la ligne naît aboutie, le reçu est définitif.
 *
 * ## L'impression
 *
 * `window.print()` : la boîte de dialogue du système, celle que l'opérateur
 * connaît, et qui sait aussi produire un PDF à joindre à un e-mail. Le CDC
 * demande « impression **ou** envoi » ; l'envoi supposerait une route de
 * notification que l'API ne sert pas.
 *
 * ## La réimpression, et pourquoi elle n'est pas provisoire (#828)
 *
 * Ce même reçu sert à **réimprimer** celui d'un encaissement déjà inscrit,
 * relu de l'historique de la journée. `settled` dit qu'on est dans ce cas, et
 * il ne se déduit pas du moyen : un reçu carte imprimé sur la réponse du
 * navigateur est provisoire, le même reçu réimprimé depuis une ligne
 * `succeeded` ne l'est pas — c'est le webhook signé qui a écrit cette ligne.
 * Sans ce drapeau, la réimpression aurait annoncé « preuve de passage, pas de
 * capture » sur un encaissement que la base confirme.
 *
 * Et si l'encaissement relu porte un remboursement (#63), le reçu l'écrit :
 * « Remboursé », puis « Reste acquis » à la place du total. Un ticket se remet
 * en main propre : lui faire affirmer une somme encaissée que le prestataire a
 * déjà rendue contredirait le bandeau juste au-dessus, qui l'annonce, et la
 * pastille de la liste, qui dit « remboursé ».
 */
export function CheckoutReceipt({
  appointment,
  method,
  settled = false,
  timeZone,
  transaction,
}: {
  readonly appointment: Appointment;
  readonly method: PaymentMethod;
  /** L'encaissement est déjà inscrit en base : le reçu est définitif. */
  readonly settled?: boolean;
  readonly timeZone: TimeZone;
  /** L'encaissement inscrit — `null` sur une carte, que seul le webhook conclut. */
  readonly transaction: PaymentTransaction | null;
}) {
  const due = amountDue(appointment);
  const provisional = !settled && receiptIsProvisional(method);
  const settledAt = transaction?.capturedAt ?? transaction?.createdAt ?? null;
  // Ce que le prestataire a **rendu** sur cet encaissement (#63) — `null` tant
  // qu'il n'a rien rendu, ce qui est le cas de tout reçu imprimé au comptoir.
  const refunded =
    transaction !== null && transaction.refunded.amountMinor > 0 ? transaction.refunded : null;
  // Le montant de la ligne inscrite, moins ce qui a été rendu. `due` reste la
  // référence hors remboursement : c'est le prix figé à la réservation, et rien
  // n'est calculé ici sur un reçu qui n'a rien à défalquer.
  const kept =
    refunded === null || transaction === null
      ? due
      : subtractMoney(transaction.amount, refunded);

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
        Reçu
      </h2>

      <table className="spa-admin-table">
        <caption className="spa-visually-hidden">Lignes du reçu</caption>
        <thead>
          <tr>
            <th className="spa-admin-table__head" scope="col">
              Ligne
            </th>
            <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
              Qté
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
            <td className="spa-admin-table__cell spa-admin-table__cell--numeric">1</td>
            <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
              {formatMoney(due)}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="spa-admin-checkout__totals">
        <div className="spa-admin-checkout__total-row">
          <span className="spa-admin-checkout__total-label">Moyen de paiement</span>
          <span className="spa-admin-checkout__total-value">{methodLabel(method)}</span>
        </div>
        {settledAt === null ? null : (
          <div className="spa-admin-checkout__total-row">
            <span className="spa-admin-checkout__total-label">Enregistré le</span>
            <span className="spa-admin-checkout__total-value">
              {formatDateTimeInTimeZone(settledAt, timeZone)}
            </span>
          </div>
        )}
        {refunded === null ? null : (
          <div className="spa-admin-checkout__total-row">
            <span className="spa-admin-checkout__total-label">Remboursé</span>
            <span className="spa-admin-checkout__total-value">− {formatMoney(refunded)}</span>
          </div>
        )}
        <div className="spa-admin-checkout__total-row spa-admin-checkout__total-row--grand">
          <span className="spa-admin-checkout__total-label">
            {refunded === null ? 'Total' : 'Reste acquis'}
          </span>
          <span className="spa-admin-checkout__total-value">{formatMoney(kept)}</span>
        </div>
      </div>

      <Button
        variant="neutral"
        onClick={() => {
          window.print();
        }}
      >
        Imprimer le ticket
      </Button>
    </section>
  );
}
