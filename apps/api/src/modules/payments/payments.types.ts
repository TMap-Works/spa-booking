/**
 * Le vocabulaire du module `payments`, côté domaine.
 *
 * Ces formes ne sont ni des DTO HTTP ni des types générés par Prisma : ce sont
 * ce que le service et le repository acceptent et rendent (api-module §2). Les
 * DTO HTTP vivent sous `dto/`.
 *
 * **Rien ici ne décrit une carte.** Pas de champ `pan`, `cvc`, `expMonth` ni
 * `cardholder` : le domaine n'en a pas la notion, ce qui rend structurellement
 * impossible d'en stocker une (payments-stripe §1). Ce que ce module connaît
 * d'un paiement se lit intégralement dans `PaymentRecord` — des références
 * opaques, un montant, une devise, un statut.
 *
 * TODO(#26) : `PaymentIntentView` appartient au contrat d'API et sera importé
 * de `@spa/shared` le jour où `apps/api` dépendra du paquet — même TODO que
 * dans `appointments.types.ts`, `catalog.types.ts` et `identity.types.ts`.
 */

/**
 * Un montant, tel que tout le schéma le porte : un entier dans la plus petite
 * unité monétaire, accompagné de son code ISO 4217. Jamais de flottant, et
 * jamais d'entier sans sa devise (payments-stripe §5).
 *
 * Redéclaré ici plutôt qu'importé d'`appointments.types.ts` : un module
 * n'atteint pas les internes d'un autre (api-module §3), et cette forme
 * rejoindra `@spa/shared` avec les autres.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * Moyen d'encaissement — `enum PaymentMethod` du schéma.
 *
 * Liste locale plutôt qu'import du client généré, pour la raison qui vaut dans
 * `appointment-status.ts` et `identity/roles.ts` : ce fichier est lu par le
 * service et le contrôleur, et api-module §2 réserve l'import de `@prisma/client`
 * au repository. Le **témoin** vit dans la suite de test, qui compare cette
 * liste à l'énumération réellement générée.
 */
export const PAYMENT_METHODS = ['CARD', 'CASH'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Statut d'un encaissement — `enum PaymentStatus` du schéma, même régime. */
export const PAYMENT_STATUSES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Le rendez-vous, réduit à ce dont l'encaissement a besoin.
 *
 * `price` est le prix **figé à la réservation**, relu en base : c'est lui qui
 * fait autorité, jamais un montant envoyé par l'appelant. Un `amount` dans le
 * corps de la requête aurait laissé n'importe qui payer un massage un centime
 * — c'est la règle « le total est recalculé côté serveur ; le montant envoyé
 * par le front n'est jamais fait autorité » (payments-stripe §4), appliquée au
 * tunnel public.
 *
 * Pas de `tenantId` : il n'apporte rien à l'appelant et invite aux essais
 * (tenant-isolation §4). Pas de coordonnées de cliente non plus — le module
 * `payments` n'a aucune raison de les lire, et ce qu'il ne lit pas ne peut pas
 * partir chez le prestataire.
 */
export interface PayableAppointment {
  readonly id: string;
  readonly status: string;
  readonly price: Money;
}

/**
 * Une ligne `payments`, telle que ce module la manipule.
 *
 * `providerPaymentIntentId` est `null` pour une vente en espèces (#62) : il n'y
 * a pas d'intention Stripe derrière un billet. C'est ce `null` qui distingue,
 * dans le service, l'encaissement qu'on peut reprendre de celui qu'on ne peut
 * pas.
 */
export interface PaymentRecord {
  readonly id: string;
  readonly appointmentId: string | null;
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly providerPaymentIntentId: string | null;
}

/** Ce que le repository écrit lorsqu'une intention vient d'être créée. */
export interface CardPaymentDraft {
  readonly appointmentId: string;
  readonly amount: Money;
  readonly providerPaymentIntentId: string;
}

/**
 * Ce que le repository écrit lorsqu'un rendez-vous est réglé en espèces (#62).
 *
 * **Il n'y a pas de champ pour une référence de prestataire**, et c'est la forme
 * du quatrième critère : le chemin espèces n'a nulle part où ranger un
 * `pi_…`, parce qu'aucun appel Stripe n'a eu lieu pour en produire un. Le
 * montant, lui, n'est pas non plus dans le corps de la requête — il est relu au
 * rendez-vous, comme sur le chemin carte (payments-stripe §4).
 *
 * Ni `method` ni `status` : cette écriture n'a qu'un sens — un billet posé sur
 * le comptoir, donc `CASH` et `SUCCEEDED`, dès l'écriture. Contrairement à la
 * carte, il n'y a aucun tiers dont on attendrait la confirmation : la caisse
 * fait foi (payments-stripe §4).
 */
export interface CashPaymentDraft {
  readonly appointmentId: string;
  readonly amount: Money;
}

/**
 * L'intention de paiement telle que l'API la rend — le premier critère de #57.
 *
 * ## Les deux valeurs qui partent au navigateur, et pourquoi elles peuvent
 *
 * - `clientSecret` : un laissez-passer à usage unique, lié à **cette**
 *   intention, qui n'autorise rien d'autre que la confirmer. Il est fait pour
 *   être manipulé par le navigateur — c'est le mécanisme même de Stripe
 *   Elements.
 * - `publishableKey` : publiable par définition (payments-stripe §7). C'est la
 *   seule clé qui ait le droit de sortir du serveur.
 *
 * La clé **secrète** n'apparaît ni ici ni nulle part ailleurs dans une réponse.
 *
 * ## Ce que cette vue ne porte pas
 *
 * Ni `tenantId` — information interne (tenant-isolation §4) —, ni marque de
 * carte, ni quatre derniers chiffres : au moment où cette réponse part, aucune
 * carte n'a encore été saisie, et c'est le webhook de #58 qui apprendra au
 * serveur ce qui a été présenté.
 */
export interface PaymentIntentView {
  /** Notre identifiant de ligne `payments` — pas celui de Stripe. */
  readonly paymentId: string;
  readonly appointmentId: string;
  readonly amount: Money;
  readonly status: PaymentStatus;
  readonly clientSecret: string;
  readonly publishableKey: string;
}

/**
 * Une transaction telle que l'historique la rend — la **ligne de
 * rapprochement** du troisième critère de #62.
 *
 * Elle porte trois choses de plus que `PaymentRecord`, et chacune sert le
 * rapprochement avec les relevés Stripe (CDC §4.9) :
 *
 * - `providerChargeId`, parce qu'un relevé Stripe est un relevé de **charges**,
 *   pas d'intentions : c'est `ch_…` qui figure sur la ligne de virement, et
 *   `pi_…` qui figure dans le tableau de bord. Les deux sont nécessaires pour
 *   partir de l'un ou de l'autre ;
 * - `capturedAt`, l'instant où l'argent a été pris — celui qui décide du jour de
 *   caisse, là où `createdAt` ne date que l'ouverture de l'encaissement ;
 * - `refunded`, parce qu'une ligne remboursée reste au relevé et qu'un total qui
 *   l'ignorerait ne tomberait jamais juste.
 *
 * Une vente en espèces porte `null` aux deux références et se distingue donc
 * **par construction** de ce qui doit se retrouver chez Stripe : le
 * rapprochement se fait sur les lignes qui en ont une, la caisse fait foi pour
 * les autres.
 *
 * Pas de `tenantId` : information interne, qui n'apporte rien au consommateur et
 * invite aux essais (tenant-isolation §4). Pas de coordonnées de cliente non
 * plus — le module `payments` n'en lit aucune.
 */
export interface PaymentTransaction {
  readonly id: string;
  readonly appointmentId: string | null;
  readonly amount: Money;
  readonly refunded: Money;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly providerPaymentIntentId: string | null;
  readonly providerChargeId: string | null;
  readonly capturedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * La fenêtre et les critères de l'historique des transactions (#62).
 *
 * `from` est inclus, `to` **exclu** : c'est la seule convention qui permette de
 * poser deux journées de caisse bout à bout sans compter deux fois
 * l'encaissement de minuit, ni l'oublier. Les deux sont facultatifs — un
 * comptoir qui ouvre l'écran veut les dernières transactions, pas une fenêtre à
 * saisir avant de voir quoi que ce soit.
 *
 * `page` et `pageSize` sont **résolus** — leurs valeurs par défaut sont
 * appliquées une fois, à la frontière HTTP, et pas redevinées par chaque couche.
 */
export interface PaymentHistoryFilter {
  readonly from?: Date;
  readonly to?: Date;
  readonly method?: PaymentMethod;
  readonly status?: PaymentStatus;
  readonly page: number;
  readonly pageSize: number;
}

/** Une page de transactions, avec de quoi afficher un sélecteur de page. */
export interface PaymentTransactionPage {
  readonly items: readonly PaymentTransaction[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}
