import type { AppointmentStatus } from '../appointments/appointment-status';
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
 * TODO(#26) : ces formes reprennent `customerSchema`, `customerVisitSchema` et
 * `customerVisitSummarySchema` de `@spa/shared`. Les redéclarer ici suit le
 * précédent des modules voisins ; l'import se substituera à ces interfaces sans
 * changer un champ, lors de la reprise groupée de ce TODO — la dépendance vers
 * le paquet partagé est posée depuis #463, et `crm.errors.ts` en consomme déjà
 * une valeur. La casse des statuts est le seul écart connu et il est documenté
 * sur `CustomerVisit.status`.
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

/** Une visite, telle que l'historique la rend. */
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
  cancelledVisits: number;
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
 * D'où les trois champs que l'historique ne montre pas : `clientNote`,
 * `staffNote` et le motif d'annulation.
 *
 * Ce qu'il ne porte pas, en revanche : ni `tenantId`, ni `staffId`, ni
 * `serviceId`. Ce sont des identifiants internes de l'établissement, et le
 * destinataire de l'export n'est pas l'établissement (tenant-isolation §4).
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
