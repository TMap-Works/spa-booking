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
 * ## Les refus se disent dans la langue de la requête — #1299
 *
 * Ce module rendait des phrases françaises écrites en dur — « Établissement
 * inconnu. », « Indiquez le motif… », « Le formulaire contient une erreur. » —
 * au motif qu'aucun écran ne les montre : chaque composant de la console lit le
 * **code** du refus et écrit sa propre phrase dans la langue de la session
 * (web-frontend §2). L'argument tenait tant que le tri sur le code restait
 * exhaustif ; il ne tient plus le jour où un écran retombe sur `result.message`,
 * et la phrase s'affiche alors en français sur une console anglaise.
 *
 * Deux corrections, celles qu'a prises le back-office en #1234 :
 *
 * - **plus aucun littéral.** La phrase du refus vient d'`errorMessage(code,
 *   locale)` du contrat partagé — toujours `VALIDATION_ERROR`, jamais un code
 *   choisi pour la phrase qu'il porte : c'est le code qu'`invalid()` pose, et un
 *   refus dont la phrase dirait autre chose que son code serait illisible pour
 *   l'écran, qui trie sur le code ;
 * - **la carte de zod est celle de la requête.** Là où le message du premier
 *   refus du schéma est rendu tel quel — il nomme le champ fautif, là où le
 *   repli ne dit que « incomplètes ou mal formées » —, le `safeParse` reçoit
 *   `zodErrorMap(locale)`. Sans elle il retombait sur la carte globale du
 *   contrat, posée en `DIAGNOSTIC_LOCALE = 'fr'` pour les journaux de l'API
 *   (#1232) : du français, quelle que soit la langue de l'écran.
 *
 * Les `safeParse` dont le message ne remonte jamais — `uuidSchema` sur un
 * identifiant d'URL — n'en reçoivent pas : leur refus se dit par la phrase du
 * code, et leur passer une carte n'ajouterait qu'un paramètre sans lecteur.
 */

import {
  ERROR_CODES,
  createPlatformNoteRequestSchema,
  createTenantRequestSchema,
  errorMessage,
  platformLoginRequestSchema,
  updateTenantStatusRequestSchema,
  uuidSchema,
  zodErrorMap,
  type Locale,
  type PlatformOperator,
  type PlatformTenant,
  type PlatformTenantEvent,
  type ProvisionedTenant,
  type ReissuedTenantInvitation,
} from '@spa/shared';
import { getLocale } from 'next-intl/server';
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

/**
 * La phrase de `VALIDATION_ERROR`, dans la langue donnée.
 *
 * Synchrone et non exportée : `'use server'` n'admet que des exports
 * asynchrones, chacun devenant un point d'entrée appelable depuis le navigateur.
 * La langue est un paramètre plutôt qu'une lecture interne pour qu'une action
 * qui la lit déjà — parce qu'elle en fait aussi une carte de zod — n'interroge
 * pas la requête deux fois.
 */
function refusDeValidation(locale: Locale): string {
  return errorMessage(ERROR_CODES.VALIDATION_ERROR, locale);
}

export async function platformLoginAction(
  credentials: unknown,
): Promise<PlatformActionResult<PlatformOperator>> {
  const parsed = platformLoginRequestSchema.safeParse(credentials);

  if (!parsed.success) {
    return invalid(refusDeValidation(await getLocale()));
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
  const locale = await getLocale();
  const parsed = createTenantRequestSchema.safeParse(values, { errorMap: zodErrorMap(locale) });

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? refusDeValidation(locale));
  }
  if (!/^[A-Za-z0-9-]{8,128}$/.test(idempotencyKey)) {
    return invalid(refusDeValidation(locale));
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
    return invalid(refusDeValidation(await getLocale()));
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
  const locale = await getLocale();
  const id = uuidSchema.safeParse(tenantId);
  const parsed = createPlatformNoteRequestSchema.safeParse(values, {
    errorMap: zodErrorMap(locale),
  });

  if (!id.success) {
    return invalid(refusDeValidation(locale));
  }
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? refusDeValidation(locale));
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
  const locale = await getLocale();
  const id = uuidSchema.safeParse(tenantId);
  const parsed = updateTenantStatusRequestSchema.safeParse(values, {
    errorMap: zodErrorMap(locale),
  });

  if (!id.success) {
    return invalid(refusDeValidation(locale));
  }
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? refusDeValidation(locale));
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
