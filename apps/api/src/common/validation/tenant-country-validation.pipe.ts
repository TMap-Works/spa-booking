import { BadRequestException, Inject, Injectable, type PipeTransform, type Type } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

import { TENANT_COUNTRY_PROVIDER, type TenantCountryProvider } from '../tenant';
import { assertRefusesUnknownKeys, violationsOf } from './zod-validation.pipe';

/**
 * Monte un schéma du contrat partagé comme validateur d'un paramètre de
 * handler, en l'instanciant **avec le pays de l'établissement de la requête**
 * (#1028).
 *
 * ## Le problème que `ZodValidationPipe` ne peut pas résoudre
 *
 * Un `ZodValidationPipe` reçoit son schéma au constructeur, et il est construit
 * à l'amorçage de l'application — une fois, pour toutes les requêtes. C'est
 * exactement ce qu'il faut tant que la règle ne dépend que de la forme du
 * corps ; cela cesse de suffire dès qu'un champ se juge à la lumière d'une
 * **donnée de requête**.
 *
 * Le téléphone du tunnel invité en est le cas, et le seul à ce jour : compléter
 * « 06 12 34 56 78 » demande de savoir que le salon est en France, ce qui se lit
 * dans `tenants.country_code` — donc après que `TenantScopeMiddleware` a résolu
 * le slug de l'URL, et pas avant. Les six autres portes du produit n'avaient pas
 * ce problème : elles normalisent dans leur service, qui a lu l'établissement
 * (`identity/phone.ts`). La septième n'a pas de service à qui déléguer — son
 * corps est refusé *avant* d'atteindre quoi que ce soit — d'où ce pipe.
 *
 * ## Ce qu'il conserve de `ZodValidationPipe`, mot pour mot
 *
 * - **la garde `.strict()`**, vérifiée ici encore à l'amorçage plutôt qu'à la
 *   première requête : la *forme* du schéma ne dépend pas du pays, seul le
 *   contenu d'un champ en dépend, si bien qu'un seul appel de la fabrique suffit
 *   à juger la stricture pour toutes ses instances. Un `tenantId` glissé dans le
 *   corps reste donc refusé, ce qui est la propriété d'isolation à laquelle une
 *   route publique n'a rien d'autre à opposer (tenant-isolation §2) ;
 * - **la forme du refus** : la même `BadRequestException` portant le même
 *   tableau `champ : message`, que `DomainExceptionFilter` sert en
 *   `{ code: "VALIDATION_ERROR", details: { violations } }`. Les deux fonctions
 *   sont **importées** de son fichier et non recopiées : deux écritures d'un
 *   corps d'erreur finissent par diverger, et c'est ce corps-là qui décide si le
 *   message s'affiche sous le champ ou en bloc en tête de page (web-frontend §4).
 *
 * ## Une fabrique de classe, et non une instance
 *
 * Parce que le pipe a une **dépendance à injecter** — le fournisseur du pays — et
 * que Nest ne l'injecte que s'il instancie lui-même le pipe : c'est la
 * différence entre `@Body(monPipe)` et `@Body(MonPipe)`. La classe rendue ici se
 * déclare comme n'importe quel injectable du module qui monte la route, et le
 * jeton `TENANT_COUNTRY_PROVIDER` doit y être résolvable.
 *
 * Le pays est lu **à chaque transformation**, jamais mémorisé dans l'instance :
 * le pipe est un singleton, deux requêtes de deux salons le traversent, et
 * retenir le premier pays validerait la seconde avec le pays du voisin. Seuls
 * les **schémas** sont mémoïsés, par pays — ils ne dépendent que de lui, et les
 * reconstruire à chaque réservation se paierait sur le chemin le plus chaud du
 * produit. Le cache est borné par le nombre de codes pays existants.
 *
 * @param schemaFor la fabrique du contrat partagé — `…SchemaFor(pays)`
 */
export function tenantCountryValidationPipe<TSchema extends ZodTypeAny>(
  schemaFor: (defaultCountry: string | null) => TSchema,
): Type<PipeTransform<unknown, Promise<z.infer<TSchema>>>> {
  // À l'amorçage, sur une ligne de code, et non à la première requête d'un
  // appelant qui aurait deviné le nom d'un champ — voir l'en-tête de
  // `assertRefusesUnknownKeys`.
  assertRefusesUnknownKeys(schemaFor(null));

  @Injectable()
  class TenantCountryValidationPipe implements PipeTransform<unknown, Promise<z.infer<TSchema>>> {
    private readonly schemas = new Map<string | null, TSchema>();

    public constructor(
      @Inject(TENANT_COUNTRY_PROVIDER) private readonly tenants: TenantCountryProvider,
    ) {}

    public async transform(value: unknown): Promise<z.infer<TSchema>> {
      const parsed = this.schemaFor(await this.tenants.currentCountryCode()).safeParse(value);

      if (!parsed.success) {
        throw new BadRequestException(violationsOf(parsed.error));
      }

      return parsed.data as z.infer<TSchema>;
    }

    private schemaFor(defaultCountry: string | null): TSchema {
      const cached = this.schemas.get(defaultCountry);

      if (cached !== undefined) {
        return cached;
      }

      const schema = schemaFor(defaultCountry);
      this.schemas.set(defaultCountry, schema);

      return schema;
    }
  }

  return TenantCountryValidationPipe;
}
