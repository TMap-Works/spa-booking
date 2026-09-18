import type { AppointmentScope, BookedAppointment, PublicService, TimeZone } from '@spa/shared';

import { appointmentBrief } from '@/components/account/appointment-brief';

import { AppointmentCard } from './appointment-card';

/**
 * Une liste de cartes compactes de rendez-vous — les rendez-vous à venir qui
 * suivent le prochain, ou l'historique.
 *
 * Server Component : rien ici n'a d'état, et ce qui en a — les gestes d'une
 * carte — vit dans `AppointmentCard`. C'est ce découpage qui garde la session
 * hors du bundle : la page lit l'API avec le jeton, les cartes ne reçoivent que
 * des rendez-vous.
 *
 * ## Ce qu'elle ne fait plus : l'état vide (#1053)
 *
 * Elle le rendait, à partir d'un titre, d'une phrase et d'une action passés par
 * l'appelant — trois paramètres qui ne servaient qu'à le composer. Depuis que
 * l'espace a un onglet par moitié, les deux vides n'ont plus rien en commun :
 * celui des rendez-vous porte une suggestion tirée de la dernière visite
 * (`BM-HISTO-02`), celui de l'historique constate. Chaque page monte donc son
 * `EmptyState`, et cette liste ne s'occupe que du cas peuplé.
 *
 * ## Les noms se résolvent ici, une fois
 *
 * Le contrat public ne sert que des identifiants (`serviceId`, `staffId`) : les
 * noms viennent du catalogue, que la page a déjà chargé. `appointmentBrief` les
 * résout carte par carte — voir `components/account/appointment-brief.ts`.
 */
interface AppointmentListProps {
  readonly tenantSlug: string;
  readonly appointments: readonly BookedAppointment[];
  readonly timeZone: TimeZone;
  /** Le catalogue public, pour nommer la prestation et le praticien de chaque carte. */
  readonly services: readonly PublicService[];
  /**
   * La moitié servie — c'est elle qui décide si une carte porte encore ses deux
   * gestes. Voir l'en-tête d'`AppointmentCard` : le statut seul ne suffit pas.
   */
  readonly scope: AppointmentScope;
}

export function AppointmentList({
  tenantSlug,
  appointments,
  timeZone,
  services,
  scope,
}: AppointmentListProps) {
  return (
    <ul className="spa-appointment-list">
      {appointments.map((appointment) => (
        <AppointmentCard
          key={appointment.id}
          tenantSlug={tenantSlug}
          brief={appointmentBrief(appointment, services)}
          timeZone={timeZone}
          scope={scope}
        />
      ))}
    </ul>
  );
}
