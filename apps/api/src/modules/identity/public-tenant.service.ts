import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import type { PublicTenantDto } from './dto/public-tenant.dto';
import { IdentityRepository, type PublicTenantRecord } from './identity.repository';

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
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      defaultCurrency: tenant.defaultCurrency,
      contactEmail: tenant.contactEmail ?? undefined,
      contactPhone: tenant.contactPhone ?? undefined,
    };
  }
}
