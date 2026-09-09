import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ReportExport } from '@spa/shared';

import { NotFoundError } from '../../../common/errors';
import { requireTenantId } from '../../../common/tenant/tenant-context';
import { ReportExportUnavailableError } from '../reporting.errors';
import { ReportingRepository } from '../reporting.repository';
import { ReportingService } from '../reporting.service';
import type { ReportWindow } from '../reporting.types';
import { ReportExportConfig } from './report-export.config';
import { buildReportExportCsv } from './report-export.csv';
import {
  REPORT_EXPORT_CONTENT_TYPE,
  reportExportFilename,
  reportExportKey,
} from './report-export.key';
import { REPORT_EXPORT_STORAGE, type ReportExportStorage } from './report-export.storage';

/**
 * L'export du reporting servi par URL présignée — #563, et la seconde moitié du
 * cinquième critère de #75.
 *
 * ## Ce que ce service fait, dans l'ordre, et pourquoi cet ordre
 *
 * 1. il **relit les trois rapports** par `ReportingService`, jamais par le dépôt
 *    directement. C'est ce qui fait que le fichier et l'écran disent la même
 *    chose : même validation de fenêtre, même fuseau, même dénominateur de
 *    no-show. Réécrire ces règles ici aurait créé une seconde définition du
 *    chiffre d'affaires, celle du fichier ;
 * 2. il **sérialise** — fonction pure, sans horloge et sans réseau ;
 * 3. il **dépose** sous une clé préfixée par le `tenant_id` ;
 * 4. il **signe** une lecture de durée bornée.
 *
 * La fenêtre est validée dès la première étape, avant que le moindre objet ne
 * soit déposé : un `?from=1970` refusé en 422 ne doit pas laisser un fichier
 * derrière lui.
 *
 * ## Ce module écrit — et c'est la seule chose qu'il écrive
 *
 * `reporting.repository.ts` s'ouvre sur « aucune écriture, pas un `INSERT` », et
 * cela reste vrai : ce service n'écrit **rien en base**. Il dépose un objet dans
 * un bucket, ce qui n'est ni une ligne, ni une transaction, ni un état que
 * quiconque relira comme une vérité métier — le fichier est une **photographie**
 * de lectures, purgée par le cycle de vie du bucket au bout de quelques jours.
 *
 * ## La frontière de tenant, en un paragraphe
 *
 * L'établissement vient de `requireTenantId()` — du contexte de requête,
 * c'est-à-dire du jeton vérifié — et de nulle part ailleurs. Aucune route ne
 * prend de `tenantId`, aucune ne prend de clé. Un `exportId` reçu est recomposé
 * en clé **sous le préfixe de l'appelant** : présenté par un salon voisin, il
 * désigne un objet qui n'existe pas chez lui, et {@link resign} rend 404 —
 * jamais 403, qui confirmerait l'existence, jamais l'URL (tenant-isolation §4).
 */
@Injectable()
export class ReportExportService {
  public constructor(
    private readonly reporting: ReportingService,
    private readonly repository: ReportingRepository,
    private readonly config: ReportExportConfig,
    @Inject(REPORT_EXPORT_STORAGE) private readonly storage: ReportExportStorage,
  ) {}

  /**
   * Produit l'export de la fenêtre et rend son URL présignée.
   *
   * Les cinq lectures partent **ensemble** : aucune ne dépend d'une autre, et
   * les enchaîner ferait payer cinq allers-retours à un geste déjà lent. C'est
   * le même arbitrage que celui de l'écran de #75, qui mène exactement les mêmes
   * cinq lectures de front.
   *
   * **Les trois axes de volume, et pas seulement `day`.** L'écran de #75
   * exportait l'axe que la gérante avait filtré — par praticien, par prestation
   * ou par jour — et n'exporter que `day` aurait fait du fichier serveur un
   * appauvrissement du fichier navigateur qu'il remplace. Les trois sections
   * cohabitent dans le CSV (`volume_day`, `volume_staff`, `volume_service`), ce
   * qui rend le fichier **indépendant du filtre** : un seul export répond aux
   * trois questions, là où il fallait trois clics.
   *
   * L'identifiant est tiré au sort à chaque appel : deux exports de la même
   * période ne s'écrasent pas, et une clé ne se devine pas
   * (`report-export.key.ts`).
   *
   * @throws {ReportWindowInvalidError} fenêtre inversée ou vide — 422.
   * @throws {ReportWindowTooWideError} fenêtre de plus d'un an — 422.
   * @throws {NotFoundError} l'établissement a disparu sous la requête — 404.
   * @throws {ReportExportUnavailableError} aucun bucket branché — 503.
   */
  public async create(window: ReportWindow): Promise<ReportExport> {
    const ttlSeconds = this.requireTtlSeconds();
    const tenantId = requireTenantId('Tenant', 'createReportExport');

    const [revenue, byDay, byStaff, byService, noShows, slug] = await Promise.all([
      this.reporting.dailyRevenue(window),
      this.reporting.appointmentVolume(window, 'day'),
      this.reporting.appointmentVolume(window, 'staff'),
      this.reporting.appointmentVolume(window, 'service'),
      this.reporting.noShows(window),
      this.requireSlug(),
    ]);

    const exportId = randomUUID();
    const key = reportExportKey(tenantId, exportId);
    const filename = reportExportFilename(slug, window, revenue.timeZone);

    await this.storage.put({
      key,
      filename,
      body: buildReportExportCsv({
        window,
        timeZone: revenue.timeZone,
        revenue,
        volumes: [byDay, byStaff, byService],
        noShows,
      }),
      contentType: REPORT_EXPORT_CONTENT_TYPE,
    });

    return this.sign(exportId, key, filename, ttlSeconds);
  }

  /**
   * Re-signe un export déjà produit — l'URL est éphémère, le fichier ne l'est
   * pas encore.
   *
   * Sans cette route, une URL périmée obligerait à **reproduire** le fichier :
   * une seconde lecture des trois rapports, un second objet dans le bucket, et
   * un fichier qui peut différer du premier si une caisse est tombée
   * entre-temps. Re-signer rend le même fichier, ce qui est exactement ce qu'on
   * attend d'un lien qu'on rouvre.
   *
   * L'existence est vérifiée avant la signature, et c'est ce qui fait le 404 :
   * `getSignedUrl` ne parle à personne — il calcule une signature localement, et
   * signerait joyeusement la clé d'un objet absent. Sans le `HeadObject`, la
   * route rendrait une URL à tout le monde, et la fuite ne se verrait qu'au
   * moment où le voisin la suivrait.
   *
   * @throws {NotFoundError} aucun export à cet identifiant **chez l'appelant**.
   * @throws {ReportExportUnavailableError} aucun bucket branché — 503.
   */
  public async resign(exportId: string): Promise<ReportExport> {
    // Le 503 se décide **avant** la lecture : sans entrepôt, il n'y a pas de
    // « pas trouvé » à distinguer d'un « pas configuré », et rendre 404 sur un
    // environnement sans bucket ferait chercher un fichier là où il manque une
    // variable d'environnement.
    const ttlSeconds = this.requireTtlSeconds();
    const tenantId = requireTenantId('Tenant', 'resignReportExport');
    const key = reportExportKey(tenantId, exportId);

    const found = await this.storage.find(key);

    if (found === null) {
      // Le message ne distingue pas « jamais produit », « purgé par le cycle de
      // vie » et « appartient à un autre établissement » : les trois se
      // ressemblent de l'extérieur, et c'est voulu.
      throw new NotFoundError('Export introuvable.');
    }

    // Le nom du fichier n'est pas dans la clé (`report-export.key.ts`) : il est
    // **relu de l'objet**, que le dépôt a nommé. Le reconstruire ici était
    // impossible — la clé ne porte ni le slug ni la période — et l'inventer
    // aurait donné le change : `ResponseContentDisposition` d'une URL présignée
    // l'emporte sur l'en-tête posé sur l'objet, si bien qu'un nom improvisé
    // n'aurait pas été un repli, mais le nom sous lequel le fichier atterrit.
    //
    // L'identifiant technique ne sert donc que d'ultime recours, pour un objet
    // déposé avant que la métadonnée n'existe.
    const filename = found.filename === '' ? `${exportId}.csv` : found.filename;

    return this.sign(exportId, key, filename, ttlSeconds);
  }

  /** L'enveloppe de réponse : l'URL signée et l'instant où elle cesse de valoir. */
  private async sign(
    exportId: string,
    key: string,
    filename: string,
    ttlSeconds: number,
  ): Promise<ReportExport> {
    // `expiresAt` est calculé **avant** la signature, jamais après : le calcul
    // de signature prend quelques millisecondes, et annoncer une échéance plus
    // tardive que la vraie ferait suivre une URL déjà morte.
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const url = await this.storage.presign({ key, filename, ttlSeconds });

    return { id: exportId, url, expiresAt, filename };
  }

  /**
   * Le slug de l'établissement courant — ou 404.
   *
   * `tenants.slug` est `NOT NULL` et unique : son absence ne peut venir que d'un
   * établissement qui n'existe plus. Même conduite que `requireTimeZone` du
   * service de reporting, et le 404 y est la seule réponse qui n'apprenne rien.
   */
  private async requireSlug(): Promise<string> {
    const slug = await this.repository.currentSlug();

    if (slug === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    return slug;
  }

  /**
   * La durée de vie des URL de cet environnement — ou le refus 503.
   *
   * Appelé **en premier** par les deux routes, avant toute lecture et tout
   * dépôt. L'entrepôt de repli refuse déjà chaque appel de son côté, et ces deux
   * gardes disent la même chose ; les deux existent parce qu'elles ne protègent
   * pas au même endroit — celle-ci fait que le 503 est rendu **avant** qu'un
   * autre refus plus spécifique ne prenne les devants, ce qui ferait chercher un
   * fichier absent là où il manque une variable d'environnement.
   */
  private requireTtlSeconds(): number {
    const settings = this.config.resolved;

    if (settings === null) {
      throw new ReportExportUnavailableError();
    }

    return settings.ttlSeconds;
  }
}
