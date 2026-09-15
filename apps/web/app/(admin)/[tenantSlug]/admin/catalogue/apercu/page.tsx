import type { PublicService } from '@spa/shared';
import Link from 'next/link';

import { ServiceCatalog } from '@/components/salon/service-catalog';
import { Notification } from '@/components/ui/notification';
import { fetchPublicServices } from '@/lib/api-client';

import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { adminCatalogPath, adminCatalogPreviewPath } from '../../paths';

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
 *
 * ## Pourquoi les blocs ne sont pas réunis sous une `<section>` (#633)
 *
 * Ils l'étaient, dans une `<section>` que rien ne mettait en page : ses enfants
 * s'empilaient dans le flux normal, à **0 px**, et la carte de la barre d'outils
 * touchait l'encart « Ce que voit la cliente » — deux liserés confondus en un
 * trait. La gouttière existe pourtant déjà : `.spa-admin__content`, la zone de
 * contenu que le shell pose autour de chaque écran, sépare ses enfants de
 * `var(--spa-space-4)`. Cette `<section>` intermédiaire était exactement ce qui
 * l'empêchait d'atteindre les blocs.
 *
 * Elle n'est pas remplacée par une enveloppe équivalente : rien ne se perd à la
 * retirer. Le `<h1>` nomme déjà l'écran, et l'aperçu lui-même est une région
 * nommée — `ServiceCatalog` rend sa propre `<section aria-labelledby>`, celle que
 * la cliente voit. L'identifiant que le `<h1>` portait pour cette `<section>`
 * disparaît avec elle : plus rien ne s'y réfère. La correction reste ainsi dans
 * le balisage du catalogue, sans une ligne de CSS partagé — `/catalogue/nouveau`,
 * qui porte la même `<section>`, n'est pas touché.
 */

export const dynamic = 'force-dynamic';

interface CatalogPreviewPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function CatalogPreviewPage({ params }: CatalogPreviewPageProps) {
  const { tenantSlug } = await params;
  await requireAdminAccessToken(tenantSlug, adminCatalogPreviewPath(tenantSlug));

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
    <>
      <h1 className="spa-admin__title">Aperçu du rendu public</h1>

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
    </>
  );
}
