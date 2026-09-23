import type { PublicService } from '@spa/shared';
import { getTranslations } from 'next-intl/server';
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
 * ## La langue de l'aperçu est celle de l'écran (#849)
 *
 * `ServiceCatalog` lit `useLocale()` et son propre namespace `booking` : il se
 * rend donc dans la langue de la session, sans que cette page lui passe quoi que
 * ce soit. C'est la même mécanique que sur la vitrine, et c'est ce qui fait que
 * l'aperçu montre ce que verrait une cliente **dans cette langue** — prix et
 * durées mis en forme comprises.
 *
 * L'encart, lui, cite deux libellés qui ne sont pas les siens : la mention de la
 * prestation sans praticien, lue sur le catalogue `booking` — la **même** clé que
 * la ligne du catalogue public —, et « Compte désactivé », lue sur le namespace de
 * ce ticket, où la fiche de la prestation l'écrit déjà. Les deux sont lues et non
 * recopiées : deux écrans qui décrivent le même état avec deux phrases
 * différentes est exactement l'écart que cet écran doit éviter. La constante
 * `UNSTAFFED_SERVICE_LABEL`, figée en français, n'est donc plus importée ici.
 *
 * ## Ce que l'aperçu ne montre pas, et pourquoi c'est le sujet
 *
 * Les prestations désactivées, les rubriques désactivées, les praticiens
 * inactifs et les tampons. Constater leur absence est exactement ce qu'on vient
 * vérifier : une prestation qu'on croyait en ligne et qui n'y est pas se voit
 * ici, avant qu'une cliente ne le remarque à notre place.
 *
 * ## Le cas inverse : présente, et pourtant irréservable (#765)
 *
 * Une prestation active sans praticien, elle, **figure** dans l'aperçu — et
 * c'est le piège que cet écran doit désamorcer plutôt que reproduire. Le
 * catalogue porte désormais la mention à la place des noms de praticiens
 * (`ServiceCatalog`), et l'encart la reprend mot pour mot : ce que la gérante
 * lit ici est ce qu'elle verra sur la carte, et c'est déjà ce que la fiche de la
 * prestation lui dit une navigation plus loin. Le libellé vient du composant, il
 * n'est pas recopié — deux écrans qui décrivent le même état avec deux phrases
 * différentes est exactement l'écart relevé par l'audit.
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
  const t = await getTranslations('admin-catalog');
  // Le vocabulaire de la vitrine, lu là où il est écrit : la ligne du catalogue
  // public rend cette même clé.
  const publicWords = await getTranslations('booking');
  await requireAdminAccessToken(tenantSlug, adminCatalogPreviewPath(tenantSlug));

  let services: PublicService[];
  try {
    services = await fetchPublicServices(tenantSlug);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('preview.unavailable'),
      deniedHint: t('preview.unavailableHint'),
      failedTitle: t('preview.unavailable'),
    });
  }

  return (
    <>
      <h1 className="spa-admin__title">{t('preview.title')}</h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminCatalogPath(tenantSlug)}>
          {t('preview.backToCatalog')}
        </Link>
        <span className="spa-admin-toolbar__spacer" />
        <Link className="spa-button spa-button--neutral" href={`/${tenantSlug}`}>
          {t('preview.openSalonPage')}
        </Link>
      </div>

      <Notification tone="info" title={t('preview.noticeTitle')}>
        <p>{t('preview.noticeScope')}</p>
        <p>
          {t('preview.noticeUnstaffed', {
            unstaffed: publicWords('salon.catalog.unstaffed'),
            disabled: t('staffPanel.disabledAccount'),
          })}
        </p>
      </Notification>

      <ServiceCatalog services={services} />
    </>
  );
}
