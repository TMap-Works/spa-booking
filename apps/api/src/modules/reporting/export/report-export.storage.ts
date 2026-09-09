/**
 * L'entrepôt d'exports — la seule frontière du module `reporting` avec AWS.
 *
 * ## Pourquoi une interface plutôt qu'un `S3Client` injecté
 *
 * Parce que trois choses seulement intéressent le service — déposer, retrouver,
 * signer — et qu'un `S3Client` en offre deux cents. Réduire la
 * surface est ce qui rend le double de test honnête : un faux entrepôt qui
 * implémente trois méthodes reproduit *tout* ce que le vrai sait faire, alors
 * qu'un faux client S3 reproduirait ce qu'on a pensé à reproduire.
 *
 * C'est aussi ce qui permet aux suites d'intégration de monter l'application
 * entière sans compte AWS ni bouchon réseau : `AppModule` monte les huit modules
 * métier, et une dépendance S3 non substituable aurait fait de chaque suite du
 * dépôt une suite qui parle à Internet.
 *
 * ## Ce que cette frontière **ne** fait pas
 *
 * Elle ne construit **aucune clé**. Les clés viennent de `report-export.key.ts`,
 * qui les préfixe par l'établissement du jeton ; l'entrepôt reçoit une clé déjà
 * composée et ne sait pas ce qu'un tenant est. C'est délibéré : une couche qui
 * ignore la notion de tenant ne peut pas la franchir par erreur.
 *
 * Elle ne décide pas non plus de la durée de vie : elle la reçoit, plafonnée en
 * amont par `ReportExportConfig`.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { ReportExportConfig, type ReportExportSettings } from './report-export.config';
import { ReportExportUnavailableError } from '../reporting.errors';

/** Jeton d'injection de l'entrepôt — l'interface n'existe pas à l'exécution. */
export const REPORT_EXPORT_STORAGE = Symbol('REPORT_EXPORT_STORAGE');

/** Ce qu'il faut déposer : une clé déjà préfixée, un corps, un type. */
export interface ReportExportUpload {
  readonly key: string;
  readonly body: string;
  readonly contentType: string;
  /** Nom servi au téléchargement, via `Content-Disposition`. */
  readonly filename: string;
}

/** Ce qu'il faut pour signer une lecture : la clé, le nom, la durée de vie. */
export interface ReportExportSignature {
  readonly key: string;
  readonly filename: string;
  readonly ttlSeconds: number;
}

/**
 * Ce qu'un objet déposé apprend à qui le retrouve — son nom de téléchargement,
 * et rien d'autre.
 *
 * Le nom **n'est pas** reconstructible depuis la clé : celle-ci ne porte qu'un
 * UUID (`report-export.key.ts`), pas le slug ni la période. Le relire ici est
 * donc la seule façon pour la re-signature de rendre le même nom de fichier que
 * la création — sans quoi le fichier rouvert atterrirait sous un identifiant
 * technique dans le dossier de téléchargements.
 */
export interface ReportExportObject {
  readonly filename: string;
}

/**
 * La métadonnée utilisateur S3 qui porte ce nom.
 *
 * Une métadonnée plutôt qu'une relecture de `Content-Disposition` : ce dernier
 * est un en-tête à analyser — deux formes, un encodage de pourcentage, des
 * guillemets —, là où une métadonnée se relit telle quelle.
 */
export const REPORT_EXPORT_FILENAME_METADATA = 'filename';

export interface ReportExportStorage {
  /** Dépose l'objet. Écrase la clé si elle existe — elle est tirée au sort. */
  put(upload: ReportExportUpload): Promise<void>;

  /** L'objet **à cette clé exacte**, ou `null`. Aucune énumération. */
  find(key: string): Promise<ReportExportObject | null>;

  /** Une URL de lecture présignée, valable `ttlSeconds` et pas davantage. */
  presign(signature: ReportExportSignature): Promise<string>;
}

/**
 * L'entrepôt S3 — l'implémentation servie dès qu'un bucket est configuré.
 *
 * ## Le client est construit une fois, à l'amorçage
 *
 * Un `S3Client` tient une chaîne de résolution d'identifiants et un pool de
 * connexions : en fabriquer un par requête ferait payer une résolution de rôle
 * de tâche à chaque export, et ouvrirait autant de sockets.
 *
 * ## Les identifiants ne sont jamais dans le code
 *
 * Aucune clé d'accès n'est lue, ni passée, ni journalisée. En déployé, le SDK
 * prend le **rôle de tâche ECS** — celui auquel le module Terraform
 * `reporting-export` attache sa politique, et qui n'a de droits que sur ce
 * bucket-là. C'est le même arbitrage que partout ailleurs dans le dépôt : aucun
 * secret dans le code, aucun dans l'environnement quand une identité suffit.
 *
 * ## Le chiffrement au repos n'est pas demandé ici
 *
 * Le bucket porte une configuration de chiffrement par défaut, appliquée par S3
 * à tout objet déposé. Le redemander à chaque `PutObject` serait redondant, et
 * surtout dangereux : deux endroits qui décident du chiffrement finissent par
 * diverger, et c'est celui qui n'est pas dans le module Terraform qu'on oublie
 * de revoir.
 */
@Injectable()
export class S3ReportExportStorage implements ReportExportStorage {
  private readonly logger = new Logger(S3ReportExportStorage.name);

  private readonly client: S3Client;

  private readonly bucket: string;

  public constructor(settings: ReportExportSettings) {
    this.bucket = settings.bucket;
    // Composé plutôt que déclaré d'un bloc : sous `exactOptionalPropertyTypes`,
    // un `region: undefined` explicite n'est pas la même chose qu'une région
    // absente, et le SDK cesserait alors de la déduire de son environnement.
    this.client = new S3Client(settings.region === null ? {} : { region: settings.region });
  }

  public async put(upload: ReportExportUpload): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: upload.key,
        Body: upload.body,
        ContentType: upload.contentType,
        ContentDisposition: contentDisposition(upload.filename),
        // Le même nom, rangé là où il se relit sans analyse d'en-tête : la
        // re-signature en a besoin, et la clé ne le porte pas.
        Metadata: { [REPORT_EXPORT_FILENAME_METADATA]: asciiMetadata(upload.filename) },
      }),
    );
  }

  /**
   * `HeadObject` plutôt que `ListObjectsV2` sur le préfixe du tenant.
   *
   * Une énumération dirait « voici les exports de cet établissement », ce dont
   * aucune route n'a besoin, et il faudrait alors accorder `s3:ListBucket` —
   * c'est-à-dire le droit de parcourir le bucket **entier**, tous préfixes
   * confondus, puisque S3 n'attache ce droit qu'au bucket. Une clé exacte suffit
   * à la question posée, et la politique reste bornée aux objets.
   *
   * Un 404 ou un 403 remontent tous deux `null` : sur un bucket dont on n'a pas
   * `ListBucket`, S3 répond 403 pour un objet absent — ce que le SDK remonte
   * en `NotFound` ou en `Forbidden` selon les cas. La distinction n'intéresse
   * personne ici : dans les deux cas, l'appelant n'a rien à cette clé, et la
   * réponse est un 404 d'API (tenant-isolation §4).
   */
  public async find(key: string): Promise<ReportExportObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      // La métadonnée peut manquer sur un objet déposé avant qu'elle n'existe :
      // le nom est alors laissé vide, et c'est l'appelant qui retombe sur son
      // repli. Un `undefined` traversant la frontière serait plus discret et
      // ferait échouer plus loin.
      return { filename: head.Metadata?.[REPORT_EXPORT_FILENAME_METADATA] ?? '' };
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }

      // La clé n'est **pas** journalisée : elle porte l'identifiant de
      // l'établissement, et un journal est lu par plus de monde qu'une réponse.
      this.logger.error(
        `Lecture impossible dans le bucket d'export : ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  public async presign(signature: ReportExportSignature): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: signature.key,
        // Répété à la signature en plus du dépôt : `Content-Disposition` posé
        // sur l'objet vaut pour tout lecteur, celui-ci vaut pour cette URL. Les
        // deux disent la même chose, et le second couvre les objets déposés
        // avant que le premier n'existe.
        ResponseContentDisposition: contentDisposition(signature.filename),
      }),
      { expiresIn: signature.ttlSeconds },
    );
  }
}

/**
 * L'entrepôt de repli — celui d'un déploiement où aucun bucket n'est branché.
 *
 * Il refuse chaque appel en 503 plutôt que de laisser l'application démarrer
 * puis échouer d'un `undefined` au premier export. Même régime que
 * `UnconfiguredNotificationSender` : **défaut fermé, par requête**, bruyant du
 * bon côté. Les trois routes de lecture du module continuent de servir — c'est
 * l'export qui manque, pas le reporting.
 */
@Injectable()
export class UnconfiguredReportExportStorage implements ReportExportStorage {
  public put(): Promise<void> {
    return Promise.reject(new ReportExportUnavailableError());
  }

  public find(): Promise<ReportExportObject | null> {
    return Promise.reject(new ReportExportUnavailableError());
  }

  public presign(): Promise<string> {
    return Promise.reject(new ReportExportUnavailableError());
  }
}

/**
 * L'entrepôt à monter, selon ce que l'environnement fournit.
 *
 * Une fabrique et non deux fournisseurs conditionnels : le service dépend d'un
 * seul jeton, et c'est ce qui fait qu'il n'a pas à savoir qu'un déploiement sans
 * bucket existe.
 */
export function reportExportStorageFactory(config: ReportExportConfig): ReportExportStorage {
  const settings = config.resolved;

  return settings === null
    ? new UnconfiguredReportExportStorage()
    : new S3ReportExportStorage(settings);
}

/**
 * L'en-tête qui fait proposer un **téléchargement** plutôt qu'un affichage, sous
 * le nom voulu.
 *
 * Deux formes dans le même en-tête, comme RFC 6266 le prévoit : `filename` en
 * ASCII pour les clients anciens, `filename*` en UTF-8 encodé pour les autres.
 * Un slug d'établissement est déjà en ASCII, mais rien ne garantit qu'il le
 * reste, et un nom accentué dans la forme brute produit un en-tête invalide que
 * certains clients rejettent entièrement.
 *
 * Les guillemets et les antislashs sont retirés de la forme brute : ce sont les
 * deux caractères qui refermeraient la chaîne citée et permettraient d'injecter
 * un second en-tête.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/["\\]/g, '');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Le nom, réduit à ce qu'une métadonnée S3 accepte.
 *
 * Les métadonnées utilisateur voyagent dans des **en-têtes HTTP** : tout ce qui
 * sort de l'ASCII imprimable y est rejeté ou mutilé selon le client. Un nom de
 * fichier d'export est déjà en ASCII — un slug l'est, deux dates aussi —, mais
 * rien ne garantit qu'un slug le reste, et un en-tête invalide ferait échouer le
 * dépôt lui-même. Le nom exact, lui, continue de voyager encodé dans
 * `Content-Disposition`.
 */
function asciiMetadata(value: string): string {
  return value.replaceAll(/[^ -~]/g, '_');
}

/** `true` quand S3 dit qu'il n'y a rien à cette clé — 404 comme 403. */
function isMissingObject(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) {
    return false;
  }

  const status = error.$metadata.httpStatusCode;

  return status === 404 || status === 403;
}
