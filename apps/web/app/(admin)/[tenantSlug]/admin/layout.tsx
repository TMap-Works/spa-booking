import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../../../../styles/admin/index.css';

/**
 * L'enveloppe du back-office.
 *
 * ## Un groupe de routes à lui
 *
 * `(admin)` est le troisième produit servi par `apps/web`, à côté du parcours
 * public `(booking)` et de l'espace client `(account)` : derrière
 * authentification, **non indexable**, à densité d'information élevée
 * (web-frontend §1). Le segment `[tenantSlug]` est le même que celui du tunnel —
 * on atteint `/salon-des-lilas/admin` comme `/salon-des-lilas/reservation` — et
 * les groupes ne se disputent aucune route.
 *
 * ## Portée volontairement réduite
 *
 * Ce layout n'est pas le shell du tableau de bord : navigation latérale,
 * calendrier, indicateurs et fil d'Ariane relèvent de #48. Il porte ici le
 * minimum dont l'écran de réglages (#343) a besoin — un titre, un cadre, et le
 * `robots: noindex` qui compte vraiment. Le remplacer par le vrai shell ne
 * demandera pas de toucher aux pages.
 *
 * ## Ce que ce layout ne fait pas : garder la session
 *
 * Un layout n'est pas une frontière de sécurité dans l'App Router : il n'est pas
 * rejoué à chaque navigation, et une page peut être servie sans que son parent
 * ait été réévalué. La garde vit donc **dans chaque page**, et l'écran de
 * connexion s'en passe délibérément plutôt que d'être exempté par une liste
 * tenue ailleurs.
 */

export const metadata: Metadata = {
  title: 'Back-office',
  // Le back-office n'a rien à faire dans un index de recherche : ses pages ne
  // rendent rien sans session, et une URL indexée n'apporte que du trafic qui
  // rebondit sur un écran de connexion.
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="spa-admin">
      <main className="spa-admin__content" id="contenu">
        {children}
      </main>
    </div>
  );
}
