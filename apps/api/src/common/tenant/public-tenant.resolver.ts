import type { Provider } from '@nestjs/common';

/**
 * Le contrat par lequel le middleware public change un slug en établissement.
 *
 * ## Pourquoi une abstraction plutôt qu'un appel direct
 *
 * La lecture `slug → tenantId` interroge la table `tenants`, et cette table
 * appartient au module `identity` (CDC §2.3). Le middleware, lui, vit dans
 * `common/` parce qu'il s'applique à **toutes** les routes, bien avant qu'un
 * module métier ne soit choisi. Faire importer `IdentityRepository` par
 * `common/tenant` inverserait la dépendance — un socle transverse qui connaît un
 * module métier — et api-module §3 l'interdit précisément pour que les modules
 * restent extractibles.
 *
 * Le jeton retourne la dépendance : `common/` déclare ce dont il a besoin,
 * `identity` le fournit. Aucun `import` ne relie les deux.
 *
 * ## Ce que le contrat ne rend pas
 *
 * Un identifiant, et rien d'autre. Rendre la fiche complète ferait voyager le
 * nom, le contact et l'état d'activation de l'établissement jusqu'à un
 * middleware qui n'en a que faire — et la première fois qu'on chercherait où
 * afficher ces champs, ils seraient déjà là.
 */
export interface PublicTenantResolver {
  /**
   * L'identifiant de l'établissement **actif** portant ce slug, ou `null`.
   *
   * `null` couvre indistinctement « aucun établissement » et « établissement
   * désactivé » : les distinguer dirait à un visiteur qu'un salon a existé, et
   * lequel.
   */
  findTenantIdBySlug(slug: string): Promise<string | null>;
}

/**
 * Jeton d'injection du résolveur. Un `Symbol` plutôt qu'une chaîne : deux
 * modules ne peuvent pas se marcher dessus par homonymie.
 */
export const PUBLIC_TENANT_RESOLVER = Symbol('PUBLIC_TENANT_RESOLVER');

/** Le fournisseur tel qu'`identity` le déclare — la forme est écrite une fois. */
export type PublicTenantResolverProvider = Provider<PublicTenantResolver>;
