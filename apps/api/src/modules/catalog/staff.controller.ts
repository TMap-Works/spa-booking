import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import { ListStaffQueryDto, StaffMemberDto } from './dto/staff.dto';
import { StaffService } from './staff.service';

/**
 * L'annuaire des fiches praticien de l'établissement — #421.
 *
 * | Route | Rôles |
 * |---|---|
 * | `GET /staff` | staff et au-dessus |
 *
 * ## Ce que cette route répare
 *
 * `POST /services/:serviceId/staff` attend l'identifiant d'une **fiche**
 * praticien, et aucune lecture n'en rendait la liste : `GET /services/:id/staff`
 * ne montre que les praticiens **déjà affectés**, le catalogue public pas
 * davantage, et `GET /v1/users` rend des **comptes** dont l'identifiant n'est
 * pas celui d'une fiche. Un salon qui démarre n'avait donc aucun candidat à
 * proposer, et sa toute première affectation était impossible depuis le
 * back-office.
 *
 * ## Lire au rang `STAFF`
 *
 * Le même seuil que le reste des lectures du module. Savoir qui travaille dans
 * l'établissement n'est pas une information de gestion — c'est ce qu'un
 * praticien lit sur le planning affiché en cabine —, et la fiche ne porte ni le
 * compte, ni le contact, ni la rémunération. Rien n'écrit ici : le cycle de vie
 * de la fiche n'appartient encore à aucun module, et l'ouvrir sur cette route
 * choisirait ce propriétaire par inadvertance.
 *
 * ## Une ressource à plat, et non une sous-ressource
 *
 * `/staff` plutôt que `/services/:serviceId/staff` — qui existe déjà et répond à
 * une autre question. Celle-ci est « quelles fiches ce salon a-t-il », sans
 * prestation pour contexte : c'est précisément l'absence de contexte
 * d'affectation qui la rend utile à l'amorçage.
 *
 * ## Pourquoi aucun `:tenantId` nulle part
 *
 * L'établissement vient du jeton vérifié, jamais du chemin ni de la chaîne de
 * requête (tenant-isolation §2). Il n'y a rien à comparer ici : le client Prisma
 * est déjà borné quand la lecture l'atteint, et le seul paramètre déclaré est un
 * filtre d'activité — `forbidNonWhitelisted` rejette tout le reste en 400 plutôt
 * que de l'ignorer.
 */
@ApiTags('catalog')
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  public constructor(private readonly staff: StaffService) {}

  /**
   * Les fiches praticien de l'établissement, **désactivées comprises**.
   *
   * L'identifiant rendu est celui de la fiche : il part tel quel dans le corps
   * de `POST /services/{serviceId}/staff`.
   *
   * Pas de 404 possible : une liste vide est la réponse juste pour un salon qui
   * n'a encore aucune fiche, et c'est un état d'amorçage, pas une erreur.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les fiches praticien de l’établissement' })
  @ApiOkResponse({ type: [StaffMemberDto] })
  public async list(@Query() query: ListStaffQueryDto): Promise<StaffMemberDto[]> {
    return this.staff.list(query.activeOnly ?? false);
  }
}
