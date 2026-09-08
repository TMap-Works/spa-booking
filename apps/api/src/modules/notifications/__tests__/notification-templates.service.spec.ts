import { runWithTenant } from '../../../common/tenant';
import { defaultTemplateFor } from '../notification-default-templates';
import { SMS_MAX_SEGMENTS } from '../notification-template';
import { NotificationTemplatesService } from '../notification-templates.service';
import {
  NotificationTemplateInvalidError,
  NotificationTemplateNotFoundError,
  NotificationTemplateTooLongError,
} from '../notifications.errors';
import type { NotificationTemplateSource, NotificationType } from '../notifications.types';
import { FakeNotificationTemplates } from './notifications.doubles';

/**
 * Les modèles de messages d'un établissement — #69, les deux règles que le
 * service tient seul.
 *
 * 1. **La résolution du modèle effectif** : la personnalisation du salon si elle
 *    existe, le modèle de la plateforme sinon. C'est le premier critère
 *    d'acceptation, et il n'est vérifiable qu'ici — le dépôt ne connaît pas les
 *    défauts, et le contrôleur ne connaît pas le dépôt.
 * 2. **La validation d'un modèle soumis** : variables connues, sections
 *    refermées, coût du SMS borné.
 *
 * Le dépôt est doublé — il parle à Prisma —, et le double **exige une portée de
 * tenant ouverte** : une lecture qui échapperait au scoping y échoue au lieu de
 * passer au vert.
 */

const SALON = '11111111-1111-4111-8111-111111111111';
const VOISIN = '22222222-2222-4222-8222-222222222222';

const PERSONNALISE: NotificationTemplateSource = {
  subject: 'À demain chez {{salon}}',
  html: '<p>Bonjour {{client}}, le {{date}}.</p>',
  text: 'Bonjour {{client}}, le {{date}}.',
};

function serviceOn(store: FakeNotificationTemplates): NotificationTemplatesService {
  return new NotificationTemplatesService(store.repository);
}

describe('modèles — la résolution du modèle effectif', () => {
  it('sert le modèle de la plateforme quand le salon n’a rien écrit', async () => {
    const store = new FakeNotificationTemplates();

    const template = await runWithTenant(SALON, () =>
      serviceOn(store).get('BOOKING_CONFIRMATION', 'EMAIL'),
    );

    expect(template.origin).toBe('PLATFORM');
    expect(template.source).toEqual(defaultTemplateFor('BOOKING_CONFIRMATION', 'EMAIL'));
    // Un défaut n'a pas de date d'écriture : personne ne l'a écrit dans ce salon.
    expect(template.updatedAt).toBeNull();
  });

  it('sert la personnalisation du salon dès qu’il en a une', async () => {
    const store = new FakeNotificationTemplates();
    store.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: PERSONNALISE,
    });

    const template = await runWithTenant(SALON, () =>
      serviceOn(store).get('BOOKING_CONFIRMATION', 'EMAIL'),
    );

    expect(template.origin).toBe('TENANT');
    expect(template.source).toEqual(PERSONNALISE);
    expect(template.updatedAt).not.toBeNull();
  });

  it('ne sert pas au voisin la personnalisation du salon', async () => {
    // La borne qui compte : cette table décide de ce que reçoivent les clientes,
    // et servir le modèle d'un concurrent serait une fuite visible dans un
    // e-mail signé du mauvais nom.
    const store = new FakeNotificationTemplates();
    store.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: PERSONNALISE,
    });

    const template = await runWithTenant(VOISIN, () =>
      serviceOn(store).get('BOOKING_CONFIRMATION', 'EMAIL'),
    );

    expect(template.origin).toBe('PLATFORM');
    expect(template.source.subject).not.toBe(PERSONNALISE.subject);
  });

  it('refuse en 404 un message sans modèle, ni personnalisé ni par défaut', async () => {
    // Depuis #72, les trois types du CDC §1.4 ont tous leur défaut : ce refus ne
    // se produit plus par une valeur de l'énumération, et le DTO du contrôleur
    // n'en laisse pas passer d'autre. La barrière reste malgré tout — un type
    // ajouté à l'énumération sans son modèle doit rendre 404 plutôt que servir
    // celui d'un autre message.
    const store = new FakeNotificationTemplates();

    await expect(
      runWithTenant(SALON, () =>
        serviceOn(store).get('WELCOME' as NotificationType, 'EMAIL'),
      ),
    ).rejects.toBeInstanceOf(NotificationTemplateNotFoundError);
  });

  it('échoue hors portée de tenant plutôt que de lire tous les salons', async () => {
    const store = new FakeNotificationTemplates();

    await expect(serviceOn(store).get('BOOKING_CONFIRMATION', 'EMAIL')).rejects.toThrow(
      /portée de tenant/,
    );
  });
});

describe('modèles — la liste du back-office', () => {
  it('rend les six modèles servis par défaut — trois messages, deux canaux', async () => {
    // Quatre jusqu'à #72, qui a livré l'avis d'annulation. L'ordre est celui des
    // énumérations : une liste de configuration qui change d'ordre fait bouger
    // les lignes sous la souris.
    const store = new FakeNotificationTemplates();

    const list = await runWithTenant(SALON, () => serviceOn(store).list());

    expect(list.map((item) => `${item.type}/${item.channel}`)).toEqual([
      'BOOKING_CONFIRMATION/EMAIL',
      'BOOKING_CONFIRMATION/SMS',
      'REMINDER_24H/EMAIL',
      'REMINDER_24H/SMS',
      'CANCELLATION/EMAIL',
      'CANCELLATION/SMS',
    ]);
    expect(list.every((item) => item.origin === 'PLATFORM')).toBe(true);
  });

  it('fait passer la personnalisation du salon devant le défaut', async () => {
    // Ce que « personnaliser sans déploiement » veut dire : le salon qui réécrit
    // son avis d'annulation voit partir le sien, et non celui de la plateforme.
    const store = new FakeNotificationTemplates();
    store.seed({ tenantId: SALON, type: 'CANCELLATION', channel: 'EMAIL', source: PERSONNALISE });

    const list = await runWithTenant(SALON, () => serviceOn(store).list());
    const avis = list.find((item) => `${item.type}/${item.channel}` === 'CANCELLATION/EMAIL');

    expect(avis?.origin).toBe('TENANT');
    expect(avis?.source).toEqual(PERSONNALISE);
  });

  it('mesure le coût des modèles de SMS, et d’eux seuls', async () => {
    const store = new FakeNotificationTemplates();

    const list = await runWithTenant(SALON, () => serviceOn(store).list());

    for (const item of list) {
      expect({ channel: item.channel, mesure: item.sms !== null }).toEqual({
        channel: item.channel,
        mesure: item.channel === 'SMS',
      });
    }
  });
});

describe('modèles — la validation à l’enregistrement', () => {
  it('accepte un modèle qui n’emploie que le vocabulaire', async () => {
    const store = new FakeNotificationTemplates();

    const saved = await runWithTenant(SALON, () =>
      serviceOn(store).save('REMINDER_24H', 'EMAIL', PERSONNALISE),
    );

    expect(saved.origin).toBe('TENANT');
    expect(saved.source).toEqual(PERSONNALISE);
  });

  it('refuse une variable inconnue, et la nomme', async () => {
    const store = new FakeNotificationTemplates();
    const fautif = { subject: 'x', html: '<p>{{prenom}}</p>', text: '{{prenom}}' };

    const error = await runWithTenant(SALON, () =>
      serviceOn(store)
        .save('REMINDER_24H', 'EMAIL', fautif)
        .catch((caught: unknown) => caught),
    );

    expect(error).toBeInstanceOf(NotificationTemplateInvalidError);
    expect((error as NotificationTemplateInvalidError).details).toEqual({
      unknownVariables: ['prenom'],
    });
  });

  it('refuse une section jamais refermée', async () => {
    const store = new FakeNotificationTemplates();
    const fautif = { subject: '', html: '', text: '{{#adresse}}Adresse : {{adresse}}' };

    await expect(
      runWithTenant(SALON, () => serviceOn(store).save('REMINDER_24H', 'EMAIL', fautif)),
    ).rejects.toBeInstanceOf(NotificationTemplateInvalidError);
  });

  it('n’apparie pas une section d’un corps avec la fermeture d’un autre', async () => {
    // Deux fautes distinctes — l'une dans le HTML, l'autre dans le texte — qui
    // s'annuleraient si les corps étaient comptés ensemble. Les deux balises
    // partiraient alors telles quelles, chacune dans sa version de l'e-mail.
    const store = new FakeNotificationTemplates();
    const fautif = {
      subject: '',
      html: '<p>{{#adresse}}{{adresse}}</p>',
      text: '{{/adresse}}Adresse inconnue',
    };

    await expect(
      runWithTenant(SALON, () => serviceOn(store).save('REMINDER_24H', 'EMAIL', fautif)),
    ).rejects.toBeInstanceOf(NotificationTemplateInvalidError);
  });

  it('n’écrit rien quand il refuse', async () => {
    // La validation précède l'écriture : un modèle refusé qui aurait touché la
    // base priverait les clientes du salon de leurs confirmations.
    const store = new FakeNotificationTemplates();
    const fautif = { subject: '', html: '', text: '{{prenom}}' };

    await runWithTenant(SALON, () =>
      serviceOn(store)
        .save('REMINDER_24H', 'EMAIL', fautif)
        .catch(() => undefined),
    );

    const template = await runWithTenant(SALON, () => serviceOn(store).get('REMINDER_24H', 'EMAIL'));

    expect(template.origin).toBe('PLATFORM');
  });

  it('refuse un modèle de SMS qui dépasse le plafond de segments', async () => {
    const store = new FakeNotificationTemplates();
    // Trois segments UCS-2 concaténés valent 201 unités : 260 caractères
    // accentués les dépassent, alors que les mêmes en GSM-7 tiendraient en deux
    // segments.
    const trop = { subject: '', html: '', text: 'ê'.repeat(260) };

    const error = await runWithTenant(SALON, () =>
      serviceOn(store)
        .save('REMINDER_24H', 'SMS', trop)
        .catch((caught: unknown) => caught),
    );

    expect(error).toBeInstanceOf(NotificationTemplateTooLongError);
    expect((error as NotificationTemplateTooLongError).details).toEqual({
      encoding: 'UCS_2',
      segments: 4,
      maxSegments: SMS_MAX_SEGMENTS,
    });
  });

  it('accepte le même texte sans accent hors GSM-7 — c’est tout le critère', async () => {
    // La démonstration du cinquième critère d'acceptation : à longueur égale, un
    // caractère hors GSM-7 double le coût. `e` passe là où `ê` est refusé.
    const store = new FakeNotificationTemplates();
    const juste = { subject: '', html: '', text: 'e'.repeat(260) };

    const saved = await runWithTenant(SALON, () =>
      serviceOn(store).save('REMINDER_24H', 'SMS', juste),
    );

    expect(saved.sms).toEqual({ encoding: 'GSM_7', units: 260, segments: 2 });
  });

  it('refuse un modèle d’e-mail sans objet, et nomme le champ', async () => {
    // Sans ce contrôle, `PUT …/booking_confirmation/email {"text":"…"}` passe, et
    // chaque confirmation part ensuite avec un en-tête `Subject` vide. La
    // contrainte dépend du canal : elle ne peut pas vivre dans le DTO, qui ne
    // connaît que le corps.
    const store = new FakeNotificationTemplates();

    const error = await runWithTenant(SALON, () =>
      serviceOn(store)
        .save('REMINDER_24H', 'EMAIL', { subject: '   ', html: '<p>y</p>', text: 'y' })
        .catch((caught: unknown) => caught),
    );

    expect(error).toBeInstanceOf(NotificationTemplateInvalidError);
    expect((error as NotificationTemplateInvalidError).details).toEqual({
      missingFields: ['subject'],
    });
  });

  it('n’exige pas de HTML — un e-mail en texte seul est licite', async () => {
    // Ce que le quatrième critère impose est l'inverse : que le texte accompagne
    // toujours le HTML. Un e-mail sans HTML est même plutôt bien vu des filtres.
    const store = new FakeNotificationTemplates();

    const saved = await runWithTenant(SALON, () =>
      serviceOn(store).save('REMINDER_24H', 'EMAIL', { subject: 'Rappel', html: '', text: 'y' }),
    );

    expect(saved.source).toEqual({ subject: 'Rappel', html: '', text: 'y' });
  });

  it('n’exige aucun objet sur le canal SMS — il n’en a pas', async () => {
    const store = new FakeNotificationTemplates();

    const saved = await runWithTenant(SALON, () =>
      serviceOn(store).save('REMINDER_24H', 'SMS', { subject: '', html: '', text: 'avis' }),
    );

    expect(saved.source.text).toBe('avis');
  });

  it('force l’objet et le HTML à vide sur le canal SMS', async () => {
    // Un expéditeur SNS ne lit que `text` ; ce qui n'est pas stocké ne peut pas
    // être envoyé par erreur.
    const store = new FakeNotificationTemplates();

    const saved = await runWithTenant(SALON, () =>
      serviceOn(store).save('REMINDER_24H', 'SMS', {
        subject: 'objet',
        html: '<p>corps</p>',
        text: 'avis',
      }),
    );

    expect(saved.source).toEqual({ subject: '', html: '', text: 'avis' });
  });

  it('remplace la personnalisation existante au lieu d’en empiler une seconde', async () => {
    const store = new FakeNotificationTemplates();

    await runWithTenant(SALON, () => serviceOn(store).save('REMINDER_24H', 'SMS', {
      subject: '',
      html: '',
      text: 'premier',
    }));
    await runWithTenant(SALON, () => serviceOn(store).save('REMINDER_24H', 'SMS', {
      subject: '',
      html: '',
      text: 'second',
    }));

    const list = await runWithTenant(SALON, () => serviceOn(store).list());
    const sms = list.filter((item) => item.type === 'REMINDER_24H' && item.channel === 'SMS');

    expect(sms).toHaveLength(1);
    expect(sms[0]?.source.text).toBe('second');
  });
});

describe('modèles — le retour au défaut', () => {
  it('efface la personnalisation et rend le modèle de la plateforme', async () => {
    const store = new FakeNotificationTemplates();
    store.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: PERSONNALISE,
    });

    const template = await runWithTenant(SALON, () =>
      serviceOn(store).reset('BOOKING_CONFIRMATION', 'EMAIL'),
    );

    expect(template.origin).toBe('PLATFORM');
    expect(template.source).toEqual(defaultTemplateFor('BOOKING_CONFIRMATION', 'EMAIL'));
  });

  it('est idempotent — effacer ce qui n’existe pas laisse l’état demandé', async () => {
    const store = new FakeNotificationTemplates();

    const template = await runWithTenant(SALON, () =>
      serviceOn(store).reset('BOOKING_CONFIRMATION', 'SMS'),
    );

    expect(template.origin).toBe('PLATFORM');
  });

  it('n’efface que la sienne — le voisin garde la sienne', async () => {
    const store = new FakeNotificationTemplates();
    store.seed({
      tenantId: VOISIN,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: PERSONNALISE,
    });

    await runWithTenant(SALON, () => serviceOn(store).reset('BOOKING_CONFIRMATION', 'EMAIL'));

    const chezLeVoisin = await runWithTenant(VOISIN, () =>
      serviceOn(store).get('BOOKING_CONFIRMATION', 'EMAIL'),
    );

    expect(chezLeVoisin.origin).toBe('TENANT');
  });

  it('rend l’avis d’annulation à son défaut, comme les deux autres messages', async () => {
    // Jusqu'à #72 ce couple n'avait aucun défaut : l'effacement le laissait sans
    // modèle, et la lecture qui suit rendait 404. Ce n'est plus le cas — les
    // trois messages du CDC §1.4 ont le leur.
    const store = new FakeNotificationTemplates();
    store.seed({ tenantId: SALON, type: 'CANCELLATION', channel: 'SMS', source: PERSONNALISE });

    const template = await runWithTenant(SALON, () =>
      serviceOn(store).reset('CANCELLATION', 'SMS'),
    );

    expect(template.origin).toBe('PLATFORM');
    expect(template.source).toEqual(defaultTemplateFor('CANCELLATION', 'SMS'));
  });

  it('signale en 404 le message qui reste alors sans aucun modèle', async () => {
    // L'effacement a bien eu lieu — c'est ce que le salon a demandé —, et le
    // refus porte sur la lecture qui suit. Le cas ne s'atteint plus par une
    // valeur de l'énumération, mais la barrière reste et doit se prouver.
    const store = new FakeNotificationTemplates();

    await expect(
      runWithTenant(SALON, () =>
        serviceOn(store).reset('WELCOME' as NotificationType, 'SMS'),
      ),
    ).rejects.toBeInstanceOf(NotificationTemplateNotFoundError);
  });
});
