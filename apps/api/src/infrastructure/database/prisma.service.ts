import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Client Prisma unique de l'application — **le** chemin d'accès aux données
 * métier. Il coexiste avec `DatabaseConnection` sans se confondre avec lui :
 * le pool `pg` sert la sonde `/health` et le SQL brut que Prisma n'exprime pas
 * (contrainte d'exclusion, verrou consultatif) ; Prisma sert tout le reste.
 * Seuls les repositories l'injectent — ni un contrôleur, ni un service métier
 * ne connaît le schéma (.claude/skills/api-module/SKILL.md §2).
 *
 * Trois choix méritent leur explication :
 *
 * 1. **Aucune connexion à l'initialisation.** `$connect()` n'est pas appelé :
 *    Prisma ouvre sa connexion à la première requête. Une base injoignable ne
 *    doit pas empêcher le conteneur de démarrer — c'est `/health` qui le
 *    signale, ce qui laisse l'ALB retirer la tâche du service au lieu de la voir
 *    tomber en boucle de redémarrage. Même raison que le `lazyConnect` du client
 *    Redis.
 * 2. **`errorFormat: 'minimal'`.** Le format riche recopie un extrait du schéma
 *    et l'URL de la source de données — mot de passe compris — dans le message
 *    d'erreur, qui finit dans CloudWatch Logs.
 * 3. **Les journaux `query` restent éteints.** Une requête journalisée porte ses
 *    paramètres, donc l'e-mail et le téléphone du client (CDC §5.1). Seuls
 *    `warn` et `error` sont écoutés, et ils passent par le logger structuré qui
 *    rédige.
 *
 * Le scoping automatique par `tenant_id` — l'extension Prisma décrite en
 * tenant-isolation §3 — n'est pas ici : il a besoin du contexte de requête
 * authentifié, qui arrive avec le module `identity`. Tant qu'il n'existe pas,
 * chaque repository porte son `where: { tenantId }` et le test de fuite de son
 * module en est la preuve.
 */
/**
 * Options passées au client, déclarées comme **type** et pas seulement comme
 * valeur : c'est de `log` que Prisma déduit les événements que `$on` accepte.
 * Sans ce paramètre de généricité, `$on('warn', …)` ne compile pas.
 */
type PrismaOptions = {
  datasourceUrl: string;
  errorFormat: 'minimal';
  log: [{ emit: 'event'; level: 'warn' }, { emit: 'event'; level: 'error' }];
};

@Injectable()
export class PrismaService extends PrismaClient<PrismaOptions> implements OnModuleDestroy {
  public constructor(config: AppConfigService, logger: StructuredLogger) {
    super({
      datasourceUrl: config.databaseUrl,
      errorFormat: 'minimal',
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    this.$on('warn', (event) => {
      logger.warn(event.message, PrismaService.name);
    });

    // Journalisé en `warn` et non en `error` : une erreur de requête est déjà
    // remontée à l'appelant, où le filtre d'exceptions la traduit et la
    // journalise avec son contexte HTTP. La compter deux fois en `error`
    // fausserait toute alarme assise sur ce palier.
    this.$on('error', (event) => {
      logger.warn(event.message, PrismaService.name);
    });
  }

  public async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
