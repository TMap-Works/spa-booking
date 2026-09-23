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

export async function POST(
  _request: Request,
  context: { params: Promise<{ tenantSlug: string; appointmentId: string }> },
): Promise<NextResponse> {
  const { tenantSlug, appointmentId } = await context.params;
  const locale = (await getLocale()) as Locale;
  const slug = slugSchema.safeParse(tenantSlug);
  const id = uuidSchema.safeParse(appointmentId);

  if (!slug.success || !id.success) {
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
