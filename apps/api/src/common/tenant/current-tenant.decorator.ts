import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { requireTenantId } from './tenant-context';

/**
 * Injecte le tenant courant dans un paramètre de contrôleur.
 *
 * ```ts
 * // ❌ interdit — le client choisit son tenant
 * findAll(@Query('tenantId') tenantId: string) { … }
 *
 * // ✅ le tenant vient du contexte de requête, résolu côté serveur
 * findAll(@CurrentTenant() tenantId: string) { … }
 * ```
 *
 * Le `ExecutionContext` est reçu et **délibérément ignoré**. C'est le cœur de la
 * garantie : un décorateur qui lirait `request.headers['x-tenant-id']` ou
 * `request.params.tenantId` remettrait le choix du tenant entre les mains de
 * l'appelant, et toute la mécanique d'isolation deviendrait décorative. Rien de
 * ce que le client envoie n'atteint cette fonction — elle n'a qu'une source, le
 * store `AsyncLocalStorage`.
 *
 * Hors contexte, le décorateur **lève** (`MissingTenantContextError` → 500)
 * plutôt que de rendre `undefined` : une route annotée mais non couverte par un
 * résolveur est un défaut de câblage, pas une route « sans tenant ».
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): string => requireTenantId(),
);
