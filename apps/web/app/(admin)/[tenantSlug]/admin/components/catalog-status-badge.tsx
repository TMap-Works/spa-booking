import { useTranslations } from 'next-intl';

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
 *
 * ## Pas de directive `'use client'`, et c'est délibéré (#849)
 *
 * Le fichier ne tient aucun état : Next.js le compile dans le graphe de celui
 * qui l'importe. La liste du catalogue, la fiche d'une prestation et l'écran
 * d'une rubrique l'importent côté serveur ; `CategoryManager` l'importe côté
 * client. `useTranslations` fonctionne des deux côtés de la frontière — c'est
 * précisément ce qui permet à ce fichier de rester sans directive, comme
 * `period-nav.tsx`.
 */
export function CatalogStatusBadge({ isActive }: { readonly isActive: boolean }) {
  const t = useTranslations('admin-catalog');

  return (
    <span className={`spa-admin-badge spa-admin-badge--${isActive ? 'confirmed' : 'cancelled'}`}>
      {isActive ? t('status.active') : t('status.inactive')}
    </span>
  );
}
