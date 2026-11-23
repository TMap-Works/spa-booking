import type { Message } from '@ag-ui/core';

/**
 * La mémoire de la conversation côté navigateur.
 *
 * Sans elle, tout rechargement de page (un filtre posé sur l'écran où l'on est
 * déjà, un lien suivi vers un autre espace) fait repartir le chat de zéro : le
 * fil change et les messages s'effacent, alors que le serveur garde l'historique
 * 30 minutes.
 *
 * Ce qui est gardé tient dans `sessionStorage` : propre à l'onglet, vidé à sa
 * fermeture, jamais envoyé nulle part. Trois bornes :
 *
 * - **30 minutes** sans message — la durée de conservation du serveur
 *   (registre des traitements §2.7) ; au-delà, le serveur a oublié et nous aussi ;
 * - **par salon et par espace** — le panneau d'un back-office n'est pas la bulle
 *   d'une vitrine ;
 * - **par personne** — l'empreinte du compte (`sujet`, rendue par le serveur) est
 *   gardée avec la conversation : un autre compte, ou une déconnexion, sur le
 *   même onglet ne la retrouve jamais.
 */

export const MEMORY_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGES = 60;

export interface Conversation {
  readonly threadId: string;
  readonly messages: Message[];
}

interface Stored extends Conversation {
  readonly sujet: string;
  readonly savedAt: number;
}

const keyOf = (tenantSlug: string, variant: string) => `spa-copilot:${tenantSlug}:${variant}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const newThreadId = () => globalThis.crypto.randomUUID();

/** La conversation à reprendre, ou un fil neuf si elle manque, a expiré ou n'est pas à cette personne. */
export function loadConversation(tenantSlug: string, variant: string, sujet: string, now = Date.now()): Conversation {
  const store = storage();
  try {
    const raw = store?.getItem(keyOf(tenantSlug, variant));
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Stored>;
      if (
        saved.sujet === sujet &&
        typeof saved.threadId === 'string' &&
        Array.isArray(saved.messages) &&
        typeof saved.savedAt === 'number' &&
        now - saved.savedAt < MEMORY_TTL_MS
      ) {
        return { threadId: saved.threadId, messages: saved.messages };
      }
      store?.removeItem(keyOf(tenantSlug, variant));
    }
  } catch {
    // Un stockage illisible vaut un stockage vide.
  }
  return { threadId: newThreadId(), messages: [] };
}

/** Garde la conversation ; ne dit rien si le navigateur refuse (mode privé, quota). */
export function saveConversation(
  tenantSlug: string,
  variant: string,
  sujet: string,
  conversation: Conversation,
  now = Date.now(),
): void {
  // Le texte échangé : ni raisonnement ni activité interne.
  const messages = conversation.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
    .slice(-MAX_MESSAGES);
  if (messages.length === 0) return;
  try {
    const stored: Stored = { threadId: conversation.threadId, messages, sujet, savedAt: now };
    storage()?.setItem(keyOf(tenantSlug, variant), JSON.stringify(stored));
  } catch {
    // Rien à faire : la conversation continue, elle ne survivra simplement pas.
  }
}
