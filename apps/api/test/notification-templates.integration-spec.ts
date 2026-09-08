import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { TEMPLATE_VARIABLES } from '../src/modules/notifications/notification-template';
import {
  createNotificationTemplatesHarness,
  type NotificationTemplatesHarness,
} from './notification-templates.harness';

/**
 * Les routes de personnalisation des messages — #69.
 *
 * L'application est la **vraie** : préfixe, versionnement, `ValidationPipe`
 * global, filtre d'exceptions, gardes d'authentification et de rôles. Seul le
 * dépôt est doublé. Ce que cette suite prouve et qu'aucun test unitaire ne peut
 * prouver : que ces routes sont **servies**, que leurs seuils de rôle sont ceux
 * qu'on croit, et que les refus sortent dans la forme `{ code, message, details }`.
 */

const BASE = '/api/v1/notification-templates';
const CONFIRMATION_EMAIL = `${BASE}/booking_confirmation/email`;
const RAPPEL_SMS = `${BASE}/reminder_24h/sms`;

interface TemplateBody {
  type: string;
  channel: string;
  origin: string;
  subject: string;
  html: string;
  text: string;
  updatedAt?: string;
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
    it('sert les modèles par défaut de la plateforme et le vocabulaire des variables', async () => {
      const response = await request(server())
        .get(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as { items: TemplateBody[]; variables: string[] };

      // Six depuis #72, qui a livré l'avis d'annulation : les trois messages du
      // CDC §1.4, sur les deux canaux.
      expect(body.items.map((item) => `${item.type}/${item.channel}`)).toEqual([
        'booking_confirmation/email',
        'booking_confirmation/sms',
        'reminder_24h/email',
        'reminder_24h/sms',
        'cancellation/email',
        'cancellation/sms',
      ]);
      expect(body.items.every((item) => item.origin === 'platform')).toBe(true);
      expect(body.variables).toEqual([...TEMPLATE_VARIABLES]);
    });

    it('refuse sans jeton', async () => {
      await request(server()).get(BASE).expect(401);
    });
  });

  describe('GET /notification-templates/:type/:channel', () => {
    it('rend le modèle effectif, avec son origine', async () => {
      const response = await request(server())
        .get(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('platform');
      // Un défaut n'a pas de date d'écriture : le champ est **omis**, pas nul.
      expect(body.updatedAt).toBeUndefined();
      expect(body.text.length).toBeGreaterThan(0);
    });

    it('mesure le coût d’un modèle de SMS, et le rend', async () => {
      const response = await request(server())
        .get(RAPPEL_SMS)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as TemplateBody;

      // Le défaut est écrit en GSM-7 : il tient en un segment, et c'est ce que
      // le back-office doit voir avant qu'un salon n'y ajoute une apostrophe
      // typographique.
      expect(body.sms).toEqual({ encoding: 'gsm_7', units: expect.any(Number), segments: 1 });
    });

    it('refuse un type inconnu en nommant le champ', async () => {
      const response = await request(server())
        .get(`${BASE}/promotion/email`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBeDefined();
      expect(JSON.stringify(body)).toContain('type');
    });

    it('sert l’avis d’annulation, et il nomme l’origine de la décision', async () => {
      // #72 : le couple avait 404 tant qu'aucun modèle de plateforme ne le
      // servait. Les trois messages du CDC §1.4 en ont un désormais, et le refus
      // du service n'est plus atteignable par une valeur de l'énumération — le
      // DTO du contrôleur n'en laisse pas passer d'autre.
      const response = await request(server())
        .get(`${BASE}/cancellation/email`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('platform');
      expect(body.text).toContain('{{origine}}');
    });
  });

  describe('PUT /notification-templates/:type/:channel', () => {
    it('enregistre la personnalisation et la rend', async () => {
      const response = await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({
          subject: 'C’est noté, {{client}}',
          html: '<p>Le {{date}} chez {{salon}}.</p>',
          text: 'Le {{date}} chez {{salon}}.',
        })
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('tenant');
      expect(body.subject).toBe('C’est noté, {{client}}');
      expect(body.updatedAt).toBeDefined();
    });

    it('la relit ensuite comme modèle effectif', async () => {
      await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>', text: 'y' })
        .expect(200);

      const response = await request(server())
        .get(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect((response.body as TemplateBody).origin).toBe('tenant');
    });

    it('refuse une variable inconnue et la nomme', async () => {
      const response = await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>{{prenom}}</p>', text: '{{prenom}}' })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_INVALID');
      expect(body.details).toEqual({ unknownVariables: ['prenom'] });
    });

    it('refuse un modèle sans version texte brut', async () => {
      // Quatrième critère d'acceptation : le texte accompagne systématiquement le
      // HTML, sans quoi l'e-mail est pénalisé par les filtres anti-spam.
      const response = await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('text');
    });

    it('refuse un modèle d’e-mail sans objet', async () => {
      // La contrainte dépend du canal — qui est dans le chemin —, et c'est
      // pourquoi elle est portée par le service et non par un décorateur du DTO.
      const response = await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ html: '<p>y</p>', text: 'y' })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_INVALID');
      expect(body.details).toEqual({ missingFields: ['subject'] });
    });

    it('accepte un modèle de SMS sans objet — il n’en a pas', async () => {
      await request(server())
        .put(RAPPEL_SMS)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: '{{salon}} : rappel le {{date}}.' })
        .expect(200);
    });

    it('refuse un modèle de SMS qui dépasse le plafond de segments', async () => {
      const response = await request(server())
        .put(RAPPEL_SMS)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: 'ê'.repeat(260) })
        .expect(400);

      const body = response.body as ErrorBody;

      expect(body.code).toBe('NOTIFICATION_TEMPLATE_TOO_LONG');
      expect(body.details).toEqual({ encoding: 'UCS_2', segments: 4, maxSegments: 3 });
    });

    it('refuse un `tenantId` glissé dans le corps', async () => {
      // `forbidNonWhitelisted` : le scénario de fuite le plus direct
      // (tenant-isolation §2). L'établissement vient du jeton, et de lui seul.
      await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ text: 'x', tenantId: harness.otherTenantId })
        .expect(400);
    });

    it('refuse un `STAFF` — écrire engage l’établissement auprès de ses clientes', async () => {
      await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ text: 'x' })
        .expect(403);
    });

    it('refuse sans jeton', async () => {
      await request(server()).put(CONFIRMATION_EMAIL).send({ text: 'x' }).expect(401);
    });
  });

  describe('DELETE /notification-templates/:type/:channel', () => {
    it('ramène l’établissement au modèle par défaut', async () => {
      await request(server())
        .put(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ subject: 'x', html: '<p>y</p>', text: 'y' })
        .expect(200);

      const response = await request(server())
        .delete(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(200);

      const body = response.body as TemplateBody;

      expect(body.origin).toBe('platform');
      expect(body.subject).not.toBe('x');
    });

    it('est idempotent — effacer ce qui n’existe pas rend le défaut', async () => {
      await request(server())
        .delete(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(200);
    });

    it('refuse un `STAFF`', async () => {
      await request(server())
        .delete(CONFIRMATION_EMAIL)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(403);
    });
  });
});
