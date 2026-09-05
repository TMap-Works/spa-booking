import { Injectable } from '@nestjs/common';

import { BusinessRuleError, NotFoundError } from '../../common/errors';
import type { TenantDto, UpdateTenantDto } from './dto/tenant-settings.dto';
import {
  IdentityRepository,
  type OpeningHourRecord,
  type TenantRecord,
  type TenantSettingsChanges,
} from './identity.repository';
import { toOpeningHours, toPostalAddress } from './public-tenant.service';
import { wallClockToMinutesOrNull } from './opening-hours';

/**
 * Le paramétrage de l'établissement, tel que le back-office l'exerce (#343).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2). Comme
 * `PublicTenantService`, il n'a **aucun paramètre d'établissement** : le tenant
 * arrive par le contexte de requête, résolu depuis le jeton vérifié. Il n'existe
 * pas de signature par laquelle un appelant pourrait en désigner un autre — ce
 * qui est la seule garantie qui tienne, un contrôle par argument se contournant
 * dès le deuxième site d'appel.
 */
@Injectable()
export class TenantSettingsService {
  public constructor(private readonly repository: IdentityRepository) {}

  /** Les réglages courants de l'établissement de la requête. */
  public async currentTenant(): Promise<TenantDto> {
    return TenantSettingsService.toTenant(await this.read());
  }

  /**
   * Applique une modification partielle, puis rend l'état résultant.
   *
   * **Une seule écriture**, colonnes et horaires ensemble (#416). Deux appels
   * successifs laissaient le premier commité quand le second échouait :
   * l'adresse enregistrée, la semaine non, et aucune réponse rendue. Le service
   * n'a aucun moyen de rattraper cela depuis ici — annuler demanderait de
   * réécrire l'état d'avant, donc de le relire et d'espérer que personne
   * n'écrive entre-temps. C'est le dépôt qui tient l'atomicité, dans une
   * transaction ; ce qui se décide ici est de ne lui faire qu'une demande.
   *
   * Les horaires sont **convertis et contrôlés avant** cette écriture.
   * `toOpeningHourRecords` refuse une plage inversée ou deux plages qui se
   * recouvrent, et le DTO ne porte ni l'une ni l'autre de ces règles — elles
   * demandent de lire deux champs ensemble, ou l'ensemble de la semaine. Les
   * contrôler après l'écriture aurait rendu un 422 sur une requête qui a
   * **déjà** posé le nom et l'adresse de la même charge utile : l'écran annonce
   * un refus, et la moitié de la saisie est passée quand même.
   *
   * La lecture préalable n'est pas une vérification d'autorisation — le scoping
   * s'en charge — mais une distinction de codes : sans elle, un établissement
   * supprimé entre la résolution du jeton et l'écriture produirait un 200 sur
   * une mise à jour qui n'a touché aucune ligne.
   */
  public async update(changes: UpdateTenantDto): Promise<TenantDto> {
    await this.read();

    const openingHours =
      changes.openingHours === undefined
        ? undefined
        : TenantSettingsService.toOpeningHourRecords(changes.openingHours);

    // Propriété **omise** et non posée à `undefined` : sous
    // `exactOptionalPropertyTypes`, les deux ne sont pas la même chose, et
    // c'est l'absence qui signifie « ne touche pas à la semaine ».
    const applied = await this.repository.updateTenantSettings({
      changes: TenantSettingsService.toSettingsChanges(changes),
      ...(openingHours === undefined ? {} : { openingHours }),
    });

    if (!applied) {
      throw new NotFoundError('Établissement introuvable.');
    }

    return TenantSettingsService.toTenant(await this.read());
  }

  private async read(): Promise<TenantRecord> {
    const tenant = await this.repository.findCurrentTenant();

    if (tenant === null) {
      throw new NotFoundError('Établissement introuvable.');
    }
    return tenant;
  }

  /**
   * Recopie champ par champ, plutôt qu'un `{ ...tenant }`.
   *
   * L'étalement rendrait ce que le repository a lu — donc, le jour où quelqu'un
   * ajoute un champ à la projection sans penser à la réponse, un champ interne
   * de plus dans une réponse d'API. Ici, publier demande d'écrire une ligne.
   */
  private static toTenant(tenant: TenantRecord): TenantDto {
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
      ...(address === undefined ? {} : { address }),
      ...(openingHours === undefined ? {} : { openingHours }),
      isActive: tenant.isActive,
    };
  }

  /**
   * Traduit la charge utile en colonnes, en préservant la distinction qui
   * compte : **absent** ne touche à rien, `null` efface.
   *
   * L'adresse est le seul champ composé, et le seul dont l'absence et le `null`
   * ne se traduisent pas de la même façon : `null` retire les cinq colonnes
   * d'un coup, un objet les pose toutes les cinq — `line2` et `postalCode`
   * compris, remis à `null` s'ils ne sont pas fournis. C'est ce qui rend
   * impossible l'adresse à moitié réécrite : on ne peut pas garder l'ancien
   * complément d'adresse sous une nouvelle rue.
   */
  private static toSettingsChanges(changes: UpdateTenantDto): TenantSettingsChanges {
    const address = changes.address;

    return {
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.timezone === undefined ? {} : { timezone: changes.timezone }),
      ...(changes.defaultCurrency === undefined
        ? {}
        : { defaultCurrency: changes.defaultCurrency }),
      ...(changes.contactEmail === undefined ? {} : { contactEmail: changes.contactEmail }),
      ...(changes.contactPhone === undefined ? {} : { contactPhone: changes.contactPhone }),
      ...(address === undefined
        ? {}
        : address === null
          ? {
              addressLine1: null,
              addressLine2: null,
              postalCode: null,
              city: null,
              countryCode: null,
            }
          : {
              addressLine1: address.line1,
              addressLine2: address.line2 ?? null,
              postalCode: address.postalCode ?? null,
              city: address.city,
              countryCode: address.country,
            }),
    };
  }

  /**
   * Convertit les heures murales en minutes locales, et **refuse les plages
   * incohérentes avant la base**.
   *
   * Deux règles que le DTO ne peut pas porter : une fermeture antérieure à
   * l'ouverture se voit sur la plage seule mais demande de lire ses deux champs
   * ensemble, et le recouvrement porte sur l'ensemble de la semaine. Les deux
   * sont tenues en base — `tenant_opening_hours_minutes_check` et
   * `tenant_opening_hours_no_overlap` —, et c'est la base qui reste la garantie.
   * Ce contrôle-ci est le **message** : sans lui, une saisie fautive remonterait
   * en violation de contrainte brute, donc en 500, là où le contrat annonce 422.
   */
  private static toOpeningHourRecords(
    entries: readonly { weekday: number; opensAt: string; closesAt: string }[],
  ): OpeningHourRecord[] {
    const records = entries.map((entry) => {
      const startMinute = wallClockToMinutesOrNull(entry.opensAt);
      const endMinute = wallClockToMinutesOrNull(entry.closesAt);

      // Le format est déjà refusé en 400 par le DTO : y arriver serait un défaut
      // de programmation, pas une saisie. On le dit plutôt que de convertir un
      // `null` en `0`, ce qui poserait une plage muette à minuit.
      if (startMinute === null || endMinute === null) {
        throw new BusinessRuleError('Heure d’ouverture illisible.');
      }
      if (endMinute <= startMinute) {
        throw new BusinessRuleError(
          'La fermeture doit être strictement postérieure à l’ouverture.',
        );
      }

      return { weekday: entry.weekday, startMinute, endMinute };
    });

    if (TenantSettingsService.overlap(records)) {
      throw new BusinessRuleError('Deux plages d’ouverture du même jour se recouvrent.');
    }

    return records;
  }

  /**
   * `true` si deux plages du **même jour** se recouvrent, borne haute exclue.
   *
   * Adjacence tolérée (`end === start`) : « 09:00–12:00 » et « 12:00–19:00 »
   * décrivent une journée continue en deux morceaux, pas un double emploi.
   */
  private static overlap(records: readonly OpeningHourRecord[]): boolean {
    const byWeekday = new Map<number, OpeningHourRecord[]>();

    for (const record of records) {
      const sameDay = byWeekday.get(record.weekday) ?? [];

      if (
        sameDay.some(
          (other) => record.startMinute < other.endMinute && other.startMinute < record.endMinute,
        )
      ) {
        return true;
      }

      sameDay.push(record);
      byWeekday.set(record.weekday, sameDay);
    }

    return false;
  }
}
