'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { initialsOf } from '@/lib/initials';
import { PLATFORM_NAME } from '@/lib/platform';

import { platformLogoutAction } from '../actions';
import {
  PLATFORM_CONSOLE_PATH,
  PLATFORM_NEW_TENANT_PATH,
  PLATFORM_TENANTS_PATH,
  platformLoginPath,
} from '../paths';

/**
 * Les entrées du rail. `exact` : le tableau de bord n'est « la page courante »
 * que sur `/plateforme` même — sans quoi il resterait allumé sous toute la
 * console, dont il est la racine.
 *
 * `label` est une **clé du catalogue** depuis #1106, et non le libellé : un
 * libellé traduit ne peut être ni une clé de rendu ni le repère d'une entrée.
 */
const ENTRIES: readonly {
  href: string;
  label: 'dashboard' | 'tenants' | 'newTenant';
  icon: IconName;
  exact: boolean;
}[] = [
  { href: PLATFORM_CONSOLE_PATH, label: 'dashboard', icon: 'home', exact: true },
  { href: PLATFORM_TENANTS_PATH, label: 'tenants', icon: 'store', exact: false },
  { href: PLATFORM_NEW_TENANT_PATH, label: 'newTenant', icon: 'sparkle', exact: true },
];

/** La page courante — la fiche d'un salon allume « Salons », pas « Ouvrir un salon ». */
function isCurrent(pathname: string, entry: (typeof ENTRIES)[number]): boolean {
  if (entry.exact || pathname === PLATFORM_NEW_TENANT_PATH) {
    return pathname === entry.href;
  }
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/** Le rail de la console — celui du back-office (#1058), sans salon ni rang. */
export function PlatformRail({ operatorName }: { readonly operatorName: string | null }) {
  const t = useTranslations('platform');
  const pathname = usePathname();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  const logout = async (): Promise<void> => {
    if (leaving) {
      return;
    }
    setLeaving(true);

    try {
      await platformLogoutAction();
    } catch {
      setLeaving(false);
      return;
    }

    router.replace(platformLoginPath());
    router.refresh();
  };

  return (
    <nav className="spa-admin__rail" aria-label={t('shell.railLabel')}>
      <div className="spa-admin__brand-block">
        <span aria-hidden="true" className="spa-admin__logo">
          <Icon name="leaf" />
        </span>
        <span className="spa-admin__brand-text">
          <span className="spa-admin__brand">{PLATFORM_NAME}</span>
          <span className="spa-admin__brand-caption">{t('shell.title')}</span>
        </span>
      </div>

      <div className="spa-admin__nav">
        <div className="spa-admin__nav-group">
          <span aria-hidden="true" className="spa-admin__nav-group-label">
            {t('shell.navGroup')}
          </span>
          {ENTRIES.map((entry) => (
            <Link
              aria-current={isCurrent(pathname, entry) ? 'page' : undefined}
              className="spa-admin__nav-link"
              href={entry.href}
              key={entry.href}
            >
              <Icon className="spa-admin__nav-icon" name={entry.icon} />
              {t(`shell.nav.${entry.label}`)}
            </Link>
          ))}
        </div>
      </div>

      <div className="spa-admin__rail-footer">
        <span className="spa-admin__rail-meta">
          <Icon name="clock" />
          <span>{t('shell.sessionLength')}</span>
        </span>
        {operatorName === null ? null : (
          <div className="spa-admin__user">
            <span aria-hidden="true" className="spa-admin__avatar">
              {initialsOf(operatorName)}
            </span>
            <span className="spa-admin__user-text">
              <span className="spa-visually-hidden">{`${t('shell.signedInAs')} `}</span>
              <span className="spa-admin__user-name">{operatorName}</span>
              <span className="spa-admin__user-role">{t('shell.operatorRole')}</span>
            </span>
          </div>
        )}
        <Button
          variant="quiet"
          loading={leaving}
          loadingLabel={t('shell.signingOut')}
          onClick={() => void logout()}
        >
          <Icon className="spa-admin__logout-icon" name="logout" />
          {t('shell.signOut')}
        </Button>
        {/*
          Le sélecteur de langue ferme le pied du rail, comme dans celui du
          back-office (#845) : c'est un réglage du poste et non une section du
          sommaire. Il est **consommé** tel que #845 le livre — même composant,
          même action serveur, même cookie d'un an.
        */}
        <LocaleSwitcher />
      </div>
    </nav>
  );
}
