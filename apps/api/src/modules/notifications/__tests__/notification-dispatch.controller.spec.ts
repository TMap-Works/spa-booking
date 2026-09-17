import { HttpStatus } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { Response } from 'express';

import { getTenantId } from '../../../common/tenant/tenant-context';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  DispatchNotificationDto,
  toNotificationMessage,
} from '../dto/dispatch-notification.dto';
import { NotificationDispatchController } from '../notification-dispatch.controller';
import { NotificationDispatchService } from '../notification-dispatch.service';
import {
  countingSender,
  fakeNotificationsRepository,
  recordingLogger,
  stubRenderer,
} from './notifications.doubles';

/**
 * La route d'envoi interne — sixième critère d'acceptation de #799.
 *
 * ## Ce qu'elle doit prouver, et pourquoi c'est ici
 *
 * Trois choses, et aucune n'est prouvée par les suites voisines :
 *
 * 1. **les codes qu'elle rend.** Ils ne sont pas choisis par ce dépôt : la table
 *    de `infra/terraform/modules/notifications/README.md` les fige, et la Lambda
 *    d'envoi les traduit déjà en décisions de rejeu. Rendre `200` sur un rejeu
 *    ferait compter un `Sent` là où rien n'est parti — et c'est cette métrique
 *    qui dit si la chaîne fonctionne ;
 * 2. **la portée de tenant.** La route est appelée hors de toute session : rien
 *    ne la lui donne, et elle l'ouvre sur `message.tenantId`. C'est le seul
 *    endroit du module où une portée naît d'un corps de requête, donc le seul
 *    endroit où elle peut naître fausse ;
 * 3. **ce que la validation laisse passer.** Un corps refusé sort en `400`, que
 *    la Lambda acquitte en `PermanentFailures` : le message est **perdu**. La
 *    validation doit donc être exactement aussi stricte que le contrat, et pas
 *    davantage — en particulier sur `scheduledFor`, que les deux producteurs
 *    n'écrivent pas de la même façon.
 *
 * La garde, elle, a sa propre suite (`internal-caller.spec.ts`) : elle est la
 * même que pour les deux autres routes internes du module, et le jeton partagé
 * n'a pas à être éprouvé trois fois.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const APPOINTMENT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: '059f36b4-87a3-44ab-83d2-661975830a7d',
    message: {
      tenantId: TENANT,
      dedupeKey: `appointment:${APPOINTMENT}:BOOKING_CONFIRMATION:EMAIL`,
      appointmentId: APPOINTMENT,
      recipientUserId: CLIENT,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      scheduledFor: null,
      ...overrides,
    },
  };
}

/** Une réponse Express réduite à la seule chose que le contrôleur lui écrit. */
function fakeResponse(): { response: Response; statuses: number[] } {
  const statuses: number[] = [];

  return {
    statuses,
    response: {
      status(code: number) {
        statuses.push(code);
        return this;
      },
    } as unknown as Response,
  };
}

function build(behaviour: readonly (string | Error)[] = []) {
  const repository = fakeNotificationsRepository();
  const sender = countingSender(behaviour);
  const logger = recordingLogger();

  const dispatch = new NotificationDispatchService(
    repository.repository,
    stubRenderer().renderer,
    sender.sender,
    logger.logger,
  );

  const controller = new NotificationDispatchController(
    dispatch,
    new TenantContextService(),
    logger.logger,
  );

  return { controller, repository, sender, logger, dispatch };
}

/** Le corps, passé par le pipe global tel que `app.module.ts` le configure. */
async function validated(raw: Record<string, unknown>): Promise<{
  readonly dto: DispatchNotificationDto;
  readonly errors: readonly string[];
}> {
  const dto = plainToInstance(DispatchNotificationDto, raw);
  const failures = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return {
    dto,
    errors: failures.flatMap((failure) => [
      ...Object.values(failure.constraints ?? {}),
      ...(failure.children ?? []).flatMap((child) => Object.values(child.constraints ?? {})),
    ]),
  };
}

describe('notifications — la route interne rend les codes que la Lambda traduit', () => {
  it('rend 200 et `sent` quand le message est parti', async () => {
    const { controller, repository } = build();
    const { response, statuses } = fakeResponse();

    const result = await controller.dispatchMessage(
      (await validated(body())).dto,
      response,
    );

    expect(result).toEqual({ outcome: 'sent' });
    // Aucun statut écrit à la main : `@HttpCode(200)` fait foi.
    expect(statuses).toEqual([]);
    expect(repository.rows.map((row) => row.status)).toEqual(['SENT']);
  });

  it('rend 204 sans corps sur un rejeu', async () => {
    // « 204/409 pour un message sans objet » : la Lambda acquitte et compte
    // `Skipped`. Rendre 200 aurait compté un envoi qui n'a pas eu lieu.
    const { controller } = build();
    const { response, statuses } = fakeResponse();
    const dto = (await validated(body())).dto;

    await controller.dispatchMessage(dto, response);
    const replay = await controller.dispatchMessage(dto, response);

    expect(replay).toBeUndefined();
    expect(statuses).toEqual([HttpStatus.NO_CONTENT]);
  });

  it('rend 204 quand le rappel J-1 n’a plus d’objet', async () => {
    // Un rendez-vous annulé entre la sélection et l'envoi : rien ne part, et
    // rien n'est rejoué. `skipped` n'est pas un échec.
    const { controller, repository } = build();
    const { response, statuses } = fakeResponse();
    repository.reminder = { status: 'CANCELLED', startsAt: new Date(Date.now() + 86_400_000) };

    const result = await controller.dispatchMessage(
      (await validated(body({ type: 'REMINDER_24H' }))).dto,
      response,
    );

    expect(result).toBeUndefined();
    expect(statuses).toEqual([HttpStatus.NO_CONTENT]);
    expect(repository.rows).toHaveLength(0);
  });

  it('laisse remonter le refus de l’expéditeur, qui sort en 5xx', async () => {
    // C'est la ligne qui tient le troisième critère d'acceptation : un
    // expéditeur non configuré lève en 503, donc **transitoire** pour la
    // Lambda. Le message part en DLQ et repart le jour où la passerelle est
    // branchée — ce qu'un faux `SENT` aurait rendu impossible.
    const { controller, repository } = build([new Error('SES indisponible')]);
    const { response } = fakeResponse();

    await expect(
      controller.dispatchMessage((await validated(body())).dto, response),
    ).rejects.toThrow('SES indisponible');
    expect(repository.rows.map((row) => row.status)).toEqual(['FAILED']);
  });
});

describe('notifications — la portée de tenant naît de l’enveloppe', () => {
  it('ouvre la portée sur `message.tenantId`, et sur rien d’autre', async () => {
    // Appelée hors de toute session, la route n'a que l'enveloppe : c'est pour
    // cela que `NotificationMessage.tenantId` existe depuis #71 — « le jour où
    // l'événement viendra d'une file, il n'y aura plus aucune requête ni aucun
    // `AsyncLocalStorage` à hériter ».
    const { controller, dispatch } = build();
    const { response } = fakeResponse();
    const scopes: (string | undefined)[] = [];

    jest.spyOn(dispatch, 'dispatch').mockImplementation(() => {
      scopes.push(getTenantId());
      return Promise.resolve('sent');
    });

    await controller.dispatchMessage(
      (await validated(body({ tenantId: OTHER_TENANT }))).dto,
      response,
    );

    expect(scopes).toEqual([OTHER_TENANT]);
  });

  it('referme la portée en sortant', async () => {
    // Sans quoi la requête suivante servie par la même tâche hériterait de
    // l'établissement de la précédente — la fuite la plus directe qui soit.
    const { controller } = build();
    const { response } = fakeResponse();

    await controller.dispatchMessage((await validated(body())).dto, response);

    expect(getTenantId()).toBeUndefined();
  });
});

describe('notifications — la validation est aussi stricte que le contrat, pas davantage', () => {
  it('accepte une échéance nulle comme une échéance absente', async () => {
    // Les deux formes arrivent réellement : le balayage du rappel J-1 **omet**
    // le champ (`toReminderMessageDto`), là où une enveloppe d'abonné sérialisée
    // par `JSON.stringify` porte `null`. Refuser l'une des deux aurait perdu la
    // moitié des messages en 400.
    const withNull = await validated(body({ scheduledFor: null }));
    const withoutField = await validated(body({ scheduledFor: undefined }));

    expect(withNull.errors).toEqual([]);
    expect(withoutField.errors).toEqual([]);
    expect(toNotificationMessage(withNull.dto.message).scheduledFor).toBeNull();
    expect(toNotificationMessage(withoutField.dto.message).scheduledFor).toBeNull();
  });

  it('convertit l’échéance ISO 8601 en Date', async () => {
    const { dto, errors } = await validated(
      body({ type: 'REMINDER_24H', scheduledFor: '2026-09-08T12:30:00.000Z' }),
    );

    expect(errors).toEqual([]);
    expect(toNotificationMessage(dto.message).scheduledFor).toEqual(
      new Date('2026-09-08T12:30:00.000Z'),
    );
  });

  it('refuse un type ou un canal hors du périmètre MVP', async () => {
    // Élargir ces ensembles revient à élargir le périmètre MVP : cela passe par
    // une issue, pas par une ligne. Les valeurs sont **dérivées** du domaine,
    // jamais recopiées.
    expect((await validated(body({ type: 'MARKETING' }))).errors).toContainEqual(
      expect.stringContaining('message.type'),
    );
    expect((await validated(body({ channel: 'WHATSAPP' }))).errors).toContainEqual(
      expect.stringContaining('message.channel'),
    );
  });

  it('refuse une enveloppe amputée d’un identifiant', async () => {
    expect((await validated(body({ tenantId: undefined }))).errors).toContainEqual(
      expect.stringContaining('message.tenantId'),
    );
    expect((await validated(body({ dedupeKey: '' }))).errors).toContainEqual(
      expect.stringContaining('message.dedupeKey'),
    );
    expect((await validated(body({ recipientUserId: 'pas-un-uuid' }))).errors).toContainEqual(
      expect.stringContaining('message.recipientUserId'),
    );
  });

  it('refuse un champ que le contrat ne déclare pas', async () => {
    // `forbidNonWhitelisted` : sans lui, une coordonnée glissée dans l'enveloppe
    // passerait silencieusement et finirait dans les journaux de la Lambda
    // (CDC §5.1, notifications §7).
    const { errors } = await validated(body({ email: 'cliente@example.test' }));

    expect(errors.length).toBeGreaterThan(0);
  });
});
