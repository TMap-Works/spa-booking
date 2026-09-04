/**
 * Lecture d'un événement Stripe — de `Buffer` brut à fait métier typé.
 *
 * Ce fichier est le seul du module qui connaisse la forme JSON de Stripe, et
 * il la réduit immédiatement à ce dont le traitement a besoin. Deux raisons,
 * dans cet ordre :
 *
 * 1. **La frontière PCI.** Un objet Stripe complet porte
 *    `payment_method_details.card.last4`, `brand`, `exp_month`… Ne jamais
 *    construire cet objet, c'est n'avoir nulle part où ces champs pourraient
 *    entrer — ni en base, ni dans un journal, ni dans un message d'erreur
 *    (payments-stripe §1). Les types ci-dessous ne déclarent aucun champ de
 *    carte, et rien ne recopie ce qui n'est pas déclaré.
 * 2. **Le corps n'est pas de confiance avant vérification, et à peine après.**
 *    La signature prouve l'émetteur, pas la forme. Chaque champ lu est donc
 *    vérifié pour ce qu'il doit être — un entier reste un entier, une chaîne
 *    vide vaut absence.
 *
 * Le parsing ne lève jamais : il rend un verdict que l'appelant traite. Une
 * exception sur un corps mal formé aurait produit un 500 là où la conduite
 * juste est un 400 sans trace d'incident.
 */

/**
 * Les quatre événements du périmètre MVP (payments-stripe §3).
 *
 * Tout autre type reçu — et une terminaison Stripe abonnée largement en reçoit
 * — est **acquitté sans traitement**. Répondre autre chose que 200 ferait
 * rejouer indéfiniment un événement qu'on n'a de toute façon pas l'intention de
 * traiter, et gonflerait la file de Stripe pour rien.
 */
export const HANDLED_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/**
 * Le fait métier porté par l'événement — ce que le traitement va appliquer.
 *
 * Une union discriminée plutôt qu'un objet à champs optionnels : le compilateur
 * refuse alors qu'un remboursement soit appliqué sans montant, et le `switch`
 * du service est exhaustif par construction (`noFallthroughCasesInSwitch`).
 */
export type WebhookFact =
  | { readonly kind: 'payment-succeeded'; readonly paymentIntentId: string; readonly chargeId: string | null }
  | { readonly kind: 'payment-failed'; readonly paymentIntentId: string }
  | {
      readonly kind: 'charge-refunded';
      readonly paymentIntentId: string;
      readonly chargeId: string | null;
      readonly refundedAmountMinor: number;
      /** `true` quand Stripe a remboursé la totalité de ce qui avait été capturé. */
      readonly fullyRefunded: boolean;
    }
  | {
      readonly kind: 'dispute-opened';
      readonly paymentIntentId: string | null;
      readonly chargeId: string | null;
      readonly disputeId: string;
    };

/** Un événement lu, réduit, et prêt à être mis en file. */
export interface StripeWebhookEvent {
  /** `evt_…` — la clé d'idempotence de `processed_webhook_events`. */
  readonly eventId: string;
  readonly eventType: HandledEventType;
  /**
   * L'établissement annoncé par les métadonnées de l'intention, quand elles
   * sont là.
   *
   * C'est **nous** qui les avons écrites à la création de l'intention, et la
   * signature du corps les authentifie : ce n'est donc pas une entrée
   * utilisateur au sens de tenant-isolation §2, c'est une donnée serveur qui
   * nous revient. Elle reste néanmoins une *indication* — le résolveur la
   * confronte à la base avant d'ouvrir quoi que ce soit.
   */
  readonly tenantHint: string | null;
  readonly fact: WebhookFact;
}

/** Ce que la lecture d'un corps peut donner. */
export type WebhookReadOutcome =
  /** Un événement du périmètre, exploitable. */
  | { readonly status: 'handled'; readonly event: StripeWebhookEvent }
  /** Un événement bien formé, hors périmètre MVP, ou dont les champs utiles manquent. */
  | { readonly status: 'ignored'; readonly eventId: string | null; readonly eventType: string | null }
  /** Pas du JSON, ou pas un événement Stripe. */
  | { readonly status: 'unreadable' };

const IGNORED_UNREADABLE: WebhookReadOutcome = { status: 'unreadable' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Une chaîne non vide, ou `null`. Stripe rend `null` là où nous rendrions `undefined`. */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Un entier positif ou nul, ou `null`.
 *
 * Les montants Stripe sont toujours dans la plus petite unité de la devise et
 * toujours entiers. Un flottant ici serait le signe d'une charge falsifiée ou
 * d'un champ mal lu ; l'accepter ferait entrer un `float` dans un calcul
 * d'argent, ce que les règles de code interdisent.
 */
function readAmountMinor(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * L'identifiant d'une référence Stripe qui peut arriver soit développée (un
 * objet avec son `id`), soit sous forme de chaîne. Les deux formes existent
 * selon les réglages d'expansion de la terminaison.
 */
function readReference(source: Record<string, unknown>, key: string): string | null {
  const direct = readString(source, key);
  if (direct !== null) {
    return direct;
  }
  const expanded = asRecord(source[key]);
  return expanded === null ? null : readString(expanded, 'id');
}

/** `metadata.tenantId`, tel que `PaymentsService` l'écrit à la création de l'intention. */
function readTenantHint(object: Record<string, unknown>): string | null {
  const metadata = asRecord(object['metadata']);
  return metadata === null ? null : readString(metadata, 'tenantId');
}

function isHandled(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Le fait métier d'un événement du périmètre, ou `null` si les champs dont le
 * traitement a besoin manquent.
 *
 * `null` mène à un acquittement sans traitement, jamais à une erreur : un
 * `charge.refunded` sans intention de paiement rattachée est un encaissement
 * qui n'est pas passé par notre tunnel — une opération faite à la main dans le
 * tableau de bord Stripe, par exemple. Il n'y a rien à corriger, et rejouer ne
 * ferait pas apparaître le champ manquant.
 */
function readFact(type: HandledEventType, object: Record<string, unknown>): WebhookFact | null {
  switch (type) {
    case 'payment_intent.succeeded': {
      const paymentIntentId = readString(object, 'id');
      if (paymentIntentId === null) {
        return null;
      }
      // `latest_charge` est la charge que l'intention a produite : c'est elle
      // qu'un remboursement citera plus tard, et la conserver évite d'avoir à
      // la redemander à Stripe le jour venu.
      return { kind: 'payment-succeeded', paymentIntentId, chargeId: readReference(object, 'latest_charge') };
    }

    case 'payment_intent.payment_failed': {
      const paymentIntentId = readString(object, 'id');
      return paymentIntentId === null ? null : { kind: 'payment-failed', paymentIntentId };
    }

    case 'charge.refunded': {
      const paymentIntentId = readReference(object, 'payment_intent');
      const refundedAmountMinor = readAmountMinor(object, 'amount_refunded');
      const capturedAmountMinor = readAmountMinor(object, 'amount_captured');
      if (paymentIntentId === null || refundedAmountMinor === null) {
        return null;
      }
      return {
        kind: 'charge-refunded',
        paymentIntentId,
        chargeId: readString(object, 'id'),
        refundedAmountMinor,
        // Sans montant capturé lisible, on ne conclut pas au remboursement
        // total : `PARTIALLY_REFUNDED` est le statut prudent, il n'interdit
        // aucune suite et un événement ultérieur le corrigera.
        fullyRefunded: capturedAmountMinor !== null && refundedAmountMinor >= capturedAmountMinor,
      };
    }

    case 'charge.dispute.created': {
      const disputeId = readString(object, 'id');
      if (disputeId === null) {
        return null;
      }
      return {
        kind: 'dispute-opened',
        paymentIntentId: readReference(object, 'payment_intent'),
        chargeId: readReference(object, 'charge'),
        disputeId,
      };
    }
  }
}

/**
 * Lit un corps **déjà vérifié** et rend ce qu'il faut en faire.
 *
 * L'ordre d'appel n'est pas négociable : la signature d'abord, ce parsing
 * ensuite. Désérialiser avant de vérifier ferait exécuter du code sur une
 * charge arbitraire, ce que payments-stripe §3 refuse en une phrase — « une
 * signature invalide, 400 immédiat, aucun traitement ».
 */
export function readWebhookEvent(payload: Buffer): WebhookReadOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return IGNORED_UNREADABLE;
  }

  const envelope = asRecord(parsed);
  if (envelope === null) {
    return IGNORED_UNREADABLE;
  }

  const eventId = readString(envelope, 'id');
  const eventType = readString(envelope, 'type');
  if (eventId === null || eventType === null) {
    return IGNORED_UNREADABLE;
  }

  if (!isHandled(eventType)) {
    return { status: 'ignored', eventId, eventType };
  }

  const object = asRecord(asRecord(envelope['data'])?.['object']);
  if (object === null) {
    return { status: 'ignored', eventId, eventType };
  }

  const fact = readFact(eventType, object);
  if (fact === null) {
    return { status: 'ignored', eventId, eventType };
  }

  return {
    status: 'handled',
    event: { eventId, eventType, tenantHint: readTenantHint(object), fact },
  };
}
