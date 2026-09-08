import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ReminderSweepRepository } from './reminder-sweep.repository';
import { REMINDER_LEAD_MS, reminderWindow } from './reminder-window';
import {
  appointmentDedupeKey,
  reachableChannels,
  type DueReminder,
  type NotificationMessage,
} from './notifications.types';

/**
 * Nombre maximal de rendez-vous retenus par balayage, tous établissements
 * confondus.
 *
 * Une heure de rendez-vous sur l'ensemble de la plateforme ; 500 est très
 * au-delà de ce que le MVP produira, et c'est le propos — ce plafond n'est pas
 * un dimensionnement, c'est un garde-fou. Sans lui, une fenêtre anormalement
 * peuplée — un import de planning, une erreur de saisie de dates — ferait
 * composer une réponse HTTP de plusieurs mégaoctets et publier autant de
 * messages d'un coup.
 *
 * Le dépassement n'est pas silencieux : `truncated` le dit dans la réponse, la
 * Lambda le journalise en `error` et publie la métrique `SweepTruncated`, que
 * l'alarme `…-reminder-sweep-truncated` regarde. Ce n'est **pas** l'alarme
 * d'erreurs de la fonction qui le verrait : un balayage tronqué réussit, et
 * `AWS/Lambda Errors` ne compte pas une ligne de journal. Un plafond qu'on
 * atteint sans le savoir serait pire qu'aucun plafond.
 */
export const REMINDER_SWEEP_MAX_APPOINTMENTS = 500;

/** Ce qu'un balayage a produit. */
export interface ReminderSweepResult {
  /** L'instant de référence du balayage, en UTC — la fenêtre en découle. */
  readonly sweptAt: Date;
  /** Borne basse **incluse** de la fenêtre de sélection. */
  readonly from: Date;
  /** Borne haute **exclue** de la fenêtre de sélection. */
  readonly to: Date;
  /** Nombre d'établissements visités. */
  readonly tenantCount: number;
  /** Nombre de rendez-vous retenus. */
  readonly appointmentCount: number;
  /** Les enveloppes à publier — une par canal joignable. */
  readonly messages: readonly NotificationMessage[];
  /** Vrai si le plafond a arrêté le balayage avant la fin. */
  readonly truncated: boolean;
}

/**
 * Le balayage horaire du rappel J-1 — le **producteur** de #71.
 *
 * ```
 * EventBridge Scheduler ──► Lambda reminder-sweeper ──► POST /notifications/reminders/sweep
 *      (toutes les heures)            │                             │
 *                                     │                    ce service : sélection
 *                                     │                             │
 *                                     ◄───────── enveloppes ────────┘
 *                                     │
 *                                     └──► SQS ──► Lambda d'envoi ──► API ──► SES/SNS
 * ```
 *
 * ## Ce qu'il produit, et ce qu'il ne fait pas
 *
 * Il **désigne** des messages ; il n'en envoie aucun. Aucune ligne de
 * `notifications` n'est écrite ici : la prise de droit appartient à
 * `NotificationDispatchService.claim()`, à l'autre bout de la file, et c'est ce
 * qui rend l'idempotence indifférente au nombre de balayages. Un balayage rejoué
 * republie les mêmes enveloppes — mêmes `dedupeKey`, puisqu'elles sont
 * déterministes — et le second lot est ignoré à l'envoi.
 *
 * Il ne parle pas non plus à SQS. L'API n'embarque pas le SDK AWS et n'a pas à
 * l'embarquer : publier est du transport, et le transport est le métier de la
 * Lambda qui l'appelle — la même division du travail que pour la Lambda d'envoi
 * de #67, dont le fichier dit « elle est le transport, elle n'est pas
 * l'expéditeur ».
 *
 * ## Pourquoi la sélection vit dans l'API et non dans la Lambda
 *
 * Parce qu'elle a besoin du schéma, du client Prisma scopé et de la définition
 * de « rendez-vous vivant ». La réécrire en JavaScript dans une fonction Lambda
 * donnerait deux implémentations de la même règle, dans deux exécutables, avec
 * un seul jeu de tests — c'est-à-dire une divergence garantie.
 */
@Injectable()
export class ReminderSweepService {
  public constructor(
    private readonly repository: ReminderSweepRepository,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Sélectionne les rappels dus et compose leurs enveloppes.
   *
   * `now` est un paramètre et non `new Date()` pris au vol : c'est ce qui rend
   * la fenêtre observable en test sans horloge simulée, et c'est la convention
   * du reste du dépôt pour tout calcul de temps.
   */
  public async sweep(
    now: Date = new Date(),
    maxAppointments: number = REMINDER_SWEEP_MAX_APPOINTMENTS,
  ): Promise<ReminderSweepResult> {
    const window = reminderWindow(now);
    const tenantIds = await this.repository.listTenantIds();

    const due: DueReminder[] = [];
    let remaining = maxAppointments;
    let truncated = false;

    for (const [index, tenantId] of tenantIds.entries()) {
      // **Une ligne de plus que le budget.** C'est elle, et elle seule, qui
      // distingue « ce salon remplit exactement le budget » de « il en restait
      // après » : une page de la taille exacte du budget ne dit rien de ce qui
      // se trouve derrière, et le supposer tronqué ferait sonner l'alarme
      // `SweepTruncated` sur un balayage complet. La ligne excédentaire n'est
      // jamais retenue.
      const probe = remaining + 1;

      // Une portée par établissement : la lecture des rendez-vous passe par le
      // client scopé, exactement comme dans une requête HTTP. Le balayage est
      // inter-tenant, ses lectures ne le sont pas.
      const rows = await this.tenants.runWithTenant(tenantId, () =>
        this.repository.findDueAppointments(window, probe),
      );

      const retained = rows.length > remaining ? rows.slice(0, remaining) : rows;

      for (const row of retained) {
        due.push({ tenantId, ...row });
      }

      if (rows.length > remaining) {
        // Ce salon avait davantage de rendez-vous dus que le budget ne pouvait
        // en porter : le balayage est incomplet, et le taire ferait disparaître
        // des rappels sans laisser de trace.
        truncated = true;
        break;
      }

      remaining -= rows.length;

      if (remaining === 0) {
        // Le budget est exactement consommé. Ce qui reste à savoir est s'il
        // reste des salons à visiter : avec un budget nul, les visiter ne
        // rendrait plus rien, et l'on ne peut donc pas trancher autrement qu'en
        // se déclarant incomplet dès qu'il en reste un.
        truncated = index < tenantIds.length - 1;
        break;
      }
    }

    const messages = due.flatMap((reminder) => this.envelopes(reminder));

    this.logger.log('balayage des rappels J-1', {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      tenantCount: tenantIds.length,
      appointmentCount: due.length,
      messageCount: messages.length,
      truncated,
    });

    return {
      sweptAt: now,
      from: window.from,
      to: window.to,
      tenantCount: tenantIds.length,
      appointmentCount: due.length,
      messages,
      truncated,
    };
  }

  /**
   * Une enveloppe par canal joignable — la même règle de canaux que la
   * confirmation.
   *
   * La règle est celle de `reachableChannels` : l'e-mail dès qu'il y a une
   * adresse, le SMS dès que le numéro est composable au sens E.164
   * (`isDialableNumber`). `marketing_consent` n'entre pas dans la décision : un
   * rappel de rendez-vous relève de l'exécution du contrat, pas de la
   * prospection (CDC §5.1, notifications §7).
   *
   * `scheduledFor` porte l'instant **voulu** de l'envoi — le début du rendez-vous
   * moins 24 heures —, et non l'instant de publication. C'est ce que la colonne
   * `notifications.scheduled_for` documente (« le rappel J-1 est planifié, pas
   * immédiat ») et c'est la seule valeur qui rende le journal du back-office
   * lisible : elle dit à quelle échéance ce rappel répondait. La publication,
   * elle, est immédiate, si bien qu'un rappel part entre 24 et 25 heures avant le
   * rendez-vous — la largeur de la fenêtre de balayage, et rien de plus.
   */
  private envelopes(reminder: DueReminder): readonly NotificationMessage[] {
    const channels = reachableChannels(reminder);

    if (channels.length === 0) {
      // Structurellement improbable — `users.email` est `NOT NULL` — mais le
      // dire vaut mieux que de sortir en silence : c'est le seul chemin par
      // lequel un rendez-vous dû ne produirait aucun rappel ni aucune trace.
      this.logger.warn('rappel J-1 sans canal joignable', {
        appointmentId: reminder.appointmentId,
      });
      return [];
    }

    // Ce qu'un rappel vivant couvre déjà ne se republie pas — canal par canal,
    // jamais rendez-vous par rendez-vous. Un balayage rejoué après une
    // publication partielle retrouve ainsi le canal qui manque, là où une
    // exclusion au rendez-vous l'aurait perdu pour de bon.
    const pending = channels.filter((channel) => !reminder.liveChannels.includes(channel));

    if (pending.length === 0) {
      return [];
    }

    const scheduledFor = new Date(reminder.startsAt.getTime() - REMINDER_LEAD_MS);

    return pending.map((channel) => ({
      tenantId: reminder.tenantId,
      dedupeKey: appointmentDedupeKey(reminder.appointmentId, 'REMINDER_24H', channel),
      appointmentId: reminder.appointmentId,
      recipientUserId: reminder.clientId,
      type: 'REMINDER_24H' as const,
      channel,
      scheduledFor,
    }));
  }
}
