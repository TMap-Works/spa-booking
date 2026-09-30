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
 *
 * ## Les refus se disent par leur code — #1234
 *
 * Ces actions rendaient des phrases françaises en dur — « Établissement
 * inconnu. », « Langue inconnue. », « Renseignez votre adresse e-mail et votre
 * mot de passe. ». Aucune n'est affichée aujourd'hui, les écrans de connexion et
 * d'invitation triant sur le `code` (`admin-login-form.tsx`,
 * `admin-invitation-form.tsx`) — mais une phrase en dur finit toujours par
 * s'afficher, et celle-ci l'aurait fait en français sur un back-office anglais.
 *
 * Elles passent donc par la phrase du **code**, et non par un littéral. Depuis
 * #1310 elle vient de `validationRefusal(locale)` d'`action-result.ts` — le
 * module qui dit déjà comment un refus se présente, et qui pose
 * `VALIDATION_ERROR` — plutôt que d'un `errorMessage(ERROR_CODES.VALIDATION_ERROR,
 * locale)` recopié à chaque site d'appel. Toujours ce code-là, et jamais un code
 * choisi pour la phrase qu'il porte : une phrase qui dirait autre chose que son
 * code rendrait le refus illisible pour l'écran, qui trie sur le code.
 *
 * ## Et le message que le schéma nomme lui-même — #1299
 *
 * Deux refus rendent mieux que la phrase générique : celui de l'acceptation
 * d'invitation et celui des réglages du salon rendent `issues[0].message`, qui
 * nomme le champ fautif. Il venait de la carte **globale** de zod, posée par le
 * contrat partagé en `DIAGNOSTIC_LOCALE = 'fr'` pour ses journaux (#1232) —
 * c'est-à-dire du français sur un back-office anglais, au moment précis où la
 * validation client a laissé passer quelque chose. Leur `safeParse` reçoit
 * désormais `zodErrorMap(locale)` : une carte contextuelle l'emporte sur la
 * globale, par conception de zod.
 *
 * Ce « premier refus du schéma, à défaut la phrase du code » est lui-même rendu
 * par `invalidFromZod(error, locale)` depuis #1319 : la forme était recopiée à
 * cinq sites, et sa place est auprès d'`invalid()` — voir l'en-tête
 * d'`action-result.ts`, qui porte la décision et son motif.
 *
 * ## Et l'établissement inconnu se dit par son code — #1379
 *
 * Les cinq sites de ce module qui jugent le slug de l'URL le refusaient sous
 * `VALIDATION_ERROR`, c'est-à-dire sous la tournure générique du refus de
 * saisie — « Certaines informations sont incomplètes ou mal formées. » pour un
 * segment d'URL que personne n'a tapé. Ils rendent `unknownTenant()` désormais,
 * comme les sept autres modules d'actions du produit depuis #1372 et #1375.
 *
 * **Le slug se juge d'abord, et seul.** Trois de ces cinq sites le jugeaient du
 * même `if` que leur charge utile, si bien que le refus rendu dépendait de
 * l'ordre des tests d'un `||`. Ils sont scindés, et l'ordre est partout le même :
 * l'établissement, puis la saisie. C'est l'ordre juste, et non une commodité —
 * un slug qui ne désigne aucun établissement rend la saisie sans objet, et
 * reprocher un mot de passe sur une adresse qui ne mène nulle part envoie
 * chercher une faute qui n'est pas celle qu'on a commise.
 */

import {
  acceptInvitationRequestSchema,
  loginRequestSchema,
  slugSchema,
  submittedLocaleSchema,
  updateTenantRequestSchema,
  zodErrorMap,
  type Locale,
  type SessionUser,
  type Tenant,
} from '@spa/shared';
import { getLocale } from 'next-intl/server';
import { cookies } from 'next/headers';

import {
  acceptInvitation,
  loginToAccount,
  logoutSession,
  openBillingPortal,
  startBillingCheckout,
  updateTenantSettings,
} from '@/lib/api-client';

import {
  failure,
  invalid,
  invalidFromZod,
  unknownTenant,
  validationRefusal,
  type AdminActionResult,
} from './action-result';
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

  // L'établissement d'abord, et seul : l'écran de connexion retombe sur
  // `errorMessage(code, locale)` pour tout code qu'il ne nomme pas
  // (`admin-login-form.tsx`, table `FAILURE_KEYS`), et c'est donc la phrase qui
  // nomme l'établissement qui s'affiche, sous le titre neutre « Connexion
  // impossible » — et non « Renseignez votre adresse e-mail et votre mot de
  // passe. » sur une adresse qui ne mène nulle part (#1379).
  if (!slug.success) {
    return unknownTenant();
  }
  if (!parsed.success) {
    return invalid(validationRefusal(await getLocale()));
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
  const locale = await getLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = acceptInvitationRequestSchema.safeParse(values, { errorMap: zodErrorMap(locale) });

  // Le cas que #1319 avait laissé à part, et que #1379 tranche : ces deux refus
  // se jugeaient d'un même `if`, et l'`undefined` d'`invalidFromZod` servait
  // exactement le slug illisible — un refus sans qu'aucune `ZodError` n'existe.
  //
  // C'est l'établissement qui l'emporte. Deux raisons, et la seconde est la
  // décisive : l'ordre est celui des quatre autres sites de ce module, et l'écran
  // d'invitation reconduirait sinon le défaut que tout ce fil corrige — « douze
  // caractères au minimum » là où il n'y a aucun établissement dans lequel
  // accepter l'invitation, donc rien à corriger sur cet écran. La saisie, elle,
  // ne perd rien : elle est jugée juste après, et son refus nomme toujours le
  // champ fautif.
  if (!slug.success) {
    return unknownTenant();
  }
  if (!parsed.success) {
    // Le premier refus du schéma quand il en nomme un — c'est ce qui distingue
    // « douze caractères au minimum » d'un mot de passe absent. À défaut, la
    // phrase du code, et non un littéral.
    return invalidFromZod(parsed.error, locale);
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
    return unknownTenant();
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
  const locale = await getLocale();
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = updateTenantRequestSchema.safeParse(changes, { errorMap: zodErrorMap(locale) });

  if (!slug.success) {
    return unknownTenant();
  }
  if (!parsed.success) {
    // Le message du premier refus, et non un « formulaire invalide » générique :
    // c'est ce qui distingue « code pays attendu » de « deux plages du même jour
    // se recouvrent », et l'écran n'a pas d'autre source pour le dire. Il est dit
    // dans la langue de la requête depuis #1299 — la carte contextuelle
    // ci-dessus l'emporte sur la carte globale du contrat, en français.
    return invalidFromZod(parsed.error, locale);
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

  // Le slug et la langue sont deux entrées de cette action, et elles ne se
  // refusent plus du même code depuis #1379 : une langue hors contrat est un
  // refus de saisie — le panneau d'abonnement l'a envoyée —, un slug illisible
  // n'en est pas un. Le panneau range le seul `code` du refus et en réécrit la
  // phrase au rendu (`billing-panel.tsx`, repli `errorMessage`) : il nomme donc
  // l'établissement sans rien changer à sa table de codes.
  if (!slug.success) {
    return unknownTenant();
  }
  if (!submitted.success) {
    return invalid(validationRefusal(await getLocale()));
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
