import { runWithTenant } from '../../../common/tenant';
import type { AppConfigService } from '../../../config/app-config.service';
import { AppointmentNotificationRenderer } from '../notification-renderer';
import { UnrenderableNotificationError, NotificationContextGoneError } from '../notifications.errors';
import type { NotificationsRepository } from '../notifications.repository';
import type { AppointmentMessageContext, NotificationMessage } from '../notifications.types';
import { FakeNotificationTemplates } from './notifications.doubles';

/**
 * Le rendu à l'envoi — la couture entre les modèles de #69 et la chaîne
 * d'expédition de #68.
 *
 * Ce que cette suite prouve, et que ni le service ni le moteur ne prouvent : que
 * **le modèle du salon l'emporte au moment d'envoyer**. Un service qui résout
 * correctement pour un écran de configuration ne dit rien de ce qui part
 * réellement pour la cliente ; c'est ici que les deux se rejoignent.
 */

const SALON = '11111111-1111-4111-8111-111111111111';
const RDV = '33333333-3333-4333-8333-333333333333';

const CONTEXTE: AppointmentMessageContext = {
  tenantName: 'Maison Lotus',
  tenantSlug: 'maison-lotus',
  tenantTimeZone: 'Europe/Paris',
  tenantAddress: '12 rue des Lilas, 75011 Paris',
  tenantPhone: '+33123456789',
  clientFirstName: 'Amina',
  clientLastName: 'Rakoto',
  serviceName: 'Massage suédois',
  staffName: 'Claire D.',
  startsAt: new Date('2026-09-08T12:30:00Z'),
  endsAt: new Date('2026-09-08T13:30:00Z'),
  priceAmountMinor: 6_500,
  priceCurrency: 'EUR',
};

const MESSAGE: NotificationMessage = {
  tenantId: SALON,
  dedupeKey: `appointment:${RDV}:BOOKING_CONFIRMATION:EMAIL`,
  appointmentId: RDV,
  recipientUserId: '44444444-4444-4444-8444-444444444444',
  type: 'BOOKING_CONFIRMATION',
  channel: 'EMAIL',
  scheduledFor: null,
};

/** Le dépôt d'envois, réduit à la seule lecture que le renderer lui demande. */
function contextRepository(context: AppointmentMessageContext | null): NotificationsRepository {
  return {
    loadAppointmentContext: () => Promise.resolve(context),
  } as unknown as NotificationsRepository;
}

const CONFIG = { appUrl: 'https://reservation.test' } as AppConfigService;

function rendererOn(
  templates: FakeNotificationTemplates,
  context: AppointmentMessageContext | null = CONTEXTE,
): AppointmentNotificationRenderer {
  return new AppointmentNotificationRenderer(
    contextRepository(context),
    templates.repository,
    CONFIG,
  );
}

describe('rendu à l’envoi — quel modèle part', () => {
  it('emploie le modèle de la plateforme quand le salon n’a rien écrit', async () => {
    const templates = new FakeNotificationTemplates();

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE));

    expect(rendered.subject).toContain('est confirmé');
    expect(rendered.html).toContain('Maison Lotus');
  });

  it('emploie le modèle du salon dès qu’il en a écrit un', async () => {
    const templates = new FakeNotificationTemplates();
    templates.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: {
        subject: 'C’est noté, {{client}} !',
        html: '<p>Le {{date}} chez {{salon}}.</p>',
        text: 'Le {{date}} chez {{salon}}.',
      },
    });

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE));

    expect(rendered.subject).toBe('C’est noté, Amina Rakoto !');
    // 12:30 UTC = 14:30 à Paris : le modèle nomme la date, il ne la calcule pas.
    expect(rendered.html).toContain('14:30');
    expect(rendered.html).not.toContain('12:30');
  });

  it('échappe les variables du modèle du salon, comme celles du défaut', async () => {
    // Le point où un modèle personnalisé aurait pu perdre l'échappement : il n'y
    // a qu'un seul chemin de rendu, et il échappe.
    const templates = new FakeNotificationTemplates();
    templates.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: { subject: 'x', html: '<p>{{client}}</p>', text: '{{client}}' },
    });

    const rendered = await runWithTenant(SALON, () =>
      rendererOn(templates, { ...CONTEXTE, clientLastName: '<img src=x onerror=1>' }).render(
        MESSAGE,
      ),
    );

    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&lt;img');
    // Le corps texte n'échappe rien : des `&amp;` y seraient visibles.
    expect(rendered.text).toContain('<img src=x onerror=1>');
  });

  it('fournit toujours une version texte à côté du HTML', async () => {
    const templates = new FakeNotificationTemplates();

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE));

    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.text).not.toContain('<');
  });

  it('compose le lien d’annulation depuis la configuration, jamais depuis le modèle', async () => {
    // Un salon nomme `{{lien_annulation}}` ; il ne l'écrit pas. C'est ce qui
    // empêche qu'un modèle personnalisé devienne un vecteur d'hameçonnage signé
    // du nom du salon.
    const templates = new FakeNotificationTemplates();
    templates.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      source: { subject: 'x', html: '<a href="{{lien_annulation}}">a</a>', text: '{{lien_annulation}}' },
    });

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE));

    expect(rendered.text).toBe('https://reservation.test/maison-lotus/compte');
  });

  it('refuse l’avis d’annulation tant qu’aucun modèle ne le sert', async () => {
    // #72. Lui servir le modèle du rappel annoncerait un rendez-vous à qui vient
    // de l'annuler.
    const templates = new FakeNotificationTemplates();

    await expect(
      runWithTenant(SALON, () =>
        rendererOn(templates).render({ ...MESSAGE, type: 'CANCELLATION' }),
      ),
    ).rejects.toBeInstanceOf(UnrenderableNotificationError);
  });

  it('le sert dès que le salon l’a écrit lui-même', async () => {
    const templates = new FakeNotificationTemplates();
    templates.seed({
      tenantId: SALON,
      type: 'CANCELLATION',
      channel: 'EMAIL',
      source: { subject: 'Annulé', html: '<p>{{date}}</p>', text: '{{date}}' },
    });

    const rendered = await runWithTenant(SALON, () =>
      rendererOn(templates).render({ ...MESSAGE, type: 'CANCELLATION' }),
    );

    expect(rendered.subject).toBe('Annulé');
  });

  it('relève un rendez-vous disparu sous la livraison', async () => {
    const templates = new FakeNotificationTemplates();

    await expect(
      runWithTenant(SALON, () => rendererOn(templates, null).render(MESSAGE)),
    ).rejects.toBeInstanceOf(NotificationContextGoneError);
  });

  it('ne lit pas le rendez-vous quand aucun modèle ne sert le message', async () => {
    // Une jointure sur la cliente, la prestation et le praticien n'a aucune
    // raison d'être payée pour un message qui ne partira pas.
    const templates = new FakeNotificationTemplates();
    let lectures = 0;

    const repository = {
      loadAppointmentContext: () => {
        lectures += 1;
        return Promise.resolve(CONTEXTE);
      },
    } as unknown as NotificationsRepository;

    const renderer = new AppointmentNotificationRenderer(repository, templates.repository, CONFIG);

    await runWithTenant(SALON, () =>
      renderer.render({ ...MESSAGE, type: 'CANCELLATION' }).catch(() => undefined),
    );

    expect(lectures).toBe(0);
  });
});
