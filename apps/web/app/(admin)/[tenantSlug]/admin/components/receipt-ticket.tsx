'use client';

import type { Locale, SaleReceipt } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Fragment } from 'react';

import {
  formatReceiptPhone,
  issuerAddressLines,
  legalIdLine,
  settlementLabel,
  soldLines,
  taxTableRows,
} from '@/lib/admin/receipt-ticket';
import { formatMoney, formatTicketDateTime, type DisplayLocale } from '@/lib/format';

/**
 * Le ticket de caisse, mis en page comme un rouleau thermique de 80 mm.
 *
 * ## Ce qu'il porte
 *
 * Ce qu'un ticket de grande surface porte, et ce qu'une note de prestation de
 * services doit porter : l'enseigne et la raison sociale, l'adresse, les
 * identifiants légaux (SIRET ou NIF/STAT, numéro de TVA), le numéro de pièce
 * et l'horodatage, le **nom du client**, le praticien, chaque article avec sa
 * quantité et son prix, le total **HT**, la **TVA** par taux, le total **TTC**,
 * le moyen de règlement avec la monnaie rendue, les avoirs, et le pied de ticket
 * du salon.
 *
 * ## Ce qu'il ne porte pas
 *
 * Aucune donnée de carte — ni marque, ni quatre derniers chiffres : le contrat
 * du reçu n'en a pas la notion (payments-stripe §1). Et aucun montant calculé
 * ici : tout vient de `GET /sales/{id}/receipt`, figé à la clôture de la vente.
 *
 * Un composant de présentation pur : il s'affiche en aperçu dans l'écran
 * d'encaissement et s'imprime tel quel — voir `TicketPrinter`.
 *
 * ## Dans la langue de la session — #1248
 *
 * Tous les mots du rouleau viennent du catalogue `admin-checkout`, aucun n'est
 * écrit ici. Le produit sert l'**anglais par défaut** depuis
 * l'internationalisation : un salon dont la session est en anglais tendait à sa
 * cliente une pièce comptable en français, et treize clés du catalogue que
 * personne ne lisait n'étaient relues, ni corrigées, ni traduites par personne.
 *
 * `useTranslations` et non `getTranslations`, malgré l'absence de `'use
 * client'` dans le fichier d'origine : ce composant **n'est pas** un Server
 * Component. Son seul consommateur, `checkout-receipt.tsx`, porte `'use
 * client'` et l'importe directement — le rouleau est donc compilé dans le
 * *bundle* client, où `next-intl/server` lève « not supported in Client
 * Components ». La directive est posée en tête pour que la frontière soit lue
 * sur le fichier plutôt que déduite de son importateur (web-frontend §1).
 *
 * ## La langue ne touche pas aux chiffres
 *
 * Aucun montant, aucune date et aucun numéro de pièce ne change de **valeur**
 * avec la langue : les montants restent les entiers que l'API a figés, les
 * instants restent en UTC, et le fuseau d'affichage reste celui du salon
 * (`receipt.timezone`). Seule leur **mise en forme** suit la langue, et elle
 * passe par `lib/format.ts` — jamais par un `toLocaleString` posé ici
 * (`CLAUDE.md`).
 *
 * La région de cette mise en forme est celle du **pays de l'établissement**,
 * `Tenant.countryCode` — la même que celle dont se sert tout le reste du
 * comptoir, et que `CheckoutReceipt` tient déjà de sa page. Elle est donc
 * **passée**, comme aux autres briques du comptoir.
 *
 * L'adresse de la pièce ne sert que de repli : elle porte bien le même pays
 * (`toIssuerDto`, `apps/api`), mais l'API **omet l'adresse entière** tant que la
 * rue, la ville et le pays ne sont pas tous les trois renseignés. Un salon
 * malgache qui n'a pas publié sa rue retomberait alors sur la région par défaut
 * de la langue — et daterait son rouleau « 09/05/2026 » à l'américaine sous un
 * bandeau qui dit « 05/09/2026 ».
 */
export function ReceiptTicket({
  countryCode = null,
  receipt,
}: {
  /** `Tenant.countryCode` — la région de la mise en forme, jamais le fuseau. */
  readonly countryCode?: string | null;
  readonly receipt: SaleReceipt;
}) {
  const t = useTranslations('admin-checkout');
  const locale = useLocale() as Locale;
  const { issuer } = receipt;
  const display: DisplayLocale = { locale, countryCode: countryCode ?? issuer.address?.country };
  const legalId = legalIdLine(issuer, locale);
  const contacts = [
    issuer.contactPhone === undefined ? undefined : formatReceiptPhone(issuer.contactPhone),
    issuer.contactEmail,
  ].filter((value): value is string => value !== undefined);
  const lines = soldLines(receipt.lines);
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0);
  const taxes = taxTableRows(receipt.taxBreakdown, display);
  const taxed = taxes.length > 0;
  const issuedAt = receipt.issuedAt ?? receipt.openedAt;
  // Le nom du document, et le seul : il coiffe le rouleau à l'écran et donne
  // son nom accessible à la région. Deux formulations différentes pour la même
  // pièce feraient annoncer au lecteur d'écran autre chose que ce qui est
  // imprimé.
  const documentTitle =
    receipt.number === null
      ? t('receipt.provisionalTitle')
      : t('receipt.finalTitle', { number: receipt.number });

  return (
    <article aria-label={documentTitle} className="spa-ticket">
      <header className="spa-ticket__header">
        <p className="spa-ticket__brand">{issuer.name}</p>
        {issuer.legalName !== undefined && issuer.legalName !== issuer.name ? (
          <p>{issuer.legalName}</p>
        ) : null}
        {issuerAddressLines(issuer).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {contacts.length > 0 ? <p>{contacts.join(' · ')}</p> : null}
        {legalId === null ? null : <p>{legalId}</p>}
        {issuer.vatNumber === undefined ? null : (
          <p>{t('receipt.vatNumber', { number: issuer.vatNumber })}</p>
        )}
      </header>

      <hr className="spa-ticket__rule" />

      <div className="spa-ticket__identity">
        <p className="spa-ticket__title">{documentTitle}</p>
        {receipt.number === null ? (
          <p className="spa-ticket__note">{t('receipt.provisionalNote')}</p>
        ) : null}
        <p>{formatTicketDateTime(issuedAt, receipt.timezone, display)}</p>
      </div>

      <hr className="spa-ticket__rule" />

      <dl className="spa-ticket__rows">
        {receipt.client === null ? null : (
          <div className="spa-ticket__row">
            <dt>{t('receipt.client')}</dt>
            <dd>{receipt.client.displayName}</dd>
          </div>
        )}
        {receipt.practitioner === null ? null : (
          <div className="spa-ticket__row">
            <dt>{t('receipt.staff')}</dt>
            <dd>{receipt.practitioner.displayName}</dd>
          </div>
        )}
        <div className="spa-ticket__row">
          <dt>{t('receipt.cashier')}</dt>
          <dd>{receipt.cashier.displayName}</dd>
        </div>
      </dl>

      <hr className="spa-ticket__rule" />

      <table className="spa-ticket__items">
        <caption className="spa-visually-hidden">{t('receipt.linesCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('receipt.item')}</th>
            <th className="spa-ticket__num" scope="col">
              {t('receipt.quantity')}
            </th>
            <th className="spa-ticket__num" scope="col">
              {t('receipt.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.position}>
              <td>
                {line.label}
                {line.quantity === 1 ? null : (
                  <span className="spa-ticket__detail">
                    {line.quantity} × {formatMoney(line.unitPrice, display)}
                  </span>
                )}
              </td>
              <td className="spa-ticket__num">{line.quantity}</td>
              <td className="spa-ticket__num">{formatMoney(line.total, display)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* L'accord se décide dans le catalogue, par une forme plurielle ICU : le
          pluriel n'a pas les mêmes règles d'une langue à l'autre, et un « s »
          concaténé ici les fixerait sur celles du français. */}
      <p className="spa-ticket__count">{t('receipt.itemCount', { count: itemCount })}</p>

      <hr className="spa-ticket__rule spa-ticket__rule--dashed" />

      <dl className="spa-ticket__rows">
        {taxed ? (
          <>
            <div className="spa-ticket__row">
              <dt>{t('receipt.subtotal')}</dt>
              <dd>{formatMoney(receipt.subtotal, display)}</dd>
            </div>
            <div className="spa-ticket__row">
              <dt>{t('receipt.tax')}</dt>
              <dd>{formatMoney(receipt.taxTotal, display)}</dd>
            </div>
          </>
        ) : null}
        {receipt.tip.amountMinor === 0 ? null : (
          <div className="spa-ticket__row">
            <dt>{t('receipt.tip')}</dt>
            <dd>{formatMoney(receipt.tip, display)}</dd>
          </div>
        )}
        <div className="spa-ticket__row spa-ticket__row--grand">
          <dt>{taxed ? t('receipt.totalIncludingTax') : t('receipt.total')}</dt>
          <dd>{formatMoney(receipt.total, display)}</dd>
        </div>
      </dl>

      <hr className="spa-ticket__rule" />

      <p className="spa-ticket__section">{t('receipt.payment')}</p>
      {receipt.settlements.length === 0 ? (
        <p className="spa-ticket__note">{t('receipt.noSettlement')}</p>
      ) : (
        <dl className="spa-ticket__rows">
          {receipt.settlements.map((settlement, index) => (
            <Fragment key={`${settlement.method}-${String(index)}`}>
              <div className="spa-ticket__row">
                <dt>{settlementLabel(settlement, locale)}</dt>
                <dd>{formatMoney(settlement.amount, display)}</dd>
              </div>
              {settlement.tendered === undefined ? null : (
                <div className="spa-ticket__row spa-ticket__row--sub">
                  <dt>{t('receipt.tendered')}</dt>
                  <dd>{formatMoney(settlement.tendered, display)}</dd>
                </div>
              )}
              {settlement.change === undefined ? null : (
                <div className="spa-ticket__row spa-ticket__row--sub">
                  <dt>{t('receipt.change')}</dt>
                  <dd>{formatMoney(settlement.change, display)}</dd>
                </div>
              )}
            </Fragment>
          ))}
        </dl>
      )}

      {taxed ? (
        <>
          <hr className="spa-ticket__rule spa-ticket__rule--dashed" />
          <table className="spa-ticket__taxes">
            <caption className="spa-visually-hidden">{t('receipt.taxCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('receipt.taxRate')}</th>
                <th className="spa-ticket__num" scope="col">
                  {t('receipt.taxBase')}
                </th>
                <th className="spa-ticket__num" scope="col">
                  {t('receipt.taxAmount')}
                </th>
                <th className="spa-ticket__num" scope="col">
                  {t('receipt.taxGross')}
                </th>
              </tr>
            </thead>
            <tbody>
              {taxes.map((row) => (
                <tr key={row.rate}>
                  <td>{row.rate}</td>
                  <td className="spa-ticket__num">{formatMoney(row.base, display)}</td>
                  <td className="spa-ticket__num">{formatMoney(row.tax, display)}</td>
                  <td className="spa-ticket__num">{formatMoney(row.total, display)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {receipt.refunds.length === 0 ? null : (
        <>
          <hr className="spa-ticket__rule spa-ticket__rule--dashed" />
          <p className="spa-ticket__section">{t('receipt.refunded')}</p>
          <dl className="spa-ticket__rows">
            {receipt.refunds.map((refund, index) => (
              <div className="spa-ticket__row" key={refund.number ?? `avoir-${String(index)}`}>
                <dt>
                  {refund.number ?? t('receipt.creditNote', { index: index + 1 })}
                  <span className="spa-ticket__detail">
                    {formatTicketDateTime(refund.issuedAt, receipt.timezone, display)}
                    {refund.reason === undefined ? '' : ` — ${refund.reason}`}
                  </span>
                </dt>
                <dd>− {formatMoney(refund.amount, display)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <hr className="spa-ticket__rule" />

      <footer className="spa-ticket__footer">
        {issuer.footer === undefined ? null : <p className="spa-ticket__legal">{issuer.footer}</p>}
        <p className="spa-ticket__thanks">{t('receipt.thanks')}</p>
      </footer>
    </article>
  );
}
