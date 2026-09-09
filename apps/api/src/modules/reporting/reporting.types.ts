/**
 * Vocabulaire du module `reporting` — CDC §2.3, « agrégation du revenu, du
 * volume de RDV et des no-shows ».
 *
 * Ce module ne possède **aucune table**. Il ne fait que relire, en agrégeant,
 * celles que `appointments` et `payments` écrivent. C'est ce qui gouverne tout
 * le reste de son dessin :
 *
 * - il n'a ni migration de table, ni cycle de vie, ni écriture — le seul SQL
 *   qu'il émet est un `SELECT … GROUP BY` ;
 * - il n'importe le service d'aucun autre module : il n'a rien à leur demander
 *   qu'ils sachent faire, et un agrégat sur un an de rendez-vous ne se compose
 *   pas d'appels de service (api-module §3, la voie « appel de service » sert
 *   une lecture unitaire, pas un balayage) ;
 * - il rend des **chiffres**, jamais des lignes. Aucun type de ce fichier ne
 *   porte de nom de cliente, d'adresse, de note interne ni de référence de
 *   prestataire : un tableau de bord se lit à distance, et ce qu'il ne contient
 *   pas ne peut pas fuir (CDC §5.1).
 *
 * ## Les listes de valeurs sont locales, comme partout ailleurs
 *
 * `PAYMENT_METHODS` et `APPOINTMENT_STATUSES` sont recopiées ici plutôt
 * qu'importées de `payments/payments.types.ts` ou de
 * `appointments/appointment-status.ts` : un module n'importe pas un fichier
 * profond d'un autre (api-module §3). C'est la même discipline que celle de ces
 * deux fichiers vis-à-vis du client Prisma généré, et le **témoin** est le
 * même : `__tests__/reporting.vocabulary.spec.ts` compare ces listes aux
 * énumérations réellement générées, si bien qu'une valeur ajoutée au schéma
 * fait rougir une suite avant qu'un total ne l'ignore en silence.
 *
 * Écart assumé, tranché en #554 : ces vocabulaires appartiennent au contrat d'API, et #510 n'a pas
 * pu les y prendre — c'est son premier point de vigilance, et il se voit ici
 * mieux qu'ailleurs. Les listes de ce fichier portent la casse de
 * l'énumération PostgreSQL (`PENDING`, `CARD`) parce que c'est ce que la colonne
 * écrit et ce que le total agrège ; `appointmentStatusSchema` et
 * `paymentMethodSchema` de `@spa/shared` portent les mêmes mots en
 * **minuscules**, parce que c'est ce que le front lit. Importer les seconds ici
 * ne changerait pas une réponse — il ferait simplement que plus aucun `groupBy`
 * de ce module ne reconnaîtrait la valeur qu'il vient de lire en base.
 *
 * Reste à faire, et c'est une décision de contrat et non de module : unifier les
 * deux vocabulaires, ce qui change le format du fil et touche du même coup
 * `notifications`, `apps/web` et tout lecteur d'agenda. `receivedAppointmentStatusSchema`
 * est écrit pour que cette unification se fasse en un seul endroit le jour venu.
 */

/** Moyen d'encaissement — `enum PaymentMethod` du schéma. */
export const PAYMENT_METHODS = ['CARD', 'CASH'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Statut d'un rendez-vous — `enum AppointmentStatus` du schéma. */
export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Les statuts d'encaissement qui constituent une **recette**.
 *
 * `PENDING` est une intention ouverte dont rien ne dit qu'elle aboutira ;
 * `FAILED` est une carte refusée. Ni l'une ni l'autre n'est de l'argent entré
 * en caisse, et les compter gonflerait le chiffre d'affaires de tout ce qui a
 * échoué.
 *
 * `REFUNDED` et `PARTIALLY_REFUNDED` y figurent au contraire, et il le faut :
 * un encaissement remboursé **a bien eu lieu**, il reste au relevé, et c'est
 * `refunded_amount_minor` qui le retranche du net. Les écarter aurait fait
 * disparaître la vente *et* son remboursement, si bien qu'un total remboursé à
 * moitié aurait pesé zéro au lieu de la moitié.
 */
export const REVENUE_PAYMENT_STATUSES = [
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

/**
 * L'axe de regroupement du volume de rendez-vous — les trois que demande le
 * deuxième critère de #74 : « par période, par praticien et par service ».
 *
 * En minuscules parce que c'est ce qui circule sur la chaîne de requête, comme
 * les filtres de statut de l'agenda.
 */
export const APPOINTMENT_GROUPINGS = ['day', 'staff', 'service'] as const;
export type AppointmentGrouping = (typeof APPOINTMENT_GROUPINGS)[number];

/**
 * La fenêtre d'un rapport — `from` **inclus**, `to` **exclu**.
 *
 * Même convention que l'historique de rapprochement de #62, et pour la même
 * raison : c'est la seule qui permette de poser deux journées de caisse bout à
 * bout sans compter deux fois l'encaissement de minuit, ni l'oublier.
 *
 * Les deux bornes sont **obligatoires**, à la différence de cet historique-là.
 * Un rapport sans borne balaierait toute l'histoire de l'établissement à chaque
 * ouverture d'écran, ce que le cinquième critère de #74 — « temps de réponse
 * acceptable sur un an de données » — interdit en pratique. Un tableau de bord
 * regarde toujours une période ; l'y obliger ne retire donc aucun usage.
 */
export interface ReportWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Une ligne de revenu : un jour, un moyen de paiement, une devise.
 *
 * La devise fait partie de la clé et n'est pas décorative. Un montant n'a pas
 * de sens sans elle, et sommer des minor units de devises différentes produit
 * un nombre qui ne veut rien dire. Un établissement n'en pratique qu'une en
 * temps normal ; la clé composite fait que le jour où ce ne serait plus vrai,
 * le rapport se scinde au lieu de mentir.
 *
 * `date` est une date **civile** `YYYY-MM-DD`, calculée dans le fuseau du
 * tenant : c'est la journée de caisse telle que le salon la vit, pas telle
 * qu'UTC la découpe.
 */
export interface DailyRevenueRow {
  readonly date: string;
  readonly method: PaymentMethod;
  readonly currency: string;
  readonly transactions: number;
  readonly grossAmountMinor: number;
  readonly refundedAmountMinor: number;
  readonly netAmountMinor: number;
}

/**
 * Le cumul de la fenêtre, ventilé par moyen de paiement et par devise.
 *
 * Il est **replié depuis les jours déjà agrégés**, et non calculé par une
 * seconde requête. Les deux auraient donné le même chiffre, mais la fenêtre
 * étant plafonnée à un an et la liste des jours n'étant jamais tronquée, la
 * somme porte exactement sur les lignes que l'écran affiche — un total qui ne
 * peut donc pas contredire ce qu'on montre, pour une requête de moins.
 */
export interface RevenueTotalRow {
  readonly method: PaymentMethod;
  readonly currency: string;
  readonly transactions: number;
  readonly grossAmountMinor: number;
  readonly refundedAmountMinor: number;
  readonly netAmountMinor: number;
}

/** Le revenu quotidien ventilé par moyen de paiement — premier critère de #74. */
export interface DailyRevenueReport {
  readonly window: ReportWindow;
  /** Le fuseau du tenant, celui dans lequel `date` a été découpée. */
  readonly timeZone: string;
  readonly days: readonly DailyRevenueRow[];
  readonly totals: readonly RevenueTotalRow[];
}

/**
 * Le compte de rendez-vous d'un groupe, ventilé par statut.
 *
 * `key` est la valeur de l'axe : une date civile `YYYY-MM-DD` pour `day`,
 * un identifiant de praticien pour `staff`, de prestation pour `service`.
 * `label` est le nom lisible qui va avec — `staff.display_name`,
 * `services.name` — et vaut `null` sur l'axe `day`, où la clé se lit d'elle-même.
 *
 * `label` n'est **pas** une donnée personnelle de cliente : c'est le nom public
 * du praticien, celui que l'agenda affiche déjà (`AgendaStaffDto`), ou celui de
 * la prestation au mur. Aucun nom de client n'entre dans un rapport.
 */
export interface AppointmentVolumeRow {
  readonly key: string;
  readonly label: string | null;
  readonly total: number;
  readonly byStatus: Readonly<Record<AppointmentStatus, number>>;
}

/** Le volume de rendez-vous sur une fenêtre — deuxième critère de #74. */
export interface AppointmentVolumeReport {
  readonly window: ReportWindow;
  readonly groupBy: AppointmentGrouping;
  readonly timeZone: string;
  readonly rows: readonly AppointmentVolumeRow[];
  readonly total: number;
}

/**
 * Le suivi des no-shows — troisième critère de #74, « taux **et** nombre ».
 *
 * Le taux est celui des rendez-vous **arrivés à échéance** : `noShows /
 * (completed + noShows)`. Un rendez-vous annulé n'est pas une occasion manquée
 * de venir — le créneau a été rendu, et souvent revendu ; le compter au
 * dénominateur diluerait le taux de tout ce que le salon a su replacer. Un
 * rendez-vous encore `PENDING` ou `CONFIRMED` sur la fenêtre n'a, lui, pas
 * encore été jugé.
 *
 * `rate` vaut `null` — et non `0` — quand le dénominateur est nul : « aucun
 * rendez-vous à honorer sur la période » n'est pas « aucun no-show », et un
 * `0` affiché sur un salon fermé se lirait comme une performance.
 *
 * Les quatre comptes sont rendus à côté du taux, et ce sont eux qui font foi :
 * un écran qui préfère un autre dénominateur peut le recalculer sans nous
 * redemander la fenêtre.
 */
export interface NoShowCounts {
  /** Rendez-vous marqués `NO_SHOW` sur la fenêtre. */
  readonly noShows: number;
  /** Rendez-vous `COMPLETED` — honorés. */
  readonly honored: number;
  /** Rendez-vous `CANCELLED`, hors dénominateur du taux. */
  readonly cancelled: number;
  /** Rendez-vous encore `PENDING` ou `CONFIRMED` sur la fenêtre. */
  readonly pending: number;
  /** Tous statuts confondus, sur la fenêtre. */
  readonly total: number;
}

/** Le suivi des no-shows tel que la route le rend — les comptes, et le taux. */
export interface NoShowReport extends NoShowCounts {
  readonly window: ReportWindow;
  readonly timeZone: string;
  /** `noShows / (honored + noShows)`, arrondi à quatre décimales, ou `null`. */
  readonly rate: number | null;
}
