'use client';

import { SUBSCRIPTION_PLAN, type TenantBilling } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import { PLAN_PRICE_LABEL } from '@/lib/plan';

import { openBillingPortalAction, startBillingCheckoutAction } from '../actions';
import { adminCatalogPath, adminDashboardPath } from '../paths';

/**
 * L'écran d'abonnement — ADR 0016.
 *
 * Il dit où en est le salon, et propose **le** geste qui convient : démarrer
 * l'essai (carte enregistrée chez Stripe), gérer l'abonnement (portail Stripe),
 * ou le réactiver. Aucun champ de carte ici : les deux gestes quittent la page
 * pour une page hébergée par Stripe (payments-stripe §1).
 */

export type BillingReturn = 'paiement' | 'annule' | null;

interface StatusCopy {
  readonly tone: NotificationTone;
  readonly title: string;
  readonly body: string;
  readonly action: 'checkout' | 'portal' | null;
  readonly actionLabel: string;
}

const PLAN_PRICE = PLAN_PRICE_LABEL;

const INCLUDED = [
  'Réservation en ligne 24 h/24, sur votre page à votre nom',
  'Confirmations et rappels automatiques par e-mail et SMS',
  'Planning, équipe, fiches clientes et encaissement au comptoir',
  'Suivi du chiffre d’affaires, des rendez-vous et des absences',
] as const;

function statusCopy(billing: TenantBilling, formatDate: (iso: string) => string): StatusCopy {
  switch (billing.status) {
    case 'managed':
      return {
        tone: 'info',
        title: 'Salon accompagné par la plateforme',
        body: 'Votre salon a été ouvert par l’équipe de la plateforme : vous n’avez aucun abonnement à régler ici.',
        action: null,
        actionLabel: '',
      };
    case 'pending':
      return {
        tone: 'warning',
        title: 'Votre essai gratuit n’a pas encore commencé',
        body: `Enregistrez votre carte pour ouvrir votre salon : rien n’est prélevé pendant les ${String(SUBSCRIPTION_PLAN.trialDays)} jours d’essai, et vous pouvez résilier à tout moment. Tant que l’essai n’a pas commencé, votre page de réservation reste fermée.`,
        action: 'checkout',
        actionLabel: 'Démarrer mon essai gratuit',
      };
    case 'trialing':
      return {
        tone: 'success',
        title:
          billing.trialEndsAt === null
            ? 'Essai gratuit en cours'
            : `Essai gratuit jusqu’au ${formatDate(billing.trialEndsAt)}`,
        body: `Votre salon est ouvert. Le premier prélèvement de ${PLAN_PRICE} aura lieu à la fin de l’essai, sauf résiliation d’ici là.`,
        action: 'portal',
        actionLabel: 'Gérer mon abonnement',
      };
    case 'active':
      return {
        tone: 'success',
        title: 'Abonnement actif',
        body:
          billing.currentPeriodEndsAt === null
            ? 'Votre salon est ouvert.'
            : `Votre salon est ouvert. Prochaine échéance le ${formatDate(billing.currentPeriodEndsAt)}.`,
        action: 'portal',
        actionLabel: 'Gérer mon abonnement',
      };
    case 'past_due':
      return {
        tone: 'danger',
        title: 'Le dernier paiement a échoué',
        body: 'Votre salon reste ouvert pendant que le paiement est retenté. Mettez à jour votre carte pour éviter sa fermeture.',
        action: 'portal',
        actionLabel: 'Mettre à jour ma carte',
      };
    case 'canceled':
      return {
        tone: 'danger',
        title: 'Abonnement résilié',
        body: 'Votre salon est fermé : la réservation en ligne et le back-office sont suspendus. Vos prestations, votre équipe et vos fiches clientes sont conservées — tout rouvre dès la réactivation.',
        action: 'checkout',
        actionLabel: 'Réactiver mon abonnement',
      };
  }
}

interface BillingPanelProps {
  readonly tenantSlug: string;
  readonly billing: TenantBilling;
  readonly retour: BillingReturn;
  readonly timeZone: string;
}

export function BillingPanel({ tenantSlug, billing, retour, timeZone }: BillingPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const formatDate = (iso: string): string =>
    new Intl.DateTimeFormat('fr-FR', { timeZone, dateStyle: 'long' }).format(new Date(iso));

  const copy = statusCopy(billing, formatDate);
  const welcome = retour === 'paiement' && billing.status === 'trialing';
  const confirming = retour === 'paiement' && billing.status === 'pending';

  const go = async (): Promise<void> => {
    if (pending || copy.action === null) {
      return;
    }
    setPending(true);
    setFailure(null);

    const result =
      copy.action === 'checkout'
        ? await startBillingCheckoutAction(tenantSlug)
        : await openBillingPortalAction(tenantSlug);

    if (!result.ok) {
      setFailure(result.message);
      setPending(false);
      return;
    }

    // Une page hébergée par Stripe : on la quitte pour de bon, le bouton reste
    // en attente jusqu'au départ.
    window.location.assign(result.data);
  };

  return (
    <div className="spa-billing">
      {welcome ? (
        <Notification tone="success" title="Bienvenue ! Votre salon est ouvert">
          <p>
            Votre essai gratuit de {SUBSCRIPTION_PLAN.trialDays} jours a commencé. Prochaine étape :
            ajoutez vos prestations, pour qu’elles apparaissent sur votre page de réservation.
          </p>
          <div className="spa-billing__next">
            <Link className="spa-button spa-button--accent" href={adminCatalogPath(tenantSlug)}>
              Ajouter mes prestations
            </Link>
            <Link className="spa-button spa-button--neutral" href={adminDashboardPath(tenantSlug)}>
              Voir mon tableau de bord
            </Link>
          </div>
        </Notification>
      ) : null}

      {confirming ? (
        <Notification tone="info" title="Paiement en cours de confirmation">
          <p>Stripe n’a pas encore confirmé l’enregistrement de votre carte. Cela prend quelques secondes.</p>
          <p>
            <Button variant="neutral" onClick={() => router.refresh()}>
              Actualiser
            </Button>
          </p>
        </Notification>
      ) : null}

      {retour === 'annule' && billing.status === 'pending' ? (
        <Notification tone="info" title="Paiement interrompu">
          <p>Aucune carte n’a été enregistrée. Vous pouvez reprendre quand vous voulez.</p>
        </Notification>
      ) : null}

      <div className="spa-billing__grid">
        <div className="spa-admin__section spa-billing__plan">
          <p className="spa-billing__eyebrow">Votre offre</p>
          <h2 className="spa-billing__plan-name">{SUBSCRIPTION_PLAN.name}</h2>
          <p className="spa-billing__price">
            <span className="spa-billing__amount">{PLAN_PRICE}</span>
            <span className="spa-billing__period"> / mois, sans engagement</span>
          </p>
          <ul className="spa-billing__included">
            {INCLUDED.map((item) => (
              <li className="spa-billing__included-item" key={item}>
                <Icon name="check" className="spa-billing__check" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="spa-admin__section spa-billing__status">
          <Notification tone={copy.tone} title={copy.title}>
            <p>{copy.body}</p>
          </Notification>

          {failure === null ? null : (
            <Notification tone="danger" title="Stripe n’a pas pu être ouvert">
              <p>{failure}</p>
            </Notification>
          )}

          {copy.action === null ? null : (
            <Button
              variant={copy.action === 'checkout' ? 'accent' : 'neutral'}
              loading={pending}
              loadingLabel="Ouverture de Stripe…"
              onClick={() => void go()}
            >
              {copy.actionLabel}
            </Button>
          )}

          <p className="spa-billing__secure">
            Paiement sécurisé par Stripe : vos données de carte ne transitent jamais par nos
            serveurs.
          </p>
        </div>
      </div>
    </div>
  );
}
