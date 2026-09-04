import type { PublicService } from '@spa/shared';
import Link from 'next/link';

import { ServiceCatalog } from '@/components/salon/service-catalog';
import { Notification } from '@/components/ui/notification';
import { fetchPublicServices } from '@/lib/api-client';

import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { adminCatalogPath } from '../../paths';

/**
 * Aperçu du rendu public (#52, cinquième critère).
 *
 * ## C'est le composant public lui-même, pas une imitation
 *
 * `ServiceCatalog` est celui que sert `/{slug}` à la cliente. Le réemployer tel
 * quel est ce qui donne à cet écran sa seule valeur : une maquette qui
 * ressemblerait au rendu public dériverait de lui au premier changement, et
 * l'aperçu se mettrait à mentir précisément quand on compte dessus. Il en va de
 * même de la source : les données viennent du point d'entrée **public**, si bien
 * que ce qui manque ici manque aussi à la cliente.
 *
 * ## Ce que l'aperçu ne montre pas, et pourquoi c'est le sujet
 *
 * Les prestations désactivées, les rubriques désactivées, les praticiens
 * inactifs et les tampons. Constater leur absence est exactement ce qu'on vient
 * vérifier : une prestation qu'on croyait en ligne et qui n'y est pas se voit
 * ici, avant qu'une cliente ne le remarque à notre place.
 *
 * ## Pourquoi la garde de session malgré des données publiques
 *
 * L'écran appartient au back-office : il porte sa navigation, son chrome et son
 * `robots: noindex`. Le servir sans session en ferait une seconde page publique
 * du catalogue, à une autre URL — un doublon que le référencement pénalise et
 * que personne n'a demandé.
 */

export const dynamic = 'force-dynamic';

interface CatalogPreviewPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function CatalogPreviewPage({ params }: CatalogPreviewPageProps) {
  const { tenantSlug } = await params;
  await requireAdminAccessToken(tenantSlug);

  let services: PublicService[];
  try {
    services = await fetchPublicServices(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Aperçu indisponible',
      deniedHint: 'La page publique du salon n’a pas pu être lue.',
      failedTitle: 'Aperçu indisponible',
    });
  }

  return (
    <section aria-labelledby="apercu-titre">
      <h1 className="spa-admin__title" id="apercu-titre">
        Aperçu du rendu public
      </h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminCatalogPath(tenantSlug)}>
          Retour au catalogue
        </Link>
        <span className="spa-admin-toolbar__spacer" />
        <Link className="spa-button spa-button--neutral" href={`/${tenantSlug}`}>
          Ouvrir la page du salon
        </Link>
      </div>

      <Notification tone="info" title="Ce que voit la cliente">
        <p>
          Seules les prestations actives, classées sous une rubrique active, apparaissent ici. Les
          tampons de préparation et de remise en état n’y figurent pas : ils décrivent la cadence
          interne du salon.
        </p>
      </Notification>

      <ServiceCatalog services={services} />
    </section>
  );
}
