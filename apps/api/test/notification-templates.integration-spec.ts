import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { TEMPLATE_VARIABLES } from '../src/modules/notifications/notification-template';
import {
  createNotificationTemplatesHarness,
  type NotificationTemplatesHarness,
} from './notification-templates.harness';

/**
 * Les routes de personnalisation des messages — #69, étendues par #854.
 *
 * L'application est la **vraie** : préfixe, versionnement, `ValidationPipe`
 * global, filtre d'exceptions, gardes d'authentification et de rôles. Seul le
 * dépôt est doublé. Ce que cette suite prouve et qu'aucun test unitaire ne peut
 * prouver : que ces routes sont **servies**, que leurs seuils de rôle sont ceux
 * qu'on croit, et que les refus sortent dans la forme `{ code, message, details }`.
 *
 * ## Ce que #854 change dans cette suite
 *
 * La langue est entrée dans le **chemin** des trois routes unitaires, et une
 * quatrième est apparue — l'aperçu. Les cas qui suivent couvrent, en plus des
 * précédents : la liste dans les deux langues et son filtre, le refus d'une
 * langue inconnue, le **repli intra-langue** (personnaliser le français ne
 * change pas l'anglais, et l'anglais non personnalisé retombe sur le défaut
 * anglais et non sur le français), et l'aperçu rendu.
 */

const BASE = '/api/v1/notification-templates';
const CONFIRMATION_EMAIL_FR = `${BASE}/booking_confirmation/email/fr`;
const CONFIRMATION_EMAIL_EN = `${BASE}/booking_confirmation/email/en`;
const RAPPEL_SMS_FR = `${BASE}/reminder_24h/sms/fr`;
const RAPPEL_SMS_EN = `${BASE}/reminder_24h/sms/en`;
const APERCU_FR = `${CONFIRMATION_EMAIL_FR}/preview`;
const APERCU_EN = `${CONFIRMATION_EMAIL_EN}/preview`;

interface TemplateBody {
  type: string;
  channel: string;
  locale: string;
  origin: string;
  subject: string;
  html: string;
  text: string;
  updatedAt?: string;
  sms?: { encoding: string; units: number; segments: number };
}

interface PreviewBody {
  type: string;
  channel: string;
  locale: string;
  origin: string;
  rendered: { subject: string; html: string; text: string };
  sms?: { encoding: string; units: number; segments: number };
}

interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

describe('Modèles de messages — routes du back-office', () => {
  let harness: NotificationTemplatesHarness;

  beforeEach(async () => {
    harness = await createNotificationTemplatesHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  describe('GET /notification-templates', () => {
    it('sert les modèles par défaut de la plateforme dans les deux langues, et le vocabulaire des variables', async () => {
      const response = await request(server())
        .get(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as { items: TemplateBody[]; variables: string[] };

      // Onze couples `(type, canal)` depuis #1116 — les cinq messages de
      // rendez-vous sur les deux canaux, plus la réinitialisation du mot de
      // passe en e-mail seulement, `password_reset/sms` n'ayant pas de modèle de
      // plateforme. **Vingt-deux lignes depuis #854** : chacun de ces couples
      // existe dans les deux langues, et c'est le premier critère d'acceptation
      // du ticket. L'ordre suit les énumérations — type, canal, puis `LOCALES`,
      // qui présente le français en premier.
      expect(body.items.map((item) => `${item.type}/${item.channel}/${item.locale}`)).toEqual([
        'booking_confirmation/email/fr',
        'booking_confirmation/email/en',
        'booking_confirmation/sms/fr',
        'booking_confirmation/sms/en',
        'reminder_24h/email/fr',
        'reminder_24h/email/en',
        'reminder_24h/sms/fr',
        'reminder_24h/sms/en',
        'cancellation/email/fr',
        'cancellation/email/en',
        'cancellation/sms/fr',
        'cancellation/sms/en',
        'password_reset/email/fr',
        'password_reset/email/en',
        'appointment_confirmed/email/fr',
        'appointment_confirmed/email/en',
        'appointment_confirmed/sms/fr',
        'appointment_confirmed/sms/en',
        'appointment_rescheduled/email/fr',
        'appointment_rescheduled/email/en',
        'appointment_rescheduled/sms/fr',
        'appointment_rescheduled/sms/en',
      ]);
      expect(body.items.every((item) => item.origin === 'platform')).toBe(true);
      expect(body.variables).toEqual([...TEMPLATE_VARIABLES]);
    });

    it('restreint la liste à une langue quand on le lui demande', async () => {
      const response = await request(server())
        .get(`${BASE}?locale=en`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as { items: TemplateBody[] };

      expect(body.items).toHaveLength(11);
      expect(body.items.every((item) => item.locale === 'en')).toBe(true);
    });

    it('refuse une langue inconnue en nommant le champ', async () => {
      const response = await request(server())
        .get(`${BASE}?locale=de`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('locale');
    });

    it('refuse sans jeton', async () => {
      await request(server()).get(BASE).expect(401);
    });
  });

  describe('GET /notification-templates/:type/:channel/:locale', () => {
    it('rend le modèle effectif, avec son origine et sa langue', async () => {
      const response = await request(server())
        .get(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('platform');
      expect(body.locale).toBe('fr');
      // Un défaut n'a pas de date d'écriture : le champ est **omis**, pas nul.
      expect(body.updatedAt).toBeUndefined();
      expect(body.text.length).toBeGreaterThan(0);
    });

    it('sert un texte différent dans l’autre langue — jamais le même modèle traduit à la volée', async () => {
      const fr = await request(server())
        .get(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const en = await request(server())
        .get(CONFIRMATION_EMAIL_EN)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect((en.body as TemplateBody).locale).toBe('en');
      expect((en.body as TemplateBody).text).not.toBe((fr.body as TemplateBody).text);
      expect((en.body as TemplateBody).subject).not.toBe((fr.body as TemplateBody).subject);
    });

    it('mesure le coût d’un modèle de SMS dans chaque langue, et le rend', async () => {
      // Le défaut est écrit en GSM-7 : il tient en un segment, et c'est ce que
      // le back-office doit voir avant qu'un salon n'y ajoute une apostrophe
      // typographique. Le septième critère de #854 exige la même borne des deux
      // côtés — c'est `notification-default-templates.spec.ts` qui la tient sur
      // tous les couples ; ici, on prouve que la route la **rend**.
      for (const cible of [RAPPEL_SMS_FR, RAPPEL_SMS_EN]) {
        const response = await request(server())
          .get(cible)
          .set('Authorization', await harness.bearer('STAFF'))
          .expect(200);

        expect((response.body as TemplateBody).sms).toEqual({
          encoding: 'gsm_7',
          units: expect.any(Number),
          segments: 1,
        });
      }
    });

    it('refuse un type inconnu en nommant le champ', async () => {
      const response = await request(server())
        .get(`${BASE}/promotion/email/fr`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBeDefined();
      expect(JSON.stringify(body)).toContain('type');
    });

    it('refuse une langue inconnue en nommant le champ', async () => {
      const response = await request(server())
        .get(`${BASE}/booking_confirmation/email/de`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('locale');
    });

    it('sert l’avis d’annulation, et il nomme l’origine de la décision', async () => {
      // #72 : le couple avait 404 tant qu'aucun modèle de plateforme ne le
      // servait. Les trois messages du CDC §1.4 en ont un désormais, dans les
      // deux langues depuis #854.
      for (const cible of [`${BASE}/cancellation/email/fr`, `${BASE}/cancellation/email/en`]) {
        const response = await request(server())
          .get(cible)
          .set('Authorization', await harness.bearer('STAFF'))
          .expect(200);

        const body = response.body as TemplateBody;

        expect(body.origin).toBe('platform');
        expect(body.text).toContain('{{origine}}');
      }
    });
  });

  describe('PUT /notification-templates/:type/:channel/:locale', () => {
    it('enregistre la personnalisation et la rend', async () => {
      const response = await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          subject: 'C’est noté, {{client}}',
          html: '<p>Le {{date}} chez {{salon}}.</p>',
          text: 'Le {{date}} chez {{salon}}.',
        })
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('tenant');
      expect(body.locale).toBe('fr');
      expect(body.subject).toBe('C’est noté, {{client}}');
      expect(body.updatedAt).toBeDefined();
    });

    it('la relit ensuite comme modèle effectif', async () => {
      await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>', text: 'y' })
        .expect(200);

      const response = await request(server())
        .get(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect((response.body as TemplateBody).origin).toBe('tenant');
    });

    it('écrire une langue laisse l’autre au modèle de plateforme — de sa langue', async () => {
      // Le quatrième critère de #854 : « quand une langue n'a pas de
      // personnalisation, le message retombe sur le modèle par défaut de la
      // plateforme **dans cette même langue**, jamais sur l'autre langue ».
      const defautAnglais = await request(server())
        .get(CONFIRMATION_EMAIL_EN)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'Maison', html: '<p>Maison</p>', text: 'Maison' })
        .expect(200);

      const apres = await request(server())
        .get(CONFIRMATION_EMAIL_EN)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = apres.body as TemplateBody;

      expect(body.origin).toBe('platform');
      expect(body.text).toBe((defautAnglais.body as TemplateBody).text);
      expect(body.text).not.toBe('Maison');
    });

    it('refuse une variable inconnue et la nomme', async () => {
      const response = await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>{{prenom}}</p>', text: '{{prenom}}' })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_INVALID');
      expect(body.details).toEqual({ unknownVariables: ['prenom'] });
    });

    it('refuse un modèle sans version texte brut', async () => {
      // Quatrième critère d'acceptation de #69 : le texte accompagne
      // systématiquement le HTML, sans quoi l'e-mail est pénalisé par les
      // filtres anti-spam.
      const response = await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('text');
    });

    it('refuse un modèle d’e-mail sans objet', async () => {
      // La contrainte dépend du canal — qui est dans le chemin —, et c'est
      // pourquoi elle est portée par le service et non par un décorateur du DTO.
      const response = await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ html: '<p>y</p>', text: 'y' })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_INVALID');
      expect(body.details).toEqual({ missingFields: ['subject'] });
    });

    it('accepte un modèle de SMS sans objet — il n’en a pas', async () => {
      await request(server())
        .put(RAPPEL_SMS_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: '{{salon}} : rappel le {{date}}.' })
        .expect(200);
    });

    it('refuse un modèle de SMS qui dépasse le plafond de segments', async () => {
      const response = await request(server())
        .put(RAPPEL_SMS_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: 'ê'.repeat(260) })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_TOO_LONG');
      expect(body.details).toEqual({ encoding: 'UCS_2', segments: 4, maxSegments: 3 });
    });

    it('refuse une langue inconnue dans le chemin', async () => {
      const response = await request(server())
        .put(`${BASE}/booking_confirmation/email/de`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>', text: 'y' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('locale');
    });

    it('refuse un `tenantId` glissé dans le corps', async () => {
      // `forbidNonWhitelisted` : le scénario de fuite le plus direct
      // (tenant-isolation §2). L'établissement vient du jeton, et de lui seul.
      await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: 'x', tenantId: harness.otherTenantId })
        .expect(400);
    });

    it('refuse un `locale` glissé dans le corps — la langue est dans le chemin', async () => {
      // Le pendant du cas précédent pour la coordonnée qu'ajoute #854 : accepter
      // les deux aurait ouvert la question de savoir laquelle gagne, et un `PUT`
      // dont la cible dépend du corps n'est plus idempotent sur son URL.
      await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: 'x', locale: 'en' })
        .expect(400);
    });

    it('refuse un `STAFF` — écrire engage l’établissement auprès de ses clientes', async () => {
      await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ text: 'x' })
        .expect(403);
    });

    it('refuse sans jeton', async () => {
      await request(server()).put(CONFIRMATION_EMAIL_FR).send({ text: 'x' }).expect(401);
    });
  });

  describe('DELETE /notification-templates/:type/:channel/:locale', () => {
    it('ramène l’établissement au modèle par défaut', async () => {
      await request(server())
        .put(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>', text: 'y' })
        .expect(200);

      const response = await request(server())
        .delete(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('platform');
      expect(body.locale).toBe('fr');
      expect(body.subject).not.toBe('x');
    });

    it('n’efface que la langue demandée', async () => {
      for (const cible of [CONFIRMATION_EMAIL_FR, CONFIRMATION_EMAIL_EN]) {
        await request(server())
          .put(cible)
          .set('Authorization', await harness.bearer('MANAGER'))
          .send({ subject: 'x', html: '<p>y</p>', text: 'y' })
          .expect(200);
      }

      await request(server())
        .delete(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(200);

      const anglais = await request(server())
        .get(CONFIRMATION_EMAIL_EN)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect((anglais.body as TemplateBody).origin).toBe('tenant');
    });

    it('est idempotent — effacer ce qui n’existe pas rend le défaut', async () => {
      await request(server())
        .delete(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(200);
    });

    it('refuse un `STAFF`', async () => {
      await request(server())
        .delete(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(403);
    });
  });

  describe('POST /notification-templates/:type/:channel/:locale/preview', () => {
    it('rend le modèle effectif, balises substituées', async () => {
      const response = await request(server())
        .post(APERCU_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({})
        .expect(200);

      const body = response.body as PreviewBody;

      expect(body.origin).toBe('platform');
      expect(body.locale).toBe('fr');
      // Ce que la lecture ne montre pas : plus aucune balise ne subsiste.
      expect(body.rendered.text).not.toContain('{{');
      expect(body.rendered.subject.length).toBeGreaterThan(0);
    });

    it('formate les dates dans la langue demandée — le troisième critère', async () => {
      const fr = await request(server())
        .post(APERCU_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ subject: 'x', html: '<p>{{date}}</p>', text: '{{date}}' })
        .expect(200);

      const en = await request(server())
        .post(APERCU_EN)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ subject: 'x', html: '<p>{{date}}</p>', text: '{{date}}' })
        .expect(200);

      const dateFr = (fr.body as PreviewBody).rendered.text;
      const dateEn = (en.body as PreviewBody).rendered.text;

      // Le même instant de référence, le même fuseau, le même brouillon : seule
      // la langue change, et c'est donc elle qui fait la différence de rendu.
      expect(dateFr).not.toBe(dateEn);
      expect(dateFr).not.toContain('{{');
      expect(dateEn).not.toContain('{{');
    });

    it('rend le brouillon soumis, sans rien enregistrer', async () => {
      const response = await request(server())
        .post(APERCU_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ subject: 'Brouillon', html: '<p>Chez {{salon}}.</p>', text: 'Chez {{salon}}.' })
        .expect(200);

      const body = response.body as PreviewBody;

      expect(body.origin).toBe('tenant');
      expect(body.rendered.subject).toBe('Brouillon');
      expect(body.rendered.text).toContain('Chez ');

      // Rien n'a été écrit : la lecture rend toujours le défaut de la plateforme.
      const relu = await request(server())
        .get(CONFIRMATION_EMAIL_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect((relu.body as TemplateBody).origin).toBe('platform');
    });

    it('refuse un brouillon que l’enregistrement refuserait', async () => {
      // Un aperçu plus permissif que l'écriture montrerait un message que
      // l'écriture refuse.
      const response = await request(server())
        .post(APERCU_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ subject: 'x', html: '<p>{{prenom}}</p>', text: '{{prenom}}' })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_INVALID');
      expect(body.details).toEqual({ unknownVariables: ['prenom'] });
    });

    it('rend le coût mesuré sur le canal SMS', async () => {
      const response = await request(server())
        .post(`${RAPPEL_SMS_EN}/preview`)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({})
        .expect(200);

      expect((response.body as PreviewBody).sms).toEqual({
        encoding: 'gsm_7',
        units: expect.any(Number),
        segments: 1,
      });
    });

    it('se lit à `STAFF` — voir ce qui partira est une question de comptoir', async () => {
      await request(server())
        .post(APERCU_FR)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({})
        .expect(200);
    });

    it('refuse sans jeton', async () => {
      await request(server()).post(APERCU_FR).send({}).expect(401);
    });
  });
});
