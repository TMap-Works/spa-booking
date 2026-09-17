import { ProgressBar } from '@/components/ui/progress-bar';

/** Lignes de la carte : de quoi remplir la hauteur d'un écran de bureau. */
const SKELETON_ROWS = [1, 2, 3, 4, 5, 6] as const;

/**
 * L'écran du back-office qui arrive (#830).
 *
 * ## Où il s'affiche
 *
 * C'est le rendu des `loading.tsx` du back-office, à la place de l'écran et sous
 * le layout admin : le rail reste en place et utilisable. Chaque écran a sa
 * frontière, que l'App Router recrée à chaque changement d'écran — elle
 * s'affiche donc d'un écran à son voisin, de « Clients » à « Encaissement ».
 *
 * Elle borne aussi le préchargement des entrées du rail : un `<Link>` vers une
 * page dynamique précharge ses segments jusqu'au premier `loading.tsx`. Le clic
 * affiche donc ce squelette sans aller-retour, et le contenu suit.
 *
 * ## Pourquoi une frontière par écran, et pas une pour tout le back-office
 *
 * Un squelette part vers le navigateur **avant** la page, en-tête de réponse
 * compris. Une page qui lève `notFound()` sous lui ne peut donc plus répondre
 * 404 — or les fiches d'une prestation et d'un praticien en font un point
 * délibéré (`catalogue/[serviceId]/not-found.tsx`,
 * `personnel/[staffId]/not-found.tsx`) : l'identifiant mal formé, inconnu ou
 * d'un autre établissement rend le même écran **et** le même statut
 * (tenant-isolation §4). Une frontière posée sur `admin/` les enveloppait, et la
 * revue de #830 l'a relevé.
 *
 * Les frontières sont donc posées écran par écran, et jamais au-dessus d'une
 * fiche : les listes du catalogue et du personnel vivent sous un groupe
 * `(liste)/` pour cette seule raison. Les fiches n'ont que la barre de
 * progression, le temps d'arriver. `tests/unit/route-boundaries.test.tsx` tient
 * la règle.
 *
 * ## Ce qu'il annonce
 *
 * `aria-busy` et une phrase masquée, comme le squelette du tunnel. La barre de
 * progression est rendue ici aussi : elle prend le relais de celle du clic, qui
 * s'éteint à l'arrivée de l'URL (`components/ui/progress-bar.tsx`).
 *
 * Aucun titre de niveau 1 : chaque écran rend le sien, et un titre provisoire
 * annoncerait un nom d'écran que le squelette ignore — il les sert tous. Sa
 * forme et ses mesures sont décrites dans `styles/admin/loading.css`.
 */
export function AdminScreenSkeleton() {
  return (
    <div aria-busy="true" className="spa-admin-loading">
      <ProgressBar />
      <p className="spa-visually-hidden">Chargement de l’écran…</p>
      <span className="spa-skeleton spa-admin-loading__title" />
      <div className="spa-admin-loading__toolbar">
        <span className="spa-skeleton spa-admin-loading__control" />
        <span className="spa-skeleton spa-admin-loading__control" />
      </div>
      <div className="spa-admin__section">
        <span className="spa-skeleton spa-admin-loading__heading" />
        {SKELETON_ROWS.map((row) => (
          <span className="spa-skeleton spa-admin-loading__row" key={row} />
        ))}
      </div>
    </div>
  );
}
