import type { AppointmentStatus } from '../appointments/appointment-status';

/**
 * Vocabulaire du module `crm` — ce qui franchit la frontière du service, jamais
 * une entité Prisma (api-module §4).
 *
 * TODO(#26) : ces formes reprennent `customerSchema`, `customerVisitSchema` et
 * `customerVisitSummarySchema` de `@spa/shared`. Les redéclarer ici suit le
 * précédent des modules voisins — `apps/api` ne dépend pas encore du paquet
 * partagé —, et l'import se substituera à ces interfaces sans changer un champ.
 * La casse des statuts est le seul écart connu et il est documenté sur
 * `CustomerVisit.status`.
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
