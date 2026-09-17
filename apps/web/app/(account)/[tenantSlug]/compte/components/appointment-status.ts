import type { AppointmentScope, BookedAppointment } from '@spa/shared';

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

/**
 * Le seul endroit du front où s'écrit l'état d'un rendez-vous pris mais que le
 * salon n'a pas encore confirmé (#743).
 *
 * ## Pourquoi une constante, et pourquoi exportée
 *
 * Le parcours enchaînait trois mots pour un même fait : le tunnel annonçait
 * « Votre rendez-vous est enregistré », l'espace client affichait, sur ce
 * rendez-vous-là, « En attente de confirmation », et rien ne disait ce qu'on
 * attendait ni de qui. Une cliente qui vient de cliquer « Confirmer la
 * réservation » lit alors qu'il manque *encore* une confirmation, sans savoir
 * si elle en est redevable.
 *
 * Le libellé **nomme l'acteur** : c'est le salon qui confirme, et le geste de la
 * cliente est déjà fait. C'est ce qui lève la contradiction sans mentir — le
 * rendez-vous naît bien `PENDING` côté API (`appointments.repository.ts`), et
 * l'annoncer « confirmé » comme le fait le wireframe — Étape 6 — contredirait la
 * pastille au lieu de l'accorder.
 *
 * Elle est exportée parce que l'écran terminal du tunnel reprend **la même**
 * phrase (`(booking)/[tenantSlug]/reservation/steps/confirmation-step.tsx`).
 * Deux littéraux dans deux fichiers, c'est exactement la façon dont ces deux
 * surfaces ont divergé ; il n'y en a donc plus qu'un. Ce module s'y prête : il
 * ne dépend que d'un type partagé, comme `paths.ts` que le tunnel importe déjà.
 */
export const PENDING_CONFIRMATION_LABEL = 'À confirmer par le salon';

/**
 * La pastille d'une ligne, pour la moitié d'historique d'où elle vient.
 *
 * `scope` n'est pas décoratif : un rendez-vous resté `pending` dont l'heure est
 * passée tombe dans l'historique — l'API définit « à venir » comme « l'intervalle
 * n'est pas terminé **et** le statut occupe encore le créneau » — et lui
 * promettre une confirmation à venir serait faux. Il n'y a plus rien à attendre
 * de ce rendez-vous-là : la pastille se borne à constater (#743).
 */
export function appointmentBadge(
  appointment: BookedAppointment,
  scope: AppointmentScope,
): AppointmentBadge {
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
      return {
        label: scope === 'upcoming' ? PENDING_CONFIRMATION_LABEL : 'Non confirmé',
        tone: 'pending',
      };
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
