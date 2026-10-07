import { z } from 'zod';

import {
  displayNameSchema,
  longTextSchema,
  nameSchema,
  storedPhoneSchema,
  uuidSchema,
} from '../common/identifiers';
import {
  calendarDateSchema,
  durationMinutesSchema,
  timeZoneSchema,
  utcInstantSchema,
} from '../common/time';
import { appointmentReferenceSchema, receivedAppointmentStatusSchema } from './appointment';
import { isoWeekdaySchema, staffScheduleEntrySchema, staffTimeOffSchema } from './availability';
import { staffMemberSchema } from './catalog';

/**
 * L'espace du **praticien connecté** — « les staffs doivent avoir un aperçu de
 * leur emploi du temps » (#811, CDC §1.3 « Comptes staff, rôles,
 * disponibilités »).
 *
 * ## Pourquoi un fichier à part, et non trois ajouts dans trois fichiers
 *
 * Parce que les trois réponses décrites ici ne sont pas trois entités de plus :
 * c'est **une seule surface**, celle du praticien qui regarde son propre agenda,
 * et elle emprunte sa matière à trois modules à la fois — la fiche vient du
 * catalogue, les rendez-vous du cycle de vie, les horaires et les absences de la
 * disponibilité. Les disperser aurait fait chercher en trois endroits le contrat
 * d'un seul écran, et surtout dilué la propriété qui les tient toutes :
 *
 * > **le praticien n'est jamais un paramètre.**
 *
 * `receipt.ts` est le même cas de figure — une surface, pas un module.
 *
 * ## Ce que ces trois schémas ne portent pas, et c'est structurel
 *
 * Aucun `staffId` **en entrée**. Les deux schémas de requête sont `.strict()` et
 * ne déclarent que la fenêtre : un `?staffId=` y sort en **400 comme champ
 * inconnu**, exactement comme un `?tenantId=`. Le périmètre d'une lecture
 * « mes … » se dérive du jeton vérifié et de rien d'autre (tenant-isolation §2),
 * et c'est `myAppointmentsQuerySchema` — l'historique de la cliente — qui a posé
 * ce précédent. La différence avec `appointmentListQuerySchema`, qui porte bien
 * un `staffId`, n'est pas un oubli : celui-là est l'agenda du **comptoir**, où
 * choisir le praticien qu'on regarde est le geste courant.
 *
 * En **sortie**, en revanche, `staffId` est rendu : l'appelant vient d'apprendre
 * quelle fiche le serveur a résolue pour lui, ce qui n'est une information
 * d'aucun autre établissement et ce dont l'écran a besoin pour recouper ses
 * appels.
 *
 * ## Les instants restent en UTC, et l'offset voyage à côté
 *
 * Même asymétrie que partout dans ce contrat : `utcInstantSchema` en sortie, et
 * jamais une date-heure décalée. Un planning a pourtant besoin de l'heure
 * **murale** du salon — c'est elle qui est écrite sur la porte de la cabine —,
 * d'où `utcOffsetMinutes`, porté **par rendez-vous** et non par la réponse. Une
 * fenêtre de trente et un jours peut enjamber un changement d'heure : un offset
 * global aurait décalé d'une heure la moitié des lignes, ce que CLAUDE.md classe
 * en bug de sévérité haute.
 */

/**
 * Bornes plausibles d'un décalage horaire, en minutes.
 *
 * Les extrêmes réels de la base tzdata sont `-12:00` (Etc/GMT+12) et `+14:00`
 * (Pacific/Kiritimati). Les borner ici n'attrape aucune faute de saisie — cette
 * valeur est calculée par le serveur, jamais reçue — mais fait échouer à la
 * compilation, puis au test de contrat, un jour où un calcul d'offset rendrait
 * des millisecondes ou des secondes au lieu de minutes.
 */
export const UTC_OFFSET_MINUTES_MIN = -720;
export const UTC_OFFSET_MINUTES_MAX = 840;

/**
 * La fenêtre d'une lecture « mes … », en dates civiles du salon.
 *
 * Les deux bornes sont **facultatives** et se complètent l'une l'autre, comme
 * celles de l'agenda du comptoir : absentes toutes les deux, la réponse sert la
 * journée courante **du salon**, que seul le serveur sait nommer. Le plafond de
 * `MAX_APPOINTMENT_RANGE_DAYS` est jugé côté serveur et sort en 422, pour la
 * raison qui vaut déjà là-bas — chaque date est bien écrite, c'est leur écart
 * qui n'est pas servable, et un `refine` ici l'aurait rendu en 400.
 */
export const myStaffRangeQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
  })
  .strict();

export type MyStaffRangeQuery = z.infer<typeof myStaffRangeQuerySchema>;

/**
 * La fiche praticien du compte connecté — `GET /v1/me/staff-profile`.
 *
 * C'est **exactement** `staffMemberSchema`, et l'alias est délibéré plutôt
 * qu'une forme de plus. Le praticien qui ouvre son espace doit y lire la fiche
 * que le back-office administre — même nom public, même biographie, même état
 * d'activation —, et deux formes auraient fini par diverger d'un champ sur le
 * même objet. Ce qui distingue cette route n'est pas ce qu'elle rend, c'est la
 * façon dont elle désigne la fiche : par le jeton, jamais par un identifiant.
 *
 * `userId` n'y figure pas, comme il ne figure pas dans `staffMemberSchema` :
 * l'appelant **est** ce compte, et le lui rendre n'apprendrait rien.
 */
export const myStaffProfileSchema = staffMemberSchema;

export type MyStaffProfile = z.infer<typeof myStaffProfileSchema>;

/**
 * La cliente d'une ligne de planning : de quoi la recevoir, l'appeler, et ne
 * pas lui faire ce qui lui est contre-indiqué.
 *
 * ## Ce que ce schéma portait, et pourquoi il ne le porte plus — #1404
 *
 * Il portait `firstName` + `lastInitial`, et rien d'autre : « le praticien a
 * besoin de reconnaître qui il reçoit, pas de tenir le fichier client », la
 * minimisation du CDC §5.1 appliquée à l'écran le plus ouvert du salon. La
 * campagne de QA du 02/10 a montré que cette minimisation **ne protégeait
 * rien** : la même praticienne, avec le même jeton, lit déjà nom complet,
 * téléphone et e-mail dans « Clients ». `customers:read:own` lui est accordée en
 * toutes lettres par `apps/api/src/modules/identity/permissions.ts` — « Le
 * praticien a besoin de la fiche de la personne qu'il va recevoir — allergie,
 * préférence — et d'aucune autre ». Minimiser **ici seulement** ne retirait donc
 * aucune donnée à personne : cela obligeait la praticienne à ouvrir un second
 * écran pour lire ce que le premier avait le droit de lui dire, et une allergie
 * se découvrait après le soin plutôt qu'avant.
 *
 * La minimisation reste celle du CDC §5.1, et elle se mesure désormais à la
 * **personne** plutôt qu'à l'écran : ce contrat ne rend que ce que
 * `customers:read:own` ouvre déjà, et toujours **borné aux rendez-vous du
 * praticien** — la route ne sait pas nommer une autre cliente que les siennes.
 * Ce qui reste dehors le reste : ni e-mail, ni adresse, ni historique, ni état
 * de délivrabilité. Le même écart est ouvert pour l'agenda du comptoir sous
 * #977, et sera tranché là-bas.
 *
 * ## `id` est là pour une raison précise, et une seule
 *
 * Remonter à la fiche — le lien « Voir la fiche » du détail déplié
 * (BM-AGENDA-09). Ce n'est pas un identifiant à rejouer en écriture : aucune
 * route de ce contrat ne le reçoit, et l'ouvrir dans « Clients » repasse par la
 * garde de portée de `crm`, qui refuse une fiche qui n'est pas de sa clientèle.
 */
export const myStaffAppointmentClientSchema = z
  .object({
    /** De quoi ouvrir sa fiche, et rien de plus — voir l'en-tête. */
    id: uuidSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    /**
     * Son numéro, ou `null` — une fiche saisie au comptoir peut n'en porter
     * aucun (`users.phone` est nullable).
     *
     * `.nullable()` et non `.optional()`, comme `customerSummarySchema` : l'API
     * émet toujours la clé, et un front qui distingue « absente » de « vide »
     * finit par afficher `undefined`.
     *
     * `storedPhoneSchema` et non `phoneSchema` : c'est une **sortie**, et elle
     * doit pouvoir rendre un numéro déjà en base qu'un plancher de chiffres
     * posé depuis refuserait — sans quoi la lecture d'un planning entier
     * échouerait sur une ligne historique.
     */
    phone: storedPhoneSchema.nullable(),
    /**
     * L'alerte de sa fiche — allergie, contre-indication —, ou `null`.
     *
     * C'est `users.internal_note`, le « notes internes distinctes des
     * informations visibles du client » du CDC §2.3, et le champ porte ici le
     * **même nom** que dans `customerSchema` : une donnée, un nom, quel que soit
     * l'écran qui la lit. Ce que l'écran en fait — un bandeau au-dessus des
     * notes plutôt qu'une ligne parmi elles (BM-COMPTOIR-05) — est une décision
     * d'affichage, et la figer dans le contrat l'aurait rendue non révocable.
     *
     * À ne pas confondre avec `staffNote` de `myStaffAppointmentSchema` : celle-là
     * est la note de **ce rendez-vous**, celle-ci vaut pour la personne et
     * survit à tous ses rendez-vous.
     */
    internalNote: longTextSchema.nullable(),
  })
  .strict();

export type MyStaffAppointmentClient = z.infer<typeof myStaffAppointmentClientSchema>;

/**
 * Un rendez-vous tel que le praticien connecté le lit.
 *
 * Volontairement **plus étroit** qu'`appointmentSchema` : ni prix figé, ni tarif
 * courant, ni motif d'annulation, ni preuve de consentement, ni `staff`
 * imbriqué. Le praticien sait qui il est, et un planning n'est pas un registre —
 * chaque champ servi ici répond à « qu'est-ce que je fais à cette heure-là, et
 * pour qui ». Les champs écartés ont leur route, gardée au même rang : l'agenda
 * du comptoir.
 *
 * **Sauf sur un bloc, depuis #1404** : `client` y est plus riche que celui du
 * comptoir, qui s'en tient au *summary*. L'inversion n'est pas un oubli — c'est
 * le praticien qui prépare la cabine, et c'est à lui que l'alerte de la fiche
 * manquait. Le raisonnement est écrit en tête de
 * `myStaffAppointmentClientSchema`, et l'écart ouvert pour le comptoir est #977.
 *
 * `startsAt` / `endsAt` sont l'intervalle **facturé** — le soin —, comme partout
 * dans ce contrat : l'intervalle occupé, tampons de cabine compris, est la
 * cadence interne du salon et ne s'affiche nulle part.
 */
export const myStaffAppointmentSchema = z
  .object({
    id: uuidSchema,
    /** La référence citable — celle que la cliente dicte au téléphone (#796). */
    reference: appointmentReferenceSchema,
    status: receivedAppointmentStatusSchema,
    startsAt: utcInstantSchema,
    endsAt: utcInstantSchema,
    /**
     * Décalage du salon **à l'instant de ce rendez-vous**, en minutes.
     *
     * `60` un 1er janvier à Paris, `120` un 1er juillet. Porté par la ligne et
     * non par la réponse : voir l'en-tête de ce fichier.
     */
    utcOffsetMinutes: z
      .number()
      .int()
      .min(UTC_OFFSET_MINUTES_MIN)
      .max(UTC_OFFSET_MINUTES_MAX),
    service: z
      .object({
        id: uuidSchema,
        name: displayNameSchema,
        durationMinutes: durationMinutesSchema,
      })
      .strict(),
    client: myStaffAppointmentClientSchema,
    /** Mot de la cliente au salon — absent s'il n'y en a pas. */
    clientNote: longTextSchema.optional(),
    /**
     * Note interne du salon, servie ici pour la raison qui la sert à l'agenda du
     * comptoir : c'est un champ de back-office, et cette route vit derrière une
     * garde de rôle. Le praticien en est le premier lecteur — c'est souvent lui
     * qui l'a écrite.
     */
    staffNote: longTextSchema.optional(),
  })
  .strict();

export type MyStaffAppointment = z.infer<typeof myStaffAppointmentSchema>;

/**
 * Le planning du praticien connecté — `GET /v1/me/appointments`.
 *
 * La fenêtre **résolue** est rendue avec la liste : l'appelant qui n'a rien
 * demandé doit savoir quelle journée le salon lui a servie, et le sien n'est pas
 * forcément celui de son navigateur.
 *
 * `appointments` est trié **chronologiquement**, sur l'instant facturé — celui
 * que la réponse porte.
 */
export const myStaffAgendaSchema = z
  .object({
    staffId: uuidSchema,
    timezone: timeZoneSchema,
    from: calendarDateSchema,
    to: calendarDateSchema,
    appointments: z.array(myStaffAppointmentSchema),
  })
  .strict();

export type MyStaffAgenda = z.infer<typeof myStaffAgendaSchema>;

/**
 * L'emploi du temps du praticien connecté — `GET /v1/me/schedule`.
 *
 * Les trois choses qui déterminent ce qu'il travaille, servies ensemble parce
 * qu'aucune ne se lit sans les deux autres : ses plages récurrentes, ses
 * absences sur la fenêtre, et les jours où le salon n'ouvre pour personne. Un
 * écran qui n'aurait que les premières afficherait « lundi 9 h – 18 h » sur un
 * lundi fermé.
 *
 * `entries` porte des **heures murales**, `timeOff` des **instants UTC** : ce
 * n'est pas une incohérence, c'est la nature des deux objets. « J'ouvre à 9 h »
 * reste vrai des deux côtés d'un changement d'heure ; « je suis absent du 3 au
 * 5 » désigne deux instants précis. `timezone` est ce dans quoi les premières se
 * lisent.
 */
export const myStaffScheduleSchema = z
  .object({
    staffId: uuidSchema,
    timezone: timeZoneSchema,
    from: calendarDateSchema,
    to: calendarDateSchema,
    entries: z.array(staffScheduleEntrySchema),
    /** Les absences **qui touchent la fenêtre**, bornes de l'absence entière. */
    timeOff: z.array(staffTimeOffSchema),
    /** Jours de fermeture récurrents de l'établissement, en numérotation ISO. */
    closedWeekdays: z.array(isoWeekdaySchema),
  })
  .strict();

export type MyStaffSchedule = z.infer<typeof myStaffScheduleSchema>;
