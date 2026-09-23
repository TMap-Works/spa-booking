'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { tenantSlugFromPathname } from '@/lib/tenant-slug';

import { adminCatalogPath } from '../../paths';

/**
 * L'écran servi quand la prestation demandée n'existe pas (#697).
 *
 * ## Ce que ce segment rendait avant
 *
 * L'encart « Prestation introuvable » existait déjà — mais **dans `page.tsx`**,
 * et pour le seul 404 de l'API. Un identifiant **mal formé** n'y arrivait jamais :
 * le `ParseUUIDPipe` de `GET /v1/services/:id` rend **400**, statut que la
 * cascade de la page ne distinguait ni du 404 ni du 403, et qui tombait dans la
 * branche par défaut d'`adminLoadFailure`. Selon l'état du jeton d'accès au
 * moment de la lecture, l'opératrice y voyait le message brut de l'API ou, si le
 * renouvellement échouait dans la même seconde, le formulaire de connexion vide —
 * c'est ce qu'a relevé la campagne de QA `20260915-1`, sur une session pourtant
 * valide.
 *
 * La page décide donc désormais, et cette frontière affiche — la répartition que
 * #696 a posée sur la fiche praticien, et #627 avant elle sur l'espace client.
 *
 * ## Le statut HTTP devient 404, et c'est le point
 *
 * C'est la raison de passer par `not-found.tsx` plutôt que de laisser la page
 * rendre son encart : une page qui rend son message sans lever répond **200**, et
 * annonçait comme existante une prestation qui n'existe pas. Les trois façons de
 * ne pas la trouver — identifiant mal formé, identifiant inconnu, prestation d'un
 * autre établissement — rendent maintenant le même écran **et** le même statut,
 * ce qui est précisément ce qu'exige tenant-isolation §4.
 *
 * ## Pourquoi un Client Component pour quatre lignes de balisage
 *
 * Une frontière `not-found` ne reçoit **aucune prop** — ni `params`, ni
 * `searchParams` : c'est une limite de l'App Router, pas un oubli. Le slug de
 * l'établissement, dont dépend le chemin de retour, ne peut donc venir que de
 * l'URL courante, et `usePathname()` est le seul accès qui y mène.
 *
 * La lecture du slug elle-même vit dans `lib/tenant-slug.ts` depuis #703 : cette
 * frontière en portait la **troisième** copie, caractère pour caractère, après
 * celles du report de rendez-vous (#627) et de la fiche praticien (#696), et les
 * deux gardes qu'elle porte — premier segment absent, segment non décodable —
 * sont trop coûteuses à perdre pour être écrites trois fois. Le décodage qu'elle
 * fait n'est pas redondant ici non plus : `adminCatalogPath` réencode ce qu'on
 * lui donne, et sans ce passage un slug déjà encodé dans le chemin le serait une
 * seconde fois.
 */
export default function ServiceNotFound() {
  const t = useTranslations('admin-catalog.service');
  const tenantSlug = tenantSlugFromPathname(usePathname());

  /*
   * Le texte ne dit pas **laquelle** des trois situations s'est produite :
   * distinguer « identifiant inconnu » de « prestation d'un autre établissement »
   * confirmerait à qui essaie des identifiants au hasard qu'une prestation
   * existe, et chez qui (tenant-isolation §4).
   *
   * Les mots sont ceux que `page.tsx` rendait déjà : ce ticket déplace l'encart
   * et élargit les cas qui y mènent, il ne réécrit pas ce que l'opératrice lit.
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
            <Link href={adminCatalogPath(tenantSlug)}>{t('notFoundLink')}</Link>.
          </>
        )}
      </p>
    </Notification>
  );
}
