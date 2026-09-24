import {
  APPOINTMENT_NOT_STARTED_DETAIL,
  APPOINTMENTS_ERROR_CODES,
  MAX_APPOINTMENT_RANGE_DAYS,
} from '@spa/shared';

import { DOMAIN_HTTP_STATUS, DomainError, InvalidStateTransitionError } from '../../common/errors';
import type { AppointmentStatus, OutcomeStatus } from './appointment-status';

/**
 * Erreurs du module `appointments`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en réponse
 * `{ code, message, details }`. Le front réagit sur `code`, jamais sur
 * `message`.
 *
 * La **borne** de ce fichier — `MAX_APPOINTMENT_RANGE_DAYS` — vient désormais de
 * `@spa/shared` et est simplement réexportée d'ici (#510) : elle y vaut
 * exactement ce qu'elle valait (31), et le contrat est maintenant sa seule
 * écriture.
 *
 * Les **codes** viennent eux aussi de `@spa/shared` depuis #536, et sont
 * réexportés d'ici. Ce qui bloquait n'était pas l'import mais le découpage : le
 * contrat les mêlait à ceux d'`availability` dans un `BOOKING_ERROR_CODES`
 * commun, si bien qu'importer d'ici aurait fait de la famille d'`appointments`
 * un sous-ensemble emprunté à une famille voisine. Le contrat porte désormais
 * une famille par module, et les deux valeurs de celle-ci sont inchangées,
 * caractère pour caractère.
 */
export { APPOINTMENTS_ERROR_CODES };

/**
 * 409 et non 422 : la requête est parfaitement valide, c'est **l'état du monde**
 * qui a changé entre l'affichage des créneaux et la validation.
 *
 * La valeur vient de `DOMAIN_HTTP_STATUS`, la table de correspondance
 * d'api-module §5, et non d'un `409` recopié : deux tables de statuts qui
 * dérivent, c'est un module qui répond autre chose que ce que le contrat annonce.
 */
const CONFLICT = DOMAIN_HTTP_STATUS.CONFLICT;

/**
 * 422 : la requête est bien formée, ce sont ses valeurs prises **ensemble** qui
 * ne tiennent pas. Même table que ci-dessus, jamais un nombre recopié.
 */
const UNPROCESSABLE_ENTITY = DOMAIN_HTTP_STATUS.UNPROCESSABLE_ENTITY;

/**
 * Fenêtre maximale de l'agenda de back-office, en jours (#444).
 *
 * Elle ne borne pas un calcul — l'agenda ne fait que lire — mais le **volume de
 * la réponse** : une semaine de comptoir porte plusieurs centaines de lignes,
 * chacune servie avec sa cliente, son praticien et sa prestation imbriqués
 * (CDC §1.4). Sans borne, la taille de la réponse ne dépendrait que de
 * l'appelant, et une plage saisie au 20**2**6 au lieu de 2026 ferait parcourir
 * deux siècles d'agenda pour une faute de frappe.
 *
 * Trente et un jours couvrent la vue mois d'un calendrier, la plus large qu'un
 * back-office affiche ; les vues jour et semaine de #49 tiennent largement
 * dessous.
 *
 * **Importée du contrat partagé** depuis #510, et réexportée d'ici pour les
 * appelants du module qui la lisaient déjà à cette adresse. Le littéral valait
 * 31 des deux côtés : la substitution n'a donc changé aucune borne, elle a
 * seulement supprimé la seconde écriture qui aurait pu, elle, diverger.
 */
export { MAX_APPOINTMENT_RANGE_DAYS };

/**
 * Plage d'agenda inversée, ou plus large que `MAX_APPOINTMENT_RANGE_DAYS`.
 *
 * **422 et non 400** : chaque date est bien écrite — le DTO l'a déjà vérifié
 * caractère par caractère —, c'est leur écart qui n'est pas servable. La
 * distinction compte pour le front, qui n'affiche pas un défaut de format comme
 * une limite de service, et le code est celui qu'annonce déjà
 * `appointmentListQuerySchema` du contrat partagé.
 *
 * Jugée dans le service et pas seulement dans le DTO, pour la raison qui vaut
 * déjà pour la disponibilité : la règle porte sur le **couple** de dates, et les
 * deux bornes sont facultatives — c'est le service qui complète celle qui
 * manque, avec la journée courante du salon. Un décorateur de champ n'aurait vu
 * ni le couple, ni la valeur qu'il ne reçoit pas.
 *
 * `details` ne rend que ce que l'appelant a envoyé, plus la borne : rien de cet
 * établissement, rien d'un autre.
 */
export class AppointmentRangeTooWideError extends DomainError {
  public override readonly code = APPOINTMENTS_ERROR_CODES.APPOINTMENT_RANGE_TOO_WIDE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(from: string, to: string) {
    super(
      `La plage demandée doit être ordonnée et ne pas excéder ${String(MAX_APPOINTMENT_RANGE_DAYS)} jours.`,
      { from, to, maxRangeDays: MAX_APPOINTMENT_RANGE_DAYS },
    );
  }
}

/**
 * On ne constate pas l'issue d'un rendez-vous qui n'a pas commencé (#1137).
 *
 * ## Ce que le bug faisait
 *
 * `CONFIRMED → NO_SHOW` et `CONFIRMED → COMPLETED` passaient quelle que soit la
 * date. Deux statuts terminaux, donc sans retour : un clic de trop sur la ligne
 * d'un rendez-vous du mois prochain le marquait « client absent » **et** libérait
 * son créneau, sans que rien ne permette de revenir en arrière. Le taux de
 * no-show d'octobre annonçait 66,7 % sur des soins qui n'avaient pas encore eu
 * lieu, et la fiche de la cliente affichait une « dernière visite » dans le
 * futur — CDC §1.4 « mesurer », qui ne compte que des rendez-vous passés.
 *
 * ## Pourquoi le même code que la transition interdite
 *
 * Parce que c'est bien le **cycle de vie** qui refuse, et que le front branche sur
 * `code` : ajouter un code au contrat partagé aurait obligé chaque appelant à
 * traiter un cas de plus pour un refus qu'il affiche déjà. La sous-classe existe
 * pour deux autres raisons — un message qui dit *pourquoi* au comptoir, et
 * `notStarted` dans `details`, sur lequel un écran peut proposer « attendre
 * l'heure du rendez-vous » plutôt que « recharger ».
 *
 * ## Ce que `details` porte
 *
 * `startsAt` est l'heure du rendez-vous **que l'appelant vise déjà** : il l'a
 * sous les yeux sur la ligne d'agenda, la lui rendre ne lui apprend rien de plus
 * et lui évite d'aller la relire. `now` est l'instant de la décision, ISO 8601
 * UTC comme partout — c'est ce qui rend le refus explicable quand l'horloge du
 * poste et celle du serveur divergent. Rien de la cliente ni du praticien.
 *
 * Le nom de la clé vient de `@spa/shared` — `APPOINTMENT_NOT_STARTED_DETAIL`,
 * posé par #1210, que le tiroir du comptoir et « Mon planning » lisent déjà par
 * `isAppointmentNotStartedRefusal`. La recopier ici en ferait une chaîne écrite
 * des deux côtés, et le jour où l'un des deux la changerait, le refus cesserait
 * d'être reconnu sans qu'aucun type ne bronche.
 */
export class AppointmentNotStartedError extends InvalidStateTransitionError {
  public constructor(from: AppointmentStatus, to: OutcomeStatus, startsAt: Date, now: Date) {
    super(from, to, {
      startsAt: startsAt.toISOString(),
      now: now.toISOString(),
      [APPOINTMENT_NOT_STARTED_DETAIL]: true,
    });

    // Le message du parent — « Transition « CONFIRMED » → « NO_SHOW »
    // interdite. » — est juste et n'explique rien : au comptoir, la question est
    // *pourquoi*, et la réponse est qu'il n'y a encore rien à constater. Le
    // `code` et le `status` restent ceux du parent, eux.
    this.message =
      to === 'NO_SHOW'
        ? 'Un rendez-vous qui n’a pas commencé ne peut pas être marqué « non présenté ».'
        : 'Un rendez-vous qui n’a pas commencé ne peut pas être marqué « honoré ».';
  }
}

/**
 * 404 : la ressource n'existe pas **ici**, et rien ne dit si elle existe
 * ailleurs. Même table que ci-dessus.
 */
const NOT_FOUND = DOMAIN_HTTP_STATUS.NOT_FOUND;

/**
 * Le compte connecté n'a aucune fiche praticien dans cet établissement (#811).
 *
 * ## 404, et surtout pas 403
 *
 * Le rang de l'appelant est suffisant — la garde l'a déjà jugé —, c'est la
 * **ressource** « mon agenda » qui n'existe pas : un manager qui tient le salon
 * sans y donner de soins n'a pas de fiche, et ce n'est pas un refus
 * d'autorisation. Un 403 aurait laissé croire à l'écran qu'il faut demander un
 * droit, là où il faut créer une fiche.
 *
 * ## Un code à lui, plutôt que le `NOT_FOUND` générique
 *
 * Parce qu'il est **actionnable** : c'est le seul 404 de ce module dont le front
 * puisse faire quelque chose d'utile — proposer le rattachement plutôt
 * qu'afficher un écran vide. Les autres — rendez-vous, référence — ne se
 * distinguent d'un identifiant inventé par rien, et c'est précisément ce qu'on
 * veut d'eux.
 *
 * ## `details` est vide, délibérément
 *
 * Ni `userId`, ni `tenantId` : les deux viennent du jeton de l'appelant, les lui
 * rendre ne lui apprend rien, et un corps d'erreur repart vers un journal
 * d'accès ou une capture d'écran de ticket (tenant-isolation §4).
 */
export class StaffProfileNotFoundError extends DomainError {
  public override readonly code = APPOINTMENTS_ERROR_CODES.STAFF_PROFILE_NOT_FOUND;
  public override readonly status = NOT_FOUND;

  public constructor() {
    super('Aucune fiche praticien n’est rattachée à ce compte.');
  }
}

/**
 * Le créneau a été pris entre l'affichage et la validation.
 *
 * ## Ce que cette erreur signifie exactement
 *
 * Elle n'est **jamais** levée sur la foi d'une lecture préalable. Elle traduit
 * le refus de `appointments_no_overlap` par PostgreSQL — c'est-à-dire le seul
 * arbitre qui ne puisse pas se tromper sous concurrence (ADR 0002,
 * booking-engine §1). Une vérification applicative « ce créneau est-il libre ? »
 * suivie d'un `INSERT` laisserait passer deux réservations simultanées ; la
 * contrainte, elle, en refuse une des deux, quelle que soit l'origine de
 * l'écriture.
 *
 * ## Pourquoi 409, et pourquoi cela compte
 *
 * Sans cette traduction, la perdante d'une course reçoit un **500** : un défaut
 * de programmation, du point de vue de l'appelant, là où il s'agit du
 * fonctionnement normal d'un agenda partagé. Le front ne peut alors rien faire
 * de mieux que d'afficher une erreur générique, quand un 409 lui dit exactement
 * quoi faire — réafficher les créneaux et inviter à en choisir un autre.
 *
 * ## Ce que `details` porte, et ce qu'il ne porte pas
 *
 * `staffId` et `startsAt` sont **ce que l'appelant vient d'envoyer** : les lui
 * rendre ne lui apprend rien qu'il ne sache, et lui évite de deviner lequel de
 * ses choix a fauté quand il en a soumis plusieurs.
 *
 * `staffId` vaut donc `null` quand la cliente n'a désigné personne — l'option
 * « premier disponible » de #36. Y écrire le dernier praticien tenté par
 * l'affectation apprendrait à un appelant anonyme l'identifiant d'un praticien
 * qu'il n'a jamais nommé, et ferait de ce 409 une sonde d'agenda : c'est
 * exactement ce que le paragraphe suivant interdit.
 *
 * Rien du rendez-vous **concurrent** n'est rendu — ni son identifiant, ni son
 * client, ni ses bornes exactes. Le message d'erreur de PostgreSQL les contient
 * pourtant (`Key (tenant_id, staff_id, time_range)=(…) conflicts with existing
 * key (…)`), et les recopier ferait de cet endpoint une sonde d'agenda : qui
 * peut réserver pourrait cartographier les rendez-vous d'un praticien en tirant
 * sur tous les créneaux. C'est précisément pour cela que le message d'origine
 * n'est jamais propagé — voir `appointments.conflicts.ts`.
 */
export class SlotNoLongerAvailableError extends DomainError {
  public override readonly code = APPOINTMENTS_ERROR_CODES.SLOT_NO_LONGER_AVAILABLE;
  public override readonly status = CONFLICT;

  public constructor(staffId: string | null, startsAt: Date) {
    super('Ce créneau vient d’être réservé. Choisissez-en un autre.', {
      staffId,
      // ISO 8601 avec offset explicite — le contrat n'emporte jamais une date
      // en heure murale, et un `Date` sérialisé en JSON le serait de toute façon.
      startsAt: startsAt.toISOString(),
    });
  }
}
