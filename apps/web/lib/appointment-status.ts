import type {
  AppointmentScope,
  AppointmentStatus,
  BookedAppointment,
  CancellationActor,
} from '@spa/shared';

/**
 * Le vocabulaire du cycle de vie d'un rendez-vous — **le seul endroit du front
 * où il s'écrit** (#917).
 *
 * ## Pourquoi un module de `lib/` plutôt qu'un fichier de plus dans un écran
 *
 * Parce que le même fait se dit sur six surfaces, et qu'elles l'ont dit de trois
 * façons. L'espace client écrivait « Non honoré », le planning « non présenté »,
 * le reporting « No-shows » ; l'espace client distinguait « Déplacé » d'« Annulé
 * par vous », le back-office ne connaissait qu'« annulé ». Trois tables de
 * libellés dans trois fichiers — `compte/components/appointment-status.ts`,
 * `lib/admin/calendar-grid.ts`, `lib/admin/reporting-contract.ts` — ne pouvaient
 * que diverger, et elles avaient divergé : c'est le constat `ds:coherence` de
 * l'audit `d20260916-1`.
 *
 * Il vit dans `lib/` et non dans `lib/admin/` parce qu'il est lu des deux côtés
 * de l'application : le parcours client public et l'espace client d'un côté, le
 * back-office de l'autre (web-frontend, en-tête). Un module de vocabulaire rangé
 * sous `admin/` aurait obligé l'espace client à importer du back-office.
 *
 * ## Ce que ce module contient, et ce qu'il ne contient pas
 *
 * Il contient des **mots** et la logique de présentation qui les choisit :
 * fonctions pures, aucun accès réseau, aucun état, aucun JSX — elles se testent
 * sans DOM (web-frontend §8).
 *
 * Il ne contient ni règle de cycle de vie — `APPOINTMENT_STATUS_TRANSITIONS` du
 * contrat partagé tranche, et le serveur avec lui —, ni classe CSS : la couleur
 * d'une pastille est l'affaire des feuilles de style, et le libellé est toujours
 * écrit à côté (WCAG 1.4.1).
 *
 * ## Le report ne s'affiche pas comme une annulation, et c'est le point délicat
 *
 * Un report annule la ligne d'origine — même colonne, même statut `cancelled` —
 * mais **sans auteur** : `cancelledBy` reste nul là où une vraie annulation
 * nomme `client`, `staff` ou `system`. C'est la seule chose qui distingue les
 * deux, et les trois contrats la portent désormais :
 * `bookedAppointmentSchema` (`null`), `appointmentSchema` (absent, #917) et
 * `customerVisitSchema` (`null`, #917). Les confondre ferait lire « rendez-vous
 * annulé » là où la cliente vient précisément de le conserver en le déplaçant, et
 * ferait compter au salon un créneau perdu là où il n'a rien perdu du tout.
 */

/**
 * À qui le libellé s'adresse.
 *
 * Une seule chose en dépend — la personne grammaticale d'une annulation faite par
 * la cliente : son espace lui dit « Annulé par vous », le comptoir dit « Annulé
 * par la cliente ». Ce n'est pas une divergence de vocabulaire, c'est la même
 * phrase dite à deux interlocuteurs, et la tenir ici est ce qui évite qu'un écran
 * de back-office se mette un jour à tutoyer le salon.
 */
export type AppointmentAudience = 'client' | 'desk';

/**
 * Le libellé d'un statut, au singulier — **la forme canonique**.
 *
 * Initiale en capitale : ces libellés commencent une pastille ou suivent un
 * deux-points, jamais un mot. Pour les insérer au fil d'une phrase, voir
 * `appointmentStatusLabelInSentence`.
 *
 * `no_show` dit « Non honoré » et non « non présenté » : c'est le mot que
 * l'espace client montrait déjà à la cliente, et une même absence ne peut pas
 * porter deux noms selon qui la regarde.
 */
export const APPOINTMENT_STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  pending: 'À confirmer',
  confirmed: 'Confirmé',
  completed: 'Honoré',
  cancelled: 'Annulé',
  no_show: 'Non honoré',
};

/**
 * Les mêmes mots, **accordés au pluriel** — le reporting compte des rendez-vous,
 * pas un rendez-vous.
 *
 * Une seconde table et non une règle d'accord : « À confirmer » est invariable
 * là où « Honoré » prend une marque, et une fonction qui ajouterait un `s` se
 * tromperait sur le premier. Les deux tables restent dans le même fichier, sous
 * les mêmes yeux — c'est ce qui les empêche de diverger.
 */
export const APPOINTMENT_STATUS_PLURAL_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  pending: 'À confirmer',
  confirmed: 'Confirmés',
  completed: 'Honorés',
  cancelled: 'Annulés',
  no_show: 'Non honorés',
};

/**
 * Ce qu'est devenue la ligne d'origine d'un report.
 *
 * Elle est `cancelled` en base — son créneau est bien libéré —, mais le
 * rendez-vous, lui, n'a pas été abandonné : il a changé d'heure. C'est le seul
 * mot de cette table qui ne corresponde à aucun statut.
 */
export const RESCHEDULED_LABEL = 'Déplacé';

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
 * surfaces ont divergé ; il n'y en a donc plus qu'un.
 */
export const PENDING_CONFIRMATION_LABEL = 'À confirmer par le salon';

/**
 * Ce qu'affiche un rendez-vous resté `pending` dont l'heure est passée.
 *
 * Il n'y a plus rien à attendre de celui-là : lui promettre une confirmation à
 * venir serait faux, la pastille se borne donc à constater (#743).
 */
export const UNCONFIRMED_PAST_LABEL = 'Non confirmé';

/** Le ton d'une pastille, tel que les feuilles de style le nomment. */
export type AppointmentTone = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';

export interface AppointmentBadge {
  readonly label: string;
  readonly tone: AppointmentTone;
}

/**
 * Le ton d'un statut — c'est-à-dire le suffixe de classe que les feuilles de
 * style attendent (`spa-admin-badge--no-show`, `spa-account-badge--no-show`).
 *
 * Une dérivation et non une table : le vocabulaire CSS du projet écrit les
 * statuts en `kebab-case`, sans exception, et une table de cinq entrées n'aurait
 * fait qu'offrir un endroit de plus où se tromper. Le ton ne porte **jamais**
 * l'information seule — le libellé est toujours écrit à côté.
 */
export function appointmentTone(status: AppointmentStatus): AppointmentTone {
  return status.replace(/_/g, '-') as AppointmentTone;
}

/**
 * Ce qu'est devenu un rendez-vous, en un mot, pour l'audience donnée.
 *
 * C'est la fonction que **toutes** les surfaces appellent : planning, tiroir,
 * fiche cliente, encaissement, espace client. Elle prend le rendez-vous et non
 * le seul statut, parce que `cancelled` ne se raconte pas sans son auteur —
 * c'est tout l'objet de #917.
 *
 * Le champ `cancelledBy` arrive sous deux formes selon le contrat qui le sert :
 * **absent** sur la ligne d'agenda (`appointmentSchema`), **`null`** sur la
 * sortie publique et sur l'historique CRM. Les deux se lisent pareil — « aucun
 * auteur à nommer » —, et c'est ici, une fois, que les deux formes se rejoignent.
 *
 * `system` est rendu « Annulé par le salon », et c'est délibéré : une annulation
 * automatique — un paiement jamais confirmé, une tâche planifiée — est une
 * décision du salon, prise par son outil. Inventer un cinquième mot pour elle
 * apprendrait à la cliente qu'un robot existe, sans lui dire quoi en faire.
 */
export function appointmentOutcomeLabel(
  appointment: {
    readonly status: AppointmentStatus;
    /**
     * `undefined` est écrit **explicitement** : `exactOptionalPropertyTypes` est
     * actif, et un champ simplement facultatif refuserait la ligne d'agenda, dont
     * le contrat omet la clé là où les deux autres la posent à `null`.
     */
    readonly cancelledBy?: CancellationActor | null | undefined;
  },
  audience: AppointmentAudience = 'desk',
): string {
  if (appointment.status !== 'cancelled') {
    return APPOINTMENT_STATUS_LABELS[appointment.status];
  }

  const author = appointment.cancelledBy ?? null;

  if (author === null) {
    return RESCHEDULED_LABEL;
  }

  if (author === 'client') {
    return audience === 'client' ? 'Annulé par vous' : 'Annulé par la cliente';
  }

  return 'Annulé par le salon';
}

/**
 * Le même libellé, **initiale en bas de casse** — pour les phrases où il n'est
 * pas en tête.
 *
 * « Marquer non honoré » et non « Marquer Non honoré ». Une capitale au milieu
 * d'une phrase se lit comme un nom propre, et un bouton d'action n'en est pas un.
 */
export function appointmentStatusLabelInSentence(status: AppointmentStatus): string {
  return inSentence(APPOINTMENT_STATUS_LABELS[status]);
}

/**
 * Le pluriel, **initiale en bas de casse** — « dont non honorés » en tête de
 * colonne d'un graphique, là où la table du même écran écrit « Non honorés ».
 *
 * Même geste que le singulier, et surtout même **source** : la colonne du
 * graphique de volume et la ligne de la table des statuts comptent la même
 * chose, et l'écran qui les montre côte à côte ne peut pas les nommer
 * autrement l'une de l'autre (#917).
 */
export function appointmentStatusPluralLabelInSentence(status: AppointmentStatus): string {
  return inSentence(APPOINTMENT_STATUS_PLURAL_LABELS[status]);
}

/** L'initiale d'un libellé ramenée en bas de casse, sans toucher au reste. */
function inSentence(label: string): string {
  return label.charAt(0).toLocaleLowerCase('fr-FR') + label.slice(1);
}

/**
 * La pastille d'une ligne de l'**espace client**, pour la moitié d'historique
 * d'où elle vient.
 *
 * `scope` n'est pas décoratif : un rendez-vous resté `pending` dont l'heure est
 * passée tombe dans l'historique — l'API définit « à venir » comme « l'intervalle
 * n'est pas terminé **et** le statut occupe encore le créneau » — et lui
 * promettre une confirmation à venir serait faux (#743). C'est la seule nuance
 * que le back-office n'a pas : son planning montre une journée, pas un passé.
 */
export function appointmentBadge(
  appointment: BookedAppointment,
  scope: AppointmentScope,
): AppointmentBadge {
  if (appointment.status === 'pending') {
    return {
      label: scope === 'upcoming' ? PENDING_CONFIRMATION_LABEL : UNCONFIRMED_PAST_LABEL,
      tone: 'pending',
    };
  }

  return {
    label: appointmentOutcomeLabel(appointment, 'client'),
    tone: appointmentTone(appointment.status),
  };
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
