import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import type {
  OpeningHoursEntryDto,
  PostalAddressDto,
  PublicTenantDto,
} from './dto/public-tenant.dto';
import {
  IdentityRepository,
  type OpeningHourRecord,
  type PublicTenantRecord,
} from './identity.repository';
import { minutesToWallClock } from './opening-hours';

/**
 * L'adresse, **composée** depuis les cinq colonnes — ou `undefined` (#343).
 *
 * Le triplet `line1` / `city` / `countryCode` décide : les trois renseignés,
 * l'adresse sort ; l'un manquant, elle n'existe pas. La base tient déjà cette
 * règle (`tenants_address_completeness_check`), mais elle est revérifiée ici
 * pour une raison de **typage** autant que de sûreté : le contrat déclare ces
 * trois champs requis dans l'objet, et rien dans le type de la ligne lue ne dit
 * qu'ils vont ensemble.
 *
 * `line2` et `postalCode` sont **omis** plutôt que rendus à `null`, comme les
 * contacts : c'est la forme que `postalAddressSchema` déclare, et un `null` là
 * où le front attend une chaîne ou rien ferait échouer la validation.
 *
 * Exportée pour être vérifiée en test — sa seule règle intéressante est celle
 * du triplet, et elle ne se voit pas depuis un statut HTTP.
 */
export function toPostalAddress(tenant: {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
}): PostalAddressDto | undefined {
  if (tenant.addressLine1 === null || tenant.city === null || tenant.countryCode === null) {
    return undefined;
  }

  return {
    line1: tenant.addressLine1,
    ...(tenant.addressLine2 === null ? {} : { line2: tenant.addressLine2 }),
    ...(tenant.postalCode === null ? {} : { postalCode: tenant.postalCode }),
    city: tenant.city,
    country: tenant.countryCode,
  };
}

/**
 * Les horaires, **omis** quand la semaine est vide (#343).
 *
 * Rendre `[]` aurait créé un troisième état — « publié, mais vide » — qu'aucun
 * écran n'aurait su distinguer de « pas encore renseigné », et qui aurait
 * affiché une section d'horaires blanche là où il n'y a rien à dire. Le contrat
 * partagé le déclare `.optional()` pour exactement cette raison.
 *
 * L'ordre vient de la base (`PUBLIC_TENANT_SELECT`) et n'est pas retrié ici :
 * deux tris successifs finissent par diverger sur les cas d'égalité.
 */
export function toOpeningHours(
  entries: readonly OpeningHourRecord[],
): readonly OpeningHoursEntryDto[] | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return entries.map((entry) => ({
    weekday: entry.weekday,
    opensAt: minutesToWallClock(entry.startMinute),
    closesAt: minutesToWallClock(entry.endMinute),
  }));
}

/**
 * Ce qu'une page de réservation publique a le droit de savoir de son
 * établissement.
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2) : le tenant
 * lui arrive par le contexte de requête, résolu par `TenantScopeMiddleware`
 * depuis le sous-domaine ou le slug d'URL. Ce service n'a donc **aucun
 * paramètre d'établissement** — et c'est la propriété qui compte : il n'existe
 * pas de signature par laquelle un appelant pourrait en désigner un autre.
 */
@Injectable()
export class PublicTenantService {
  public constructor(private readonly repository: IdentityRepository) {}

  /**
   * La vitrine de l'établissement de la requête.
   *
   * Le `null` ne devrait pas arriver — le middleware vient de résoudre ce même
   * établissement contre la même table. Il reste traité, et en 404 : la seule
   * façon d'y parvenir est qu'un salon ait été supprimé entre les deux
   * lectures, et la réponse juste est alors exactement celle d'un slug inconnu.
   */
  public async currentTenant(): Promise<PublicTenantDto> {
    const tenant = await this.repository.findCurrentPublicTenant();
    if (tenant === null) {
      throw new NotFoundError('Établissement introuvable.');
    }
    return PublicTenantService.toPublicTenant(tenant);
  }

  /**
   * Recopie champ par champ, plutôt qu'un `{ ...tenant }`.
   *
   * L'étalement rendrait ce que le repository a lu — donc, le jour où quelqu'un
   * ajoute un champ à la projection sans penser à la réponse, un champ interne
   * de plus dans une réponse publique. Ici, publier demande d'écrire une ligne.
   *
   * `null` devient `undefined` sur les deux contacts : la base les stocke
   * nullables, le contrat partagé les déclare **optionnels**
   * (`publicTenantSchema`), et c'est le contrat qui fait foi. `undefined`
   * disparaît à la sérialisation, la clé est donc absente du corps — la forme
   * que le front valide. La conversion a lieu ici parce que c'est la frontière :
   * en deçà, la forme de la base ; au-delà, celle de l'API.
   */
  private static toPublicTenant(tenant: PublicTenantRecord): PublicTenantDto {
    const address = toPostalAddress(tenant);
    const openingHours = toOpeningHours(tenant.openingHours);

    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      defaultCurrency: tenant.defaultCurrency,
      contactEmail: tenant.contactEmail ?? undefined,
      contactPhone: tenant.contactPhone ?? undefined,
      // Étalement conditionnel : la clé est **absente** de l'objet, et non
      // présente à `undefined`. La sérialisation JSON confond les deux, mais
      // `Object.keys` non — et cet objet est aussi lu tel quel par les tests
      // unitaires, qui vérifient que la liste des champs publiés est close.
      ...(address === undefined ? {} : { address }),
      ...(openingHours === undefined ? {} : { openingHours }),
    };
  }
}
