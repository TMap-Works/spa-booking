'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { tenantSlugFromPathname } from '@/lib/tenant-slug';

import { adminStaffPath } from '../paths';

/**
 * L'écran servi quand la fiche praticien demandée n'existe pas (#696).
 *
 * ## Pourquoi une frontière à ce segment
 *
 * `page.tsx` appelle `notFound()` dans trois situations qui doivent rester
 * indiscernables — identifiant mal formé, identifiant inconnu, fiche d'un autre
 * établissement (tenant-isolation §4). Sans frontière propre, cet appel remontait
 * jusqu'à `app/not-found.tsx`, qui répond pour une **adresse publique inconnue** :
 * « Vérifiez le lien que le salon vous a communiqué », hors du back-office, sans
 * rail ni la moindre issue. L'opérateur était pourtant connecté, dans son propre
 * tableau de bord, et n'avait suivi aucun lien du salon.
 *
 * Une frontière posée ici corrige les deux à la fois :
 *
 * - le **message** parle de la fiche, plus de l'adresse ;
 * - l'écran est rendu **dans** l'enveloppe du back-office — rail, sections,
 *   pied de rail — au lieu de la remplacer.
 *
 * C'est la transposition au back-office de ce que #627 a posé sur l'espace
 * client, et l'encart reprend mot pour mot la forme de
 * `catalogue/[serviceId]/page.tsx` : même ton `warning`, même phrase sur
 * l'établissement voisin, même lien de retour vers la liste.
 *
 * ## Le statut HTTP reste 404
 *
 * C'est la raison de passer par `not-found.tsx` plutôt que de faire rendre
 * l'encart par la page elle-même : une page qui rend son message sans lever
 * répond **200**, et annoncerait comme existante une fiche qui n'existe pas.
 *
 * ## Pourquoi un Client Component pour quatre lignes de balisage
 *
 * Une frontière `not-found` ne reçoit **aucune prop** — ni `params`, ni
 * `searchParams` : c'est une limite de l'App Router, pas un oubli. Le slug de
 * l'établissement, dont dépend le chemin de retour, ne peut donc venir que de
 * l'URL courante. `usePathname()` est le seul accès qui y mène, et il n'existe
 * que côté client. Même arbitrage que le rail du back-office.
 *
 * La lecture du slug elle-même vit dans `lib/tenant-slug.ts` depuis #703 : la
 * frontière du report de rendez-vous en avait la copie exacte, et les deux
 * gardes qu'elle porte — premier segment absent, segment non décodable — sont
 * trop coûteuses à perdre pour être écrites deux fois.
 */
export default function StaffMemberNotFound() {
  const t = useTranslations('admin-staff');
  const tenantSlug = tenantSlugFromPathname(usePathname());

  /*
   * Le texte ne dit pas **laquelle** des trois situations s'est produite :
   * distinguer « identifiant inconnu » de « fiche d'un autre établissement »
   * confirmerait à qui essaie des identifiants au hasard qu'une fiche existe, et
   * chez qui (tenant-isolation §4).
   *
   * Sans slug lisible, le lien est tu plutôt que fabriqué : le rail du
   * back-office, lui, tient son slug des `params` du layout et reste une issue.
   */
  return (
    <Notification tone="warning" title={t('notFound.title')}>
      <p>
        {t('notFound.body')}
        {tenantSlug === null ? null : (
          <>
            {' '}
            <Link href={adminStaffPath(tenantSlug)}>{t('backToStaff')}</Link>.
          </>
        )}
      </p>
    </Notification>
  );
}
