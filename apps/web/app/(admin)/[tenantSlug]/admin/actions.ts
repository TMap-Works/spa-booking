'use server';

/**
 * Les actions serveur du back-office — la seule voie par laquelle le navigateur
 * atteint l'API, et le seul endroit où les jetons existent.
 *
 * Même doctrine que les actions de l'espace client :
 *
 * - **aucune action ne rend un jeton.** Ce qu'elles rendent est ce qu'un écran
 *   affiche. Les jetons entrent dans les cookies `httpOnly` de `session.ts` et
 *   n'en ressortent pas ;
 * - **la validation est refaite ici.** Rien ne garantit qu'un appel d'action
 *   vienne du formulaire ; l'API revalidera de son côté (web-frontend §4). Les
 *   schémas sont ceux de `@spa/shared` — la même règle des deux côtés, écrite
 *   une fois.
 */

import {
  acceptInvitationRequestSchema,
  loginRequestSchema,
  slugSchema,
  submittedLocaleSchema,
  updateTenantRequestSchema,
  type Locale,
  type SessionUser,
  type Tenant,
} from '@spa/shared';
import { cookies } from 'next/headers';

import {
  acceptInvitation,
  loginToAccount,
  logoutSession,
  openBillingPortal,
  startBillingCheckout,
  updateTenantSettings,
} from '@/lib/api-client';

import { failure, invalid, type AdminActionResult } from './action-result';
import {
  clearAdminSession,
  adminActionAccess,
  readAdminRefreshToken,
  writeAdminSession,
} from './session';

/**
 * Ouvre une session de back-office et la range dans les cookies.
 *
 * La route d'authentification est la même que celle de l'espace client — il n'y
 * a qu'une identité par établissement, et c'est le **rôle** porté par le jeton
 * qui ouvre ou ferme les écrans. Un compte `CLIENT` obtient donc une session
 * ici, et se heurte au 403 de l'API dès le premier écran de réglages : c'est le
 * bon endroit pour cette décision, l'API étant la seule à ne pas pouvoir être
 * contournée.
 */
export async function adminLoginAction(
  tenantSlug: string,
  credentials: unknown,
): Promise<AdminActionResult<SessionUser>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = loginRequestSchema.safeParse(credentials);

  if (!slug.success || !parsed.success) {
    return invalid('Renseignez votre adresse e-mail et votre mot de passe.');
  }

  try {
    const opened = await loginToAccount(slug.data, parsed.data);
    await writeAdminSession(slug.data, opened);
    return { ok: true, data: opened.session.user };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Active un compte invité — le gérant d'un salon qu'on vient d'ouvrir, ou un
 * membre de son équipe — et ouvre sa session dans la foulée.
 *
 * L'établissement est une revendication signée du jeton : le slug de l'URL ne
 * sert qu'à borner le chemin des cookies, comme à la connexion.
 */
export async function adminAcceptInvitationAction(
  tenantSlug: string,
  values: unknown,
): Promise<AdminActionResult<SessionUser>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = acceptInvitationRequestSchema.safeParse(values);

  if (!slug.success || !parsed.success) {
    return invalid(
      parsed.success
        ? 'Établissement inconnu.'
        : (parsed.error.issues[0]?.message ?? 'Le mot de passe choisi est invalide.'),
    );
  }

  try {
    const opened = await acceptInvitation(parsed.data);
    await writeAdminSession(slug.data, opened);
    return { ok: true, data: opened.session.user };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Ferme la session — **des deux côtés**.
 *
 * L'appel à l'API révoque le jeton de rafraîchissement en base ; effacer les
 * cookies sans lui laisserait une session « fermée » qu'un vol de cookie
 * antérieur pourrait rejouer sept jours durant.
 */
export async function adminLogoutAction(tenantSlug: string): Promise<AdminActionResult<null>> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  const refreshToken = await readAdminRefreshToken();

  if (refreshToken !== null) {
    try {
      await logoutSession(refreshToken);
    } catch {
      // Volontairement avalé : le résultat visible est le même, et refuser la
      // déconnexion serait pire que de l'accorder à moitié.
    }
  }

  clearAdminSession(await cookies(), slug.data);
  return { ok: true, data: null };
}

/**
 * Enregistre les réglages de l'établissement — adresse, horaires, coordonnées
 * (#343).
 *
 * La charge utile est **partielle** par construction : `updateTenantRequestSchema`
 * est `.partial()`, et l'écran n'envoie que ce qu'il affiche. Le `null` d'un
 * champ efface sa valeur ; son absence n'y touche pas.
 */
export async function updateTenantSettingsAction(
  tenantSlug: string,
  changes: unknown,
): Promise<AdminActionResult<Tenant>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = updateTenantRequestSchema.safeParse(changes);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }
  if (!parsed.success) {
    // Le message du premier refus, et non un « formulaire invalide » générique :
    // c'est ce qui distingue « code pays attendu » de « deux plages du même jour
    // se recouvrent », et l'écran n'a pas d'autre source pour le dire.
    return invalid(parsed.error.issues[0]?.message ?? 'Les réglages saisis sont invalides.');
  }

  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access;
  }

  const { accessToken } = access;

  try {
    return { ok: true, data: await updateTenantSettings(accessToken, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Ouvre la page de paiement Stripe de l'abonnement (ADR 0016) et en rend
 * l'adresse — le navigateur y part aussitôt. La carte n'est saisie que chez
 * Stripe (payments-stripe §1).
 *
 * `locale` est la langue lue à l'écran au moment du clic (#1261) — voir
 * {@link billingRedirect}.
 */
export async function startBillingCheckoutAction(
  tenantSlug: string,
  locale: string,
): Promise<AdminActionResult<string>> {
  return billingRedirect(tenantSlug, locale, startBillingCheckout);
}

/** Ouvre le portail client de Stripe : carte, factures, résiliation. */
export async function openBillingPortalAction(
  tenantSlug: string,
  locale: string,
): Promise<AdminActionResult<string>> {
  return billingRedirect(tenantSlug, locale, openBillingPortal);
}

/**
 * Le tronc commun des deux ouvertures de page hébergée.
 *
 * `locale` arrive en `string` et non en `Locale` : une action serveur est une
 * **frontière réseau**, et rien ne garantit qu'un appel vienne du panneau
 * d'abonnement. Elle est donc jugée ici par `submittedLocaleSchema` — le schéma
 * du contrat, celui-là même que l'API rejouera de son côté (web-frontend §4) —
 * et une langue inconnue s'arrête avant l'appel plutôt que d'aller chercher un
 * 400 à l'autre bout.
 */
async function billingRedirect(
  tenantSlug: string,
  locale: string,
  open: (accessToken: string, locale: Locale) => Promise<{ url: string }>,
): Promise<AdminActionResult<string>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const submitted = submittedLocaleSchema.safeParse(locale);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }
  if (!submitted.success) {
    return invalid('Langue inconnue.');
  }

  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access;
  }

  try {
    return { ok: true, data: (await open(access.accessToken, submitted.data)).url };
  } catch (error) {
    return failure(error);
  }
}
