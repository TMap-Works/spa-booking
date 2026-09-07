import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { DeliveryEventRepository } from './delivery-event.repository';
import { classifyDeliveryEvent } from './delivery-event';
import type { DeliveryEventIngestion } from './notifications.types';

/**
 * L'ingestion des événements de remise SES — le traitement de #73.
 *
 * ```
 * SES ──► topic spa-{env}-ses-events ──► SQS ──► Lambda ──► POST /notifications/delivery-events
 *  (Bounce, Complaint,                                                    │
 *   Reject, Rendering Failure)                                    ce service : classement
 *                                                                         │
 *                                                       users.email_suppressed_at ◄─┘
 * ```
 *
 * ## Deux temps, et une seule décision
 *
 * 1. **Classer** — `classifyDeliveryEvent`, une fonction pure, sans base ni
 *    horloge. C'est elle qui répond à « cet événement condamne-t-il l'adresse ? »,
 *    et elle seule ; les trois issues qu'elle rend sont la distinction
 *    permanent / transitoire que le ticket demande.
 * 2. **Inscrire** — et seulement pour l'issue `suppress`. Un rebond transitoire
 *    n'écrit rien : priver une cliente de ses confirmations parce que sa boîte a
 *    été pleine deux jours coûterait plus cher que le rebond lui-même.
 *
 * ## Pourquoi le traitement vit dans l'API et non dans la Lambda
 *
 * Même raison que pour le balayage du rappel J-1 : il a besoin du schéma, du
 * client Prisma scopé et de la frontière de tenant. La réécrire en JavaScript
 * dans une fonction Lambda donnerait deux implémentations de la même règle, dans
 * deux exécutables, avec un seul jeu de tests — c'est-à-dire une divergence
 * garantie. La Lambda est le **transport**, elle n'est pas le traitement.
 *
 * ## Ce qui n'est jamais journalisé
 *
 * Les adresses. Ni en clair, ni tronquées, ni condensées : notifications §7
 * l'interdit, et une adresse dans un journal de Lambda y reste aussi longtemps
 * que la rétention du groupe. Ce qui part au journal, ce sont des **compteurs**
 * et le `messageId` de SES — un accusé opaque, non personnel, et la seule
 * référence par laquelle une livraison se retrouve chez AWS.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne touche à aucune ligne de `notifications`. Un rebond arrive **après**
 * l'envoi : la ligne est déjà `SENT`, et la repasser en `FAILED` réécrirait
 * l'histoire — le message *est* parti, c'est sa remise qui a échoué. Le schéma
 * ne connaît pas de statut `SUPPRESSED` sur cette table, et lui en ajouter un
 * ferait dire à l'idempotence des envois une chose qu'elle ne dit pas.
 *
 * Il ne parle pas non plus à SQS ni à SNS : l'API n'embarque pas le SDK AWS et
 * n'a pas à l'embarquer (notifications §1).
 */
@Injectable()
export class DeliveryEventService {
  public constructor(
    private readonly repository: DeliveryEventRepository,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Classe l'événement et, s'il condamne l'adresse, la supprime partout où elle
   * est connue.
   *
   * `now` est un paramètre et non `new Date()` pris au vol : c'est la convention
   * du dépôt pour tout ce qui date une écriture, et c'est ce qui rend l'instant
   * de suppression observable en test sans horloge simulée.
   *
   * Ne lève jamais sur une charge utile illisible. Un événement qu'on ne sait
   * pas lire ne se répare pas en le rejouant : lever ferait rejouer le message
   * jusqu'à la file d'attente morte, et l'alarme de profondeur signalerait une
   * panne là où il n'y a qu'un message inattendu. Le refus se lit dans
   * `outcome: 'unreadable'`, que la Lambda journalise et acquitte.
   */
  public async ingest(payload: unknown, now: Date = new Date()): Promise<DeliveryEventIngestion> {
    const verdict = classifyDeliveryEvent(payload);

    if (verdict.outcome === 'unreadable') {
      this.logger.warn('événement de remise illisible', { reason: verdict.reason });

      return {
        outcome: 'unreadable',
        eventType: null,
        detail: null,
        messageId: null,
        reason: null,
        recipientCount: 0,
        tenantCount: 0,
        suppressed: 0,
      };
    }

    if (verdict.outcome !== 'suppress') {
      // `transient` et `ignored` ont le même effet en base — aucun — et sont
      // pourtant journalisés distinctement : un pic de rebonds transitoires est
      // un incident de délivrabilité, un `Rendering Failure` est un bogue de
      // modèle chez nous. Les confondre rendrait la métrique de l'un illisible
      // sous le volume de l'autre.
      this.logger.log('événement de remise sans effet sur les adresses', {
        outcome: verdict.outcome,
        eventType: verdict.eventType,
        detail: verdict.detail,
        messageId: verdict.messageId,
      });

      return {
        outcome: verdict.outcome,
        eventType: verdict.eventType,
        detail: verdict.detail,
        messageId: verdict.messageId,
        reason: null,
        recipientCount: 0,
        tenantCount: 0,
        suppressed: 0,
      };
    }

    const tenantIds = await this.repository.listTenantIds();
    let suppressed = 0;

    for (const tenantId of tenantIds) {
      // Une portée par établissement : l'écriture passe par le client scopé,
      // exactement comme dans une requête HTTP. L'ingestion est inter-tenant, ses
      // écritures ne le sont pas — c'est ce qui rend impossible de supprimer par
      // mégarde l'adresse d'un salon en croyant traiter celle d'un autre.
      suppressed += await this.tenants.runWithTenant(tenantId, () =>
        this.repository.suppressEmails(verdict.recipients, verdict.reason, now),
      );
    }

    // Des compteurs et un accusé opaque — jamais une adresse (notifications §7).
    // `suppressed: 0` n'est pas une anomalie : l'adresse rebondie peut n'être
    // connue d'aucun salon (une saisie corrigée depuis), ou avoir déjà été
    // supprimée par une livraison précédente que SQS rejoue.
    this.logger.log('adresses supprimées après événement de remise', {
      eventType: verdict.eventType,
      reason: verdict.reason,
      detail: verdict.detail,
      messageId: verdict.messageId,
      recipientCount: verdict.recipients.length,
      tenantCount: tenantIds.length,
      suppressed,
    });

    return {
      outcome: 'suppress',
      eventType: verdict.eventType,
      detail: verdict.detail,
      messageId: verdict.messageId,
      reason: verdict.reason,
      recipientCount: verdict.recipients.length,
      tenantCount: tenantIds.length,
      suppressed,
    };
  }
}
