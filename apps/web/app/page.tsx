/**
 * Racine du domaine.
 *
 * Le produit n'a pas d'accueil à cette adresse : un visiteur arrive toujours par
 * la page d'un établissement (`/{slug}/reservation`), depuis un lien du salon ou
 * un résultat de recherche. Cette page dit donc ce qu'il y a à savoir plutôt que
 * de rediriger au hasard vers un établissement qui n'est pas le sien.
 *
 * L'annuaire d'établissements est une fonctionnalité de place de marché,
 * explicitement **hors périmètre** du MVP (CLAUDE.md, contrainte 1).
 */
export default function HomePage() {
  return (
    <main className="spa-empty-state">
      <h1 className="spa-empty-state__title">Réservation en ligne</h1>
      <p className="spa-empty-state__description">
        Chaque salon a sa propre page de réservation. Suivez le lien qu’il vous a communiqué —
        il a la forme <code>/nom-du-salon/reservation</code>.
      </p>
    </main>
  );
}
