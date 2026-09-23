'use client';

import type { Locale, Money } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { providerUnreachableMessage } from '@/lib/admin/checkout-summary';
import {
  StripeLoadError,
  loadStripeSdk,
  type StripeConfirmation,
  type StripeElements,
  type StripeLoadReason,
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
 *
 * ## La langue de Stripe, et ce qu'elle ne change pas (#850)
 *
 * La langue courante part à Stripe.js par l'option `locale` de sa fabrique
 * (`lib/admin/payment-stripe.ts`). C'est ce qui fait que les libellés de
 * l'iframe **et** les messages du prestataire — « carte refusée » en tête —
 * s'écrivent dans la langue de l'interface, sans qu'aucun d'eux ne soit recopié
 * dans notre catalogue : les recopier les aurait fait diverger de ce que la
 * cliente voit dans le champ.
 *
 * Le périmètre PCI ne bouge pas d'un pouce : `locale` est une option de rendu,
 * pas un accès aux données de carte. Les champs restent des iframes servies par
 * `js.stripe.com`, et il n'y a toujours **aucun** champ de carte dans ce
 * fichier.
 */
export function CheckoutCardForm({
  amount,
  clientSecret,
  countryCode = null,
  publishableKey,
  onAccepted,
}: {
  readonly amount: Money;
  /** Laissez-passer à usage unique, lié à cette intention et à elle seule. */
  readonly clientSecret: string;
  /** `Tenant.countryCode` — la région de la mise en forme du montant. */
  readonly countryCode?: string | null;
  /** Clé publiable rendue par l'API — jamais une constante de build. */
  readonly publishableKey: string;
  readonly onAccepted: () => void;
}) {
  const t = useTranslations('admin-checkout');
  const locale = useLocale() as Locale;
  const holder = useRef<HTMLDivElement | null>(null);
  const elements = useRef<StripeElements | null>(null);
  const [sdk, setSdk] = useState<StripeSdk | null>(null);
  /**
   * Pourquoi l'élément n'a pas pu être monté — une **raison**, pas une phrase.
   *
   * L'état ne porte pas le message parce que le message a une langue et que
   * l'effet qui le poserait n'en a pas : y lire `t` l'obligerait à figurer dans
   * ses dépendances, et l'élément de Stripe serait démonté puis remonté à chaque
   * rendu où `useTranslations` rend une nouvelle fonction — c'est-à-dire devant
   * la cliente, au milieu d'une saisie de carte.
   */
  const [unavailable, setUnavailable] = useState<StripeLoadReason | 'unknown' | null>(null);
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
        const loaded = await loadStripeSdk(publishableKey, locale);

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

        setUnavailable(error instanceof StripeLoadError ? error.reason : 'unknown');
      }
    }

    void mount();

    return () => {
      cancelled = true;
      element?.destroy();
      elements.current = null;
    };
  }, [clientSecret, locale, publishableKey]);

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
      setRefusal(providerUnreachableMessage(locale));
      setConfirming(false);
      return;
    }

    if (outcome.error !== undefined) {
      // Le message vient de Stripe et ne porte aucune donnée de carte, par
      // construction du prestataire — il est donc affichable tel quel. Il arrive
      // déjà dans la langue de l'interface, `locale` ayant été passée à la
      // fabrique : c'est exactement ce que le troisième critère de #850 demande,
      // et c'est pourquoi il n'est pas remplacé par un texte de notre catalogue.
      setRefusal(outcome.error.message ?? t('card.declined'));
      setConfirming(false);
      return;
    }

    const status = outcome.paymentIntent?.status ?? t('card.unknownStatus');

    // `processing` compte comme accepté : la carte est partie, l'issue arrivera
    // par le webhook comme pour un `succeeded`. Ce qui compte ici est que la
    // cliente puisse partir.
    if (status === 'succeeded' || status === 'processing') {
      onAccepted();
      return;
    }

    setRefusal(t('card.notCompleted', { status }));
    setConfirming(false);
  }

  if (unavailable !== null) {
    return (
      <Notification tone="danger" title={t('card.unavailableTitle')}>
        <p>
          {unavailable === 'script'
            ? t('card.loadFailedScript')
            : unavailable === 'entrypoint'
              ? t('card.loadFailedEntrypoint')
              : t('card.loadFailedUnknown')}
        </p>
        <p>{t('card.cashStillPossible')}</p>
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
        loadingLabel={t('action.confirmCardLoading')}
      >
        {t('action.confirmCard', { amount: formatMoney(amount, { locale, countryCode }) })}
      </Button>

      <p className="spa-admin-checkout__pci">
        <span aria-hidden="true">🔒</span>
        {t('pci.cardForm')}
      </p>
    </form>
  );
}
