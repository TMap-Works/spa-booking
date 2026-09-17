import {
  NOTIFICATION_QUEUE_URL_ENV,
  NotificationsConfig,
  SES_FROM_EMAIL_ENV,
  SMS_SENDER_ID_MAX_LENGTH,
  SNS_SMS_SENDER_ID_ENV,
  resolveQueueSettings,
  resolveSesSettings,
  resolveSnsSettings,
} from '../notifications.config';

/**
 * Les trois réglages des passerelles AWS — quatrième critère d'acceptation de
 * #799 : « lus par `NotificationsConfig`, validés au premier usage et non au
 * démarrage de l'API, et n'apparaissent dans aucun message d'erreur ni aucun
 * journal ».
 *
 * Les trois affirmations se vérifient séparément, et la deuxième est celle qui
 * ne va pas de soi : elle porte sur ce qui **ne** se passe **pas** au
 * constructeur.
 */

const QUEUE = 'https://sqs.eu-west-3.amazonaws.com/123456789012/spa-dev-notifications';

describe('notifications — la configuration SES', () => {
  it('rend null quand la variable est absente ou vide', () => {
    // `''` est ce qu'ECS produit pour une variable déclarée sans valeur : c'est
    // « pas posée », pas « mal posée ».
    expect(resolveSesSettings({})).toBeNull();
    expect(resolveSesSettings({ [SES_FROM_EMAIL_ENV]: '' })).toBeNull();
    expect(resolveSesSettings({ [SES_FROM_EMAIL_ENV]: '   ' })).toBeNull();
  });

  it('rend l’adresse et la région', () => {
    expect(
      resolveSesSettings({
        [SES_FROM_EMAIL_ENV]: '  reservations@mail.exemple.test ',
        AWS_REGION: 'eu-west-3',
      }),
    ).toEqual({ fromEmail: 'reservations@mail.exemple.test', region: 'eu-west-3' });
  });

  it('laisse la région nulle quand l’environnement ne la pose pas', () => {
    // Sur un poste local, un profil AWS la fournit au SDK. Un `region: undefined`
    // explicite l'empêcherait au contraire de la déduire.
    expect(resolveSesSettings({ [SES_FROM_EMAIL_ENV]: 'a@b.test' })?.region).toBeNull();
  });

  it('refuse une valeur qui n’est pas une adresse, sans la citer', () => {
    // Le contrôle arrête ce que personne n'a renseigné — un nom de variable
    // recopié, un gabarit non substitué. Le message nomme la variable, jamais sa
    // valeur : une adresse désigne quelqu'un, et un message d'erreur est
    // journalisé (notifications §7).
    expect(() => resolveSesSettings({ [SES_FROM_EMAIL_ENV]: '${SES_FROM_EMAIL}' })).toThrow(
      /SES_FROM_EMAIL/,
    );
    expect(() => resolveSesSettings({ [SES_FROM_EMAIL_ENV]: 'pas-une-adresse' })).toThrow(
      /adresse/,
    );

    try {
      resolveSesSettings({ [SES_FROM_EMAIL_ENV]: 'secret@interne.test' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret@interne.test');
    }
  });
});

describe('notifications — la configuration SNS', () => {
  it('rend null quand la variable est absente ou vide', () => {
    expect(resolveSnsSettings({})).toBeNull();
    expect(resolveSnsSettings({ [SNS_SMS_SENDER_ID_ENV]: '' })).toBeNull();
  });

  it('rend le sender ID et la région', () => {
    expect(
      resolveSnsSettings({ [SNS_SMS_SENDER_ID_ENV]: 'SpaSalon', AWS_REGION: 'eu-west-3' }),
    ).toEqual({ senderId: 'SpaSalon', region: 'eu-west-3' });
  });

  it('refuse un expéditeur purement numérique', () => {
    // Les opérateurs y voient une usurpation de numéro court et le remplacent —
    // ou refusent le message (notifications §5). Le refus a lieu au seul moment
    // où quelqu'un peut corriger : la configuration.
    expect(() => resolveSnsSettings({ [SNS_SMS_SENDER_ID_ENV]: '12345' })).toThrow(/une lettre/);
  });

  it('refuse un expéditeur trop long ou non alphanumérique', () => {
    expect(() =>
      resolveSnsSettings({ [SNS_SMS_SENDER_ID_ENV]: 'A'.repeat(SMS_SENDER_ID_MAX_LENGTH + 1) }),
    ).toThrow(/SNS_SMS_SENDER_ID/);
    expect(() => resolveSnsSettings({ [SNS_SMS_SENDER_ID_ENV]: 'Spa Salon' })).toThrow(
      /alphanumériques/,
    );
  });
});

describe('notifications — la configuration de la file', () => {
  it('rend null quand la variable est absente ou vide', () => {
    // C'est le mode de marche local : les abonnés du bus expédient alors dans le
    // processus, et le journal d'envois reste peuplé.
    expect(resolveQueueSettings({})).toBeNull();
    expect(resolveQueueSettings({ [NOTIFICATION_QUEUE_URL_ENV]: '' })).toBeNull();
  });

  it('rend l’URL de la file et la région', () => {
    expect(
      resolveQueueSettings({ [NOTIFICATION_QUEUE_URL_ENV]: QUEUE, AWS_REGION: 'eu-west-3' }),
    ).toEqual({ queueUrl: QUEUE, region: 'eu-west-3' });
  });

  it('refuse une URL qui n’est pas celle d’une file, sans la citer', () => {
    // L'URL porte l'identifiant du compte AWS : le message nomme la variable et
    // la forme attendue, jamais ce qui a été reçu.
    expect(() => resolveQueueSettings({ [NOTIFICATION_QUEUE_URL_ENV]: 'https://exemple.test' })).toThrow(
      /NOTIFICATION_QUEUE_URL/,
    );

    try {
      resolveQueueSettings({ [NOTIFICATION_QUEUE_URL_ENV]: 'http://compte-123456789012' });
    } catch (error) {
      expect((error as Error).message).not.toContain('123456789012');
    }
  });

  it('lit le nom que pose la définition de tâche ECS, au singulier', () => {
    // Le témoin de la divergence corrigée en revue. `infra/terraform/envs/*/main.tf`
    // compose `notification_queue_env` sur `NOTIFICATION_QUEUE_URL` — et la
    // sortie `dispatch_queue_url` du module le dit mot pour mot. `.env.example`
    // écrivait `NOTIFICATIONS_QUEUE_URL` au pluriel : sans conséquence tant
    // qu'aucune ligne ne la lisait, mais du jour où le publieur la lit, tout
    // déploiement serait retombé sur l'expédition en processus **sans qu'aucun
    // journal ne le dise**. Cette assertion est ce qui empêche la divergence de
    // revenir.
    expect(NOTIFICATION_QUEUE_URL_ENV).toBe('NOTIFICATION_QUEUE_URL');
    expect(resolveQueueSettings({ NOTIFICATION_QUEUE_URL: QUEUE })?.queueUrl).toBe(QUEUE);
  });

  it('ignore l’ancienne orthographe au pluriel', () => {
    // Un nom, un réglage. Accepter les deux aurait laissé vivre la divergence
    // dont la panne muette est née.
    expect(resolveQueueSettings({ NOTIFICATIONS_QUEUE_URL: QUEUE })).toBeNull();
  });
});

describe('notifications — les trois réglages sont lus au premier usage', () => {
  it('ne lit rien au constructeur, fût-ce une valeur invalide', () => {
    // C'est l'affirmation du quatrième critère, et elle porte sur ce qui **ne**
    // se passe **pas** : `AppModule` monte les huit modules métier, donc toutes
    // les suites d'intégration du dépôt. Une adresse mal formée ne doit pas
    // faire échouer l'amorçage de suites qui ne parlent que de créneaux.
    const config = new NotificationsConfig({
      [SES_FROM_EMAIL_ENV]: 'pas-une-adresse',
      [SNS_SMS_SENDER_ID_ENV]: '12345',
    });

    expect(config).toBeInstanceOf(NotificationsConfig);
    expect(() => config.sesSettings).toThrow(/SES_FROM_EMAIL/);
    expect(() => config.snsSettings).toThrow(/SNS_SMS_SENDER_ID/);
  });

  it('lève la même chose au second usage qu’au premier', () => {
    // L'échec est mémoïsé comme l'est le succès : sans cela, le second envoi
    // trouverait un cache vide, relirait l'environnement, et la panne changerait
    // de forme entre deux messages.
    const config = new NotificationsConfig({ [SES_FROM_EMAIL_ENV]: 'pas-une-adresse' });

    const first = captureMessage(() => config.sesSettings);
    const second = captureMessage(() => config.sesSettings);

    expect(first).toBe(second);
  });

  it('ne lit l’environnement qu’une fois par réglage', () => {
    // Une configuration résolue à chaque envoi coûterait une lecture et une
    // validation par message, sur un chemin déjà chargé.
    let reads = 0;
    const source = new Proxy<NodeJS.ProcessEnv>(
      { [SES_FROM_EMAIL_ENV]: 'reservations@mail.exemple.test' },
      {
        get(target, property: string) {
          if (property === SES_FROM_EMAIL_ENV) {
            reads += 1;
          }
          return target[property];
        },
      },
    );

    const config = new NotificationsConfig(source);

    expect(reads).toBe(0);
    expect(config.sesSettings).not.toBeNull();
    expect(config.sesSettings).not.toBeNull();
    expect(reads).toBe(1);
  });

  it('rend les trois réglages d’un environnement complet', () => {
    const config = new NotificationsConfig({
      [SES_FROM_EMAIL_ENV]: 'reservations@mail.exemple.test',
      [SNS_SMS_SENDER_ID_ENV]: 'SpaSalon',
      [NOTIFICATION_QUEUE_URL_ENV]: QUEUE,
    });

    expect(config.sesSettings?.fromEmail).toBe('reservations@mail.exemple.test');
    expect(config.snsSettings?.senderId).toBe('SpaSalon');
    expect(config.queueSettings?.queueUrl).toBe(QUEUE);
  });
});

/** Le message de l'erreur levée, ou `null` si rien n'a levé. */
function captureMessage(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
