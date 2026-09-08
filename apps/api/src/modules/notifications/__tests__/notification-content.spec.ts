import {
  buildTemplateVariables,
  cancellationUrl,
  formatDateTimeInTenantTimeZone,
  formatMoney,
  renderNotification,
} from '../notification-content';
import { defaultTemplateFor } from '../notification-default-templates';
import { SMS_SINGLE_SEGMENT_UCS2, escapeHtml } from '../notification-template';
import type {
  AppointmentMessageContext,
  NotificationChannel,
  RenderedNotification,
  NotificationType,
} from '../notifications.types';

/**
 * Les modèles de la confirmation de réservation — trois des cinq critères
 * d'acceptation de #70 : le récapitulatif, le lien d'annulation, et l'heure
 * affichée dans le fuseau du salon.
 *
 * Ces fonctions sont pures : la suite n'ouvre ni base, ni module Nest, et
 * n'appelle aucune horloge. Ce qu'elle mesure est ce qu'une cliente lira.
 *
 * ## Ce que #69 y a changé, et ce qu'il n'y a pas changé
 *
 * Les quatre messages ne sont plus des fonctions : ce sont les **modèles par
 * défaut de la plateforme** (`notification-default-templates.ts`), rendus par le
 * moteur de `notification-template.ts`. Aucune assertion n'a bougé pour autant,
 * et c'est le point : cette suite est la preuve que le passage aux modèles en
 * base n'a rien changé à ce qu'une cliente lit. Les quatre fonctions locales
 * ci-dessous ne font que rendre le défaut du couple `(type, canal)` — elles
 * n'existent que pour que les assertions restent lisibles.
 */

/**
 * Rend le modèle **par défaut** de ce message — ce que reçoit un salon qui n'a
 * rien personnalisé.
 *
 * Le destinataire vaut la cliente sauf mention contraire : c'est le cas des
 * trois quarts des messages du MVP, et le seul que la confirmation et le rappel
 * connaissent. L'avis d'annulation est le seul à en avoir deux, et les suites
 * qui l'éprouvent nomment celui qu'elles veulent (#534).
 */
function renderDefault(
  type: NotificationType,
  channel: NotificationChannel,
  context: AppointmentMessageContext,
  cancelUrl: string,
  recipientUserId: string = context.clientId,
): RenderedNotification {
  const source = defaultTemplateFor(type, channel);

  if (source === null) {
    throw new Error(`Aucun modèle par défaut pour ${type} / ${channel}.`);
  }

  return renderNotification(
    source,
    buildTemplateVariables(context, cancelUrl, channel, recipientUserId),
    channel,
  );
}

const renderBookingConfirmationEmail = (
  context: AppointmentMessageContext,
  cancelUrl: string,
): RenderedNotification => renderDefault('BOOKING_CONFIRMATION', 'EMAIL', context, cancelUrl);

const renderReminderEmail = (
  context: AppointmentMessageContext,
  cancelUrl: string,
): RenderedNotification => renderDefault('REMINDER_24H', 'EMAIL', context, cancelUrl);

// Le SMS n'a pas de lien d'annulation : le détail est dans l'e-mail, qui part
// toujours. L'URL passée n'est donc jamais substituée — le modèle ne la nomme pas.
const renderBookingConfirmationSms = (context: AppointmentMessageContext): RenderedNotification =>
  renderDefault('BOOKING_CONFIRMATION', 'SMS', context, '');

const renderReminderSms = (context: AppointmentMessageContext): RenderedNotification =>
  renderDefault('REMINDER_24H', 'SMS', context, '');

const renderCancellationEmail = (
  context: AppointmentMessageContext,
  cancelUrl: string,
  recipientUserId: string = context.clientId,
): RenderedNotification =>
  renderDefault('CANCELLATION', 'EMAIL', context, cancelUrl, recipientUserId);

const renderCancellationSms = (context: AppointmentMessageContext): RenderedNotification =>
  renderDefault('CANCELLATION', 'SMS', context, '');

/**
 * Un salon à Paris, un rendez-vous en **heure d'été**.
 *
 * `2026-09-08T12:30:00Z` vaut 14:30 à Paris (UTC+2 en septembre). Ce décalage de
 * deux heures est le cœur du quatrième critère : afficher l'instant UTC tel quel
 * avancerait le rendez-vous de deux heures dans l'esprit de la cliente — le bug
 * de sévérité haute que CLAUDE.md nomme.
 */
/** Le compte de la cliente du rendez-vous. */
const CLIENT = '33333333-3333-4333-8333-333333333333';

/** Le compte du praticien — l'autre destinataire de l'avis d'annulation. */
const PRATICIEN = '66666666-6666-4666-8666-666666666666';

const PARIS: AppointmentMessageContext = {
  tenantName: 'Maison Lotus',
  tenantSlug: 'maison-lotus',
  tenantTimeZone: 'Europe/Paris',
  tenantAddress: '12 rue des Lilas, 75011 Paris',
  tenantPhone: '+33123456789',
  clientId: CLIENT,
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

const CANCEL_URL = 'https://reservation.test/maison-lotus/compte';

describe('notifications — l’heure est celle du salon, jamais UTC', () => {
  it('convertit l’instant UTC au fuseau du tenant', () => {
    // 12:30 UTC = 14:30 à Paris en septembre.
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris')).toContain('14:30');
  });

  it('rend le même instant différemment selon le fuseau de l’établissement', () => {
    // La preuve que la conversion a bien lieu : le même `Date`, deux salons.
    // 12:30 UTC = 15:30 à Antananarivo (UTC+3, sans heure d'été).
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Indian/Antananarivo')).toContain(
      '15:30',
    );
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris')).toContain('14:30');
  });

  it('suit le changement d’heure — le même mur d’horloge, deux décalages', () => {
    // 11:30 UTC vaut 12:30 à Paris en hiver et 13:30 en été. Figer un décalage
    // décalerait la moitié de l'année.
    const hiver = new Date('2026-01-08T11:30:00Z');
    const ete = new Date('2026-07-08T11:30:00Z');

    expect(formatDateTimeInTenantTimeZone(hiver, 'Europe/Paris')).toContain('12:30');
    expect(formatDateTimeInTenantTimeZone(ete, 'Europe/Paris')).toContain('13:30');
  });

  it('écrit la date en toutes lettres, en français', () => {
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris')).toContain('septembre');
  });
});

describe('notifications — le récapitulatif de la confirmation', () => {
  it('porte la prestation, le praticien, l’heure, la fin et le prix', () => {
    const { text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(text).toContain('Massage suédois');
    expect(text).toContain('Claire D.');
    expect(text).toContain('14:30');
    expect(text).toContain('15:30');
    expect(text).toContain('Amina Rakoto');
  });

  it('nomme le fuseau employé — « 14:30 » seul serait ambigu', () => {
    const { text, html } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(text).toContain('Europe/Paris');
    expect(html).toContain('Europe/Paris');
  });

  it('donne le prix sans jamais passer par un flottant du domaine', () => {
    // 6 500 centimes = 65,00 €. Le domaine ne manipule que l'entier ; la
    // division n'a lieu qu'ici, pour l'écriture.
    expect(formatMoney(6_500, 'EUR')).toContain('65');
    // Une devise sans décimale n'est pas divisée par cent : `Intl` le sait.
    expect(formatMoney(6_500, 'JPY')).toContain('6');
    expect(formatMoney(6_500, 'JPY')).not.toContain('65,00');
  });

  it('omet l’adresse et le téléphone quand le salon ne les a pas renseignés', () => {
    const sansAdresse = { ...PARIS, tenantAddress: null, tenantPhone: null };
    const { text } = renderBookingConfirmationEmail(sansAdresse, CANCEL_URL);

    expect(text).not.toContain('Adresse');
    expect(text).not.toContain('Téléphone');
  });

  it('fournit toujours une version texte à côté du HTML', () => {
    // Un e-mail qui n'a que du HTML est pénalisé par les filtres anti-spam
    // (notifications §6), et la confirmation finirait en indésirables.
    const { html, text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('<');
  });

  it('annonce l’établissement dans l’objet, avec la date', () => {
    const { subject } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(subject).toContain('Maison Lotus');
    expect(subject).toContain('14:30');
  });
});

describe('notifications — le lien d’annulation', () => {
  it('figure dans l’e-mail, en HTML comme en texte', () => {
    const { html, text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(html).toContain(CANCEL_URL);
    expect(text).toContain(CANCEL_URL);
  });

  it('se compose depuis l’origine du front et le slug de l’établissement', () => {
    expect(cancellationUrl('https://reservation.test', 'maison-lotus')).toBe(CANCEL_URL);
  });

  it('tolère une origine à barre oblique finale sans doubler le séparateur', () => {
    expect(cancellationUrl('https://reservation.test/', 'maison-lotus')).toBe(CANCEL_URL);
  });

  it('encode un slug qui aurait besoin de l’être', () => {
    expect(cancellationUrl('https://reservation.test', 'salon/évasion')).toBe(
      'https://reservation.test/salon%2F%C3%A9vasion/compte',
    );
  });
});

describe('notifications — l’échappement des variables', () => {
  it('neutralise le HTML d’un nom de cliente', () => {
    // `users.first_name` est une chaîne libre de 80 caractères : sans
    // échappement, une balise dans un nom casse le rendu ou y injecte
    // (notifications §6).
    const injection = {
      ...PARIS,
      clientFirstName: '<script>alert(1)</script>',
      clientLastName: 'X',
    };
    const { html } = renderBookingConfirmationEmail(injection, CANCEL_URL);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('n’échappe rien dans la version texte, où ce serait illisible', () => {
    const { text } = renderBookingConfirmationEmail(
      { ...PARIS, serviceName: 'Coupe & brushing' },
      CANCEL_URL,
    );

    expect(text).toContain('Coupe & brushing');
    expect(text).not.toContain('&amp;');
  });

  it('traite l’esperluette en premier, sans double échappement', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('échappe aussi les guillemets, qui casseraient l’attribut `href`', () => {
    expect(escapeHtml('"x\'y')).toBe('&quot;x&#39;y');
  });
});

describe('notifications — le SMS de confirmation', () => {
  it('annonce le même fait, en une phrase', () => {
    const { text } = renderBookingConfirmationSms(PARIS);

    expect(text).toContain('Maison Lotus');
    expect(text).toContain('14:30');
  });

  it('ne porte ni HTML ni objet — un expéditeur SNS ne lit que le texte', () => {
    const { subject, html } = renderBookingConfirmationSms(PARIS);

    expect(subject).toBe('');
    expect(html).toBe('');
  });

  it('reste sous trois segments UCS-2, même avec un nom d’établissement démesuré', () => {
    // Le SMS coûte cher et varie par pays (notifications §5) : la borne est un
    // plafond de facture, pas une préférence de style.
    const { text } = renderBookingConfirmationSms({ ...PARIS, tenantName: 'é'.repeat(400) });

    expect(text.length).toBeLessThanOrEqual(SMS_SINGLE_SEGMENT_UCS2 * 3);
  });

  it('écourte le nom du salon plutôt que la date — c’est elle qu’on lit', () => {
    // `tenants.name` accepte 160 caractères : tronquer la phrase entière
    // emporterait l'heure du rendez-vous, c'est-à-dire la seule chose que ce
    // SMS existe pour dire.
    const { text } = renderBookingConfirmationSms({ ...PARIS, tenantName: 'Le '.repeat(50) });

    expect(text).toContain('14:30');
    expect(text).toContain('(Europe/Paris)');
  });
});

/**
 * Les modèles du rappel J-1 — #71.
 *
 * Ils partagent le récapitulatif de la confirmation, et affirment autre chose :
 * la confirmation dit « c'est enregistré », le rappel dit « voici comment vous
 * décommander ». C'est ce second membre de phrase qui réduit le no-show, donc la
 * perte de chiffre d'affaires (CDC §1.4).
 */
describe('notifications — le rappel J-1', () => {
  it('n’annonce pas un rendez-vous « confirmé » — ce n’est pas ce message-là', () => {
    const { subject, text } = renderReminderEmail(PARIS, CANCEL_URL);

    expect(subject).toContain('Rappel');
    expect(subject).not.toContain('confirmé');
    expect(text).not.toContain('est confirmé');
  });

  it('donne la date complète plutôt que « demain »', () => {
    // Le rappel part entre 24 et 25 heures à l'avance : « demain » est vrai
    // presque toujours, et « presque toujours » n'est pas une garantie qu'un
    // modèle a le droit de prendre.
    const { text, html } = renderReminderEmail(PARIS, CANCEL_URL);

    expect(text).not.toContain('demain');
    expect(html).not.toContain('demain');
    expect(text).toContain('14:30');
  });

  it('affiche l’heure dans le fuseau du salon, et le dit', () => {
    const { text } = renderReminderEmail(PARIS, CANCEL_URL);

    // 12:30 UTC = 14:30 à Paris en septembre. Sans mention du fuseau, « 14:30 »
    // est ambigu pour une cliente qui voyage.
    expect(text).toContain('14:30');
    expect(text).toContain('Europe/Paris');
    expect(text).not.toContain('12:30');
  });

  it('porte le récapitulatif et le lien d’annulation', () => {
    const { text, html } = renderReminderEmail(PARIS, CANCEL_URL);

    expect(text).toContain('Massage suédois');
    expect(text).toContain('Claire D.');
    expect(text).toContain(CANCEL_URL);
    expect(html).toContain(`href="${CANCEL_URL}"`);
  });

  it('échappe les variables dans le corps HTML, et seulement là', () => {
    const hostile = { ...PARIS, clientFirstName: '<script>alert(1)</script>' };

    const { html, text } = renderReminderEmail(hostile, CANCEL_URL);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // Le corps texte n'échappe rien : des `&amp;` y seraient visibles.
    expect(text).toContain('<script>');
  });

  it('rend une version texte à côté du HTML — un e-mail sans texte finit en indésirables', () => {
    const { html, text } = renderReminderEmail(PARIS, CANCEL_URL);

    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
  });

  it('reste un avis en SMS : ni objet, ni HTML, et sous trois segments UCS-2', () => {
    const { subject, html, text } = renderReminderSms({ ...PARIS, tenantName: 'é'.repeat(400) });

    expect(subject).toBe('');
    expect(html).toBe('');
    expect(text.length).toBeLessThanOrEqual(SMS_SINGLE_SEGMENT_UCS2 * 3);
  });

  it('dit en SMS que c’est un rappel, avec l’heure du salon', () => {
    const { text } = renderReminderSms(PARIS);

    expect(text).toContain('rappel');
    expect(text).toContain('14:30');
    expect(text).toContain('(Europe/Paris)');
  });
});

/**
 * L'avis d'annulation — #72, troisième message du MVP.
 *
 * Ce qui s'y vérifie et qui ne se vérifie nulle part ailleurs : que le message
 * **dit d'où vient l'annulation** (troisième critère d'acceptation), qu'il reste
 * lisible par ses deux publics — la cliente et le praticien —, et qu'il ne
 * transporte jamais le motif.
 */
describe('notifications — l’avis d’annulation', () => {
  const SALON_ANNULE: AppointmentMessageContext = { ...PARIS, cancelledBy: 'STAFF' };
  const CLIENTE_ANNULE: AppointmentMessageContext = { ...PARIS, cancelledBy: 'CLIENT' };

  it('mentionne l’origine de l’annulation, et elle change avec elle', () => {
    const salon = renderCancellationEmail(SALON_ANNULE, CANCEL_URL);
    const cliente = renderCancellationEmail(CLIENTE_ANNULE, CANCEL_URL);

    expect(salon.text).toContain("annulé à l'initiative du salon");
    expect(cliente.text).toContain('annulé à la demande du client');
  });

  it('ne s’adresse à personne en particulier — le même modèle sert les deux publics', () => {
    // Le CDC §1.4 veut « un avis d'annulation au staff et au client », et
    // l'unique de `notification_templates` est `(tenant_id, type, channel)` : il
    // n'y a qu'un modèle pour les deux. « Bonjour Amina » aurait salué le
    // praticien du nom de sa cliente.
    const { text, html } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL);

    expect(text).toContain('Bonjour,');
    expect(text).not.toContain('Bonjour Amina');
    expect(html).not.toContain('Bonjour Amina');
  });

  it('nomme la cliente dans le récapitulatif — c’est ce que le praticien cherche', () => {
    const { text, html } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL);

    expect(text).toContain('Amina Rakoto');
    expect(text).toContain('Massage suédois');
    expect(text).toContain('Claire D.');
    expect(html).toContain('Amina Rakoto');
  });

  it('affiche l’heure dans le fuseau du salon, et le dit', () => {
    const { text } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL);

    expect(text).toContain('14:30');
    expect(text).toContain('Europe/Paris');
    expect(text).not.toContain('12:30');
  });

  it('n’annonce pas un rendez-vous à qui vient de l’annuler', () => {
    const { text } = renderCancellationEmail(CLIENTE_ANNULE, CANCEL_URL);

    expect(text).not.toContain('Nous vous attendons');
    expect(text).toContain('de nouveau disponible');
  });

  it('efface la mention d’origine quand il n’y en a pas', () => {
    // La section, et non une valeur de repli : « a été annulé . » avec une
    // espace en trop est ce qu'une substitution nue aurait produit.
    const { text } = renderCancellationEmail(PARIS, CANCEL_URL);

    expect(text).toContain('a été annulé.');
    expect(text).not.toContain('annulé .');
  });

  it('échappe les variables dans le corps HTML, et seulement là', () => {
    const hostile = { ...SALON_ANNULE, clientFirstName: '<script>alert(1)</script>' };

    const { html, text } = renderCancellationEmail(hostile, CANCEL_URL);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(text).toContain('<script>');
  });

  it('rend une version texte à côté du HTML', () => {
    const { html, text } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL);

    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
  });

  it('invite la cliente à reprendre rendez-vous', () => {
    const { html, text } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL, CLIENT);

    expect(text).toContain(`Prendre un nouveau rendez-vous : ${CANCEL_URL}`);
    expect(html).toContain(`<a href="${CANCEL_URL}">Prendre un nouveau rendez-vous</a>`);
  });

  it('ne propose pas au praticien de prendre rendez-vous chez lui — #534', () => {
    // Le constat n°7 de la revue de #533. Le modèle est unique par
    // `(tenant_id, type, channel)` et sert désormais les deux publics sur la
    // **même** annulation : ce qui ne vaut que pour la cliente doit s'effacer
    // pour l'autre, sans quoi le praticien lit une invitation à réserver dans
    // son propre salon et un lien vers un espace qui n'est pas son agenda.
    const { html, text } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL, PRATICIEN);

    expect(text).not.toContain('Prendre un nouveau rendez-vous');
    expect(html).not.toContain('Prendre un nouveau rendez-vous');
    expect(text).not.toContain(CANCEL_URL);
    expect(html).not.toContain(CANCEL_URL);
  });

  it('dit au praticien tout le reste — le retrait ne vaut que pour le lien', () => {
    // Ce qui compte pour lui est ailleurs, et doit rester : de qui il s'agit,
    // quelle prestation, quand, et d'où vient la décision.
    const { text } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL, PRATICIEN);

    expect(text).toContain('Amina Rakoto');
    expect(text).toContain('Massage suédois');
    expect(text).toContain("annulé à l'initiative du salon");
    expect(text).toContain('de nouveau disponible');
  });

  it('ne laisse pas de ligne vide à la place du lien retiré', () => {
    // La section emporte son saut de ligne : un avis au praticien ne doit pas
    // porter la cicatrice de ce qu'il ne reçoit pas.
    const { text } = renderCancellationEmail(SALON_ANNULE, CANCEL_URL, PRATICIEN);

    expect(text).not.toMatch(/\n{3}/);
  });

  it('reste un avis en SMS : ni objet, ni HTML, et sous trois segments UCS-2', () => {
    const { subject, html, text } = renderCancellationSms({
      ...SALON_ANNULE,
      tenantName: 'é'.repeat(400),
    });

    expect(subject).toBe('');
    expect(html).toBe('');
    expect(text.length).toBeLessThanOrEqual(SMS_SINGLE_SEGMENT_UCS2 * 3);
  });

  it('dit en SMS que le rendez-vous est annulé, d’où cela vient, et à quelle heure', () => {
    const { text } = renderCancellationSms(SALON_ANNULE);

    expect(text).toContain('annulé');
    expect(text).toContain("à l'initiative du salon");
    expect(text).toContain('14:30');
    expect(text).toContain('(Europe/Paris)');
  });
});
