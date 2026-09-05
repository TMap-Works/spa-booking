'use client';

import type { Money } from '@spa/shared';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { PROVIDER_UNREACHABLE_MESSAGE } from '@/lib/admin/checkout-summary';
import {
  loadStripeSdk,
  type StripeConfirmation,
  type StripeElements,
  type StripePaymentElement,
  type StripeSdk,
} from '@/lib/admin/payment-stripe';
import { formatMoney } from '@/lib/format';

/**
 * Le paiement par carte au comptoir — troisième critère de #59.
 *
 * ## Il n'y a aucun champ de carte dans ce fichier, et il n'y en aura jamais
 *
 * Le `<div>` ci-dessous est un **conteneur vide** : ce que Stripe y monte est
 * une iframe servie par `js.stripe.com`, dans laquelle la cliente saisit son
 * numéro. Notre JavaScript ne peut pas la lire — c'est la politique d'origine du
 * navigateur qui l'en empêche, pas notre discipline —, et la confirmation part
 * du navigateur **directement** chez Stripe, sans passer par notre API. Aucun
 * numéro, aucun cryptogramme, aucune date d'expiration n'atteint donc notre
 * code, nos journaux ou notre base : c'est exactement ce qui maintient le projet
 * en auto-évaluation PCI SAQ A (payments-stripe §1).
 *
 * Un champ `<input>` maison pour un numéro de carte — fût-il « juste pour le
 * lecteur du comptoir » — ferait basculer l'obligation en SAQ D, avec un audit
 * annuel. C'est la seule ligne de ce ticket qui ne se négocie pas.
 *
 * ## Ce que ce composant ne conclut pas
 *
 * Rien. Une confirmation acceptée signifie que Stripe a autorisé le paiement,
 * pas que notre encaissement est inscrit : cela, seul le webhook signé le fait,
 * côté serveur (payments-stripe §2). `onAccepted` dit donc « le prestataire a
 * accepté », et l'écran d'appel en tire un reçu explicitement provisoire.
 */
export function CheckoutCardForm({
  amount,
  clientSecret,
  publishableKey,
  onAccepted,
}: {
  readonly amount: Money;
  /** Laissez-passer à usage unique, lié à cette intention et à elle seule. */
  readonly clientSecret: string;
  /** Clé publiable rendue par l'API — jamais une constante de build. */
  readonly publishableKey: string;
  readonly onAccepted: () => void;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const elements = useRef<StripeElements | null>(null);
  const [sdk, setSdk] = useState<StripeSdk | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    // Le démontage peut arriver avant la fin du chargement — l'opérateur repasse
    // aux espèces pendant que le script arrive. Sans ce garde, on écrirait dans
    // l'état d'un composant démonté et on monterait l'élément dans un nœud
    // détaché.
    let cancelled = false;
    let element: StripePaymentElement | null = null;

    // Une intention neuve repart d'un état neuf. Sans cette remise à zéro, le
    // `sdk` de la précédente survivrait au démontage de son élément — que le
    // nettoyage ci-dessous vient d'oublier — et le bouton, actif parce que
    // `sdk !== null`, ne confirmerait rien du tout : `confirm()` sortirait sur
    // `elements.current === null`, sans message ni roue.
    setSdk(null);
    setUnavailable(null);
    setRefusal(null);

    async function mount(): Promise<void> {
      try {
        const loaded = await loadStripeSdk(publishableKey);

        if (cancelled) {
          return;
        }

        const group = loaded.elements({ clientSecret });
        const target = holder.current;

        if (target === null) {
          return;
        }

        element = group.create('payment');
        element.mount(target);
        elements.current = group;
        setSdk(loaded);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setUnavailable(
          error instanceof Error
            ? error.message
            : 'Le module de paiement n’a pas pu être chargé.',
        );
      }
    }

    void mount();

    return () => {
      cancelled = true;
      element?.destroy();
      elements.current = null;
    };
  }, [clientSecret, publishableKey]);

  async function confirm(): Promise<void> {
    const group = elements.current;

    if (sdk === null || group === null) {
      return;
    }

    setConfirming(true);
    setRefusal(null);

    let outcome: StripeConfirmation;
    try {
      // `redirect: 'if_required'` : l'authentification forte se joue dans la
      // fenêtre de Stripe et l'appel revient ici. Le comptoir ne quitte pas son
      // écran, et il n'y a pas d'URL de retour à tenir à jour.
      outcome = await sdk.confirmPayment({ elements: group, redirect: 'if_required' });
    } catch {
      setRefusal(PROVIDER_UNREACHABLE_MESSAGE);
      setConfirming(false);
      return;
    }

    if (outcome.error !== undefined) {
      // Le message vient de Stripe et ne porte aucune donnée de carte, par
      // construction du prestataire — il est donc affichable tel quel.
      setRefusal(outcome.error.message ?? 'Le paiement a été refusé.');
      setConfirming(false);
      return;
    }

    const status = outcome.paymentIntent?.status ?? 'inconnu';

    // `processing` compte comme accepté : la carte est partie, l'issue arrivera
    // par le webhook comme pour un `succeeded`. Ce qui compte ici est que la
    // cliente puisse partir.
    if (status === 'succeeded' || status === 'processing') {
      onAccepted();
      return;
    }

    setRefusal(
      `Le paiement n’a pas abouti (état « ${status} »). Rien n’a été débité : réessayez, ou encaissez en espèces.`,
    );
    setConfirming(false);
  }

  if (unavailable !== null) {
    return (
      <Notification tone="danger" title="Paiement par carte indisponible">
        <p>{unavailable}</p>
        <p>Le règlement en espèces reste possible.</p>
      </Notification>
    );
  }

  return (
    <form
      aria-busy={confirming}
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      {/*
       * Le conteneur de l'iframe de Stripe. Il est vide dans notre arbre, et
       * c'est le propos : rien de ce qui s'y saisit n'appartient à notre DOM.
       */}
      <div data-testid="stripe-payment-element" ref={holder} />

      {refusal === null ? null : (
        <p className="spa-field__error" role="alert">
          {refusal}
        </p>
      )}

      <Button
        block
        variant="accent"
        type="submit"
        disabled={sdk === null}
        loading={confirming}
        loadingLabel="Paiement en cours…"
      >
        Encaisser {formatMoney(amount)} par carte
      </Button>

      <p className="spa-admin-checkout__pci">
        <span aria-hidden="true">🔒</span>
        Les champs de carte sont servis par Stripe : aucun numéro ne se saisit
        ailleurs, ne se note ailleurs, ni ne transite par le salon ou par nos
        serveurs.
      </p>
    </form>
  );
}
