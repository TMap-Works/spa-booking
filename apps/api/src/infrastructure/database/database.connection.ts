import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfigService } from '../../config/app-config.service';
import { StructuredLogger } from '../../common/logging/structured-logger';

/**
 * Pool PostgreSQL **de service** : il n'existe que pour que `/health` puisse
 * prouver que la base répond réellement. Rien d'autre.
 *
 * Il a d'abord été documenté comme couvrant aussi « les rares besoins de SQL
 * brut (contrainte d'exclusion, verrou consultatif) que Prisma n'exprime pas ».
 * #268 a fermé cette porte : ce SQL-là s'écrit en migration, ou via `$queryRaw`
 * / `$executeRaw` sur le client Prisma, où une garde le lit. Un pool que rien
 * n'inspecte n'a pas à être le chemin recommandé de ce qu'il y a de plus
 * sensible à écrire.
 *
 * L'accès aux données métier passera par Prisma (#19). Ce pool ne doit pas
 * devenir un second chemin d'accès au schéma : aucun repository ne l'injecte.
 *
 * Le pool est délibérément petit et paresseux — il n'ouvre une connexion qu'au
 * premier `ping()`. Une base indisponible ne doit pas empêcher le conteneur de
 * démarrer : c'est `/health` qui le signale, ce qui laisse l'ALB retirer la
 * tâche du service au lieu de la voir tomber en boucle de redémarrage.
 *
 * ## Exemption de lint, actée (#268)
 *
 * Le `client.query(…)` ci-dessous **n'est inspecté par aucune garde de scoping**
 * — ni l'extension `tenant-scope.extension.ts`, qui ne voit que Prisma, ni
 * `tenant/raw-sql-tenant-filter`, qui ne connaît que les quatre portes de SQL
 * brut de Prisma. C'est une exemption délibérée, pas un oubli, et l'ADR 0006 en
 * porte le raisonnement complet. En bref : intercepter `.query` sur son seul nom
 * produirait aujourd'hui 100 % de faux positifs — les quatre appels du dépôt
 * sont légitimement sans tenant — et le faire proprement demanderait une règle
 * typée, mesurée à ×2 sur le temps de lint.
 *
 * ## Ce que cette exemption suppose
 *
 * Elle ne tient que tant que **ce fichier reste le seul accès `pg` du code
 * applicatif**, et que ce pool n'exécute que du SQL écrit ici. Deux appuis :
 *
 * - `tenant/service-pool-confinement` interdit mécaniquement d'importer `pg`
 *   ailleurs dans `src/**` — un second chemin brut ne peut pas apparaître sans
 *   que le lint le refuse ;
 * - `pool` est `private` et la classe n'expose **aucune méthode qui exécute du
 *   SQL fourni par l'appelant**. Ajouter un passe-plat du genre
 *   `query(sql: string)` rouvrirait le trou en entier, et aucune garde
 *   automatique ne le verrait : c'est le seul point que la relecture de ce
 *   fichier doit tenir.
 *
 * Le SQL brut dont le moteur de disponibilité a besoin — contrainte
 * d'exclusion, verrous consultatifs (ADR 0002) — s'écrit donc via `$queryRaw` /
 * `$executeRaw` sur le client Prisma, où `tenant/raw-sql-tenant-filter`
 * l'inspecte, et non par ce pool.
 */
@Injectable()
export class DatabaseConnection implements OnModuleDestroy {
  private readonly pool: Pool;

  public constructor(config: AppConfigService, logger: StructuredLogger) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });

    // Sans cet écouteur, une coupure réseau sur une connexion au repos émet un
    // `error` sur l'EventEmitter et **termine le processus**.
    this.pool.on('error', (error: Error) => {
      logger.warn(`Connexion PostgreSQL au repos perdue : ${error.message}`, DatabaseConnection.name);
    });
  }

  /**
   * `SELECT 1` sur une connexion réellement empruntée au pool.
   *
   * Le seul SQL de ce pool, et il est constant : ni table, ni paramètre, ni
   * donnée d'établissement. C'est ce qui rend l'exemption de scoping de l'en-tête
   * vérifiable d'un coup d'œil — et c'est ce qu'il faut préserver.
   */
  public async ping(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
