'use client';

import type { Appointment, PaymentMethod, TimeZone } from '@spa/shared';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  amountDue,
  methodLabel,
  receiptDisclaimer,
  receiptIsProvisional,
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
 */
export function CheckoutReceipt({
  appointment,
  method,
  timeZone,
  transaction,
}: {
  readonly appointment: Appointment;
  readonly method: PaymentMethod;
  readonly timeZone: TimeZone;
  /** L'encaissement inscrit — `null` sur une carte, que seul le webhook conclut. */
  readonly transaction: PaymentTransaction | null;
}) {
  const due = amountDue(appointment);
  const provisional = receiptIsProvisional(method);
  const settledAt = transaction?.capturedAt ?? transaction?.createdAt ?? null;

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
        <p>{receiptDisclaimer(method)}</p>
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
        <div className="spa-admin-checkout__total-row spa-admin-checkout__total-row--grand">
          <span className="spa-admin-checkout__total-label">Total</span>
          <span className="spa-admin-checkout__total-value">{formatMoney(due)}</span>
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
