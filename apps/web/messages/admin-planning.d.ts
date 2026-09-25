import type AdminPlanningMessages from './en/admin-planning.json';

/**
 * Le namespace `admin-planning` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre le planning du back-office et tout ce qui s'ouvre depuis lui : la
 * grille, le tiroir de rendez-vous, le sélecteur de client, la confirmation de
 * report et le journal d'envois.
 *
 * Il est lu de deux façons, comme `appointment-status` : par
 * `useTranslations('admin-planning')` dans les composants, et par un **import
 * direct des deux fichiers JSON** dans `lib/admin/calendar-messages.ts`, que les
 * modules de calcul — sans React, donc sans crochet — appellent. Les deux
 * lectures visent les mêmes fichiers : il n'y a qu'une écriture de ce
 * vocabulaire, et depuis #1187 c'est vrai à la lettre — `appointment-desk.ts`
 * gardait une copie française de treize de ces phrases, que plus personne ne
 * rendait et qu'aucun test ne comparait au catalogue.
 *
 * ## Les refus de créneau n'affirment pas une cause que l'API ne donne pas (#611)
 *
 * Quatre clés de ce namespace disent un créneau refusé — les deux corps,
 * `desk.conflictBody` et `move.conflictBody`, et les deux titres qui les
 * coiffent, `desk.conflictTitle` et `move.conflictTitle` —, et leur rédaction
 * obéit toutes les quatre à la même contrainte, dans les deux langues.
 * `desk.slotsEmpty` n'en est pas : il dit une journée sans créneau, et non un
 * créneau refusé.
 *
 * Elles ont longtemps dit « vient d'être pris depuis un autre poste ». C'était
 * une **déduction**, et elle était fausse la plupart du temps : le contrôleur
 * annonce noir sur blanc que le seul code `SLOT_NO_LONGER_AVAILABLE` « couvre
 * toutes les façons dont le créneau n'est pas réservable — pris entre
 * l'affichage et la validation, hors des heures du praticien, pendant un congé,
 * sous le préavis, ou chez un praticien qui ne pratique pas ce soin »
 * (`apps/api/src/modules/appointments/appointments.controller.ts`). Rien dans le
 * corps du refus ne permet de trancher : `details` ne rend que le `staffId` et
 * le `startsAt` que l'appelant vient d'envoyer, délibérément, pour ne pas faire
 * de ce 409 une sonde d'agenda.
 *
 * La campagne de QA a mesuré ce que coûtait cette invention : six refus
 * consécutifs au comptoir, tous annoncés comme une course perdue entre postes,
 * sur une journée qui ne portait **aucun** rendez-vous. L'opératrice cherchait
 * une collègue qui n'avait rien réservé.
 *
 * Ces phrases énumèrent donc les causes possibles sans en désigner une, et se
 * terminent par le geste qui débloque. Le titre suit la même règle —
 * « Indisponible » et non « déjà pris » : c'est la première chose qu'on lit, et
 * c'est là que l'ancienne version affirmait le plus fort. **Toute retraduction
 * ou reformulation de ces quatre clés est tenue par cette règle.**
 *
 * ## L'annulation a son propre vocabulaire, et ce n'est pas un hasard (#754)
 *
 * Le comptoir annule par `POST /appointments/:id/cancel` (#40), et non par la
 * route de statut : c'est une route à part, avec son corps — un motif — et sa
 * confirmation en deux temps. Les clés `desk.cancelQuestion`,
 * `desk.cancelReasonLabel`, `desk.cancelReasonHint` et `desk.cancelConflict`
 * sont la trace de cette séparation, et ne se replient pas sur celles du tiroir :
 * `desk.conflictBody` invite à « reprendre une heure dans la liste » quand une
 * annulation n'a aucun créneau à reprendre, et `desk.routeMissing` annonce une
 * écriture non servie quand celle-ci l'est depuis #40. Le détail du partage est
 * écrit là où il s'applique, dans `appointment-panel.tsx`.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-planning': typeof AdminPlanningMessages;
    }
  }
}

export {};
