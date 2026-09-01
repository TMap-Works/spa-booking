import type { Money, PublicTenant, UtcInstant } from '@spa/shared';

import type { ContactDraft } from '@/lib/booking/draft';
import { formatDateTimeInTimeZone, formatMoney } from '@/lib/format';

interface RecapProps {
  readonly tenant: PublicTenant;
  readonly serviceName: string | null;
  readonly staffName: string | null;
  readonly startsAt: UtcInstant;
  readonly price: Money | null;
  readonly contact: ContactDraft;
}

/**
 * Le récapitulatif, partagé par l'écran de vérification et l'écran de
 * confirmation (#45).
 *
 * Un seul composant pour les deux, à dessein : ce que la cliente valide et ce
 * qu'elle relit ensuite doivent être **la même liste**, sinon une différence de
 * présentation se lit comme une différence de rendez-vous.
 *
 * L'heure est affichée dans le fuseau de l'établissement — un rendez-vous mal
 * fuseau-horairé est un bug de sévérité haute (CLAUDE.md). La mention explicite
 * du fuseau, quand le visiteur est ailleurs, est portée une seule fois par
 * l'en-tête du tunnel : la répéter ici la ferait apparaître deux fois dans le
 * même écran.
 */
export function Recap({ tenant, serviceName, staffName, startsAt, price, contact }: RecapProps) {
  return (
    <dl className="spa-card__body">
      <dt>Établissement</dt>
      <dd>{tenant.name}</dd>

      {serviceName === null ? null : (
        <>
          <dt>Prestation</dt>
          <dd>{serviceName}</dd>
        </>
      )}

      <dt>Praticien</dt>
      <dd>{staffName ?? 'Premier disponible'}</dd>

      <dt>Date et heure</dt>
      <dd>{formatDateTimeInTimeZone(startsAt, tenant.timezone)}</dd>

      {price === null ? null : (
        <>
          <dt>Prix</dt>
          <dd className="spa-card__price">{formatMoney(price)}</dd>
        </>
      )}

      <dt>Au nom de</dt>
      <dd>
        {contact.firstName} {contact.lastName}
      </dd>

      <dt>Adresse e-mail</dt>
      <dd>{contact.email}</dd>

      {contact.phone === '' ? null : (
        <>
          <dt>Téléphone</dt>
          <dd>{contact.phone}</dd>
        </>
      )}

      {contact.clientNote === '' ? null : (
        <>
          <dt>Votre mot au salon</dt>
          <dd>{contact.clientNote}</dd>
        </>
      )}
    </dl>
  );
}
