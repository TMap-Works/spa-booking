'use server';

/**
 * Les actions serveur de la console de l'éditeur.
 *
 * Même doctrine que le back-office : aucune action ne rend le jeton de console,
 * la validation est refaite ici avec les schémas de `@spa/shared`, et un refus
 * est un résultat, jamais une exception.
 *
 * Les **liens** rendus par l'ouverture d'un salon portent, eux, un jeton
 * d'invitation : c'est leur raison d'être — l'opérateur les remet au gérant — et
 * ils ne sont affichés qu'à lui.
 *
 * ## Les `message` de ce module sont des diagnostics, jamais de l'affichage (#1106)
 *
 * Ils restent en français, et aucun écran ne les montre : chaque composant de la
 * console lit le **code** du refus et écrit sa propre phrase dans la langue de la
 * session (web-frontend §2). Les traduire ici aurait demandé à chaque action de
 * résoudre la langue de la requête pour produire un texte que personne ne lit —
 * et aurait laissé deux écritures du même message, celle de l'action et celle de
 * l'écran, libres de diverger.
 */

import {
  createPlatformNoteRequestSchema,
  createTenantRequestSchema,
  platformLoginRequestSchema,
  updateTenantStatusRequestSchema,
  uuidSchema,
  type PlatformOperator,
  type PlatformTenant,
  type PlatformTenantEvent,
  type ProvisionedTenant,
  type ReissuedTenantInvitation,
} from '@spa/shared';
import { revalidatePath } from 'next/cache';

import {
  addPlatformTenantNote,
  loginPlatformOperator,
  provisionTenant,
  reissueTenantInvitation,
  updatePlatformTenantStatus,
} from '@/lib/api-client';

import { expired, failure, invalid, type AdminActionResult } from '@/app/(admin)/[tenantSlug]/admin/action-result';
import { platformTenantPath } from './paths';
import { clearPlatformSession, readPlatformAccessToken, writePlatformSession } from './session';

export type PlatformActionResult<TData> = AdminActionResult<TData>;

export async function platformLoginAction(
  credentials: unknown,
): Promise<PlatformActionResult<PlatformOperator>> {
  const parsed = platformLoginRequestSchema.safeParse(credentials);

  if (!parsed.success) {
    return invalid('Renseignez votre adresse e-mail, votre mot de passe et le code à six chiffres.');
  }

  try {
    const session = await loginPlatformOperator(parsed.data);
    await writePlatformSession(session);
    return { ok: true, data: session.operator };
  } catch (error) {
    return failure(error);
  }
}

/** Aucun jeton de rafraîchissement à révoquer : effacer les cookies suffit. */
export async function platformLogoutAction(): Promise<PlatformActionResult<null>> {
  await clearPlatformSession();
  return { ok: true, data: null };
}

/**
 * Ouvre un salon. `idempotencyKey` vient du formulaire et ne change qu'avec lui :
 * un double clic ou une soumission rejouée après une coupure rend le même salon.
 */
export async function provisionTenantAction(
  idempotencyKey: string,
  values: unknown,
): Promise<PlatformActionResult<ProvisionedTenant>> {
  const parsed = createTenantRequestSchema.safeParse(values);

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Le formulaire contient une erreur.');
  }
  if (!/^[A-Za-z0-9-]{8,128}$/.test(idempotencyKey)) {
    return invalid('Clé de soumission invalide — rechargez la page.');
  }

  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    return { ok: true, data: await provisionTenant(accessToken, idempotencyKey, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

/** Réémet l'invitation du gérant d'un salon — et rend ses liens d'accès. */
export async function reissueTenantInvitationAction(
  tenantId: string,
): Promise<PlatformActionResult<ReissuedTenantInvitation>> {
  const id = uuidSchema.safeParse(tenantId);

  if (!id.success) {
    return invalid('Établissement inconnu.');
  }

  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    return { ok: true, data: await reissueTenantInvitation(accessToken, id.data) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Ajoute une note interne à l'historique d'un salon.
 *
 * La fiche est un Server Component : la note apparaît parce que son segment
 * est revalidé, pas parce que l'écran l'insère de lui-même — l'historique reste
 * celui que la base rend.
 */
export async function addTenantNoteAction(
  tenantId: string,
  values: unknown,
): Promise<PlatformActionResult<PlatformTenantEvent>> {
  const id = uuidSchema.safeParse(tenantId);
  const parsed = createPlatformNoteRequestSchema.safeParse(values);

  if (!id.success) {
    return invalid('Établissement inconnu.');
  }
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'La note est invalide.');
  }

  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    const event = await addPlatformTenantNote(accessToken, id.data, parsed.data.body);
    revalidatePath(platformTenantPath(id.data));
    return { ok: true, data: event };
  } catch (error) {
    return failure(error);
  }
}

/** Suspend ou réactive un salon — le motif est exigé, dans les deux sens. */
export async function updateTenantStatusAction(
  tenantId: string,
  values: unknown,
): Promise<PlatformActionResult<PlatformTenant>> {
  const id = uuidSchema.safeParse(tenantId);
  const parsed = updateTenantStatusRequestSchema.safeParse(values);

  if (!id.success) {
    return invalid('Établissement inconnu.');
  }
  if (!parsed.success) {
    return invalid('Indiquez le motif — il est gardé dans l’historique du salon.');
  }

  const accessToken = await readPlatformAccessToken();

  if (accessToken === null) {
    return expired();
  }

  try {
    const tenant = await updatePlatformTenantStatus(accessToken, id.data, parsed.data);
    revalidatePath(platformTenantPath(id.data));
    return { ok: true, data: tenant };
  } catch (error) {
    return failure(error);
  }
}
