import type { SaleReceipt } from '@spa/shared';
import { Fragment } from 'react';

import {
  formatReceiptPhone,
  issuerAddressLines,
  legalIdLine,
  settlementLabel,
  soldLines,
  taxTableRows,
} from '@/lib/admin/receipt-ticket';
import { formatMoney, formatTicketDateTime } from '@/lib/format';

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
 */
export function ReceiptTicket({ receipt }: { readonly receipt: SaleReceipt }) {
  const { issuer } = receipt;
  const legalId = legalIdLine(issuer);
  const contacts = [
    issuer.contactPhone === undefined ? undefined : formatReceiptPhone(issuer.contactPhone),
    issuer.contactEmail,
  ].filter((value): value is string => value !== undefined);
  const lines = soldLines(receipt.lines);
  const itemCount = lines.reduce((count, line) => count + line.quantity, 0);
  const taxes = taxTableRows(receipt.taxBreakdown);
  const taxed = taxes.length > 0;
  const issuedAt = receipt.issuedAt ?? receipt.openedAt;

  return (
    <article
      aria-label={receipt.number === null ? 'Ticket provisoire' : `Ticket n° ${receipt.number}`}
      className="spa-ticket"
    >
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
        {issuer.vatNumber === undefined ? null : <p>TVA intracom. {issuer.vatNumber}</p>}
      </header>

      <hr className="spa-ticket__rule" />

      <div className="spa-ticket__identity">
        {receipt.number === null ? (
          <>
            <p className="spa-ticket__title">Ticket provisoire</p>
            <p className="spa-ticket__note">
              Vente non close — ce document n’est pas une pièce comptable.
            </p>
          </>
        ) : (
          <p className="spa-ticket__title">Ticket n° {receipt.number}</p>
        )}
        <p>{formatTicketDateTime(issuedAt, receipt.timezone)}</p>
      </div>

      <hr className="spa-ticket__rule" />

      <dl className="spa-ticket__rows">
        {receipt.client === null ? null : (
          <div className="spa-ticket__row">
            <dt>Client</dt>
            <dd>{receipt.client.displayName}</dd>
          </div>
        )}
        {receipt.practitioner === null ? null : (
          <div className="spa-ticket__row">
            <dt>Praticien</dt>
            <dd>{receipt.practitioner.displayName}</dd>
          </div>
        )}
        <div className="spa-ticket__row">
          <dt>Caisse</dt>
          <dd>{receipt.cashier.displayName}</dd>
        </div>
      </dl>

      <hr className="spa-ticket__rule" />

      <table className="spa-ticket__items">
        <caption className="spa-visually-hidden">Articles</caption>
        <thead>
          <tr>
            <th scope="col">Article</th>
            <th className="spa-ticket__num" scope="col">
              Qté
            </th>
            <th className="spa-ticket__num" scope="col">
              Montant
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
                    {line.quantity} × {formatMoney(line.unitPrice)}
                  </span>
                )}
              </td>
              <td className="spa-ticket__num">{line.quantity}</td>
              <td className="spa-ticket__num">{formatMoney(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="spa-ticket__count">
        {itemCount} article{itemCount > 1 ? 's' : ''}
      </p>

      <hr className="spa-ticket__rule spa-ticket__rule--dashed" />

      <dl className="spa-ticket__rows">
        {taxed ? (
          <>
            <div className="spa-ticket__row">
              <dt>Total HT</dt>
              <dd>{formatMoney(receipt.subtotal)}</dd>
            </div>
            <div className="spa-ticket__row">
              <dt>TVA</dt>
              <dd>{formatMoney(receipt.taxTotal)}</dd>
            </div>
          </>
        ) : null}
        {receipt.tip.amountMinor === 0 ? null : (
          <div className="spa-ticket__row">
            <dt>Pourboire</dt>
            <dd>{formatMoney(receipt.tip)}</dd>
          </div>
        )}
        <div className="spa-ticket__row spa-ticket__row--grand">
          <dt>{taxed ? 'Total TTC' : 'Total'}</dt>
          <dd>{formatMoney(receipt.total)}</dd>
        </div>
      </dl>

      <hr className="spa-ticket__rule" />

      {receipt.settlements.length === 0 ? (
        <p className="spa-ticket__note">Aucun règlement enregistré.</p>
      ) : (
        <dl className="spa-ticket__rows">
          {receipt.settlements.map((settlement, index) => (
            <Fragment key={`${settlement.method}-${String(index)}`}>
              <div className="spa-ticket__row">
                <dt>{settlementLabel(settlement)}</dt>
                <dd>{formatMoney(settlement.amount)}</dd>
              </div>
              {settlement.tendered === undefined ? null : (
                <div className="spa-ticket__row spa-ticket__row--sub">
                  <dt>Reçu</dt>
                  <dd>{formatMoney(settlement.tendered)}</dd>
                </div>
              )}
              {settlement.change === undefined ? null : (
                <div className="spa-ticket__row spa-ticket__row--sub">
                  <dt>Rendu</dt>
                  <dd>{formatMoney(settlement.change)}</dd>
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
            <caption className="spa-visually-hidden">Détail de la TVA</caption>
            <thead>
              <tr>
                <th scope="col">Taux</th>
                <th className="spa-ticket__num" scope="col">
                  HT
                </th>
                <th className="spa-ticket__num" scope="col">
                  TVA
                </th>
                <th className="spa-ticket__num" scope="col">
                  TTC
                </th>
              </tr>
            </thead>
            <tbody>
              {taxes.map((row) => (
                <tr key={row.rate}>
                  <td>{row.rate}</td>
                  <td className="spa-ticket__num">{formatMoney(row.base)}</td>
                  <td className="spa-ticket__num">{formatMoney(row.tax)}</td>
                  <td className="spa-ticket__num">{formatMoney(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {receipt.refunds.length === 0 ? null : (
        <>
          <hr className="spa-ticket__rule spa-ticket__rule--dashed" />
          <p className="spa-ticket__section">Avoirs</p>
          <dl className="spa-ticket__rows">
            {receipt.refunds.map((refund, index) => (
              <div className="spa-ticket__row" key={refund.number ?? `avoir-${String(index)}`}>
                <dt>
                  {refund.number ?? `Avoir ${String(index + 1)}`}
                  <span className="spa-ticket__detail">
                    {formatTicketDateTime(refund.issuedAt, receipt.timezone)}
                    {refund.reason === undefined ? '' : ` — ${refund.reason}`}
                  </span>
                </dt>
                <dd>− {formatMoney(refund.amount)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <hr className="spa-ticket__rule" />

      <footer className="spa-ticket__footer">
        {issuer.footer === undefined ? null : <p className="spa-ticket__legal">{issuer.footer}</p>}
        <p className="spa-ticket__thanks">Merci de votre visite !</p>
      </footer>
    </article>
  );
}
