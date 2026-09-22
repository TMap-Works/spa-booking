import { LOCALES, type Locale } from '@spa/shared';

import { measureSmsTemplate } from '../notification-content';
import { DEFAULT_TEMPLATES, defaultTemplateFor } from '../notification-default-templates';
import { SMS_MAX_SEGMENTS, unbalancedSections, unknownPlaceholders } from '../notification-template';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationType,
} from '../notifications.types';

/**
 * Les modèles **par défaut de la plateforme**, dans les deux langues — #854,
 * premier et septième critères d'acceptation.
 *
 * ## Pourquoi ils méritent leur propre suite
 *
 * Ce sont eux qui partent pour tout salon qui n'a rien personnalisé, c'est-à-dire
 * pour la quasi-totalité des messages. Jusqu'à #854 ils vivaient au bout de
 * `notification-template.spec.ts`, en marge du moteur, et ils n'avaient qu'une
 * langue à couvrir. Ils en ont deux désormais, et la propriété qui compte n'est
 * plus « chaque message a un modèle » mais « chaque message a le **même**
 * modèle dans les deux langues » — une propriété de la table entière, pas d'une
 * fonction de rendu.
 *
 * ## La parité est la barrière, et elle se pose ici
 *
 * Premier critère : « chaque valeur de `NOTIFICATION_TYPES` a ses modèles dans
 * les deux langues, et un test échoue s'il en manque un ». Le contrôle ne compte
 * donc pas les modèles : il compare les deux couvertures. Un compte attendu
 * aurait été à corriger à chaque message ajouté, et il n'aurait rien dit du jour
 * où le français en gagne un que l'anglais n'a pas — ce qui est exactement
 * l'accident qu'on cherche à empêcher, puisqu'il ne se manifesterait que par une
 * ligne `FAILED` chez une cliente anglophone.
 */

/** Les couples `(type, canal)` que la langue sert, en clair. */
function coverage(locale: Locale): string[] {
  const served: string[] = [];

  for (const type of NOTIFICATION_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      if (defaultTemplateFor(type, channel, locale) !== null) {
        served.push(`${type}/${channel}`);
      }
    }
  }

  return served;
}

/** Tous les couples servis d'une langue, modèle compris. */
function servedTemplates(
  locale: Locale,
): { type: NotificationType; channel: NotificationChannel; source: NonNullable<ReturnType<typeof defaultTemplateFor>> }[] {
  const served = [];

  for (const type of NOTIFICATION_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const source = defaultTemplateFor(type, channel, locale);

      if (source !== null) {
        served.push({ type, channel, source });
      }
    }
  }

  return served;
}

describe('modèles par défaut — la couverture des deux langues', () => {
  it('sert exactement les mêmes couples dans chaque langue — #854', () => {
    // La barrière du premier critère. Elle ne compte rien : elle compare. Un
    // message ajouté en français et oublié en anglais fait rougir cette ligne,
    // et c'est le seul endroit du dépôt où cela se voit avant la production.
    const [premiere, ...autres] = LOCALES;
    const reference = coverage(premiere);

    for (const locale of autres) {
      expect({ locale, couples: coverage(locale) }).toEqual({ locale, couples: reference });
    }
  });

  it('sert les cinq messages de rendez-vous sur les deux canaux, dans les deux langues', () => {
    // La parité seule ne dirait rien d'une table vide des deux côtés. Ce cas-ci
    // nomme le plancher : les trois messages du CDC §1.4, plus « votre
    // rendez-vous est confirmé » (#800) et « votre rendez-vous a été déplacé »
    // (#1116), sur e-mail **et** SMS.
    for (const locale of LOCALES) {
      for (const type of [
        'BOOKING_CONFIRMATION',
        'REMINDER_24H',
        'CANCELLATION',
        'APPOINTMENT_CONFIRMED',
        'APPOINTMENT_RESCHEDULED',
      ] as const) {
        for (const channel of NOTIFICATION_CHANNELS) {
          expect({
            locale,
            type,
            channel,
            servi: defaultTemplateFor(type, channel, locale) !== null,
          }).toEqual({ locale, type, channel, servi: true });
        }
      }
    }
  });

  it('n’a de modèle de réinitialisation que sur l’e-mail, dans les deux langues', () => {
    // Quatrième critère de #809, maintenu des deux côtés : un lien de 66
    // caractères ne laisse rien pour la phrase qui dit quoi en faire, et un SMS
    // ne prouve pas la possession de l'**adresse** — or c'est elle que la
    // procédure vérifie. L'absence est donc délibérée, et symétrique.
    for (const locale of LOCALES) {
      expect(defaultTemplateFor('PASSWORD_RESET', 'EMAIL', locale)).not.toBeNull();
      expect(defaultTemplateFor('PASSWORD_RESET', 'SMS', locale)).toBeNull();
    }
  });

  it('ne sert jamais une langue à la place d’une autre', () => {
    // Le quatrième critère de #854 pris à la racine : `defaultTemplateFor` lit
    // la table de **sa** langue. Une langue inconnue n'emprunte rien à l'autre —
    // elle n'a aucune table, et l'appelant échoue.
    const francais = defaultTemplateFor('BOOKING_CONFIRMATION', 'EMAIL', 'fr');
    const anglais = defaultTemplateFor('BOOKING_CONFIRMATION', 'EMAIL', 'en');

    expect(francais).not.toEqual(anglais);
    expect(Object.keys(DEFAULT_TEMPLATES).sort()).toEqual([...LOCALES].sort());
  });
});

describe('modèles par défaut — le coût d’un SMS, dans chaque langue', () => {
  it('tient en un seul segment GSM-7, en anglais comme en français — #854', () => {
    // Septième critère : « les modèles SMS anglais respectent la même limite de
    // longueur que les modèles français ». La mesure porte sur le **rendu de
    // référence de la langue**, et c'est ce qui la rend juste : la date anglaise
    // est plus longue que la française, et mesurer l'anglais contre la référence
    // française aurait sous-estimé sa facture.
    //
    // Un défaut à deux segments doublerait la facture SMS du produit entier,
    // sans que personne ne s'en aperçoive avant le relevé (notifications §5).
    for (const locale of LOCALES) {
      for (const { type, source } of servedTemplates(locale).filter(
        (entry) => entry.channel === 'SMS',
      )) {
        const cost = measureSmsTemplate(source.text, locale);

        expect({ locale, type, encoding: cost.encoding, segments: cost.segments }).toEqual({
          locale,
          type,
          encoding: 'GSM_7',
          segments: 1,
        });
        expect(cost.segments).toBeLessThanOrEqual(SMS_MAX_SEGMENTS);
      }
    }
  });
});

describe('modèles par défaut — ce que chaque langue doit tenir', () => {
  it('n’emploie que des variables du vocabulaire, et referme ses sections', () => {
    for (const locale of LOCALES) {
      for (const { type, channel, source } of servedTemplates(locale)) {
        const whole = [source.subject, source.html, source.text].join('\n');

        expect({ locale, type, channel, unknown: unknownPlaceholders(whole) }).toEqual({
          locale,
          type,
          channel,
          unknown: [],
        });
        expect(unbalancedSections(whole)).toEqual([]);
      }
    }
  });

  it('fournit toujours une version texte à côté du HTML', () => {
    // Quatrième critère d'acceptation de #69 : un e-mail qui n'a que du HTML est
    // pénalisé par les filtres anti-spam, et le rappel J-1 perd son intérêt s'il
    // finit en indésirables (notifications §6).
    for (const locale of LOCALES) {
      for (const { source } of servedTemplates(locale).filter(
        (entry) => entry.channel === 'EMAIL',
      )) {
        expect(source.html.length).toBeGreaterThan(0);
        expect(source.text.length).toBeGreaterThan(0);
        expect(source.text).not.toContain('<');
      }
    }
  });

  it('n’a ni objet ni HTML sur le canal SMS', () => {
    // Un expéditeur SNS ne lit que `text` : ce qui n'est pas écrit ne peut pas
    // partir par erreur le jour où une passerelle mal branchée lirait `html`.
    for (const locale of LOCALES) {
      for (const { source } of servedTemplates(locale).filter((entry) => entry.channel === 'SMS')) {
        expect({ subject: source.subject, html: source.html }).toEqual({ subject: '', html: '' });
      }
    }
  });

  it('n’annonce pas un rendez-vous à qui vient de l’annuler', () => {
    // La raison pour laquelle #69 avait laissé `CANCELLATION` sans défaut plutôt
    // que de lui servir le modèle du rappel. Un avis d'annulation qui dirait
    // « nous vous attendons » serait pire qu'un avis absent — dans les deux
    // langues.
    const racines: Readonly<Record<Locale, { annule: RegExp; interdit: RegExp }>> = {
      fr: { annule: /annul/i, interdit: /attendons/i },
      en: { annule: /cancel/i, interdit: /look forward/i },
    };

    for (const locale of LOCALES) {
      for (const { source } of servedTemplates(locale).filter(
        (entry) => entry.type === 'CANCELLATION',
      )) {
        for (const body of [source.subject, source.html, source.text].filter(
          (value) => value.length > 0,
        )) {
          expect({ locale, annule: racines[locale].annule.test(body) }).toEqual({
            locale,
            annule: true,
          });
          expect(racines[locale].interdit.test(body)).toBe(false);
        }
      }
    }
  });

  it('nomme l’origine de l’annulation sous section, dans les deux langues', () => {
    // Troisième critère d'acceptation de #72. La section est ce qui garantit
    // qu'un rendez-vous sans origine ne produit pas « a été annulé . ».
    for (const locale of LOCALES) {
      for (const { source } of servedTemplates(locale).filter(
        (entry) => entry.type === 'CANCELLATION',
      )) {
        const whole = [source.subject, source.html, source.text].join('\n');

        expect(whole).toContain('{{#origine}}');
        expect(whole).toContain('{{/origine}}');
      }
    }
  });

  it('ne nomme jamais le motif d’annulation — il n’a pas de variable', () => {
    // `cancellation_reason` est un texte libre écrit par un humain : il peut
    // porter un état de santé ou le nom d'un tiers (CDC §5.1). Aucune variable
    // ne l'expose, et le relevé de conformité refuserait un modèle qui essaierait
    // — quelle que soit la langue, le vocabulaire étant commun aux deux.
    expect(unknownPlaceholders('{{motif}}')).toEqual(['motif']);
    expect(unknownPlaceholders('{{cancellation_reason}}')).toEqual(['cancellation_reason']);
  });
});
