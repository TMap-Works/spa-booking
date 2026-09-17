// `AppointmentScope` vient du **contrat partagé** depuis #510 : les deux moitiés
// de l'historique d'une cliente y portent les mêmes deux mots, dans la même
// casse — c'est le seul vocabulaire de ce module qui échappe à la divergence de
// casse de l'énumération PostgreSQL, parce qu'aucune colonne ne le stocke.
import type { AppointmentScope } from '@spa/shared';

import type { UserRole } from '../identity/roles';
import type { AppointmentCancelledBy, AppointmentStatus } from './appointment-status';

/**
 * Le vocabulaire du module `appointments`, côté domaine.
 *
 * Ces formes ne sont ni des DTO HTTP ni des types générés par Prisma : ce sont
 * ce que le service et le repository acceptent et rendent (api-module §2). Les
 * DTO HTTP, eux, vivent sous `dto/`.
 *
 * L'accord avec le contrat se vérifie à la **frontière** depuis #510 :
 * `dto/book-appointment.dto.ts` et `dto/list-appointments.dto.ts` portent des
 * assertions de compilation contre `z.input<bookedAppointmentSchema>` et
 * `z.input<appointmentSchema>`, et un champ ajouté d'un côté et pas de l'autre
 * casse le `tsc`.
 *
 * Écart assumé, tranché en #554 : remplacer `AppointmentView` par le type inféré du contrat reste
 * souhaitable, et deux choses s'y opposent, dont aucune ne se tranche depuis ce
 * module. La première est le **statut** : `AppointmentStatus` porte ici la casse
 * de l'énumération PostgreSQL (`PENDING`), là où `appointmentStatusSchema` du
 * contrat porte le même mot en minuscules — c'est le premier point de vigilance
 * de #510, et l'importer changerait le format du fil. La seconde est
 * `readonly`, que `z.infer<...>` ne porte pas.
 */

/**
 * Un montant, tel que tout le schéma le porte : un entier dans la plus petite
 * unité monétaire, accompagné de son code ISO 4217. Jamais de flottant, et
 * jamais d'entier sans sa devise — un prix sans devise n'est pas un prix.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * Ce qu'il faut pour poser un rendez-vous.
 *
 * **Aucun `tenantId`**, et c'est structurel : le tenant vient du contexte de
 * requête et c'est l'extension Prisma qui le pose (tenant-isolation §3). Un
 * champ ici l'exposerait à venir du corps de la requête, ce qui est exactement
 * la fuite que le scoping automatique supprime.
 *
 * `startsAt` et `endsAt` sont des instants UTC. La durée réellement occupée —
 * soin plus tampons de part et d'autre — est calculée en amont par le moteur de
 * disponibilité (#34) : ce module reçoit l'intervalle, il ne le devine pas.
 *
 * ## Des **coordonnées**, et non un `clientId` (#313)
 *
 * Jusqu'à #313, le service résolvait la fiche cliente avant de composer ce
 * brouillon, et n'y posait qu'un identifiant. C'était une écriture publique dans
 * `users` **validée avant** l'insertion du rendez-vous : la perdante d'une course
 * pour un créneau repartait avec un 409 et laissait sa fiche au fichier du salon.
 *
 * Porter les coordonnées jusqu'ici est ce qui permet au repository de résoudre la
 * cliente **dans la transaction** qui pose le rendez-vous — donc de tout perdre
 * d'un même `ROLLBACK`. Le prix est que ce type transporte une donnée personnelle
 * de plus ; il ne quitte jamais le module, et rien de ce qu'il porte ne ressort
 * dans `AppointmentRecord`.
 */
export interface AppointmentDraft {
  /** La cliente — coordonnées à résoudre, ou fiche déjà désignée (#461). */
  readonly client: ClientReference;
  readonly staffId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Prix figé à la réservation — le tarif du catalogue peut changer ensuite. */
  readonly price: Money;
  readonly clientNote: string | null;
  /**
   * L'instant où la cliente a accepté le traitement de ses données, ou `null`
   * (#790).
   *
   * Un instant, et non le booléen reçu : la conversion se fait **une fois**, dans
   * le service, à partir de l'horloge qu'il porte déjà en paramètre. C'est la
   * conduite de `CancelDraft.cancelledAt`, et pour la même raison — une preuve
   * horodatée par un `new Date()` enfoui dans le repository ne serait observable
   * par aucun test sans décaler l'horloge de la machine.
   *
   * `null` pour la prise de rendez-vous **au comptoir** (#461) : personne n'y a
   * coché de case. Ce n'est pas un refus, c'est une autre base légale.
   */
  readonly dataConsentAt: Date | null;
}

/**
 * De qui est le rendez-vous — les deux seules façons de le dire, et elles ne se
 * mélangent pas (#461).
 *
 * | Forme | Surface | Ce que le repository en fait |
 * |---|---|---|
 * | `{ contact }` | tunnel public (#37) | demande la fiche à `crm`, qui la crée si elle manque |
 * | `{ clientId }` | comptoir (#461) | l'écrit telle quelle, et laisse la clé étrangère la juger |
 *
 * C'est la même frontière que `packages/shared` tient par le `.strict()` de ses
 * deux schémas — `bookGuestAppointmentRequestSchema` refuse un `clientId`,
 * `createAppointmentRequestSchema` refuse un `client`. Une union, et non deux
 * champs facultatifs : deux champs auraient laissé passer les deux à la fois,
 * c'est-à-dire un tunnel public capable de réserver au nom d'une fiche qu'il
 * aurait désignée.
 *
 * La forme `{ clientId }` ne relâche rien sur la frontière du tenant, et ce
 * n'est pas ce fichier qui le tient : `appointments.client_id` porte la clé
 * étrangère composite `(tenant_id, client_id)`, si bien qu'une fiche du salon
 * voisin fait échouer l'insertion en base. `AppointmentsRepository` traduit ce
 * refus en 404 — jamais 403, qui confirmerait l'existence de la fiche
 * (tenant-isolation §4).
 */
export type ClientReference =
  | { readonly contact: GuestContact }
  | { readonly clientId: string };

/**
 * Un rendez-vous, sous la forme que le module manipule.
 *
 * Pas de `tenantId` : il n'apporte rien à l'appelant et invite aux essais
 * (tenant-isolation §4). Pas de `timeRange` non plus — l'intervalle est une
 * colonne générée, une projection de `startsAt` et `endsAt` qui n'ajoute aucune
 * information et que Prisma ne sait de toute façon pas lire.
 */
export interface AppointmentRecord {
  readonly id: string;
  /**
   * La référence citable — `RDV-8F3K-27` (#796).
   *
   * Lue sur la ligne, jamais recalculée : c'est une colonne, unique par
   * établissement, posée au tirage à l'insertion. La recalculer ici depuis `id`
   * serait revenir à la dérivation de #736, qui ne garantit rien.
   */
  readonly reference: string;
  readonly clientId: string;
  readonly staffId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: AppointmentStatus;
  readonly price: Money;
  readonly clientNote: string | null;
  /**
   * Le rendez-vous que celui-ci remplace, ou `null` s'il a été pris directement
   * (#39).
   *
   * `null` se lit « pris directement », jamais « inconnu » : la colonne est
   * nullable et sans défaut, et rien d'autre que le report ne l'écrit.
   */
  readonly rescheduledFromId: string | null;
  /**
   * Quand le rendez-vous a été annulé, ou `null` (#40).
   *
   * C'est cette borne qui gouverne les deux champs suivants : nulle, il n'y a
   * jamais eu d'annulation et le reste n'a aucun sens.
   */
  readonly cancelledAt: Date | null;
  /**
   * De quel côté du comptoir l'annulation vient, ou `null` (#40).
   *
   * `null` **avec** un `cancelledAt` posé est un cas réel, et non une donnée
   * manquante : c'est l'annulation qu'un report (#39) produit sur la ligne
   * d'origine, où il n'y a pas d'auteur d'annulation à nommer.
   */
  readonly cancelledBy: AppointmentCancelledBy | null;
  /**
   * Le motif saisi, ou `null` (#40).
   *
   * Texte libre écrit par un humain — donc traité comme une donnée personnelle
   * potentielle : il ne part dans aucun événement de domaine ni dans aucun
   * journal (CDC §5.1), et `AppointmentView` ne le rend pas.
   */
  readonly cancellationReason: string | null;
}

/**
 * Ce qu'une annulation demande, telle que le **service** la reçoit (#40).
 *
 * Ni statut, ni horodatage : le premier est la destination fixe de cette
 * opération, le second est posé par le serveur. Les laisser entrer par le corps
 * de la requête ferait d'une annulation une écriture d'agenda arbitraire.
 *
 * `cancelledBy` ne vient **jamais** du corps non plus : c'est la surface qui le
 * détermine — la route publique dit `CLIENT`, la route de back-office dit
 * `STAFF`. Un champ de requête l'aurait laissé à la main de l'appelant, et une
 * cliente aurait pu inscrire au registre du salon que le salon l'avait annulée.
 */
/**
 * Qui agit, quand la portée du geste dépend de lui — #812, troisième critère.
 *
 * ## Pourquoi cette forme entre dans le domaine plutôt que de rester à la porte
 *
 * Parce que la question « ce rendez-vous est-il le vôtre ? » ne se répond pas
 * sans le lire, et qu'une garde ne lit aucune ressource — c'est ce qui rend son
 * 403 indiscernable d'une route à l'autre (`roles.guard.ts`). La garde de
 * permission tranche donc l'accès à la **route** ; la portée, elle, se tranche
 * ici, après la lecture, et le refus est un `OwnScopeOnlyError`.
 *
 * ## `undefined` n'est pas « aucun droit », c'est « aucune restriction »
 *
 * Les deux mêmes méthodes servent le tunnel public, où il n'y a ni jeton ni
 * personnel : une cliente qui annule son propre rendez-vous n'a pas de fiche
 * praticien à comparer. L'absence d'acteur s'y lit « la portée n'est pas la
 * question sur cette porte-là », et c'est la porte — non le corps de la requête
 * — qui en décide, comme pour `cancelledBy`.
 */
export interface AppointmentActor {
  /** Le compte du jeton vérifié, jamais un identifiant reçu de l'appelant. */
  readonly userId: string;
  /**
   * Son rôle, tel que le jeton le porte. La portée s'en déduit par la matrice de
   * permissions (`identity/permissions.ts`), jamais par un rang comparé ici :
   * deux écritures de la même décision finissent par différer.
   */
  readonly role: UserRole;
}

export interface CancelAppointmentInput {
  /** Le rendez-vous à annuler, dans l'établissement courant. */
  readonly appointmentId: string;
  readonly cancelledBy: AppointmentCancelledBy;
  /** Motif saisi, ou `null` — le CDC ne le rend obligatoire d'aucun côté. */
  readonly reason: string | null;
  /**
   * L'auteur, quand la porte en impose un — le back-office. Absent sur le tunnel
   * public : voir {@link AppointmentActor}.
   */
  readonly actor?: AppointmentActor;
}

/**
 * Ce que le repository écrit lors d'une annulation — la trace, et rien d'autre.
 *
 * `cancelledAt` est porté par ce type plutôt que produit dans le repository pour
 * la raison qui vaut partout ailleurs dans ce module : l'horloge est un
 * paramètre, jamais un `new Date()` enfoui — c'est ce qui rend l'horodatage
 * observable en test sans décaler celle de la machine.
 */
export interface CancelDraft {
  readonly appointmentId: string;
  readonly cancelledAt: Date;
  readonly cancelledBy: AppointmentCancelledBy;
  readonly reason: string | null;
}

/**
 * Les coordonnées d'une cliente qui réserve **sans compte** — le quatrième
 * critère de #37.
 *
 * `users.password_hash` est nullable précisément pour cela : « un client peut
 * exister sans compte, saisi au comptoir par le staff » (schéma Prisma). Une
 * fiche est donc créée, mais aucune identité : pas de mot de passe, pas de
 * session, rien à quoi se connecter.
 *
 * `phone` est facultatif : le SMS de rappel est un confort, l'e-mail de
 * confirmation est le canal obligatoire (CDC §1.4). Exiger un numéro ferait
 * abandonner des réservations pour un canal que le salon n'utilise peut-être
 * pas.
 */
export interface GuestContact {
  readonly firstName: string;
  readonly lastName: string;
  /** Canonisée — élaguée, en minuscules — avant d'atteindre ce type. */
  readonly email: string;
  readonly phone: string | null;
}

/**
 * Ce qu'une réservation demande, telle que le **service** la reçoit.
 *
 * `startsAt` est l'instant du **soin**, celui que le moteur de disponibilité a
 * proposé et que la cliente a vu s'afficher — jamais l'instant occupé. La
 * conversion de l'un vers l'autre, tampons compris, appartient au service et à
 * lui seul : c'est ce que `AppointmentDraft` porte ensuite.
 *
 * `staffId` est `null` quand la cliente n'a **pas** de préférence : c'est
 * l'option « premier disponible » du CDC §1.4 (#36). Le domaine ne connaît que
 * `null` — le DTO, lui, distingue « absent » de « vide ». L'affectation du
 * praticien revient alors au service, jamais à l'appelant : voir la règle
 * documentée dans `AppointmentsService.book`.
 */
export interface BookAppointmentInput {
  readonly serviceId: string;
  /** Praticien désigné, ou `null` pour « premier disponible ». */
  readonly staffId: string | null;
  readonly startsAt: Date;
  readonly client: GuestContact;
  readonly clientNote: string | null;
  /**
   * L'accord au traitement des données personnelles — le seul champ de cette
   * demande qui ne décrit pas le rendez-vous (#790, CDC §5.1).
   *
   * Un booléen ici, un instant en base : le service pose la date depuis son
   * horloge, jamais l'appelant (voir `AppointmentDraft.dataConsentAt`). Le
   * contrat partagé le rend obligatoire et refuse `false`, si bien qu'il vaut
   * `true` sur tout appel qui a franchi la frontière — le type reste un booléen
   * parce que le domaine n'a pas à dépendre de la façon dont un schéma
   * d'entrée le garantit.
   *
   * Absent de `CreateAppointmentInput`, et c'est la seule asymétrie de fond
   * entre les deux surfaces : au comptoir, la cliente n'est pas devant un
   * écran.
   */
  readonly dataConsent: boolean;
}

/**
 * Ce qu'une prise de rendez-vous **au comptoir** demande, telle que le service
 * la reçoit (#461, `createAppointmentRequestSchema`).
 *
 * La jumelle de `BookAppointmentInput`, et l'unique différence est la cliente :
 * ici une **fiche déjà au fichier du salon**, là-bas des coordonnées saisies par
 * une visiteuse. Tout le reste — l'instant du soin, le praticien facultatif, le
 * mot de la cliente — est rigoureusement le même, et c'est voulu : un créneau
 * proposé par le calendrier doit se réserver de la même façon des deux côtés du
 * comptoir.
 *
 * `clientId` n'est **pas** facultatif, là où le contrat partagé le déclare
 * `.optional()`. L'écart est délibéré et va dans le sens strict : le contrat
 * décrit une forme que le parcours client pourrait servir un jour — « le serveur
 * prend le client de la session » —, et cette route-ci n'a pas de cliente dans
 * son jeton, qui est celui d'un membre du personnel. L'omettre est donc une
 * saisie incomplète, et un 400 nommant le champ vaut mieux qu'un rendez-vous
 * posé au nom de personne.
 *
 * **Aucun `tenantId`**, pour la raison structurelle qui vaut partout dans ce
 * module : c'est l'extension Prisma qui le pose depuis le contexte de requête.
 */
export interface CreateAppointmentInput {
  readonly serviceId: string;
  /** Praticien désigné, ou `null` pour « premier disponible » (#36). */
  readonly staffId: string | null;
  /** Instant du **soin**, tel que le calendrier l'a proposé. */
  readonly startsAt: Date;
  /** La fiche cliente, dans l'établissement du jeton. */
  readonly clientId: string;
  readonly clientNote: string | null;
}

/**
 * Ce qu'un changement de statut demande, tel que le **service** le reçoit
 * (#461, `changeAppointmentStatusRequestSchema`).
 *
 * `reason` n'a de destination que sur `CANCELLED` : c'est la colonne
 * `cancellation_reason`, et il n'y a pas de colonne pour motiver un no-show ou
 * un soin honoré. Le contrat partagé le porte tout de même sur toutes les
 * transitions, et cette forme le suit plutôt que d'en refuser la moitié — un
 * corps que le contrat annonce ne doit pas sortir en 400.
 */
export interface ChangeAppointmentStatusInput {
  /** Le rendez-vous à faire avancer, dans l'établissement courant. */
  readonly appointmentId: string;
  /** Statut visé — jugé par `AppointmentLifecycleService`, jamais ici. */
  readonly status: AppointmentStatus;
  /** Motif saisi, ou `null`. Consigné sur une annulation, ignoré ailleurs. */
  readonly reason: string | null;
  /** L'auteur — voir {@link AppointmentActor}. */
  readonly actor?: AppointmentActor;
}

/**
 * Ce que le repository écrit lors d'un changement de statut — le statut
 * **attendu** et le statut visé, et rien d'autre (#461).
 *
 * `from` n'est pas une commodité : c'est ce qui fait de l'écriture un
 * test-et-pose atomique. L'`UPDATE` filtre dessus et rend un compte, si bien que
 * deux transitions concurrentes du même rendez-vous se sérialisent sur le verrou
 * de ligne et qu'une seule aboutit — même conduite que `CancelDraft`, et pour la
 * raison de booking-engine §1 : ce n'est jamais une lecture qui décide.
 */
export interface StatusChangeDraft {
  readonly appointmentId: string;
  readonly from: AppointmentStatus;
  readonly to: AppointmentStatus;
}

/**
 * Ce qu'un report demande, tel que le **service** le reçoit (#39).
 *
 * Ni `serviceId`, ni coordonnées de cliente, ni prix : reporter ne change ni la
 * prestation, ni la personne, ni le montant dû. Les laisser entrer par le corps
 * de la requête ferait d'un déplacement d'heure une réécriture de commande, sur
 * une surface publique de surcroît.
 *
 * `staffId` est facultatif : le salon change couramment de praticien à
 * l'occasion d'un report, et son absence signifie « le même qu'avant ».
 */
export interface RescheduleAppointmentInput {
  /** Le rendez-vous à déplacer, dans l'établissement courant. */
  readonly appointmentId: string;
  /** Instant du **soin** souhaité — jamais l'intervalle occupé. */
  readonly startsAt: Date;
  /** Nouveau praticien, ou `null` pour conserver celui du rendez-vous d'origine. */
  readonly staffId: string | null;
  /** L'auteur, quand la porte en impose un — voir {@link AppointmentActor}. */
  readonly actor?: AppointmentActor;
}

/**
 * Ce que le repository écrit lors d'un report — l'intervalle **occupé** du
 * nouveau rendez-vous, et rien d'autre.
 *
 * Tout le reste — cliente, prestation, prix figé, note de la cliente, note
 * interne du staff, statut — est recopié du rendez-vous d'origine **dans la
 * transaction**, depuis la ligne que le repository vient de relire. Le faire
 * passer par ce type l'exposerait à être modifié en chemin, et le rendrait
 * dépendant d'une lecture faite avant que le verrou d'agenda ne soit pris.
 *
 * La note interne (`staff_note`) est le cas limite qui montre pourquoi ce type
 * ne porte rien (#317) : elle est recopiée sans jamais ressortir. Un champ ici
 * l'aurait fait entrer par la demande — donc, à terme, par un corps de requête —
 * une note de back-office qu'aucune surface publique ne doit pouvoir écrire.
 */
export interface RescheduleDraft {
  readonly previousId: string;
  readonly staffId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Les deux rendez-vous d'un report, tels que le repository les rend.
 *
 * `previous` est la ligne **telle qu'elle était avant l'annulation** — son
 * statut d'origine, son ancien créneau. C'est ce dont l'appelant a besoin :
 * l'événement de domaine annonce d'où le rendez-vous part, et le statut d'avant
 * est celui que le nouveau rendez-vous a repris.
 */
export interface RescheduleOutcome {
  readonly previous: AppointmentRecord;
  readonly created: AppointmentRecord;
}

/**
 * Les deux moitiés de l'historique d'une cliente — `appointmentScopeSchema` de
 * `@spa/shared` (#47).
 *
 * **Importé du contrat partagé** depuis #510, et réexporté d'ici pour les
 * appelants du module qui le lisaient déjà à cette adresse. L'union valait
 * `'upcoming' | 'past'` des deux côtés : la substitution n'a donc changé aucun
 * vocabulaire, elle a seulement supprimé la seconde écriture qui aurait pu, elle,
 * diverger — et c'est le seul type de ce fichier que la casse de l'énumération
 * PostgreSQL ne sépare pas du contrat, `appointments.scope` n'étant pas une
 * colonne.
 */
export type { AppointmentScope };

/**
 * Ce qu'une lecture d'historique demande, telle que le **service** la reçoit
 * (#47).
 *
 * `clientId` vient du jeton vérifié et de nulle part d'autre : ce type le porte
 * parce que le service en a besoin, pas parce qu'un appelant a le droit de le
 * choisir. Le contrôleur le prend dans `@CurrentUser()` ; il n'y a aucun DTO
 * dans lequel il puisse entrer, ce qui est ce qui empêche une cliente de lire
 * l'historique d'une autre.
 *
 * **Aucun `tenantId`**, pour la raison structurelle qui vaut partout dans ce
 * module : c'est l'extension Prisma qui le pose depuis le contexte de requête.
 */
export interface ListClientAppointmentsInput {
  readonly clientId: string;
  readonly scope: AppointmentScope;
  /** Nombre maximal de lignes rendues — borné par le DTO, jamais illimité. */
  readonly limit: number;
}

/**
 * Ce que le repository lit pour un historique — la moitié demandée, bornée
 * (#47).
 *
 * `now` est un paramètre plutôt qu'un `new Date()` enfoui, pour la raison qui
 * vaut dans tout ce module : la frontière entre « à venir » et « passé » se teste
 * en décalant l'horloge de l'appelant, jamais celle de la machine.
 */
export interface ClientAppointmentsQuery {
  readonly clientId: string;
  readonly scope: AppointmentScope;
  readonly now: Date;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// L'agenda du back-office — #444
// ---------------------------------------------------------------------------

/**
 * Ce que l'agenda du comptoir demande, tel que le **service** le reçoit (#444).
 *
 * Les bornes sont des **dates civiles de l'établissement** et non des instants :
 * un agenda se consulte « du 3 au 9 mars » dans le calendrier du salon. La
 * conversion vers les instants UTC de la lecture se fait dans le service, avec
 * `tenants.timezone` — c'est le seul endroit qui le connaisse, et laisser
 * l'appelant envoyer des instants reviendrait à le laisser décider où commence
 * la journée du salon (`appointmentListQuerySchema` de `@spa/shared`).
 *
 * Les deux sont **facultatives** : absentes, le service sert la journée courante
 * de l'établissement. C'est lui qui complète, parce que « aujourd'hui » n'a de
 * sens que dans un fuseau.
 *
 * **Aucun `tenantId`**, pour la raison structurelle qui vaut partout dans ce
 * module : c'est l'extension Prisma qui le pose depuis le contexte de requête.
 * Un `clientId` figure en revanche parmi les filtres, et c'est délibéré — cette
 * surface vit derrière `@AuthAtLeast('STAFF')`, à la différence de l'historique
 * de #47 où le client vient du jeton et de nulle part d'autre.
 */
export interface ListAgendaInput {
  /** Premier jour de la plage, borne comprise, ou `null` pour aujourd'hui. */
  readonly from: string | null;
  /** Dernier jour de la plage, borne comprise, ou `null` pour `from`. */
  readonly to: string | null;
  readonly staffId: string | null;
  readonly clientId: string | null;
  readonly serviceId: string | null;
  /** Statuts retenus, ou `null` pour tous — jamais une liste vide. */
  readonly statuses: readonly AppointmentStatus[] | null;
}

/**
 * Ce que le repository lit pour un agenda — la fenêtre **en instants**, et les
 * filtres tels quels (#444).
 *
 * La fenêtre est déjà résolue : les dates civiles ont été converties par le
 * service, qui seul connaît le fuseau. Le repository ne fait donc aucune
 * arithmétique de calendrier, ce qui est ce qui empêche un jour de changement
 * d'heure de perdre une heure d'agenda.
 *
 * `to` est la borne **haute exclue** — le minuit du salon qui suit le dernier
 * jour demandé, tel que `TenantClockService.dayRange` le rend.
 */
export interface AgendaQuery {
  readonly from: Date;
  readonly to: Date;
  readonly staffId: string | null;
  readonly clientId: string | null;
  readonly serviceId: string | null;
  readonly statuses: readonly AppointmentStatus[] | null;
}

/** La cliente d'une ligne d'agenda — `userSummarySchema` de `@spa/shared`. */
export interface AgendaClientSummary {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** Le praticien d'une ligne d'agenda — `staffMemberSummarySchema`. */
export interface AgendaStaffSummary {
  readonly id: string;
  readonly displayName: string;
}

/**
 * La prestation d'une ligne d'agenda — `serviceSummarySchema`, plus le tampon
 * avant.
 *
 * `bufferBeforeMinutes` n'appartient pas au *summary* du contrat et n'est jamais
 * rendu : il sert à retrouver l'intervalle **facturé** depuis l'intervalle
 * occupé qui est en base, exactement comme `billedView` le fait ailleurs dans ce
 * module. Le lire sur la même requête est ce qui évite une lecture du catalogue
 * par ligne d'agenda.
 *
 * `price` est le tarif **courant** du catalogue, pas celui figé sur le
 * rendez-vous : les deux voyagent côte à côte dans la réponse, et les confondre
 * ferait afficher au comptoir un montant que la cliente ne doit pas.
 */
export interface AgendaServiceSummary {
  readonly id: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly price: Money;
}

/**
 * Une ligne d'agenda, telle que le repository la rend (#444).
 *
 * Élargit `AppointmentRecord` de ce que seule cette lecture demande, et de rien
 * d'autre :
 *
 * - les trois *summaries*, lues par jointure sur la même requête. Un agenda
 *   affiche des noms, et les résoudre ligne par ligne ferait N+1 requêtes sur un
 *   écran qui en montre plusieurs centaines ;
 * - `staffNote`, la note interne du praticien. C'est la « sortie distincte,
 *   gardée par un rôle » qu'annonçait déjà `RESCHEDULE_SOURCE_SELECT` (#317) :
 *   elle ne peut pas entrer dans `AppointmentRecord`, qui sert aussi le parcours
 *   public ;
 * - `createdAt`, que `appointmentSchema` du contrat rend obligatoire — c'est ce
 *   qui permet au comptoir de distinguer une réservation de la veille d'une
 *   ligne posée à l'instant.
 *
 * Toujours pas de `tenantId` : il n'apporte rien à l'appelant et invite aux
 * essais (tenant-isolation §4).
 */
export interface AgendaAppointmentRecord extends AppointmentRecord {
  readonly client: AgendaClientSummary;
  readonly staff: AgendaStaffSummary;
  readonly service: AgendaServiceSummary;
  /** Note interne du praticien, `null` quand il n'y en a pas. */
  readonly staffNote: string | null;
  readonly createdAt: Date;
  /**
   * La preuve de consentement, `null` quand il n'y en a pas (#790).
   *
   * Lue ici et non dans `AppointmentRecord`, exactement pour la raison qui y
   * garde `staffNote` : `APPOINTMENT_SELECT` sert six lectures du module, dont
   * l'historique public de #47 et la réservation d'invitée. Une donnée de
   * registre n'a rien à faire sur ces sorties-là — le salon la produit, la
   * cliente n'en a pas l'usage.
   */
  readonly dataConsentAt: Date | null;
}

/**
 * Une ligne d'agenda telle que l'API la rend — `appointmentSchema` de
 * `@spa/shared`, champ pour champ (#444).
 *
 * ## Pourquoi une seconde vue, alors qu'`AppointmentView` existe
 *
 * Parce qu'elles ne servent pas les mêmes appelants, et que le contrat partagé
 * les distingue déjà : `AppointmentView` est ce que le **parcours public**
 * reçoit — des identifiants, jamais des noms, jamais de note interne, jamais le
 * motif d'annulation. Celle-ci est la ligne de comptoir : elle imbrique les
 * *summaries* parce qu'un agenda affiche « Camille — Massage 60 min », et elle
 * porte la note interne et le motif parce que la route vit derrière
 * `@AuthAtLeast('STAFF')`.
 *
 * Fondre les deux aurait fait sortir la note interne du praticien sur la route
 * publique de réservation le jour où quelqu'un l'aurait ajoutée à la vue
 * commune — précisément ce que l'en-tête d'`AppointmentView` interdit.
 *
 * ## Les champs facultatifs sont **absents**, jamais `null`
 *
 * `appointmentSchema` les déclare `.optional()` et non `.nullable()` : un `null`
 * explicite y échouerait. C'est pourquoi cette forme les déclare `?` — la
 * sérialisation JSON omet alors la clé, ce qui est exactement ce que le contrat
 * décrit. La sortie publique fait l'inverse, `nullable`, et c'est le contrat qui
 * en décide, pas ce module.
 *
 * ## `startsAt` / `endsAt` sont l'intervalle **facturé**
 *
 * Comme partout ailleurs dans ce module : la base stocke l'intervalle occupé —
 * tampons compris, parce que c'est cela que la contrainte d'exclusion doit
 * comparer —, la réponse rend le soin. Un agenda qui afficherait 09:50–11:10
 * pour un massage de 10:00 à 11:00 ferait apparaître la cadence interne du salon
 * comme si c'était l'heure du rendez-vous.
 */
export interface AgendaAppointmentView {
  readonly id: string;
  /**
   * La référence citable, telle que le comptoir la lit et la dicte (#796).
   *
   * C'est ce que le tiroir du planning affiche : une cliente qui appelle en
   * disant « RDV-A5HY-14 » doit trouver le même code sous les yeux de la
   * personne qui décroche.
   */
  readonly reference: string;
  readonly status: AppointmentStatus;
  readonly client: AgendaClientSummary;
  readonly staff: AgendaStaffSummary;
  readonly service: {
    readonly id: string;
    readonly name: string;
    readonly durationMinutes: number;
    readonly price: Money;
  };
  /** Début du **soin**, en ISO 8601 UTC. */
  readonly startsAt: string;
  /** Fin du **soin**, en ISO 8601 UTC. */
  readonly endsAt: string;
  /** Prix figé à la réservation — jamais relu du catalogue. */
  readonly price: Money;
  readonly clientNote?: string;
  /** Note interne du praticien — **jamais** servie au parcours public (#317). */
  readonly staffNote?: string;
  readonly cancelledAt?: string;
  /**
   * De quel côté du comptoir l'annulation vient — **absent** quand il n'y a
   * personne à nommer (#917).
   *
   * Le repository le lit depuis toujours (`APPOINTMENT_SELECT`) ; c'est la
   * sérialisation qui le perdait, et avec lui la seule chose qui distingue au
   * planning un créneau **perdu** d'un créneau **déplacé** : un report pose
   * `cancelled_at` sur la ligne d'origine sans y inscrire d'auteur. Absent
   * **avec** `cancelledAt` posé se lit donc « déplacé », jamais « auteur
   * inconnu ».
   *
   * Absent et non `null`, comme les autres facultatifs de cette vue.
   */
  readonly cancelledBy?: AppointmentCancelledBy;
  readonly cancellationReason?: string;
  readonly rescheduledFromId?: string;
  readonly createdAt: string;
  /**
   * Quand la cliente a accepté le traitement de ses données, en ISO 8601 UTC —
   * **absent** quand il n'y a pas d'accord en ligne (#790).
   *
   * Absent et non `null`, comme les autres facultatifs de cette vue :
   * `appointmentSchema` les déclare `.optional()`, et un `null` explicite y
   * échouerait.
   */
  readonly dataConsentAt?: string;
}

/**
 * Le rendez-vous tel que l'API le rend.
 *
 * ## `startsAt` / `endsAt` sont l'intervalle **facturé**, pas l'intervalle occupé
 *
 * La base stocke ce que le praticien ne peut pas faire autre chose — tampon
 * avant, soin, tampon après —, parce que c'est cela que la contrainte
 * d'exclusion doit comparer. Ce que la cliente a réservé, en revanche, c'est le
 * soin : lui rendre 09:50–11:10 pour un massage de 10:00 à 11:00 ferait mentir
 * son écran de confirmation, et lui apprendrait au passage la cadence interne du
 * salon — que `PublicServiceView` cache délibérément.
 *
 * Les deux formes du créneau et leur asymétrie sont celles d'`availability.slots.ts` :
 * la grille se pose sur l'occupé, la sortie rend le facturé.
 */
export interface AppointmentView {
  readonly id: string;
  /**
   * La référence citable — `RDV-8F3K-27` (#736, #796).
   *
   * Rendue au parcours **public** à dessein : c'est la preuve de réservation que
   * l'écran de confirmation affiche, et celle que l'e-mail reprend. La cliente
   * reçoit la référence du rendez-vous qu'elle vient de prendre, et d'aucun
   * autre.
   *
   * Ce que cela n'ouvre pas : la **résolution**. Aller d'une référence à un
   * rendez-vous est derrière `@AuthAtLeast('STAFF')`, et n'a aucune surface
   * publique — six symboles s'énumèrent là où un UUID v4 ne s'énumère pas
   * (tenant-isolation §4).
   */
  readonly reference: string;
  readonly status: AppointmentStatus;
  readonly serviceId: string;
  readonly staffId: string;
  readonly clientId: string;
  /** Début du **soin**, en ISO 8601 UTC. */
  readonly startsAt: string;
  /** Fin du **soin**, en ISO 8601 UTC. */
  readonly endsAt: string;
  /** Prix figé à la réservation. */
  readonly price: Money;
  readonly clientNote: string | null;
  /**
   * Le rendez-vous que celui-ci remplace, ou `null` (#39).
   *
   * Rendu au parcours public **à dessein** : c'est ce qui permet à l'écran de
   * confirmation d'un report d'annoncer « votre rendez-vous du 3 mars a été
   * déplacé » plutôt que d'afficher une réservation neuve. L'identifiant rendu
   * est celui que l'appelant vient d'envoyer — il ne lui apprend rien.
   */
  readonly rescheduledFromId: string | null;
  /** Instant de l'annulation en ISO 8601 UTC, ou `null` (#40). */
  readonly cancelledAt: string | null;
  /**
   * De quel côté du comptoir l'annulation vient, ou `null` (#40).
   *
   * Rendu au parcours public **à dessein** : « votre rendez-vous a été annulé
   * par le salon » et « vous avez annulé ce rendez-vous » ne s'affichent pas de
   * la même façon, et le front n'a aucun autre moyen de les distinguer.
   *
   * ## Ce que cette vue ne porte **pas** : le motif
   *
   * `cancellation_reason` est un texte libre saisi par un humain. Celui qu'une
   * cliente écrit lui appartient ; celui qu'un praticien écrit est une note
   * interne — « cliente injoignable », « désistement répété » — et n'a rien à
   * faire sur l'écran de la cliente. Or `AppointmentView` est la sortie unique
   * du module : elle servira l'historique client de #47 aussi bien que la
   * réponse de l'annulation. Un champ ajouté ici pour l'écho immédiat d'une
   * saisie serait devenu une fuite le jour de la première lecture d'historique.
   *
   * Le motif est **enregistré** — c'est le deuxième critère de #40 — et se relit
   * depuis la ligne par qui a le droit de le voir.
   */
  readonly cancelledBy: AppointmentCancelledBy | null;
}

// ---------------------------------------------------------------------------
// L'espace du praticien connecté — #811
// ---------------------------------------------------------------------------

/**
 * La fiche praticien d'un compte, telle que ce module la lit.
 *
 * **Sans `userId`**, alors que c'est par lui qu'on l'a trouvée : l'appelant
 * *est* ce compte, et le lui rendre n'apprendrait rien — c'est la même
 * discipline que `StaffMemberDto` du catalogue, qui le masque déjà. Sans
 * `tenantId` non plus, pour la raison de tenant-isolation §4.
 */
export interface StaffProfileRecord {
  readonly id: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly isActive: boolean;
}

/**
 * La même fiche, telle que l'API la rend — `staffMemberSchema` de `@spa/shared`.
 *
 * Une seule différence avec la ligne lue, et elle est imposée par le contrat :
 * `bio` y est `.optional()` et non `.nullable()`, si bien qu'un `null` explicite
 * ferait échouer la lecture de la fiche entière. Absent se lit « pas de
 * présentation », ce qui est exactement ce que la colonne nulle veut dire.
 *
 * C'est le même régime que les facultatifs d'`AgendaAppointmentView`, et la
 * raison pour laquelle la conversion ne se fait pas au repository : la colonne
 * est nullable, c'est un fait du schéma ; l'omission est une décision de
 * frontière.
 */
export interface StaffProfileView {
  readonly id: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly isActive: boolean;
}

/**
 * La fenêtre d'un agenda une fois **résolue** : bornes complétées, écart jugé,
 * et le fuseau dans lequel les deux dates se lisent.
 *
 * Le fuseau voyage avec elles parce que sans lui deux dates civiles ne
 * désignent aucun intervalle : « du 1er au 7 » ne vaut pas les mêmes instants à
 * Paris et à Papeete, et c'est ce couple-là — jamais une date seule — que la
 * conversion en instants consomme.
 *
 * Rendue par `resolveAgendaRange` d'`agenda-window.ts`, et consommée par
 * `agendaWindowOf` : c'est la forme que les **trois** lectures d'agenda
 * partagent depuis #932 — le comptoir comme les deux routes du praticien
 * connecté —, et non plus celle des seules lectures « mes … ».
 */
export interface ResolvedRange {
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
}

/**
 * Ce que le praticien connecté demande de son agenda ou de son emploi du temps.
 *
 * Il n'y a **aucun `staffId`**, et c'est tout le propos du ticket : le périmètre
 * se dérive de `(tenantId, userId)` du jeton, jamais d'un paramètre
 * (tenant-isolation §2). Le type l'interdit au même titre que le schéma
 * `.strict()` du contrat le refuse en 400 — deux barrières pour la même règle,
 * l'une à la compilation, l'autre à la frontière HTTP.
 *
 * Les deux bornes sont facultatives, comme celles de l'agenda du comptoir : le
 * service complète avec la journée courante **du salon**, seul référentiel dans
 * lequel « aujourd'hui » veut dire quelque chose.
 */
export interface MyStaffRangeInput {
  readonly userId: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** La cliente d'une ligne de planning — prénom, et initiale du nom (CDC §5.1). */
export interface MyStaffAppointmentClientView {
  readonly firstName: string;
  readonly lastInitial: string;
}

/**
 * Un rendez-vous tel que le praticien connecté le lit —
 * `myStaffAppointmentSchema` de `@spa/shared`.
 *
 * `startsAt` / `endsAt` sont l'intervalle **facturé**, comme partout dans ce
 * module. `utcOffsetMinutes` est le décalage du salon **à cet instant-là** : une
 * fenêtre d'un mois peut enjamber un changement d'heure, et un décalage porté
 * par la réponse plutôt que par la ligne en aurait faussé la moitié.
 */
export interface MyStaffAppointmentView {
  readonly id: string;
  readonly reference: string;
  readonly status: AppointmentStatus;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly utcOffsetMinutes: number;
  readonly service: {
    readonly id: string;
    readonly name: string;
    readonly durationMinutes: number;
  };
  readonly client: MyStaffAppointmentClientView;
  readonly clientNote?: string;
  readonly staffNote?: string;
}

/** Le planning du praticien connecté — `myStaffAgendaSchema`. */
export interface MyStaffAgendaView {
  readonly staffId: string;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly appointments: readonly MyStaffAppointmentView[];
}

/** Une plage de travail récurrente — `staffScheduleEntrySchema`. */
export interface MyStaffScheduleEntryView {
  readonly weekday: number;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Une absence du praticien — `staffTimeOffSchema`. */
export interface MyStaffTimeOffView {
  readonly id: string;
  readonly staffId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason: string | null;
}

/**
 * L'emploi du temps du praticien connecté — `myStaffScheduleSchema`.
 *
 * Les trois sources qui déterminent ce qu'il travaille, servies ensemble parce
 * qu'aucune ne se lit sans les deux autres : un écran qui n'aurait que les
 * plages récurrentes afficherait « lundi 9 h – 18 h » sur un lundi fermé.
 */
export interface MyStaffScheduleView {
  readonly staffId: string;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly entries: readonly MyStaffScheduleEntryView[];
  readonly timeOff: readonly MyStaffTimeOffView[];
  readonly closedWeekdays: readonly number[];
}
