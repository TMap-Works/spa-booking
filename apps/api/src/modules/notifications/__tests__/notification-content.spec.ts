import {
  SMS_SINGLE_SEGMENT_UCS2,
  cancellationUrl,
  escapeHtml,
  formatDateTimeInTenantTimeZone,
  formatMoney,
  renderBookingConfirmationEmail,
  renderBookingConfirmationSms,
} from '../notification-content';
import type { AppointmentMessageContext } from '../notifications.types';

/**
 * Les modèles de la confirmation de réservation — trois des cinq critères
 * d'acceptation de #70 : le récapitulatif, le lien d'annulation, et l'heure
 * affichée dans le fuseau du salon.
 *
 * Ces fonctions sont pures : la suite n'ouvre ni base, ni module Nest, et
 * n'appelle aucune horloge. Ce qu'elle mesure est ce qu'une cliente lira.
 */

/**
 * Un salon à Paris, un rendez-vous en **heure d'été**.
 *
 * `2026-09-08T12:30:00Z` vaut 14:30 à Paris (UTC+2 en septembre). Ce décalage de
 * deux heures est le cœur du quatrième critère : afficher l'instant UTC tel quel
 * avancerait le rendez-vous de deux heures dans l'esprit de la cliente — le bug
 * de sévérité haute que CLAUDE.md nomme.
 */
const PARIS: AppointmentMessageContext = {
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
