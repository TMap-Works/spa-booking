import type { Locale } from '@spa/shared';

import { runWithTenant } from '../../../common/tenant';
import type { AppConfigService } from '../../../config/app-config.service';
import { AppointmentNotificationRenderer } from '../notification-renderer';
import { UnrenderableNotificationError, NotificationContextGoneError } from '../notifications.errors';
import type { NotificationsRepository } from '../notifications.repository';
import type {
  AppointmentMessageContext,
  NotificationMessage,
  PasswordResetMessageContext,
} from '../notifications.types';
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

/**
 * La langue que l'expédition passe au rendu — #854.
 *
 * `fr` pour les cas antérieurs à ce ticket, et ce n'est pas arbitraire : leurs
 * assertions citent le texte des modèles de plateforme, qui n'existaient qu'en
 * français. La leur imposer garde intacte la propriété que chacun éprouve —
 * l'échappement, le fuseau, le lien composé par la configuration — sans la
 * confondre avec la langue, qui a ses propres cas plus bas.
 */
const FR: Locale = 'fr';
const EN: Locale = 'en';

const CONTEXTE: AppointmentMessageContext = {
  tenantName: 'Maison Lotus',
  tenantSlug: 'maison-lotus',
  tenantTimeZone: 'Europe/Paris',
  tenantAddress: '12 rue des Lilas, 75011 Paris',
  tenantPhone: '+33123456789',
  appointmentReference: 'RDV-8F3K-27',
  clientId: '44444444-4444-4444-8444-444444444444',
  clientFirstName: 'Amina',
  clientLastName: 'Rakoto',
  serviceName: 'Massage suédois',
  staffName: 'Claire D.',
  startsAt: new Date('2026-09-08T12:30:00Z'),
  endsAt: new Date('2026-09-08T13:30:00Z'),
  priceAmountMinor: 6_500,
  priceCurrency: 'EUR',
  cancelledBy: null,
};

/**
 * Un type de message que la plateforme ne sert pas.
 *
 * Depuis #72, les trois valeurs de `NotificationType` ont toutes leur modèle de
 * plateforme : le refus du renderer ne se produit donc plus par une valeur de
 * l'énumération. La barrière reste, et c'est elle qu'on éprouve — un type ajouté
 * à l'énumération sans son modèle doit tomber en `FAILED`, pas partir vide.
 */
const SANS_MODELE = 'WELCOME' as NotificationMessage['type'];

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

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE, FR));

    // Le mot de #743, celui que l'espace client affiche au même instant sur ce
    // rendez-vous-là. Le défaut disait « est confirmé » d'un rendez-vous que le
    // dépôt venait d'écrire `PENDING` (#911) : l'assertion reconnaît désormais
    // le modèle de la plateforme au libellé **juste**, et non à l'ancien.
    expect(rendered.subject).toContain('À confirmer par le salon');
    expect(rendered.html).toContain('Maison Lotus');
  });

  it('emploie le modèle du salon dès qu’il en a écrit un', async () => {
    const templates = new FakeNotificationTemplates();
    templates.seed({
      tenantId: SALON,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      locale: FR,
      source: {
        subject: 'C’est noté, {{client}} !',
        html: '<p>Le {{date}} chez {{salon}}.</p>',
        text: 'Le {{date}} chez {{salon}}.',
      },
    });

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE, FR));

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
      locale: FR,
      source: { subject: 'x', html: '<p>{{client}}</p>', text: '{{client}}' },
    });

    const rendered = await runWithTenant(SALON, () =>
      rendererOn(templates, { ...CONTEXTE, clientLastName: '<img src=x onerror=1>' }).render(
        MESSAGE,
        FR,
      ),
    );

    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&lt;img');
    // Le corps texte n'échappe rien : des `&amp;` y seraient visibles.
    expect(rendered.text).toContain('<img src=x onerror=1>');
  });

  it('fournit toujours une version texte à côté du HTML', async () => {
    const templates = new FakeNotificationTemplates();

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE, FR));

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
      locale: FR,
      source: { subject: 'x', html: '<a href="{{lien_annulation}}">a</a>', text: '{{lien_annulation}}' },
    });

    const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE, FR));

    // Sur le sous-domaine du salon depuis #837 (arbitrage du PO, #832). La forme
    // elle-même est éprouvée dans `tenant-subdomain-links.spec.ts` ; ce qui se
    // joue ici reste que l'adresse vient de `AppConfigService.appUrl`, pas du
    // modèle.
    expect(rendered.text).toBe('https://maison-lotus.reservation.test/compte');
  });

  it('sert l’avis d’annulation depuis le défaut de la plateforme', async () => {
    // #72. Jusque-là le renderer levait faute de modèle, et la ligne tombait en
    // `FAILED` — le refus délibéré de #69, « un faux message serait pire ».
    const templates = new FakeNotificationTemplates();

    const rendered = await runWithTenant(SALON, () =>
      rendererOn(templates, { ...CONTEXTE, cancelledBy: 'STAFF' }).render(
        { ...MESSAGE, type: 'CANCELLATION' },
        FR,
      ),
    );

    expect(rendered.subject).toContain('Annulation');
    expect(rendered.text).toContain("à l'initiative du salon");
  });

  it('refuse un message qu’aucun modèle ne sert', async () => {
    const templates = new FakeNotificationTemplates();

    await expect(
      runWithTenant(SALON, () => rendererOn(templates).render({ ...MESSAGE, type: SANS_MODELE }, FR)),
    ).rejects.toBeInstanceOf(UnrenderableNotificationError);
  });

  it('le sert dès que le salon l’a écrit lui-même', async () => {
    const templates = new FakeNotificationTemplates();
    templates.seed({
      tenantId: SALON,
      type: 'CANCELLATION',
      channel: 'EMAIL',
      locale: FR,
      source: { subject: 'Annulé', html: '<p>{{date}}</p>', text: '{{date}}' },
    });

    const rendered = await runWithTenant(SALON, () =>
      rendererOn(templates).render({ ...MESSAGE, type: 'CANCELLATION' }, FR),
    );

    expect(rendered.subject).toBe('Annulé');
  });

  it('relève un rendez-vous disparu sous la livraison', async () => {
    const templates = new FakeNotificationTemplates();

    await expect(
      runWithTenant(SALON, () => rendererOn(templates, null).render(MESSAGE, FR)),
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
      renderer.render({ ...MESSAGE, type: SANS_MODELE }, FR).catch(() => undefined),
    );

    expect(lectures).toBe(0);
  });

  /**
   * La langue de l'envoi — #854, deuxième et quatrième critères.
   *
   * Ce qui se prouve ici et nulle part ailleurs : que la langue **passée** par
   * l'expédition choisit réellement le modèle, et que le repli d'une langue sans
   * personnalisation reste **dans cette langue**. Le service des modèles couvre
   * la même règle pour l'écran de configuration ; le renderer est ce qui décide
   * de ce qui part chez la cliente.
   */
  describe('la langue de l’envoi', () => {
    it('emploie le modèle de plateforme de la langue demandée', async () => {
      const templates = new FakeNotificationTemplates();

      const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE, EN));

      expect(rendered.subject).toContain('Awaiting confirmation');
      expect(rendered.subject).not.toContain('À confirmer par le salon');
    });

    it('ne sert jamais l’autre langue en repli — c’est tout le quatrième critère', async () => {
      // Le salon a réécrit son **français** et n'a rien écrit en anglais. Une
      // cliente anglophone doit recevoir le modèle de plateforme anglais, jamais
      // le texte français du salon : un message dans une langue qu'on ne lit pas
      // fait croire qu'on a été prévenu.
      const templates = new FakeNotificationTemplates();
      templates.seed({
        tenantId: SALON,
        type: 'BOOKING_CONFIRMATION',
        channel: 'EMAIL',
        locale: 'fr',
        source: {
          subject: 'C’est noté, {{client}} !',
          html: '<p>Le {{date}} chez {{salon}}.</p>',
          text: 'Le {{date}} chez {{salon}}.',
        },
      });

      const rendered = await runWithTenant(SALON, () => rendererOn(templates).render(MESSAGE, EN));

      expect(rendered.subject).not.toContain('C’est noté');
      expect(rendered.subject).toContain('Awaiting confirmation');
    });

    it('sert la personnalisation de la langue quand le salon l’a écrite', async () => {
      const templates = new FakeNotificationTemplates();
      templates.seed({
        tenantId: SALON,
        type: 'BOOKING_CONFIRMATION',
        channel: 'EMAIL',
        locale: 'fr',
        source: { subject: 'Noté !', html: '<p>fr</p>', text: 'fr' },
      });
      templates.seed({
        tenantId: SALON,
        type: 'BOOKING_CONFIRMATION',
        channel: 'EMAIL',
        locale: 'en',
        source: { subject: 'Noted!', html: '<p>en</p>', text: 'en' },
      });

      const enAnglais = await runWithTenant(SALON, () =>
        rendererOn(templates).render(MESSAGE, EN),
      );
      const enFrancais = await runWithTenant(SALON, () =>
        rendererOn(templates).render(MESSAGE, FR),
      );

      expect(enAnglais.subject).toBe('Noted!');
      expect(enFrancais.subject).toBe('Noté !');
    });

    it('formate la date dans la langue d’envoi, et dans le fuseau du salon', async () => {
      // Troisième critère. La même instant — 12:30 UTC, soit 14:30 à Paris —
      // s'écrit différemment dans les deux langues, et le fuseau ne change pas
      // avec la langue.
      const templates = new FakeNotificationTemplates();
      for (const locale of [FR, EN]) {
        templates.seed({
          tenantId: SALON,
          type: 'BOOKING_CONFIRMATION',
          channel: 'EMAIL',
          locale,
          source: { subject: '{{date}}', html: '<p>{{date}}</p>', text: '{{date}}' },
        });
      }

      const enAnglais = await runWithTenant(SALON, () =>
        rendererOn(templates).render(MESSAGE, EN),
      );
      const enFrancais = await runWithTenant(SALON, () =>
        rendererOn(templates).render(MESSAGE, FR),
      );

      expect(enFrancais.subject).toContain('septembre');
      expect(enAnglais.subject).toContain('September');
      // 14:30 à Paris des deux côtés : la langue met en forme, elle ne convertit
      // pas. L'anglais l'écrit sur douze heures.
      expect(enFrancais.subject).toContain('14:30');
      expect(enAnglais.subject).toContain('2:30');
    });

    it('refuse plutôt que de partir quand la langue demandée n’a aucun modèle', async () => {
      // Le refus laisse la ligne en `FAILED`, donc reprenable — le régime que le
      // renderer applique déjà à un type sans modèle. Servir l'autre langue
      // aurait été le seul repli vraiment fautif.
      const templates = new FakeNotificationTemplates();

      await expect(
        runWithTenant(SALON, () =>
          rendererOn(templates).render({ ...MESSAGE, type: SANS_MODELE }, EN),
        ),
      ).rejects.toBeInstanceOf(UnrenderableNotificationError);
    });
  });

  /**
   * Le lien de réinitialisation — #809, quatrième et sixième critères.
   *
   * Ce qui se prouve ici et nulle part ailleurs : le **chemin** du lien selon le
   * rôle, et le refus d'écrire à un compte qui n'est plus en service au moment
   * où le message part.
   */
  describe('lien de réinitialisation de mot de passe', () => {
    const COMPTE = '55555555-5555-4555-8555-555555555555';
    const JETON = 'jeton.de.reinitialisation';

    const RESET_MESSAGE: NotificationMessage = {
      tenantId: SALON,
      dedupeKey: 'password-reset:abc:EMAIL',
      // Ce message n'annonce aucun rendez-vous : c'est le seul des quatre dans
      // ce cas, et c'est ce que le `null` dit.
      appointmentId: null,
      recipientUserId: COMPTE,
      type: 'PASSWORD_RESET',
      channel: 'EMAIL',
      scheduledFor: null,
      passwordResetToken: JETON,
    };

    /** Le dépôt, réduit à la seule lecture que ce rendu-là demande. */
    const resetRepository = (
      context: PasswordResetMessageContext | null,
    ): NotificationsRepository =>
      ({
        loadPasswordResetContext: () => Promise.resolve(context),
      }) as unknown as NotificationsRepository;

    const CONTEXTE_CLIENTE: PasswordResetMessageContext = {
      role: 'CLIENT',
      isActive: true,
      tenantSlug: 'maison-lotus',
      tenantName: 'Maison Lotus',
    };

    const resetRendererOn = (
      context: PasswordResetMessageContext | null,
    ): AppointmentNotificationRenderer =>
      new AppointmentNotificationRenderer(
        resetRepository(context),
        new FakeNotificationTemplates().repository,
        CONFIG,
      );

    it('envoie une cliente vers son espace compte', async () => {
      const rendered = await runWithTenant(SALON, () =>
        resetRendererOn(CONTEXTE_CLIENTE).render(RESET_MESSAGE, FR),
      );

      expect(rendered.html).toContain('/compte/mot-de-passe');
      expect(rendered.html).not.toContain('/admin/mot-de-passe');
      // Le jeton est dans le lien, et il est échappé : c'est la seule valeur de
      // l'enveloppe qui ne se relise pas en base.
      expect(rendered.html).toContain(`jeton=${encodeURIComponent(JETON)}`);
      // Le message ne nomme personne — voir l'en-tête du modèle de plateforme :
      // il part à l'adresse demandée, et rien ne dit que celle ou celui qui la
      // relève soit le titulaire du compte.
      expect(rendered.html).not.toContain('Amina');
      expect(rendered.text).toContain('trente minutes');
    });

    it('envoie chacun des trois rôles internes vers la console d’administration', async () => {
      // `STAFF`, `MANAGER`, `ADMIN` — les libellés de `enum UserRole`, et les
      // seuls. Ce cas nommait `PRACTITIONER`, qui n'existe dans aucune
      // énumération du produit : il passait parce que l'ancien code envoyait
      // vers `/admin` **tout ce qui n'était pas `CLIENT`**, faute de frappe
      // comprise.
      for (const role of ['STAFF', 'MANAGER', 'ADMIN']) {
        const rendered = await runWithTenant(SALON, () =>
          resetRendererOn({ ...CONTEXTE_CLIENTE, role }).render(RESET_MESSAGE, FR),
        );

        expect(rendered.html).toContain('/admin/mot-de-passe');
        expect(rendered.html).not.toContain('/compte/mot-de-passe');
      }
    });

    it('envoie un rôle inconnu vers l’espace client, qui ne suppose aucun droit', async () => {
      // Un rôle ajouté à l'énumération sans que `passwordResetUrl` soit revu.
      // L'écran client est le défaut : il ne suppose aucun droit, là où la
      // console d'administration en suppose.
      const rendered = await runWithTenant(SALON, () =>
        resetRendererOn({ ...CONTEXTE_CLIENTE, role: 'COMPTABLE' }).render(RESET_MESSAGE, FR),
      );

      expect(rendered.html).toContain('/compte/mot-de-passe');
      expect(rendered.html).not.toContain('/admin/mot-de-passe');
    });

    it('refuse d’écrire à un compte suspendu entre la demande et l’envoi', async () => {
      // Sixième critère. `identity` a déjà refusé d'armer un jeton sur un compte
      // désactivé ; entre cet armement et l'envoi il y a un bus, une file et
      // jusqu'à cinq réceptions — une décision d'envoi se prend à l'envoi.
      await expect(
        runWithTenant(SALON, () =>
          resetRendererOn({ ...CONTEXTE_CLIENTE, isActive: false }).render(RESET_MESSAGE, FR),
        ),
      ).rejects.toBeInstanceOf(NotificationContextGoneError);
    });

    it('refuse un compte introuvable — ou d’un autre établissement', async () => {
      // Le client scopé ne distingue pas les deux, et c'est ce qui fait qu'une
      // enveloppe nommant le salon A ne peut rien rendre du salon B.
      await expect(
        runWithTenant(SALON, () => resetRendererOn(null).render(RESET_MESSAGE, FR)),
      ).rejects.toBeInstanceOf(NotificationContextGoneError);
    });

    it('refuse une enveloppe sans jeton plutôt que d’annoncer un lien vide', async () => {
      const { passwordResetToken: _ignore, ...sansJeton } = RESET_MESSAGE;

      await expect(
        runWithTenant(SALON, () => resetRendererOn(CONTEXTE_CLIENTE).render(sansJeton, FR)),
      ).rejects.toBeInstanceOf(UnrenderableNotificationError);
    });

    it('n’a aucun modèle de plateforme sur le canal SMS', async () => {
      // Quatrième critère : « canal e-mail ». Le SMS n'a pas de défaut, et le
      // refus laisse la ligne `FAILED` — donc reprenable — plutôt que de servir
      // le modèle d'un autre message.
      await expect(
        runWithTenant(SALON, () =>
          resetRendererOn(CONTEXTE_CLIENTE).render({ ...RESET_MESSAGE, channel: 'SMS' }, FR),
        ),
      ).rejects.toBeInstanceOf(UnrenderableNotificationError);
    });
  });
});
