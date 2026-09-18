'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import type { AccountPresence } from '@/lib/account-presence';

interface AccountEntryProps {
  readonly tenantSlug: string;
  /** Une session est ouverte — lue sur les jetons dans l'espace, sur la présence ailleurs. */
  readonly signedIn: boolean;
  /** Le prénom à saluer ; `null` quand la session précède le cookie de présence. */
  readonly presence: AccountPresence | null;
  /** Ce que le menu ajoute sous ses liens — « Se déconnecter » dans l'espace client. */
  readonly children?: ReactNode;
}

/**
 * L'entrée du compte, à droite de l'en-tête du salon (#1045, BM-COMPTE-01).
 *
 * - **Sans session** : « Se connecter ». Effacé sur la connexion et
 *   l'inscription, où il ramènerait à l'écran qu'on lit (#749).
 * - **Connectée** : le prénom et ses initiales, qui ouvrent un menu « Mes
 *   rendez-vous · Mes coordonnées ». C'est une navigation, pas un menu
 *   d'application : un bouton qui déplie une liste de liens (motif
 *   « disclosure » de l'APG), et non un `role="menu"` qui imposerait ses
 *   propres touches.
 *
 * Le menu se referme sur Échap (le focus revient au bouton), sur un clic
 * ailleurs, quand le focus le quitte, et à chaque changement de page.
 */
export function AccountEntry({ tenantSlug, signedIn, presence, children }: AccountEntryProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const account = `/${encodeURIComponent(tenantSlug)}/compte`;
  const login = `${account}/connexion`;
  const profile = `${account}/coordonnees`;

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  if (!signedIn) {
    if (pathname === login || pathname === `${account}/inscription`) {
      return null;
    }
    return (
      <Link className="spa-account-entry" href={login}>
        <Icon name="user" />
        Se connecter
      </Link>
    );
  }

  const fullName = presence === null ? null : `${presence.firstName} ${presence.lastName}`.trim();

  return (
    <div
      ref={container}
      className="spa-account-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="spa-account-menu__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {fullName === null ? (
          <span className="spa-account-menu__icon">
            <Icon name="user" />
          </span>
        ) : (
          <Avatar name={fullName} size="sm" />
        )}
        {presence === null ? null : <span className="spa-visually-hidden">Mon compte : </span>}
        <span className="spa-account-menu__name">{presence?.firstName ?? 'Mon compte'}</span>
        <Icon name="chevron-down" className="spa-account-menu__chevron" />
      </button>

      <div id={panelId} className="spa-account-menu__panel" hidden={!open}>
        {fullName === null ? null : (
          <p className="spa-account-menu__who">
            <span className="spa-account-menu__who-name">{fullName}</span>
            <span className="spa-account-menu__who-hint">Compte client</span>
          </p>
        )}
        <ul className="spa-account-menu__list">
          <li>
            <Link
              className="spa-account-menu__link"
              href={account}
              aria-current={pathname === account ? 'page' : undefined}
            >
              <Icon name="calendar" />
              Mes rendez-vous
            </Link>
          </li>
          <li>
            <Link
              className="spa-account-menu__link"
              href={profile}
              aria-current={pathname === profile ? 'page' : undefined}
            >
              <Icon name="user" />
              Mes coordonnées
            </Link>
          </li>
        </ul>
        {children === undefined ? null : <div className="spa-account-menu__extra">{children}</div>}
      </div>
    </div>
  );
}
