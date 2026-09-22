'use client';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';

import { NavTabs } from '@/components/ui/nav-tabs';

import { accountPath } from '../paths';

interface AccountTabsProps {
  readonly tenantSlug: string;
}

/**
 * La navigation de l'espace client, en onglets (#1045, étendue par #1053) —
 * « Mes rendez-vous », « Historique » et « Mes coordonnées ».
 *
 * Elle remplace la barre « Modifier mes coordonnées | Se déconnecter » : la
 * déconnexion est passée dans le menu du compte, en haut à droite, là où
 * BM-COMPTE-01 la range.
 *
 * ## Pourquoi trois onglets et non deux (#1053)
 *
 * `BM-RDV-01` demande « À venir d'abord, Passés à part ». Les deux moitiés
 * empilées sur un même écran mettaient neuf lignes d'historique sous le seul
 * rendez-vous qui appelle une action, et le prochain rendez-vous n'était plus
 * lisible au premier écran à 360 px. Séparer les moitiés par onglet est la
 * forme que le benchmark décrit, et c'est l'onglet qu'attend #1054 pour
 * reprendre l'historique.
 *
 * L'onglet actif suit l'adresse : le report d'un rendez-vous appartient aux
 * rendez-vous, seuls l'historique et les coordonnées ont leur propre onglet.
 */
export function AccountTabs({ tenantSlug }: AccountTabsProps) {
  const t = useTranslations('account.nav');
  const pathname = usePathname();
  const history = accountPath(tenantSlug, '/historique');
  const profile = accountPath(tenantSlug, '/coordonnees');

  const onHistory = pathname === history;
  const onProfile = pathname === profile;

  return (
    <NavTabs
      label={t('label')}
      items={[
        {
          href: accountPath(tenantSlug),
          label: t('appointments'),
          current: !onHistory && !onProfile,
        },
        { href: history, label: t('history'), current: onHistory },
        { href: profile, label: t('profile'), current: onProfile },
      ]}
    />
  );
}
