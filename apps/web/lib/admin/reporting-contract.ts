/**
 * Les trois rapports que le back-office lit, rejoués contre un schéma — le
 * revenu quotidien, le volume de rendez-vous et le suivi des no-shows (#74),
 * que l'écran de #75 restitue.
 *
 * ## Pourquoi ils ne viennent pas de `@spa/shared`
 *
 * Parce que le contrat partagé ne les publie pas : `packages/shared/src/schemas/`
 * n'a pas de fichier `reporting.ts`, et le module API les décrit dans ses
 * propres DTO (`apps/api/src/modules/reporting/dto/`). C'est exactement l'écart
 * que `payment-contract.ts` documente pour les paiements, et il se referme de la
 * même façon : le jour où le contrat partagé porte ces trois réponses, ce
 * fichier disparaît et `api-client.ts` importe les schémas de `@spa/shared`.
 *
 * TODO(#536) : ce paquet de vocabulaire appartient au contrat d'API, et
 * `reporting.types.ts` le dit déjà de son côté — « ces vocabulaires
 * appartiennent au contrat d'API, et #510 n'a pas pu les y prendre ». Le
 * déplacer suppose de trancher la question de casse que ce même fichier
 * instruit : l'API agrège `NO_SHOW` parce que c'est ce que la colonne écrit,
 * `@spa/shared` nomme `no_show` parce que c'est ce que le front lit.
 *
 * D'ici là, les schémas vivent ici et sont **composés des primitives du
 * contrat** (`utcInstantSchema`, `timeZoneSchema`, `calendarDateSchema`,
 * `currencyCodeSchema`, `amountMinorSchema`, `appointmentStatusSchema`,
 * `paymentMethodSchema`) : rien du vocabulaire n'est redéclaré, seule
 * l'enveloppe l'est.
 *
 * ## La normalisation de casse se fait ici, une fois
 *
 * L'API émet `CARD` et `NO_SHOW` ; le contrat partagé nomme `card` et `no_show`.
 * La conversion est faite à la frontière — comme
 * `receivedAppointmentStatusSchema` du contrat et `receivedPaymentMethodSchema`
 * du contrat de paiement — de sorte qu'aucun composant de l'écran n'ait à se
 * demander dans quelle casse il compare un statut.
 *
 * ## Aucune donnée personnelle ne peut entrer par ces schémas
 *
 * Un objet Zod **retire** les clés qu'il ne déclare pas. Les seuls libellés
 * déclarés ci-dessous sont `label` — le nom public d'un praticien ou d'une
 * prestation, celui que l'agenda affiche déjà. Ni nom de cliente, ni adresse, ni
 * note interne, ni référence de prestataire : le module API n'en émet aucun
 * (son README, « ce qu'aucune réponse ne porte »), et si cela changeait, rien
 * n'atteindrait un composant ni un journal du front.
 */

import {
  APPOINTMENT_STATUSES,
  amountMinorSchema,
  calendarDateSchema,
  currencyCodeSchema,
  paymentMethodSchema,
  timeZoneSchema,
  utcInstantSchema,
  type AppointmentStatus,
  type PaymentMethod,
} from '@spa/shared';
import { z } from 'zod';

/**
 * Moyen d'encaissement **tel qu'il arrive du fil** — l'API émet `CARD`, le
 * contrat nomme `card`.
 */
const receivedPaymentMethodSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(paymentMethodSchema);

/**
 * La fenêtre du rapport, telle que l'API la rend — `from` **inclus**, `to`
 * **exclu**, tous deux normalisés en UTC.
 *
 * Les deux bornes sont des instants et non des dates civiles : c'est la journée
 * de caisse du salon qui est découpée dans son fuseau, côté serveur, et la
 * réponse porte le fuseau employé pour qu'aucun écran n'ait à le supposer.
 */
export const reportWindowSchema = z
  .object({ from: utcInstantSchema, to: utcInstantSchema })
  .strict();

export type ReportWindowResponse = z.infer<typeof reportWindowSchema>;

/**
 * Un montant de rapport : un entier dans la plus petite unité monétaire et un
 * code devise explicite, jamais un flottant (CLAUDE.md, « Argent »).
 *
 * La devise fait partie de la clé des lignes de revenu, et ce n'est pas
 * décoratif : sommer des minor units de devises différentes produit un nombre
 * qui ne veut rien dire.
 */
const revenueAmountsSchema = z.object({
  currency: currencyCodeSchema,
  transactions: z.number().int().nonnegative(),
  grossAmountMinor: amountMinorSchema,
  refundedAmountMinor: amountMinorSchema,
  netAmountMinor: amountMinorSchema,
});

/** Une ligne de revenu : un jour de caisse, un moyen de paiement, une devise. */
export const dailyRevenueRowSchema = revenueAmountsSchema
  .extend({ date: calendarDateSchema, method: receivedPaymentMethodSchema })
  .strict();

export type DailyRevenueRow = z.infer<typeof dailyRevenueRowSchema>;

/** Le cumul de la fenêtre, ventilé par moyen de paiement et par devise. */
export const revenueTotalSchema = revenueAmountsSchema
  .extend({ method: receivedPaymentMethodSchema })
  .strict();

export type RevenueTotal = z.infer<typeof revenueTotalSchema>;

/** `GET /v1/reports/revenue`. */
export const dailyRevenueReportSchema = z
  .object({
    window: reportWindowSchema,
    timeZone: timeZoneSchema,
    days: z.array(dailyRevenueRowSchema),
    totals: z.array(revenueTotalSchema),
  })
  .strict();

export type DailyRevenueReport = z.infer<typeof dailyRevenueReportSchema>;

/**
 * Les axes de regroupement du volume — ceux que l'API sert, écrits comme la
 * chaîne de requête les porte.
 *
 * `day` est le défaut de la route ; l'écran demande les trois, parce que les
 * deux autres sont ce qui alimente ses filtres.
 */
export const APPOINTMENT_GROUPINGS = ['day', 'staff', 'service'] as const;

export type AppointmentGrouping = (typeof APPOINTMENT_GROUPINGS)[number];

/**
 * Les comptes par statut d'un groupe, **ramenés au vocabulaire du contrat**.
 *
 * L'API émet un objet à cinq clés majuscules (`PENDING`, …, `NO_SHOW`) : ce sont
 * les valeurs de l'`enum` PostgreSQL. Le front lit `pending` … `no_show`, comme
 * partout ailleurs. La table de correspondance est **dérivée** de
 * `APPOINTMENT_STATUSES` plutôt qu'écrite à la main : un statut ajouté au
 * contrat fait échouer la compilation ici, au lieu de disparaître en silence
 * d'un total.
 */
const WIRE_STATUS_KEYS: Readonly<Record<AppointmentStatus, string>> = Object.fromEntries(
  APPOINTMENT_STATUSES.map((status) => [status, status.toUpperCase()]),
) as Readonly<Record<AppointmentStatus, string>>;

const statusCountSchema = z.number().int().nonnegative();

export const appointmentStatusCountsSchema = z
  .object(
    Object.fromEntries(
      APPOINTMENT_STATUSES.map((status) => [WIRE_STATUS_KEYS[status], statusCountSchema]),
    ) as Record<string, typeof statusCountSchema>,
  )
  .strict()
  .transform(
    (counts) =>
      Object.fromEntries(
        APPOINTMENT_STATUSES.map((status) => [status, counts[WIRE_STATUS_KEYS[status]] ?? 0]),
      ) as Record<AppointmentStatus, number>,
  );

export type AppointmentStatusCounts = z.infer<typeof appointmentStatusCountsSchema>;

/**
 * Un groupe de l'axe demandé.
 *
 * `key` est la valeur de l'axe — une date civile sur `day`, un identifiant de
 * praticien ou de prestation sur les deux autres. `label` est le nom public qui
 * va avec, et vaut `null` sur l'axe `day` où la clé se lit d'elle-même.
 *
 * `key` n'est pas contraint à un UUID : sur l'axe `day` c'en est une date, et
 * exiger les deux formes reviendrait à décrire l'axe deux fois.
 */
export const appointmentVolumeRowSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().nullable(),
    total: z.number().int().nonnegative(),
    byStatus: appointmentStatusCountsSchema,
  })
  .strict();

export type AppointmentVolumeRow = z.infer<typeof appointmentVolumeRowSchema>;

/** `GET /v1/reports/appointments`. */
export const appointmentVolumeReportSchema = z
  .object({
    window: reportWindowSchema,
    groupBy: z.enum(APPOINTMENT_GROUPINGS),
    timeZone: timeZoneSchema,
    rows: z.array(appointmentVolumeRowSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type AppointmentVolumeReport = z.infer<typeof appointmentVolumeReportSchema>;

/**
 * `GET /v1/reports/no-shows`.
 *
 * `rate` vaut `null` — et non `0` — quand aucun rendez-vous n'était à honorer
 * sur la fenêtre. « Rien à honorer » n'est pas « aucun no-show », et l'écran
 * doit pouvoir dire l'un sans afficher l'autre comme une performance.
 */
export const noShowReportSchema = z
  .object({
    window: reportWindowSchema,
    timeZone: timeZoneSchema,
    noShows: z.number().int().nonnegative(),
    honored: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export type NoShowReport = z.infer<typeof noShowReportSchema>;

/** Le statut d'un rendez-vous, tel que l'écran l'écrit. */
export const APPOINTMENT_STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  pending: 'En attente',
  confirmed: 'Confirmés',
  completed: 'Honorés',
  cancelled: 'Annulés',
  no_show: 'No-shows',
};

/** Le moyen d'encaissement, tel que l'écran l'écrit. */
export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  card: 'Carte',
  cash: 'Espèces',
};
