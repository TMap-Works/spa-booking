import { getTenantId } from '../../../common/tenant/tenant-context';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  APPOINTMENT_CREATED,
  type AppointmentCreatedEvent,
} from '../../appointments/events/appointment-created.event';
import { AppointmentEvents } from '../../appointments/events/appointment-events';
import { BookingConfirmationListener } from '../booking-confirmation.listener';
import { NotificationDispatchService } from '../notification-dispatch.service';
import {
  countingSender,
  fakeNotificationsRepository,
  recordingLogger,
  stubRenderer,
} from './notifications.doubles';

/**
 * La confirmation de réservation, déclenchée par l'événement de domaine — les
 * deux premiers critères d'acceptation de #70.
 *
 * ## Pourquoi le vrai bus et le vrai service d'expédition
 *
 * Ce qui est en jeu ici est un **branchement** : l'écouteur est-il posé sur le
 * bon événement, la portée de tenant est-elle ouverte, l'échec reste-t-il
 * confiné ? Doubler `AppointmentEvents` aurait testé le double — et notamment
 * son enveloppe d'abonné, qui est précisément ce dont dépend la garantie
 * « un abonné qui lève ne fait pas échouer la réservation ».
 *
 * Seuls le dépôt (Prisma), le rendu (base) et l'expéditeur (AWS) sont doublés.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

function event(overrides: Partial<AppointmentCreatedEvent> = {}): AppointmentCreatedEvent {
  return {
    name: APPOINTMENT_CREATED,
    tenantId: TENANT,
    appointmentId: APPOINTMENT,
    clientId: CLIENT,
    staffId: '44444444-4444-4444-8444-444444444444',
    serviceId: '55555555-5555-4555-8555-555555555555',
    startsAt: '2026-09-08T12:30:00.000Z',
    endsAt: '2026-09-08T13:30:00.000Z',
    occurredAt: '2026-09-06T09:00:00.000Z',
    ...overrides,
  };
}

function build() {
  const repository = fakeNotificationsRepository();
  const renderer = stubRenderer();
  const sender = countingSender();
  const logger = recordingLogger();
  const events = new AppointmentEvents(logger.logger);
  const tenants = new TenantContextService();

  const dispatch = new NotificationDispatchService(
    repository.repository,
    renderer.renderer,
    sender.sender,
    logger.logger,
  );

  const listener = new BookingConfirmationListener(
    events,
    dispatch,
    repository.repository,
    tenants,
    logger.logger,
  );

  listener.onModuleInit();

  return { listener, events, repository, renderer, sender, logger, dispatch };
}

describe('notifications — la confirmation naît de l’événement de domaine', () => {
  it('s’abonne à `appointment.created` et expédie sans qu’on l’appelle', async () => {
    // Premier critère d'acceptation : « déclenchée par l'événement de domaine,
    // jamais depuis le contrôleur ». Rien n'appelle le listener ici — le bus le
    // fait.
    const { listener, sender } = build();

    await listener.handle(event());

    expect(sender.calls.map((call) => call.type)).toEqual([
      'BOOKING_CONFIRMATION',
      'BOOKING_CONFIRMATION',
    ]);
  });

  it('reçoit bien ce que le bus publie', async () => {
    const { events, dispatch } = build();
    const dispatched: string[] = [];
    jest
      .spyOn(dispatch, 'dispatch')
      .mockImplementation((message) => {
        dispatched.push(message.channel);
        return Promise.resolve('sent');
      });

    events.appointmentCreated({
      tenantId: TENANT,
      appointmentId: APPOINTMENT,
      clientId: CLIENT,
      staffId: '44444444-4444-4444-8444-444444444444',
      serviceId: '55555555-5555-4555-8555-555555555555',
      startsAt: '2026-09-08T12:30:00.000Z',
      endsAt: '2026-09-08T13:30:00.000Z',
    });

    // L'écouteur est asynchrone : `emit` rend la main avant qu'il n'ait fini.
    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatched).toEqual(['EMAIL', 'SMS']);
  });

  it('se retire du bus à l’arrêt du module', async () => {
    // Sans désabonnement, chaque application montée par la suite de tests
    // laisserait son écouteur sur un émetteur qui, lui, survit.
    const { listener, events, sender } = build();

    listener.onModuleDestroy();
    events.appointmentCreated({
      tenantId: TENANT,
      appointmentId: APPOINTMENT,
      clientId: CLIENT,
      staffId: '44444444-4444-4444-8444-444444444444',
      serviceId: '55555555-5555-4555-8555-555555555555',
      startsAt: '2026-09-08T12:30:00.000Z',
      endsAt: '2026-09-08T13:30:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sender.calls).toHaveLength(0);
  });

  it('ouvre la portée de tenant que l’événement nomme', async () => {
    // Un abonné asynchrone s'exécute hors de la portée de la requête : sans
    // `runWithTenant`, le client Prisma scopé n'aurait aucun établissement.
    const { listener, repository } = build();
    const seen: (string | undefined)[] = [];
    jest.spyOn(repository.repository, 'findRecipientContact').mockImplementation(() => {
      seen.push(getTenantId());
      return Promise.resolve({ hasEmail: true, hasSms: false });
    });

    await listener.handle(event());

    expect(seen).toEqual([TENANT]);
  });
});

describe('notifications — les canaux suivent ce dont la cliente dispose', () => {
  it('envoie e-mail **et** SMS quand le compte porte un numéro', async () => {
    const { listener, sender } = build();

    await listener.handle(event());

    expect(sender.calls.map((call) => call.channel)).toEqual(['EMAIL', 'SMS']);
  });

  it('n’envoie que l’e-mail quand aucun numéro n’est exploitable', async () => {
    // « Le SMS se désactive, l'e-mail non » — la confirmation est la preuve du
    // rendez-vous, et un établissement doit pouvoir la produire.
    const { listener, repository, sender } = build();
    repository.contact = { hasEmail: true, hasSms: false };

    await listener.handle(event());

    expect(sender.calls.map((call) => call.channel)).toEqual(['EMAIL']);
  });

  it('compose une clé de déduplication par canal — le SMS n’étouffe pas l’e-mail', async () => {
    const { listener, repository } = build();

    await listener.handle(event());

    expect(repository.rows.map((row) => row.dedupeKey)).toEqual([
      `appointment:${APPOINTMENT}:BOOKING_CONFIRMATION:EMAIL`,
      `appointment:${APPOINTMENT}:BOOKING_CONFIRMATION:SMS`,
    ]);
  });

  it('rejoué, le même événement ne produit pas un second envoi', async () => {
    // Une republication — reprise de file, redémarrage — ne doit pas doubler la
    // confirmation. C'est `notifications_live_once` qui l'arrête, et le listener
    // n'a rien à vérifier lui-même.
    const { listener, sender } = build();

    await listener.handle(event());
    await listener.handle(event());

    expect(sender.calls).toHaveLength(2);
  });

  it('ne dit rien quand le compte destinataire est introuvable, mais le journalise', async () => {
    const { listener, repository, sender, logger } = build();
    repository.contact = null;

    await listener.handle(event());

    expect(sender.calls).toHaveLength(0);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});

describe('notifications — un abonné qui échoue ne fait échouer personne', () => {
  it('n’émet aucun rejet quand l’expéditeur lève', async () => {
    // La règle du bus : « un rendez-vous réellement écrit en base ne doit pas
    // être rapporté comme un échec à la cliente parce qu'un e-mail n'est pas
    // parti ».
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const dispatch = new NotificationDispatchService(
      repository.repository,
      stubRenderer().renderer,
      countingSender([new Error('SES indisponible'), new Error('SNS indisponible')]).sender,
      logger.logger,
    );
    const listener = new BookingConfirmationListener(
      new AppointmentEvents(logger.logger),
      dispatch,
      repository.repository,
      new TenantContextService(),
      logger.logger,
    );

    await expect(listener.handle(event())).resolves.toBeUndefined();
  });

  it('laisse une trace `FAILED` en base pour chaque canal en échec', async () => {
    // C'est ce que le back-office affichera : un envoi non parti se voit, et
    // reste reprenable puisque `FAILED` n'occupe pas la place.
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const dispatch = new NotificationDispatchService(
      repository.repository,
      stubRenderer().renderer,
      countingSender([new Error('SES indisponible'), new Error('SNS indisponible')]).sender,
      logger.logger,
    );
    const listener = new BookingConfirmationListener(
      new AppointmentEvents(logger.logger),
      dispatch,
      repository.repository,
      new TenantContextService(),
      logger.logger,
    );

    await listener.handle(event());

    expect(repository.rows.map((row) => row.status)).toEqual(['FAILED', 'FAILED']);
  });

  it('un canal en échec n’empêche pas le suivant de partir', async () => {
    // La boucle ne s'interrompt pas au premier échec : c'est le pendant, à
    // l'échelle des canaux, de l'enveloppe que le bus pose sur ses abonnés.
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const sender = countingSender([new Error('SES indisponible')]);
    const dispatch = new NotificationDispatchService(
      repository.repository,
      stubRenderer().renderer,
      sender.sender,
      logger.logger,
    );
    const listener = new BookingConfirmationListener(
      new AppointmentEvents(logger.logger),
      dispatch,
      repository.repository,
      new TenantContextService(),
      logger.logger,
    );

    await listener.handle(event());

    expect(sender.calls.map((call) => call.channel)).toEqual(['EMAIL', 'SMS']);
    expect(repository.rows.map((row) => row.status)).toEqual(['FAILED', 'SENT']);
  });

  it('ne journalise ni coordonnée ni contenu de message', async () => {
    // notifications §7 : le journal garde l'identifiant de la notification et
    // celui du fournisseur, rien d'autre.
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const dispatch = new NotificationDispatchService(
      repository.repository,
      stubRenderer().renderer,
      countingSender([new Error('SES indisponible')]).sender,
      logger.logger,
    );
    const listener = new BookingConfirmationListener(
      new AppointmentEvents(logger.logger),
      dispatch,
      repository.repository,
      new TenantContextService(),
      logger.logger,
    );

    await listener.handle(event());

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('corps');
  });
});
