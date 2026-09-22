'use client';

import { ERROR_CODES, SUBSCRIPTION_PLAN, type Locale, type TenantBilling } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import { formattingLocale } from '@/lib/format';
import { planPriceLabel } from '@/lib/plan';

import { openBillingPortalAction, startBillingCheckoutAction } from '../actions';
import { adminCatalogPath, adminDashboardPath } from '../paths';

/**
 * L'écran d'abonnement — ADR 0016.
 *
 * Il dit où en est le salon, et propose **le** geste qui convient : démarrer
 * l'essai (carte enregistrée chez Stripe), gérer l'abonnement (portail Stripe),
 * ou le réactiver. Aucun champ de carte ici : les deux gestes quittent la page
 * pour une page hébergée par Stripe (payments-stripe §1).
 *
 * ## La langue (#1105)
 *
 * Les libellés viennent du namespace `admin-subscription`. Ce qui reste écrit
 * ici est la correspondance entre un statut de facturation et le ton, le geste
 * et la clé de message qui lui répondent — c'est-à-dire la règle, pas le texte.
 *
 * Les **dates d'échéance** suivent la langue lue et la région du salon, comme
 * partout ailleurs : le fuseau reste celui de l'établissement, quelle que soit
 * la langue (`CLAUDE.md`). L'étiquette `Intl` est celle de `lib/format.ts`
 * (`formattingLocale`) plutôt qu'une seconde règle de région écrite ici, qui
 * aurait pu diverger de celle du reste du produit.
 *
 * Le **prix** vient de `lib/plan.ts` : un entier dans la plus petite unité de sa
 * devise, mis en forme dans la langue lue. Ce que le catalogue porte est la
 * phrase autour, jamais le montant.
 */

export type BillingReturn = 'paiement' | 'annule' | null;

/** Ce que chaque statut appelle à l'écran — le ton, le geste, rien du texte. */
interface StatusShape {
  readonly tone: NotificationTone;
  readonly action: 'checkout' | 'portal' | null;
  /** La clé du libellé du bouton — `null` quand le statut n'en propose aucun. */
  readonly actionKey:
    | 'status.pending.action'
    | 'status.trialing.action'
    | 'status.active.action'
    | 'status.past_due.action'
    | 'status.canceled.action'
    | null;
}

const STATUS_SHAPES: Readonly<Record<TenantBilling['status'], StatusShape>> = {
  managed: { tone: 'info', action: null, actionKey: null },
  pending: { tone: 'warning', action: 'checkout', actionKey: 'status.pending.action' },
  trialing: { tone: 'success', action: 'portal', actionKey: 'status.trialing.action' },
  active: { tone: 'success', action: 'portal', actionKey: 'status.active.action' },
  past_due: { tone: 'danger', action: 'portal', actionKey: 'status.past_due.action' },
  canceled: { tone: 'danger', action: 'checkout', actionKey: 'status.canceled.action' },
};

/** Les quatre promesses de l'offre, dans l'ordre où elles se lisent. */
const INCLUDED = ['booking', 'reminders', 'backOffice', 'reporting'] as const;

/** Les clés d'erreur du catalogue, telles que `t()` les accepte. */
type RedirectErrorKey =
  | 'redirect.errors.notApplicable'
  | 'redirect.errors.accountMissing'
  | 'redirect.errors.unavailable'
  | 'redirect.errors.session'
  | 'redirect.errors.unexpected';

/**
 * Ce que devient à l'écran un refus d'ouvrir Stripe, dans la langue lue.
 *
 * Le front trie sur le **code** et non sur le message (web-frontend §2) : le
 * message d'un refus est écrit côté serveur, donc en français, et l'afficher tel
 * quel rendrait un back-office anglais bilingue à la première panne. Il reste le
 * repli d'un code que cette table ne connaît pas — mieux vaut un message dans la
 * mauvaise langue qu'un encart vide.
 */
const REDIRECT_ERROR_KEYS: Readonly<Record<string, RedirectErrorKey>> = {
  [ERROR_CODES.BILLING_NOT_APPLICABLE]: 'redirect.errors.notApplicable',
  [ERROR_CODES.BILLING_ACCOUNT_MISSING]: 'redirect.errors.accountMissing',
  [ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE]: 'redirect.errors.unavailable',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'redirect.errors.unavailable',
  [ERROR_CODES.UNAUTHORIZED]: 'redirect.errors.session',
  [ERROR_CODES.INTERNAL_ERROR]: 'redirect.errors.unexpected',
};

interface BillingPanelProps {
  readonly tenantSlug: string;
  readonly billing: TenantBilling;
  readonly retour: BillingReturn;
  readonly timeZone: string;
  /**
   * Le pays de l'établissement (`Tenant.countryCode`), quand il a publié une
   * adresse — la **région** de mise en forme des dates. Absent, le repli figé de
   * `lib/format.ts` s'applique.
   */
  readonly countryCode: string | null;
}

export function BillingPanel({
  tenantSlug,
  billing,
  retour,
  timeZone,
  countryCode,
}: BillingPanelProps) {
  const t = useTranslations('admin-subscription');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const price = planPriceLabel({ locale, countryCode });
  const intlTag = formattingLocale(locale, countryCode);
  const formatDate = (iso: string): string =>
    new Intl.DateTimeFormat(intlTag, { timeZone, dateStyle: 'long' }).format(new Date(iso));

  const shape = STATUS_SHAPES[billing.status];

  /**
   * Le titre et le corps du statut courant.
   *
   * Défini ici, au plus près de `t` : deux statuts changent de phrase selon
   * qu'une date est connue ou non — un essai sans fin annoncée, un abonnement
   * sans prochaine échéance —, et c'est une clé différente, non une
   * concaténation.
   */
  const statusCopy = (): { readonly title: string; readonly body: string } => {
    switch (billing.status) {
      case 'managed':
        return { title: t('status.managed.title'), body: t('status.managed.body') };
      case 'pending':
        return {
          title: t('status.pending.title'),
          body: t('status.pending.body', { days: SUBSCRIPTION_PLAN.trialDays }),
        };
      case 'trialing':
        return {
          title:
            billing.trialEndsAt === null
              ? t('status.trialing.title')
              : t('status.trialing.titleUntil', { date: formatDate(billing.trialEndsAt) }),
          body: t('status.trialing.body', { price }),
        };
      case 'active':
        return {
          title: t('status.active.title'),
          body:
            billing.currentPeriodEndsAt === null
              ? t('status.active.body')
              : t('status.active.bodyUntil', { date: formatDate(billing.currentPeriodEndsAt) }),
        };
      case 'past_due':
        return { title: t('status.past_due.title'), body: t('status.past_due.body') };
      case 'canceled':
        return { title: t('status.canceled.title'), body: t('status.canceled.body') };
    }
  };

  const copy = statusCopy();
  const welcome = retour === 'paiement' && billing.status === 'trialing';
  const confirming = retour === 'paiement' && billing.status === 'pending';

  const go = async (): Promise<void> => {
    if (pending || shape.action === null) {
      return;
    }
    setPending(true);
    setFailure(null);

    const result =
      shape.action === 'checkout'
        ? await startBillingCheckoutAction(tenantSlug)
        : await openBillingPortalAction(tenantSlug);

    if (!result.ok) {
      const key = REDIRECT_ERROR_KEYS[result.code];

      setFailure(key === undefined ? result.message : t(key));
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
        <Notification tone="success" title={t('return.welcome.title')}>
          <p>{t('return.welcome.body', { days: SUBSCRIPTION_PLAN.trialDays })}</p>
          <div className="spa-billing__next">
            <Link className="spa-button spa-button--accent" href={adminCatalogPath(tenantSlug)}>
              {t('return.welcome.catalog')}
            </Link>
            <Link className="spa-button spa-button--neutral" href={adminDashboardPath(tenantSlug)}>
              {t('return.welcome.dashboard')}
            </Link>
          </div>
        </Notification>
      ) : null}

      {confirming ? (
        <Notification tone="info" title={t('return.confirming.title')}>
          <p>{t('return.confirming.body')}</p>
          <p>
            <Button variant="neutral" onClick={() => router.refresh()}>
              {t('return.confirming.refresh')}
            </Button>
          </p>
        </Notification>
      ) : null}

      {retour === 'annule' && billing.status === 'pending' ? (
        <Notification tone="info" title={t('return.canceled.title')}>
          <p>{t('return.canceled.body')}</p>
        </Notification>
      ) : null}

      <div className="spa-billing__grid">
        <div className="spa-admin__section spa-billing__plan">
          <p className="spa-billing__eyebrow">{t('plan.eyebrow')}</p>
          <h2 className="spa-billing__plan-name">{SUBSCRIPTION_PLAN.name}</h2>
          <p className="spa-billing__price">
            <span className="spa-billing__amount">{price}</span>
            <span className="spa-billing__period">{t('plan.period')}</span>
          </p>
          <ul className="spa-billing__included">
            {INCLUDED.map((item) => (
              <li className="spa-billing__included-item" key={item}>
                <Icon name="check" className="spa-billing__check" />
                {t(`plan.included.${item}` as 'plan.included.booking')}
              </li>
            ))}
          </ul>
        </div>

        <div className="spa-admin__section spa-billing__status">
          <Notification tone={shape.tone} title={copy.title}>
            <p>{copy.body}</p>
          </Notification>

          {failure === null ? null : (
            <Notification tone="danger" title={t('redirect.failureTitle')}>
              <p>{failure}</p>
            </Notification>
          )}

          {shape.action === null || shape.actionKey === null ? null : (
            <Button
              variant={shape.action === 'checkout' ? 'accent' : 'neutral'}
              loading={pending}
              loadingLabel={t('redirect.loading')}
              onClick={() => void go()}
            >
              {t(shape.actionKey)}
            </Button>
          )}

          <p className="spa-billing__secure">{t('secure')}</p>
        </div>
      </div>
    </div>
  );
}
