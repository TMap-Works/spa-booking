import { ERROR_CODES, slugSchema, uuidSchema } from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import { NextResponse, type NextRequest } from 'next/server';

import { ApiClientError, fetchSaleReceiptPdf, type ReceiptPdfFormat } from '@/lib/api-client';
import { redirectWithinSite } from '@/lib/relative-redirect';

import { adminLoginPath } from '../../../paths';
import { adminActionAccess } from '../../../session';

/**
 * Le ticket de caisse d'une vente en PDF, servi au comptoir (#819).
 *
 * Un relais et rien d'autre : l'API compose le document — rouleau thermique
 * 80 mm par défaut, facture A4 sur `?format=a4` —, ce fichier y joint le jeton
 * de la session, que le navigateur ne peut pas lire (cookie `httpOnly`). Le
 * document part en `inline` : le visualiseur du navigateur l'ouvre, et c'est de
 * là qu'on l'imprime ou qu'on l'enregistre pour l'envoyer.
 *
 * L'établissement n'est pas lu du chemin : c'est le jeton qui le désigne, et une
 * vente d'un autre salon répond 404 à l'API comme une vente inconnue
 * (tenant-isolation §4).
 *
 * ## Les deux phrases de ce relais parlent la langue du poste (#850)
 *
 * Elles s'affichent nues dans un onglet, sans écran autour : c'est précisément
 * pour cela qu'elles doivent être lisibles. Un gestionnaire de route s'exécute
 * dans le contexte de la requête, `getTranslations` y rend donc la langue
 * résolue comme ailleurs. Il n'est appelé que **sur les chemins de refus**,
 * comme dans `actions.ts` : ces deux phrases-là n'ont pas à être composées quand
 * le téléchargement aboutit. Les refus de l'API, eux, gardent le message que
 * l'API a rendu — c'est elle qui nomme son refus.
 *
 * ## Et le document lui-même la parle aussi (#1259)
 *
 * Le PDF est composé **par l'API** : aucun catalogue du front ne l'atteint.
 * #1230 lui a donc ouvert un `?locale=fr|en`, avec repli sur
 * `Tenant.defaultLocale`. Ce relais ne le transmettait pas, et le repli
 * décidait seul : un gérant travaillant en anglais dans un salon réglé sur `fr`
 * tendait un ticket français à sa cliente. La langue part donc avec la demande,
 * lue par `getLocale()` — **la même résolution** que celle des messages de refus
 * ci-dessus, pour qu'une seule requête ne puisse pas rendre un onglet anglais
 * autour d'une pièce française.
 *
 * Elle est résolue sur le chemin qui aboutit, et non plus seulement sur celui
 * du refus. Ce n'est pas un coût ajouté au téléchargement : `next-intl` mémoïse
 * la configuration de la requête, et `getLocale()` lit ce que `getTranslations`
 * aurait lu de toute façon dès que la route refuse.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly tenantSlug: string; readonly saleId: string }> },
): Promise<NextResponse> {
  const params = await context.params;
  const slug = slugSchema.safeParse(params.tenantSlug);
  const sale = uuidSchema.safeParse(params.saleId);

  if (!slug.success || !sale.success) {
    return new NextResponse((await getTranslations('admin-checkout'))('pdf.notFound'), {
      status: 404,
    });
  }

  const format: ReceiptPdfFormat =
    request.nextUrl.searchParams.get('format') === 'a4' ? 'a4' : 'ticket-80';
  const access = await adminActionAccess(slug.data);

  if (!access.ok) {
    return access.code === ERROR_CODES.UNAUTHORIZED
      ? redirectWithinSite(adminLoginPath(slug.data))
      : new NextResponse(access.message, { status: 503 });
  }

  try {
    const pdf = await fetchSaleReceiptPdf(access.accessToken, sale.data, format, await getLocale());

    return new NextResponse(pdf.bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        // `inline`, comme l'API le pose : le navigateur l'affiche au lieu de le
        // télécharger d'office. Le nom porte le numéro de pièce.
        'content-disposition': pdf.disposition ?? 'inline; filename="ticket.pdf"',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ApiClientError) {
      return new NextResponse(error.message, {
        status: error.status >= 400 && error.status < 600 ? error.status : 502,
      });
    }

    return new NextResponse((await getTranslations('admin-checkout'))('pdf.failed'), {
      status: 502,
    });
  }
}
