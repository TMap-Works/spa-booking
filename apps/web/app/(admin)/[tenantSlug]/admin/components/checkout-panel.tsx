'use client';

import type { Appointment, PaymentMethod, TimeZone } from '@spa/shared';
import { useRouter } from 'next/navigation';
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
  isAlreadySettledRefusal,
  isSettleable,
  methodHint,
  methodLabel,
  methodPhrase,
  type SettlementState,
} from '@/lib/admin/checkout-summary';
import type { AppointmentPaymentIntent, PaymentTransaction } from '@/lib/admin/payment-contract';
import { formatDateTimeInTimeZone, formatMoney } from '@/lib/format';

import type { AdminActionResult } from '../action-result';
import { openCardPaymentAction, settleInCashAction } from '../encaissement/actions';
import { CheckoutCardForm } from './checkout-card-form';
import { CheckoutReceipt } from './checkout-receipt';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

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
 *
 * ## L'encaissement déjà inscrit, connu **avant** le clic (#828)
 *
 * `settlement` porte ce que la journée de caisse dit de ce rendez-vous. Réglé,
 * le panneau n'offre plus aucun encaissement : il annonce le règlement et
 * propose d'en réimprimer le ticket. C'est le sens du critère `ds:etats` — un
 * état de l'écran, pas un refus qui tombe après coup.
 *
 * Le 409 reste en place et reste le filet, pour les deux cas que la lecture ne
 * couvre pas : un compte `STAFF`, à qui `GET /payments` répond 403, et la course
 * contre le poste d'à côté. Mais il fait désormais **basculer l'écran** au lieu
 * d'afficher une ligne rouge sous un bouton resté actif — un second clic ne
 * pouvait qu'échouer de la même façon.
 *
 * ## Le récapitulatif d'à côté suit, au lieu de rester à « À encaisser » (#1004)
 *
 * `settlement` est une **donnée du serveur** : elle est lue par la page, qui est
 * un Server Component, et ce panneau ne peut pas la réécrire. Tant que rien ne
 * redemandait ce rendu, l'écran se contredisait d'une moitié à l'autre — « À
 * encaisser 65,00 € » à gauche pendant que le reçu annonçait « Encaissement
 * enregistré — 65,00 € » à droite. Ce n'est pas un affichage qui traîne : sans
 * rechargement complet, il ne se corrigeait jamais.
 *
 * `router.refresh()` rejoue donc le segment serveur quand le règlement en
 * espèces **aboutit** — la journée de caisse est relue, `settlement` revient à
 * `regle`, et le récapitulatif bascule sur « Réglé » dans le même écran que le
 * reçu. Il enveloppe déjà son travail dans une transition et ne remonte pas ce
 * composant : ni `useTransition` à poser, ni état d'attente à rendre — le reçu
 * est affiché avant l'appel et le reste pendant.
 *
 * **Rien de tel sur le chemin carte**, et ce n'est pas un oubli. Ni l'ouverture
 * de l'intention ni l'acceptation par Stripe n'inscrivent quoi que ce soit chez
 * nous : c'est le webhook signé qui le fait, plus tard (payments-stripe §2).
 * Relire la journée à l'acceptation ne ramènerait qu'une intention `pending`, et
 * le récapitulatif dirait toujours « À encaisser » — ce qui est alors la vérité,
 * et non la contradiction que ce ticket corrige : le reçu d'en face s'annonce
 * lui-même provisoire, « pas de capture confirmée ».
 *
 * Ce que ce rafraîchissement **ne doit pas** faire, c'est emporter le ticket
 * qu'on vient de produire. L'état local le rend, il survit au rafraîchissement
 * (l'App Router réconcilie sans remonter), et c'est pourquoi `phase` est
 * examinée **avant** `settlement` plus bas : sinon le reçu cédait la place à un
 * bouton « Réimprimer le ticket », et l'opérateur devait recliquer pour
 * retrouver ce qu'il avait sous les yeux.
 */
type Phase =
  | { readonly kind: 'choix' }
  | { readonly kind: 'carte'; readonly intent: AppointmentPaymentIntent }
  | {
      readonly kind: 'regle';
      readonly method: PaymentMethod;
      readonly transaction: PaymentTransaction | null;
    }
  /** Le refus 409 : un encaissement existe déjà, et il n'est pas celui-ci. */
  | { readonly kind: 'deja-regle'; readonly message: string };

export function CheckoutPanel({
  appointment,
  settlement = null,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: Appointment;
  /**
   * L'état de règlement lu avec la journée — `null` quand l'historique n'a pas
   * répondu, ce qui n'est **pas** la même chose que « rien n'est réglé ».
   */
  readonly settlement?: SettlementState | null;
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
}) {
  const due = amountDue(appointment);
  const known: SettlementState = settlement ?? { kind: 'du' };
  // Le moyen présélectionné est le premier qui soit **ouvert**, et non les
  // espèces par principe : sur une intention carte en cours, les espèces sont
  // refusées en 409, et ouvrir l'écran sur une case grisée ferait chercher la
  // panne. L'ordre reste celui de `CHECKOUT_METHODS`, donc les espèces d'abord
  // dans le cas ordinaire.
  const [method, setMethod] = useState<PaymentMethod>(
    () =>
      CHECKOUT_METHODS.find(
        (candidate) => checkoutBlocker(appointment.status, candidate, known) === null,
      ) ?? 'cash',
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'choix' });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reprinting, setReprinting] = useState(false);
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);

  const blocker = checkoutBlocker(appointment.status, method, known);

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

      // Une session à renouveler n'est pas un échec d'encaissement : rien n'a
      // été réglé, et l'écran revient tel quel une fois la session rouverte.
      // Ce test passe **avant** la lecture du refus : une session expirée n'est
      // pas un état du rendez-vous, et la traduire en message le laisserait
      // croire.
      if (renewIfExpired(result)) {
        return;
      }

      const explained = checkoutFailureMessage(result.code, result.message);

      // « Déjà encaissé » n'est pas une erreur de saisie qu'on corrige en
      // recliquant : c'est un état du rendez-vous, et l'écran le devient.
      if (isAlreadySettledRefusal(result.code)) {
        setPhase({ kind: 'deja-regle', message: explained });
        return;
      }

      setFailure(explained);
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
        // La journée de caisse vient de changer, et c'est le serveur qui la
        // rend : sans cette relecture, le récapitulatif d'à côté réclamerait
        // encore la somme que ce reçu déclare encaissée (#1004).
        router.refresh();
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

  // Le règlement que **ce poste** vient d'obtenir passe en premier, avant même
  // ce que l'historique en dit (#1004). Les deux décrivent alors le même
  // encaissement — c'est ce rafraîchissement-ci qui l'a fait apparaître dans
  // l'historique —, mais ils n'en montrent pas la même chose : ici le ticket,
  // déjà à l'écran, prêt à imprimer ; plus bas un bouton « Réimprimer le
  // ticket ». Laisser le second l'emporter aurait escamoté le reçu au moment
  // précis où l'opérateur le tend à sa cliente.
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

  // L'état de règlement passe **avant** toute action : un rendez-vous réglé
  // n'ouvre aucun moyen de paiement, et n'en montre aucun. C'est ce que le CDC
  // §1.4 attend d'une vente déjà inscrite — elle se consulte et se réimprime.
  if (known.kind === 'regle') {
    const { payment } = known;
    const refunded = payment.refunded.amountMinor > 0;
    const settledAt = payment.capturedAt ?? payment.createdAt;

    return (
      <div className="spa-admin-checkout__payment">
        <Notification
          tone={refunded ? 'info' : 'success'}
          title={`Réglé ${methodPhrase(payment.method)} — ${formatMoney(payment.amount)}`}
        >
          <p>
            Encaissement inscrit le {formatDateTimeInTimeZone(settledAt, timeZone)}.
            {refunded
              ? ` Dont ${formatMoney(payment.refunded)} remboursés.`
              : ' Il n’y a plus rien à encaisser sur ce rendez-vous.'}
          </p>
        </Notification>

        {reprinting ? (
          <CheckoutReceipt
            appointment={appointment}
            method={payment.method}
            settled
            timeZone={timeZone}
            transaction={payment}
          />
        ) : (
          <Button
            block
            onClick={() => {
              setReprinting(true);
            }}
            variant="neutral"
          >
            Réimprimer le ticket
          </Button>
        )}
      </div>
    );
  }

  if (phase.kind === 'deja-regle') {
    return (
      <div className="spa-admin-checkout__payment">
        <Notification tone="warning" title="Rendez-vous déjà encaissé">
          <p>{phase.message}</p>
        </Notification>
      </div>
    );
  }

  return (
    <div className="spa-admin-checkout__payment">
      <fieldset className="spa-admin-checkout__methods">
        <legend className="spa-admin__section-title">Moyen de paiement</legend>

        {CHECKOUT_METHODS.map((candidate) => {
          const unavailable = checkoutBlocker(appointment.status, candidate, known);
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
