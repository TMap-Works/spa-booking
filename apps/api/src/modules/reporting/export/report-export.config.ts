import { Injectable } from '@nestjs/common';
import { MAX_REPORT_EXPORT_TTL_SECONDS } from '@spa/shared';

/**
 * La configuration de l'entrepôt d'exports — bucket, région, durée de vie des
 * URL présignées (#563).
 *
 * ## Pourquoi ici et non dans `config/env.schema.ts`
 *
 * Même raison que `notifications/notifications.config.ts` et que
 * `payments/stripe/stripe.config.ts`, et `env.schema.ts` l'annonce lui-même :
 * « chaque module métier ajoutera ses propres clés au moment où il les lit
 * réellement ». `AppModule` monte les huit modules métier, donc **toutes** les
 * suites d'intégration du dépôt : imposer un nom de bucket au démarrage ferait
 * échouer des suites qui ne parlent que de créneaux, et bloquerait un
 * déploiement de recette où l'export n'est pas encore branché.
 *
 * ## « Non configuré » n'est pas un refus de démarrer
 *
 * Sans bucket, la route d'export répond 503 à chaque appel
 * (`ReportExportUnavailableError`) et les trois routes de lecture continuent de
 * servir. C'est le **défaut fermé, par requête** déjà retenu pour la chaîne de
 * notifications : bruyant du bon côté — l'export échoue visiblement — plutôt que
 * silencieux du mauvais, ce qu'un fichier vide ou une URL bidon aurait été.
 *
 * ## La durée de vie est plafonnée par le serveur, pas négociée
 *
 * {@link MAX_REPORT_EXPORT_TTL_SECONDS} vient du contrat partagé et vaut quinze
 * minutes. Une valeur d'environnement plus longue est **refusée au démarrage**
 * plutôt que rabotée en silence : une URL présignée est un porteur, et un
 * opérateur qui écrit `86400` croit poser une journée de confort alors qu'il
 * pose une journée de fuite. Mieux vaut qu'il l'apprenne du message d'erreur.
 *
 * L'appelant, lui, ne choisit rien : aucune route n'expose la durée de vie.
 */

/** Variable qui porte le nom du bucket d'export — sortie du module Terraform. */
export const REPORT_EXPORT_BUCKET_ENV = 'REPORT_EXPORT_BUCKET';

/**
 * Région du bucket.
 *
 * `AWS_REGION` plutôt qu'une variable dédiée : c'est le nom que le SDK lit de
 * lui-même, et deux variables de région pour un même compte finissent par
 * diverger.
 *
 * **Elle doit être posée en déployé.** Contrairement à Lambda, ECS n'injecte
 * aucune variable de région dans le conteneur : le SDK JS v3 ne la résout que
 * depuis `AWS_REGION`, `AWS_DEFAULT_REGION` ou un profil de configuration, et à
 * défaut le premier appel échoue sur « Region is missing ». La définition de
 * tâche la pose donc explicitement (`infra/terraform/envs/dev/main.tf`). Elle
 * reste facultative ici pour les postes locaux, où un profil AWS la fournit.
 */
export const AWS_REGION_ENV = 'AWS_REGION';

/** Variable facultative qui abaisse la durée de vie des URL présignées. */
export const REPORT_EXPORT_TTL_ENV = 'REPORT_EXPORT_URL_TTL_SECONDS';

/** Plancher de durée de vie : en deçà, l'URL périme avant le clic. */
export const MIN_REPORT_EXPORT_TTL_SECONDS = 60;

/** Ce qu'une configuration résolue porte — ou `null` si rien n'est branché. */
export interface ReportExportSettings {
  readonly bucket: string;
  readonly region: string | null;
  readonly ttlSeconds: number;
}

/**
 * Résout la configuration d'export depuis un environnement.
 *
 * Fonction pure et exportée pour elle-même : c'est le cœur testable du
 * fournisseur, exercé sans monter la moindre application Nest.
 *
 * @throws {Error} si la durée de vie est présente mais hors bornes. Le message
 * nomme la variable et la borne franchie — aucune de ces valeurs n'est un
 * secret.
 */
export function resolveReportExportSettings(
  source: NodeJS.ProcessEnv,
): ReportExportSettings | null {
  const bucket = source[REPORT_EXPORT_BUCKET_ENV]?.trim() ?? '';

  // `''` est ce qu'ECS produit pour une variable déclarée sans valeur : c'est
  // « pas posée », pas « mal posée ».
  if (bucket === '') {
    return null;
  }

  const region = source[AWS_REGION_ENV]?.trim() ?? '';

  return {
    bucket,
    region: region === '' ? null : region,
    ttlSeconds: resolveTtlSeconds(source[REPORT_EXPORT_TTL_ENV]),
  };
}

/** La durée de vie demandée, ou le plafond du contrat à défaut. */
function resolveTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return MAX_REPORT_EXPORT_TTL_SECONDS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Configuration d'export invalide : ${REPORT_EXPORT_TTL_ENV} doit être un nombre entier de secondes.`,
    );
  }

  if (parsed < MIN_REPORT_EXPORT_TTL_SECONDS || parsed > MAX_REPORT_EXPORT_TTL_SECONDS) {
    throw new Error(
      `Configuration d'export invalide : ${REPORT_EXPORT_TTL_ENV} doit être compris entre ` +
        `${MIN_REPORT_EXPORT_TTL_SECONDS} et ${MAX_REPORT_EXPORT_TTL_SECONDS} secondes — une URL ` +
        'présignée est un porteur, et sa durée de vie est la seule chose qui borne les dégâts.',
    );
  }

  return parsed;
}

@Injectable()
export class ReportExportConfig {
  /** `null` sur un déploiement sans bucket d'export — la route répond alors 503. */
  private readonly settings: ReportExportSettings | null;

  public constructor(source: NodeJS.ProcessEnv = process.env) {
    this.settings = resolveReportExportSettings(source);
  }

  /** `false` sur un poste local sans entrepôt branché. */
  public get isConfigured(): boolean {
    return this.settings !== null;
  }

  /** La configuration résolue, ou `null` — jamais une valeur inventée. */
  public get resolved(): ReportExportSettings | null {
    return this.settings;
  }
}
