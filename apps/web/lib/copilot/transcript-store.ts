import type Anthropic from '@anthropic-ai/sdk';

/**
 * La conversation telle que Claude l'a vue, gardée côté serveur.
 *
 * ## Pourquoi pas l'historique que renvoie le navigateur
 *
 * CopilotKit renvoie à chaque tour les messages AG-UI : du texte et des appels
 * d'outil, mais **pas les blocs de réflexion** ni leur signature. Or Claude
 * exige qu'on les lui rende tels quels, et refuse un historique réécrit
 * (preserved thinking, spécification §6.4). L'historique canonique est donc
 * celui-ci, en ajout seul ; les messages AG-UI ne servent qu'à savoir ce qui
 * est **nouveau** depuis le dernier tour (`seen`).
 *
 * Le navigateur n'en est pas la source pour une seconde raison : ce qu'il
 * renvoie est sous son contrôle, et un message d'assistant forgé ne doit pas
 * devenir une parole de Claude.
 */
export interface Transcript {
  messages: Anthropic.MessageParam[];
  /** Identifiants des messages AG-UI déjà versés dans `messages`. */
  seen: string[];
  /**
   * Résultats d'outils serveur dont le tour s'est arrêté sur l'appel (passe-plat,
   * spécification §6.2.3) : ils ouvrent le prochain message de l'utilisateur,
   * pour que l'historique reste en ajout seul.
   */
  pending?: Anthropic.ToolResultBlockParam[];
}

export interface TranscriptStore {
  get(key: string): Promise<Transcript | undefined>;
  set(key: string, transcript: Transcript): Promise<void>;
}

/** Durée de vie d'une conversation sans nouveau message (spécification §5). */
export const TRANSCRIPT_TTL_SECONDS = 30 * 60;

/**
 * Magasin en mémoire, **pour le développement local seulement** : il ne
 * survit pas à un redémarrage et n'est pas partagé entre deux tâches ECS. En
 * déployé, c'est `RedisTranscriptStore` (P1-08).
 */
export class MemoryTranscriptStore implements TranscriptStore {
  readonly #entries = new Map<string, { transcript: Transcript; expiresAt: number }>();

  constructor(
    private readonly ttlMs = TRANSCRIPT_TTL_SECONDS * 1000,
    private readonly maxEntries = 500,
  ) {}

  async get(key: string): Promise<Transcript | undefined> {
    const entry = this.#entries.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.transcript;
  }

  async set(key: string, transcript: Transcript): Promise<void> {
    this.#entries.delete(key);
    this.#entries.set(key, { transcript, expiresAt: Date.now() + this.ttlMs });
    // Map garde l'ordre d'insertion : la première clé est la plus ancienne.
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** Ce que le magasin Redis attend de la connexion : de quoi l'éprouver sans serveur. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/**
 * Magasin Redis — P1-08. Une conversation par clé
 * (`copilot:{salon}:{empreinte du compte|visiteur}:{fil}`), en JSON, réarmée
 * pour trente minutes à chaque tour. Les blocs de réflexion et leurs signatures
 * y sont gardés tels quels : c'est ce qui permet de les rendre à Claude au tour
 * suivant, quelle que soit la tâche qui le sert.
 */
export class RedisTranscriptStore implements TranscriptStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds = TRANSCRIPT_TTL_SECONDS,
  ) {}

  async get(key: string): Promise<Transcript | undefined> {
    const raw = await this.redis.get(`transcript:${key}`);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as Transcript;
    } catch {
      // Une entrée illisible (version précédente, écriture coupée) repart
      // d'une conversation vide plutôt que de bloquer le fil.
      return undefined;
    }
  }

  async set(key: string, transcript: Transcript): Promise<void> {
    await this.redis.set(`transcript:${key}`, JSON.stringify(transcript), 'EX', this.ttlSeconds);
  }
}
