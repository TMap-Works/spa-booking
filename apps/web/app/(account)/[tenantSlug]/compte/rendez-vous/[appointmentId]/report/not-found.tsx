'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { accountPath } from '../../../paths';

/**
 * L'écran servi quand le rendez-vous à reporter n'existe plus (#627).
 *
 * ## Pourquoi une frontière à ce segment, et non un message dans la page
 *
 * `page.tsx` appelle `notFound()` dans trois situations qui doivent rester
 * indiscernables — identifiant inexistant, rendez-vous d'une autre cliente,
 * rendez-vous déjà sorti de la liste « à venir » (tenant-isolation §4). Sans
 * frontière propre, cet appel remontait jusqu'à `app/not-found.tsx`, qui répond
 * pour une **adresse publique inconnue** : « Vérifiez le lien que le salon vous a
 * communiqué », sans bandeau, sans pied de page, sans un seul lien. La cliente
 * était pourtant dans son propre espace et n'avait suivi aucun lien du salon.
 *
 * Une frontière posée ici corrige les deux à la fois :
 *
 * - le **message** parle du rendez-vous, plus de l'adresse ;
 * - l'écran est rendu **dans** l'enveloppe de l'espace client — bandeau au nom du
 *   salon, pied de page et ses deux liens — au lieu de la remplacer.
 *
 * Le 404 générique reste intact : un slug d'établissement inconnu est refusé par
 * `compte/layout.tsx`, en amont de cette frontière, et continue donc de rendre le
 * message qui lui convient.
 *
 * ## Le statut HTTP reste 404
 *
 * C'est la raison de passer par `not-found.tsx` plutôt que de faire rendre l'état
 * d'erreur par la page elle-même : une page qui rend son message sans lever
 * répond **200**, et annoncerait comme existante une ressource qui n'existe pas.
 *
 * ## Pourquoi un Client Component pour trois lignes de balisage
 *
 * Une frontière `not-found` ne reçoit **aucune prop** — ni `params`, ni
 * `searchParams` : c'est une limite de l'App Router, pas un oubli. Le slug de
 * l'établissement, dont dépend le chemin de retour, ne peut donc venir que de
 * l'URL courante. `usePathname()` est le seul accès qui y mène, et il n'existe
 * que côté client. C'est le même arbitrage que le rail du back-office.
 */

/**
 * Le slug de l'établissement, premier segment de toute URL de l'espace client.
 *
 * Il est décodé avant d'être rendu à `accountPath`, qui le réencode : sans ce
 * passage, un slug déjà encodé dans le chemin le serait une seconde fois, et le
 * lien de retour pointerait à côté. `usePathname()` rend bien le chemin **encodé**
 * — Next le tire de `new URL(canonicalUrl).pathname` —, ce qui rend ce décodage
 * nécessaire et non redondant.
 *
 * Rend `null` plutôt qu'une chaîne vide quand le premier segment manque ou ne se
 * décode pas. Les deux cas ne devraient pas se présenter sur cette frontière, qui
 * n'est atteinte que sous un slug déjà résolu par `compte/layout.tsx` — mais une
 * chaîne vide passée à `accountPath` donnerait `//compte`, que le navigateur lit
 * comme l'URL **absolue** `https://compte/` : la seule issue de l'écran sortirait
 * du site. Et un `decodeURIComponent` qui lève remplacerait le 404 par la
 * frontière d'erreur — précisément l'écran que #627 cherche à ne plus montrer.
 */
function tenantSlugFromPathname(pathname: string): string | null {
  const [, encodedSlug = ''] = pathname.split('/');

  if (encodedSlug === '') {
    return null;
  }

  try {
    return decodeURIComponent(encodedSlug);
  } catch {
    // Un segment qui ne se décode pas ne désigne aucun établissement : mieux vaut
    // n'offrir aucun lien que d'en fabriquer un au hasard. Même arbitrage que
    // `readApiSessionCookie` dans `lib/api-client.ts`.
    return null;
  }
}

export default function ReportAppointmentNotFound() {
  const tenantSlug = tenantSlugFromPathname(usePathname());

  return (
    <section className="spa-account__panel" aria-labelledby="report-introuvable-titre">
      <h2 className="spa-account__section-title" id="report-introuvable-titre">
        Ce rendez-vous n’est plus disponible
      </h2>

      {/*
       * Le texte ne dit pas **laquelle** des trois situations s'est produite : le
       * distinguer confirmerait à qui essaie des identifiants au hasard qu'un
       * rendez-vous existe, et chez qui (tenant-isolation §4).
       */}
      <p className="spa-account__lead">
        Il a pu être annulé, déjà déplacé, ou avoir eu lieu depuis. Vos rendez-vous à venir sont
        toujours dans votre compte, et ceux-là peuvent encore être reportés.
      </p>

      {/*
       * Sans slug lisible, le lien est tu plutôt que fabriqué : le pied de page de
       * `compte/layout.tsx`, lui, tient son slug des `params` et reste une issue.
       */}
      {tenantSlug === null ? null : (
        <div className="spa-account__actions">
          <Link className="spa-button spa-button--accent" href={accountPath(tenantSlug)}>
            Revenir à mes rendez-vous
          </Link>
        </div>
      )}
    </section>
  );
}
