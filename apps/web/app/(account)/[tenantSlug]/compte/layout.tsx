import type { PublicTenant } from '@spa/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppointmentFeedProvider } from '@/components/live/appointment-feed';
import { SalonShell } from '@/components/salon/salon-shell';
import { PhoneCountryProvider } from '@/components/ui/phone-country';
import { readAccountPresence } from '@/lib/account-presence';
import { ApiClientError } from '@/lib/api-client';

import {
  AccountAnnouncementProvider,
  AccountAnnouncementRegion,
} from './components/account-announcement';
import { AccountLiveAnnouncements } from './components/account-live-announcements';
import { AccountTabs } from './components/account-tabs';
import { LogoutButton } from './components/logout-button';
import { accountFeedPath, bookingPath } from './paths';
import { readAccessToken, readRefreshToken } from './session';
import { accountTenant } from './tenant';

/**
 * L'enveloppe de l'espace client (#47).
 *
 * ## Un groupe de routes à lui, et pourquoi
 *
 * `(account)` est le troisième produit servi par `apps/web`, à côté du parcours
 * public `(booking)` et du tableau de bord admin à venir. Il n'a ni les mêmes
 * conventions ni le même public : derrière authentification, **non indexable**,
 * et centré sur la relecture plutôt que sur la conversion. Le mêler au tunnel
 * aurait fait porter à la surface qui génère le revenu — et qui vise un
 * LCP < 2,5 s en 4G — le chrome d'un espace que les moteurs ne verront jamais.
 *
 * Le segment `[tenantSlug]` est le même que celui du tunnel, et c'est
 * délibéré : une cliente du Salon des Lilas atteint `/salon-des-lilas/compte`
 * comme elle atteint `/salon-des-lilas/reservation`. Les deux groupes ne se
 * disputent aucune route — `reservation` et `compte` sont disjoints.
 *
 * ## Ce que ce layout ne fait pas : garder la session
 *
 * Un layout n'est pas une frontière de sécurité dans l'App Router : il n'est pas
 * rejoué à chaque navigation, et une page peut être servie sans que son parent
 * ait été réévalué. La garde vit donc **dans chaque page**, par
 * `readAccountData` (`session.ts`) — et les deux pages qui doivent rester
 * ouvertes, connexion et inscription, ne l'appellent simplement pas.
 *
 * ## Ce que ce layout fait, en revanche : porter la région d'annonce (#746)
 *
 * Ce qui le disqualifie comme frontière de sécurité le qualifie pour cela. Un
 * layout n'est pas rejoué à chaque navigation : l'App Router le **conserve** d'un
 * écran à l'autre du même segment, avec l'état de ses Client Components. La
 * région `aria-live` qu'il monte existe donc avant tout geste — c'est ce que WCAG
 * 4.1.3 exige d'un message d'état, une région insérée avec son message n'étant
 * annoncée par aucun lecteur d'écran de façon fiable — et l'annonce d'un report
 * traverse le retour vers la liste, alors qu'un état porté par la page de report
 * serait démonté avec elle. Voir `components/account-announcement.tsx`.
 *
 * ## … et le gabarit du salon, pour la même raison (#1045)
 *
 * L'en-tête, le menu du compte et le pied de page sont ceux de la vitrine
 * (`components/salon/salon-shell.tsx`) : passer de la vitrine à son compte ne
 * doit plus donner l'impression de changer de site. Ce qui appartient à
 * l'espace et non à un écran se pose ici, et ce layout étant conservé d'un
 * écran à l'autre, l'en-tête ne clignote pas.
 *
 * - **Avec une session**, le menu du compte porte « Se déconnecter » — ici et
 *   nulle part ailleurs : l'action serveur de déconnexion doit lire le jeton de
 *   rafraîchissement pour le révoquer, et ce cookie n'est envoyé qu'aux pages
 *   de `/{slug}/compte`. Sous le titre, les onglets « Mes rendez-vous · Mes
 *   coordonnées » (`components/account-tabs.tsx`), posés **avant** `<main>` et
 *   hors de lui : d'abord où aller, ensuite ce qu'on lit (WCAG 1.3.2).
 * - **Sans session**, les seuls écrans servis pour de bon sont la connexion et
 *   l'inscription : le gabarit du salon les enveloppe, et chacune **porte son
 *   propre cadre d'accueil** (`components/auth/salon-auth-screen.tsx`, #1052).
 *   Ce cadre était posé ici jusqu'à ce que son titre doive différer d'un écran
 *   à l'autre — « Bienvenue chez … » d'un côté, « Créez votre compte … » de
 *   l'autre : un layout de l'App Router ne sait pas quelle route il enveloppe,
 *   et il n'est pas rejoué quand on passe de la connexion à l'inscription, si
 *   bien qu'un titre calculé ici serait resté celui de l'écran précédent.
 *   L'entrée « Se connecter » de l'en-tête s'efface d'elle-même, où elle
 *   ramènerait à l'écran qu'on lit (#749) ; le pied de page porte les chemins
 *   de retour et la mention de la plateforme.
 *
 * Ce layout ne redirige pas pour autant : il lit la session pour savoir quoi
 * dessiner, jamais pour décider d'une issue. Rediriger d'ici doublerait la
 * décision de la page — et bouclerait sur l'écran de connexion, qui est sous ce
 * même layout.
 */

export const metadata: Metadata = {
  title: 'Mon compte',
  // L'espace client n'a rien à faire dans un index de recherche : ses pages ne
  // rendent rien sans session, et une URL de compte indexée n'apporte que du
  // trafic qui rebondit sur un écran de connexion.
  robots: { index: false, follow: false },
};

/**
 * Ce gabarit lit un cookie de session pour savoir quoi peindre : le mettre en
 * cache servirait l'en-tête de la première visiteuse à quelqu'un qui n'est pas
 * connecté — ou l'inverse (#747).
 */
export const dynamic = 'force-dynamic';

interface AccountLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function AccountLayout({ children, params }: AccountLayoutProps) {
  const { tenantSlug } = await params;

  // L'établissement est résolu ici plutôt que dans chaque page : c'est ce qui
  // fait qu'un slug inconnu rend 404 avant tout écran de connexion, et non un
  // formulaire qui n'aurait nulle part où s'envoyer.
  let tenant: PublicTenant;
  try {
    tenant = await accountTenant(tenantSlug);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  /*
   * Y a-t-il une session ? Le cookie d'accès, ou à défaut celui de
   * rafraîchissement — qui annonce une session que la prochaine page
   * renouvellera sur place. Se borner au seul cookie d'accès aurait fait
   * clignoter l'en-tête à chaque expiration (#747).
   *
   * Aucun appel à l'API : le prénom que l'en-tête salue vient du cookie de
   * présence (`lib/account-presence.ts`), posé avec la session.
   */
  const signedIn = (await readAccessToken()) !== null || (await readRefreshToken()) !== null;
  const presence = signedIn ? await readAccountPresence() : null;

  if (!signedIn) {
    return (
      <AccountAnnouncementProvider>
        <SalonShell
          tenantSlug={tenantSlug}
          tenant={tenant}
          signedIn={false}
          presence={null}
          bookingHref={bookingPath(tenantSlug)}
        >
          <main className="spa-account__main" id="contenu">
            <AccountAnnouncementRegion />
            {/* L'indicatif par défaut de l'inscription et du profil (#825). */}
            <PhoneCountryProvider country={tenant.address?.country ?? null}>
              {children}
            </PhoneCountryProvider>
          </main>
        </SalonShell>
      </AccountAnnouncementProvider>
    );
  }

  return (
    <AccountAnnouncementProvider>
      {/*
        Le temps réel de la cliente : ses rendez-vous se tiennent à jour quand
        le salon les confirme, les déplace ou les annule — la page se relit à
        chaque changement, et le bandeau d'annonce dit lequel. Seulement avec
        une session : il n'y a rien à suivre sur l'écran de connexion. Voir
        `components/live/appointment-feed.tsx`.
      */}
      <AppointmentFeedProvider feedPath={accountFeedPath(tenantSlug)}>
        <AccountLiveAnnouncements tenantSlug={tenantSlug} timeZone={tenant.timezone} />
      </AppointmentFeedProvider>
      <SalonShell
        tenantSlug={tenantSlug}
        tenant={tenant}
        signedIn
        presence={presence}
        bookingHref={bookingPath(tenantSlug)}
        accountMenuExtra={<LogoutButton tenantSlug={tenantSlug} />}
      >
        <div className="spa-account">
          <header className="spa-account__header">
            <h1 className="spa-account__title">
              {presence === null ? 'Mon compte' : `Bonjour ${presence.firstName}`}
            </h1>
            <AccountTabs tenantSlug={tenantSlug} />
          </header>
          <main className="spa-account__main" id="contenu">
            {/*
              En tête du contenu, et non au pied : ce qui vient de se passer se lit
              avant ce qu'il reste à faire, et le lien d'évitement mène ici.
            */}
            <AccountAnnouncementRegion />
            {/* L'indicatif par défaut de l'inscription et du profil (#825). */}
            <PhoneCountryProvider country={tenant.address?.country ?? null}>
              {children}
            </PhoneCountryProvider>
          </main>
        </div>
      </SalonShell>
    </AccountAnnouncementProvider>
  );
}
