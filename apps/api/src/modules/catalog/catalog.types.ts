/**
 * Formes de données du module `catalog` — CDC §2.3 « services, catégories,
 * durée, prix ».
 *
 * TODO(#26) : `Money`, `ServiceView` et `ServiceCategoryView` appartiennent au
 * contrat d'API et devront être importés de `@spa/shared` — le front ne
 * redéclare jamais un type que l'API expose (CLAUDE.md). Le paquet décrit déjà
 * ces formes (`packages/shared/src/schemas/catalog.ts`, tenu à jour par ce même
 * ticket) ; la substitution demandera d'ajouter la dépendance à
 * `apps/api/package.json`, ce qu'aucun module de l'API ne fait encore — voir le
 * même TODO dans `identity.types.ts`.
 *
 * ## Aucune de ces formes ne porte de `tenantId`
 *
 * Ni en entrée, ni en sortie. En entrée, parce que le tenant vient du contexte
 * d'authentification et de nulle part ailleurs (tenant-isolation §2) : un champ
 * dans un DTO serait exactement le paramètre que le client contrôle. En sortie,
 * parce que c'est une information interne qui n'apporte rien au consommateur et
 * invite aux essais (§4).
 */

/**
 * Un montant : entier dans la plus petite unité, et le code devise qui lui donne
 * son sens. **Jamais de flottant** (CLAUDE.md).
 *
 * Les deux voyagent dans le même objet, et non en deux champs plats comme en
 * base : deux champs indépendants dans une charge utile peuvent être mis à jour
 * séparément, et il existe alors un instant où le montant est celui de l'ancienne
 * devise. La mise à plat vers `price_amount_minor` / `price_currency` est la
 * responsabilité du repository.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Une catégorie telle que l'API la rend. */
export interface ServiceCategoryView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
}

/** Forme réduite, telle qu'imbriquée dans une prestation. */
export interface ServiceCategorySummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Une prestation telle que l'API la rend.
 *
 * La catégorie est **imbriquée** plutôt que réduite à son identifiant : un écran
 * de catalogue affiche le libellé, et le rendre obligerait sinon le front à une
 * seconde requête ou à un appariement côté client.
 */
export interface ServiceView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: ServiceCategorySummary | null;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  /**
   * Durée réellement bloquée sur l'agenda du praticien, tampons compris.
   *
   * Dérivée et non stockée : une colonne de plus se désynchroniserait de ses
   * trois termes à la première mise à jour partielle. Elle est rendue parce que
   * c'est la valeur dont le calendrier admin a besoin, et que la recalculer côté
   * front exposerait la règle à diverger.
   */
  readonly occupiedMinutes: number;
  readonly price: Money;
  readonly isActive: boolean;
}
