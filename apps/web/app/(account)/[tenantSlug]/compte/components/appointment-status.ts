import type { BookedAppointment } from '@spa/shared';

/**
 * Ce qu'une ligne d'historique annonce, et le ton avec lequel elle l'annonce.
 *
 * Logique de présentation pure — aucun accès réseau, aucun état : elle se teste
 * sans DOM (web-frontend §8).
 *
 * ## Le report ne s'affiche pas comme une annulation, et c'est le point délicat
 *
 * Un report annule la ligne d'origine — même colonne, même statut `cancelled` —
 * mais **sans auteur** : `cancelledBy` reste `null` là où une vraie annulation
 * nomme `client` ou `staff`. C'est la seule chose qui distingue les deux, et
 * l'API le documente comme tel (`bookedAppointmentSchema`). Les confondre ferait
 * lire « rendez-vous annulé » à une cliente qui vient précisément de le
 * conserver en le déplaçant.
 */
export type AppointmentTone = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';

export interface AppointmentBadge {
  readonly label: string;
  readonly tone: AppointmentTone;
}

export function appointmentBadge(appointment: BookedAppointment): AppointmentBadge {
  if (appointment.status === 'cancelled') {
    return appointment.cancelledBy === null
      ? { label: 'Déplacé', tone: 'cancelled' }
      : {
          label: appointment.cancelledBy === 'client' ? 'Annulé par vous' : 'Annulé par le salon',
          tone: 'cancelled',
        };
  }

  switch (appointment.status) {
    case 'pending':
      return { label: 'En attente de confirmation', tone: 'pending' };
    case 'confirmed':
      return { label: 'Confirmé', tone: 'confirmed' };
    case 'completed':
      return { label: 'Honoré', tone: 'completed' };
    case 'no_show':
      return { label: 'Non honoré', tone: 'no-show' };
  }
}

/**
 * `true` si le rendez-vous peut encore être reporté ou annulé par la cliente.
 *
 * Le cycle de vie de l'API tranche pour de bon — une transition interdite sort
 * en 422 —, et ce prédicat ne le double pas : il décide seulement s'il faut
 * **afficher** les boutons. Montrer « Annuler » sur un rendez-vous déjà annulé
 * n'est pas une faille, c'est une promesse que le clic ne tiendra pas.
 */
export function isStillActionable(appointment: BookedAppointment): boolean {
  return appointment.status === 'pending' || appointment.status === 'confirmed';
}
