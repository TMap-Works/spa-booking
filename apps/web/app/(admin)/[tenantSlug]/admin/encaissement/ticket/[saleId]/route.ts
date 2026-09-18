import { ERROR_CODES, slugSchema, uuidSchema } from '@spa/shared';
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
    return new NextResponse('Ticket introuvable.', { status: 404 });
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
    const pdf = await fetchSaleReceiptPdf(access.accessToken, sale.data, format);

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

    return new NextResponse('Le ticket n’a pas pu être produit. Merci de réessayer.', {
      status: 502,
    });
  }
}
