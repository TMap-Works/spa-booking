import { AwsNotificationSender } from '../aws-notification.sender';
import { NotificationsConfig } from '../notifications.config';
import type { NotificationSendRequest } from '../notification-sender';
import type { EmailGateway, EmailToSend } from '../ses-email.gateway';
import type { SmsGateway, SmsToSend } from '../sns-sms.gateway';
import { fakeNotificationsRepository, recordingLogger, RENDERED } from './notifications.doubles';

/**
 * Les passerelles SES et SNS derrière `NOTIFICATION_SENDER` — les critères 1, 2,
 * 3 et 5 de #799.
 *
 * ## Aucun test n'envoie de vrai message
 *
 * notifications §8 le pose en une phrase, et c'est un critère d'acceptation à
 * lui seul : « en test, SES et SNS sont bouchonnés ». La substitution est
 * **structurelle** et non disciplinée — `AwsNotificationSender` reçoit ses deux
 * fabriques de passerelles en paramètres, et cette suite en passe qui
 * enregistrent au lieu d'appeler AWS. Aucun client du SDK n'est construit, donc
 * aucune chaîne d'identifiants n'est résolue et aucune socket n'est ouverte.
 *
 * C'est aussi la raison pour laquelle les passerelles sont des interfaces d'une
 * méthode : un double qui implémente `send` reproduit *tout* ce que la vraie
 * sait faire, là où un faux `SESv2Client` reproduirait ce qu'on a pensé à
 * reproduire.
 *
 * ## Ce que chaque groupe de cas établit
 *
 * 1. le canal décide de la passerelle, et de rien d'autre ;
 * 2. la coordonnée est **relue** sur le compte, jamais portée par la demande ;
 * 3. sans configuration, le refus est le même qu'avant #799 — 503, et par canal ;
 * 4. un numéro non normalisable est un échec **permanent** (422) ;
 * 5. rien de ce qui est lu n'atteint le journal.
 */

const NOTIFICATION = '66666666-6666-4666-8666-666666666666';
const APPOINTMENT = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

/** Une passerelle e-mail qui enregistre au lieu d'écrire. */
function recordingEmailGateway(messageId = 'ses-1'): {
  readonly gateway: EmailGateway;
  readonly calls: EmailToSend[];
} {
  const calls: EmailToSend[] = [];

  return {
    calls,
    gateway: {
      send(email: EmailToSend): Promise<string> {
        calls.push(email);
        return Promise.resolve(messageId);
      },
    },
  };
}

/** Une passerelle SMS qui enregistre au lieu d'émettre. */
function recordingSmsGateway(messageId = 'sns-1'): {
  readonly gateway: SmsGateway;
  readonly calls: SmsToSend[];
} {
  const calls: SmsToSend[] = [];

  return {
    calls,
    gateway: {
      send(sms: SmsToSend): Promise<string> {
        calls.push(sms);
        return Promise.resolve(messageId);
      },
    },
  };
}

function request(overrides: Partial<NotificationSendRequest> = {}): NotificationSendRequest {
  return {
    notificationId: NOTIFICATION,
    type: 'BOOKING_CONFIRMATION',
    channel: 'EMAIL',
    recipientUserId: CLIENT,
    appointmentId: APPOINTMENT,
    content: RENDERED,
    ...overrides,
  };
}

/** L'environnement d'un déploiement où les deux canaux sont branchés. */
const CONFIGURED: NodeJS.ProcessEnv = {
  SES_FROM_EMAIL: 'reservations@mail.exemple.test',
  SNS_SMS_SENDER_ID: 'SpaSalon',
  AWS_REGION: 'eu-west-3',
};

function build(env: NodeJS.ProcessEnv = CONFIGURED) {
  const repository = fakeNotificationsRepository();
  const logger = recordingLogger();
  const email = recordingEmailGateway();
  const sms = recordingSmsGateway();

  const sender = new AwsNotificationSender(
    new NotificationsConfig(env),
    repository.repository,
    logger.logger,
    () => email.gateway,
    () => sms.gateway,
  );

  return { sender, repository, logger, email, sms };
}

describe('notifications — le canal décide de la passerelle', () => {
  it('écrit par SES sur le canal e-mail, et rend son MessageId', async () => {
    const { sender, email, sms } = build();

    const receipt = await sender.send(request({ channel: 'EMAIL' }));

    expect(receipt).toEqual({ providerMessageId: 'ses-1' });
    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toEqual([
      {
        to: 'cliente@example.test',
        subject: RENDERED.subject,
        html: RENDERED.html,
        text: RENDERED.text,
      },
    ]);
  });

  it('émet par SNS sur le canal SMS, avec le seul corps texte', async () => {
    // Un SMS n'a ni objet ni HTML : `content.text` est à la fois la version
    // texte de l'e-mail et le corps du message court.
    const { sender, email, sms } = build();

    const receipt = await sender.send(request({ channel: 'SMS' }));

    expect(receipt).toEqual({ providerMessageId: 'sns-1' });
    expect(email.calls).toHaveLength(0);
    expect(sms.calls).toEqual([{ to: '+261341234567', text: RENDERED.text }]);
  });

  it('ne construit la passerelle qu’une fois, quel que soit le nombre d’envois', async () => {
    // Un client AWS tient une chaîne de résolution d'identifiants et un pool de
    // connexions : en fabriquer un par message ferait payer une résolution de
    // rôle de tâche à chaque e-mail.
    const repository = fakeNotificationsRepository();
    const email = recordingEmailGateway();
    let built = 0;

    const sender = new AwsNotificationSender(
      new NotificationsConfig(CONFIGURED),
      repository.repository,
      recordingLogger().logger,
      () => {
        built += 1;
        return email.gateway;
      },
      () => recordingSmsGateway().gateway,
    );

    await sender.send(request());
    await sender.send(request());

    expect(built).toBe(1);
    expect(email.calls).toHaveLength(2);
  });
});

describe('notifications — la coordonnée est relue, jamais transportée', () => {
  it('lit l’adresse sur le compte désigné, et non sur la demande', async () => {
    // Deuxième critère d'acceptation : « l'adresse et le numéro sont **relus**
    // sur `recipientUserId` au moment d'envoyer, jamais recopiés dans le
    // message » (notifications §7). La demande ne porte aucune coordonnée — le
    // type ne lui en offre pas le champ — et c'est le dépôt qui répond.
    const { sender, repository, email } = build();
    repository.address = { email: 'nouvelle@example.test', phone: null };

    await sender.send(request({ channel: 'EMAIL' }));

    expect(email.calls[0]?.to).toBe('nouvelle@example.test');
  });

  it('relit à chaque tentative — un rejeu part sur l’adresse corrigée', async () => {
    // Un message de file survit à sa file : une cliente qui corrige son adresse
    // entre la publication et le rejeu doit recevoir sur la nouvelle.
    const { sender, repository, email } = build();

    await sender.send(request());
    repository.address = { email: 'corrigee@example.test', phone: null };
    await sender.send(request());

    expect(email.calls.map((call) => call.to)).toEqual([
      'cliente@example.test',
      'corrigee@example.test',
    ]);
  });

  it('normalise le numéro avant de le composer', async () => {
    // `normalizeToE164` vient du contrat partagé : la règle est écrite une fois,
    // pour la saisie comme pour l'envoi. `00261…` et les séparateurs entrent,
    // et SNS reçoit la seule forme qu'il accepte.
    const { sender, repository, sms } = build();
    repository.address = { email: 'cliente@example.test', phone: '00261 34 12 345 67' };

    await sender.send(request({ channel: 'SMS' }));

    expect(sms.calls[0]?.to).toBe('+261341234567');
  });
});

describe('notifications — le défaut reste fermé, canal par canal', () => {
  it('refuse l’e-mail en 503 sans SES_FROM_EMAIL', async () => {
    // Troisième critère d'acceptation : « sans configuration SES/SNS, le
    // comportement actuel est conservé : refus en 503, ligne `FAILED`, message
    // reprenable — jamais un `SENT` silencieux ». 503 est **transitoire** pour
    // la Lambda : le message part en DLQ et repart le jour où SES est branché.
    const { sender } = build({ SNS_SMS_SENDER_ID: 'SpaSalon' });

    await expect(sender.send(request({ channel: 'EMAIL' }))).rejects.toMatchObject({
      status: 503,
      code: 'NOTIFICATION_SENDER_NOT_CONFIGURED',
    });
  });

  it('refuse le SMS en 503 sans SNS_SMS_SENDER_ID', async () => {
    const { sender } = build({ SES_FROM_EMAIL: 'reservations@mail.exemple.test' });

    await expect(sender.send(request({ channel: 'SMS' }))).rejects.toMatchObject({
      status: 503,
      code: 'NOTIFICATION_SENDER_NOT_CONFIGURED',
    });
  });

  it('laisse partir l’e-mail quand seul le SMS manque', async () => {
    // Le refus est par canal et non global : un environnement où l'e-mail part
    // et le SMS pas est l'état normal d'une mise en service — SES se vérifie par
    // DNS, SNS demande un plafond de dépense et un sender ID enregistré.
    const { sender, email } = build({ SES_FROM_EMAIL: 'reservations@mail.exemple.test' });

    await expect(sender.send(request({ channel: 'EMAIL' }))).resolves.toEqual({
      providerMessageId: 'ses-1',
    });
    expect(email.calls).toHaveLength(1);
  });

  it('ne construit aucune passerelle tant que rien n’est envoyé', () => {
    // Quatrième critère d'acceptation : la configuration est lue au **premier
    // usage**, pas au démarrage. Une API qui n'enverra jamais rien ne construit
    // aucun client AWS et ne lit aucune de ces variables.
    let built = 0;

    const sender = new AwsNotificationSender(
      new NotificationsConfig(CONFIGURED),
      fakeNotificationsRepository().repository,
      recordingLogger().logger,
      () => {
        built += 1;
        return recordingEmailGateway().gateway;
      },
    );

    expect(sender).toBeInstanceOf(AwsNotificationSender);
    expect(built).toBe(0);
  });
});

describe('notifications — un destinataire injoignable est un échec permanent', () => {
  it('refuse en 422 un numéro non normalisable', async () => {
    // Cinquième critère d'acceptation : « un numéro non normalisable est un
    // échec **permanent**, pas un rejeu ». 422 est acquitté par la Lambda et
    // compté dans `PermanentFailures` — cinq tentatives n'apprendraient pas à
    // SNS de quel pays compléter un numéro national.
    const { sender, repository, sms } = build();
    repository.address = { email: 'cliente@example.test', phone: '0341234567' };

    await expect(sender.send(request({ channel: 'SMS' }))).rejects.toMatchObject({
      status: 422,
    });
    expect(sms.calls).toHaveLength(0);
  });

  it('refuse en 422 un compte disparu', async () => {
    // Anonymisation RGPD, ou compte d'un autre établissement : le client scopé
    // traite les deux de la même façon, et il n'y a personne à qui écrire.
    const { sender, repository, email } = build();
    repository.address = null;

    await expect(sender.send(request({ channel: 'EMAIL' }))).rejects.toMatchObject({
      status: 422,
    });
    expect(email.calls).toHaveLength(0);
  });

  it('refuse en 422 un destinataire absent de la demande', async () => {
    // La colonne `recipient_user_id` est nullable et la ligne relue peut l'avoir
    // perdu. Sans compte à consulter, il n'y a pas d'adresse à trouver.
    const { sender, email } = build();

    await expect(
      sender.send(request({ channel: 'EMAIL', recipientUserId: null })),
    ).rejects.toMatchObject({ status: 422 });
    expect(email.calls).toHaveLength(0);
  });

  it('refuse en 422 une adresse vide', async () => {
    const { sender, repository, email } = build();
    repository.address = { email: '   ', phone: null };

    await expect(sender.send(request({ channel: 'EMAIL' }))).rejects.toMatchObject({
      status: 422,
    });
    expect(email.calls).toHaveLength(0);
  });
});

describe('notifications — rien de ce qui est lu n’atteint le journal', () => {
  it('ne journalise ni numéro, ni adresse, ni contenu sur un refus de numéro', async () => {
    // notifications §7 : le journal garde l'identifiant de la notification et
    // celui du fournisseur, jamais une coordonnée — c'est précisément celle
    // qu'on serait tenté d'y mettre pour diagnostiquer, et c'est celle qui
    // désigne une personne.
    const { sender, repository, logger } = build();
    repository.address = { email: 'cliente@example.test', phone: '0341234567' };

    await expect(sender.send(request({ channel: 'SMS' }))).rejects.toBeDefined();

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).not.toContain('0341234567');
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain(RENDERED.text);
  });

  it('ne fait figurer aucune coordonnée dans le détail de l’erreur', async () => {
    // Un `details` d'erreur est journalisé — et il traverse la réponse HTTP de
    // la route interne, donc les journaux de la Lambda.
    const { sender, repository } = build();
    repository.address = { email: 'cliente@example.test', phone: '0341234567' };

    await expect(sender.send(request({ channel: 'SMS' }))).rejects.toMatchObject({
      details: { channel: 'SMS' },
    });
  });
});
