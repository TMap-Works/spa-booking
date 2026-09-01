/**
 * Page servie sur un `notFound()` ou une adresse inconnue.
 *
 * Elle ne distingue pas l'établissement qui n'existe pas de celui qui est
 * désactivé : l'API répond 404 dans les deux cas, et un message qui les
 * séparerait confirmerait l'existence d'un salon à qui essaie des slugs au
 * hasard (tenant-isolation §4).
 */
export default function NotFound() {
  return (
    <main className="spa-empty-state">
      <h1 className="spa-empty-state__title">Page introuvable</h1>
      <p className="spa-empty-state__description">
        Cette adresse ne correspond à aucune page de réservation. Vérifiez le lien que le salon
        vous a communiqué.
      </p>
    </main>
  );
}
