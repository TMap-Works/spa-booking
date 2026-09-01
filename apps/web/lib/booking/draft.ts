/**
 * L'état du tunnel de réservation, et sa survie à un rafraîchissement (#45).
 *
 * Troisième critère d'acceptation de l'issue, et §3 de la skill `web-frontend` :
 * *« un client qui recharge et perd sa progression abandonne »*. Tout ce que le
 * visiteur a saisi ou choisi vit donc dans `sessionStorage`, réécrit à chaque
 * changement et relu au montage.
 *
 * ## Pourquoi `sessionStorage` et non `localStorage`
 *
 * Le brouillon porte des coordonnées — nom, e-mail, téléphone. `localStorage`
 * les laisserait sur la machine jusqu'à effacement manuel, y compris sur un
 * poste partagé ; `sessionStorage` disparaît avec l'onglet, ce qui est
 * exactement la durée de vie d'une prise de rendez-vous.
 *
 * ## Pourquoi une clé par établissement
 *
 * Deux salons ouverts dans deux onglets du même navigateur ne partagent pas
 * `sessionStorage` entre onglets, mais un même onglet peut passer de l'un à
 * l'autre. Une clé unique ferait alors apparaître, dans le tunnel du second
 * salon, la prestation choisie chez le premier — un identifiant qui n'existe
 * pas de ce côté de la frontière.
 *
 * ## Pourquoi le contenu relu est validé
 *
 * `sessionStorage` est modifiable par l'utilisateur et survit à un déploiement.
 * Un brouillon écrit par une version antérieure du tunnel, ou bricolé à la main,
 * ne doit pas faire planter le montage : il est rejoué contre son schéma, et
 * repart de zéro s'il ne le satisfait pas.
 */

import { bookedAppointmentSchema, uuidSchema, utcInstantSchema } from '@spa/shared';
import { z } from 'zod';

/**
 * Les étapes, dans l'ordre du parcours (skill web-frontend §3).
 *
 * Le paiement n'y figure pas : il est traité par son propre ticket, et le
 * rendez-vous est déjà pris à la confirmation.
 */
export const BOOKING_STEPS = [
  'prestation',
  'creneau',
  'coordonnees',
  'recapitulatif',
  'confirmation',
] as const;

export type BookingStep = (typeof BOOKING_STEPS)[number];

export const bookingStepSchema = z.enum(BOOKING_STEPS);

/**
 * Les coordonnées **telles qu'elles ont été tapées**, et non telles que le
 * contrat les normalise.
 *
 * C'est ce qui permet de réafficher le formulaire après un rafraîchissement
 * dans l'état où le visiteur l'a laissé — y compris un numéro incomplet en
 * cours de frappe. La normalisation E.164 et la validation restent l'affaire de
 * `guestContactSchema`, appliqué à la soumission.
 */
export const contactDraftSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  clientNote: z.string(),
});

export type ContactDraft = z.infer<typeof contactDraftSchema>;

export const bookingDraftSchema = z.object({
  step: bookingStepSchema,
  serviceId: uuidSchema.nullable(),
  /** `null` = « premier disponible » (CDC §1.4), pas « pas encore choisi ». */
  staffId: uuidSchema.nullable(),
  startsAt: utcInstantSchema.nullable(),
  contact: contactDraftSchema,
  /** Le rendez-vous obtenu, qui fait vivre l'écran de confirmation après un F5. */
  appointment: bookedAppointmentSchema.nullable(),
});

export type BookingDraft = z.infer<typeof bookingDraftSchema>;

export function emptyBookingDraft(): BookingDraft {
  return {
    step: 'prestation',
    serviceId: null,
    staffId: null,
    startsAt: null,
    contact: { firstName: '', lastName: '', email: '', phone: '', clientNote: '' },
    appointment: null,
  };
}

function storageKey(tenantSlug: string): string {
  return `spa.booking.${tenantSlug}`;
}

/**
 * Le `sessionStorage` du navigateur, ou `null`.
 *
 * `null` couvre trois cas qui ne sont pas des pannes : le rendu serveur, la
 * navigation privée de certains navigateurs, et un stockage désactivé par
 * politique. Le tunnel reste utilisable dans tous les trois — il perd la survie
 * au rafraîchissement, pas la capacité de réserver.
 */
function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Le brouillon en cours pour cet établissement, ou un brouillon vierge. */
export function readBookingDraft(tenantSlug: string): BookingDraft {
  const store = sessionStore();
  const raw = store?.getItem(storageKey(tenantSlug));

  if (raw === null || raw === undefined) {
    return emptyBookingDraft();
  }

  try {
    const parsed = bookingDraftSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : emptyBookingDraft();
  } catch {
    return emptyBookingDraft();
  }
}

export function writeBookingDraft(tenantSlug: string, draft: BookingDraft): void {
  try {
    sessionStore()?.setItem(storageKey(tenantSlug), JSON.stringify(draft));
  } catch {
    // Quota dépassé ou stockage refusé : le tunnel continue sans persistance
    // plutôt que de s'interrompre au milieu d'une réservation.
  }
}

// Pas d'`effacement` : « prendre un nouveau rendez-vous » réécrit un brouillon
// vierge par `writeBookingDraft`, ce qui laisse le stockage dans le même état
// qu'un `removeItem` sans introduire un second chemin d'écriture à tenir.

/**
 * L'étape la plus avancée qu'un brouillon permet d'afficher.
 *
 * Un brouillon relu peut annoncer `recapitulatif` sans porter de créneau — il a
 * été bricolé, ou il vient d'une version antérieure du tunnel. Afficher
 * l'étape telle quelle donnerait un récapitulatif vide ; la ramener à la
 * première étape incomplète remet le visiteur là où il a quelque chose à faire.
 */
export function reachableStep(draft: BookingDraft): BookingStep {
  if (draft.appointment !== null) {
    return 'confirmation';
  }
  if (draft.serviceId === null) {
    return 'prestation';
  }
  if (draft.startsAt === null) {
    return draft.step === 'prestation' ? 'prestation' : 'creneau';
  }
  if (draft.step === 'confirmation') {
    // Le rendez-vous a disparu du brouillon : il n'y a plus rien à confirmer.
    return 'recapitulatif';
  }

  return draft.step;
}
