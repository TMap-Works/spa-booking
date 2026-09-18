'use server';

/**
 * L'inscription d'un salon en libre-service — ADR 0016.
 *
 * Trois temps, sous une seule action : le salon et son administrateur sont
 * créés (l'API ouvre aussitôt la session de celui-ci), la session est rangée
 * dans les cookies du back-office du salon, puis la page de paiement Stripe de
 * l'essai est ouverte. Le navigateur y part avec l'adresse rendue.
 *
 * Si Stripe ne répond pas, le salon existe quand même : l'adresse rendue est
 * alors celle de l'écran d'abonnement, qui propose de reprendre le paiement.
 */

import { salonSignupRequestSchema } from '@spa/shared';

import { failure, invalid, type AdminActionResult } from '@/app/(admin)/[tenantSlug]/admin/action-result';
import { adminBillingPath } from '@/app/(admin)/[tenantSlug]/admin/paths';
import { writeAdminSession } from '@/app/(admin)/[tenantSlug]/admin/session';
import { signupSalon, startBillingCheckout } from '@/lib/api-client';

export interface SignupOutcome {
  /** Où envoyer le navigateur : Stripe Checkout, ou l'écran d'abonnement. */
  readonly next: string;
}

export async function signupSalonAction(values: unknown): Promise<AdminActionResult<SignupOutcome>> {
  const parsed = salonSignupRequestSchema.safeParse(values);

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Le formulaire contient une erreur.');
  }

  let opened;
  try {
    opened = await signupSalon(parsed.data);
  } catch (error) {
    return failure(error);
  }

  await writeAdminSession(parsed.data.slug, opened);

  try {
    const checkout = await startBillingCheckout(opened.session.accessToken);
    return { ok: true, data: { next: checkout.url } };
  } catch {
    return { ok: true, data: { next: adminBillingPath(parsed.data.slug) } };
  }
}
