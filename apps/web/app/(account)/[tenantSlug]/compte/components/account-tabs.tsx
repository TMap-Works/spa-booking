'use client';

import { usePathname } from 'next/navigation';

import { NavTabs } from '@/components/ui/nav-tabs';

import { accountPath } from '../paths';

interface AccountTabsProps {
  readonly tenantSlug: string;
}

/**
 * La navigation de l'espace client, en onglets (#1045) — « Mes rendez-vous »
 * et « Mes coordonnées ».
 *
 * Elle remplace la barre « Modifier mes coordonnées | Se déconnecter » : la
 * déconnexion est passée dans le menu du compte, en haut à droite, là où
 * BM-COMPTE-01 la range. L'onglet actif suit l'adresse : le report d'un
 * rendez-vous appartient aux rendez-vous, seul l'écran des coordonnées
 * appartient à l'autre.
 */
export function AccountTabs({ tenantSlug }: AccountTabsProps) {
  const pathname = usePathname();
  const profile = accountPath(tenantSlug, '/coordonnees');
  const onProfile = pathname === profile;

  return (
    <NavTabs
      label="Mon compte"
      items={[
        { href: accountPath(tenantSlug), label: 'Mes rendez-vous', current: !onProfile },
        { href: profile, label: 'Mes coordonnées', current: onProfile },
      ]}
    />
  );
}
