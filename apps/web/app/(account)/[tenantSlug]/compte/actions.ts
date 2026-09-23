'use server';

/**
 * Les actions serveur de l'espace client — la seule voie par laquelle le
 * navigateur atteint l'API, et le seul endroit où les jetons existent.
 *
 * Même doctrine que les actions du tunnel (`(booking)/…/reservation/actions.ts`),
 * et deux règles propres à cette surface :
 *
 * - **aucune action ne rend un jeton.** Ce qu'elles rendent est ce qu'un écran
 *   affiche : un profil, une liste, un message. Les jetons entrent dans les
 *   cookies `httpOnly` de `session.ts` et n'en ressortent pas. C'est ce qui rend
 *   vrai le cinquième critère de #47 — la session ne transite ni par
 *   `localStorage` ni par le bundle du navigateur ;
 * - **la validation est refaite ici.** Rien ne garantit qu'un appel d'action
 *   vienne du formulaire ; l'API revalidera de son côté (web-frontend §4).
 *
 * ## Les refus se disent dans la langue de la requête (#847)
 *
 * Deux familles, et deux sources :
 *
 * - ce que **l'API** refuse se dit par `errorMessage(code, locale)` du contrat
 *   partagé, qui porte une phrase par code et par langue (#845). Le message que
 *   l'API renvoie dans son corps n'est **pas** réaffiché : il est écrit pour un
 *   journal et pour le diagnostic, dans une langue qui n'est pas négociée.
 *   C'est aussi la règle du contrat — *« le front réagit sur `code`, jamais sur
 *   `message` »* (`errors/error-codes.ts`) ;
 * - ce que **ces actions** refusent d'elles-mêmes — un corps que le schéma ne
 *   lit pas — vient du catalogue `account.errors`, comme n'importe quel autre
 *   texte de cet espace.
 */

import {
  ERROR_CODES,
  cancelAppointmentRequestSchema,
  errorMessage,
  loginRequestSchema,
  localeSchema,
  registerRequestSchema,
  rescheduleAppointmentRequestSchema,
  slugSchema,
  updateProfileRequestSchema,
  uuidSchema,
  type BookedAppointment,
  type Locale,
  type SessionUser,
} from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import {
  ApiClientError,
  cancelAppointment,
  loginToAccount,
  logoutSession,
  registerAccount,
  rescheduleAppointment,
  updateOwnProfile,
} from '@/lib/api-client';

import {
  attachAccountLocaleCookies,
  attachProfileLocaleCookies,
  setAccountLocaleMirror,
} from './account-locale';
import {
  accountActionAccess,
  attachPresenceCookie,
  clearSessionCookies,
  readRefreshToken,
  writeSessionCookies,
} from './session';

export type ActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly code: string; readonly message: string };

type Failure = { ok: false; code: string; message: string };

/** La langue de la requête en cours — celle dans laquelle l'écran vient d'agir. */
function actionLocale(): Promise<Locale> {
  return getLocale();
}

/** Ce que l'API a refusé, dit dans la langue de la requête. */
function failure(error: unknown, locale: Locale): Failure {
  const code = error instanceof ApiClientError ? error.code : ERROR_CODES.INTERNAL_ERROR;

  return { ok: false, code, message: errorMessage(code, locale) };
}

/** Refus de validation : l'appel n'a même pas atteint l'API. */
function invalid(message: string): Failure {
  return { ok: false, code: ERROR_CODES.VALIDATION_ERROR, message };
}

/**
 * Ce que l'API a refusé sur **un rendez-vous nommé** — annulation, report —
 * avec les trois refus de #1135 ramenés à deux (#1201).
 *
 * `FORBIDDEN` devient `NOT_FOUND`, code et message compris. Les deux gardes de
 * `public-appointments.controller.ts` ne disent pas la même chose, et c'est
 * précisément pour cela qu'il faut les confondre ici :
 *
 * | Ce que l'API rend | Ce qu'il faut en comprendre |
 * |---|---|
 * | 403 `FORBIDDEN` | le jeton n'est pas celui d'une **cliente** |
 * | 404 `NOT_FOUND` | le rendez-vous n'existe pas, est chez un autre salon, ou appartient à une autre cliente |
 *
 * Rendre le 403 tel quel — « Votre compte n'a pas les droits nécessaires » —
 * apprendrait à qui l'obtient que **le rendez-vous, lui, existe** : le refus
 * porterait sur le porteur du jeton et non sur la ligne visée, et cet écran
 * redeviendrait la sonde d'existence que le 404 de l'API existe pour fermer
 * (tenant-isolation §4). Le message des deux est donc le même, et il ne nomme
 * jamais la propriété du rendez-vous — « ce rendez-vous ne vous appartient pas »
 * dirait par l'écran ce que le 404 tait.
 *
 * `UNAUTHORIZED` n'est pas touché : il traverse jusqu'à `renewIfExpired`, qui
 * renouvelle la session ou mène à la connexion (`lib/session-renewal.ts`). C'est
 * un refus sur la session, pas sur le rendez-vous.
 */
function appointmentFailure(error: unknown, locale: Locale): Failure {
  const refused = failure(error, locale);

  if (refused.code !== ERROR_CODES.FORBIDDEN) {
    return refused;
  }

  return {
    ok: false,
    code: ERROR_CODES.NOT_FOUND,
    message: errorMessage(ERROR_CODES.NOT_FOUND, locale),
  };
}

/**
 * Session absente ou impossible à renouveler — l'écran part vers la route de
 * renouvellement, qui tranche et mène à la connexion.
 */
async function unauthenticated(): Promise<Failure> {
  const t = await getTranslations('account.errors');

  return { ok: false, code: ERROR_CODES.UNAUTHORIZED, message: t('sessionExpired') };
}

/**
 * Le jeton de la session, renouvelé sur place s'il a expiré (#856) — ou le refus
 * que l'écran sait traiter.
 */
async function sessionAccess(
  tenantSlug: string,
  locale: Locale,
): Promise<{ ok: true; accessToken: string } | Failure> {
  const access = await accountActionAccess(tenantSlug);

  switch (access.kind) {
    case 'ready':
      return { ok: true, accessToken: access.accessToken };
    case 'expired':
      return unauthenticated();
    case 'failed':
      return failure(access.error, locale);
  }
}

/**
 * Ouvre une session et la range dans les cookies.
 *
 * Rend le profil, **jamais les jetons** : c'est la frontière que tout le
 * dispositif protège, et elle se tient ici, dans la seule fonction qui les voit.
 */
export async function loginAction(
  tenantSlug: string,
  credentials: unknown,
): Promise<ActionResult<SessionUser>> {
  const locale = await actionLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = loginRequestSchema.safeParse(credentials);

  if (!slug.success || !parsed.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('credentialsRequired'));
  }

  try {
    const opened = await loginToAccount(slug.data, parsed.data);
    await writeSessionCookies(slug.data, opened);
    // Cinquième critère de #847 : après la connexion, l'interface passe dans la
    // langue enregistrée sur le compte. Voir `account-locale.ts`, qui porte la
    // raison pour laquelle le cookie du sélecteur est effacé plutôt que réécrit.
    attachAccountLocaleCookies(await cookies(), opened.session.user.locale);
    return { ok: true, data: opened.session.user };
  } catch (error) {
    return failure(error, locale);
  }
}

/** Inscrit une cliente et ouvre sa session dans la foulée. */
export async function registerAction(
  tenantSlug: string,
  body: unknown,
): Promise<ActionResult<SessionUser>> {
  const locale = await actionLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  /*
   * La langue de lecture part avec l'inscription — `registerRequestSchema.locale`,
   * huitième critère d'acceptation de #844 : *« elle ne décrit pas ce que la
   * personne a saisi, elle constate dans quelle langue elle était en train de
   * lire »*. Elle est posée ici et non par le formulaire : c'est le serveur qui
   * sait quelle langue il vient de rendre, et un champ caché aurait laissé le
   * navigateur en décider.
   *
   * Le corps du formulaire garde la priorité s'il en porte une : le schéma est
   * `.strict()`, et écraser une valeur soumise ferait de ce défaut une règle.
   */
  const parsed = registerRequestSchema.safeParse(
    typeof body === 'object' && body !== null && !('locale' in body)
      ? { ...body, locale }
      : body,
  );

  if (!slug.success || !parsed.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('registrationIncomplete'));
  }

  try {
    const opened = await registerAccount(slug.data, parsed.data);
    await writeSessionCookies(slug.data, opened);
    attachAccountLocaleCookies(await cookies(), opened.session.user.locale);
    return { ok: true, data: opened.session.user };
  } catch (error) {
    return failure(error, locale);
  }
}

/**
 * Ferme la session — **des deux côtés**.
 *
 * L'appel à l'API révoque le jeton de rafraîchissement en base ; effacer les
 * cookies sans lui laisserait une session « fermée » qu'un vol de cookie
 * antérieur pourrait rejouer sept jours durant. L'échec de cet appel n'empêche
 * pas d'effacer les cookies : le résultat visible pour la visiteuse est le même,
 * et lui refuser la déconnexion serait pire que de la lui accorder à moitié.
 */
export async function logoutAction(tenantSlug: string): Promise<ActionResult<null>> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('unknownTenant'));
  }

  const refreshToken = await readRefreshToken();

  if (refreshToken !== null) {
    try {
      await logoutSession(refreshToken);
    } catch {
      // Volontairement avalé — voir l'en-tête.
    }
  }

  clearSessionCookies(await cookies(), slug.data);
  return { ok: true, data: null };
}

/** Met à jour ses propres coordonnées. */
export async function updateProfileAction(
  tenantSlug: string,
  changes: unknown,
): Promise<ActionResult<SessionUser>> {
  const locale = await actionLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = updateProfileRequestSchema.safeParse(changes);

  if (!slug.success || !parsed.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('invalidProfile'));
  }

  const access = await sessionAccess(slug.data, locale);
  if (!access.ok) {
    return access;
  }

  try {
    const updated = await updateOwnProfile(access.accessToken, parsed.data);
    const store = await cookies();
    // L'en-tête du salon salue la cliente par son prénom : il suit la correction.
    attachPresenceCookie(store, slug.data, updated);

    // Troisième critère de #847 : la langue choisie sur l'écran des coordonnées
    // s'applique tout de suite. Les cookies ne bougent que si la demande portait
    // le champ — `updateProfileRequestSchema` est `.partial()`, et un envoi qui
    // ne parle que du téléphone n'a rien à dire de la langue.
    //
    // `attachProfileLocaleCookies` et non `attachAccountLocaleCookies` : le
    // retrait de la préférence emporte aussi le choix du sélecteur, faute de
    // quoi la synchronisation le réinstallerait au rendu suivant. Voir
    // `account-locale.ts`.
    if (parsed.data.locale !== undefined) {
      attachProfileLocaleCookies(store, updated.locale);
    }

    return { ok: true, data: updated };
  } catch (error) {
    return failure(error, locale);
  }
}

/**
 * Enregistre sur le compte la langue que la cliente vient de choisir dans le
 * sélecteur — quatrième critère d'acceptation de #847.
 *
 * ## Pourquoi une action à part, appelée par un îlot client
 *
 * Le sélecteur de langue est une brique partagée (`components/ui/locale-switcher.tsx`)
 * et son action serveur (`i18n/actions.ts`) est commune aux trois coquilles du
 * produit : la vitrine et le back-office n'ont pas de compte client à mettre à
 * jour, et l'un des deux n'a même pas de jeton sous la main. Faire remonter cette
 * écriture-là dans une brique partagée aurait mis un appel à l'API du compte
 * client sur le chemin de chaque changement de langue du produit.
 *
 * Elle est donc **rattachée à l'espace client**, qui est le seul endroit où la
 * question se pose : `components/account-locale-sync.tsx` compare la langue
 * affichée à la préférence enregistrée, et n'appelle ceci que lorsqu'elles
 * diffèrent.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle n'écrit pas le cookie du sélecteur : il est déjà posé, c'est lui qui a
 * déclenché l'appel. Elle ne pose que le **miroir** de la préférence du compte,
 * pour que la comparaison suivante tombe juste et que l'appel n'ait pas lieu
 * deux fois.
 */
export async function saveAccountLocaleAction(
  tenantSlug: string,
  chosen: unknown,
): Promise<ActionResult<SessionUser>> {
  const currentLocale = await actionLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = localeSchema.safeParse(chosen);

  if (!slug.success || !parsed.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('invalidLocale'));
  }

  const access = await sessionAccess(slug.data, currentLocale);
  if (!access.ok) {
    return access;
  }

  try {
    const updated = await updateOwnProfile(access.accessToken, { locale: parsed.data });
    const store = await cookies();
    attachPresenceCookie(store, slug.data, updated);
    setAccountLocaleMirror(store, updated.locale);
    return { ok: true, data: updated };
  } catch (error) {
    return failure(error, currentLocale);
  }
}

/**
 * Annule un de ses rendez-vous, depuis l'espace client.
 *
 * La route appelée est servie sous `/public/{slug}/…`, et elle n'est plus
 * publique pour autant : depuis #1135 elle exige le jeton de la **cliente du
 * rendez-vous**, et l'action le lui joint (#1201). Ce n'est pas un contrôle de
 * plus posé ici — c'est l'API qui tranche la propriété de la ligne, en 404 —,
 * c'est le transport de ce sur quoi elle tranche.
 *
 * `cancelledBy` vaut `CLIENT`, fixé par la route et non par le corps ; et il
 * n'est vrai que parce que le jeton nomme la cliente.
 */
export async function cancelOwnAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  reason?: string,
): Promise<ActionResult<BookedAppointment>> {
  const locale = await actionLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const id = uuidSchema.safeParse(appointmentId);
  const body = cancelAppointmentRequestSchema.safeParse(
    reason === undefined || reason.trim() === '' ? {} : { reason },
  );

  if (!slug.success || !id.success || !body.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('invalidCancellation'));
  }

  // Le jeton **autorise** désormais l'appel (#1135) : sans lui, la route rend
  // 401. Une session simplement expirée se renouvelle sur place ; une session
  // fermée renvoie à la connexion.
  const access = await sessionAccess(slug.data, locale);
  if (!access.ok) {
    return access;
  }

  try {
    return {
      ok: true,
      data: await cancelAppointment(slug.data, id.data, access.accessToken, body.data),
    };
  } catch (error) {
    return appointmentFailure(error, locale);
  }
}

/** Reporte un de ses rendez-vous — même régime que l'annulation ci-dessus. */
export async function rescheduleOwnAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  request: unknown,
): Promise<ActionResult<BookedAppointment>> {
  const locale = await actionLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const id = uuidSchema.safeParse(appointmentId);
  const body = rescheduleAppointmentRequestSchema.safeParse(request);

  if (!slug.success || !id.success || !body.success) {
    const t = await getTranslations('account.errors');
    return invalid(t('invalidReschedule'));
  }

  const access = await sessionAccess(slug.data, locale);
  if (!access.ok) {
    return access;
  }

  try {
    return {
      ok: true,
      data: await rescheduleAppointment(slug.data, id.data, access.accessToken, body.data),
    };
  } catch (error) {
    return appointmentFailure(error, locale);
  }
}
