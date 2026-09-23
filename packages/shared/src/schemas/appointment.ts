/**
 * Rendez-vous — le cœur de la boucle de valeur « réserver → confirmer →
 * honorer → encaisser ».
 *
 * Trois traits de ce contrat méritent d'être lus avant d'écrire un contrôleur :
 *
 * 1. **Le client ne pose pas `endsAt`.** Il choisit un début et une prestation ;
 *    la fin se dérive de la durée du catalogue, côté serveur. Laisser le client
 *    l'envoyer reviendrait à lui laisser réserver une heure de fauteuil pour un
 *    soin de quinze minutes — ou l'inverse, et à faire chevaucher le suivant.
 * 2. **Le prix est figé à la réservation** (`price`), et non relu du catalogue à
 *    l'affichage : le tarif peut changer entre la prise de rendez-vous et la
 *    venue, le montant dû par ce client-là, non.
 * 3. **Aucun schéma ne porte `tenantId`.** Il est résolu depuis la requête. Voir
 *    l'en-tête de `./tenant`.
 *
 * ## L'asymétrie entrée / sortie sur les dates (#297)
 *
 * | Sens | Schéma | Raison |
 * |---|---|---|
 * | Entrée | `offsetDateTimeSchema` — `Z` **ou** `±HH:MM`, normalisé en UTC | ne pas faire porter la conversion au client, qui la ferait avec le fuseau de son navigateur |
 * | Sortie | `utcInstantSchema` — `…Z` seulement | un seul référentiel : deux horodatages se comparent par simple ordre lexicographique |
 *
 * Elle n'est pas un relâchement d'un côté et une rigueur de l'autre : ce qui est
 * proscrit dans les deux sens, c'est la date-heure **nue**, dont le serveur ne
 * pourrait que deviner le fuseau. `Z` est un offset explicite, donc une entrée
 * valable ; `+02:00` n'est pas une sortie valable, parce qu'il obligerait chaque
 * lecteur à normaliser avant de comparer. Voir
 * [ADR 0006](../../../../docs/adr/0006-fuseaux-horaires-tenant.md) et l'en-tête
 * de `../common/time`.
 *
 * Une conséquence à connaître avant d'écrire un client : `offsetDateTimeSchema`
 * **transforme**, si bien que le type inféré d'un champ entrant est déjà l'instant
 * UTC normalisé, pas la chaîne envoyée. C'est voulu — passé le schéma, plus
 * aucune couche n'a à se demander dans quel référentiel elle lit un horodatage —
 * et c'est la même convention que les schémas d'absence de `./availability`.
 */

import { z } from 'zod';

import {
  e164PhoneSchemaFor,
  emailSchema,
  longTextSchema,
  nameSchema,
  reasonSchema,
  uuidSchema,
} from '../common/identifiers';
import { nonNegativeMoneySchema } from '../common/money';
import {
  calendarDateSchema,
  calendarDaysBetween,
  offsetDateTimeSchema,
  utcInstantSchema,
} from '../common/time';
import {
  APPOINTMENT_REFERENCE_PATTERN,
  APPOINTMENT_STATUSES,
  CANCELLATION_ACTORS,
  normalizeAppointmentReference,
} from '../constants/appointment';
import { MAX_APPOINTMENT_RANGE_DAYS } from '../constants/limits';
import { submittedLocaleSchema } from '../locale/index';

import { serviceSummarySchema, staffMemberSummarySchema } from './catalog';
import { userSummarySchema } from './identity';

export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);

export const cancellationActorSchema = z.enum(CANCELLATION_ACTORS);

/**
 * La référence citable d'un rendez-vous, sous la forme **émise** — `RDV-8F3K-27`
 * (#796).
 *
 * Elle vient de la colonne `appointments.reference`, unique par établissement,
 * et non plus d'un calcul côté front (#736) : voir l'en-tête du bloc
 * « référence citable » de `../constants/appointment`.
 *
 * Ce schéma est **strict** parce qu'il décrit une sortie : ce que l'API rend est
 * ce que la base contient, à la casse et au séparateur près. La tolérance de
 * saisie est l'affaire de `citedAppointmentReferenceSchema` ci-dessous, et les
 * séparer est ce qui évite qu'un jour l'API se mette à émettre `a5hy14`.
 */
export const appointmentReferenceSchema = z
  .string()
  .regex(APPOINTMENT_REFERENCE_PATTERN, 'référence de rendez-vous attendue, au format RDV-XXXX-NN');

export type AppointmentReference = z.infer<typeof appointmentReferenceSchema>;

/**
 * La référence telle qu'on vient de la **dicter** — normalisée, puis jugée.
 *
 * C'est le schéma d'**entrée** : celui d'un champ de recherche au comptoir ou
 * d'un segment d'URL. Il transforme avant de valider, exactement comme
 * `offsetDateTimeSchema` normalise un instant entrant, si bien que le type
 * inféré est déjà la forme émise — passé la frontière, plus aucune couche n'a à
 * se demander dans quelle casse elle compare une référence.
 *
 * Ce qu'il absorbe et ce qu'il refuse est documenté sur
 * `normalizeAppointmentReference`. Ce qu'il **ne fait pas** : chercher. Une
 * référence bien formée qui ne désigne aucun rendez-vous de l'établissement est
 * un 404, pas un 400 — la distinction est celle entre « ce n'est pas une
 * référence » et « ce n'en est pas une d'ici ».
 */
export const citedAppointmentReferenceSchema = z
  .string()
  .transform(normalizeAppointmentReference)
  .pipe(appointmentReferenceSchema);

/**
 * Statut de rendez-vous **tel qu'il arrive du fil**, ramené au vocabulaire du
 * contrat.
 *
 * L'API émet aujourd'hui `PENDING` — la casse de l'énumération PostgreSQL que
 * Prisma génère — là où ce contrat nomme le même statut `pending`. La
 * conversion se fait donc **une fois, à la frontière**, exactement comme
 * `offsetDateTimeSchema` normalise un instant entrant : au-delà, plus aucun
 * écran n'a à se demander dans quelle casse il compare un statut.
 *
 * Ce n'est pas la forme d'arrivée définitive, et ce qui l'en sépare n'est plus
 * la dépendance — `apps/api` valide déjà ses entrées avec ce paquet
 * ([ADR 0008](../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * C'est la **casse émise** : unifier les deux vocabulaires change le format du
 * fil, et casserait tout lecteur qui n'aurait pas bougé en même temps —
 * `notifications`, `reporting` et `apps/web` compris. C'est le premier point de
 * vigilance de #510 ; le jour où il sera tranché, ce schéma pourra redevenir
 * `appointmentStatusSchema` tout court. Le laisser ici plutôt que d'écrire un
 * `.toLowerCase()` dans un composant est ce qui rend cette suppression possible
 * en un seul endroit.
 *
 * Déclaré **avant** `appointmentSchema` et non plus à côté des schémas du
 * parcours public : les deux formes de sortie du contrat s'en servent
 * désormais, la ligne d'agenda du back-office comme le rendez-vous que rend une
 * réservation (#444). Une seule des deux qui l'aurait porté aurait fait échouer
 * la lecture de l'autre sur la casse d'une chaîne — sans qu'aucun type ne le
 * signale, les deux inférant le même `AppointmentStatus`.
 */
export const receivedAppointmentStatusSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(appointmentStatusSchema);

/** Auteur d'annulation reçu du fil (`CLIENT`), même normalisation que ci-dessus. */
export const receivedCancellationActorSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(cancellationActorSchema);

/**
 * Rendez-vous tel que l'API le renvoie.
 *
 * `client`, `staff` et `service` sont imbriqués sous leur forme *summary* : un
 * agenda affiche un nom, une prestation et une heure, et n'a besoin ni de
 * l'état d'activation du compte ni de la biographie du praticien. C'est aussi
 * ce qui borne la donnée personnelle diffusée à chaque ligne d'agenda.
 *
 * **Tous les instants de cette réponse restent en `utcInstantSchema`** (#297).
 * C'est le côté « sortie » de l'asymétrie décrite en tête de fichier : émettre
 * `startsAt` avec l'offset du salon obligerait l'agenda du back-office à
 * normaliser chaque ligne avant de la trier, et deux salons de fuseaux
 * différents ne se compareraient plus du tout.
 *
 * ## Le statut est normalisé à la réception, comme celui du parcours public (#444)
 *
 * `receivedAppointmentStatusSchema` et non `appointmentStatusSchema` : l'API
 * émet la casse de l'énumération PostgreSQL (`PENDING`), et
 * `bookedAppointmentSchema` absorbe déjà cet écart depuis #45. Ce schéma-ci ne
 * le faisait pas — sans conséquence tant qu'aucune route ne le servait, mais
 * `GET /api/v1/appointments` le sert désormais, et un agenda entier échouait à
 * se lire sur la casse d'une chaîne. Le champ inféré reste `AppointmentStatus`,
 * en minuscules : rien ne change pour qui consomme ce type.
 */
export const appointmentSchema = z.object({
  id: uuidSchema,
  /**
   * La référence citable — `RDV-8F3K-27` (#796).
   *
   * Requise, et non facultative : la colonne est `NOT NULL`, toute ligne en
   * porte une, et un champ optionnel aurait laissé le comptoir afficher « — » à
   * la place d'un code qui existe toujours. C'est elle, et non `id`, que le
   * tiroir du planning montre : un UUID ne se dicte pas.
   */
  reference: appointmentReferenceSchema,
  status: receivedAppointmentStatusSchema,
  client: userSummarySchema,
  staff: staffMemberSummarySchema,
  service: serviceSummarySchema,
  startsAt: utcInstantSchema,
  endsAt: utcInstantSchema,
  /** Prix figé au moment de la réservation. */
  price: nonNegativeMoneySchema,
  clientNote: longTextSchema.optional(),
  /**
   * Note interne. **Jamais servie au parcours public** : c'est un champ de
   * back-office, et le contrat le documente ici pour que l'omission côté client
   * soit un choix visible plutôt qu'un oubli.
   */
  staffNote: longTextSchema.optional(),
  cancelledAt: utcInstantSchema.optional(),
  /**
   * De quel côté du comptoir l'annulation vient — **absent** quand il n'y a pas
   * d'auteur à nommer (#917).
   *
   * ## Un champ absent **avec** `cancelledAt` posé n'est pas une donnée manquante
   *
   * C'est l'annulation qu'un **report** (#39) produit sur la ligne d'origine :
   * `appointments.repository.ts` y pose `cancelled_at` et rien d'autre, et
   * refuse délibérément d'y inscrire un auteur — « un report n'est pas un
   * abandon ». C'est donc cette absence, et elle seule, qui distingue au
   * back-office un créneau **perdu** d'un créneau **déplacé** :
   * `rescheduledFromId` est porté par le successeur, pas par l'origine, et
   * ouvrir l'origine n'apprenait rien jusqu'ici.
   *
   * ## Pourquoi `.optional()` là où la sortie publique est `.nullable()`
   *
   * Parce que les deux vues ne sérialisent pas de la même façon, et que chacune
   * le fait explicitement : `bookedAppointmentSchema` émet toujours la clé, à
   * `null` quand elle est sans objet ; cette ligne d'agenda **omet** la clé,
   * comme elle omet déjà `cancelledAt`, `cancellationReason` et
   * `rescheduledFromId`. Les deux absences se lisent pareil — « aucun auteur » —
   * et `lib/appointment-status.ts`, côté front, les ramène à un seul cas.
   *
   * Ce que ce champ n'est **pas** : un rôle. Un `MANAGER` qui annule est du côté
   * du salon, comme un `STAFF`, et `system` n'est le rôle de personne.
   */
  cancelledBy: receivedCancellationActorSchema.optional(),
  cancellationReason: reasonSchema.optional(),
  /**
   * Le rendez-vous que celui-ci **remplace**, s'il est né d'un report.
   *
   * Absent sur un rendez-vous pris directement, ce qui est le cas de la grande
   * majorité. C'est ce champ, et lui seul, qui distingue un déplacement d'une
   * réservation neuve : sans lui, l'historique de la cliente montrerait un
   * rendez-vous annulé et un rendez-vous sans passé, au lieu d'un même
   * rendez-vous déplacé. Voir `rescheduleAppointmentRequestSchema`.
   */
  rescheduledFromId: uuidSchema.optional(),
  createdAt: utcInstantSchema,
  /**
   * Quand la cliente a accepté le traitement de ses données, en ISO 8601 UTC —
   * la **preuve de consentement** du salon (#790, CDC §5.1, RGPD art. 7.1).
   *
   * Servie ici et nulle part ailleurs, pour la raison qui vaut déjà pour
   * `staffNote` : c'est une donnée de registre, que le salon doit pouvoir
   * produire, et cette route vit derrière une garde de rôle. Le parcours public
   * n'en a aucun usage — la cliente sait ce qu'elle vient de cocher.
   *
   * Absente, et non `null`, quand il n'y en a pas : un rendez-vous saisi au
   * comptoir n'a recueilli aucun accord en ligne, et le salon répond alors de sa
   * base légale autrement. « Absent » se lit « aucun consentement en ligne »,
   * jamais « refusé » — la route publique, elle, refuse de réserver sans accord.
   */
  dataConsentAt: utcInstantSchema.optional(),
});

export type Appointment = z.infer<typeof appointmentSchema>;

/**
 * Prise de rendez-vous depuis le parcours public ou le back-office.
 *
 * `clientId` est optionnel et **réservé au back-office** : au comptoir, le staff
 * réserve pour quelqu'un d'autre. Sur le parcours public, le serveur ignore
 * cette possibilité et prend le client de la session — un client authentifié qui
 * poserait l'identifiant d'un autre ne doit pas pouvoir réserver en son nom.
 *
 * ## `staffId` est **facultatif** : c'est l'option « premier disponible » (#36)
 *
 * Le CDC §1.4 la nomme explicitement — « choix du praticien ou *premier
 * disponible* ». Son absence n'est donc pas une donnée manquante, c'est un
 * choix : la cliente dit qu'elle n'a pas de préférence, et le serveur affecte le
 * praticien **à la réservation**, selon une règle documentée dans le README du
 * module `appointments`.
 *
 * L'affectation est faite côté serveur, jamais côté client : un front qui
 * choisirait lui-même un praticien parmi ceux qu'un calendrier lui a montrés
 * décidera toujours sur un état périmé, et rouvrirait la fenêtre de concurrence
 * que le créneau sert à fermer. Le champ reste donc là pour la cliente qui **a**
 * une préférence, et pour elle seule.
 */
export const createAppointmentRequestSchema = z
  .object({
    serviceId: uuidSchema,
    /** Absent = « premier disponible ». Voir l'en-tête de ce schéma. */
    staffId: uuidSchema.optional(),
    /**
     * Début du **soin**, ISO 8601 avec offset explicite — `Z` ou `±HH:MM` (#297).
     *
     * C'est l'instant que le calendrier a affiché à la cliente, tel qu'il s'est
     * affiché. Le front n'a donc pas à le convertir avant de l'envoyer : il le
     * ferait avec le fuseau du navigateur, qui n'est pas celui du salon dès
     * qu'on réserve en voyage — et c'est exactement la conversion silencieuse
     * que la frontière existe pour empêcher.
     *
     * La normalisation en UTC a lieu **ici**, si bien que le type inféré est
     * déjà un `UtcInstant`. La date-heure nue reste refusée : son fuseau ne
     * pourrait qu'être deviné.
     */
    startsAt: offsetDateTimeSchema,
    clientId: uuidSchema.optional(),
    clientNote: longTextSchema.optional(),
  })
  .strict();

export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequestSchema>;

/**
 * Les coordonnées d'une cliente qui réserve **sans compte** (#45).
 *
 * Aucun mot de passe, et il n'y en aura pas : ce formulaire crée une fiche
 * jointe au rendez-vous, pas une identité. Le visiteur qui veut un compte passe
 * par `registerRequestSchema` ; le tunnel n'a pas à le lui imposer pour prendre
 * un rendez-vous.
 *
 * `phone` est en **E.164** et non en `phoneSchema` : c'est le numéro qu'un
 * opérateur SMS recevra pour le rappel J-1, et il n'a alors qu'une écriture
 * possible. Le champ reste facultatif — le canal obligatoire est l'e-mail de
 * confirmation, le SMS est un confort. Voir l'en-tête d'`e164PhoneSchema`.
 *
 * C'est ce schéma, et lui seul, que le formulaire de coordonnées du parcours
 * public valide : le front ne redéclare pas la règle, il importe celle-ci.
 *
 * ## Ce qu'il ne décide plus, depuis #1136
 *
 * **La cliente du rendez-vous.** Ces coordonnées ont servi à retrouver une
 * fiche par son adresse e-mail tant que réserver n'exigeait pas de compte ;
 * elles ne le font plus, et le champ `client` de
 * `bookGuestAppointmentRequestSchemaFor` est devenu facultatif et sans effet.
 * Ce schéma garde son emploi propre — valider une saisie de coordonnées — et
 * c'est le formulaire du tunnel qui le lui donne.
 *
 * ## Une **fabrique**, parce que le pays est une donnée de requête (#1028)
 *
 * `guestContactSchemaFor(pays)` plutôt qu'une constante : la septième porte du
 * téléphone — la réservation sans compte — refusait « 06 12 34 56 78 » que
 * `/auth/register` accepte sur le **même** salon. L'écart ne venait pas de la
 * règle, qui est celle d'`e164PhoneSchemaFor` des deux côtés, mais du pays :
 * les six autres portes lisent `tenants.country_code` dans un service, celle-ci
 * validait avec un schéma figé à l'amorçage de l'application.
 *
 * La fabrique déplace la décision d'un cran : le contrat continue de porter la
 * règle et **une seule fois**, et c'est l'appelant qui l'instancie avec ce qu'il
 * sait de l'établissement — le pipe à portée de requête côté API
 * (`apps/api/src/common/validation/tenant-country-validation.pipe.ts`), le pays
 * de la vitrine côté formulaire. Sans pays, le comportement est **exactement**
 * celui d'avant : un numéro national reste irrattachable, et le refuser vaut
 * mieux que deviner un indicatif — c'est-à-dire qu'envoyer le rappel de
 * quelqu'un à un inconnu.
 *
 * ## Ce schéma **est** la frontière de l'API, depuis #404
 *
 * `GuestContactDto` décrivait la même forme une seconde fois, en
 * `class-validator`, et l'écart de comportement était réel : il validait `phone`
 * avec un motif **libre borné** et conservait la saisie, là où ce schéma-ci
 * normalise et refuse un numéro national.
 *
 * Il n'y a plus d'écart, parce qu'il n'y a plus de seconde écriture :
 * `POST /api/v1/public/:tenantSlug/appointments` valide avec **cette
 * fabrique-ci**, instanciée par requête avec le pays de l'établissement du slug
 * ([ADR 0008](../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * `GuestContactDto` survit dépouillé de ses décorateurs de validation, comme
 * porteur des `@ApiProperty` d'où sort `/api/docs`.
 *
 * La conséquence pour qui écrit un formulaire de coordonnées est inchangée, et
 * désormais garantie plutôt qu'espérée : le message à afficher n'est pas
 * « l'API a refusé », c'est « ce numéro doit porter son indicatif ».
 * `apps/api/src/modules/appointments/__tests__/guest-booking-frontier.spec.ts`
 * tient le câblage — que la route est bien montée sur ce schéma-ci.
 */
export function guestContactSchemaFor(defaultCountry?: string | null) {
  return z
    .object({
      firstName: nameSchema,
      lastName: nameSchema,
      email: emailSchema,
      phone: e164PhoneSchemaFor(defaultCountry).optional(),
      /**
       * La langue dans laquelle le tunnel a été suivi — #844, huitième critère
       * d'acceptation.
       *
       * **Facultative**, et elle ne décrit pas une saisie : personne ne la tape,
       * le tunnel la constate. Absente, la fiche cliente reste sans préférence.
       *
       * Ce qu'elle produit en base est borné par une règle que le serveur tient
       * seul : la langue est **posée** sur une fiche qui n'en a pas, et une
       * préférence déjà enregistrée n'est **jamais** écrasée. La nuance est
       * celle qui protège déjà le prénom, le nom et le numéro d'une fiche
       * existante (`CrmRepository.resolveClientWithin`, « ce que cette méthode
       * ne fait pas : mettre à jour ») : un appel public ne réécrit pas le
       * dossier d'une cliente dont on connaît l'adresse. La langue fait exception
       * dans un seul sens — combler un trou —, jamais dans l'autre.
       */
      locale: submittedLocaleSchema.optional(),
    })
    .strict();
}

/**
 * Les mêmes coordonnées **sans pays par défaut** — la forme historique, et celle
 * que tout appelant qui ne connaît pas l'établissement doit prendre.
 *
 * Conservée comme valeur pour la raison qui garde `e164PhoneSchema` : plusieurs
 * fichiers la composent, et la recréer à chaque import multiplierait des objets
 * identiques. Elle reste par ailleurs la référence de la **forme** — le
 * `.strict()`, les noms de champs — que le pipe serveur vérifie à l'amorçage,
 * une fois, plutôt qu'à chaque requête.
 */
export const guestContactSchema = guestContactSchemaFor();

export type GuestContact = z.infer<typeof guestContactSchema>;

/**
 * L'accord donné au traitement des données personnelles, tel qu'il **entre**
 * dans l'API (#790).
 *
 * ## Un booléen, et pas un horodatage
 *
 * La date du consentement est posée par le **serveur**, jamais envoyée par
 * l'appelant. C'est la règle qui vaut déjà pour `status` ou pour le prix figé,
 * et elle vaut d'autant plus ici : RGPD art. 7.1 met à la charge du responsable
 * de traitement la **preuve** que le consentement a été donné, et une preuve
 * dont l'horloge appartient à celui qu'elle engage n'en est pas une. Le champ
 * dit donc l'accord, et le serveur dit quand.
 *
 * ## Pourquoi il est **obligatoire**, et pourquoi il refuse `false`
 *
 * Parce que la case est bloquante à l'écran depuis #734, et qu'une barrière
 * qui ne tient que dans le navigateur n'est pas une barrière : un appel direct
 * à la route publique la contournerait, et le salon garderait une fiche cliente
 * sans base légale pour l'avoir constituée (CDC §5.1). Le facultatif aurait
 * par ailleurs rendu le champ indistinct — « absent » se serait lu tantôt
 * « pas encore demandé », tantôt « refusé ».
 *
 * `refine` plutôt que `z.literal(true)` pour une raison de message : le refus
 * littéral de Zod 3 s'annonce « Invalid literal value, expected true », et ce
 * message-là remonte jusqu'au formulaire. C'est la même raison, et la même
 * écriture, que `consentSchema` côté web (`apps/web/lib/booking/consent.tsx`).
 */
export const dataConsentSchema = z.boolean().refine((accepted) => accepted, {
  message: 'le traitement des données doit être accepté pour réserver',
});

/**
 * Prise de rendez-vous depuis le **parcours public**, par une cliente
 * **authentifiée** (#1136).
 *
 * C'est la variante « tunnel » de `createAppointmentRequestSchema`, et la
 * différence ne tient plus à un champ du corps mais à la **porte** : là où la
 * forme de back-office désigne une fiche existante par `clientId`, celle-ci ne
 * désigne personne du tout — la cliente du rendez-vous est celle du jeton, et
 * `POST /api/v1/public/{slug}/appointments` exige ce jeton depuis #1136.
 *
 * ## Ce que #1136 a retiré à ce schéma, et pourquoi
 *
 * `client` portait les coordonnées saisies au moment de réserver, « à partir
 * desquelles le serveur crée ou retrouve la fiche ». Retrouver une fiche
 * **par son adresse e-mail** sur une route ouverte, c'était laisser n'importe
 * qui poser un rendez-vous dans le compte d'une cliente existante et repartir
 * avec son `clientId` : c'est le défaut que la campagne de QA du 22/09/2026 a
 * relevé, et il ne se corrige pas par une garde seule — une cliente
 * authentifiée aurait encore pu réserver au nom d'une autre en donnant son
 * adresse.
 *
 * Le champ est donc devenu **facultatif et sans effet**. Il n'entre plus dans
 * aucune décision du serveur : `AppointmentsService.book` prend un compte de
 * jeton vérifié (`AppointmentClientPrincipal`) et n'a plus de type pour
 * recevoir des coordonnées. Il reste accepté — et validé, quand il est là — le
 * temps que le tunnel cesse de l'envoyer : `apps/web` le poste encore depuis son
 * étape « Coordonnées », et le refuser en 400 n'apprendrait rien à personne que
 * le 401 de la route ne dise déjà. Sa suppression appartient au même diff que
 * cette étape-là, hors de l'empreinte de #1136.
 *
 * ## Ce que le `.strict()` continue de tenir
 *
 * La séparation d'avec la forme de back-office, et dans les **deux sens** :
 * celui-ci refuse un `clientId`, et `createAppointmentRequestSchema` refuse un
 * `client`. Un seul des deux suffirait à fermer la porte qu'on regarde et
 * laisserait l'autre ouverte — un `client` glissé dans une demande de
 * back-office ferait créer une fiche là où le comptoir en avait désigné une.
 * `guest-booking.spec.ts` exerce les deux (#314).
 *
 * ## Une fabrique, pour la seule raison qui vaut pour `guestContactSchemaFor`
 *
 * Le pays par défaut du téléphone (#1028), et rien d'autre : aucun autre champ
 * de cette demande ne dépend de l'établissement. La forme — les clés, le
 * `.strict()`, la version d'UUID — est donc **la même** quel que soit
 * l'argument, ce dont le pipe serveur se sert pour ne payer sa garde de champ
 * inconnu qu'une fois, à l'amorçage.
 */
export function bookGuestAppointmentRequestSchemaFor(defaultCountry?: string | null) {
  return z
    .object({
      serviceId: uuidSchema,
      /** Absent = « premier disponible ». Voir `createAppointmentRequestSchema`. */
      staffId: uuidSchema.optional(),
      /** Début du soin, ISO 8601 avec offset explicite — normalisé en UTC ici. */
      startsAt: offsetDateTimeSchema,
      /**
       * **Obsolète depuis #1136, et sans effet.** La cliente du rendez-vous est
       * celle du jeton ; ces coordonnées-là ne rattachent plus rien à personne.
       * Voir l'en-tête de ce schéma.
       */
      client: guestContactSchemaFor(defaultCountry).optional(),
      clientNote: longTextSchema.optional(),
      /**
       * L'accord au traitement des données, **obligatoire** (#790).
       *
       * C'est le seul champ de cette demande qui ne décrit pas le rendez-vous :
       * il décrit ce qui autorise le salon à en garder la trace. Voir
       * `dataConsentSchema` pour le sens de l'obligation, et
       * `appointmentSchema.dataConsentAt` pour ce que le serveur en fait.
       */
      dataConsent: dataConsentSchema,
    })
    .strict();
}

/**
 * La même demande **sans pays par défaut** — la forme historique du contrat.
 *
 * Elle reste la référence de tout ce qui ne dépend pas de l'établissement : le
 * type inféré, la garde de champ inconnu du pipe, et les suites du contrat.
 */
export const bookGuestAppointmentRequestSchema = bookGuestAppointmentRequestSchemaFor();

export type BookGuestAppointmentRequest = z.infer<typeof bookGuestAppointmentRequestSchema>;

/**
 * Report — **une annulation suivie d'une création liée**, jamais une mise à jour
 * des dates en place (booking-engine §5).
 *
 * C'est un déplacement pour la cliente, une paire de lignes pour la base, et la
 * distinction n'est pas théorique :
 *
 * - **l'historique**. Réécrire les bornes de la ligne existante efface l'heure
 *   d'origine : plus moyen de dire d'où le rendez-vous vient, ni de compter les
 *   reports d'un salon. Le rendez-vous créé porte l'identifiant de celui qu'il
 *   remplace dans `rescheduledFromId`, et celui-ci passe en `cancelled` ;
 * - **la contrainte d'exclusion**. Elle compare la ligne modifiée aux autres,
 *   elle-même comprise : avancer d'une demi-heure un soin d'une heure la ferait
 *   chevaucher son propre état antérieur, et PostgreSQL refuserait un
 *   déplacement pourtant légitime. Annuler puis créer sort la ligne de l'index
 *   partiel avant que l'insertion ne soit jugée.
 *
 * Les deux écritures sont dans **une seule transaction** : un créneau d'arrivée
 * refusé laisse le rendez-vous d'origine intact, jamais une cliente sans
 * rendez-vous du tout.
 *
 * La réponse est donc un rendez-vous **neuf**, avec un nouvel identifiant : le
 * front remplace celui qu'il gardait. `staffId` permet de changer de praticien
 * au passage, ce que le comptoir fait couramment ; absent, le praticien reste le
 * même.
 *
 * ## Le corps n'a pas changé ; la **porte**, si (#1135)
 *
 * `POST /public/{slug}/appointments/{id}/reschedule` exigeait la seule
 * connaissance de l'identifiant. Elle exige désormais le **jeton de la cliente
 * du rendez-vous** : 401 sans jeton, 403 sur un jeton de personnel, 404 sur le
 * rendez-vous d'une autre cliente. Même régime que l'annulation, et pour la même
 * raison — l'identifiant n'est plus un secret de la cliente. La route de
 * back-office, `POST /appointments/{id}/reschedule`, est inchangée.
 */
export const rescheduleAppointmentRequestSchema = z
  .object({
    /**
     * Nouveau début du soin, ISO 8601 avec offset explicite (#297) — même
     * frontière qu'à la réservation, et ce n'est pas une coïncidence : les
     * créneaux que le calendrier propose pour un report sont ceux-là mêmes qu'il
     * propose pour une réservation neuve. Deux formats d'entrée différents
     * feraient refuser au report un instant que la réservation accepte.
     */
    startsAt: offsetDateTimeSchema,
    staffId: uuidSchema.optional(),
  })
  .strict();

export type RescheduleAppointmentRequest = z.infer<typeof rescheduleAppointmentRequestSchema>;

/**
 * Annulation.
 *
 * `actor` n'est pas fourni par le client : le serveur le déduit du rôle de
 * l'appelant. Il n'apparaît donc pas ici — le motif, si.
 *
 * ## Le corps n'a pas changé ; la **porte**, si (#1135)
 *
 * `POST /public/{slug}/appointments/{id}/cancel` exigeait la seule connaissance
 * de l'identifiant du rendez-vous. Elle exige désormais le **jeton de la cliente
 * du rendez-vous** : 401 sans jeton, 403 sur un jeton de personnel, 404 sur le
 * rendez-vous d'une autre cliente — indiscernable d'un identifiant inconnu. Un
 * appelant qui envoyait ce corps sans en-tête `Authorization` doit donc en
 * ajouter un ; rien d'autre ne bouge.
 *
 * La route de back-office, `POST /appointments/{id}/cancel`, est inchangée :
 * même corps, mêmes permissions `appointment:write:own|all`, et la portée du
 * praticien y reste jugée en 403 `OWN_SCOPE_ONLY` (#812).
 */
export const cancelAppointmentRequestSchema = z
  .object({
    reason: reasonSchema.optional(),
  })
  .strict();

export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentRequestSchema>;

/**
 * Changement de statut par le back-office — `confirmed`, `completed`, `no_show`.
 *
 * La transition est validée par `canTransitionAppointment` ; une transition non
 * prévue par le cycle de vie sort en `INVALID_STATE_TRANSITION`.
 */
export const changeAppointmentStatusRequestSchema = z
  .object({
    status: appointmentStatusSchema,
    reason: reasonSchema.optional(),
  })
  .strict();

export type ChangeAppointmentStatusRequest = z.infer<typeof changeAppointmentStatusRequestSchema>;

/**
 * Filtres de l'agenda du back-office.
 *
 * Les bornes sont des **dates civiles** et non des instants : un agenda se
 * consulte « du 3 au 9 mars » dans le calendrier de l'établissement. La
 * conversion vers les instants UTC de la requête se fait côté serveur, avec le
 * fuseau du tenant — c'est le seul endroit qui le connaisse.
 *
 * C'est pourquoi `from` et `to` **ne basculent pas** sur `offsetDateTimeSchema`
 * (#297), alors que ce sont bien des champs entrants : la question ne se pose
 * pas pour eux. Une date civile n'est pas un instant mal formé, c'est une autre
 * nature de donnée — « le 3 mars » ne commence pas au même moment à Papeete et à
 * Paris. Leur adjoindre un offset laisserait l'appelant décider où commence la
 * journée de l'établissement, qui est précisément ce que `tenants.timezone`
 * tranche. Voir l'en-tête de `../common/time`.
 *
 * `statuses` accepte plusieurs valeurs pour la vue « à venir » (`pending` +
 * `confirmed`), qui est l'écran par défaut du comptoir.
 *
 * ## Les deux bornes, et pourquoi elles sont dans le contrat (#444)
 *
 * Les `refine` bornent la fenêtre à `MAX_APPOINTMENT_RANGE_DAYS`, exactement
 * comme `availabilityQuerySchema` borne la sienne. La raison n'est pas la même :
 * l'agenda ne calcule rien, il lit — mais une semaine de back-office porte
 * plusieurs centaines de lignes, chacune avec sa cliente, son praticien et sa
 * prestation imbriqués. Une plage non bornée est donc une réponse dont la taille
 * ne dépend que de l'appelant, et le refus sort en
 * `APPOINTMENT_RANGE_TOO_WIDE` plutôt qu'en temps de réponse qui s'allonge.
 *
 * Les deux bornes sont **facultatives**, et la garde ne s'applique qu'au couple
 * effectivement fourni : c'est le serveur qui complète l'autre — la journée
 * courante de l'établissement —, parce que lui seul connaît le fuseau dans
 * lequel « aujourd'hui » veut dire quelque chose.
 */
export const appointmentListQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    staffId: uuidSchema.optional(),
    clientId: uuidSchema.optional(),
    serviceId: uuidSchema.optional(),
    statuses: z.array(appointmentStatusSchema).nonempty().optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.to >= query.from, {
    message: 'la fin de la plage ne peut pas précéder son début',
    path: ['to'],
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      calendarDaysBetween(query.from, query.to) <= MAX_APPOINTMENT_RANGE_DAYS,
    {
      message: `la plage demandée dépasse ${String(MAX_APPOINTMENT_RANGE_DAYS)} jours`,
      path: ['to'],
    },
  );

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

// ---------------------------------------------------------------------------
// Ce que le parcours public reçoit en retour d'une réservation — #45
// ---------------------------------------------------------------------------

/**
 * Le rendez-vous que rendent les routes publiques de réservation, de report et
 * d'annulation.
 *
 * Distinct d'`appointmentSchema`, qui décrit la ligne d'agenda du back-office :
 * celle-ci imbrique les *summaries* de la cliente, du praticien et de la
 * prestation, parce qu'un agenda affiche des noms. Le parcours public, lui,
 * **connaît déjà** ces noms — c'est lui qui vient de les choisir dans le
 * catalogue — et reçoit des identifiants. Servir les *summaries* ici
 * diffuserait à un appelant non authentifié l'identité d'une cliente à partir
 * du seul identifiant d'un rendez-vous.
 *
 * Non `.strict()`, comme les autres schémas de sortie du contrat : un champ que
 * l'API ajouterait ne doit pas faire échouer un front qui ne s'en sert pas.
 *
 * `clientNote`, `rescheduledFromId`, `cancelledAt` et `cancelledBy` sont
 * `nullable` et non `optional` : l'API les émet toujours, à `null` quand ils
 * sont sans objet. Un `cancelledBy` à `null` **avec** un `cancelledAt` posé
 * n'est pas une donnée manquante — c'est l'annulation qu'un report produit sur
 * la ligne d'origine, où il n'y a pas d'auteur à nommer.
 */
export const bookedAppointmentSchema = z.object({
  id: uuidSchema,
  /**
   * La référence citable — c'est elle que l'écran de confirmation affiche
   * (#736, #796).
   *
   * Servie au parcours **public** à dessein, et sans que cela ouvre quoi que ce
   * soit : la cliente reçoit la référence de son propre rendez-vous, celui
   * qu'elle vient de prendre. Ce que la référence permet de faire — résoudre un
   * rendez-vous à partir d'elle — est derrière une garde `STAFF` et n'a aucune
   * surface publique, précisément parce qu'un code de six symboles s'énumère là
   * où un UUID v4 ne s'énumère pas (tenant-isolation §4).
   */
  reference: appointmentReferenceSchema,
  status: receivedAppointmentStatusSchema,
  serviceId: uuidSchema,
  staffId: uuidSchema,
  clientId: uuidSchema,
  startsAt: utcInstantSchema,
  endsAt: utcInstantSchema,
  /** Prix figé au moment de la réservation. */
  price: nonNegativeMoneySchema,
  clientNote: longTextSchema.nullable(),
  rescheduledFromId: uuidSchema.nullable(),
  cancelledAt: utcInstantSchema.nullable(),
  cancelledBy: receivedCancellationActorSchema.nullable(),
});

export type BookedAppointment = z.infer<typeof bookedAppointmentSchema>;

// ---------------------------------------------------------------------------
// L'historique de l'espace client — #47
// ---------------------------------------------------------------------------

/**
 * Les deux moitiés de l'historique d'une cliente connectée : « à venir » et
 * « passés ».
 *
 * Ce n'est **pas** un filtre de statut, et les confondre serait une erreur
 * d'affichage visible : un rendez-vous annulé pour demain n'est pas à venir —
 * il n'y a plus rien à honorer —, et il n'est pas non plus perdu, il descend
 * dans l'historique avec sa mention d'annulation. La frontière est donc « ce
 * qu'il me reste à honorer » d'un côté, « tout le reste » de l'autre, et le
 * serveur la trace parce qu'il est le seul à connaître l'heure de référence.
 *
 * Distinct d'`appointmentListQuerySchema`, qui est l'agenda du **comptoir** :
 * celui-ci porte un `clientId` en filtre, ce que la surface cliente ne doit
 * jamais accepter — le client d'une lecture « mes rendez-vous » vient du jeton
 * vérifié, jamais de la requête (tenant-isolation §2).
 */
export const appointmentScopeSchema = z.enum(['upcoming', 'past']);

export type AppointmentScope = z.infer<typeof appointmentScopeSchema>;

/** Moitié servie quand la requête n'en désigne aucune — l'écran d'accueil du compte. */
export const DEFAULT_APPOINTMENT_SCOPE = 'upcoming' satisfies AppointmentScope;

/** Nombre de rendez-vous rendus quand la requête ne demande rien de particulier. */
export const MY_APPOINTMENTS_DEFAULT_LIMIT = 20;

/**
 * Plafond dur du nombre de rendez-vous rendus en une fois.
 *
 * Il existe parce qu'une cliente fidèle d'un salon peut accumuler des centaines
 * de lignes, et qu'une réponse non bornée finirait par coûter plus cher à
 * construire qu'à lire. La pagination complète du CDC §1.4 relève du back-office
 * et de `paginationQuerySchema` ; ici, un plafond suffit — l'espace client montre
 * les prochains rendez-vous et les dernières visites, pas un registre.
 */
export const MY_APPOINTMENTS_MAX_LIMIT = 100;

/**
 * Filtres de l'historique de la cliente connectée.
 *
 * `z.coerce` sur `limit` parce que la valeur arrive d'une chaîne de requête :
 * sans lui, `?limit=5` serait refusé pour cause de type, ce qui ferait passer
 * une borne parfaitement valide pour une erreur de saisie.
 */
export const myAppointmentsQuerySchema = z
  .object({
    scope: appointmentScopeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MY_APPOINTMENTS_MAX_LIMIT).optional(),
  })
  .strict();

export type MyAppointmentsQuery = z.infer<typeof myAppointmentsQuerySchema>;
