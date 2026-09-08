import { buildTemplateVariables, renderNotification } from '../notification-content';
import { defaultTemplateFor } from '../notification-default-templates';
import {
  SMS_MAX_SEGMENTS,
  SMS_SINGLE_SEGMENT_UCS2,
  SMS_TENANT_NAME_MAX,
  TEMPLATE_VARIABLES,
  escapeHtml,
  keepAsIs,
  measureSms,
  measureSmsTemplate,
  renderTemplateSource,
  unbalancedSections,
  unknownPlaceholders,
  type TemplateVariables,
} from '../notification-template';
import type { AppointmentMessageContext } from '../notifications.types';

/**
 * Le moteur de modèles — #69.
 *
 * Quatre des cinq critères d'acceptation se prouvent ici, et nulle part ailleurs :
 * l'échappement des variables au rendu HTML, la version texte brut à côté du
 * HTML, l'heure dans le fuseau du salon, et la mesure du coût d'un SMS.
 *
 * La suite n'ouvre ni base, ni module Nest, et n'appelle aucune horloge : ce sont
 * des fonctions de `(modèle, valeurs) → texte`.
 */

const VALUES: TemplateVariables = {
  client: 'Amina Rakoto',
  service: 'Massage suédois',
  praticien: 'Claire D.',
  salon: 'Maison Lotus',
  adresse: '12 rue des Lilas, 75011 Paris',
  telephone: '+33123456789',
  date: 'mardi 8 septembre 2026 à 14:30',
  heure: '14:30',
  fin: '15:30',
  fuseau: 'Europe/Paris',
  prix: '65,00 €',
  lien_annulation: 'https://reservation.test/maison-lotus/compte',
  // Vide, comme sur tout rendez-vous qui n'est pas annulé : c'est l'état dans
  // lequel la confirmation et le rappel voient cette variable.
  origine: '',
  // La confirmation et le rappel ne partent qu'à la cliente : c'est l'état
  // ordinaire de cette variable.
  destinataire_client: 'oui',
};

describe('modèles — la substitution des variables', () => {
  it('remplace une balise par sa valeur', () => {
    expect(renderTemplateSource('Bonjour {{client}},', VALUES, keepAsIs)).toBe('Bonjour Amina Rakoto,');
  });

  it('remplace toutes les occurrences, pas seulement la première', () => {
    // `replaceAll` et non `replace` : le modèle de confirmation nomme `{{salon}}`
    // deux fois — dans le corps et dans la signature —, et une seule
    // substitution aurait laissé la signature en balise.
    expect(renderTemplateSource('{{salon}} … {{salon}}', VALUES, keepAsIs)).toBe(
      'Maison Lotus … Maison Lotus',
    );
  });

  it('rend une variable inconnue à vide plutôt que sa propre balise', () => {
    // Le refus a lieu à l'écriture ; ici, laisser `{{prenom}}` traverser jusqu'à
    // l'e-mail serait le pire des deux mondes.
    expect(renderTemplateSource('Bonjour {{prenom}} !', VALUES, keepAsIs)).toBe('Bonjour  !');
  });

  it('ne ré-interprète pas une valeur qui ressemble à de la syntaxe', () => {
    // Le point où un moteur naïf laisserait une donnée d'utilisateur redevenir
    // de la syntaxe : les sections se résolvent sur le modèle, les valeurs
    // arrivent après.
    const hostile = { ...VALUES, client: '{{#adresse}}{{lien_annulation}}{{/adresse}}' };

    expect(renderTemplateSource('{{client}}', hostile, keepAsIs)).toBe(
      '{{#adresse}}{{lien_annulation}}{{/adresse}}',
    );
  });
});

describe('modèles — les sections conditionnelles', () => {
  it('garde le fragment quand la variable est renseignée', () => {
    expect(renderTemplateSource('{{#adresse}}Adresse : {{adresse}}{{/adresse}}', VALUES, keepAsIs)).toBe(
      'Adresse : 12 rue des Lilas, 75011 Paris',
    );
  });

  it('efface le fragment entier quand elle est vide', () => {
    // L'adresse et le téléphone sont nullables au schéma : sans section, un salon
    // qui ne les a pas saisis recevrait « Adresse : » vide dans chaque message.
    const sans = { ...VALUES, adresse: '' };

    expect(renderTemplateSource('a{{#adresse}}Adresse : {{adresse}}{{/adresse}}b', sans, keepAsIs)).toBe(
      'ab',
    );
  });

  it('n’ouvre pas une section sur la balise d’une autre variable', () => {
    // La référence arrière impose que la fermeture nomme la même variable :
    // `{{#adresse}}…{{/telephone}}` n'est pas une section, et le relevé de
    // conformité le dit.
    expect(unbalancedSections('{{#adresse}}x{{/telephone}}')).toEqual(['adresse', 'telephone']);
  });
});

describe('modèles — l’échappement, et où il s’applique', () => {
  it('neutralise le HTML d’une valeur dans un corps HTML', () => {
    const hostile = { ...VALUES, client: '<script>alert(1)</script>' };

    const html = renderTemplateSource('<p>Bonjour {{client}}</p>', hostile, escapeHtml);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('échappe les guillemets, qui refermeraient l’attribut `href`', () => {
    // `lien_annulation` est substitué dans `href="…"`. Sans échappement, une
    // valeur portant un guillemet y ferait entrer un attribut de son choix.
    const hostile = { ...VALUES, lien_annulation: '" onclick="alert(1)' };

    expect(renderTemplateSource('<a href="{{lien_annulation}}">x</a>', hostile, escapeHtml)).toBe(
      '<a href="&quot; onclick=&quot;alert(1)">x</a>',
    );
  });

  it('traite l’esperluette en premier, sans double échappement', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('n’échappe rien dans un corps texte, où ce serait illisible', () => {
    const hostile = { ...VALUES, client: 'Marie & <Paul>' };

    expect(renderTemplateSource('Bonjour {{client}}', hostile, keepAsIs)).toBe(
      'Bonjour Marie & <Paul>',
    );
  });

  it('échappe le modèle ? non — la valeur, et elle seule', () => {
    // Le modèle **est** du HTML : l'échapper aurait rendu impossible d'en écrire.
    expect(renderTemplateSource('<b>{{client}}</b>', VALUES, escapeHtml)).toBe(
      '<b>Amina Rakoto</b>',
    );
  });
});

describe('modèles — le relevé de conformité, à l’écriture', () => {
  it('nomme les variables inconnues, dédoublonnées et triées', () => {
    expect(unknownPlaceholders('{{prenom}} {{nom}} {{prenom}} {{client}}')).toEqual([
      'nom',
      'prenom',
    ]);
  });

  it('refuse la casse approchante plutôt que de la tolérer', () => {
    // Tolérer `{{Client}}` obligerait le rendu à normaliser lui aussi, et une
    // normalisation qui diverge entre validation et rendu rend un modèle valide
    // à l'écriture et vide à l'envoi.
    expect(unknownPlaceholders('{{Client}}')).toEqual(['Client']);
  });

  it('ne signale rien sur un modèle qui n’emploie que le vocabulaire', () => {
    const whole = TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(' ');

    expect(unknownPlaceholders(whole)).toEqual([]);
    expect(unbalancedSections(whole)).toEqual([]);
  });

  it('signale une section ouverte et jamais refermée', () => {
    // Sans ce contrôle, `{{#adresse}}` traverse le rendu tel quel et part dans
    // l'e-mail.
    expect(unbalancedSections('{{#adresse}}Adresse : {{adresse}}')).toEqual(['adresse']);
  });

  it('signale une fermeture qui précède son ouverture, quoique à l’équilibre', () => {
    // Le compte est nul, et pourtant `SECTION_PATTERN` ne reconnaît rien : les
    // deux balises partiraient telles quelles dans l'e-mail.
    expect(unbalancedSections('{{/adresse}}x{{#adresse}}')).toEqual(['adresse']);
  });

  it('signale une balise que le rendu ne saurait pas substituer', () => {
    // `{{prénom}}` n'est ni une variable connue, ni une balise que
    // `VARIABLE_PATTERN` remplace : non refusée ici, elle partirait littéralement
    // dans le message.
    expect(unknownPlaceholders('Bonjour {{prénom}}, le {{date2}}.')).toEqual(['date2', 'prénom']);
  });
});

describe('modèles — le coût d’un SMS', () => {
  it('compte en GSM-7 tant que chaque caractère y figure', () => {
    // `é` et `è` sont dans l'alphabet de base : un message français n'est pas
    // condamné à l'UCS-2.
    expect(measureSms('Rendez-vous confirmé après-demain')).toEqual({
      encoding: 'GSM_7',
      units: 33,
      segments: 1,
    });
  });

  it('bascule en UCS-2 sur une apostrophe typographique', () => {
    // Le cœur du cinquième critère d'acceptation : un seul caractère hors GSM-7
    // divise la capacité par deux, donc double le coût.
    const cost = measureSms('Aujourd’hui');

    expect(cost.encoding).toBe('UCS_2');
    expect(cost.units).toBe(11);
  });

  it('bascule aussi sur `ê`, `ô` et le `ç` minuscule, qui n’y sont pas', () => {
    // La capitale `Ç` y est, la minuscule non — c'est exactement le genre
    // d'asymétrie qu'on ne devine pas.
    for (const character of ['ê', 'ô', 'î', 'û', 'ç', '—', '…', '«']) {
      expect(measureSms(`abc${character}`).encoding).toBe('UCS_2');
    }
  });

  it('compte double les caractères de la table d’extension', () => {
    // `€` est précédé d'un échappement dans la trame : un tarif écrit « 65 € »
    // coûte un septet de plus qu'il n'y paraît.
    expect(measureSms('€')).toEqual({ encoding: 'GSM_7', units: 2, segments: 1 });
  });

  it('facture un second segment au 161e septet, pas au 161e caractère', () => {
    expect(measureSms('a'.repeat(160)).segments).toBe(1);
    expect(measureSms('a'.repeat(161)).segments).toBe(2);
  });

  it('facture un second segment dès la 71e unité en UCS-2', () => {
    const long = `’${'a'.repeat(SMS_SINGLE_SEGMENT_UCS2)}`;

    expect(measureSms('’'.repeat(SMS_SINGLE_SEGMENT_UCS2)).segments).toBe(1);
    expect(measureSms(long).segments).toBe(2);
  });

  it('facture un segment à un message vide — l’opérateur l’envoie quand même', () => {
    expect(measureSms('').segments).toBe(1);
  });

  it('mesure `{{prix}}` avec les espaces insécables qu’`Intl` y met vraiment', () => {
    // `formatMoney` sépare les milliers par U+202F et la devise par U+00A0 :
    // aucune des deux n'est dans GSM-7. Une référence écrite avec des espaces
    // ordinaires aurait annoncé un segment GSM-7 pour un SMS qui part en UCS-2.
    expect(measureSmsTemplate('Prix : {{prix}}').encoding).toBe('UCS_2');
  });

  it('mesure un modèle sur son rendu, jamais sur ses balises', () => {
    // `{{date}}` fait huit caractères et en rendra trente-quatre : mesurer la
    // chaîne brute dirait n'importe quoi.
    expect(measureSmsTemplate('{{date}}').units).toBeGreaterThan('{{date}}'.length);
  });
});

/**
 * Les modèles par défaut de la plateforme, mesurés.
 *
 * Ce n'est pas une vérification de style : ce sont eux qui partent pour tout
 * salon qui n'a rien personnalisé, c'est-à-dire pour la quasi-totalité des
 * messages. Un défaut à deux segments doublerait la facture SMS du produit
 * entier, sans que personne ne s'en aperçoive avant le relevé.
 */
describe('modèles — les défauts de la plateforme', () => {
  it('tiennent en un seul segment SMS, et en GSM-7', () => {
    for (const type of ['BOOKING_CONFIRMATION', 'REMINDER_24H', 'CANCELLATION'] as const) {
      const source = defaultTemplateFor(type, 'SMS');
      expect(source).not.toBeNull();

      const cost = measureSmsTemplate(source?.text ?? '');

      expect({ type, encoding: cost.encoding, segments: cost.segments }).toEqual({
        type,
        encoding: 'GSM_7',
        segments: 1,
      });
      expect(cost.segments).toBeLessThanOrEqual(SMS_MAX_SEGMENTS);
    }
  });

  it('n’emploient que des variables du vocabulaire', () => {
    for (const type of ['BOOKING_CONFIRMATION', 'REMINDER_24H', 'CANCELLATION'] as const) {
      for (const channel of ['EMAIL', 'SMS'] as const) {
        const source = defaultTemplateFor(type, channel);
        const whole = [source?.subject, source?.html, source?.text].join('\n');

        expect({ type, channel, unknown: unknownPlaceholders(whole) }).toEqual({
          type,
          channel,
          unknown: [],
        });
        expect(unbalancedSections(whole)).toEqual([]);
      }
    }
  });

  it('fournissent toujours une version texte à côté du HTML', () => {
    // Quatrième critère d'acceptation : un e-mail qui n'a que du HTML est
    // pénalisé par les filtres anti-spam, et le rappel J-1 perd son intérêt s'il
    // finit en indésirables.
    for (const type of ['BOOKING_CONFIRMATION', 'REMINDER_24H', 'CANCELLATION'] as const) {
      const email = defaultTemplateFor(type, 'EMAIL');

      expect(email?.html.length ?? 0).toBeGreaterThan(0);
      expect(email?.text.length ?? 0).toBeGreaterThan(0);
      expect(email?.text).not.toContain('<');
    }
  });

  it('servent les trois messages du CDC §1.4, sur les deux canaux', () => {
    // #72 pose le dernier. Un couple sans modèle laisserait le renderer lever
    // `UnrenderableNotificationError`, donc la ligne en `FAILED` — ce qui était
    // le sort de l'avis d'annulation jusqu'ici.
    for (const type of ['BOOKING_CONFIRMATION', 'REMINDER_24H', 'CANCELLATION'] as const) {
      for (const channel of ['EMAIL', 'SMS'] as const) {
        expect({ type, channel, servi: defaultTemplateFor(type, channel) !== null }).toEqual({
          type,
          channel,
          servi: true,
        });
      }
    }
  });

  it('n’annoncent pas un rendez-vous à qui vient de l’annuler', () => {
    // La raison pour laquelle #69 avait laissé `CANCELLATION` sans défaut plutôt
    // que de lui servir le modèle du rappel. Le modèle livré par #72 dit
    // l'inverse, et cette suite est ce qui empêche une recopie distraite du
    // rappel de repasser en douce.
    const email = defaultTemplateFor('CANCELLATION', 'EMAIL');
    const sms = defaultTemplateFor('CANCELLATION', 'SMS');

    for (const body of [email?.subject, email?.html, email?.text, sms?.text]) {
      // « Annulation » dans l'objet, « annulé » dans les corps : c'est la racine
      // qui compte, et elle doit être dans chacun des quatre.
      expect(body ?? '').toMatch(/annul/i);
      expect(body ?? '').not.toContain('attendons');
    }
  });

  it('nomment l’origine de l’annulation, sous section', () => {
    // Troisième critère d'acceptation de #72. La section est ce qui garantit
    // qu'un rendez-vous sans origine ne produit pas « a été annulé . ».
    for (const channel of ['EMAIL', 'SMS'] as const) {
      const source = defaultTemplateFor('CANCELLATION', channel);
      const whole = [source?.subject, source?.html, source?.text].join('\n');

      expect(whole).toContain('{{#origine}}');
      expect(whole).toContain('{{/origine}}');
    }
  });

  it('ne nomment jamais le motif d’annulation — il n’a pas de variable', () => {
    // `cancellation_reason` est un texte libre écrit par un humain : il peut
    // porter un état de santé ou le nom d'un tiers (CDC §5.1). Aucune variable
    // ne l'expose, et le relevé de conformité refuserait un modèle qui essaierait.
    expect(unknownPlaceholders('{{motif}}')).toEqual(['motif']);
    expect(unknownPlaceholders('{{cancellation_reason}}')).toEqual(['cancellation_reason']);
  });
});

/**
 * Un salon à Paris, un rendez-vous en **heure d'été**.
 *
 * `2026-09-08T12:30:00Z` vaut 14:30 à Paris (UTC+2 en septembre). C'est le
 * décalage qui rend le critère vérifiable : afficher l'instant UTC tel quel
 * avancerait le rendez-vous de deux heures dans l'esprit de la cliente.
 */
/** Le compte de la cliente du rendez-vous — le destinataire par défaut ici. */
const CLIENT = '33333333-3333-4333-8333-333333333333';

/** Le compte du praticien : tout ce qui n'est pas la cliente. */
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

describe('modèles — les valeurs que le rendu compose', () => {
  it('donne l’heure dans le fuseau du salon, jamais en UTC', () => {
    const values = buildTemplateVariables(PARIS, 'https://x.test', 'EMAIL', CLIENT);

    expect(values.heure).toBe('14:30');
    expect(values.date).toContain('14:30');
    expect(values.fuseau).toBe('Europe/Paris');
    expect(values.date).not.toContain('12:30');
  });

  it('rend le même instant différemment selon le salon', () => {
    // La preuve que la conversion a bien lieu. 12:30 UTC = 15:30 à Antananarivo.
    const values = buildTemplateVariables(
      { ...PARIS, tenantTimeZone: 'Indian/Antananarivo' },
      'https://x.test',
      'EMAIL',
      CLIENT,
    );

    expect(values.heure).toBe('15:30');
  });

  it('rend une absence par une chaîne vide, jamais par « null »', () => {
    const values = buildTemplateVariables(
      { ...PARIS, tenantAddress: null, tenantPhone: null },
      'https://x.test',
      'EMAIL',
      CLIENT,
    );

    expect(values.adresse).toBe('');
    expect(values.telephone).toBe('');
  });

  it('écourte le nom du salon sur le canal SMS, et lui seul', () => {
    const long = { ...PARIS, tenantName: 'Le '.repeat(60) };

    expect(buildTemplateVariables(long, '', 'SMS', CLIENT).salon.length).toBe(SMS_TENANT_NAME_MAX);
    expect(buildTemplateVariables(long, '', 'EMAIL', CLIENT).salon).toBe(long.tenantName);
  });

  it('dit si le message part vers la cliente du rendez-vous — #534', () => {
    // La variable qui permet à un modèle unique de servir deux destinataires :
    // vide pour le praticien, elle referme sur lui les sections qui ne
    // s'adressent qu'à la cliente.
    expect(buildTemplateVariables(PARIS, '', 'EMAIL', CLIENT).destinataire_client).toBe('oui');
    expect(buildTemplateVariables(PARIS, '', 'EMAIL', PRATICIEN).destinataire_client).toBe('');
  });

  it('compare le compte, jamais le rôle', () => {
    // Une praticienne qui réserve pour elle-même **est** la cliente de ce
    // rendez-vous : la question posée est « es-tu la cliente de celui-ci », pas
    // « quel est ton rôle dans le salon ».
    const soi = { ...PARIS, clientId: PRATICIEN };

    expect(buildTemplateVariables(soi, '', 'EMAIL', PRATICIEN).destinataire_client).toBe('oui');
  });

  it('laisse `origine` vide sur un rendez-vous qui n’est pas annulé', () => {
    // C'est ce qui rend la variable utilisable en section : un modèle qui la
    // nomme dans une confirmation n'écrit rien plutôt qu'une phrase fausse.
    expect(buildTemplateVariables(PARIS, '', 'EMAIL', CLIENT).origine).toBe('');
  });

  it('dit d’où vient l’annulation, sans s’adresser à personne', () => {
    // Le même modèle sert la cliente et le praticien : « à votre demande » aurait
    // été faux pour l'un des deux à chaque envoi.
    const dit = (cancelledBy: AppointmentMessageContext['cancelledBy']): string =>
      buildTemplateVariables({ ...PARIS, cancelledBy }, '', 'EMAIL', CLIENT).origine;

    expect(dit('CLIENT')).toBe('à la demande du client');
    expect(dit('STAFF')).toBe("à l'initiative du salon");
    expect(dit('SYSTEM')).toBe('automatiquement par le système');

    for (const phrase of [dit('CLIENT'), dit('STAFF'), dit('SYSTEM')]) {
      expect(phrase).not.toContain('votre');
    }
  });

  it('écrit les trois origines en GSM-7 — un accent hors table doublerait la facture', () => {
    // `ê`, `ô` et `ç` minuscule n'y sont pas, et un seul d'entre eux ferait
    // passer l'avis d'annulation de 160 à 70 caractères (notifications §5).
    for (const cancelledBy of ['CLIENT', 'STAFF', 'SYSTEM'] as const) {
      const phrase = buildTemplateVariables({ ...PARIS, cancelledBy }, '', 'SMS', CLIENT).origine;

      expect({ cancelledBy, encoding: measureSms(phrase).encoding }).toEqual({
        cancelledBy,
        encoding: 'GSM_7',
      });
    }
  });
});

describe('modèles — le rendu d’un message', () => {
  it('échappe le HTML et laisse le texte intact, dans le même appel', () => {
    const hostile = { ...PARIS, clientFirstName: '<b>Amina</b>' };
    const source = { subject: 'x', html: '<p>{{client}}</p>', text: '{{client}}' };

    const rendered = renderNotification(
      source,
      buildTemplateVariables(hostile, 'https://x.test', 'EMAIL', CLIENT),
      'EMAIL',
    );

    expect(rendered.html).toContain('&lt;b&gt;Amina&lt;/b&gt;');
    expect(rendered.text).toContain('<b>Amina</b>');
  });

  it('n’échappe pas l’objet — un client mail affiche du texte brut', () => {
    const source = { subject: "L'atelier & vous", html: '', text: 'x' };

    expect(
      renderNotification(source, buildTemplateVariables(PARIS, '', 'EMAIL', CLIENT), 'EMAIL').subject,
    ).toBe("L'atelier & vous");
  });

  it('vide l’objet et le HTML sur le canal SMS, quoi qu’en dise le modèle', () => {
    // Un expéditeur SNS ne lit que `text` : laisser passer du HTML ouvrirait la
    // porte à une passerelle mal branchée qui l'enverrait tel quel.
    const source = { subject: 'objet', html: '<p>corps</p>', text: 'avis' };

    expect(renderNotification(source, buildTemplateVariables(PARIS, '', 'SMS', CLIENT), 'SMS')).toEqual({
      subject: '',
      html: '',
      text: 'avis',
    });
  });

  it('borne un SMS au plafond de segments, en dernier rideau', () => {
    // La validation du modèle a mesuré un rendu de référence ; rien ne garantit
    // qu'une valeur réelle soit plus courte que la référence.
    const source = { subject: '', html: '', text: '{{client}}'.repeat(40) };
    const bavard = { ...PARIS, clientFirstName: 'A'.repeat(80), clientLastName: 'B'.repeat(80) };

    const { text } = renderNotification(
      source,
      buildTemplateVariables(bavard, '', 'SMS', CLIENT),
      'SMS',
    );

    // Ce qui est borné est la **facture**, pas un nombre de caractères : ce
    // message-ci est en GSM-7, où trois segments valent 459 septets et non 210.
    expect(measureSms(text)).toEqual({
      encoding: 'GSM_7',
      units: 459,
      segments: SMS_MAX_SEGMENTS,
    });
  });

  it('borne aussi un corps UCS-2, où trois segments valent 201 unités', () => {
    // 210 caractères accentués en coûteraient quatre : une borne en caractères
    // calquée sur « 70 × 3 » aurait laissé passer le segment qu'elle prétend
    // interdire.
    const source = { subject: '', html: '', text: '{{client}}' };
    const bavard = { ...PARIS, clientFirstName: 'ê'.repeat(200), clientLastName: 'ê'.repeat(200) };

    const { text } = renderNotification(source, buildTemplateVariables(bavard, '', 'SMS', CLIENT), 'SMS');

    expect(measureSms(text).segments).toBe(SMS_MAX_SEGMENTS);
    // 67 unités par segment concaténé, et non 70 : l'en-tête de segmentation en
    // mange trois.
    expect(text.length).toBe(201);
  });
});
