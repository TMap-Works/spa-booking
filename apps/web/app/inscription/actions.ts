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
 *
 * ## La langue de la page de paiement (#1261)
 *
 * Celle dans laquelle le formulaire d'inscription vient d'être rempli
 * (`getLocale()`, donc la résolution de `i18n/resolve.ts` — sélecteur compris).
 * C'est le seul signal qui existe à cet instant : le compte vient d'être créé et
 * n'a encore exprimé aucune préférence, et laisser l'API choisir seule ferait
 * basculer en anglais, par `tenants.default_locale`, une inscription entièrement
 * suivie en français.
 *
 * ## Et la langue du refus de validation (#1299)
 *
 * La même. Le `safeParse` ci-dessous ne recevait aucune carte d'erreurs : il
 * retombait donc sur la carte **globale** du contrat partagé, posée en
 * `DIAGNOSTIC_LOCALE = 'fr'` pour les journaux de l'API (#1232). Le premier refus
 * du schéma — c'est lui que l'action rend, parce qu'il nomme le champ fautif —
 * arrivait en français sur un formulaire anglais, et le repli était une phrase
 * française écrite en dur. La carte est désormais celle de la requête, et le
 * repli la phrase de `VALIDATION_ERROR` dans cette langue — rendue par
 * `validationRefusal` d'`action-result.ts`, qui la tient pour toutes les actions
 * serveur depuis #1310.
 *
 * L'inscription est vue par un gérant qui n'a encore aucun compte : c'est
 * exactement l'écran où une phrase française sur une page anglaise se paie.
 *
 * ## La langue se lit **avant** que la session soit posée, et c'est voulu
 *
 * Une seule lecture, en tête d'action, sert les deux emplois — la carte de zod
 * et la page de paiement. Elle ne peut donc plus avoir lieu après
 * `writeAdminSession`, qui pose au passage le miroir de la langue du **compte**
 * (`setAccountLocaleMirror`, #853) : ce cookie est relu par la résolution, et il
 * porte `tenants.default_locale` — la langue du salon qu'on vient d'ouvrir, non
 * celle du formulaire. Lire avant, c'est précisément ce que la section #1261
 * ci-dessus demande, et le code ne le tenait que par l'ordre des lignes.
 */

import { salonSignupRequestSchema, zodErrorMap } from '@spa/shared';
import { getLocale } from 'next-intl/server';

import {
  failure,
  invalid,
  validationRefusal,
  type AdminActionResult,
} from '@/app/(admin)/[tenantSlug]/admin/action-result';
import { adminBillingPath } from '@/app/(admin)/[tenantSlug]/admin/paths';
import { writeAdminSession } from '@/app/(admin)/[tenantSlug]/admin/session';
import { signupSalon, startBillingCheckout } from '@/lib/api-client';

export interface SignupOutcome {
  /** Où envoyer le navigateur : Stripe Checkout, ou l'écran d'abonnement. */
  readonly next: string;
}

export async function signupSalonAction(values: unknown): Promise<AdminActionResult<SignupOutcome>> {
  const locale = await getLocale();
  const parsed = salonSignupRequestSchema.safeParse(values, { errorMap: zodErrorMap(locale) });

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? validationRefusal(locale));
  }

  let opened;
  try {
    opened = await signupSalon(parsed.data);
  } catch (error) {
    return failure(error);
  }

  await writeAdminSession(parsed.data.slug, opened);

  try {
    const checkout = await startBillingCheckout(opened.session.accessToken, locale);
    return { ok: true, data: { next: checkout.url } };
  } catch {
    return { ok: true, data: { next: adminBillingPath(parsed.data.slug) } };
  }
}
