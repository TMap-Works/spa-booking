import type { AppointmentCancelledBy, AppointmentStatus } from './appointment-status';

/**
 * Le vocabulaire du module `appointments`, côté domaine.
 *
 * Ces formes ne sont ni des DTO HTTP ni des types générés par Prisma : ce sont
 * ce que le service et le repository acceptent et rendent (api-module §2). Les
 * DTO HTTP, eux, vivent sous `dto/`.
 *
 * TODO(#26) : `AppointmentView` appartient au contrat d'API et sera importé de
 * `@spa/shared` (`appointmentSchema`) le jour où `apps/api` dépendra du paquet —
 * même TODO que dans `catalog.types.ts` et `identity.types.ts`.
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
  /** Les coordonnées de la cliente — résolues en fiche dans la transaction. */
  readonly client: GuestContact;
  readonly staffId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Prix figé à la réservation — le tarif du catalogue peut changer ensuite. */
  readonly price: Money;
  readonly clientNote: string | null;
}

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
export interface CancelAppointmentInput {
  /** Le rendez-vous à annuler, dans l'établissement courant. */
  readonly appointmentId: string;
  readonly cancelledBy: AppointmentCancelledBy;
  /** Motif saisi, ou `null` — le CDC ne le rend obligatoire d'aucun côté. */
  readonly reason: string | null;
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
 * `@spa/shared`, côté domaine (#47).
 *
 * TODO(#26) : à importer du paquet partagé le jour où `apps/api` en dépendra.
 */
export type AppointmentScope = 'upcoming' | 'past';

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
  readonly cancellationReason?: string;
  readonly rescheduledFromId?: string;
  readonly createdAt: string;
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
