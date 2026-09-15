import type { Money, PublicTenant, UtcInstant } from '@spa/shared';
import type { ReactNode } from 'react';

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

interface RecapRowProps {
  readonly term: string;
  /** Classe supplémentaire portée par la valeur — le prix et lui seul, à ce jour. */
  readonly valueClassName?: string;
  readonly children: ReactNode;
}

/**
 * Un couple libellé / valeur du récapitulatif.
 *
 * ## Pourquoi le `<div>` entre la `<dl>` et ses `<dt>`/`<dd>`
 *
 * Sans lui, `<dt>` et `<dd>` sont frères dans le flux de la liste, et rien ne
 * relie visuellement l'un à l'autre : la mise en colonnes demanderait alors une
 * grille, dont les deux pistes retomberaient l'une sous l'autre sur un écran
 * étroit sans que la valeur reste attachée à son libellé. Le groupe de division
 * est explicitement admis par HTML — une `<dl>` accepte des `<div>` dont chacun
 * porte ses `<dt>` et ses `<dd>` — et ne change rien à la sémantique de la liste
 * ni à ce qu'en restitue un lecteur d'écran.
 *
 * C'est exactement la structure d'« Informations pratiques » sur la vitrine
 * (`components/salon/salon-info.tsx`), dont ce récapitulatif reprend la mise en
 * page : les deux surfaces publiques rendent des couples libellé / valeur, elles
 * doivent les rendre pareil.
 */
function RecapRow({ term, valueClassName, children }: RecapRowProps) {
  // Même composition de classes que `Button`, `Field` ou `Select` : la liste
  // puis le filtrage. Écrire la classe de base dans les deux branches d'un
  // ternaire la ferait renommer deux fois le jour où elle change.
  const classes = ['spa-booking__recap-value', valueClassName ?? null]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <div className="spa-booking__recap-row">
      <dt className="spa-booking__recap-term">{term}</dt>
      <dd className={classes}>{children}</dd>
    </div>
  );
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
 *
 * ## La liste est mise en colonnes (#636)
 *
 * Elle était rendue avec le style par défaut du navigateur : chaque valeur
 * passait à la ligne sous son libellé et s'en décalait de 40 px — dix couples
 * étalés sur vingt lignes, à l'écran même où la cliente vérifie ce qu'elle
 * s'apprête à réserver. `.spa-booking__recap-*` rend les deux colonnes, et
 * `booking.css` dit pourquoi elles sont calquées sur la vitrine.
 */
export function Recap({ tenant, serviceName, staffName, startsAt, price, contact }: RecapProps) {
  return (
    <dl className="spa-card__body spa-booking__recap">
      <RecapRow term="Établissement">{tenant.name}</RecapRow>

      {serviceName === null ? null : <RecapRow term="Prestation">{serviceName}</RecapRow>}

      <RecapRow term="Praticien">{staffName ?? 'Premier disponible'}</RecapRow>

      <RecapRow term="Date et heure">
        {formatDateTimeInTimeZone(startsAt, tenant.timezone)}
      </RecapRow>

      {price === null ? null : (
        <RecapRow term="Prix" valueClassName="spa-card__price">
          {formatMoney(price)}
        </RecapRow>
      )}

      <RecapRow term="Au nom de">
        {contact.firstName} {contact.lastName}
      </RecapRow>

      <RecapRow term="Adresse e-mail">{contact.email}</RecapRow>

      {contact.phone === '' ? null : <RecapRow term="Téléphone">{contact.phone}</RecapRow>}

      {contact.clientNote === '' ? null : (
        <RecapRow term="Votre mot au salon">{contact.clientNote}</RecapRow>
      )}
    </dl>
  );
}
