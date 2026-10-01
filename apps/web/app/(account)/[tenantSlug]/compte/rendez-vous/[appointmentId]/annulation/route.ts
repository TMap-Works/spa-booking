import { ERROR_CODES, errorMessage, slugSchema, uuidSchema, type Locale } from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import { NextResponse } from 'next/server';

import { ApiClientError, cancelAppointment } from '@/lib/api-client';

import { accountActionAccess } from '../../../session';
import type { CancellationOutcome } from './cancellation-request';

/**
 * L'annulation d'un rendez-vous par la cliente, **appelable depuis le tunnel**
 * (#1201).
 *
 * ## Pourquoi une route et non une action serveur de plus
 *
 * L'espace client annule déjà par action serveur (`compte/actions.ts`), et c'est
 * la bonne forme quand l'écran est servi sous `/{slug}/compte` : le navigateur
 * joint les cookies de session, qui sont posés sur ce chemin-là.
 *
 * L'écran de confirmation du tunnel, lui, est servi sur `/{slug}/reservation`.
 * Une action serveur appelée de là poste sur l'URL de cette page, le navigateur
 * n'y joint aucun cookie de session, et la route de l'API — gardée depuis #1135
 * — rend 401. Ce qui manquait au lien d'annulation n'était pas un contrôle,
 * c'était une **adresse d'où la session part** : celle-ci en est une, pour la
 * raison exacte qui met déjà le flux temps réel sous `accountPath`
 * (`compte/flux/route.ts`, `cancellationPath`).
 *
 * ## Ce que cette route n'ouvre pas
 *
 * - **rien qui ne soit déjà offert** : la cliente connectée annule ses
 *   rendez-vous depuis son espace (`CancelAppointmentControl`). Cette route sert
 *   le même geste à un écran qui ne peut pas atteindre l'autre ;
 * - **aucun choix de cible** : l'identifiant est dans le chemin, le corps n'est
 *   pas lu, et c'est l'API qui tranche la propriété de la ligne — en **404**,
 *   indiscernable d'un identifiant inconnu (tenant-isolation §4) ;
 * - **aucune écriture depuis un autre site** : les cookies de session sont
 *   `sameSite: 'lax'`, que le navigateur ne joint jamais à une requête `POST`
 *   d'origine tierce. Sans eux, la route s'arrête sur son propre 401 avant
 *   d'appeler quoi que ce soit.
 *
 * ## Les refus qu'elle rend, et pourquoi 403 n'en est pas
 *
 * Même règle que `compte/actions.ts` : `FORBIDDEN` devient `NOT_FOUND`, code et
 * message compris. Rendre le 403 tel quel apprendrait à qui l'obtient que le
 * rendez-vous, lui, existe.
 *
 * ## L'établissement illisible se juge seul, et se rend en 404 — #1394
 *
 * Cette route était, avec `compte/reservation/route.ts`, l'une des deux surfaces
 * que la classe ouverte par #1372 et refermée par #1391 avait laissées dehors :
 * les **modules d'actions serveur** rendaient `TENANT_NOT_FOUND`, et ces deux
 * **Route Handlers** jugeaient encore le même slug sous `VALIDATION_ERROR`. Le
 * défaut les avait suivies quand #1201 et #1207 les ont converties en routes,
 * faute de pouvoir joindre le jeton de la cliente depuis une action, et il est
 * sorti du périmètre que les en-têtes d'`admin/action-result.ts` et de
 * `WEB_ACTION_ERROR_CODES` auditaient — ces deux-là parlaient de « modules
 * d'actions serveur », au mot près.
 *
 * Ici le symptôme était le plus net de toute la classe : le slug se jugeait **du
 * même `if`** que l'identifiant du rendez-vous, si bien que le refus rendu dépendait
 * de l'ordre des tests d'un `||`, et qu'un segment d'URL qui ne désigne aucun
 * établissement se disait « La demande d'annulation est incomplète. ». Les deux
 * gardes sont séparées, et le slug passe le premier — un identifiant jugé sur une
 * adresse qui ne mène nulle part enverrait chercher une faute qu'on n'a pas
 * commise. L'identifiant n'est même plus lu dans ce cas.
 *
 * ### Le statut, que ce fichier décide et que le contrat ne dit pas
 *
 * Un module d'actions ne rend qu'un résultat ; une route porte un **statut**, et
 * c'est la seule chose que les modules d'actions n'avaient pas eu à trancher. Le
 * contrat partagé ne le tranche pas pour nous — l'en-tête d'`error-codes.ts`
 * l'écrit : *« ce fichier n'est pas une table de correspondance vers des statuts
 * HTTP »*. **404, et non le 400 d'avant** :
 *
 * - **l'API répond déjà 404 à cette cause exacte**, slug mal formé compris.
 *   `tenant-scope.middleware.ts` fond en un seul 404 « slug inconnu »,
 *   « établissement désactivé », « slug mal formé » et « sous-domaine en
 *   désaccord », *« quatre refus qu'il n'y a aucune raison de laisser
 *   distinguer »*. Une route qui refuse **avant** d'appeler doit rendre ce que
 *   l'appel aurait rendu : en 400, le statut devenait à lui seul le discriminant
 *   que ce commentaire-là refuse de laisser lire — 400 pour « refusé par
 *   `slugSchema` », 404 pour « refusé par la table `tenants` » ;
 * - **c'est déjà ce que rend la troisième route qui juge ce slug**, le PDF de
 *   ticket du comptoir (`admin/encaissement/ticket/[saleId]/route.ts`), sur le
 *   même `safeParse` en échec. Elle avait tranché seule ; les deux autres s'y
 *   alignent ;
 * - **400 dit que la charge utile est mal formée**, et c'est exactement la
 *   confusion que ce fil a corrigée chez chacun de ses émetteurs au niveau du
 *   *code*. La laisser debout au niveau du *statut* l'aurait reconduite d'un cran
 *   plus bas.
 *
 * Le refus de l'**identifiant**, lui, garde `VALIDATION_ERROR` **et** 400 : c'est
 * bien une charge utile mal formée, et sa phrase reste celle du catalogue, qui
 * dit de quelle demande il s'agissait là où le contrat ne le sait pas (règle de
 * #1391, en tête de `(booking)/[tenantSlug]/reservation/actions.ts`).
 *
 * Aucun appelant ne lit le statut, et cela a été vérifié plutôt que supposé :
 * `cancellation-request.ts` relit le **corps** quel que soit le statut, et
 * l'écran trie sur le `code`.
 */
export const dynamic = 'force-dynamic';

/** Le refus, dans la forme que l'écran attend, avec le statut qui lui convient. */
function refused(code: string, message: string, status: number): NextResponse {
  const body: CancellationOutcome = { ok: false, code, message };

  return NextResponse.json(body, { status });
}

/**
 * Ce qu'une panne de transport vaut comme refus — code, phrase et statut.
 *
 * Un refus de l'API garde son code et son statut ; tout le reste — une panne
 * que le client d'API n'a pas su nommer — retombe sur `INTERNAL_ERROR` en 500.
 * La phrase vient du catalogue partagé, jamais du corps de l'API (`errorMessage`).
 */
function refusalOf(error: unknown, locale: Locale): [string, string, number] {
  const code = error instanceof ApiClientError ? error.code : ERROR_CODES.INTERNAL_ERROR;
  const status = error instanceof ApiClientError ? error.status : 500;

  return [code, errorMessage(code, locale), status];
}

/**
 * Refus faute d'établissement : le slug de l'URL n'en désigne aucun — #1394.
 *
 * Le jumeau de ce que le back-office (`admin/action-result.ts`), l'espace client
 * (`compte/actions.ts`) et le tunnel public (`(booking)/…/reservation/actions.ts`)
 * rendent déjà, à la seule chose près qu'une route ajoute : le **statut**. Code,
 * statut et provenance de la phrase sont instruits en tête de ce module.
 *
 * La phrase vient du contrat partagé et non du catalogue de cet espace : « Cet
 * établissement est introuvable. » est exactement ce qu'il y a à dire, et le
 * contrat le dit dans les deux langues (règle de #1391).
 */
function unknownTenant(locale: Locale): NextResponse {
  return refused(
    ERROR_CODES.TENANT_NOT_FOUND,
    errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
    404,
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ tenantSlug: string; appointmentId: string }> },
): Promise<NextResponse> {
  const { tenantSlug, appointmentId } = await context.params;
  const locale = (await getLocale()) as Locale;
  const slug = slugSchema.safeParse(tenantSlug);

  // Le slug se juge **seul et en premier** (#1394) : il ne partage plus son `if`
  // avec l'identifiant du rendez-vous, et celui-ci n'est pas même lu tant que
  // l'adresse ne désigne aucun établissement.
  if (!slug.success) {
    return unknownTenant(locale);
  }

  const id = uuidSchema.safeParse(appointmentId);

  if (!id.success) {
    const t = await getTranslations('account.errors');
    return refused(ERROR_CODES.VALIDATION_ERROR, t('invalidCancellation'), 400);
  }

  const access = await accountActionAccess(slug.data);

  if (access.kind === 'expired') {
    // Plus rien à renouveler — pas de cookie de rafraîchissement, ou l'API le
    // refuse. Cet écran-ci n'a pas de route de renouvellement à sa portée — elle
    // vit, elle aussi, sous `/{slug}/compte`. Il invite donc à se connecter, et
    // le lien vers l'espace client est déjà sous ses yeux.
    const t = await getTranslations('account.errors');
    return refused(ERROR_CODES.UNAUTHORIZED, t('sessionExpired'), 401);
  }

  if (access.kind === 'failed') {
    // Le renouvellement n'a pas abouti, et ce n'est **pas** une session morte :
    // limiteur, panne, coupure (`accessTokenForAction`). Le dire « expirée »
    // enverrait se reconnecter une cliente dont la session est valide, là où
    // réessayer aurait suffi — `sessionAccess` de `compte/actions.ts` fait déjà
    // cette distinction, et cette route la tient de la même façon.
    return refused(...refusalOf(access.error, locale));
  }

  try {
    const data = await cancelAppointment(slug.data, id.data, access.accessToken);
    const body: CancellationOutcome = { ok: true, data };

    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    // Le 403 de la garde `CLIENT` devient un 404, code et message compris :
    // rendu tel quel, il apprendrait à qui l'obtient que le rendez-vous existe.
    if (error instanceof ApiClientError && error.code === ERROR_CODES.FORBIDDEN) {
      return refused(ERROR_CODES.NOT_FOUND, errorMessage(ERROR_CODES.NOT_FOUND, locale), 404);
    }

    return refused(...refusalOf(error, locale));
  }
}
