import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { AvailabilityCacheService } from './availability-cache';
import {
  InvalidTimeOffRangeError,
  MAX_TIME_OFF_RANGE_DAYS,
  TIME_OFF_RULES,
} from './availability.errors';
import { StaffTimeOffRepository } from './staff-time-off.repository';
import type { StaffBusyRange, StaffTimeOffView, TimeOffWindow } from './staff-time-off.types';

/**
 * Plages bloquées et congés du personnel — CDC §2.3, #33.
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le repository est **scopé** par le contexte de
 * requête, que `JwtAuthGuard` a renseigné depuis une revendication signée. Une
 * lecture visant l'absence d'un autre établissement ne la trouve donc pas — elle
 * rend `null`, que ce service traduit en `NotFoundError`, donc en 404.
 *
 * Un service qui aurait comparé les tenants lui-même aurait eu un `if` à écrire,
 * et ce `if` aurait eu à choisir entre 403 et 404. Le 403 est précisément la
 * fuite qu'on refuse (tenant-isolation §4). Ne pas avoir l'information est la
 * meilleure garantie de ne pas la divulguer.
 *
 * ## Deux règles, et deux seulement
 *
 * 1. **Les bornes tiennent** — la fin suit le début, et l'absence ne dépasse pas
 *    `MAX_TIME_OFF_RANGE_DAYS`. Jugée ici et non dans le DTO, parce qu'une
 *    modification partielle ne fournit qu'une des deux bornes : l'autre se lit
 *    en base, et un décorateur de champ ne la voit pas.
 * 2. **Toute écriture invalide le cache de disponibilité.** C'est le point qui
 *    s'oublie et qui ne se rattrape pas : un cache qui montre un créneau pendant
 *    un congé produit une réservation que personne n'honorera.
 *
 * Ce qui n'est délibérément **pas** une règle : le chevauchement. Deux absences
 * qui se recouvrent ne sont que la même absence dite deux fois, et les interdire
 * ferait échouer le geste anodin d'étendre un congé en en posant un second. Le
 * moteur les fusionne avant de soustraire (`availability.intervals.ts`).
 */
@Injectable()
export class StaffTimeOffService {
  public constructor(
    private readonly repository: StaffTimeOffRepository,
    private readonly cache: AvailabilityCacheService,
  ) {}

  /**
   * Le planning d'absences de l'établissement courant, sur la fenêtre demandée.
   *
   * La fenêtre est jugée par la **même** règle qu'une absence : ni vide, ni
   * inversée, ni au-delà d'un an. Ce n'est pas une coquetterie de symétrie — une
   * fenêtre non bornée fait rendre au planning tout l'historique de
   * l'établissement à chaque ouverture, ce qu'aucun écran n'affiche et ce qu'une
   * requête suffit à déclencher.
   */
  public async list(window: TimeOffWindow, staffId?: string): Promise<StaffTimeOffView[]> {
    requirePlausibleRange(window.from, window.to);

    return this.repository.list(window, staffId);
  }

  /**
   * Une absence, par identifiant.
   *
   * Le 404 couvre indistinctement « n'existe nulle part » et « existe dans un
   * autre établissement » — et c'est exactement ce qu'il faut : la différence
   * entre les deux est précisément l'information à ne pas donner.
   */
  public async byId(id: string): Promise<StaffTimeOffView> {
    const found = await this.repository.findById(id);

    if (found === null) {
      throw new NotFoundError('Absence introuvable.');
    }

    return found;
  }

  /**
   * Pose une plage bloquée ou un congé.
   *
   * Rien ne distingue les deux : c'est le même intervalle, et seule sa durée
   * change. Un praticien inconnu — ou d'un autre établissement — sort en 404,
   * levé par le repository sur la violation de clé étrangère composite.
   */
  public async create(input: {
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    reason?: string;
  }): Promise<StaffTimeOffView> {
    requirePlausibleRange(input.startsAt, input.endsAt);

    const created = await this.repository.create({
      staffId: input.staffId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason ?? null,
    });

    await this.cache.invalidateCurrentTenant();

    return created;
  }

  /**
   * Modifie une absence de l'établissement courant.
   *
   * Le corps est un **patch** : un champ absent n'est pas touché, `reason` à
   * `null` est effacé. Les bornes se jugent **fusionnées avec l'état en base** —
   * déplacer la seule fin d'une absence peut la faire passer avant son début, et
   * seul le couple résultant a un sens à valider.
   *
   * La lecture préalable n'est pas un contrôle d'existence redondant avec
   * l'`updateMany` qui suit : c'est elle qui fournit la borne non modifiée. Elle
   * donne au passage le 404 sur l'identifiant d'un autre établissement, sans
   * qu'aucun `if` n'ait à comparer de tenant.
   */
  public async update(
    id: string,
    patch: { startsAt?: Date; endsAt?: Date; reason?: string | null },
  ): Promise<StaffTimeOffView> {
    const current = await this.byId(id);

    requirePlausibleRange(
      patch.startsAt ?? new Date(current.startsAt),
      patch.endsAt ?? new Date(current.endsAt),
    );

    const updated = await this.repository.update(id, patch);

    if (updated === null) {
      // Course : l'absence a été retirée entre la lecture et l'écriture. Le 404
      // reste la bonne réponse — la ressource n'existe plus.
      throw new NotFoundError('Absence introuvable.');
    }

    await this.cache.invalidateCurrentTenant();

    return updated;
  }

  /**
   * Retire une absence — le praticien redevient proposable sur ces créneaux.
   *
   * L'invalidation du cache compte **davantage** ici qu'à la création : un cache
   * périmé qui masque un créneau redevenu libre fait perdre du chiffre
   * d'affaires sans que rien ne le signale (booking-engine §3).
   */
  public async remove(id: string): Promise<void> {
    const removed = await this.repository.deleteById(id);

    if (!removed) {
      throw new NotFoundError('Absence introuvable.');
    }

    await this.cache.invalidateCurrentTenant();
  }

  /**
   * Les intervalles d'occupation des praticiens demandés — la porte du module
   * vers le calcul de créneaux (#34).
   *
   * **Sans motif** : la projection du repository ne le sélectionne pas. C'est ce
   * qui rend « visible du back-office uniquement » une propriété du code et non
   * une consigne — ce qui n'est pas lu ne peut pas fuiter jusqu'à une page
   * publique.
   */
  public async busyRanges(
    staffIds: readonly string[],
    window: TimeOffWindow,
  ): Promise<StaffBusyRange[]> {
    return this.repository.listBusyRanges(staffIds, window);
  }
}

/** Millisecondes dans une journée — la borne de `MAX_TIME_OFF_RANGE_DAYS`. */
const DAY_MS = 86_400_000;

/**
 * Refuse un intervalle vide, inversé, ou déraisonnablement long.
 *
 * Fonction de module et non méthode privée : la règle est la même pour la
 * création et pour la modification, et une fonction pure se teste sans monter le
 * service. Elle est le pendant serveur du `refine` de
 * `createStaffTimeOffRequestSchema` — le contrat partagé la décrit, l'API la
 * fait respecter, et la base la borne une troisième fois
 * (`CHECK ("ends_at" > "starts_at")`).
 */
function requirePlausibleRange(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new InvalidTimeOffRangeError(TIME_OFF_RULES.ENDS_BEFORE_STARTS, startsAt, endsAt);
  }

  if (endsAt.getTime() - startsAt.getTime() > MAX_TIME_OFF_RANGE_DAYS * DAY_MS) {
    throw new InvalidTimeOffRangeError(TIME_OFF_RULES.RANGE_TOO_WIDE, startsAt, endsAt);
  }
}
