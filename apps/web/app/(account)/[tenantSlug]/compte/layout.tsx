import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { ApiClientError } from '@/lib/api-client';

import { accountPath } from './paths';
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
 */

export const metadata: Metadata = {
  title: 'Mon compte',
  // L'espace client n'a rien à faire dans un index de recherche : ses pages ne
  // rendent rien sans session, et une URL de compte indexée n'apporte que du
  // trafic qui rebondit sur un écran de connexion.
  robots: { index: false, follow: false },
};

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

  return (
    <div className="spa-account">
      <header className="spa-account__header">
        <p className="spa-account__tenant">{tenantName}</p>
        <h1 className="spa-account__title">Mon compte</h1>
        <p className="spa-account__lead">
          Vos rendez-vous à venir, votre historique et vos coordonnées.
        </p>
      </header>
      <main className="spa-account__main" id="contenu">
        {children}
      </main>
      <footer className="spa-account__footer">
        <a className="spa-account__back" href={`/${encodeURIComponent(tenantSlug)}/reservation`}>
          Prendre un nouveau rendez-vous
        </a>
        <a className="spa-account__back" href={accountPath(tenantSlug)}>
          Mes rendez-vous
        </a>
      </footer>
    </div>
  );
}
