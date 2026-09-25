'use client';

import type {
  Appointment,
  CounterSettlementMean,
  Locale,
  Money,
  SaleSettlement,
  SettleSaleRequest,
  TimeZone,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  COUNTER_MEANS,
  checkoutBlocker,
  checkoutFailureMessage,
  completionUnavailableMessage,
  firstSettlementCeiling,
  isAlreadySettledRefusal,
  isSettleable,
  meanHint,
  meanLabel,
  methodLabel,
  methodOfMean,
  methodPhrase,
  priceDriftOf,
  providerUnreachableMessage,
  terminalReferenceField,
  terminalReferenceIssue,
  terminalReferenceRefusal,
  type SettlementState,
} from '@/lib/admin/checkout-summary';
import type { PaymentTransaction, SaleSummary } from '@/lib/admin/payment-contract';
import {
  formatDateTimeInTimeZone,
  formatMoney,
  parseAmountInput,
  type DisplayLocale,
} from '@/lib/format';

import type { AdminActionResult } from '../action-result';
import { openCheckoutTicketAction, settleTicketAction } from '../encaissement/actions';
import { CheckoutReceipt } from './checkout-receipt';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

/**
 * Le panneau d'encaissement d'un rendez-vous — #59, repris par #835.
 *
 * ## Ce qui a changé, et pourquoi ce n'est pas un détail d'écran
 *
 * Le comptoir ne monte plus **aucun** formulaire de carte. La carte se règle sur
 * le **TPE autonome** de la banque du salon — celui qu'il possède déjà, qui n'est
 * pas relié à l'application et auquel l'application ne parle pas —, et ce
 * panneau n'enregistre que l'issue que le caissier déclare : le moyen, le
 * montant, l'opérateur, l'horodatage, et le numéro du ticket du terminal s'il
 * l'a relevé (ADR 0015, `payments-stripe` §4).
 *
 * La conséquence est une **frontière PCI vraie partout** : il n'existe plus une
 * seule page servie par nous où un numéro de carte pourrait se saisir, pas même
 * dans une iframe. `tests/admin-mockups.test.mjs` refuse par exécution tout champ
 * qui y ressemblerait.
 *
 * Contrepartie, dite par l'ADR et par le reçu : un règlement au terminal est une
 * **déclaration d'opérateur**, comme l'est déjà l'encaissement en espèces. Rien
 * ne prouve côté serveur que le terminal a autorisé l'opération ; l'écart se
 * constate au rapprochement, contre le relevé que le terminal imprime.
 *
 * ## Le ticket, et non plus le rendez-vous
 *
 * Régler passe désormais par `POST /v1/sales/{saleId}/payments`, qui inscrit
 * **un** encaissement sur une pièce comptable. C'est ce qui rend le règlement
 * mixte possible : un ticket de 78,00 € se solde par 50,00 € d'espèces puis
 * 28,00 € au terminal, et le reste dû décroît sous le contrôle du serveur,
 * relu sous verrou à chaque appel.
 *
 * Le ticket est composé au **premier règlement**, jamais à l'affichage : ouvrir
 * l'écran d'un rendez-vous ne doit laisser aucune pièce derrière soi. Celui qui
 * existe déjà est retrouvé par la page (`readAppointmentTicket`) et passé en
 * prop, pour qu'un rafraîchissement au milieu d'un règlement mixte retrouve son
 * reste dû au lieu d'ouvrir un second ticket.
 *
 * ## Aucune arithmétique monétaire ici
 *
 * `total`, `settled`, `remaining` et `change` viennent tous du serveur. Le seul
 * montant que ce panneau **compose** est celui que l'opérateur tape — une part,
 * ou ce que la cliente a tendu —, et il passe par `parseAmountInput`, qui
 * n'emploie aucun flottant et refuse une saisie plus précise que la devise.
 *
 * Il reçoit le **contexte d'affichage**, comme `formatMoney` juste au-dessus de
 * lui (#1123) : l'opérateur d'un comptoir anglais lit « €1,200.00 » dans la pile
 * des totaux, et ce qu'il recopie dans « Montant remis » doit se relire. Sans lui,
 * la virgule de milliers de l'anglais faisait refuser un montant que l'écran
 * venait d'afficher.
 *
 * ## Le double clic, et la clé d'idempotence
 *
 * Deux protections, et elles ne font pas doublon. Côté écran, `Button` se
 * désactive dès que `pending` est posé (web-frontend §3). Côté API, la clé
 * `Idempotency-Key` est **obligatoire** sur cette route : rejouée, elle rend le
 * règlement déjà inscrit sans rien écrire, et `replayed` vaut `true`.
 *
 * La clé est engendrée **au montage du geste**, pas au clic : engendrée au clic,
 * un double clic porterait deux clés et inscrirait deux règlements de 28,00 € —
 * ce que rien, côté serveur, ne pourrait distinguer de deux gestes volontaires.
 * Elle est renouvelée après chaque règlement abouti, parce que le règlement
 * suivant est un autre geste.
 *
 * ## La langue (#850)
 *
 * Les mots viennent de `useTranslations('admin-checkout')` ; ceux que
 * `lib/admin/checkout-summary.ts` compose — un moyen fermé, un refus de l'API —
 * reçoivent la langue en paramètre, ce module n'ayant aucun crochet à sa
 * disposition. Les deux lisent **le même catalogue**. Le `countryCode` ne donne
 * que la région de la mise en forme, et `formatMoney` reste le seul point où la
 * langue touche un chiffre.
 */
type Phase =
  | { readonly kind: 'choix' }
  /** Le montant est annoncé, la carte passe sur le terminal, l'issue se déclare. */
  | { readonly kind: 'tpe' }
  /** Le ticket est soldé : le reçu prend toute la place. */
  | { readonly kind: 'regle'; readonly saleId: string }
  /** Le refus 409 : la pièce est déjà soldée, et ce n'est pas par ce geste-ci. */
  | { readonly kind: 'deja-regle'; readonly message: string };

/**
 * Une clé d'idempotence neuve — 32 caractères hexadécimaux tirés au sort.
 *
 * `getRandomValues` plutôt que `randomUUID` : le second n'est servi que sur une
 * origine sûre, et ce panneau tourne aussi en HTTP sur un poste de comptoir.
 * Une clé qui vaudrait `undefined` là-bas ferait tomber chaque règlement sur le
 * 400 de l'en-tête manquant — et la panne n'apparaîtrait qu'en salon.
 *
 * Trente-deux caractères tiennent largement dans les bornes de l'API (8 à 128),
 * et seize octets d'entropie rendent la collision entre deux postes hors de
 * question — ce qui compte, puisque l'unicité est **par ticket**.
 */
function newGestureKey(): string {
  const bytes = new Uint8Array(16);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function CheckoutPanel({
  appointment,
  countryCode = null,
  settlement = null,
  ticket = null,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: Appointment;
  /** `Tenant.countryCode` — la région de la mise en forme, jamais le fuseau. */
  readonly countryCode?: string | null;
  /**
   * L'état de règlement lu avec la journée — `null` quand l'historique n'a pas
   * répondu, ce qui n'est **pas** la même chose que « rien n'est réglé ».
   */
  readonly settlement?: SettlementState | null;
  /**
   * Le ticket de caisse déjà ouvert sur ce rendez-vous, s'il y en a un. `null`
   * veut dire « aucun, ou lecture indisponible » : le premier règlement refait
   * la recherche côté serveur avant d'écrire, si bien que le pire cas est une
   * lecture de plus, jamais un ticket de trop.
   */
  readonly ticket?: SaleSummary | null;
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
}) {
  const t = useTranslations('admin-checkout');
  const locale = useLocale() as Locale;
  const display: DisplayLocale = { locale, countryCode };

  const [sale, setSale] = useState<SaleSummary | null>(ticket);
  const [phase, setPhase] = useState<Phase>({ kind: 'choix' });
  const [mean, setMean] = useState<CounterSettlementMean>('CASH');
  const [partial, setPartial] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [tenderedText, setTenderedText] = useState('');
  const [reference, setReference] = useState('');
  const [fieldIssue, setFieldIssue] = useState<{
    readonly field: 'amount' | 'tendered' | 'reference';
    readonly message: string;
  } | null>(null);
  /** Les règlements inscrits **par ce poste**, dans l'ordre où ils ont été pris. */
  const [taken, setTaken] = useState<readonly PaymentTransaction[]>([]);
  const [change, setChange] = useState<Money | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reprinting, setReprinting] = useState(false);
  const [gestureKey, setGestureKey] = useState(newGestureKey);
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);

  /**
   * Ce qu'il reste à prendre : le ticket fait foi dès qu'il existe.
   *
   * Tant qu'il n'existe pas, ce n'est **pas** le prix figé à la réservation mais
   * le plafond de ce que le ticket pourra porter (#1240, deuxième critère).
   * `POST /v1/sales` relit le tarif **au catalogue** : sur une prestation dont le
   * prix a baissé depuis la réservation, envoyer le prix figé ne pouvait
   * qu'échouer en `422 SALE_OVERPAYMENT` — un refus rouge devant la cliente pour
   * une raison qui n'était pas du fait de l'opérateur. Voir
   * `firstSettlementCeiling`, qui dit aussi pourquoi le plafond ne joue que dans
   * ce sens-là.
   */
  const outstanding: Money = sale?.remaining ?? firstSettlementCeiling(appointment);
  const currency = outstanding.currency;
  /**
   * L'état de règlement lu avec la journée, **corrigé par le ticket**.
   *
   * `settlementOf` rapproche les encaissements du jour sur `appointmentId` et
   * conclut « réglé » dès qu'une ligne aboutie s'y rattache. C'était juste tant
   * qu'un rendez-vous ne portait qu'**un** encaissement ; depuis le règlement
   * mixte (#817, #835), une part de 50,00 € sur un ticket de 78,00 € en inscrit
   * une — et `payments.appointment_id` s'y résout par la vente
   * (`payments.repository.ts`). Sans cette correction, un rechargement d'écran
   * entre les deux gestes rendait les 28,00 € restants **inatteignables** : le
   * panneau basculait sur « Réglé en espèces — 50,00 € » et n'offrait plus
   * qu'une réimpression.
   *
   * Le ticket tranche, parce qu'il est la pièce : tant qu'il reste un centime
   * dû, il n'y a rien de soldé. Les deux autres états — intention en ligne en
   * vol ou en échec — ne sont pas touchés : ils ferment le comptoir quel que
   * soit le reste dû.
   *
   * La correction rend désormais l'état que #1240 a nommé — `partiel` — au lieu
   * de retomber sur « rien n'est réglé ». Les deux ouvrent le comptoir de la
   * même façon, mais le second effaçait de l'écran un fait que l'opérateur a
   * besoin de lire : une part **a** été prise. La pile de totaux juste en
   * dessous la montre, et le panneau ne la contredit plus.
   */
  const known: SettlementState =
    settlement === null
      ? { kind: 'du' }
      : settlement.kind === 'regle' && sale !== null && sale.remaining.amountMinor > 0
        ? { kind: 'partiel', payment: settlement.payment, ticket: sale }
        : settlement;
  const blocker = checkoutBlocker(appointment.status, known, locale);

  /** Le montant de **ce** règlement — `null` quand la saisie est illisible. */
  function plannedAmount(): Money | null {
    return partial ? parseAmountInput(amountText, currency, display) : outstanding;
  }

  /**
   * Ce que le corps portera, ou le champ fautif.
   *
   * Le front borne pour le confort, l'API pour la sécurité (web-frontend §4) :
   * ces trois refus évitent un aller-retour et un 400 devant la cliente, ils ne
   * remplacent aucun contrôle du serveur.
   */
  function composeRequest():
    | { readonly ok: true; readonly body: SettleSaleRequest }
    | { readonly ok: false; readonly field: 'amount' | 'tendered' | 'reference'; readonly message: string } {
    const amount = plannedAmount();

    if (amount === null || amount.amountMinor <= 0) {
      return { ok: false, field: 'amount', message: t('amount.invalid') };
    }

    if (amount.amountMinor > outstanding.amountMinor) {
      return {
        ok: false,
        field: 'amount',
        message: t('amount.tooHigh', { amount: formatMoney(outstanding, display) }),
      };
    }

    if (mean === 'CARD_TERMINAL') {
      const issue = terminalReferenceIssue(reference, locale);

      if (issue !== null) {
        return { ok: false, field: 'reference', message: issue };
      }

      return {
        ok: true,
        body: {
          method: 'CARD_TERMINAL',
          amountMinor: amount.amountMinor,
          ...terminalReferenceField(reference),
        },
      };
    }

    // Le billet tendu n'existe pas en règlement partiel : le champ n'y est pas
    // offert, et une valeur qui y aurait survécu à une case cochée ne doit pas
    // se glisser dans le corps.
    const tenderable = !partial && tenderedText.trim() !== '';
    const tendered = tenderable ? parseAmountInput(tenderedText, currency, display) : null;

    if (tenderable && tendered === null) {
      return { ok: false, field: 'tendered', message: t('amount.invalid') };
    }

    if (tendered !== null && tendered.amountMinor < amount.amountMinor) {
      return {
        ok: false,
        field: 'tendered',
        message: t('amount.tenderedTooLow', { amount: formatMoney(amount, display) }),
      };
    }

    // Les deux montants **s'excluent** côté API (`settleSaleRequestSchema`,
    // `settlement.rules.ts`) : désigner une part et tendre un billet seraient
    // deux instructions pour un seul geste, et rien ne dirait laquelle
    // l'emporte. Les envoyer ensemble rendait un 400 « La requête est invalide »
    // que seule la recette a vu — les tests unitaires exerçaient un double de
    // l'action serveur, qui acceptait tout.
    //
    // Quand la cliente tend un billet, c'est **lui** qui commande : le serveur
    // applique le reste dû, rend la différence en monnaie, et le front n'a
    // aucun montant à soustraire. C'est pourquoi le champ « Montant remis »
    // n'est offert que hors règlement partiel, où la part est désignée à la
    // place.
    if (tendered !== null) {
      return { ok: true, body: { method: 'CASH', tenderedAmountMinor: tendered.amountMinor } };
    }

    return { ok: true, body: { method: 'CASH', amountMinor: amount.amountMinor } };
  }

  /**
   * Pose à l'écran ce qu'un refus veut dire — `true` s'il est traité.
   *
   * Une session à renouveler n'est pas un échec d'encaissement : rien n'a été
   * réglé, et l'écran revient tel quel une fois la session rouverte. « Déjà
   * soldé » n'est pas davantage une erreur de saisie qu'on corrige en
   * recliquant : c'est un état du ticket, et l'écran le **devient** plutôt que
   * d'afficher une ligne rouge sous un bouton resté actif (#828, #1005).
   *
   * Un refus de **saisie**, lui, retourne à la saisie. Le 400 qui nomme
   * `terminalReference` — une référence bien formée mais qui porte une clé de
   * Luhn, donc refusée par l'API et par elle seule — se pose sur le champ,
   * jamais en bloc sous le bouton : c'est là que l'opérateur corrigera, et le
   * message générique de la validation ne lui aurait pas dit lequel des champs
   * reprendre (troisième critère de #1025, `web-frontend` §4).
   */
  function explainFailure(result: AdminActionResult<unknown>): void {
    if (result.ok || renewIfExpired(result)) {
      return;
    }

    const refused = terminalReferenceRefusal(result.code, result.details, locale);

    if (refused !== null) {
      setFieldIssue({ field: 'reference', message: refused });
      return;
    }

    const explained = checkoutFailureMessage(result.code, result.message, locale);

    if (isAlreadySettledRefusal(result.code)) {
      setPhase({ kind: 'deja-regle', message: explained });
      return;
    }

    setFailure(explained);
  }

  /**
   * Enregistre le règlement en cours — le seul chemin d'écriture de cet écran.
   *
   * Deux appels au plus : composer le ticket s'il n'existe pas encore, puis y
   * inscrire le règlement. Le premier ne se refait jamais — le ticket composé
   * est retenu dans l'état, et c'est ce qui permet au second règlement d'un
   * mixte de viser la même pièce.
   *
   * Le `finally` n'est pas une précaution de style : une action serveur ne rend
   * un résultat que si elle **aboutit**. Si l'appel lui-même échoue — le réseau
   * du poste tombe entre le clic et le POST —, la promesse est rejetée, et sans
   * lui `pending` resterait vrai : bouton grisé, roue qui tourne, aucune
   * explication, et plus rien à faire qu'un rechargement devant la cliente.
   */
  async function settle(): Promise<void> {
    const composed = composeRequest();

    if (!composed.ok) {
      setFieldIssue({ field: composed.field, message: composed.message });
      return;
    }

    setPending(true);
    setFailure(null);
    setFieldIssue(null);

    try {
      let target = sale;

      if (target === null) {
        const opened = await openCheckoutTicketAction(
          tenantSlug,
          appointment.id,
          appointment.service.id,
        );

        if (!opened.ok) {
          explainFailure(opened);
          return;
        }

        target = opened.data;
        setSale(opened.data);
      }

      const result = await settleTicketAction(
        tenantSlug,
        target.id,
        composed.body,
        gestureKey,
      );

      if (!result.ok) {
        explainFailure(result);
        return;
      }

      applySettlement(result.data);
    } catch {
      // L'action n'a pas répondu du tout : rien n'a été encaissé, et le message
      // le dit plutôt que de laisser le comptoir deviner.
      setFailure(providerUnreachableMessage(locale));
    } finally {
      setPending(false);
    }
  }

  /** Ce que l'écran devient une fois le règlement inscrit. */
  function applySettlement(result: SaleSettlement): void {
    setSale((current) =>
      current === null
        ? current
        : {
            ...current,
            settled: result.settled,
            remaining: result.remaining,
            settledAt: result.settledAt,
          },
    );
    setTaken((current) => [...current, result.payment]);
    setChange(result.change.amountMinor > 0 ? result.change : null);
    setReplayed(result.replayed);
    setAmountText('');
    setTenderedText('');
    setReference('');
    setPartial(false);
    // Le geste suivant est un autre geste : sa clé ne peut pas être celle-ci,
    // sans quoi il serait rendu comme une répétition du précédent.
    setGestureKey(newGestureKey());

    if (result.remaining.amountMinor === 0) {
      setPhase({ kind: 'regle', saleId: result.saleId });
      // La journée de caisse vient de changer, et c'est le serveur qui la rend :
      // sans cette relecture, le récapitulatif d'à côté réclamerait encore la
      // somme que ce ticket déclare encaissée (#1004).
      router.refresh();
      return;
    }

    setPhase({ kind: 'choix' });
  }

  function chooseMean(next: CounterSettlementMean): void {
    setMean(next);
    setFailure(null);
    setFieldIssue(null);
    setPhase({ kind: 'choix' });
  }

  if (!isSettleable(appointment.status)) {
    return (
      <div className="spa-admin-checkout__payment">
        <Notification tone="warning" title={t('blocker.nothingToSettleTitle')}>
          <p>{checkoutBlocker(appointment.status, { kind: 'du' }, locale)}</p>
        </Notification>
      </div>
    );
  }

  // Le ticket que **ce poste** vient de solder passe en premier, avant même ce
  // que l'historique en dit (#1004) : ici la pièce, déjà à l'écran, prête à
  // imprimer ; plus bas un bouton « Réimprimer le ticket ». Laisser le second
  // l'emporter escamoterait le reçu au moment précis où l'opérateur le tend.
  if (phase.kind === 'regle') {
    return (
      <div className="spa-admin-checkout__payment">
        {change === null ? null : (
          <AmountCallout amount={change} display={display} label={t('amount.changeTitle')} />
        )}
        <CheckoutReceipt
          appointment={appointment}
          countryCode={countryCode}
          saleId={phase.saleId}
          tenantSlug={tenantSlug}
          transaction={taken.at(-1) ?? null}
        />
        <p className="spa-admin-checkout__pci">{completionUnavailableMessage(locale)}</p>
      </div>
    );
  }

  // L'état de règlement passe **avant** toute action : un rendez-vous réglé
  // n'ouvre aucun moyen de paiement, et n'en montre aucun. C'est ce que le CDC
  // §1.4 attend d'une vente déjà inscrite — elle se consulte et se réimprime.
  if (known.kind === 'regle') {
    // Le règlement **entier** part à `methodPhrase`, et non son seul `method`
    // (#1245) : ce bandeau relit la pièce préexistante du rendez-vous, tunnel en
    // ligne compris, et c'est `cardChannel` qui nomme le tuyau à rapprocher.
    // Contrairement à la liste des règlements pris à ce poste, il peut donc
    // porter une carte Stripe — qu'annoncer « TPE » enverrait chercher sur le
    // relevé du terminal.
    const { payment } = known;
    const refunded = payment.refunded.amountMinor > 0;
    const settledAt = payment.capturedAt ?? payment.createdAt;

    return (
      <div className="spa-admin-checkout__payment">
        <Notification
          tone={refunded ? 'info' : 'success'}
          title={t('settlement.title', {
            method: methodPhrase(payment, locale),
            amount: formatMoney(payment.amount, display),
          })}
        >
          <p>
            {t('settlement.recordedAt', {
              date: formatDateTimeInTimeZone(settledAt, timeZone, display),
            })}
            {refunded
              ? t('settlement.refundedPart', {
                  amount: formatMoney(payment.refunded, display),
                })
              : t('settlement.nothingLeft')}
          </p>
        </Notification>

        {/* Le bouton n'existe que s'il y a une pièce à relire. Un encaissement
          * inscrit avant #817 n'en porte pas (`saleId` nul), et le proposer
          * quand même donnait un bouton qui ne faisait **rien** : le clic
          * posait `reprinting`, la garde retombait sur le même bouton, et
          * l'opérateur recliquait devant sa cliente. */}
        {payment.saleId == null ? null : reprinting ? (
          <CheckoutReceipt
            appointment={appointment}
            countryCode={countryCode}
            saleId={payment.saleId}
            tenantSlug={tenantSlug}
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
            {t('settlement.reprint')}
          </Button>
        )}
      </div>
    );
  }

  if (phase.kind === 'deja-regle') {
    return (
      <div className="spa-admin-checkout__payment">
        <Notification tone="warning" title={t('settlement.alreadySettledTitle')}>
          <p>{phase.message}</p>
        </Notification>
      </div>
    );
  }

  const planned = plannedAmount();
  const shown = planned ?? outstanding;
  /**
   * L'écart de tarif, s'il y en a un — **avant** le clic autant qu'après
   * (#1240).
   *
   * Il ne se voyait que sur un ticket déjà composé. Or c'est au **premier**
   * règlement qu'il compte : c'est là que la caisse relit le catalogue, et là que
   * l'opérateur s'apprête à annoncer un montant à voix haute. `priceDriftOf`
   * répond dans les deux cas, en nommant celui qui s'applique.
   */
  const drift = priceDriftOf(appointment, sale);

  return (
    <div className="spa-admin-checkout__payment">
      {sale === null ? null : (
        <div className="spa-admin-checkout__totals">
          <div className="spa-admin-checkout__total-row">
            <span className="spa-admin-checkout__total-label">{t('ticket.totalLabel')}</span>
            <span className="spa-admin-checkout__total-value">
              {formatMoney(sale.total, display)}
            </span>
          </div>
          <div className="spa-admin-checkout__total-row">
            <span className="spa-admin-checkout__total-label">{t('ticket.settledLabel')}</span>
            <span className="spa-admin-checkout__total-value">
              {formatMoney(sale.settled, display)}
            </span>
          </div>
          <div className="spa-admin-checkout__total-row spa-admin-checkout__total-row--grand">
            <span className="spa-admin-checkout__total-label">{t('ticket.remainingLabel')}</span>
            <span className="spa-admin-checkout__total-value">
              {formatMoney(sale.remaining, display)}
            </span>
          </div>
        </div>
      )}

      {drift === null ? null : (
        <p className="spa-admin-checkout__pci" role="status">
          {drift.kind === 'ticket'
            ? t('ticket.priceDrift', {
                ticket: formatMoney(drift.charged, display),
                booked: formatMoney(drift.booked, display),
              })
            : t('ticket.priceDriftAhead', {
                catalogue: formatMoney(drift.charged, display),
                booked: formatMoney(drift.booked, display),
                // Ce qui sera **pris**, et non ce que le catalogue dit : les deux
                // diffèrent dès que le catalogue a monté, cas où la cliente ne
                // doit que ce qu'elle a accepté (`firstSettlementCeiling`).
                charged: formatMoney(outstanding, display),
              })}
        </p>
      )}

      {taken.length === 0 ? null : (
        <div className="spa-admin-checkout__totals">
          <p className="spa-admin__section-title">{t('ticket.settlementsTitle')}</p>
          {/* La liste porte son propre nom : le titre au-dessus est un
            * paragraphe, pas un en-tête, et un lecteur d'écran qui atterrit sur
            * la liste seule n'aurait rien pour la situer. */}
          <ul
            aria-label={t('ticket.settlementsCaption')}
            className="spa-admin-checkout__settlements"
          >
            {taken.map((payment) => (
              <li className="spa-admin-checkout__total-row" key={payment.id}>
                <span className="spa-admin-checkout__total-label">
                  {methodLabel(payment.method, locale)}
                  {payment.terminalReference == null
                    ? ''
                    : ` — ${t('ticket.settlementReference', {
                        reference: payment.terminalReference,
                      })}`}
                </span>
                <span className="spa-admin-checkout__total-value">
                  {formatMoney(payment.amount, display)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {change === null ? null : (
        <AmountCallout amount={change} display={display} label={t('amount.changeTitle')} />
      )}

      {replayed ? (
        <p className="spa-admin-checkout__pci" role="status">
          {t('ticket.replayed')}
        </p>
      ) : null}

      {blocker !== null ? (
        <Notification
          tone="warning"
          title={t('method.unavailableTitle', { method: meanLabel(mean, locale) })}
        >
          <p>{blocker}</p>
        </Notification>
      ) : phase.kind === 'tpe' ? (
        <>
          <AmountCallout
            amount={shown}
            display={display}
            label={t('terminal.instructionTitle')}
          />
          <p className="spa-admin-checkout__terminal">{t('terminal.instructionBody')}</p>

          {/* Le seul champ de saisie libre de cet écran, et il ne porte pas de
            * donnée de carte : c'est le numéro d'**opération** que le terminal
            * imprime, celui par lequel le rapprochement retrouve la ligne chez
            * la banque du salon. Facultatif — bloquer la caisse dessus serait un
            * refus de service —, borné en forme ici et refusé en 400 par l'API
            * s'il ressemble à un numéro de carte. */}
          <div className="spa-field">
            <label className="spa-field__label" htmlFor="tpe-reference">
              {t('terminal.referenceLabel')}
            </label>
            <input
              aria-describedby={
                fieldIssue?.field === 'reference' ? 'tpe-reference-erreur' : 'tpe-reference-aide'
              }
              aria-invalid={fieldIssue?.field === 'reference'}
              autoComplete="off"
              className="spa-field__control"
              id="tpe-reference"
              inputMode="text"
              maxLength={32}
              name="tpe-reference"
              onChange={(event) => {
                setReference(event.target.value);
                setFieldIssue(null);
              }}
              type="text"
              value={reference}
            />
            {fieldIssue?.field === 'reference' ? (
              <p className="spa-field__error" id="tpe-reference-erreur" role="alert">
                {fieldIssue.message}
              </p>
            ) : (
              <p className="spa-field__hint" id="tpe-reference-aide">
                {t('terminal.referenceHint')}
              </p>
            )}
          </div>

          {failure === null ? null : (
            <p className="spa-field__error" role="alert">
              {failure}
            </p>
          )}

          <Button
            block
            loading={pending}
            loadingLabel={t('action.settleTerminalLoading')}
            onClick={() => void settle()}
            variant="accent"
          >
            {t('terminal.accept')}
          </Button>
          {/* « Refusé » ne s'enregistre pas : rien n'est parti chez nous, il n'y
            * a donc rien à inscrire ni à annuler. L'écran revient au choix du
            * moyen, et la cliente paie autrement. */}
          <Button
            block
            disabled={pending}
            onClick={() => {
              setReference('');
              setFieldIssue(null);
              setFailure(t('terminal.declinedNotice'));
              setPhase({ kind: 'choix' });
            }}
            variant="neutral"
          >
            {t('terminal.decline')}
          </Button>
          <p className="spa-admin-checkout__pci">
            <span aria-hidden="true">🔒</span>
            {t('pci.card')}
          </p>
        </>
      ) : (
        <>
          <fieldset className="spa-admin-checkout__methods">
            <legend className="spa-admin__section-title">{t('method.legend')}</legend>

            {COUNTER_MEANS.map((candidate) => {
              const inputId = `moyen-${methodOfMean(candidate)}`;

              return (
                <div key={candidate}>
                  <input
                    checked={mean === candidate}
                    className="spa-admin-checkout__method-input spa-visually-hidden"
                    disabled={pending}
                    id={inputId}
                    name="moyen"
                    onChange={() => {
                      chooseMean(candidate);
                    }}
                    type="radio"
                    value={candidate}
                  />
                  <label className="spa-admin-checkout__method" htmlFor={inputId}>
                    <span className="spa-admin-checkout__method-label">
                      {meanLabel(candidate, locale)}
                    </span>
                    <span className="spa-admin-checkout__method-hint">
                      {meanHint(candidate, locale)}
                    </span>
                  </label>
                </div>
              );
            })}
          </fieldset>

          <div className="spa-field">
            <label className="spa-field__label" htmlFor="reglement-partiel">
              <input
                checked={partial}
                disabled={pending}
                id="reglement-partiel"
                name="reglement-partiel"
                onChange={(event) => {
                  setPartial(event.target.checked);
                  // Le champ part **vide** : pré-remplir avec le reste dû ferait
                  // d'un clic de trop un règlement intégral déguisé en partiel,
                  // et c'est le geste que ce mode existe précisément pour éviter.
                  setAmountText('');
                  // Le billet tendu et la part désignée s'excluent (l'API refuse
                  // les deux ensemble) : basculer en partiel oublie le billet
                  // plutôt que de le garder en réserve d'un 400.
                  setTenderedText('');
                  setFieldIssue(null);
                }}
                type="checkbox"
              />{' '}
              {t('amount.partialToggle')}
            </label>
            <p className="spa-field__hint" id="reglement-partiel-aide">
              {t('amount.partialHint')}
            </p>
          </div>

          {partial ? (
            <div className="spa-field">
              <label className="spa-field__label" htmlFor="montant-regle">
                {t('amount.partialLabel')}
              </label>
              <input
                aria-describedby={fieldIssue?.field === 'amount' ? 'montant-regle-erreur' : undefined}
                aria-invalid={fieldIssue?.field === 'amount'}
                autoComplete="off"
                className="spa-field__control"
                id="montant-regle"
                inputMode="decimal"
                name="montant-regle"
                onChange={(event) => {
                  setAmountText(event.target.value);
                  setFieldIssue(null);
                }}
                type="text"
                value={amountText}
              />
              {fieldIssue?.field === 'amount' ? (
                <p className="spa-field__error" id="montant-regle-erreur" role="alert">
                  {fieldIssue.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Le billet tendu ne se demande qu'en règlement **intégral** : en
            * partiel, c'est la part qui est désignée, et l'API refuse les deux
            * instructions à la fois. */}
          {mean === 'CASH' && !partial ? (
            <div className="spa-field">
              <label className="spa-field__label" htmlFor="montant-remis">
                {t('amount.tenderedLabel')}
              </label>
              <input
                aria-describedby={
                  fieldIssue?.field === 'tendered' ? 'montant-remis-erreur' : 'montant-remis-aide'
                }
                aria-invalid={fieldIssue?.field === 'tendered'}
                autoComplete="off"
                className="spa-field__control"
                id="montant-remis"
                inputMode="decimal"
                name="montant-remis"
                onChange={(event) => {
                  setTenderedText(event.target.value);
                  setFieldIssue(null);
                }}
                type="text"
                value={tenderedText}
              />
              {fieldIssue?.field === 'tendered' ? (
                <p className="spa-field__error" id="montant-remis-erreur" role="alert">
                  {fieldIssue.message}
                </p>
              ) : (
                <p className="spa-field__hint" id="montant-remis-aide">
                  {t('amount.tenderedHint')}
                </p>
              )}
            </div>
          ) : null}

          {failure === null ? null : (
            <p className="spa-field__error" role="alert">
              {failure}
            </p>
          )}

          {mean === 'CASH' ? (
            <>
              <Button
                block
                loading={pending}
                loadingLabel={t('action.settleCashLoading')}
                onClick={() => void settle()}
                variant="accent"
              >
                {t('action.settleCash', { amount: formatMoney(shown, display) })}
              </Button>
              <p className="spa-admin-checkout__pci">
                <span aria-hidden="true">🔒</span>
                {t('pci.cash')}
              </p>
            </>
          ) : (
            <>
              <Button
                block
                disabled={pending}
                onClick={() => {
                  const composed = composeRequest();

                  if (!composed.ok) {
                    setFieldIssue({ field: composed.field, message: composed.message });
                    return;
                  }

                  setFailure(null);
                  setPhase({ kind: 'tpe' });
                }}
                variant="accent"
              >
                {t('action.settleTerminal', { amount: formatMoney(shown, display) })}
              </Button>
              <p className="spa-admin-checkout__pci">
                <span aria-hidden="true">🔒</span>
                {t('pci.card')}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * La monnaie à rendue, en grand — troisième critère de #835.
 *
 * Le montant est **calculé par le serveur** : `change` vient de l'enveloppe de
 * règlement, et le front ne soustrait jamais deux montants. C'est le chiffre que
 * l'opérateur compte dans sa main devant la cliente, et il n'a pas à le chercher
 * dans une ligne de tableau.
 */
function AmountCallout({
  amount,
  display,
  label,
}: {
  readonly amount: Money;
  readonly display: DisplayLocale;
  readonly label: string;
}) {
  return (
    <div className="spa-admin-checkout__callout" role="status">
      <span className="spa-admin-checkout__callout-label">{label}</span>
      <span className="spa-admin-checkout__callout-amount">{formatMoney(amount, display)}</span>
    </div>
  );
}
