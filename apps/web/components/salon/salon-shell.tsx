import type { PublicTenant } from '@spa/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AccountEntry } from '@/components/account/account-entry';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import type { AccountName, AccountPresence } from '@/lib/account-presence';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

import { PUBLIC_EXIT_LABELS } from './public-exits';
import { addressLines } from './salon-address';
import { telUri } from './salon-contact';

export interface SalonShellProps {
  readonly tenantSlug: string;
  /** `null` quand la fiche n'a pas pu être lue : l'en-tête garde son lien vers la vitrine. */
  readonly tenant: PublicTenant | null;
  readonly signedIn: boolean;
  /**
   * La présence telle que le cookie la porte — les quatre champs.
   *
   * Le gabarit est un Server Component : ce qu'il reçoit ne quitte pas le
   * serveur. C'est lui qui la réduit au nom avant de la passer à l'îlot client
   * (`nameOnly`, #1088), et les trois écrans qui la lisent n'ont donc rien à
   * changer.
   */
  readonly presence: AccountPresence | null;
  /** « Prendre rendez-vous » dans l'en-tête et le pied — `null` quand rien n'est réservable. */
  readonly bookingHref: string | null;
  /** Ajouté au menu du compte — « Se déconnecter », là où la session est lisible. */
  readonly accountMenuExtra?: ReactNode;
  readonly children: ReactNode;
}

function salonHref(tenantSlug: string, suffix = ''): string {
  return `/${encodeURIComponent(tenantSlug)}${suffix}`;
}

/**
 * Ce que l'en-tête a le droit de faire franchir la frontière serveur / client
 * (#1088) : le nom, et rien d'autre.
 *
 * L'en-tête n'affiche que le prénom et les initiales, mais `AccountEntry` est un
 * composant client : ses propriétés sont sérialisées dans la charge utile RSC,
 * elle-même inscrite dans le HTML servi. Passer la présence entière écrivait
 * l'adresse e-mail et le numéro de la cliente dans la source de **chaque page du
 * salon**, vitrine publique comprise — à portée de n'importe quel script de la
 * page, c'est-à-dire exactement ce que le `httpOnly` du cookie existe pour
 * empêcher (CDC §5.1, minimisation).
 *
 * La réduction est ici, à la frontière, et **pas plus haut** : le tunnel est
 * servi par `reservation/page.tsx`, qui descend les quatre champs à
 * `BookingTunnel` pour que l'étape « Coordonnées » les préremplisse (#1086). Une
 * donnée qui remplit un formulaire doit atteindre le navigateur ; celle qui ne
 * fait que voyager, non.
 *
 * **Local, et non importé de `lib/account-presence.ts`** : ce module importe
 * `next/headers`, et une importation de *valeur* le ferait entrer dans le graphe
 * de tout module client qui atteindrait ce fichier — la raison déjà écrite en
 * tête de `compte/paths.ts` et rappelée dans `contact-step.tsx`. Seul le type
 * `AccountName` se partage : il s'efface à la compilation.
 */
function nameOnly(presence: AccountPresence | null): AccountName | null {
  if (presence === null) {
    return null;
  }
  // Construit champ par champ, jamais par un `...presence` amputé : une
  // propriété ajoutée au cookie demain se retrouverait sinon dans le HTML sans
  // que rien ne le signale.
  return { firstName: presence.firstName, lastName: presence.lastName };
}

/**
 * Le gabarit public d'un salon (#1045) — vitrine, espace client, politique de
 * données.
 *
 * Avant lui, chaque écran ouvrait sur une surcapitale grise et un titre, et se
 * fermait sur deux ou trois liens soulignés : passer de l'accueil de la
 * plateforme, qui a un vrai en-tête, à la vitrine d'un salon donnait
 * l'impression de changer de produit (audit `d20260918-1`).
 *
 * - **L'en-tête** porte l'identité du salon — monogramme et nom, qui mènent à
 *   la vitrine — et l'entrée du compte (BM-COMPTE-01). Il reste collé en haut.
 *   Au-delà de 48 rem, « Prendre rendez-vous » s'y ajoute **en contour** : le
 *   bouton plein de l'écran reste celui de l'écran (BM-VISUEL-02).
 * - **Le pied** donne ce qu'une cliente cherche en bas de page : où est le
 *   salon, comment le joindre, et les pages du salon. La plateforme n'y est
 *   plus qu'une mention. L'espace client n'y figure pas : l'en-tête le porte,
 *   et un lien « Mon compte » ramènerait la connexion à elle-même (#749).
 *
 * Le tunnel de réservation n'est pas servi ici : son en-tête se réduit à
 * revenir et sortir (BM-TUNNEL-10), c'est l'objet de #1047.
 *
 * Server Component : seule l'entrée du compte, qui déplie un menu, est un îlot
 * client — et ce qui franchit cette frontière est réduit au nom (`nameOnly`,
 * #1088), parce que tout ce qui la franchit est écrit dans le HTML servi.
 */
export function SalonShell({
  tenantSlug,
  tenant,
  signedIn,
  presence,
  bookingHref,
  accountMenuExtra,
  children,
}: SalonShellProps) {
  const name = tenant?.name ?? null;

  return (
    <div className="spa-shell">
      <a className="spa-shell__skip" href="#contenu">
        Aller au contenu
      </a>

      <header className="spa-shell__header">
        <div className="spa-shell__bar">
          <Link className="spa-shell__brand" href={salonHref(tenantSlug)}>
            {name === null ? null : <Avatar name={name} shape="square" tone="brand" size="sm" />}
            <span className="spa-shell__salon">{name ?? 'Accueil du salon'}</span>
          </Link>

          <div className="spa-shell__actions">
            <AccountEntry tenantSlug={tenantSlug} signedIn={signedIn} presence={nameOnly(presence)}>
              {accountMenuExtra}
            </AccountEntry>
            {bookingHref === null ? null : (
              <Link className="spa-button spa-button--neutral spa-shell__cta" href={bookingHref}>
                <span className="spa-button__label">{PUBLIC_EXIT_LABELS.reservation}</span>
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="spa-shell__body">{children}</div>

      <SalonFooter tenantSlug={tenantSlug} tenant={tenant} bookingHref={bookingHref} />
    </div>
  );
}

interface SalonFooterProps {
  readonly tenantSlug: string;
  readonly tenant: PublicTenant | null;
  readonly bookingHref: string | null;
}

function SalonFooter({ tenantSlug, tenant, bookingHref }: SalonFooterProps) {
  const phone = tenant?.contactPhone;
  const email = tenant?.contactEmail;

  return (
    <footer className="spa-shell__footer">
      <div className="spa-shell__footer-grid">
        {tenant === null ? null : (
          <div className="spa-shell__footer-block">
            <p className="spa-shell__footer-salon">
              <Avatar name={tenant.name} shape="square" tone="brand" size="sm" />
              {tenant.name}
            </p>
            {tenant.address === undefined ? null : (
              <address className="spa-shell__footer-address">
                {addressLines(tenant.address).map((line, index) => (
                  <span key={index}>{line}</span>
                ))}
              </address>
            )}
          </div>
        )}

        {phone === undefined && email === undefined ? null : (
          <div className="spa-shell__footer-block">
            <p className="spa-shell__footer-title">Nous contacter</p>
            <ul className="spa-shell__footer-list">
              {phone === undefined ? null : (
                <li>
                  <a className="spa-shell__footer-link" href={telUri(phone)}>
                    <Icon name="phone" />
                    {phone}
                  </a>
                </li>
              )}
              {email === undefined ? null : (
                <li>
                  <a className="spa-shell__footer-link" href={`mailto:${email}`}>
                    <Icon name="mail" />
                    {email}
                  </a>
                </li>
              )}
            </ul>
          </div>
        )}

        <nav className="spa-shell__footer-block" aria-label="Pages du salon">
          <p className="spa-shell__footer-title">Le salon</p>
          <ul className="spa-shell__footer-list">
            <li>
              <Link className="spa-shell__footer-link" href={salonHref(tenantSlug)}>
                Prestations et tarifs
              </Link>
            </li>
            {bookingHref === null ? null : (
              <li>
                <Link className="spa-shell__footer-link" href={bookingHref}>
                  {PUBLIC_EXIT_LABELS.reservation}
                </Link>
              </li>
            )}
            <li>
              <Link className="spa-shell__footer-link" href={salonHref(tenantSlug, '/politique-donnees')}>
                Politique de données
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      <p className="spa-shell__legal">
        Réservation en ligne propulsée par{' '}
        <Link href={PLATFORM_HOME_PATH}>{PLATFORM_NAME}</Link>
      </p>
    </footer>
  );
}
