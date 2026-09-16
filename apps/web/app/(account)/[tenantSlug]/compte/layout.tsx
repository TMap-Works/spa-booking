import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { ApiClientError } from '@/lib/api-client';

import {
  AccountAnnouncementProvider,
  AccountAnnouncementRegion,
} from './components/account-announcement';
import { AccountNav } from './components/account-nav';
import { accountPath, bookingPath } from './paths';
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
 * ## … et la navigation du compte, pour la même raison (#747)
 *
 * « Modifier mes coordonnées | Se déconnecter » était rendue par `page.tsx`,
 * donc par **un écran sur trois** : ni les coordonnées ni le report ne la
 * portaient, et fermer sa session depuis l'écran de ses coordonnées demandait de
 * revenir d'abord à la liste. Ce qui appartient à l'espace et non à un écran se
 * pose ici — comme le rail du back-office, posé par le layout de `(admin)`.
 *
 * Elle n'est peinte que **s'il y a une session**, et ce n'est pas une garde :
 * connexion et inscription partagent ce gabarit, et n'ont nulle part où
 * naviguer — leur proposer « Se déconnecter » offrirait de fermer une session
 * qui n'est pas ouverte. Le constat suffit donc, et il est le même que celui
 * d'`AdminRail` : *« le rail n'est pas rendu du tout tant qu'il n'y a pas de
 * session : c'est le layout qui en décide »*. La garde des écrans, elle, reste
 * dans chaque page.
 *
 * Ce layout ne redirige pas pour autant : il lit la session pour savoir quoi
 * dessiner, jamais pour décider d'une issue. Rediriger d'ici doublerait la
 * décision de la page — et bouclerait sur l'écran de connexion, qui est sous ce
 * même layout.
 *
 * ## La barre est posée **avant** `<main>`, et hors de lui
 *
 * `<main>` est le repère qui porte *le contenu de l'écran*, et rien d'autre : une
 * navigation rendue à l'intérieur — ce que faisait `page.tsx` — s'y trouvait à
 * tort, si bien que le geste « aller au contenu principal » d'un lecteur d'écran
 * y atterrissait sur la barre plutôt que sur la liste. Dehors, et avant lui,
 * l'ordre du document dit ce qu'il énonce : d'abord où aller, ensuite ce qu'on
 * lit (HTML `main` / `navigation`, WCAG 1.3.2). C'est aussi ce que sauterait un
 * lien d'évitement vers `#contenu` — `apps/web` n'en pose encore aucun, mais
 * l'`id` est là pour lui et la barre n'est plus sur son chemin.
 *
 * Le rythme, lui, ne bouge pas : `.spa-account` et `.spa-account__main`
 * partagent la même gouttière `--spa-space-8`, si bien que la barre garde
 * exactement l'espacement qu'elle avait sous l'en-tête — aucune retouche de
 * `styles/components/account.css` n'a été nécessaire.
 */

export const metadata: Metadata = {
  title: 'Mon compte',
  // L'espace client n'a rien à faire dans un index de recherche : ses pages ne
  // rendent rien sans session, et une URL de compte indexée n'apporte que du
  // trafic qui rebondit sur un écran de connexion.
  robots: { index: false, follow: false },
};

/**
 * Ce gabarit lit un cookie de session pour savoir s'il doit peindre la barre du
 * compte : le mettre en cache servirait la barre de la première visiteuse à
 * quelqu'un qui n'est pas connecté — ou l'inverse (#747).
 *
 * `cookies()` suffirait à sortir du rendu statique ; le dire explicitement, comme
 * le fait le layout du back-office, empêche qu'une revalidation posée un jour
 * au-dessus rattrape la page.
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
  let tenantName: string;
  try {
    tenantName = (await accountTenant(tenantSlug)).name;
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  /**
   * Y a-t-il une session à laquelle la barre du compte s'adresse ?
   *
   * La même lecture que `readAccountData` fait pour décider d'une issue, moins
   * la décision : le cookie d'accès, ou à défaut celui de rafraîchissement — qui
   * annonce une session que la prochaine page renouvellera sur place. Se borner
   * au seul cookie d'accès aurait fait clignoter la barre à chaque expiration,
   * juste avant le renouvellement qui la ramène.
   *
   * Aucun appel à l'API : cette barre ne dit rien du compte, seulement où aller.
   * L'interroger ajouterait un aller-retour à chacun des cinq écrans pour deux
   * libellés qui ne dépendent de personne.
   */
  const signedIn = (await readAccessToken()) !== null || (await readRefreshToken()) !== null;

  return (
    <AccountAnnouncementProvider>
      <div className="spa-account">
        <header className="spa-account__header">
          <p className="spa-account__tenant">{tenantName}</p>
          <h1 className="spa-account__title">Mon compte</h1>
          <p className="spa-account__lead">
            Vos rendez-vous à venir, votre historique et vos coordonnées.
          </p>
        </header>
        {signedIn ? <AccountNav tenantSlug={tenantSlug} /> : null}
        <main className="spa-account__main" id="contenu">
          {/*
            En tête du contenu, et non au pied : ce qui vient de se passer se lit
            avant ce qu'il reste à faire, et le lien d'évitement mène ici.
          */}
          <AccountAnnouncementRegion />
          {children}
        </main>
        <footer className="spa-account__footer">
          <a className="spa-account__back" href={bookingPath(tenantSlug)}>
            Prendre un nouveau rendez-vous
          </a>
          <a className="spa-account__back" href={accountPath(tenantSlug)}>
            Mes rendez-vous
          </a>
        </footer>
      </div>
    </AccountAnnouncementProvider>
  );
}
