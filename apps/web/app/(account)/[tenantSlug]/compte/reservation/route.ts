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

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantSlug: string }> },
): Promise<NextResponse> {
  const { tenantSlug } = await context.params;
  const locale = (await getLocale()) as Locale;
  // Le catalogue du **tunnel**, et non celui de l'espace client : ces phrases
  // s'affichent au récapitulatif de la réservation, et ce sont exactement celles
  // que l'action serveur d'avant y écrivait. Les redire sous `account.errors`
  // ferait deux libellés pour un même refus (`ds:libelles`).
  const t = await getTranslations('booking');
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return refused(ERROR_CODES.VALIDATION_ERROR, t('tunnel.actions.bookingIncomplete'), 400);
  }

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
