/**
 * Pagination — une seule forme pour toutes les listes de l'API.
 *
 * Pagination par numéro de page, et non par curseur : le back-office affiche des
 * tableaux avec un sélecteur de page, et aucune liste du périmètre MVP n'atteint
 * la volumétrie où le décalage `OFFSET` coûte quelque chose. Passer au curseur
 * est une décision d'ADR, pas un ajout de champ.
 */

import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/limits';

/**
 * Paramètres de pagination reçus en query string.
 *
 * `z.coerce` parce qu'une query string ne transporte que des chaînes :
 * `?page=2` arrive en `'2'`. Le plafond `MAX_PAGE_SIZE` est appliqué **côté
 * serveur** et n'est pas négociable par le client — sans lui, `?pageSize=100000`
 * est un déni de service à une requête.
 */
export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Métadonnées renvoyées avec toute page de résultats. */
export const paginationMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});

export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/**
 * Enveloppe d'une page de résultats.
 *
 * Déclarée comme une intersection avec `PaginationMeta` plutôt que réécrite :
 * les quatre champs de métadonnées n'existent qu'à un seul endroit, et ajouter
 * une métadonnée la propage à toutes les listes sans retoucher ce type.
 */
export type Paginated<T> = PaginationMeta & { items: T[] };

/**
 * Construit le schéma d'une page pour un type d'élément donné.
 *
 * ```ts
 * const servicePageSchema = paginatedSchema(serviceSchema);
 * ```
 */
export function paginatedSchema<TItem extends z.ZodTypeAny>(item: TItem) {
  return paginationMetaSchema.extend({ items: z.array(item) });
}

/**
 * Calcule les métadonnées d'une page.
 *
 * `totalPages` vaut `0` sur un ensemble vide et non `1` : « page 1 sur 0 »
 * décrit correctement une liste sans résultat, là où « page 1 sur 1 » laisse
 * croire à une page qui existe.
 */
export function paginationMeta(
  query: PaginationQuery,
  totalItems: number,
): PaginationMeta {
  return paginationMetaSchema.parse({
    page: query.page,
    pageSize: query.pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / query.pageSize),
  });
}
