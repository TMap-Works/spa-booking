import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { ReportExportConfig } from './export/report-export.config';
import { ReportExportService } from './export/report-export.service';
import {
  REPORT_EXPORT_STORAGE,
  reportExportStorageFactory,
} from './export/report-export.storage';
import { ReportingController } from './reporting.controller';
import { ReportingRepository } from './reporting.repository';
import { ReportingService } from './reporting.service';

/**
 * Module `reporting` — agrégation du revenu, du volume de rendez-vous et des
 * no-shows (CDC §2.3, #74).
 *
 * ## Ce qu'il importe
 *
 * `IdentityModule`, et **seulement** pour ses gardes : `@AuthAtLeast('MANAGER')`
 * monte `JwtAuthGuard` et `RolesGuard`, qui ont des dépendances à injecter.
 * C'est la voie prévue par api-module §3, et rien ici n'atteint
 * `IdentityRepository`.
 *
 * ## Ce qu'il n'importe pas, et c'est le point
 *
 * Ni `PaymentsModule`, ni `AppointmentsModule`, ni `CatalogModule`, alors qu'il
 * agrège leurs trois tables. Le couplage aurait été à contresens : un rapport
 * est une **projection en lecture seule** qui ne décide d'aucune règle de cycle
 * de vie, et un agrégat sur un an de rendez-vous ne se compose pas d'appels de
 * service — la voie « appel de service » d'api-module §3 sert une lecture
 * unitaire, pas un balayage.
 *
 * Importer `AppointmentsService` pour compter des no-shows aurait mis la
 * question du reporting dans le module des rendez-vous, et fait dépendre le
 * tableau de bord du cycle de vie qu'il observe. C'est le même arbitrage que
 * celui de `CrmRepository` pour l'historique de visites, et il est argumenté au
 * même endroit : en tête du dépôt.
 *
 * ## Ce qu'il exporte : rien
 *
 * Aucun service n'en sort. Un module qui ne fait que lire n'a rien à offrir aux
 * autres, et ouvrir une porte ici reviendrait à offrir à n'importe quel module
 * le chiffre d'affaires de l'établissement — la donnée que ce module garde
 * derrière `MANAGER`.
 *
 * ## Aucune table, aucune écriture **en base**
 *
 * Ce module ne possède rien dans le schéma : les seuls objets que #74 y a
 * ajoutés sont **deux index**, et ils appartiennent aux tables de `payments` et
 * d'`appointments`. Il n'a donc ni migration de table, ni entité, ni cycle de
 * vie — et pas un `INSERT`.
 *
 * #563 y ajoute une écriture, et une seule : le **dépôt d'un fichier** dans un
 * bucket S3. Ce n'est pas une exception à ce qui précède — un objet purgé au
 * bout de quelques jours par le cycle de vie du bucket n'est pas un état que
 * quiconque relira comme une vérité métier, c'est une photographie de lectures.
 * Le module continue de ne rien posséder dans le schéma.
 *
 * ## L'entrepôt d'export est monté par fabrique, jamais en dur
 *
 * `REPORT_EXPORT_STORAGE` résout vers S3 quand `REPORT_EXPORT_BUCKET` est posée,
 * et vers un entrepôt de repli qui refuse en 503 sinon
 * (`export/report-export.storage.ts`). Deux conséquences voulues : aucune suite
 * d'intégration du dépôt n'a besoin d'un compte AWS — `AppModule` monte les huit
 * modules métier, donc celui-ci —, et un déploiement sans bucket démarre au lieu
 * de refuser de servir le reste de l'API.
 */
@Module({
  imports: [IdentityModule],
  controllers: [ReportingController],
  providers: [
    ReportingService,
    ReportingRepository,
    ReportExportService,
    // `process.env` lu à la construction, comme `NotificationsConfig` et
    // `StripeConfig` : la clé n'entre pas dans `config/env.schema.ts`, dont
    // l'absence ferait échouer au démarrage des suites qui ne parlent pas
    // d'export.
    { provide: ReportExportConfig, useFactory: () => new ReportExportConfig(process.env) },
    {
      provide: REPORT_EXPORT_STORAGE,
      useFactory: reportExportStorageFactory,
      inject: [ReportExportConfig],
    },
  ],
})
export class ReportingModule {}
