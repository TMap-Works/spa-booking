'use client';

import type { Appointment, PaymentMethod, TimeZone } from '@spa/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  CHECKOUT_METHODS,
  PROVIDER_UNREACHABLE_MESSAGE,
  amountDue,
  checkoutBlocker,
  checkoutFailureMessage,
  completionUnavailableMessage,
  isSettleable,
  methodHint,
  methodLabel,
} from '@/lib/admin/checkout-summary';
import type { AppointmentPaymentIntent, PaymentTransaction } from '@/lib/admin/payment-contract';
import { formatMoney } from '@/lib/format';

import type { AdminActionResult } from '../action-result';
import { openCardPaymentAction, settleInCashAction } from '../encaissement/actions';
import { CheckoutCardForm } from './checkout-card-form';
import { CheckoutReceipt } from './checkout-receipt';

/**
 * Le panneau d'encaissement d'un rendez-vous — deuxième et quatrième critères de
 * #59.
 *
 * ## Les trois états, et pourquoi ils sont explicites
 *
 * `choix` → `carte` → `regle`. Un booléen « en cours » n'aurait pas suffi : la
 * carte a une étape intermédiaire — l'intention est ouverte, l'élément de Stripe
 * est monté, rien n'est encore débité — pendant laquelle changer de moyen de
 * paiement doit démonter proprement l'élément. Nommer l'état rend cette
 * transition visible plutôt que déduite de trois conditions.
 *
 * ## Le double clic
 *
 * Deux protections, et elles ne font pas doublon. Côté écran, `Button` se
 * désactive dès que `loading` est posé (web-frontend §3). Côté API, l'ouverture
 * d'intention et le règlement en espèces sont **idempotents** — le second appel
 * rend la même intention et le même encaissement. La première évite la question,
 * la seconde évite le dégât si elle se pose quand même : un écran ne peut pas
 * garantir qu'il n'y a qu'un poste devant la caisse.
 *
 * ## Ce que ce panneau ne fait pas
 *
 * Il ne calcule aucun total — le montant dû est le prix figé à la réservation —
 * et il ne déclare aucun paiement carte abouti : c'est le webhook signé qui
 * inscrit l'encaissement, côté serveur (payments-stripe §2).
 */
type Phase =
  | { readonly kind: 'choix' }
  | { readonly kind: 'carte'; readonly intent: AppointmentPaymentIntent }
  | {
      readonly kind: 'regle';
      readonly method: PaymentMethod;
      readonly transaction: PaymentTransaction | null;
    };

export function CheckoutPanel({
  appointment,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: Appointment;
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
}) {
  const due = amountDue(appointment);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [phase, setPhase] = useState<Phase>({ kind: 'choix' });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const blocker = checkoutBlocker(appointment.status, method);

  /**
   * Déroule une action d'encaissement en tenant l'indicateur d'attente.
   *
   * Le `finally` n'est pas une précaution de style : une action serveur ne rend
   * un résultat que si elle **aboutit**. Si l'appel lui-même échoue — le réseau
   * du poste tombe entre le clic et le POST —, la promesse est rejetée, et sans
   * ce `finally` `pending` resterait vrai : bouton grisé, roue qui tourne,
   * aucune explication, et plus rien à faire qu'un rechargement complet devant
   * la cliente. C'est le `try/finally` que le planning tient déjà sur ses
   * chargements.
   */
  async function run<TData>(
    call: () => Promise<AdminActionResult<TData>>,
    onSuccess: (data: TData) => void,
  ): Promise<void> {
    setPending(true);
    setFailure(null);

    try {
      const result = await call();

      if (result.ok) {
        onSuccess(result.data);
        return;
      }

      setFailure(checkoutFailureMessage(result.code, result.message));
    } catch {
      // L'action n'a pas répondu du tout : rien n'a été encaissé, et le message
      // le dit plutôt que de laisser le comptoir deviner.
      setFailure(PROVIDER_UNREACHABLE_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  async function settleInCash(): Promise<void> {
    await run(
      () => settleInCashAction(tenantSlug, appointment.id),
      (transaction) => {
        setPhase({ kind: 'regle', method: 'cash', transaction });
      },
    );
  }

  async function openCardPayment(): Promise<void> {
    await run(
      () => openCardPaymentAction(tenantSlug, appointment.id),
      (intent) => {
        setPhase({ kind: 'carte', intent });
      },
    );
  }

  function chooseMethod(next: PaymentMethod): void {
    setMethod(next);
    setFailure(null);
    // Repasser au choix démonte l'élément de Stripe : l'intention reste ouverte
    // côté prestataire — elle est idempotente et sera rendue à l'identique — mais
    // rien ne doit rester monté dans un panneau qui n'affiche plus la carte.
    setPhase({ kind: 'choix' });
  }

  if (!isSettleable(appointment.status)) {
    return (
      <div className="spa-admin-checkout__payment">
        <Notification tone="warning" title="Rien à encaisser">
          <p>{checkoutBlocker(appointment.status, 'cash')}</p>
        </Notification>
      </div>
    );
  }

  if (phase.kind === 'regle') {
    return (
      <div className="spa-admin-checkout__payment">
        <CheckoutReceipt
          appointment={appointment}
          method={phase.method}
          timeZone={timeZone}
          transaction={phase.transaction}
        />
        <p className="spa-admin-checkout__pci">
          {completionUnavailableMessage(phase.method)}
        </p>
      </div>
    );
  }

  return (
    <div className="spa-admin-checkout__payment">
      <fieldset className="spa-admin-checkout__methods">
        <legend className="spa-admin__section-title">Moyen de paiement</legend>

        {CHECKOUT_METHODS.map((candidate) => {
          const unavailable = checkoutBlocker(appointment.status, candidate);
          const inputId = `moyen-${candidate}`;

          return (
            <div key={candidate}>
              <input
                checked={method === candidate}
                className="spa-admin-checkout__method-input spa-visually-hidden"
                disabled={unavailable !== null || pending}
                id={inputId}
                name="moyen"
                onChange={() => {
                  chooseMethod(candidate);
                }}
                type="radio"
                value={candidate}
              />
              <label className="spa-admin-checkout__method" htmlFor={inputId}>
                <span className="spa-admin-checkout__method-label">{methodLabel(candidate)}</span>
                <span className="spa-admin-checkout__method-hint">
                  {unavailable ?? methodHint(candidate)}
                </span>
              </label>
            </div>
          );
        })}
      </fieldset>

      {failure === null ? null : (
        <p className="spa-field__error" role="alert">
          {failure}
        </p>
      )}

      {blocker !== null ? (
        <Notification tone="warning" title={`${methodLabel(method)} indisponible`}>
          <p>{blocker}</p>
        </Notification>
      ) : method === 'cash' ? (
        <>
          <Button
            block
            loading={pending}
            loadingLabel="Encaissement en cours…"
            onClick={() => void settleInCash()}
            variant="accent"
          >
            Encaisser {formatMoney(due)} en espèces
          </Button>
          <p className="spa-admin-checkout__pci">
            <span aria-hidden="true">🔒</span>
            Aucun appel au prestataire de paiement sur ce chemin : la vente est
            inscrite avec son opérateur et son horodatage, et la caisse fait foi
            au rapprochement.
          </p>
        </>
      ) : phase.kind === 'carte' ? (
        <CheckoutCardForm
          amount={due}
          clientSecret={phase.intent.clientSecret}
          onAccepted={() => {
            setPhase({ kind: 'regle', method: 'card', transaction: null });
          }}
          publishableKey={phase.intent.publishableKey}
        />
      ) : (
        <>
          <Button
            block
            loading={pending}
            loadingLabel="Ouverture du paiement…"
            onClick={() => void openCardPayment()}
            variant="accent"
          >
            Payer {formatMoney(due)} par carte
          </Button>
          <p className="spa-admin-checkout__pci">
            <span aria-hidden="true">🔒</span>
            Les champs de carte sont servis par Stripe : aucun numéro ne se
            saisit ici, ni ne se note ailleurs.
          </p>
        </>
      )}
    </div>
  );
}
