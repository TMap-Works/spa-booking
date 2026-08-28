import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { AppConfigService } from '../../config/app-config.service';
import type { AvailabilityCacheEntry, AvailabilityCacheStore } from './availability-cache';

/**
 * L'entrepôt Redis du cache de disponibilité (#35).
 *
 * ## Une panne du cache n'est jamais une panne de l'API
 *
 * C'est la propriété la plus importante de ce fichier, et la raison pour
 * laquelle **aucune** de ses trois méthodes ne rejette. Un cache injoignable
 * doit se comporter comme un cache vide : la lecture rend des défauts, l'écriture
 * est perdue, l'invalidation ne trouve rien — et l'endpoint recalcule, ce qui est
 * plus lent mais jamais faux. Laisser remonter l'erreur ferait de Redis une
 * dépendance dure du parcours de réservation, alors qu'il n'y est qu'une
 * optimisation (ARCHITECTURE.md : « le verrou Redis améliore l'UX, il ne
 * garantit rien »).
 *
 * Le corollaire vaut pour l'écriture : si l'invalidation échoue, le rendez-vous
 * vient tout de même d'être posé. Refuser la réservation pour cette raison
 * échangerait une vente contre au plus soixante secondes de cache périmé — que
 * le TTL efface de lui-même.
 *
 * ## `commandTimeout`, et pourquoi il vaut moins que le budget de la requête
 *
 * Le quatrième critère de #35 est un temps de réponse sous 300 ms. Un cache qui
 * met 5 s à répondre « je n'ai rien » l'a déjà fait manquer. `commandTimeout`
 * borne chaque commande à 200 ms : au-delà, la commande rejette, l'erreur est
 * avalée, et le chemin de calcul reprend la main. Le cache ne peut donc jamais
 * rendre une réponse **plus lente** que s'il n'existait pas, à ces 200 ms près.
 *
 * ## Un client propre à ce module, et la dette que cela ouvre
 *
 * `CacheConnection` (`infrastructure/cache`) tient le client Redis partagé de
 * l'application, mais n'expose que `ping()` : la sonde de `/health` est tout ce
 * dont l'application avait besoin jusqu'ici. Lui ajouter les commandes de cache
 * relève de son fichier, hors de l'empreinte de ce ticket ; ce module ouvre donc
 * sa propre connexion, avec la même politique de connexion paresseuse et de
 * réessai. Une issue de suivi porte l'unification — quand elle aura lieu, c'est
 * ce fichier qui disparaîtra, et pas un appelant.
 *
 * ## Le client naît à la première commande, pas au démarrage
 *
 * Nest instancie ses fournisseurs avec impatience : ouvrir la socket dans le
 * constructeur ferait de **chaque** application montée — dont chaque suite de
 * test — un client Redis de plus, avec le minuteur de réessai qui va avec. Le
 * client est donc créé au premier appel, et une API qui ne sert jamais de
 * disponibilité n'ouvre jamais cette connexion.
 */

/** Au-delà, la commande rejette et l'appelant recalcule — voir l'en-tête. */
const COMMAND_TIMEOUT_MS = 200;

/**
 * Nombre de clés **visitées** par itération de `SCAN`.
 *
 * Visitées, et non rendues : `MATCH` filtre après le balayage. Une itération
 * parcourt donc cinq cents clés de l'espace **entier** — tous établissements
 * confondus — et peut n'en rendre aucune.
 */
const SCAN_BATCH = 500;

/**
 * Garde-fou du balayage : au-delà, on abandonne l'invalidation en cours.
 *
 * `SCAN` ne garantit qu'une chose sur son curseur — il finit par revenir à zéro.
 * Un espace de clés qui grossit plus vite qu'on ne le balaye tiendrait cette
 * boucle indéfiniment, sur le fil d'une requête HTTP.
 *
 * À cinq cents clés par itération, deux cents tours couvrent cent mille clés de
 * l'espace **partagé**, pas de celui d'un établissement : le coût comme la borne
 * sont ceux du cache de tous les tenants réunis. Deux conséquences à garder en
 * tête, et bornées l'une comme l'autre par le TTL de soixante secondes :
 * l'invalidation d'un salon paie le balayage des clés de ses voisins, et
 * au-delà de cent mille clés vivantes elle abandonne avant d'avoir tout jeté.
 * Le remède n'est pas un plafond plus haut — ce serait la latence de chaque
 * écriture d'agenda — mais un espace de clés versionné par tenant, dont
 * l'invalidation est un `INCR`. Une issue de suivi le porte.
 */
const MAX_SCAN_ITERATIONS = 200;

@Injectable()
export class RedisAvailabilityCacheStore implements AvailabilityCacheStore, OnModuleDestroy {
  private client: Redis | null = null;

  public constructor(
    private readonly config: AppConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Jette l'espace de clés d'un établissement, par balayage.
   *
   * `SCAN` et non `KEYS` : `KEYS` parcourt la totalité de l'espace de clés en
   * bloquant le serveur Redis — partagé par tous les établissements. Un salon
   * qui déplace un rendez-vous suspendrait alors le cache de tous les autres.
   *
   * `UNLINK` et non `DEL` : la libération se fait dans un fil de fond, ce qui
   * rend la commande constante en temps quel que soit le nombre de clés.
   */
  public async evictByPrefix(prefix: string): Promise<void> {
    const client = this.connect();

    if (client === null) {
      return;
    }

    // Hors de la boucle : le motif ne dépend pas du curseur, et le recalculer à
    // chaque tour ferait deux cents échappements pour une seule invalidation.
    const pattern = `${escapeGlob(prefix)}*`;

    try {
      let cursor = '0';
      let iterations = 0;

      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);

        if (keys.length > 0) {
          await client.unlink(...keys);
        }

        cursor = next;
        iterations += 1;
      } while (cursor !== '0' && iterations < MAX_SCAN_ITERATIONS);
    } catch (error: unknown) {
      this.degrade('invalidation', error);
    }
  }

  /**
   * Les valeurs demandées, en **un** aller-retour.
   *
   * Une plage de trente et un jours ferait trente et un allers-retours en
   * `GET` ; `MGET` en fait un. Sur un cache dont la raison d'être est un budget
   * de 300 ms, la différence n'est pas une optimisation, c'est la fonction.
   *
   * Un échec rend autant de défauts que de clés demandées : l'appelant traite le
   * cache injoignable exactement comme un cache froid.
   */
  public async readMany(keys: readonly string[]): Promise<readonly (string | null)[]> {
    const client = this.connect();

    if (client === null || keys.length === 0) {
      return keys.map(() => null);
    }

    try {
      return await client.mget(...keys);
    } catch (error: unknown) {
      this.degrade('lecture', error);

      return keys.map(() => null);
    }
  }

  /**
   * Écrit le lot, chaque clé avec son propre TTL.
   *
   * Un pipeline plutôt que `MSET` : `MSET` ne sait pas poser de durée de vie, et
   * des clés de disponibilité sans TTL survivraient à toute panne
   * d'invalidation — un cache qui ne périme jamais est pire qu'un cache absent.
   */
  public async writeMany(
    entries: readonly AvailabilityCacheEntry[],
    ttlSeconds: number,
  ): Promise<void> {
    const client = this.connect();

    if (client === null || entries.length === 0) {
      return;
    }

    try {
      const pipeline = client.pipeline();

      for (const entry of entries) {
        pipeline.set(entry.key, entry.value, 'EX', ttlSeconds);
      }

      await pipeline.exec();
    } catch (error: unknown) {
      this.degrade('écriture', error);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    const client = this.client;

    if (client === null) {
      return;
    }

    this.client = null;

    // Même conduite que `CacheConnection` : `quit()` sur un client jamais
    // connecté (`wait`) ou déjà fermé (`end`) reste en attente indéfiniment.
    if (client.status === 'end' || client.status === 'wait') {
      client.disconnect();
      return;
    }

    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  /**
   * Le client, créé à la demande — ou `null` si sa création échoue.
   *
   * Une URL Redis mal formée est la seule façon dont le constructeur d'ioredis
   * lève ; elle ne doit pas plus faire échouer une réservation qu'un serveur
   * éteint.
   */
  private connect(): Redis | null {
    if (this.client !== null) {
      return this.client;
    }

    try {
      const client = new Redis(this.config.redisUrl, {
        lazyConnect: true,
        connectTimeout: 2_000,
        commandTimeout: COMMAND_TIMEOUT_MS,
        // Le réessai interne d'une commande de cache n'a aucun intérêt : le
        // recalcul coûte moins cher que l'attente.
        maxRetriesPerRequest: 1,
        retryStrategy: (attempt: number): number => Math.min(attempt * 200, 2_000),
      });

      // Un `error` non écouté sur un client ioredis termine le processus. Le
      // message est journalisé en `debug`, jamais renvoyé au client HTTP.
      client.on('error', (error: Error) => {
        this.logger.debug(
          `Erreur du client Redis du cache de disponibilité : ${error.message}`,
          RedisAvailabilityCacheStore.name,
        );
      });

      this.client = client;

      return client;
    } catch (error: unknown) {
      this.degrade('connexion', error);

      return null;
    }
  }

  /** Journalise la panne et rend la main — le cache se tait, l'API continue. */
  private degrade(operation: string, error: unknown): void {
    this.logger.warn(
      `Cache de disponibilité indisponible (${operation}) : ${describe(error)} — ` +
        'la réponse est recalculée.',
      RedisAvailabilityCacheStore.name,
    );
  }
}

/**
 * Neutralise les métacaractères de motif d'un préfixe.
 *
 * Le préfixe est aujourd'hui bâti sur un UUID, qui n'en contient aucun. La
 * précaution vise le jour où il n'en serait plus un : un `*` glissé dans un
 * préfixe ferait déborder l'invalidation d'un établissement sur ses voisins,
 * c'est-à-dire exactement la frontière que la clé existe pour tenir
 * (tenant-isolation §5).
 */
function escapeGlob(value: string): string {
  return value.replace(/[?*[\]^\\-]/g, (character) => `\\${character}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
