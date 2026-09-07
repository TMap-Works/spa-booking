import type { EmailSuppressionReason } from './notifications.types';

/**
 * La lecture d'un événement de remise SES — #73, notifications §5.
 *
 * Fonctions **pures**, sans base ni horloge : c'est ici que se prend la seule
 * décision du ticket qui ne dépende d'aucun état — « cet événement condamne-t-il
 * l'adresse ? » — et c'est pourquoi elle vit dans un fichier à part, exercé
 * directement, comme `reminder-window.ts` l'est pour la fenêtre du rappel J-1.
 *
 * ## Ce qu'un événement SES est, et d'où il vient
 *
 * SES publie sur le topic `spa-{env}-ses-events` les quatre types retenus par
 * `var.event_types` : `Bounce`, `Complaint`, `Reject` et `Rendering Failure`.
 * Une file SQS s'y abonne, une Lambda la dépile et rejoue chaque événement
 * contre l'API. Le corps est alors exactement le JSON de SES, l'enveloppe SNS
 * ayant été retirée par la remise brute (`raw_message_delivery`).
 *
 * ## Les trois issues, et pourquoi trois et pas deux
 *
 * | Issue | Ce qu'elle veut dire | Effet |
 * |---|---|---|
 * | `suppress` | l'adresse est morte, ou son titulaire ne veut plus rien recevoir | elle cesse d'être sollicitée |
 * | `transient` | l'envoi a échoué **cette fois** | rien n'est écrit ; le message pourra repartir |
 * | `ignored` | l'événement ne dit rien de l'adresse | rien n'est écrit |
 *
 * `transient` et `ignored` ont le même effet en base — aucun — et sont pourtant
 * distincts, parce qu'ils ne se supervisent pas pareil. Un pic de rebonds
 * transitoires est le signe d'un incident de délivrabilité qui mérite un regard ;
 * un `Rendering Failure` est un bogue de modèle chez nous. Les confondre aurait
 * rendu la métrique de l'un illisible sous le volume de l'autre.
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il ne résout **aucun établissement**. L'événement ne porte que des adresses, et
 * une adresse n'est pas un tenant : c'est le service qui ouvre une portée par
 * établissement et y cherche l'adresse, jamais l'inverse (tenant-isolation §2).
 *
 * Il ne journalise rien non plus. Les adresses qu'il rend sont des données
 * personnelles, et notifications §7 interdit de les écrire dans un journal ;
 * elles ne servent qu'à une lecture indexée, immédiatement après.
 */

/**
 * Le type d'événement, tel qu'il est nommé dans la charge utile.
 *
 * SES écrit `Rendering Failure` — avec une espace — et `DeliveryDelay` — collé —
 * dans le même champ `eventType`, mais `RENDERING_FAILURE` et `DELIVERY_DELAY`
 * dans la configuration Terraform du jeu de destinations. Ce n'est pas une
 * incohérence de notre part : ce sont deux vocabulaires du même service, à trois
 * conventions de casse près, et la normalisation ci-dessous les réconcilie une
 * fois pour toutes.
 */
export const DELIVERY_EVENT_TYPES = [
  'BOUNCE',
  'COMPLAINT',
  'REJECT',
  'RENDERING_FAILURE',
  'DELIVERY_DELAY',
  'DELIVERY',
  'SEND',
  'OPEN',
  'CLICK',
  'SUBSCRIPTION',
] as const;

export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/** Ce qu'un événement de remise commande de faire. */
export type DeliveryEventVerdict =
  | {
      readonly outcome: 'suppress';
      readonly eventType: DeliveryEventType;
      readonly reason: EmailSuppressionReason;
      /**
       * Les adresses concernées, normalisées et dédupliquées.
       *
       * Une donnée personnelle : elle ne se journalise pas et ne ressort pas de
       * l'API. Le service l'emploie pour une lecture indexée, et rien d'autre.
       */
      readonly recipients: readonly string[];
      /** Sous-type SES (`General`, `NoEmail`, `abuse`…), quand il est lisible. */
      readonly detail: string | null;
      /** `mail.messageId` — l'accusé opaque de SES, journalisable. */
      readonly messageId: string | null;
    }
  | {
      readonly outcome: 'transient' | 'ignored';
      readonly eventType: DeliveryEventType;
      readonly detail: string | null;
      readonly messageId: string | null;
    }
  | {
      /** Ni JSON d'événement SES, ni type reconnu : il n'y a rien à faire, et le rejouer n'y changera rien. */
      readonly outcome: 'unreadable';
      /** Motif fixe, jamais un extrait de la charge utile : il part dans les journaux. */
      readonly reason: string;
    };

/** Les issues possibles, pour les compteurs et les contrats. */
export const DELIVERY_EVENT_OUTCOMES = ['suppress', 'transient', 'ignored', 'unreadable'] as const;

export type DeliveryEventOutcome = (typeof DELIVERY_EVENT_OUTCOMES)[number];

/** Largeur du sous-type conservé — celle de la colonne la plus étroite qui pourrait l'accueillir. */
const DETAIL_MAX_LENGTH = 64;

/**
 * Sous-types acceptés tels quels : lettres, chiffres, tiret et souligné.
 *
 * SES n'y met que des identifiants (`General`, `MailboxFull`, `abuse`,
 * `not-spam`), mais ce champ n'est pas un contrat : le filtrer empêche qu'un
 * `diagnosticCode` glissé au mauvais endroit — lequel **contient l'adresse du
 * destinataire** — se retrouve dans un journal (notifications §7).
 */
const DETAIL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

/**
 * Le sous-type, s'il est présentable — sinon `null`.
 *
 * Tronqué **et** filtré : la troncature borne la place qu'il prend, le filtre
 * garantit qu'il ne transporte pas autre chose que ce qu'il annonce.
 */
function readDetail(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) {
    return null;
  }

  const raw = readString(source, key);

  if (raw === null) {
    return null;
  }

  const trimmed = raw.slice(0, DETAIL_MAX_LENGTH);

  return DETAIL_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Une adresse ramenée à sa forme canonique, ou `null` si ce n'en est pas une.
 *
 * ## Trois traitements, et chacun ferme un écart réel
 *
 * 1. **La forme d'affichage.** SES rend parfois `"Alice" <alice@exemple.test>`
 *    dans `bouncedRecipients`, parce qu'il recopie ce que le serveur distant lui
 *    a répondu. Cherchée telle quelle, cette chaîne ne correspondrait à aucune
 *    ligne `users`, et l'adresse resterait sollicitée — un échec silencieux, le
 *    pire des trois.
 * 2. **La casse.** `users.email` est unique « sur les octets » et le module
 *    `identity` normalise en minuscules avant écriture : c'est cette même forme
 *    qu'il faut chercher, faute de quoi un `Alice@Exemple.test` rebondi ne
 *    trouverait pas la ligne `alice@exemple.test`.
 * 3. **Les espaces.** Rien de subtil, mais un `\r\n` traîne facilement dans une
 *    valeur venue d'un serveur SMTP.
 *
 * Ce qui n'a pas d'arrobase, ou qui n'a rien de part et d'autre, est refusé : la
 * chaîne ne désigne alors aucune adresse, et la chercher ne pourrait au mieux que
 * ne rien trouver.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const angled = /<([^<>]+)>\s*$/.exec(raw.trim());
  const candidate = (angled?.[1] ?? raw).trim().toLowerCase();

  const at = candidate.indexOf('@');

  if (at <= 0 || at === candidate.length - 1 || candidate.includes(' ')) {
    return null;
  }

  return candidate;
}

/**
 * Les adresses d'une liste de destinataires SES, normalisées et dédupliquées.
 *
 * Dédupliquées parce qu'un même serveur peut répondre deux fois pour la même
 * boîte, et qu'une écriture par doublon serait une écriture pour rien.
 */
function recipients(source: unknown, key: string): readonly string[] {
  if (!Array.isArray(source)) {
    return [];
  }

  const addresses = source
    .map((entry) => (isRecord(entry) ? normalizeEmail(entry[key]) : null))
    .filter((address): address is string => address !== null);

  return [...new Set(addresses)];
}

/**
 * Le type d'événement, ramené au vocabulaire de Terraform.
 *
 * `eventType` est ce que publie une destination de jeu de configuration ;
 * `notificationType` est ce que publiait l'ancienne forme, celle d'une
 * notification d'identité. Les deux sont lus, parce qu'un compte peut porter les
 * deux configurations en même temps et que rien ne coûte à accepter la seconde.
 *
 * ## Les trois casses de SES, et pourquoi il faut les trois
 *
 * | Ce que SES écrit | Ce qu'il faut lire |
 * |---|---|
 * | `Rendering Failure` | une espace sépare les deux mots |
 * | `DeliveryDelay` | rien ne les sépare — c'est du chameau |
 * | `RENDERING_FAILURE` | le vocabulaire de `var.event_types`, côté Terraform |
 *
 * La coupure sur la frontière minuscule → majuscule est donc **nécessaire**, et
 * non un raffinement : sans elle, `DeliveryDelay` ne correspondrait à aucune
 * valeur connue et un retard de livraison — un événement parfaitement banal —
 * ressortirait `unreadable`, c'est-à-dire journalisé comme une anomalie à chaque
 * fois qu'une boîte est momentanément pleine.
 *
 * Elle est sans effet sur les deux autres formes : `RENDERING_FAILURE` n'a
 * aucune frontière de ce genre, et l'espace de `Rendering Failure` est traité par
 * le remplacement qui suit.
 */
function eventType(payload: Record<string, unknown>): DeliveryEventType | null {
  const raw = readString(payload, 'eventType') ?? readString(payload, 'notificationType');

  if (raw === null) {
    return null;
  }

  const normalized = raw
    .trim()
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[\s-]+/g, '_')
    .toUpperCase();

  return (DELIVERY_EVENT_TYPES as readonly string[]).includes(normalized)
    ? (normalized as DeliveryEventType)
    : null;
}

/**
 * Ce que la Lambda a dépilé, classé.
 *
 * ## Les rebonds, et la seule distinction qui compte
 *
 * `bounceType` vaut `Permanent`, `Transient` ou `Undetermined`. Seul le premier
 * condamne l'adresse. `Undetermined` est traité comme transitoire, et ce choix
 * est délibéré : dans le doute, on préfère réécrire une fois de trop à une
 * adresse peut-être vivante plutôt que couper définitivement les confirmations
 * d'une cliente sur une réponse SMTP que SES lui-même n'a pas su interpréter.
 *
 * ## Les plaintes, qui n'ont pas de sous-type à considérer
 *
 * Une plainte est définitive quel que soit son `complaintFeedbackType` — y
 * compris `not-spam`, qui est un retour de désignation erronée et non un
 * consentement retrouvé. Continuer à écrire à quelqu'un qui a cliqué « courrier
 * indésirable » est ce qui fait basculer la réputation d'un domaine.
 *
 * ## `Reject` et `Rendering Failure`, définitifs mais innocents
 *
 * SES a refusé le message (virus détecté) ou n'a pas su rendre le modèle. Le
 * message ne partira pas, et le rejouer ne changerait rien — mais l'adresse n'y
 * est pour rien, et la supprimer punirait la cliente d'un défaut qui est le
 * nôtre. Ils sont donc `ignored` du point de vue de la suppression, et visibles
 * dans les journaux de la Lambda pour ce qu'ils sont.
 */
export function classifyDeliveryEvent(payload: unknown): DeliveryEventVerdict {
  if (!isRecord(payload)) {
    return { outcome: 'unreadable', reason: 'payload-not-an-object' };
  }

  const type = eventType(payload);

  if (type === null) {
    return { outcome: 'unreadable', reason: 'unknown-event-type' };
  }

  const messageId = readString(readRecord(payload, 'mail') ?? {}, 'messageId');

  switch (type) {
    case 'BOUNCE': {
      return classifyBounce(payload, messageId);
    }

    case 'COMPLAINT': {
      const complaint = readRecord(payload, 'complaint');
      const addresses = recipients(complaint?.['complainedRecipients'], 'emailAddress');

      if (addresses.length === 0) {
        // Une plainte sans destinataire lisible ne désigne personne. Il n'y a
        // rien à supprimer, et le rejouer n'y ajouterait pas d'adresse.
        return { outcome: 'ignored', eventType: type, detail: null, messageId };
      }

      return {
        outcome: 'suppress',
        eventType: type,
        reason: 'COMPLAINT',
        recipients: addresses,
        detail: readDetail(complaint, 'complaintFeedbackType'),
        messageId,
      };
    }

    case 'DELIVERY_DELAY': {
      // Un retard n'est pas un échec : SES continue d'essayer. Transitoire par
      // définition — et il ne repartira pas de notre côté, puisque le message
      // est toujours chez SES.
      return {
        outcome: 'transient',
        eventType: type,
        detail: readDetail(readRecord(payload, 'deliveryDelay'), 'delayType'),
        messageId,
      };
    }

    default: {
      return { outcome: 'ignored', eventType: type, detail: null, messageId };
    }
  }
}

/** Le seul type d'événement dont l'issue dépende d'un sous-champ. */
function classifyBounce(
  payload: Record<string, unknown>,
  messageId: string | null,
): DeliveryEventVerdict {
  const bounce = readRecord(payload, 'bounce');
  const detail = readDetail(bounce, 'bounceSubType');

  if (bounce === null || readString(bounce, 'bounceType') !== 'Permanent') {
    return { outcome: 'transient', eventType: 'BOUNCE', detail, messageId };
  }

  const addresses = recipients(bounce['bouncedRecipients'], 'emailAddress');

  if (addresses.length === 0) {
    // Un rebond permanent qui ne nomme aucune adresse lisible : il n'y a rien à
    // supprimer. Ce n'est pas transitoire pour autant — le message ne repartira
    // pas — mais le seul geste possible est de le journaliser.
    return { outcome: 'ignored', eventType: 'BOUNCE', detail, messageId };
  }

  return {
    outcome: 'suppress',
    eventType: 'BOUNCE',
    reason: 'HARD_BOUNCE',
    recipients: addresses,
    detail,
    messageId,
  };
}
