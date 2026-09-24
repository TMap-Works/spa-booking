'use client';

import type { Appointment, Locale, SaleReceipt } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { receiptDisclaimer } from '@/lib/admin/checkout-summary';
import type { PaymentTransaction } from '@/lib/admin/payment-contract';
import { formatMoney, type DisplayLocale } from '@/lib/format';

import { loadReceiptAction } from '../encaissement/actions';
import { adminReceiptPdfPath } from '../paths';
import { ReceiptTicket } from './receipt-ticket';
import { TicketPrinter } from './ticket-printer';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

/**
 * Le ticket remis à la cliente — cinquième critère de #59, repris par #835.
 *
 * ## Le ticket, et non la page
 *
 * Ce qui s'imprime est le **ticket de caisse** de la vente que l'encaissement
 * vient de solder, tel que l'API le compose (`GET /sales/{id}/receipt`, #818) :
 * identité légale du salon, numéro de pièce, client, praticien, articles, total
 * HT, TVA par taux, et **tous les règlements** de la pièce. `ReceiptTicket` le
 * met en page comme un rouleau de 80 mm, et `TicketPrinter` l'imprime seul. Les
 * deux PDF de l'API — rouleau 80 mm et facture A4 — s'ouvrent à côté.
 *
 * C'est ce qui porte le quatrième critère de #835 : un ticket de 78,00 € réglé
 * par 50,00 € d'espèces puis 28,00 € au terminal imprime ses **deux** lignes de
 * règlement, avec le montant reçu et la monnaie rendue quand il y en a. L'écran
 * n'en compose aucune — il met en page ce que la pièce dit.
 *
 * ## Il n'y a plus de reçu provisoire — ADR 0015
 *
 * Le comptoir n'appelle plus aucun prestataire : espèces comme TPE, le règlement
 * est inscrit `SUCCEEDED` avec son opérateur et son horodatage au moment où
 * l'API répond. Le reçu est donc définitif quand il s'imprime, et le reçu réduit
 * « en attente de confirmation » n'a plus de cas d'emploi. Ce qui reste, et que
 * la mention sous le bandeau dit, est que le règlement au terminal est une
 * **déclaration d'opérateur** : l'écart se constate au rapprochement, contre le
 * relevé que le terminal imprime.
 *
 * ## Ce qu'il ne portera jamais
 *
 * **Aucune donnée de carte** : ni marque, ni quatre derniers chiffres, ni
 * référence de porteur. Le domaine n'en a pas la notion et le schéma de lecture
 * ne les déclare pas (payments-stripe §1). Le numéro du ticket du terminal n'en
 * est pas une : c'est un identifiant opaque émis par la banque du salon, du même
 * rang qu'un `pi_…`, et c'est par lui que le rapprochement retrouve l'opération.
 */
export function CheckoutReceipt({
  appointment,
  countryCode = null,
  saleId,
  tenantSlug,
  transaction,
}: {
  readonly appointment: Appointment;
  /** `Tenant.countryCode` — la région de la mise en forme, jamais le fuseau. */
  readonly countryCode?: string | null;
  /** La pièce à relire et à imprimer — celle que le règlement vient de solder. */
  readonly saleId: string;
  readonly tenantSlug: string;
  /** Le dernier encaissement inscrit, pour le bandeau — `null` si inconnu. */
  readonly transaction: PaymentTransaction | null;
}) {
  const t = useTranslations('admin-checkout');
  const locale = useLocale() as Locale;
  const display: DisplayLocale = { locale, countryCode };
  // Le montant annoncé au-dessus du ticket est celui de la **pièce** quand on le
  // connaît, et celui du rendez-vous à défaut : le prix figé à la réservation
  // n'est pas le total du ticket dès qu'une ligne s'y ajoute (#817).
  const announced = transaction?.amount ?? appointment.price;

  return (
    <section aria-labelledby="recu-titre" className="spa-admin-checkout__ticket">
      <Notification
        tone="success"
        title={t('receipt.recordedTitle', { amount: formatMoney(announced, display) })}
      >
        <p>{receiptDisclaimer(locale)}</p>
      </Notification>

      <h2 className="spa-admin__section-title" id="recu-titre">
        {t('receipt.heading')}
      </h2>

      <SaleTicket countryCode={countryCode} saleId={saleId} tenantSlug={tenantSlug} />
    </section>
  );
}

type TicketState =
  | { readonly kind: 'chargement' }
  | { readonly kind: 'pret'; readonly receipt: SaleReceipt }
  /**
   * `message` est celui que l'**API** a rendu — c'est elle qui nomme son refus
   * (web-frontend §2). `null` dit « le serveur n'a pas répondu du tout » : il n'y
   * a alors aucun message à reprendre, et c'est l'écran qui le dit, donc le
   * catalogue. Porter la phrase ici aurait obligé l'effet à lire `t`, donc à le
   * déclarer en dépendance, donc à relancer la lecture du ticket à chaque rendu.
   */
  | { readonly kind: 'echec'; readonly message: string | null };

/**
 * Le ticket de caisse d'une vente : relu de l'API, affiché en aperçu,
 * imprimable seul, et ouvrable en PDF (rouleau 80 mm ou facture A4).
 */
function SaleTicket({
  countryCode,
  saleId,
  tenantSlug,
}: {
  /** `Tenant.countryCode` — la région de la mise en forme du rouleau. */
  readonly countryCode: string | null;
  readonly saleId: string;
  readonly tenantSlug: string;
}) {
  const t = useTranslations('admin-checkout');
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
          setState({ kind: 'echec', message: null });
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
        <span className="spa-button__label">{t('receipt.pdfTicket')}</span>
      </a>
      <a
        className="spa-button spa-button--neutral"
        href={adminReceiptPdfPath(tenantSlug, saleId, 'a4')}
        rel="noopener"
        target="_blank"
      >
        <span className="spa-button__label">{t('receipt.pdfInvoice')}</span>
      </a>
    </>
  );

  if (state.kind === 'chargement') {
    return (
      <p aria-live="polite" className="spa-admin-checkout__pci" role="status">
        {t('receipt.loading')}
      </p>
    );
  }

  if (state.kind === 'echec') {
    return (
      <>
        <Notification tone="warning" title={t('receipt.unavailableTitle')}>
          <p>{state.message ?? t('receipt.loadFailed')}</p>
        </Notification>
        <div className="spa-ticket-actions">
          <Button
            onClick={() => {
              setAttempt((count) => count + 1);
            }}
            variant="accent"
          >
            {t('receipt.retry')}
          </Button>
          {pdfLinks}
        </div>
      </>
    );
  }

  return (
    <>
      <ReceiptTicket countryCode={countryCode} receipt={state.receipt} />
      <div className="spa-ticket-actions">
        <TicketPrinter>
          <ReceiptTicket countryCode={countryCode} receipt={state.receipt} />
        </TicketPrinter>
        {pdfLinks}
      </div>
    </>
  );
}
