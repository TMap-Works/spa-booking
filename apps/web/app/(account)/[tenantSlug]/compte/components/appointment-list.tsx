import type {
  AppointmentScope,
  BookedAppointment,
  PublicService,
  TimeZone,
} from '@spa/shared';

import { AppointmentCard } from './appointment-card';

/**
 * Une moitié de l'historique — « à venir » ou « passés ».
 *
 * Server Component : rien ici n'a d'état, et ce qui en a — les deux gestes d'une
 * ligne — vit dans `AppointmentCard`. C'est ce découpage qui garde la session
 * hors du bundle : la liste lit l'API avec le jeton, les cartes ne reçoivent que
 * des rendez-vous.
 *
 * ## L'état vide dit **pourquoi** il est vide
 *
 * Un écran vide sans explication est un bug d'UX (web-frontend §6), et les deux
 * moitiés n'ont pas le même vide : « aucun rendez-vous à venir » invite à
 * réserver, « aucune visite passée » constate. Le libellé est donc passé par
 * l'appelant plutôt que déduit ici.
 */
interface AppointmentListProps {
  readonly tenantSlug: string;
  readonly appointments: readonly BookedAppointment[];
  readonly timeZone: TimeZone;
  /** Le catalogue public, pour nommer la prestation de chaque ligne. */
  readonly services: readonly PublicService[];
  /**
   * La moitié servie — c'est elle qui décide si une ligne porte encore ses deux
   * gestes. Voir l'en-tête d'`AppointmentCard` : le statut seul ne suffit pas.
   */
  readonly scope: AppointmentScope;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

export function AppointmentList({
  tenantSlug,
  appointments,
  timeZone,
  services,
  scope,
  emptyTitle,
  emptyDescription,
}: AppointmentListProps) {
  if (appointments.length === 0) {
    return (
      <div className="spa-empty-state">
        <p className="spa-empty-state__title">{emptyTitle}</p>
        <p className="spa-empty-state__description">{emptyDescription}</p>
      </div>
    );
  }

  // Le catalogue **public** ne contient que les prestations encore en vente : un
  // soin retiré depuis laisse une ligne sans nom, et la carte affiche alors un
  // libellé générique plutôt que de disparaître de l'historique.
  const namesById = new Map(services.map((service) => [service.id, service.name]));

  return (
    <ul className="spa-appointment-list">
      {appointments.map((appointment) => (
        <AppointmentCard
          key={appointment.id}
          tenantSlug={tenantSlug}
          appointment={appointment}
          timeZone={timeZone}
          serviceName={namesById.get(appointment.serviceId) ?? null}
          scope={scope}
        />
      ))}
    </ul>
  );
}
