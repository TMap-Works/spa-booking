/**
 * « Active » / « Désactivée » — l'état d'une prestation ou d'une rubrique.
 *
 * ## Pourquoi ces classes-là
 *
 * `--confirmed` et `--cancelled` sont nées pour les statuts de rendez-vous
 * (`styles/admin/shell.css`). Elles sont reprises ici plutôt que d'ajouter deux
 * variantes de badge au design system, pour une raison précise : le back-office
 * n'a que deux teintes d'état — « en vigueur » et « retiré » —, elles sont déjà
 * déclarées, déjà vérifiées au contraste AA par `contrast.test.mjs`, et une
 * troisième paire de jetons qui dirait la même chose finirait par en diverger au
 * premier changement de rampe. Le libellé, lui, reste écrit : la couleur ne
 * porte jamais l'information seule (WCAG 1.4.1).
 *
 * Le jour où le catalogue mérite ses propres teintes, c'est ici qu'elles se
 * posent — un seul endroit à changer, et aucune page à rouvrir.
 */
export function CatalogStatusBadge({ isActive }: { readonly isActive: boolean }) {
  return (
    <span className={`spa-admin-badge spa-admin-badge--${isActive ? 'confirmed' : 'cancelled'}`}>
      {isActive ? 'Active' : 'Désactivée'}
    </span>
  );
}
