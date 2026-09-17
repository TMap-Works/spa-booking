import type {
  AppointmentCancelledBy,
  AppointmentStatus,
} from '../appointments/appointment-status';
// Même import que le précédent, et pour la même raison : un **vocabulaire** de
// module voisin, en `import type`, effacé à la compilation. Ce n'est pas
// l'import du repository d'un autre module qu'api-module §3 interdit — c'est le
// nom de l'énumération que la colonne `users.email_suppression_reason` écrit, et
// la recopier ici aurait créé une seconde définition de « pourquoi une adresse
// est morte », divergente au premier motif ajouté.
import type { EmailSuppressionReason } from '../notifications/notifications.types';

/**
 * Vocabulaire du module `crm` — ce qui franchit la frontière du service, jamais
 * une entité Prisma (api-module §4).
 *
 * L'accord avec le contrat se vérifie à la **frontière** depuis #510 :
 * `dto/customer.dto.ts` porte des assertions de compilation contre
 * `z.input<customerSummarySchema>` et `z.input<customerPageSchema>`, et un champ
 * ajouté d'un côté et pas de l'autre casse le `tsc`.
 *
 * Écart assumé, tranché en #554 : remplacer ces interfaces par les types inférés du contrat reste
 * souhaitable, et trois choses s'y opposent, dont aucune ne se tranche depuis ce
 * module :
 *
 * 1. **la casse des statuts.** `CustomerVisit.status` porte la casse de
 *    l'énumération PostgreSQL (`COMPLETED`) ; `appointmentStatusSchema` du
 *    contrat porte le même mot en minuscules. C'est le premier point de
 *    vigilance de #510 — même constat que dans `reporting.types.ts` ;
 * 2. **`readonly`.** `z.infer<...>` ne le porte pas, là où toutes les vues de ce
 *    fichier le sont ;
 * 3. **deux des trois champs de #81** — `marketingConsent` et
 *    `marketingConsentAt` —, que `customerSchema` ne décrit pas encore, et qui
 *    sont déjà la raison pour laquelle `CustomerDto` n'a pas d'assertion de jeu
 *    de clés (voir son en-tête). Le troisième, `anonymizedAt`, est entré au
 *    contrat en #529 : le back-office en a besoin pour taire l'avis d'adresse
 *    supprimée sur une fiche anonymisée.
 */

/**
 * Fiche cliente réduite — la forme des listes.
 *
 * Ni `internalNote`, ni `role`, ni `createdAt` : une liste de deux cents fiches
 * ferait transiter deux cents notes de deux mille caractères qu'aucun tableau
 * n'affiche. Ce qui n'est pas lu ne peut pas fuiter.
 */
export interface CustomerSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
}

/**
 * Fiche cliente complète — la forme de `GET /customers/:id`.
 *
 * `internalNote` n'apparaît que sur cette forme-ci, servie au rang `STAFF` et
 * au-dessus. C'est la moitié applicative du « notes internes distinctes des
 * informations visibles du client » ; l'autre moitié est la colonne, que rien
 * du parcours public ne lit.
 */
export interface Customer extends CustomerSummary {
  internalNote: string | null;
  createdAt: Date;
  /**
   * Consentement au démarchage commercial — #81, CDC §5.1.
   *
   * Ne gouverne **pas** les notifications transactionnelles (confirmation,
   * rappel J-1, annulation) : celles-là relèvent de l'exécution du contrat.
   */
  marketingConsent: boolean;
  /**
   * Instant du dernier changement de `marketingConsent` — la preuve que
   * l'art. 7.1 du RGPD met à la charge du responsable de traitement.
   *
   * `null` tant que personne ne s'est prononcé : « jamais demandé » n'est pas
   * « refusé à telle date ».
   */
  marketingConsentAt: Date | null;
  /**
   * Instant de l'anonymisation, ou `null` sur une fiche vivante — #81.
   *
   * Daté, la fiche ne porte plus qu'un pseudonyme : ses rendez-vous, ses
   * encaissements et ses tickets restent comptés, sans personne au bout.
   */
  anonymizedAt: Date | null;
  /**
   * Instant auquel l'adresse a cessé d'être écrite, ou `null` — #73, #525.
   *
   * Posé par l'ingestion d'un événement de remise SES
   * (`DeliveryEventRepository.suppressEmails`), jamais par ce module : le
   * fichier client **lit** cet état, il ne le décide pas. Sans lui, un
   * gestionnaire voit une réservation confirmée sans jamais savoir que la
   * cliente n'a rien reçu et ne recevra plus rien.
   */
  emailSuppressedAt: Date | null;
  /**
   * Ce qui a valu la suppression — nul exactement quand `emailSuppressedAt`
   * l'est.
   *
   * « Rebond définitif » et « plainte » n'appellent pas la même conversation au
   * comptoir : la première se corrige en redemandant l'adresse, la seconde ne se
   * corrige pas du tout.
   */
  emailSuppressionReason: EmailSuppressionReason | null;
}

/** Une page de fiches, avec de quoi afficher un sélecteur de page. */
export interface CustomerPage {
  items: CustomerSummary[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * Une visite, telle que l'historique la rend.
 *
 * `startsAt` et `endsAt` sont l'intervalle **facturé** — l'heure du soin, celle
 * que la cliente a lue en réservant et que le planning affiche —, et non
 * l'intervalle occupé que porte la colonne. Les tampons de préparation et de
 * finition du CDC §2.3 bloquent la cabine sans être facturés : les montrer ici
 * ferait annoncer chaque visite cinq à dix minutes avant l'heure du rendez-vous
 * (#750). La conversion est celle d'`appointments/billed-interval.ts`, la même
 * que celle de l'agenda.
 *
 * ## Une seule des deux notes du rendez-vous y figure — #870
 *
 * `clientNote`, ce que le client a écrit lui-même en réservant, et rien d'autre.
 * `staffNote` reste en dehors : elle est écrite **sur** quelqu'un par le salon,
 * et le contrat partagé la borne à `appointmentSchema`, dont la seule sortie est
 * gardée par un rôle (#317). Elle est lue par `EXPORT_APPOINTMENT_SELECT`, parce
 * que l'art. 15 du RGPD ne connaît pas d'exception pour les notes qu'on aurait
 * préféré garder pour soi — mais cette lecture-là remet un document à la
 * personne, elle n'alimente aucun écran.
 */
export interface CustomerVisit {
  appointmentId: string;
  /**
   * Le statut **tel que la colonne l'écrit** — `COMPLETED`, `NO_SHOW`. Le
   * contrat partagé nomme les mêmes valeurs en minuscules, et la conversion se
   * fera à la frontière le jour du #26, comme pour les rôles.
   */
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  serviceName: string;
  /** `null` si le praticien a été retiré : une visite sans praticien reste une visite. */
  staffName: string | null;
  priceAmountMinor: number;
  priceCurrency: string;
  /**
   * La remarque écrite par le client à la réservation, ou `null` (#870).
   *
   * Le champ facultatif de l'étape 4 du tunnel
   * (`docs/design/appointments/wireframes.md`). Il n'est jamais réécrit par le
   * salon : ce qu'écrit le salon est `staffNote`, que cette vue ne porte pas.
   */
  clientNote: string | null;
  /**
   * De quel côté du comptoir l'annulation vient, ou `null` (#917).
   *
   * `null` sur une visite **annulée** est l'origine d'un report, pas une donnée
   * manquante : `appointments.repository.ts` annule la ligne d'origine sans lui
   * inscrire d'auteur. C'est ce qui permet à la fiche cliente d'écrire
   * « Déplacé » là où elle écrivait « Annulé ».
   */
  cancelledBy: AppointmentCancelledBy | null;
  /**
   * Le rendez-vous que cette visite remplace, ou `null` (#917).
   *
   * L'autre moitié du même fait, portée par le **successeur** : l'origine se
   * reconnaît à son auteur nul, le successeur à cette colonne.
   */
  rescheduledFromId: string | null;
}

/**
 * L'agrégat de l'historique.
 *
 * Il porte sur **tous** les rendez-vous de la fiche, jamais sur la seule page de
 * visites rendue à côté : un compteur calculé sur cinquante lignes mentirait dès
 * la cinquante et unième.
 *
 * `totalSpentAmountMinor` et `totalSpentCurrency` sont `null` ensemble quand
 * aucune visite n'a été honorée — `0` laisserait croire à une cliente venue sans
 * rien payer. Ils ne se séparent jamais : un montant sans devise n'est pas un
 * montant.
 */
export interface CustomerVisitSummary {
  totalVisits: number;
  honoredVisits: number;
  /**
   * Les annulations **véritables**, celles qui portent un auteur (#917).
   *
   * Disjoint de `rescheduledVisits` : leur somme est le nombre de lignes
   * `CANCELLED`, et `totalVisits` reste `honored + cancelled + rescheduled +
   * noShow + upcoming`.
   */
  cancelledVisits: number;
  /** Les **reports** — lignes annulées sans auteur, comptées sur l'origine (#917). */
  rescheduledVisits: number;
  noShowVisits: number;
  upcomingVisits: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  totalSpentAmountMinor: number | null;
  totalSpentCurrency: string | null;
}

/** Ce que rend `GET /customers/:id/history`. */
export interface CustomerVisitHistory {
  summary: CustomerVisitSummary;
  visits: CustomerVisit[];
}

/**
 * Un rendez-vous **tel que l'export le rend** — plus large que `CustomerVisit`,
 * et pour une raison de droit et non de confort (#81).
 *
 * L'historique du back-office sert à décider : il montre ce qu'un écran affiche.
 * L'export sert le droit d'accès (RGPD art. 15), qui porte sur **toutes** les
 * données concernant la personne — y compris les textes libres qu'un humain a
 * saisis à son sujet, et y compris ce qu'elle a elle-même écrit en réservant.
 * D'où les deux champs que l'historique ne montre pas : `staffNote`, écrite
 * **sur** la personne par le salon, et le motif d'annulation. `clientNote`, le
 * troisième texte libre, est dans les deux depuis #870 — l'écran le montre
 * parce que la praticienne en a besoin pour préparer la cabine, l'export le
 * restitue parce que la personne l'a écrit elle-même.
 *
 * Ce qu'il ne porte pas, en revanche : ni `tenantId`, ni `staffId`, ni
 * `serviceId`. Ce sont des identifiants internes de l'établissement, et le
 * destinataire de l'export n'est pas l'établissement (tenant-isolation §4).
 *
 * `startsAt` et `endsAt` sont l'intervalle **facturé**, comme sur `CustomerVisit`
 * et pour une raison de plus : un document remis au titre de l'art. 15 du RGPD
 * doit être exact, et les heures qu'il porte sont celles que la personne a
 * réellement vues — pas la cadence interne des cabines (#750).
 */
export interface ExportedAppointment {
  id: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  serviceName: string;
  /** `null` si le praticien a été retiré — une visite sans praticien reste une visite. */
  staffName: string | null;
  priceAmountMinor: number;
  priceCurrency: string;
  /** Ce que la cliente a écrit en réservant — sa donnée, donc dans son export. */
  clientNote: string | null;
  /** Ce que le salon a noté sur ce rendez-vous — sa donnée à elle aussi (art. 15). */
  staffNote: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
}

/**
 * Le dossier complet d'une personne — ce que rend `GET /customers/:id/export`.
 *
 * Premier critère de #81, et réponse au « mécanismes d'accès […] et d'export »
 * du CDC §5.1. La forme est un objet JSON unique, daté, et non un assemblage
 * d'appels que le destinataire aurait à recomposer : un export de portabilité
 * (RGPD art. 20) doit être « structuré, couramment utilisé et lisible par
 * machine », et un document se remet, une pagination non.
 *
 * `generatedAt` n'est pas décoratif : un export est une photographie, et sans sa
 * date on ne sait pas de quand. C'est aussi ce qui permet à une personne qui en
 * demande deux de les distinguer.
 */
export interface CustomerDataExport {
  /** Instant UTC auquel la photographie a été prise. */
  generatedAt: Date;
  /** L'identité et les coordonnées — la fiche telle que le salon la détient. */
  identity: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    isActive: boolean;
    createdAt: Date;
    anonymizedAt: Date | null;
  };
  /**
   * L'état des consentements, avec sa date.
   *
   * Un seul pour l'instant, et c'est exact : les notifications
   * transactionnelles ne reposent pas sur le consentement mais sur l'exécution
   * du contrat, et les faire figurer ici aurait laissé croire qu'elles se
   * retirent.
   */
  consents: {
    marketing: boolean;
    marketingRecordedAt: Date | null;
  };
  /**
   * La note interne du salon sur cette personne.
   *
   * Elle est dans l'export, et ce n'est pas une négligence : le droit d'accès
   * porte sur les données **concernant** la personne, sans exception pour celles
   * qu'on aurait préféré garder pour soi. C'est aussi ce qui donne son sens à
   * son autre propriété — elle ne sort par aucune autre porte que celle-ci et
   * `GET /customers/:id`, toutes deux gardées.
   */
  internalNote: string | null;
  /** Tous les rendez-vous, du plus ancien au plus récent. */
  appointments: ExportedAppointment[];
}
