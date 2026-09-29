import type { Locale } from '@spa/shared';

import {
  buildTemplateVariables,
  cancellationUrl,
  formatDateTimeInTenantTimeZone,
  formatMoney,
  formatTimeInTenantTimeZone,
  measureSmsTemplate,
  renderNotification,
  type NotificationDisplay,
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
 *
 * ## Ce que #854 y a changé, et ce qu'il n'y a pas changé non plus
 *
 * Le rendu prend désormais une **langue**. Cette suite garde la sienne fixée au
 * français, et c'est délibéré : ses assertions portent sur des mots — « Adresse »,
 * « septembre », « à très vite » — et les traduire toutes aurait transformé le
 * témoin du contenu français en témoin de rien. Ce que les modèles anglais
 * doivent tenir — exister pour chaque type, chaque canal, et rester sous le même
 * plafond de segments — est éprouvé là où cela se prouve, dans
 * `notification-default-templates.spec.ts`.
 *
 * La langue est donc un **paramètre par défaut** ici, et non une constante
 * cachée : une suite qui veut l'anglais la nomme, et le fait qu'elle soit
 * nommable est ce qui empêche ce fichier de redevenir implicitement francophone.
 */

/** La langue de cette suite — celle de ses assertions. */
const FR: Locale = 'fr';

/**
 * Un salon **parisien** — `fr-FR` en français, `en-FR` en anglais (#1344).
 *
 * Même couple de fabriques que `receipt-pdf.format.spec.ts`, et pour la même
 * raison : c'est la seule façon de distinguer ce que la **langue** décide — les
 * mots — de ce que le **pays du salon** décide — l'ordre d'une date, le cycle
 * horaire, les séparateurs d'un montant.
 */
const enFrance = (locale: Locale): NotificationDisplay => ({ locale, countryCode: 'FR' });

/** Un salon **new-yorkais** — `fr-US` en français, `en-US` en anglais. */
const auxEtatsUnis = (locale: Locale): NotificationDisplay => ({ locale, countryCode: 'US' });

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
  locale: Locale = FR,
): RenderedNotification {
  const source = defaultTemplateFor(type, channel, locale);

  if (source === null) {
    throw new Error(`Aucun modèle par défaut pour ${type} / ${channel} / ${locale}.`);
  }

  return renderNotification(
    source,
    buildTemplateVariables(context, cancelUrl, channel, recipientUserId, locale),
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
  tenantCountryCode: 'FR',
  tenantAddress: '12 rue des Lilas, 75011 Paris',
  tenantPhone: '+33123456789',
  appointmentReference: 'RDV-8F3K-27',
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

/**
 * **Le même rendez-vous, chez un salon new-yorkais** — #1344.
 *
 * Le même instant UTC : 12:30 Z vaut 08:30 à New York en septembre (UTC−4). Ce
 * contexte-ci existe pour le seul fait que la suite ne pouvait pas voir avec un
 * salon unique — que l'écriture d'une heure vient du **pays du salon** et non de la
 * langue du message.
 */
const NEW_YORK: AppointmentMessageContext = {
  ...PARIS,
  tenantName: 'Lotus House',
  tenantSlug: 'lotus-house',
  tenantTimeZone: 'America/New_York',
  tenantCountryCode: 'US',
  tenantAddress: '350 5th Avenue, New York, NY 10118',
};

/**
 * Sur sous-domaine depuis #837 : un salon est servi sur `{slug}.{domaine}`
 * (arbitrage du PO du 16/09/2026, #832). Les cas de repli par chemin et de mode
 * forcé vivent dans `tenant-subdomain-links.spec.ts`.
 */
const CANCEL_URL = 'https://maison-lotus.reservation.test/compte';

describe('notifications — l’heure est celle du salon, jamais UTC', () => {
  it('convertit l’instant UTC au fuseau du tenant', () => {
    // 12:30 UTC = 14:30 à Paris en septembre.
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris', enFrance(FR))).toContain(
      '14:30',
    );
  });

  it('rend le même instant différemment selon le fuseau de l’établissement', () => {
    // La preuve que la conversion a bien lieu : le même `Date`, deux salons.
    // 12:30 UTC = 15:30 à Antananarivo (UTC+3, sans heure d'été).
    expect(
      formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Indian/Antananarivo', enFrance(FR)),
    ).toContain('15:30');
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris', enFrance(FR))).toContain(
      '14:30',
    );
  });

  it('suit le changement d’heure — le même mur d’horloge, deux décalages', () => {
    // 11:30 UTC vaut 12:30 à Paris en hiver et 13:30 en été. Figer un décalage
    // décalerait la moitié de l'année.
    const hiver = new Date('2026-01-08T11:30:00Z');
    const ete = new Date('2026-07-08T11:30:00Z');

    expect(formatDateTimeInTenantTimeZone(hiver, 'Europe/Paris', enFrance(FR))).toContain('12:30');
    expect(formatDateTimeInTenantTimeZone(ete, 'Europe/Paris', enFrance(FR))).toContain('13:30');
  });

  it('le fuseau reste celui du salon quelle que soit la langue — #854', () => {
    // Troisième critère d'acceptation, et sa moitié la moins évidente : traduire
    // un message ne le déplace pas. Le rendez-vous est à 14:30 à Paris, qu'on
    // l'annonce en français ou en anglais — c'est le **fuseau du salon** qui fixe
    // l'heure, et la langue qui fixe les mots. Les confondre aurait fait arriver
    // une cliente anglophone deux heures plus tôt.
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris', enFrance('en'))).toContain(
      '14:30',
    );
  });

  it('écrit la date en toutes lettres, dans la langue d’envoi — #854', () => {
    // Le même instant, deux langues : c'est la preuve que le formatage suit la
    // langue du message et non une constante du code. « septembre » en dur dans
    // `notification-content.ts` aurait passé la moitié de ce témoin.
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris', enFrance('en'))).toContain(
      'September',
    );
    expect(
      formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris', enFrance('en')),
    ).not.toContain('septembre');
  });

  it('écrit la date en toutes lettres, en français', () => {
    expect(formatDateTimeInTenantTimeZone(PARIS.startsAt, 'Europe/Paris', enFrance(FR))).toContain(
      'septembre',
    );
  });
});

/**
 * **La locale de mise en forme d'un message — #1344.**
 *
 * Ce qui s'y prouve, et que rien ne prouvait : que l'écriture d'une heure, d'une
 * date et d'un montant vient du **pays de l'établissement** et non de la langue de
 * la destinataire, et que le cycle horaire n'est forcé nulle part.
 *
 * ## La même horloge que le reçu, dans la forme brève du produit
 *
 * L'**horloge** attendue ici est celle de `receipt-pdf.format.spec.ts` pour les
 * mêmes entrées — 24 heures chez le salon parisien dans les deux langues, 12 h
 * chez le salon new-yorkais dans les deux langues. C'est ce que demande le
 * quatrième critère d'acceptation, et c'est ce que la divergence d'origine
 * violait : un e-mail daté « 11:30 AM » et un PDF daté « 11:30 » pour la même
 * vente, en faisant passer les deux suites.
 *
 * La **forme** est celle des heures en prose du produit — `timeStyle: 'short'`,
 * comme `formatTimeInTimeZone` du front, donc « 8:30 AM ». Le reçu et le ticket à
 * l'écran écrivent « 08:30 AM », parce qu'ils datent en colonne de chiffres
 * (« 17/09/2026 08:30 AM »). Les deux disent la même heure sur la même horloge ;
 * et le septet que la forme brève économise est ce qui tient l'avis d'annulation
 * anglais dans un seul segment chez un salon canadien.
 */
describe('notifications — la locale de mise en forme suit le pays du salon', () => {
  /** L'instant du rendez-vous : 14:30 à Paris, 08:30 à New York. */
  const INSTANT = PARIS.startsAt;

  it('n’écrit pas 12 heures à un salon parisien qui lit l’anglais', () => {
    // Le constat de l'issue, dans sa forme la plus courte. La langue décidait de
    // l'horloge : une cliente anglophone de la Maison Lotus lisait « 2:30 PM »
    // quand le reçu de la même vente écrivait « 14:30 ».
    expect(formatTimeInTenantTimeZone(INSTANT, 'Europe/Paris', enFrance('en'))).toBe('14:30');
    expect(formatTimeInTenantTimeZone(INSTANT, 'Europe/Paris', enFrance('en'))).not.toContain('PM');
  });

  it('écrit 12 heures à un salon américain, dans les deux langues qu’il sert', () => {
    // Le pendant : ce n'est pas « 24 heures partout », c'est « l'horloge du pays ».
    // Et elle ne change pas quand le message part en français — le salon est le
    // même, sa convention aussi.
    expect(formatTimeInTenantTimeZone(INSTANT, 'America/New_York', auxEtatsUnis('en'))).toBe(
      '8:30 AM',
    );
    expect(formatTimeInTenantTimeZone(INSTANT, 'America/New_York', auxEtatsUnis(FR))).toBe('08:30');
  });

  it('garde les mots de la langue et l’ordre de la date du pays', () => {
    // Les quatre écritures d'un même instant. C'est le seul témoin qui distingue
    // ce que la langue décide de ce que le pays décide : « September 8 » contre
    // « 8 September » est une affaire de pays, « Tuesday » contre « mardi » une
    // affaire de langue.
    expect(formatDateTimeInTenantTimeZone(INSTANT, 'Europe/Paris', enFrance(FR))).toBe(
      'mardi 8 septembre 2026 à 14:30',
    );
    expect(formatDateTimeInTenantTimeZone(INSTANT, 'Europe/Paris', enFrance('en'))).toBe(
      'Tuesday, 8 September 2026 at 14:30',
    );
    expect(formatDateTimeInTenantTimeZone(INSTANT, 'America/New_York', auxEtatsUnis('en'))).toBe(
      'Tuesday, September 8, 2026 at 8:30 AM',
    );
    expect(formatDateTimeInTenantTimeZone(INSTANT, 'America/New_York', auxEtatsUnis(FR))).toBe(
      'mardi 8 septembre 2026 à 08:30',
    );
  });

  it('écrit le montant avec les séparateurs du pays, jamais ceux de la langue', () => {
    // CLDR déclare pour `en-FR` des séparateurs **monétaires** à l'anglaise et des
    // séparateurs ordinaires à la française : sans `withPlainSeparators`, l'e-mail
    // d'un salon parisien lu en anglais écrivait « €65.00 » là où le reçu de la
    // même vente écrit « €65,00 ».
    expect(formatMoney(6_500, 'EUR', enFrance('en'))).toBe('€65,00');
    expect(formatMoney(6_500, 'EUR', auxEtatsUnis('en'))).toBe('€65.00');
  });

  it('retombe sur la région du marché de la langue quand le salon n’a pas de pays', () => {
    // `tenants.country_code` est nullable : un salon qui n'a pas publié son
    // adresse n'a pas de région. Le repli est celui de la règle unique — documenté
    // et figé dans `@spa/shared` —, jamais celui du serveur, qui ferait varier la
    // date d'un conteneur ECS à l'autre pour le même salon.
    expect(formatTimeInTenantTimeZone(INSTANT, 'Europe/Paris', { locale: FR })).toBe('14:30');
    expect(formatTimeInTenantTimeZone(INSTANT, 'America/New_York', { locale: 'en' })).toBe(
      '8:30 AM',
    );
    expect(formatTimeInTenantTimeZone(INSTANT, 'Europe/Paris', { locale: FR, countryCode: null })).toBe(
      '14:30',
    );
  });

  it('écrit la confirmation d’un salon américain à l’heure de son pays', () => {
    // Le rendu complet, et non seulement le formateur : c'est lui que la cliente
    // lit, et c'est par `buildTemplateVariables` que le pays du contexte doit
    // arriver jusqu'à l'étiquette.
    const francais = renderDefault('BOOKING_CONFIRMATION', 'EMAIL', NEW_YORK, CANCEL_URL);
    const anglais = renderDefault(
      'BOOKING_CONFIRMATION',
      'EMAIL',
      NEW_YORK,
      CANCEL_URL,
      NEW_YORK.clientId,
      'en',
    );

    expect(francais.text).toContain('08:30');
    expect(francais.text).not.toContain('AM');
    expect(anglais.text).toContain('8:30 AM');
    expect(anglais.subject).toContain('8:30 AM');
  });

  it('n’annonce pas la même heure à deux salons de fuseaux différents', () => {
    // La garantie que le pays n'a pas emporté le fuseau au passage : le même
    // instant, deux salons, deux heures — 14:30 à Paris, 08:30 à New York.
    const paris = buildTemplateVariables(PARIS, '', 'EMAIL', PARIS.clientId, 'en');
    const newYork = buildTemplateVariables(NEW_YORK, '', 'EMAIL', NEW_YORK.clientId, 'en');

    expect(paris.heure).toBe('14:30');
    expect(newYork.heure).toBe('8:30 AM');
  });

  /**
   * **La mesure d'un SMS suit le pays du salon, elle aussi — #1344.**
   *
   * Ce que cette assertion ferme : une région de repli commune aurait laissé la
   * validation de modèle mesurer un salon de Montréal à Paris ou à New York, alors
   * que `fr-CA` écrit « 14 h 30 » et `en-CA` « 2:30 p.m. » — deux caractères de
   * plus à chaque fois. Le salon se serait vu annoncer un segment pour un message
   * qui lui en coûte deux, ce que la validation existe précisément pour empêcher
   * (#854, septième critère ; notifications §5).
   *
   * Les trois pays sont ceux dont le produit connaît l'adresse : France (#1334),
   * États-Unis et Canada (#1339).
   */
  it('mesure un modèle dans l’écriture du pays, et non dans celle d’un marché commun', () => {
    // Deux caractères de plus au Canada, dans chacune des deux langues — c'est
    // exactement l'écart qui fait basculer un segment en deux sur un modèle qui
    // frôle la borne.
    const date = '{{date}}';

    expect(measureSmsTemplate(date, { locale: 'en', countryCode: 'CA' }).units).toBe(
      measureSmsTemplate(date, { locale: 'en', countryCode: 'US' }).units + 2,
    );
    expect(measureSmsTemplate(date, { locale: FR, countryCode: 'CA' }).units).toBe(
      measureSmsTemplate(date, { locale: FR, countryCode: 'FR' }).units + 2,
    );
  });

  /**
   * Le pendant côté langue, qui ne doit pas disparaître : la mesure reste une
   * fonction de la langue autant que du pays (#854, septième critère).
   */
  it('mesure un modèle anglais plus cher qu’un modèle français, à pays égal', () => {
    expect(measureSmsTemplate('{{date}}', { locale: 'en', countryCode: 'FR' }).units).toBeGreaterThan(
      measureSmsTemplate('{{date}}', { locale: FR, countryCode: 'FR' }).units,
    );
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
    expect(formatMoney(6_500, 'EUR', enFrance(FR))).toContain('65');
    // Une devise sans décimale n'est pas divisée par cent : `Intl` le sait.
    expect(formatMoney(6_500, 'JPY', enFrance(FR))).toContain('6');
    expect(formatMoney(6_500, 'JPY', enFrance(FR))).not.toContain('65,00');
  });

  it('écrit le montant selon la langue et le pays, sans changer la valeur — #854', () => {
    // Le salon parisien met le symbole après et sépare par une virgule décimale,
    // le salon américain met le symbole avant et sépare par un point. C'est une
    // écriture qui change, jamais un montant : les deux disent soixante-cinq
    // euros. Depuis #1344 c'est le **pays** qui en décide, et non la langue :
    // « €65,00 » pour le salon parisien lu en anglais.
    expect(formatMoney(6_500, 'EUR', auxEtatsUnis('en'))).toContain('65');
    expect(formatMoney(6_500, 'EUR', auxEtatsUnis('en'))).not.toContain('65,00');
    expect(formatMoney(6_500, 'EUR', enFrance('en'))).not.toContain('65.00');
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

/**
 * Ce que la confirmation **affirme** — #911.
 *
 * Elle part sur `appointment.created`, donc sur un rendez-vous que le dépôt vient
 * d'écrire au statut `PENDING` : « votre rendez-vous est confirmé » y était faux
 * au moment même de l'envoi, et contredisait l'espace client qui affiche, sur ce
 * rendez-vous-là, « À confirmer par le salon » (#743).
 *
 * Ces assertions pincent le **fait annoncé**, pas le style. Le jour où la
 * confirmation deviendra un message du salon — s'il y en a un un jour —, ce sont
 * elles qui diront qu'il faut reprendre le gabarit, et non une relecture.
 */
describe('notifications — ce que la confirmation affirme', () => {
  it('dit la réservation enregistrée et la confirmation attendue du salon', () => {
    const { subject, text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(subject).toContain('À confirmer par le salon');
    expect(text).toContain('est enregistré');
    expect(text).toContain('à confirmer par le salon');
  });

  it('n’annonce pas un rendez-vous « confirmé » — il ne l’est pas encore', () => {
    const { subject, html, text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(subject).not.toContain('est confirmé');
    expect(html).not.toContain('est confirmé');
    expect(text).not.toContain('est confirmé');
  });

  it('annonce le message qui suivra la confirmation, que `APPOINTMENT_CONFIRMED` tient', () => {
    // Jusqu'à #800, rien ne partait à la confirmation et la phrase aurait été
    // une promesse creuse. `APPOINTMENT_CONFIRMED` part désormais quand le salon
    // confirme : la promesse est tenue, et la dire évite à la cliente de
    // surveiller son espace.
    const { html, text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(text).toContain('vous recevrez un message dès que ce sera fait');
    expect(html).toContain('vous recevrez un message dès que ce sera fait');
    expect(defaultTemplateFor('APPOINTMENT_CONFIRMED', 'EMAIL', FR)).not.toBeNull();
  });
});

/**
 * « Votre rendez-vous est confirmé » — #800.
 *
 * Le pendant de ce qui précède : ce message part quand le salon confirme, et il
 * dit l'inverse du premier. Ces assertions pincent le fait annoncé — confirmé,
 * par le salon — et ce que la cliente doit y retrouver pour s'en servir le
 * jour J : la référence, l'heure dans le fuseau du salon, le lien.
 */
describe('notifications — le salon a confirmé', () => {
  it('dit que le salon a confirmé, et plus « à confirmer »', () => {
    const { subject, html, text } = renderDefault('APPOINTMENT_CONFIRMED', 'EMAIL', PARIS, CANCEL_URL);

    expect(subject).toContain('Rendez-vous confirmé');
    expect(subject).toContain('Maison Lotus');
    expect(text).toContain('Maison Lotus a confirmé votre rendez-vous');
    expect(html).toContain('Maison Lotus a confirmé votre rendez-vous');
    expect(`${subject}
${html}
${text}`.toLowerCase()).not.toContain('à confirmer');
  });

  it('porte la référence, l’heure du salon et le lien pour modifier', () => {
    const { subject, html, text } = renderDefault('APPOINTMENT_CONFIRMED', 'EMAIL', PARIS, CANCEL_URL);

    // 12:30 UTC vaut 14:30 à Paris en septembre : l'instant UTC affiché tel quel
    // avancerait le rendez-vous de deux heures (CLAUDE.md, sévérité haute).
    expect(subject).toContain('14:30');
    expect(text).toContain('RDV-8F3K-27');
    expect(text).toContain(CANCEL_URL);
    expect(html).toContain(CANCEL_URL);
    expect(text).not.toContain('<');
  });

  it('a son SMS, qui dit la même chose en une phrase', () => {
    const { text } = renderDefault('APPOINTMENT_CONFIRMED', 'SMS', PARIS, '');

    expect(text).toContain('Maison Lotus');
    expect(text).toContain('14:30');
    expect(text).toContain('est confirmé');
  });
});

/**
 * « Votre rendez-vous a été déplacé » — ce que la cliente doit y lire : que le
 * rendez-vous a bougé, et sa **nouvelle** heure dans le fuseau du salon.
 */
describe('notifications — le rendez-vous a été déplacé', () => {
  it('dit le déplacement et la nouvelle heure, dans le fuseau du salon', () => {
    const { subject, html, text } = renderDefault(
      'APPOINTMENT_RESCHEDULED',
      'EMAIL',
      PARIS,
      CANCEL_URL,
    );

    expect(subject).toContain('Rendez-vous déplacé');
    expect(subject).toContain('14:30');
    expect(text).toContain('Votre rendez-vous chez Maison Lotus a été déplacé');
    expect(html).toContain('Votre rendez-vous chez Maison Lotus a été déplacé');
    expect(text).toContain('RDV-8F3K-27');
    expect(text).toContain(CANCEL_URL);
    expect(text).not.toContain('<');
  });

  it('a son SMS, qui dit la même chose en une phrase', () => {
    const { text } = renderDefault('APPOINTMENT_RESCHEDULED', 'SMS', PARIS, '');

    expect(text).toContain('Maison Lotus');
    expect(text).toContain('14:30');
    expect(text).toContain('déplacé');
  });
});

describe('notifications — le lien d’annulation', () => {
  it('figure dans l’e-mail, en HTML comme en texte', () => {
    const { html, text } = renderBookingConfirmationEmail(PARIS, CANCEL_URL);

    expect(html).toContain(CANCEL_URL);
    expect(text).toContain(CANCEL_URL);
  });

  it('se compose depuis l’origine du front et le sous-domaine de l’établissement', () => {
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

  it('dit la confirmation attendue, comme l’e-mail parti au même instant', () => {
    // Les deux canaux partent du même `appointment.created` : n'en corriger
    // qu'un aurait fait arriver, sur la même réservation, deux messages qui se
    // contredisent (#911).
    const { text } = renderBookingConfirmationSms(PARIS);

    expect(text).toContain('à confirmer par le salon');
    expect(text).not.toContain('rendez-vous confirmé');
  });

  it('emploie la minuscule « à », seule accentuée que GSM-7 connaisse', () => {
    // La capitale `À` du libellé du front n'est pas dans l'alphabet de base :
    // elle basculerait le message en UCS-2 et doublerait son coût
    // (notifications §5). Le coût lui-même est mesuré sur le modèle, dans
    // `notification-template.spec.ts` ; ici c'est le caractère qu'on pince.
    const { text } = renderBookingConfirmationSms(PARIS);

    expect(text).not.toContain('À');
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
