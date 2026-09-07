import {
  DELIVERY_EVENT_OUTCOMES,
  DELIVERY_EVENT_TYPES,
  classifyDeliveryEvent,
  normalizeEmail,
} from '../delivery-event';
import { EMAIL_SUPPRESSION_REASONS } from '../notifications.types';

/**
 * La lecture d'un événement de remise SES — #73.
 *
 * Des fonctions pures : ni base, ni horloge, ni serveur. C'est ici que se prouve
 * la **distinction entre échecs permanents et transitoires**, qui est le
 * troisième critère d'acceptation du ticket — et l'endroit où elle se prouve le
 * mieux, puisqu'il suffit d'une charge utile et d'un verdict.
 *
 * Les charges utiles reprennent la forme réelle des notifications SES, y compris
 * ce qui, dedans, nous a fait écrire du code : la casse variable des adresses, la
 * forme d'affichage `"Nom" <adresse>`, l'espace de `Rendering Failure`, et le
 * `diagnosticCode` qui porte l'adresse du destinataire là où on ne l'attend pas.
 */

/** Une notification de rebond, telle que SES la publie. */
function bounce(
  bounceType: string,
  recipients: readonly unknown[] = [{ emailAddress: 'morte@exemple.test' }],
  bounceSubType = 'General',
): Record<string, unknown> {
  return {
    eventType: 'Bounce',
    mail: { messageId: 'ses-0102' },
    bounce: { bounceType, bounceSubType, bouncedRecipients: recipients },
  };
}

describe('normalizeEmail — la forme canonique d’une adresse', () => {
  it('accepte une adresse nue et la met en minuscules', () => {
    // `users.email` est unique « sur les octets » et `identity` normalise en
    // minuscules avant écriture : chercher autre chose ne trouverait pas la ligne.
    expect(normalizeEmail('Alice@Exemple.TEST')).toBe('alice@exemple.test');
  });

  it('extrait l’adresse d’une forme d’affichage', () => {
    // SES recopie ce que le serveur distant lui répond, et cela ressemble
    // souvent à un en-tête `From`. Cherchée telle quelle, cette chaîne ne
    // correspondrait à aucune ligne `users` : l'adresse resterait sollicitée,
    // et l'échec serait silencieux.
    expect(normalizeEmail('"Alice Martin" <Alice@Exemple.test>')).toBe('alice@exemple.test');
  });

  it('tolère les espaces de bord, y compris une fin de ligne SMTP', () => {
    expect(normalizeEmail('  alice@exemple.test\r\n')).toBe('alice@exemple.test');
  });

  it.each([
    ['une chaîne vide', ''],
    ['sans arrobase', 'alice.exemple.test'],
    ['sans partie locale', '@exemple.test'],
    ['sans domaine', 'alice@'],
    ['avec une espace interne', 'ali ce@exemple.test'],
    ['un nombre', 42],
    ['null', null],
    ['un objet', { emailAddress: 'alice@exemple.test' }],
  ])('refuse %s', (_label, raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });
});

describe('classifyDeliveryEvent — ce qu’un événement commande de faire', () => {
  describe('les rebonds', () => {
    it('condamne l’adresse sur un rebond permanent', () => {
      const verdict = classifyDeliveryEvent(bounce('Permanent'));

      expect(verdict).toEqual({
        outcome: 'suppress',
        eventType: 'BOUNCE',
        reason: 'HARD_BOUNCE',
        recipients: ['morte@exemple.test'],
        detail: 'General',
        messageId: 'ses-0102',
      });
    });

    it.each([
      ['Transient', 'une boîte pleine ou un serveur momentanément indisponible'],
      ['Undetermined', 'une réponse SMTP que SES lui-même n’a pas su interpréter'],
    ])('laisse l’adresse vivante sur un rebond %s', (bounceType) => {
      // Le biais est délibéré : réécrire une fois de trop à une adresse
      // peut-être vivante coûte moins cher que couper définitivement les
      // confirmations d'une cliente.
      expect(classifyDeliveryEvent(bounce(bounceType))).toMatchObject({
        outcome: 'transient',
        eventType: 'BOUNCE',
      });
    });

    it('traite un rebond sans bloc `bounce` comme transitoire', () => {
      expect(classifyDeliveryEvent({ eventType: 'Bounce', mail: {} })).toMatchObject({
        outcome: 'transient',
        eventType: 'BOUNCE',
      });
    });

    it('n’est pas transitoire quand un rebond permanent ne nomme aucune adresse lisible', () => {
      // Le message ne repartira pas — ce n'est donc pas transitoire — mais il
      // n'y a rien à supprimer : le seul geste possible est de le journaliser.
      expect(classifyDeliveryEvent(bounce('Permanent', [{ emailAddress: 'pas-une-adresse' }])))
        .toMatchObject({ outcome: 'ignored', eventType: 'BOUNCE' });
    });

    it('normalise et déduplique les destinataires', () => {
      const verdict = classifyDeliveryEvent(
        bounce('Permanent', [
          { emailAddress: 'Alice@Exemple.test' },
          // Le même serveur peut répondre deux fois pour la même boîte : une
          // écriture par doublon serait une écriture pour rien.
          { emailAddress: '"Alice" <alice@exemple.test>' },
          { emailAddress: 'bob@exemple.test' },
          { emailAddress: 'illisible' },
          'pas un objet',
        ]),
      );

      expect(verdict).toMatchObject({
        outcome: 'suppress',
        recipients: ['alice@exemple.test', 'bob@exemple.test'],
      });
    });
  });

  describe('les plaintes', () => {
    it('condamne l’adresse, quel que soit le retour', () => {
      const verdict = classifyDeliveryEvent({
        eventType: 'Complaint',
        mail: { messageId: 'ses-0203' },
        complaint: {
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'plainte@exemple.test' }],
        },
      });

      expect(verdict).toEqual({
        outcome: 'suppress',
        eventType: 'COMPLAINT',
        reason: 'COMPLAINT',
        recipients: ['plainte@exemple.test'],
        detail: 'abuse',
        messageId: 'ses-0203',
      });
    });

    it('condamne aussi sur `not-spam`', () => {
      // Un retour de désignation erronée n'est pas un consentement retrouvé :
      // la personne a bien cliqué « courrier indésirable », et c'est cela qui
      // fait basculer la réputation d'un domaine.
      expect(
        classifyDeliveryEvent({
          eventType: 'Complaint',
          complaint: {
            complaintFeedbackType: 'not-spam',
            complainedRecipients: [{ emailAddress: 'plainte@exemple.test' }],
          },
        }),
      ).toMatchObject({ outcome: 'suppress', reason: 'COMPLAINT' });
    });

    it('ignore une plainte sans destinataire lisible', () => {
      expect(
        classifyDeliveryEvent({ eventType: 'Complaint', complaint: { complainedRecipients: [] } }),
      ).toMatchObject({ outcome: 'ignored', eventType: 'COMPLAINT' });
    });
  });

  describe('les événements qui ne disent rien de l’adresse', () => {
    it.each([
      ['Reject', 'SES a refusé le message — un virus détecté, par exemple'],
      ['Rendering Failure', 'notre modèle n’a pas su se rendre'],
      ['Delivery', 'le message est arrivé'],
      ['Open', 'la cliente l’a ouvert'],
    ])('ignore %s', (eventType) => {
      // L'adresse n'y est pour rien : la supprimer punirait la cliente d'un
      // défaut qui est le nôtre.
      expect(classifyDeliveryEvent({ eventType, mail: { messageId: 'ses-0304' } })).toEqual({
        outcome: 'ignored',
        eventType: eventType.replaceAll(' ', '_').toUpperCase(),
        detail: null,
        messageId: 'ses-0304',
      });
    });

    it('tient un retard de livraison pour transitoire', () => {
      // SES continue d'essayer, et le message est toujours chez lui : il ne
      // repartira pas de notre côté.
      expect(
        classifyDeliveryEvent({
          eventType: 'DeliveryDelay',
          deliveryDelay: { delayType: 'MailboxFull' },
        }),
      ).toMatchObject({ outcome: 'transient', eventType: 'DELIVERY_DELAY', detail: 'MailboxFull' });
    });
  });

  describe('les deux vocabulaires de SES', () => {
    it.each([
      ['Rendering Failure', 'RENDERING_FAILURE', 'l’espace de la charge SES'],
      ['RENDERING_FAILURE', 'RENDERING_FAILURE', 'le souligné de `var.event_types`'],
      ['renderingFailure', 'RENDERING_FAILURE', 'la forme en chameau minuscule'],
      // Sans la coupure sur la frontière de casse, ce type-là ressortirait
      // `unreadable` : un retard de livraison — une boîte momentanément
      // pleine — serait journalisé comme une anomalie à chaque fois.
      ['DeliveryDelay', 'DELIVERY_DELAY', 'le chameau collé de SES'],
    ])('lit `%s` comme %s (%s)', (raw, expected) => {
      expect(classifyDeliveryEvent({ eventType: raw })).toMatchObject({ eventType: expected });
    });

    it('accepte `notificationType`, la forme des notifications d’identité', () => {
      expect(
        classifyDeliveryEvent({
          notificationType: 'Bounce',
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'morte@exemple.test' }],
          },
        }),
      ).toMatchObject({ outcome: 'suppress', eventType: 'BOUNCE' });
    });
  });

  describe('ce qui ne se lit pas', () => {
    it.each([
      ['une chaîne', 'Bounce'],
      ['un tableau', [{ eventType: 'Bounce' }]],
      ['null', null],
      ['undefined', undefined],
    ])('refuse %s sans lever', (_label, payload) => {
      expect(classifyDeliveryEvent(payload)).toEqual({
        outcome: 'unreadable',
        reason: 'payload-not-an-object',
      });
    });

    it('refuse un type inconnu', () => {
      expect(classifyDeliveryEvent({ eventType: 'Teleportation' })).toEqual({
        outcome: 'unreadable',
        reason: 'unknown-event-type',
      });
    });

    it('ne rend jamais la charge utile dans son motif', () => {
      // Le motif part dans les journaux : il est **fixe**, jamais un extrait de
      // ce qu'on vient de refuser — lequel pourrait porter une adresse.
      const verdict = classifyDeliveryEvent({ eventType: 'X', victime: 'alice@exemple.test' });

      expect(JSON.stringify(verdict)).not.toContain('alice@exemple.test');
    });
  });

  describe('le sous-type, qui part dans les journaux', () => {
    it('refuse un sous-type qui n’a pas la forme d’un identifiant', () => {
      // SES range parfois un `diagnosticCode` au mauvais endroit — et celui-ci
      // **contient l'adresse du destinataire**. Le filtre est ce qui l'empêche
      // de se retrouver dans un journal (notifications §7).
      const verdict = classifyDeliveryEvent(
        bounce(
          'Permanent',
          [{ emailAddress: 'morte@exemple.test' }],
          'smtp; 550 5.1.1 <morte@exemple.test>: Recipient address rejected',
        ),
      );

      expect(verdict).toMatchObject({ outcome: 'suppress', detail: null });
    });

    it('borne la largeur d’un sous-type légitime mais démesuré', () => {
      const verdict = classifyDeliveryEvent(
        bounce('Permanent', [{ emailAddress: 'morte@exemple.test' }], 'A'.repeat(200)),
      );

      expect(verdict).toMatchObject({ outcome: 'suppress', detail: 'A'.repeat(64) });
    });
  });
});

describe('les listes du module', () => {
  it('ne connaît que les quatre issues nommées', () => {
    expect([...DELIVERY_EVENT_OUTCOMES]).toEqual(['suppress', 'transient', 'ignored', 'unreadable']);
  });

  it('n’a que deux motifs de suppression, et ce sont ceux du schéma', () => {
    // Le témoin de l'`enum EmailSuppressionReason` : en ajouter une valeur
    // demanderait une migration, et cette égalité le rappelle.
    expect([...EMAIL_SUPPRESSION_REASONS]).toEqual(['HARD_BOUNCE', 'COMPLAINT']);
  });

  it('nomme les quatre types que la destination SES publie', () => {
    for (const type of ['BOUNCE', 'COMPLAINT', 'REJECT', 'RENDERING_FAILURE']) {
      expect(DELIVERY_EVENT_TYPES).toContain(type);
    }
  });
});
