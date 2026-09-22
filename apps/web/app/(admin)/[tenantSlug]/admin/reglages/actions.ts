'use server';

/**
 * L'action de la **langue du compte connecté**, depuis le back-office (#853,
 * troisième critère d'acceptation).
 *
 * ## Pourquoi elle n'est pas dans `actions.ts`
 *
 * Elle n'appartient pas à l'établissement mais à la personne, et elle est la
 * seule écriture de cet écran qui ne passe pas par `PATCH /tenant`. La ranger
 * auprès de l'écran qui la porte la garde lisible, et garde le module des
 * actions transverses du back-office à ce qu'il est — la session et les
 * réglages du salon.
 *
 * ## Elle écrit la même chose que l'espace client, par le même module
 *
 * `attachProfileLocaleCookies` de `(account)/…/account-locale.ts` : la
 * préférence du compte n'a qu'un cookie (`spa_account_locale`) et qu'une règle,
 * et la réécrire ici en aurait fait deux copies à tenir synchrones. Le geste est
 * celui de l'écran des coordonnées et non celui d'une ouverture de session —
 * retirer sa préférence doit emporter le choix du sélecteur, faute de quoi la
 * langue retirée reviendrait au rendu suivant.
 */

import {
  ERROR_CODES,
  errorMessage,
  slugSchema,
  updateProfileRequestSchema,
  type SessionUser,
} from '@spa/shared';
import { getLocale } from 'next-intl/server';
import { cookies } from 'next/headers';

import { attachProfileLocaleCookies } from '@/app/(account)/[tenantSlug]/compte/account-locale';
import { updateOwnProfile } from '@/lib/api-client';

import { failure, invalid, type AdminActionResult } from '../action-result';
import { adminActionAccess } from '../session';

/**
 * Enregistre la langue préférée du compte connecté.
 *
 * `chosen` vient d'un `<select>` : la chaîne vide y transporte le `null` du
 * contrat — « aucune préférence », et c'est alors la langue de l'établissement
 * qui tranche (#844). Le corps est validé par le schéma du contrat lui-même,
 * comme toute action de cette surface (web-frontend §4) ; l'API revalide.
 */
export async function saveMemberLocaleAction(
  tenantSlug: string,
  chosen: unknown,
): Promise<AdminActionResult<SessionUser>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = updateProfileRequestSchema.safeParse({
    locale: chosen === '' ? null : chosen,
  });

  if (!slug.success || !parsed.success) {
    // La phrase vient du contrat et non d'un littéral : elle existe dans les
    // deux langues, et l'écran n'a pas à en réécrire une (#845).
    return invalid(errorMessage(ERROR_CODES.VALIDATION_ERROR, await getLocale()));
  }

  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access;
  }

  try {
    const updated = await updateOwnProfile(access.accessToken, parsed.data);

    attachProfileLocaleCookies(await cookies(), updated.locale);

    return { ok: true, data: updated };
  } catch (error) {
    return failure(error);
  }
}
