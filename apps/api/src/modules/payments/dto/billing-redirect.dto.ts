import { ApiPropertyOptional } from '@nestjs/swagger';
import { LOCALES, billingRedirectRequestSchema, type BillingRedirectRequest } from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import { optionalBody } from './validation';

/**
 * Le corps des deux ouvertures de page hébergée par Stripe — #1261.
 *
 * ## Ce qu'il porte, et pourquoi il a fallu qu'il porte quelque chose
 *
 * Une langue, et rien d'autre. #1231 faisait suivre aux pages Stripe la
 * préférence du **compte** (`users.locale`), ce qui laissait un gérant dont le
 * compte est en français et qui bascule l'interface en anglais devant une page de
 * paiement française. Le reste du produit range le choix explicite **avant** la
 * préférence enregistrée (`apps/web/i18n/resolve.ts`, #845 ; l'export CSV du
 * reporting, #851) : ce corps est ce par quoi ce choix voyage jusqu'ici.
 *
 * ## Le partage des rôles, comme partout depuis l'ADR 0008
 *
 * `billingRedirectRequestSchema` de `@spa/shared` décrit la forme et **juge** le
 * corps, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * La classe ci-dessous ne porte que ses `@ApiProperty`, d'où sort `/api/docs` —
 * et **typer un paramètre de handler par elle viderait le corps de la requête**,
 * le `ValidationPipe` global appliquant `whitelist` à une classe sans décorateur
 * de validation.
 *
 * ## Ce que ce corps ne porte pas, et qui compte plus que ce qu'il porte
 *
 * - **Aucune donnée de carte.** Ni PAN, ni CVC, ni expiration, ni jeton de moyen
 *   de paiement. Les deux routes rendent une **adresse** ; la carte se saisit sur
 *   la page hébergée par Stripe, et notre périmètre PCI reste SAQ A
 *   (payments-stripe §1). Le `.strict()` du contrat est ce qui rend cette
 *   absence exécutable plutôt que déclarative : un champ inconnu est **refusé**,
 *   pas silencieusement ignoré.
 * - **Ni `tenantId`, ni `userId`.** La portée et le gérant viennent du jeton. Un
 *   identifiant accepté ici ferait de ces routes un moyen d'ouvrir le portail de
 *   facturation d'un salon voisin (tenant-isolation §2).
 */

/**
 * Le pipe des deux ouvertures — c'est **lui** qui valide, et non la classe
 * ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 *
 * `optionalBody` l'enveloppe parce qu'**aucun champ n'est obligatoire** : les
 * deux routes n'avaient pas de corps du tout avant #1261 et répondaient 201 sans
 * en recevoir. Elles doivent continuer de le faire — c'est ce qui permet au
 * contrat d'exister avant que tous ses appelants ne l'emploient.
 */
export const billingRedirectBody = new ZodValidationPipe(
  optionalBody(billingRedirectRequestSchema),
);

/** La demande d'ouverture, telle que le contrat la rend au contrôleur. */
export type BillingRedirectBody = BillingRedirectRequest;

/** La demande d'ouverture — la documentation de `billingRedirectRequestSchema`. */
export class BillingRedirectDto {
  @ApiPropertyOptional({
    enum: LOCALES,
    example: 'en',
    description:
      'Langue de la page hébergée par Stripe — celle que le back-office affiche à l’instant du clic. ' +
      'Facultative : sans elle, la langue reste celle du compte du gérant (`users.locale`), puis celle ' +
      'de l’établissement, puis l’anglais. La casse et les espaces sont normalisés (`FR` vaut `fr`) ; ' +
      'ce qui ne désigne aucune des deux langues du contrat est refusé en 400 `VALIDATION_ERROR`.',
  })
  public locale?: string;
}

/**
 * La classe qui documente `/api/docs` doit annoncer exactement les champs que le
 * pipe accepte — la garde de compilation du patron de `cancel-appointment.dto.ts`.
 */
type AssertNever<T extends never> = T;

type _BillingRedirectDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof BillingRedirectDto, keyof z.input<typeof billingRedirectRequestSchema>>
  | Exclude<keyof z.input<typeof billingRedirectRequestSchema>, keyof BillingRedirectDto>
>;
