'use server';

/**
 * Les actions serveur du tunnel — la seule voie par laquelle le navigateur
 * atteint l'API.
 *
 * Aucun `fetch` vers l'API depuis un Client Component : le client HTTP lit
 * `API_URL`, qui n'existe que côté serveur (voir l'en-tête de
 * `lib/api-client.ts`). Le navigateur ne parle donc qu'à son propre domaine.
 *
 * ## Pourquoi ces actions rendent un résultat et ne lèvent pas
 *
 * Une exception traversant la frontière d'une action serveur est **masquée** en
 * production : Next remplace son message par un identifiant opaque, ce qui est
 * la bonne politique — un message d'erreur serveur n'a rien à faire dans un
 * navigateur. Mais le tunnel a besoin de distinguer un créneau perdu (409, cas
 * normal sous concurrence) d'une panne. Le code d'erreur du contrat est donc
 * transporté explicitement, dans une valeur sérialisable.
 *
 * ## La validation est refaite ici
 *
 * Le formulaire valide pour le confort, cette frontière valide pour la
 * correction : rien ne garantit qu'un appel d'action vienne du formulaire.
 * L'API revalidera de son côté — le front valide pour le confort, le back pour
 * la sécurité, jamais l'un sans l'autre (skill web-frontend §4).
 */

import {
  ERROR_CODES,
  availabilityQuerySchema,
  bookGuestAppointmentRequestSchema,
  cancelAppointmentRequestSchema,
  slugSchema,
  uuidSchema,
  type AvailabilityResponse,
  type BookedAppointment,
} from '@spa/shared';

import {
  ApiClientError,
  bookGuestAppointment,
  cancelAppointment,
  fetchAvailability,
} from '@/lib/api-client';

export type ActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly code: string; readonly message: string };

function failure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof ApiClientError) {
    return { ok: false, code: error.code, message: error.message };
  }

  return {
    ok: false,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'Une erreur inattendue est survenue. Merci de réessayer.',
  };
}

/** Refus de validation : l'appel n'a même pas atteint l'API. */
function invalid(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: ERROR_CODES.VALIDATION_ERROR, message };
}

export async function loadAvailabilityAction(
  tenantSlug: string,
  query: unknown,
): Promise<ActionResult<AvailabilityResponse>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = availabilityQuerySchema.safeParse(query);

  if (!slug.success || !parsed.success) {
    return invalid('La demande de disponibilités est incomplète.');
  }

  try {
    return { ok: true, data: await fetchAvailability(slug.data, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

export async function bookAppointmentAction(
  tenantSlug: string,
  request: unknown,
): Promise<ActionResult<BookedAppointment>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = bookGuestAppointmentRequestSchema.safeParse(request);

  if (!slug.success || !parsed.success) {
    return invalid('Les informations de réservation sont incomplètes.');
  }

  try {
    return { ok: true, data: await bookGuestAppointment(slug.data, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  reason?: string,
): Promise<ActionResult<BookedAppointment>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const id = uuidSchema.safeParse(appointmentId);
  const body = cancelAppointmentRequestSchema.safeParse(
    reason === undefined || reason === '' ? {} : { reason },
  );

  if (!slug.success || !id.success || !body.success) {
    return invalid('La demande d’annulation est incomplète.');
  }

  try {
    return { ok: true, data: await cancelAppointment(slug.data, id.data, body.data) };
  } catch (error) {
    return failure(error);
  }
}
