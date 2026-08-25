import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfigService } from '../../config/app-config.service';
import { StructuredLogger } from '../../common/logging/structured-logger';

/**
 * Pool PostgreSQL **de service** : il n'existe que pour que `/health` puisse
 * prouver que la base répond réellement, et pour les rares besoins de SQL brut
 * (contrainte d'exclusion, verrou consultatif) que Prisma n'exprime pas.
 *
 * L'accès aux données métier passera par Prisma (#19). Ce pool ne doit pas
 * devenir un second chemin d'accès au schéma : aucun repository ne l'injecte.
 *
 * Le pool est délibérément petit et paresseux — il n'ouvre une connexion qu'au
 * premier `ping()`. Une base indisponible ne doit pas empêcher le conteneur de
 * démarrer : c'est `/health` qui le signale, ce qui laisse l'ALB retirer la
 * tâche du service au lieu de la voir tomber en boucle de redémarrage.
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

  /** `SELECT 1` sur une connexion réellement empruntée au pool. */
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
