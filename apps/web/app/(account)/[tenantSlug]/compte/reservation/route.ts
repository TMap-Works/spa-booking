import {
  bookGuestAppointmentRequestSchema,
  ERROR_CODES,
  errorMessage,
  slugSchema,
  type Locale,
} from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import { NextResponse } from 'next/server';

import type { BookingOutcome } from '@/app/(booking)/[tenantSlug]/reservation/booking-request';
import { ApiClientError, bookGuestAppointment } from '@/lib/api-client';

import { accountActionAccess } from '../session';

/**
 * La prise de rendez-vous par la cliente, **appelable depuis le tunnel**
 * (#1207).
 *
 * ## Pourquoi une route et non l'action serveur d'avant
 *
 * `bookAppointmentAction` vivait sous `(booking)/…/reservation/actions.ts`, et
 * elle ne pouvait plus aboutir. Une action serveur est postée sur l'URL de la
 * page qui l'appelle : le tunnel est servi sur `/{slug}/reservation`, les deux
 * cookies de session sont posés sur `/{slug}/compte` (`../session.ts`), et le
 * navigateur ne les joint qu'aux requêtes de ce chemin-là. L'appel partait donc
 * sans en-tête `Authorization` vers une route que #1136 garde par
 * `@Auth('CLIENT')` — 401, et le parcours critique au rouge à l'étape
 * « Confirmation » (PR #1206).
 *
 * Ce qui manquait n'était pas un contrôle, c'était une **adresse d'où la session
 * part** : celle-ci en est une, pour la raison exacte qui met déjà sous
 * `accountPath` l'annulation appelée du tunnel (`rendez-vous/[appointmentId]/
 * annulation/route.ts`, #1201) et le flux temps réel (`flux/route.ts`). Les
 * trois routes du tunnel public se tranchent ainsi de la même façon, ce que
 * l'issue demandait « une fois pour les trois ».
 *
 * ## L'ordre des deux tickets, et ce qu'il vaut aujourd'hui
 *
 * #1136 est ce qui **pose** la garde ; sa PR #1206 a été fermée, et `develop` ne
 * la porte donc pas encore : `book` y est explicitement ouverte
 * (`public-appointments.controller.ts`, « Pas de garde sur `book` »). L'en-tête
 * `Authorization` que cette route joint est, ce jour, simplement ignoré par
 * l'API — la réservation aboutit comme avant, et le parcours critique reste
 * vert. Elle deviendra la condition de la réservation au merge de #1136, sans
 * qu'une ligne d'ici ne bouge : c'est tout l'objet de ce ticket, qui est le
 * prérequis de l'autre et non l'inverse.
 *
 * Deux phrases de ce fichier n'énoncent donc la vérité qu'**après** ce merge —
 * « le jeton désigne la cliente » et « `client` devient sans effet ». Elles sont
 * écrites au futur là où elles le disent.
 *
 * ## Ce que cette route n'ouvre pas
 *
 * - **rien qui ne soit déjà offert** : le tunnel prenait déjà ce rendez-vous,
 *   par une action serveur montée sur la même validation et le même client
 *   d'API. Ce qui change est le chemin par lequel la demande arrive, et le jeton
 *   qu'elle emporte ;
 * - **aucun choix de compte** : le jeton est lu des cookies, jamais du corps.
 *   Une fois #1136 mergée, c'est lui — et non l'adresse e-mail postée — qui
 *   désignera la cliente à qui le rendez-vous se rattache ;
 * - **aucune écriture depuis un autre site** : les cookies de session sont
 *   `sameSite: 'lax'`, que le navigateur ne joint jamais à une requête `POST`
 *   d'origine tierce. Sans eux, la route s'arrête sur son propre 401 avant
 *   d'appeler quoi que ce soit.
 *
 * ## `client` ne part plus, depuis #1222
 *
 * Il partait jusqu'ici parce que le contrat l'exigeait, puis parce que le
 * retirer d'un côté sans l'autre aurait fait rendre 400 à toute réservation —
 * `bookGuestAppointmentRequestSchema` est `.strict()`. L'ordre a été tenu :
 * `summary-step.tsx` a cessé de l'envoyer, **puis** le contrat a perdu le champ,
 * la fabrique par pays et le pipe côté API. Ce que l'écran demande à la cliente
 * n'en a jamais dépendu — l'étape « Coordonnées » résume le compte au lieu de le
 * redemander (#1050, #1086).
 *
 * ## L'établissement illisible a son code, et son statut est 404 — #1394
 *
 * Cette route était, avec l'annulation de l'espace client, l'une des deux
 * surfaces que la classe ouverte par #1372 et refermée par #1391 avait laissées
 * dehors : dix **modules d'actions serveur** rendent `TENANT_NOT_FOUND`, et ces
 * deux **Route Handlers** jugeaient encore le même slug sous `VALIDATION_ERROR`,
 * sous la phrase de leur geste — ici « Les informations de réservation sont
 * incomplètes. » pour un segment d'URL que personne n'avait tapé. Le défaut les a
 * suivies quand #1201 et #1207 les ont converties en routes, et il est sorti du
 * périmètre que les en-têtes d'`admin/action-result.ts` et de
 * `WEB_ACTION_ERROR_CODES` auditaient — ceux-là parlaient de « modules d'actions
 * serveur », au mot près.
 *
 * Le partage est celui de #1391, et il tient en une ligne : **l'établissement au
 * contrat, la charge utile au catalogue.**
 *
 * | Refus | Code | Statut | Phrase |
 * |---|---|---|---|
 * | le slug n'est pas une adresse de salon | `TENANT_NOT_FOUND` | **404** | contrat, `errorMessage` |
 * | le corps n'est pas lisible, ou le schéma le refuse | `VALIDATION_ERROR` | 400 | catalogue, `tunnel.actions.bookingIncomplete` |
 *
 * Le contrat ne sait pas dire **de quelle** demande il s'agissait ; le tunnel,
 * oui — d'où la seconde ligne, inchangée. Et « Cet établissement est
 * introuvable. » est exactement ce qu'il y a à dire de la première, dans les deux
 * langues.
 *
 * ### Pourquoi 404 et non le 400 d'avant
 *
 * C'est la seule chose que les dix modules d'actions n'avaient pas eu à
 * trancher : ils ne rendent qu'un résultat, une route porte un statut. Le contrat
 * ne le tranche pas pour nous — l'en-tête d'`error-codes.ts` écrit que ce fichier
 * *« n'est pas une table de correspondance vers des statuts HTTP »*. L'argumentaire
 * complet est en tête de la route d'annulation ; il tient à trois choses : l'API
 * répond déjà 404 à cette cause exacte, slug mal formé compris
 * (`tenant-scope.middleware.ts`), la troisième route du dépôt qui juge ce slug le
 * rend déjà ainsi (`admin/encaissement/ticket/[saleId]/route.ts`), et un 400 dit
 * que la **charge utile** est mal formée — la confusion même que ce fil corrige.
 *
 * Aucun appelant ne lit le statut : `booking-request.ts` relit le corps quel qu'il
 * soit, et `summary-step.tsx` trie sur le `code`.
 */
export const dynamic = 'force-dynamic';

/** Le refus, dans la forme que l'écran attend, avec le statut qui lui convient. */
function refused(code: string, message: string, status: number): NextResponse {
  const body: BookingOutcome = { ok: false, code, message };

  return NextResponse.json(body, { status });
}

/**
 * Ce qu'une panne de transport vaut comme refus — code, phrase et statut.
 *
 * Un refus de l'API garde son **code** et son statut : c'est sur lui, et sur lui
 * seul, que le récapitulatif distingue le créneau perdu (409) de l'adresse
 * refusée (409 elle aussi) et de la session échue (401). Sa **phrase**, elle,
 * vient du catalogue partagé et jamais du corps de l'API — même arbitrage que la
 * route d'annulation.
 */
function refusalOf(error: unknown, locale: Locale): [string, string, number] {
  const code = error instanceof ApiClientError ? error.code : ERROR_CODES.INTERNAL_ERROR;
  const status = error instanceof ApiClientError ? error.status : 500;

  return [code, errorMessage(code, locale), status];
}

/**
 * Refus faute d'établissement : le slug de l'URL n'en désigne aucun — #1394.
 *
 * Le jumeau de celui de la route d'annulation, et de ceux des dix modules
 * d'actions serveur. Code, statut et provenance de la phrase sont instruits en
 * tête de ce module ; l'argumentaire du statut, en tête de
 * `rendez-vous/[appointmentId]/annulation/route.ts`.
 *
 * Il ne consulte pas le catalogue du tunnel, et c'est la décision : la phrase du
 * contrat nomme l'établissement dans les deux langues, là où le catalogue ne
 * saurait que redire le refus du geste.
 */
function unknownTenant(locale: Locale): NextResponse {
  return refused(
    ERROR_CODES.TENANT_NOT_FOUND,
    errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
    404,
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantSlug: string }> },
): Promise<NextResponse> {
  const { tenantSlug } = await context.params;
  const locale = (await getLocale()) as Locale;
  const slug = slugSchema.safeParse(tenantSlug);

  // Le slug se juge **seul et en premier** (#1394), et le catalogue n'est pas même
  // consulté pour ce refus-là : sa phrase vient du contrat partagé.
  if (!slug.success) {
    return unknownTenant(locale);
  }

  // Le catalogue du **tunnel**, et non celui de l'espace client : ces phrases
  // s'affichent au récapitulatif de la réservation, et ce sont exactement celles
  // que l'action serveur d'avant y écrivait. Les redire sous `account.errors`
  // ferait deux libellés pour un même refus (`ds:libelles`).
  const t = await getTranslations('booking');
  const access = await accountActionAccess(slug.data);

  if (access.kind === 'expired') {
    // Plus rien à renouveler — pas de cookie de rafraîchissement, ou l'API le
    // refuse. Le code compte autant que le statut : c'est lui que le
    // récapitulatif traduit en retour à l'écran de connexion (`onSignInRequired`).
    return refused(ERROR_CODES.UNAUTHORIZED, t('tunnel.actions.signInRequired'), 401);
  }

  if (access.kind === 'failed') {
    // Le renouvellement n'a pas abouti, et ce n'est **pas** une session morte :
    // limiteur, panne, coupure (`accessTokenForAction`). Le dire « expirée »
    // renverrait se connecter une cliente dont la session est valide, et lui
    // ferait perdre le tunnel qu'elle vient de parcourir, là où réessayer aurait
    // suffi.
    return refused(...refusalOf(access.error, locale));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refused(ERROR_CODES.VALIDATION_ERROR, t('tunnel.actions.bookingIncomplete'), 400);
  }

  try {
    /*
     * Une constante, et plus une fabrique instanciée avec le pays du salon
     * (#1222). Le pays ne servait qu'au téléphone de `client`, et la demande ne
     * porte plus de coordonnées : rien de ce qui reste — prestation, praticien,
     * instant, mot de la cliente, consentement — ne dépend de l'établissement.
     *
     * La validation, elle, reste faite ici et **normalise** : ce qui part vers
     * l'API est la sortie transformée du schéma — l'instant ramené en UTC — et
     * non le corps reçu du navigateur.
     */
    const parsed = bookGuestAppointmentRequestSchema.safeParse(body);

    if (!parsed.success) {
      return refused(ERROR_CODES.VALIDATION_ERROR, t('tunnel.actions.bookingIncomplete'), 400);
    }

    const data = await bookGuestAppointment(slug.data, access.accessToken, parsed.data);
    const outcome: BookingOutcome = { ok: true, data };

    return NextResponse.json(outcome, { status: 201 });
  } catch (error) {
    return refused(...refusalOf(error, locale));
  }
}
