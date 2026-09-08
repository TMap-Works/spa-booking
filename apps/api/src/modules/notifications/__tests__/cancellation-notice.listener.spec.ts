import { getTenantId } from '../../../common/tenant/tenant-context';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  APPOINTMENT_CANCELLED,
  type AppointmentCancelledEvent,
} from '../../appointments/events/appointment-cancelled.event';
import { AppointmentEvents } from '../../appointments/events/appointment-events';
import { CancellationNoticeListener } from '../cancellation-notice.listener';
import { NotificationDispatchService } from '../notification-dispatch.service';
import {
  countingSender,
  fakeNotificationsRepository,
  recordingLogger,
  stubRenderer,
} from './notifications.doubles';

/**
 * L'avis d'annulation, déclenché par l'événement de domaine — les quatre
 * critères d'acceptation de #72.
 *
 * ## Pourquoi le vrai bus et le vrai service d'expédition
 *
 * Même raison que pour la confirmation (#70) : ce qui est en jeu est un
 * **branchement**. L'écouteur est-il posé sur `appointment.cancelled` et non sur
 * `appointment.created` ? La portée de tenant est-elle ouverte ? L'échec
 * reste-t-il confiné ? Doubler `AppointmentEvents` aurait testé le double.
 *
 * Le dépôt doublé rejoue les **deux uniques** de la table, dont
 * `notifications_live_once` : c'est ce qui rend significatif le comptage des
 * lignes, et c'est aussi ce qui rendrait rouge une conduite qui prétendrait
 * écrire deux avis vivants sur le même canal pour un même rendez-vous.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const STAFF = '44444444-4444-4444-8444-444444444444';
const STAFF_USER = '66666666-6666-4666-8666-666666666666';

function event(overrides: Partial<AppointmentCancelledEvent> = {}): AppointmentCancelledEvent {
  return {
    name: APPOINTMENT_CANCELLED,
    tenantId: TENANT,
    appointmentId: APPOINTMENT,
    clientId: CLIENT,
    serviceId: '55555555-5555-4555-8555-555555555555',
    staffId: STAFF,
    startsAt: '2026-09-08T12:30:00.000Z',
    endsAt: '2026-09-08T13:30:00.000Z',
    previousStatus: 'CONFIRMED',
    cancelledBy: 'STAFF',
    cancelledAt: '2026-09-06T09:00:00.000Z',
    occurredAt: '2026-09-06T09:00:00.000Z',
    ...overrides,
  };
}

function build(behaviour: readonly (string | Error)[] = []) {
  const repository = fakeNotificationsRepository();
  repository.staffUserId = STAFF_USER;

  const renderer = stubRenderer();
  const sender = countingSender(behaviour);
  const logger = recordingLogger();
  const events = new AppointmentEvents(logger.logger);
  const tenants = new TenantContextService();

  const dispatch = new NotificationDispatchService(
    repository.repository,
    renderer.renderer,
    sender.sender,
    logger.logger,
  );

  const listener = new CancellationNoticeListener(
    events,
    dispatch,
    repository.repository,
    tenants,
    logger.logger,
  );

  listener.onModuleInit();

  return { listener, events, repository, renderer, sender, logger, dispatch };
}

describe('notifications — l’avis d’annulation naît de l’événement de domaine', () => {
  it('s’abonne à `appointment.cancelled` et expédie sans qu’on l’appelle', async () => {
    // Premier critère d'acceptation : « déclenché par l'événement
    // appointment.cancelled ». Rien n'appelle le listener ici — le bus le fait.
    const { events, sender } = build();

    events.appointmentCancelled({
      tenantId: TENANT,
      appointmentId: APPOINTMENT,
      clientId: CLIENT,
      serviceId: '55555555-5555-4555-8555-555555555555',
      staffId: STAFF,
      startsAt: '2026-09-08T12:30:00.000Z',
      endsAt: '2026-09-08T13:30:00.000Z',
      previousStatus: 'CONFIRMED',
      cancelledBy: 'STAFF',
      cancelledAt: '2026-09-06T09:00:00.000Z',
    });

    // L'écouteur est asynchrone : `emit` rend la main avant qu'il n'ait fini.
    await new Promise((resolve) => setImmediate(resolve));

    // Deux destinataires, deux canaux chacun — quatre envois.
    expect(sender.calls.map((call) => call.type)).toEqual([
      'CANCELLATION',
      'CANCELLATION',
      'CANCELLATION',
      'CANCELLATION',
    ]);
  });

  it('ne réagit pas à une création de rendez-vous', async () => {
    // Le branchement est sur le bon événement, et pas sur le bus en général.
    const { events, sender } = build();

    events.appointmentCreated({
      tenantId: TENANT,
      appointmentId: APPOINTMENT,
      clientId: CLIENT,
      staffId: STAFF,
      serviceId: '55555555-5555-4555-8555-555555555555',
      startsAt: '2026-09-08T12:30:00.000Z',
      endsAt: '2026-09-08T13:30:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sender.calls).toHaveLength(0);
  });

  it('se retire du bus à l’arrêt du module', async () => {
    const { listener, events, sender } = build();

    listener.onModuleDestroy();
    events.appointmentCancelled({
      tenantId: TENANT,
      appointmentId: APPOINTMENT,
      clientId: CLIENT,
      serviceId: '55555555-5555-4555-8555-555555555555',
      staffId: STAFF,
      startsAt: '2026-09-08T12:30:00.000Z',
      endsAt: '2026-09-08T13:30:00.000Z',
      previousStatus: 'CONFIRMED',
      cancelledBy: 'STAFF',
      cancelledAt: '2026-09-06T09:00:00.000Z',
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

    // Une lecture par destinataire, toutes dans la portée de l'événement.
    expect(seen).toEqual([TENANT, TENANT]);
  });
});

describe('notifications — qui reçoit l’avis d’annulation', () => {
  it('prévient la cliente **et** le praticien quand le salon annule', async () => {
    // Le cœur de #534, et le deuxième critère de #72 enfin tenu en entier :
    // « envoyé au client **et** au praticien concerné ». Une annulation posée au
    // comptoir par l'accueil ou la gérance change l'agenda du praticien, et rien
    // dans l'événement ne dit que c'est lui qui l'a posée.
    const { listener, sender } = build();

    await listener.handle(event({ cancelledBy: 'STAFF' }));

    expect(new Set(sender.calls.map((call) => call.recipientUserId))).toEqual(
      new Set([CLIENT, STAFF_USER]),
    );
  });

  it('écrit deux lignes vivantes par canal, une par destinataire', async () => {
    // Ce que l'ancien index interdisait : `notifications_live_once` portait sur
    // `(tenant_id, appointment_id, type, channel)`, et le second avis était
    // refusé en silence. Le double rejoue la **nouvelle** définition, qui porte
    // le destinataire.
    const { listener, repository } = build();

    await listener.handle(event({ cancelledBy: 'STAFF' }));

    expect(
      repository.rows.map((row) => `${row.channel}:${String(row.recipientUserId)}`),
    ).toEqual([
      `EMAIL:${CLIENT}`,
      `SMS:${CLIENT}`,
      `EMAIL:${STAFF_USER}`,
      `SMS:${STAFF_USER}`,
    ]);
  });

  it('prévient les deux quand l’annulation vient du système', async () => {
    // `SYSTEM` n'est émis par aucune surface aujourd'hui, mais il est dans
    // `CANCELLATION_AUTHORS` : personne n'a décidé d'aucun côté du comptoir.
    const { listener, sender } = build();

    await listener.handle(event({ cancelledBy: 'SYSTEM' }));

    expect(new Set(sender.calls.map((call) => call.recipientUserId))).toEqual(
      new Set([CLIENT, STAFF_USER]),
    );
  });

  it('n’écrit qu’un avis quand le praticien **est** la cliente', async () => {
    // Une praticienne réserve pour elle-même, et le salon annule : les deux
    // publics du CDC désignent un seul compte. Lui écrire deux fois la même
    // chose n'aurait servi personne — et le nouvel index ne l'aurait pas
    // interdit, puisque le destinataire est le même.
    const { listener, repository, sender } = build();
    repository.staffUserId = CLIENT;

    await listener.handle(event({ cancelledBy: 'STAFF' }));

    expect(sender.calls.map((call) => call.channel)).toEqual(['EMAIL', 'SMS']);
    expect(new Set(sender.calls.map((call) => call.recipientUserId))).toEqual(new Set([CLIENT]));
  });

  it('prévient la cliente même quand le praticien est introuvable', async () => {
    // Un public perdu n'en emporte pas deux : la ligne `staff` a disparu, la
    // cliente doit tout de même apprendre que son rendez-vous n'a plus lieu.
    const { listener, repository, sender, logger } = build();
    repository.staffUserId = null;

    await listener.handle(event({ cancelledBy: 'STAFF' }));

    expect(new Set(sender.calls.map((call) => call.recipientUserId))).toEqual(new Set([CLIENT]));
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('prévient la cliente même quand la lecture du praticien échoue', async () => {
    // La lecture du praticien est passée **devant** la cliente avec #534 : avant
    // lui, une annulation `STAFF` n'interrogeait pas la table `staff` du tout.
    // Une panne de base sur cette lecture-là ne doit donc pas emporter l'avis de
    // la cliente — le bus est en mémoire, rien ne rejouera l'événement, et elle
    // se déplacerait pour un rendez-vous qui n'a plus lieu.
    const { listener, repository, sender, logger } = build();
    repository.staffLookupError = new Error('connexion perdue');

    await listener.handle(event({ cancelledBy: 'STAFF' }));

    expect(new Set(sender.calls.map((call) => call.recipientUserId))).toEqual(new Set([CLIENT]));
    expect(logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('prévient le praticien quand la cliente annule elle-même', async () => {
    // Quatrième critère : « aucun avis envoyé si l'annulation vient du client
    // lui-même sur son propre rendez-vous, **hors notification au staff** ».
    const { listener, sender } = build();

    await listener.handle(event({ cancelledBy: 'CLIENT' }));

    expect(new Set(sender.calls.map((call) => call.recipientUserId))).toEqual(
      new Set([STAFF_USER]),
    );
  });

  it('ne prévient jamais la cliente de sa propre annulation', async () => {
    const { listener, sender } = build();

    await listener.handle(event({ cancelledBy: 'CLIENT' }));

    expect(sender.calls.some((call) => call.recipientUserId === CLIENT)).toBe(false);
  });

  it('n’envoie rien quand la praticienne annule son propre rendez-vous', async () => {
    // Elle a réservé pour elle-même et se décommande depuis son espace client :
    // le seul destinataire possible serait l'auteur de l'annulation.
    const { listener, repository, sender } = build();
    repository.staffUserId = CLIENT;

    await listener.handle(event({ cancelledBy: 'CLIENT' }));

    expect(sender.calls).toHaveLength(0);
  });

  it('journalise, sans rien envoyer, un praticien introuvable', async () => {
    // Sa ligne `staff` a disparu, ou appartient à un autre salon — le client
    // scopé traite les deux de la même façon. La cliente ayant annulé, c'était
    // le seul destinataire possible.
    const { listener, repository, sender, logger } = build();
    repository.staffUserId = null;

    await listener.handle(event({ cancelledBy: 'CLIENT' }));

    expect(sender.calls).toHaveLength(0);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});

describe('notifications — les canaux de l’avis d’annulation', () => {
  it('envoie e-mail **et** SMS quand le compte porte un numéro', async () => {
    // Deux destinataires, deux canaux chacun, et l'e-mail d'abord : c'est lui
    // qui porte le récapitulatif.
    const { listener, sender } = build();

    await listener.handle(event());

    expect(sender.calls.map((call) => `${call.channel}:${call.recipientUserId}`)).toEqual([
      `EMAIL:${CLIENT}`,
      `SMS:${CLIENT}`,
      `EMAIL:${STAFF_USER}`,
      `SMS:${STAFF_USER}`,
    ]);
  });

  it('n’envoie que l’e-mail quand aucun numéro n’est exploitable', async () => {
    const { listener, repository, sender } = build();
    repository.contact = { hasEmail: true, hasSms: false };

    await listener.handle(event());

    expect(sender.calls.map((call) => call.channel)).toEqual(['EMAIL', 'EMAIL']);
  });

  it('compose une clé de livraison par canal **et** par destinataire', async () => {
    // Le destinataire est dans la clé parce que l'avis d'annulation est le seul
    // message dont il dépende d'une donnée du rendez-vous : sans lui, l'avis au
    // praticien serait pris pour un rejeu de l'avis à la cliente — et acquitté
    // auprès de SQS sans être parti.
    const { listener, repository } = build();

    await listener.handle(event());

    expect(repository.rows.map((row) => row.dedupeKey)).toEqual([
      `appointment:${APPOINTMENT}:CANCELLATION:EMAIL:${CLIENT}`,
      `appointment:${APPOINTMENT}:CANCELLATION:SMS:${CLIENT}`,
      `appointment:${APPOINTMENT}:CANCELLATION:EMAIL:${STAFF_USER}`,
      `appointment:${APPOINTMENT}:CANCELLATION:SMS:${STAFF_USER}`,
    ]);
  });

  it('rejoué, le même événement n’en produit toujours qu’un par destinataire', async () => {
    // Une republication — reprise de file, redémarrage — ne doit pas doubler
    // l'avis. C'est `notifications_live_once` qui l'arrête, et le listener n'a
    // rien à vérifier lui-même. Ajouter un destinataire n'a donc rien coûté à
    // l'idempotence : l'index l'a suivi.
    const { listener, sender, repository } = build();

    await listener.handle(event());
    await listener.handle(event());

    expect(sender.calls).toHaveLength(4);
    expect(repository.rows).toHaveLength(4);
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
    // Une annulation réellement écrite en base ne doit pas être rapportée comme
    // un échec parce qu'un e-mail n'est pas parti : la cliente croirait son
    // rendez-vous maintenu.
    const { listener } = build([new Error('SES indisponible'), new Error('SNS indisponible')]);

    await expect(listener.handle(event())).resolves.toBeUndefined();
  });

  it('laisse une trace `FAILED` en base pour chaque canal en échec', async () => {
    // Les deux premiers envois échouent — ceux de la cliente ; ceux du praticien
    // partent quand même.
    const { listener, repository } = build([
      new Error('SES indisponible'),
      new Error('SNS indisponible'),
    ]);

    await listener.handle(event());

    expect(repository.rows.map((row) => row.status)).toEqual([
      'FAILED',
      'FAILED',
      'SENT',
      'SENT',
    ]);
  });

  it('un canal en échec n’empêche ni le suivant ni l’autre destinataire de partir', async () => {
    const { listener, repository, sender } = build([new Error('SES indisponible')]);

    await listener.handle(event());

    expect(sender.calls.map((call) => call.channel)).toEqual(['EMAIL', 'SMS', 'EMAIL', 'SMS']);
    expect(repository.rows.map((row) => row.status)).toEqual([
      'FAILED',
      'SENT',
      'SENT',
      'SENT',
    ]);
  });

  it('ne journalise ni coordonnée, ni contenu, ni motif d’annulation', async () => {
    // notifications §7 et CDC §5.1 : le journal garde des identifiants. Le motif
    // n'est même pas dans l'événement — `appointment-cancelled.event.ts`
    // explique pourquoi — et rien ici ne va le chercher.
    const { listener, logger } = build([new Error('SES indisponible')]);

    await listener.handle(event());

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('corps');
    expect(serialized).not.toContain('reason');
  });
});
