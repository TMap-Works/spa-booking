'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { tenantSlugFromPathname } from '@/lib/tenant-slug';

import { adminServiceCategoriesPath } from '../../../paths';

/**
 * L'écran servi quand la rubrique demandée n'existe pas (#769).
 *
 * Même frontière, mêmes raisons, que celle de la fiche d'une prestation (#697) :
 * une page qui rendrait son encart sans lever répondrait **200**, et annoncerait
 * comme existante une rubrique qui n'existe pas. Les trois façons de ne pas la
 * trouver — identifiant mal formé, identifiant inconnu, rubrique d'un autre
 * établissement — rendent le même écran **et** le même statut, ce qu'exige
 * tenant-isolation §4.
 *
 * ## Pourquoi un Client Component pour quatre lignes de balisage
 *
 * Une frontière `not-found` ne reçoit **aucune prop** — ni `params`, ni
 * `searchParams` : c'est une limite de l'App Router. Le slug de l'établissement,
 * dont dépend le chemin de retour, ne peut donc venir que de l'URL courante, et
 * `usePathname()` est le seul accès qui y mène. La lecture du slug elle-même vit
 * dans `lib/tenant-slug.ts` depuis #703, avec ses deux gardes — premier segment
 * absent, segment non décodable — et son décodage, sans lequel
 * `adminServiceCategoriesPath` réencoderait un slug déjà encodé.
 */
export default function ServiceCategoryNotFound() {
  const t = useTranslations('admin-catalog.categories');
  const tenantSlug = tenantSlugFromPathname(usePathname());

  /*
   * Le texte ne dit pas **laquelle** des trois situations s'est produite :
   * distinguer « identifiant inconnu » de « rubrique d'un autre établissement »
   * confirmerait à qui essaie des identifiants au hasard qu'une rubrique existe,
   * et chez qui (tenant-isolation §4).
   *
   * Sans slug lisible, le lien est tu plutôt que fabriqué : le rail du
   * back-office, lui, tient son slug des `params` du layout et reste une issue.
   */
  return (
    <Notification tone="warning" title={t('notFoundTitle')}>
      <p>
        {t('notFoundBody')}
        {tenantSlug === null ? null : (
          <>
            {' '}
            <Link href={adminServiceCategoriesPath(tenantSlug)}>{t('notFoundLink')}</Link>.
          </>
        )}
      </p>
    </Notification>
  );
}
