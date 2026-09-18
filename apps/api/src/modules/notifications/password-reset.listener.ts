import { createHash } from 'node:crypto';

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { IdentityEvents } from '../identity/events/identity-events';
import type { PasswordResetRequestedEvent } from '../identity/events/password-reset-requested.event';
import { NOTIFICATION_PUBLISHER, type NotificationPublisher } from './notification-publisher';
import { passwordResetDedupeKey, type NotificationMessage } from './notifications.types';

/**
 * Le lien de réinitialisation d'un mot de passe — #809, quatrième critère
 * d'acceptation.
 *
 * ## Le troisième abonné du module, et le premier qui n'écoute pas
 * `appointments`
 *
 * `BookingConfirmationListener` et `CancellationNoticeListener` s'abonnent au
 * bus d'`appointments` ; celui-ci s'abonne à celui d'`identity`. La forme est la
 * même — `onModuleInit` abonne, `onModuleDestroy` se retire, `handle` ne lève
 * jamais — et le sens de dépendance aussi : c'est `notifications` qui dépend des
 * deux autres modules, jamais l'inverse (api-module §3). `IdentityModule` était
 * déjà importé par ce module pour ses gardes ; il exporte désormais son bus.
 *
 * ## Pourquoi un abonné plutôt qu'un appel depuis `AuthService`
 *
 * Parce que la dépendance inverse formerait un cycle que Nest refuse au
 * démarrage — mais surtout parce que c'est ce qui tient le « **toujours 202** »
 * du premier critère. La route répond dès que le jeton est armé en base ; ce qui
 * suit est le métier de ce module. Une panne de SES ne transforme donc pas une
 * demande légitime en erreur affichée à quelqu'un qui n'a déjà plus accès à son
 * compte.
 *
 * ## E-mail seulement, et ce n'est pas `reachableChannels` qui le dit
 *
 * Les trois autres messages demandent au compte sur quels canaux il est
 * joignable. Celui-ci ne le demande pas : le critère fige le canal — « modèle
 * `password_reset`, **canal e-mail** » — et la raison est de fond. Un SMS ne
 * prouve pas la possession de l'**adresse**, or c'est bien une adresse qui a été
 * saisie dans le formulaire, et c'est elle que toute la procédure vérifie.
 * Envoyer aussi par SMS aurait doublé le nombre de canaux par lesquels un lien
 * d'ouverture de compte circule, pour ne rien prouver de plus.
 *
 * C'est aussi pourquoi aucune lecture de `findRecipientContact` n'a lieu ici :
 * la question « cette personne a-t-elle une adresse ? » est déjà tranchée —
 * `users.email` est `NOT NULL`, et c'est sur cette adresse que la demande a été
 * faite.
 *
 * ## La portée de tenant est rouverte explicitement
 *
 * L'émission a lieu dans la requête HTTP qui a demandé la réinitialisation, donc
 * dans une portée déjà ouverte — mais s'y fier serait un pari sur
 * l'implémentation du bus, exactement comme pour les deux autres abonnés. C'est
 * pour cela que `PasswordResetRequestedEvent` porte `tenantId`, et
 * `runWithTenant` le pose ici, une fois.
 *
 * ## Ce que le journal ne dit pas
 *
 * Jamais le jeton. L'identifiant du compte et la clé de déduplication — qui ne
 * porte qu'une **empreinte** du jeton, précisément pour cette raison — et rien
 * d'autre (notifications §7, CDC §5.1).
 */
@Injectable()
export class PasswordResetListener implements OnModuleInit, OnModuleDestroy {
  /**
   * De quoi se retirer du bus à l'arrêt du module.
   *
   * Sans cela, chaque application montée par la suite de tests laisserait son
   * écouteur sur un émetteur qui vit aussi longtemps que son instance.
   */
  private unsubscribe: (() => void) | null = null;

  public constructor(
    private readonly events: IdentityEvents,
    @Inject(NOTIFICATION_PUBLISHER) private readonly publisher: NotificationPublisher,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  public onModuleInit(): void {
    this.unsubscribe = this.events.onPasswordResetRequested((event) => {
      void this.handle(event);
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Traite un `password-reset.requested` : une enveloppe, sur le canal e-mail.
   *
   * Ne lève jamais. Un jeton réellement armé en base ne doit pas être rapporté
   * comme un échec à quelqu'un qui a déjà reçu son 202 — et de toute façon, la
   * garde du bus rattraperait le rejet. Ce `try` est la première barrière, celle
   * du bus est la seconde : un abonné qui se repose sur la garde de son émetteur
   * est un abonné dont on ne sait plus, en le lisant, s'il est sûr.
   *
   * La conséquence est explicite, et c'est la même que pour les confirmations :
   * **une remise qui échoue ne remonte nulle part.** Elle laisse un journal
   * d'erreur et — quand l'expédition a lieu dans le processus, faute de file
   * branchée — une ligne `FAILED` visible au back-office. Le recours de la
   * personne est de redemander un lien, ce que le deuxième critère organise :
   * le nouveau jeton invalide l'ancien.
   */
  public async handle(event: PasswordResetRequestedEvent): Promise<void> {
    try {
      await this.tenants.runWithTenant(event.tenantId, async () => {
        await this.publisher.publish(PasswordResetListener.envelope(event));
      });
    } catch (error: unknown) {
      this.logger.error("lien de réinitialisation non remis à la chaîne d'envoi", {
        userId: event.userId,
        error: error instanceof Error ? error.message : `erreur non standard (${typeof error})`,
      });
    }
  }

  /**
   * L'enveloppe, telle que la chaîne d'envoi l'attend.
   *
   * `appointmentId: null` — ce message n'annonce aucun rendez-vous, et c'est le
   * seul des quatre dans ce cas. `scheduledFor: null` — il est immédiat, le
   * rappel J-1 restant le seul message planifié du MVP.
   *
   * La clé de déduplication porte l'**empreinte** du jeton et non le compte :
   * deux demandes successives sont deux faits distincts, et une clé par compte
   * les aurait confondues — la seconde se serait heurtée à l'index
   * d'idempotence, et la personne n'aurait jamais reçu le seul lien encore
   * valable. Voir `passwordResetDedupeKey`.
   *
   * L'empreinte est recalculée ici plutôt que portée par l'événement : c'est un
   * SHA-256 sur quelques dizaines d'octets, et la faire voyager aurait mis dans
   * l'événement deux représentations du même secret — donc une occasion qu'elles
   * divergent, sur la valeur même qui sert d'identité à la livraison.
   */
  private static envelope(event: PasswordResetRequestedEvent): NotificationMessage {
    const tokenHash = createHash('sha256').update(event.token).digest('hex');

    return {
      tenantId: event.tenantId,
      dedupeKey: passwordResetDedupeKey(tokenHash, 'EMAIL'),
      appointmentId: null,
      recipientUserId: event.userId,
      type: 'PASSWORD_RESET',
      channel: 'EMAIL',
      scheduledFor: null,
      passwordResetToken: event.token,
    };
  }
}
