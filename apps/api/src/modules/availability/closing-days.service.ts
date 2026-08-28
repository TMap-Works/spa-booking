import { Injectable } from '@nestjs/common';

import { AvailabilityCacheService } from './availability-cache';
import { AvailabilityRepository } from './availability.repository';
import { isIsoWeekday, type IsoWeekday } from './availability.schedule';
import type { ClosingDaysView } from './availability.types';

/**
 * Jours de fermeture **récurrents** de l'établissement — « fermé le dimanche »
 * (#32, troisième critère).
 *
 * ## Pourquoi la fermeture n'est pas un trou dans chaque semaine de travail
 *
 * Elle pourrait l'être : il suffirait de ne poser aucun horaire le dimanche pour
 * chaque praticien. Elle ne l'est pas, parce qu'un praticien embauché après coup
 * rouvrirait le salon à lui seul — sa semaine par défaut ne saurait rien de la
 * fermeture, et le calendrier public proposerait des créneaux un jour où
 * personne n'ouvre. La fermeture est un fait de l'établissement ; elle se dit
 * une fois, au même endroit que le fuseau et la devise.
 *
 * ## Ce qui n'est pas ici
 *
 * Les fermetures **ponctuelles** — un jour férié, une semaine de congés. Elles
 * portent une date et non un jour de semaine, et relèvent des plages bloquées
 * (#33). Les confondre obligerait à ressaisir chaque année les mêmes fériés sous
 * forme de récurrence hebdomadaire, ce qu'ils ne sont pas.
 *
 * Comme `StaffScheduleService`, ce service ne compare aucun `tenantId` : le
 * client Prisma du repository est scopé par le contexte de requête, et il n'y a
 * pas de paramètre par lequel désigner un autre établissement.
 */
@Injectable()
export class ClosingDaysService {
  public constructor(
    private readonly repository: AvailabilityRepository,
    private readonly cache: AvailabilityCacheService,
  ) {}

  public async list(): Promise<ClosingDaysView> {
    return { weekdays: await this.readWeekdays() };
  }

  /**
   * Remplace intégralement la liste des jours fermés.
   *
   * Un tableau vide est licite et signifie « ouvert sept jours sur sept » : c'est
   * ainsi qu'on rouvre un jour, et il n'y a donc pas de suppression unitaire à
   * écrire. Les doublons sont refusés par le DTO — et par l'unique
   * `(tenant_id, weekday)` en base, qui reste la garantie.
   *
   * ## Le cache est chassé après l'écriture (#35, troisième critère)
   *
   * Une fermeture s'applique à **tous** les praticiens : c'est l'écriture qui
   * change le plus de créneaux d'un seul geste. Un salon qui ferme le lundi et
   * dont le cache continue d'en proposer les créneaux prend des rendez-vous que
   * personne n'honorera — et rien ne le rattrape en aval, la contrainte
   * d'exclusion ne connaissant que les chevauchements.
   */
  public async replace(weekdays: readonly number[]): Promise<ClosingDaysView> {
    // `replaceClosedWeekdays` relit déjà la liste après écriture, et la rend
    // triée : la relire une seconde fois ne coûterait qu'un aller-retour de
    // plus, sur une réponse qui serait la même.
    const stored = await this.repository.replaceClosedWeekdays(weekdays);

    await this.cache.invalidateCurrentTenant();

    return { weekdays: stored.filter(isIsoWeekday) };
  }

  /**
   * Les jours fermés, relus depuis la base.
   *
   * `filter(isIsoWeekday)` n'est pas une défiance envers la contrainte `CHECK`
   * qui borne la colonne à 1-7 : c'est ce qui donne au tableau son type sans un
   * `as`, et la contrainte reste ce qui garantit qu'aucune ligne n'est écartée.
   */
  private async readWeekdays(): Promise<IsoWeekday[]> {
    const stored = await this.repository.listClosedWeekdays();

    return stored.filter(isIsoWeekday);
  }
}
