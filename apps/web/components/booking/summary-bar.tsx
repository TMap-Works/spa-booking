import type { PublicService, PublicTenant, UtcInstant } from '@spa/shared';
import type { ReactNode } from 'react';

import { formatDateTimeInTimeZone, formatDuration, formatMoney } from '@/lib/format';

interface BookingSummaryBarProps {
  readonly tenant: PublicTenant;
  /** `null` tant qu'aucune prestation n'est retenue : la barre ne rend alors rien. */
  readonly service: PublicService | null;
  /** `null` tant qu'aucun créneau n'est retenu — l'étape « Créneau » est là pour ça. */
  readonly startsAt: UtcInstant | null;
}

interface SummaryFactProps {
  readonly term: string;
  /** Classe supplémentaire portée par la valeur — le prix et lui seul, à ce jour. */
  readonly valueClassName?: string;
  readonly children: ReactNode;
}

/**
 * Un fait de la barre : son libellé au-dessus, sa valeur en dessous.
 *
 * `<dl>` comme le récapitulatif, et pour la même raison : ce sont des couples
 * libellé / valeur, et c'est ce qu'un lecteur d'écran doit entendre. Le `<div>`
 * de groupe est admis par HTML — une `<dl>` accepte des `<div>` dont chacun
 * porte ses `<dt>` et ses `<dd>` — et c'est lui qui tient la valeur sous son
 * libellé quand la barre passe à la ligne (`recap.tsx` en dit plus long).
 *
 * Les libellés sont **visibles**, là où le wireframe sépare les valeurs par des
 * points médians. À 360 px, la barre passe de toute façon à la ligne : une suite
 * de valeurs nues y produirait des lignes commençant par un séparateur, et le
 * seul moyen de ne pas le faire entendre aux lecteurs d'écran aurait été un
 * contenu généré en CSS, que certains restituent quand même. Quatre couples
 * courts coûtent une ligne de plus et se lisent sans décodage.
 */
function SummaryFact({ term, valueClassName, children }: SummaryFactProps) {
  // Même composition de classes que `RecapRow` : la liste, puis le filtrage.
  const classes = ['spa-booking__summary-value', valueClassName ?? null]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <div className="spa-booking__summary-fact">
      <dt className="spa-booking__summary-term">{term}</dt>
      <dd className={classes}>{children}</dd>
    </div>
  );
}

/**
 * La barre de résumé collante du tunnel (#735).
 *
 * ## Ce qu'elle répare
 *
 * `docs/design/appointments/README.md` — « Mobile d'abord » — prescrit une
 * « barre de résumé collante en bas rappelant service, praticien, date/heure et
 * **prix** dès qu'ils sont connus », et `wireframes.md` la dessine sur chaque
 * étape. Aucune n'existait : à l'étape « Créneau », l'écran ne portait que le nom
 * de la prestation — le prix avait disparu depuis l'étape précédente ; à l'étape
 * « Coordonnées », plus rien ne rappelait ni la prestation, ni la date, ni
 * l'heure, ni le prix. La cliente décidait de tête (audit `d20260916-1`,
 * critère `ds:confiance`).
 *
 * ## Ce qu'elle rappelle, et dans quel ordre
 *
 * Prestation, durée, date et heure, prix — l'ordre du parcours, et celui de la
 * direction demandée par l'issue. Le praticien qu'énumère le README en est
 * absent : il est **choisi sur l'étape « Créneau » elle-même**, où son sélecteur
 * est à l'écran, et le récapitulatif le redit avant la confirmation. L'ajouter
 * ferait une cinquième colonne sur une barre qui en tient déjà quatre à 360 px,
 * pour la seule information que la cliente peut lire là où elle la change.
 *
 * Ce qui n'est pas encore connu ne s'affiche pas : sans créneau retenu, la barre
 * porte trois faits, pas une ligne « Date et heure : — » qui ferait passer un
 * choix à venir pour une donnée manquante (`states.md`).
 *
 * ## Ce qu'elle n'est pas
 *
 * Elle ne porte pas l'action primaire, que le wireframe ancre au même endroit :
 * chaque étape garde le sien, dans son flux. Déplacer les boutons de cinq étapes
 * dans une barre commune remanierait la mise en page de tout le tunnel, pour une
 * issue qui demande de **rappeler ce qui permet de décider**.
 */
export function BookingSummaryBar({ tenant, service, startsAt }: BookingSummaryBarProps) {
  if (service === null) {
    // Rien de connu, rien à rappeler : une barre vide occuperait le bas de
    // l'écran sans rien y dire.
    return null;
  }

  return (
    // `aria-label` plutôt qu'un titre visible : la barre est un rappel, et un
    // intertitre de plus dans le panneau se lirait comme une section du
    // formulaire. Le repère reste nommé pour qui navigue de région en région.
    <aside className="spa-booking__summary" aria-label="Votre réservation">
      <dl className="spa-booking__summary-facts">
        <SummaryFact term="Prestation">{service.name}</SummaryFact>

        <SummaryFact term="Durée">{formatDuration(service.durationMinutes)}</SummaryFact>

        {startsAt === null ? null : (
          <SummaryFact term="Date et heure">
            {/* Dans le fuseau du salon, comme partout ailleurs dans le tunnel :
                la mention du fuseau est portée une fois pour toutes par
                l'en-tête, et la répéter ici la ferait apparaître deux fois sur
                le même écran. */}
            {formatDateTimeInTimeZone(startsAt, tenant.timezone)}
          </SummaryFact>
        )}

        <SummaryFact term="Prix" valueClassName="spa-booking__summary-value--price">
          {formatMoney(service.price)}
        </SummaryFact>
      </dl>
    </aside>
  );
}
