import { Injectable } from '@nestjs/common';

/**
 * La configuration propre au module `notifications` — le jeton que présentent
 * les fonctions Lambda de la chaîne d'envoi, et les trois réglages des
 * passerelles AWS (#799).
 *
 * ## Pourquoi ici et non dans `config/env.schema.ts`
 *
 * `env.schema.ts` l'annonce lui-même : « chaque module métier ajoutera ses
 * propres clés (JWT, Stripe, SES…) au moment où il les lit réellement ». C'est
 * la conduite qu'a prise `payments/stripe/stripe.config.ts`, et pour une raison
 * qui vaut mot pour mot ici : `AppModule` monte les huit modules métier, donc
 * **toutes** les suites d'intégration du dépôt. Imposer une variable de
 * notifications au démarrage ferait échouer des suites qui ne parlent que de
 * créneaux.
 *
 * ## Ce que « non configuré » veut dire, et pourquoi ce n'est pas un refus de
 * démarrer
 *
 * Le module entier fonctionne déjà ainsi : sans passerelle SES ni SNS,
 * `UnconfiguredNotificationSender` refuse chaque envoi en 503 et la ligne reste
 * reprenable. Un refus de démarrer sur ce jeton-ci serait donc incohérent — il
 * immobiliserait l'API entière pour une capacité que le reste de la chaîne
 * n'exige pas encore, et il bloquerait le déploiement de recette (#76) avant que
 * la chaîne ne soit branchée.
 *
 * Le régime retenu est le **défaut fermé, par requête** : sans jeton, la route
 * interne répond 503 à chaque appel. C'est bruyant du bon côté — le balayage
 * échoue à chaque heure, la Lambda le journalise, son alarme d'erreurs le voit —
 * plutôt que silencieux du mauvais, ce qu'un jeton facultatif accepté aurait été.
 *
 * ## Un jeton présent mais faible est refusé partout
 *
 * Même raisonnement que les préfixes de `StripeConfig` : une valeur **présente**
 * et dangereuse est refusée quel que soit l'environnement, parce qu'elle ne
 * devient pas inoffensive en développement. Un secret partagé de quelques
 * caractères se devine ; celui-ci ouvre une route qui lit les rendez-vous de
 * **tous** les établissements.
 *
 * La valeur n'apparaît dans aucun message d'erreur ni dans aucun journal — c'est
 * un secret, et les messages de ce fichier ne citent jamais ce qu'ils ont reçu.
 */

/** Variable d'environnement qui porte le jeton d'appel interne. */
export const NOTIFICATIONS_INTERNAL_TOKEN_ENV = 'NOTIFICATIONS_INTERNAL_TOKEN';

/**
 * En-tête par lequel une fonction Lambda de la chaîne se fait reconnaître.
 *
 * Ce n'est pas un choix libre : c'est celui qu'envoie déjà la Lambda d'envoi de
 * #67 (`headers['x-internal-token'] = token`), et le balayage de #71 présente le
 * même jeton à la même API. Un second nom d'en-tête aurait voulu dire un second
 * secret à faire tourner, pour la même frontière de confiance.
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * Longueur minimale du jeton.
 *
 * 32 caractères, soit l'ordre de grandeur d'un `openssl rand -hex 16`. En deçà,
 * un secret partagé se devine hors ligne, et il n'y a aucune raison légitime
 * d'en poser un plus court : personne ne le tape à la main.
 */
export const INTERNAL_TOKEN_MIN_LENGTH = 32;

/**
 * Résout le jeton d'appel interne depuis un environnement.
 *
 * Fonction pure et exportée pour elle-même : c'est le cœur testable du
 * fournisseur, exercé sans monter la moindre application Nest.
 *
 * @throws {Error} si le jeton est présent mais trop court — quel que soit
 * l'environnement. Le message nomme la variable, **jamais** sa valeur.
 */
export function resolveInternalToken(source: NodeJS.ProcessEnv): string | null {
  const raw = source[NOTIFICATIONS_INTERNAL_TOKEN_ENV];

  // `''` est ce qu'ECS produit pour une variable déclarée sans valeur : c'est
  // « pas posée », pas « mal posée ».
  if (raw === undefined || raw === '') {
    return null;
  }

  if (raw.length < INTERNAL_TOKEN_MIN_LENGTH) {
    throw new Error(
      `Configuration notifications invalide : ${NOTIFICATIONS_INTERNAL_TOKEN_ENV} doit compter ` +
        `au moins ${INTERNAL_TOKEN_MIN_LENGTH} caractères — un secret partagé plus court se devine, ` +
        'et celui-ci ouvre une route qui lit les rendez-vous de tous les établissements.',
    );
  }

  return raw;
}

/**
 * ## Les trois réglages des passerelles AWS, et pourquoi ils sont **différés**
 *
 * `NOTIFICATIONS_INTERNAL_TOKEN` est résolu au constructeur : il conditionne une
 * garde, donc le premier appel venu, et son seul mode de panne — une valeur trop
 * courte — est une faute d'exploitation qu'on veut voir au démarrage.
 *
 * Les trois suivants sont résolus au **premier usage**, et c'est le quatrième
 * critère d'acceptation de #799, au mot près : « validés au premier usage et non
 * au démarrage de l'API ». Trois raisons, dans cet ordre d'importance :
 *
 * 1. `AppModule` monte les huit modules métier, donc **toutes** les suites
 *    d'intégration du dépôt. Une adresse d'expéditeur mal formée ferait échouer
 *    l'amorçage de suites qui ne parlent que de créneaux ;
 * 2. une API qui refuserait de démarrer pour une capacité d'envoi immobiliserait
 *    la réservation, l'encaissement et le reporting — c'est-à-dire tout le
 *    produit — pour un e-mail. Le régime du module est le **défaut fermé par
 *    requête**, pas le refus de démarrer ;
 * 3. sur un déploiement sans SES ni SNS, rien n'est jamais lu : la configuration
 *    n'est pas seulement tolérée absente, elle n'est même pas consultée.
 *
 * ## Ce qu'aucune de ces valeurs ne fait, et c'est ce qui compte
 *
 * Aucune n'apparaît dans un message d'erreur ni dans un journal. Ce ne sont pas
 * des secrets au sens du jeton — une adresse d'expéditeur est publique, elle
 * s'affiche dans chaque e-mail reçu — mais l'URL de file porte l'identifiant du
 * compte AWS, et un journal est lu par plus de monde qu'une réponse. Les
 * messages de ce fichier nomment la **variable**, jamais sa valeur.
 */

/** Adresse d'expéditeur des e-mails — identité vérifiée côté SES. */
export const SES_FROM_EMAIL_ENV = 'SES_FROM_EMAIL';

/** Nom d'expéditeur alphanumérique des SMS, tel que SNS l'attend. */
export const SNS_SMS_SENDER_ID_ENV = 'SNS_SMS_SENDER_ID';

/**
 * URL de la file de découplage.
 *
 * ## Le nom est celui de l'infrastructure, au **singulier**, et c'est un piège
 *
 * `.env.example` a longtemps écrit `NOTIFICATIONS_QUEUE_URL`, au pluriel, là où
 * `infra/terraform/envs/{dev,staging,prod}/main.tf` compose
 * `notification_queue_env` sur la clé `NOTIFICATION_QUEUE_URL` — et la sortie
 * `dispatch_queue_url` du module le dit mot pour mot : « `NOTIFICATION_QUEUE_URL`
 * sur le conteneur de l'API ».
 *
 * Tant que la variable n'était lue par **personne** — c'est le cinquième constat
 * de #799 — les deux orthographes ont pu coexister sans conséquence. Du jour où
 * le publieur la lit, la divergence devient une panne muette : tout déploiement
 * retomberait sur l'expédition en processus sans qu'aucun journal ne le dise,
 * c'est-à-dire que le découplage que ce ticket pose serait supprimé en silence.
 *
 * C'est donc le nom d'ECS qui l'emporte, et `.env.example` qui a été corrigé. La
 * variable n'ayant jamais été lue, il n'y a aucune compatibilité à préserver, et
 * accepter les deux orthographes aurait laissé deux noms pour un réglage — la
 * situation dont cette divergence est née. Le contrat du README du module
 * Terraform ne se redéfinit pas ici : on s'y conforme.
 */
export const NOTIFICATION_QUEUE_URL_ENV = 'NOTIFICATION_QUEUE_URL';

/**
 * Région des clients AWS du module.
 *
 * `AWS_REGION` plutôt qu'une variable dédiée, pour la raison qu'expose déjà
 * `reporting/export/report-export.config.ts` : c'est le nom que le SDK lit de
 * lui-même, et deux variables de région pour un même compte finissent par
 * diverger. La constante est **redéclarée** ici plutôt qu'importée de là-bas :
 * api-module §3 tient les modules métier étanches, et un `import` depuis
 * `reporting` ferait dépendre l'expédition d'un message du module de reporting.
 *
 * Facultative : sur un poste local, un profil AWS la fournit ; en déployé, la
 * définition de tâche ECS la pose explicitement — ECS n'injecte aucune région
 * dans le conteneur, contrairement à Lambda.
 */
export const AWS_REGION_ENV = 'AWS_REGION';

/**
 * Longueur maximale d'un sender ID SNS — onze caractères alphanumériques.
 *
 * Le module Terraform pose la même borne, et pour la même raison qu'elle est
 * reprise ici : SNS refuse au-delà, et un refus au moment d'envoyer coûte une
 * ligne `FAILED` par message plutôt qu'un message d'erreur à la configuration.
 */
export const SMS_SENDER_ID_MAX_LENGTH = 11;

/** Ce qu'il faut pour écrire un e-mail — l'identité d'expéditeur, et la région. */
export interface SesSettings {
  readonly fromEmail: string;
  readonly region: string | null;
}

/** Ce qu'il faut pour émettre un SMS — le nom d'expéditeur, et la région. */
export interface SnsSettings {
  readonly senderId: string;
  readonly region: string | null;
}

/** Ce qu'il faut pour publier une enveloppe — l'URL de la file, et la région. */
export interface QueueSettings {
  readonly queueUrl: string;
  readonly region: string | null;
}

/** La région résolue, ou `null` quand l'environnement la laisse au SDK. */
function resolveRegion(source: NodeJS.ProcessEnv): string | null {
  const region = source[AWS_REGION_ENV]?.trim() ?? '';

  return region === '' ? null : region;
}

/**
 * Résout l'expéditeur SES depuis un environnement.
 *
 * Fonction pure et exportée pour elle-même : c'est le cœur testable du
 * fournisseur, exercé sans monter la moindre application Nest.
 *
 * @throws {Error} si l'adresse est présente mais n'en est pas une. Le message
 * nomme la variable, **jamais** sa valeur — une adresse est une donnée
 * personnelle dès qu'elle désigne quelqu'un, et un message d'erreur est
 * journalisé (notifications §7).
 */
export function resolveSesSettings(source: NodeJS.ProcessEnv): SesSettings | null {
  const fromEmail = source[SES_FROM_EMAIL_ENV]?.trim() ?? '';

  // `''` est ce qu'ECS produit pour une variable déclarée sans valeur : c'est
  // « pas posée », pas « mal posée ».
  if (fromEmail === '') {
    return null;
  }

  // Contrôle délibérément minimal — une seule arobase, rien autour d'elle qui
  // soit vide ou espacé. Valider finement une adresse est un problème sans fond
  // et sans intérêt ici : c'est SES qui tranche, sur une identité qu'il a
  // vérifiée. Ce qu'on arrête, c'est la valeur que personne n'a renseignée —
  // un nom de variable recopié, une chaîne de gabarit non substituée.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
    throw new Error(
      `Configuration notifications invalide : ${SES_FROM_EMAIL_ENV} doit être une adresse ` +
        "e-mail — c'est l'identité d'expéditeur vérifiée côté SES, et SES refuse tout envoi " +
        'depuis une adresse qui ne lui appartient pas.',
    );
  }

  return { fromEmail, region: resolveRegion(source) };
}

/**
 * Résout l'expéditeur SNS depuis un environnement.
 *
 * @throws {Error} si le sender ID est présent mais inacceptable. Onze
 * caractères alphanumériques au plus, **dont au moins une lettre** : un
 * expéditeur purement numérique est refusé par les opérateurs, qui y voient une
 * usurpation de numéro court (notifications §5).
 */
export function resolveSnsSettings(source: NodeJS.ProcessEnv): SnsSettings | null {
  const senderId = source[SNS_SMS_SENDER_ID_ENV]?.trim() ?? '';

  if (senderId === '') {
    return null;
  }

  if (senderId.length > SMS_SENDER_ID_MAX_LENGTH || !/^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(senderId)) {
    throw new Error(
      `Configuration notifications invalide : ${SNS_SMS_SENDER_ID_ENV} doit compter au plus ` +
        `${SMS_SENDER_ID_MAX_LENGTH} caractères alphanumériques dont au moins une lettre — un ` +
        'expéditeur purement numérique est refusé par les opérateurs, qui y voient une ' +
        'usurpation de numéro court.',
    );
  }

  return { senderId, region: resolveRegion(source) };
}

/**
 * Résout la file de découplage depuis un environnement.
 *
 * @throws {Error} si l'URL est présente mais n'est pas une URL de file SQS. Le
 * message nomme la variable, jamais sa valeur : elle porte l'identifiant du
 * compte AWS.
 */
export function resolveQueueSettings(source: NodeJS.ProcessEnv): QueueSettings | null {
  const queueUrl = source[NOTIFICATION_QUEUE_URL_ENV]?.trim() ?? '';

  if (queueUrl === '') {
    return null;
  }

  if (!/^https:\/\/[^\s/]+\/\d+\/[^\s/]+$/.test(queueUrl)) {
    throw new Error(
      `Configuration notifications invalide : ${NOTIFICATION_QUEUE_URL_ENV} doit être l'URL ` +
        "d'une file SQS (https://sqs.<région>.amazonaws.com/<compte>/<file>) — c'est la sortie " +
        '`dispatch_queue_url` du module Terraform.',
    );
  }

  return { queueUrl, region: resolveRegion(source) };
}

/**
 * Mémoïse une résolution, **y compris son échec**.
 *
 * Une configuration invalide doit lever à chaque usage, et lever la *même*
 * chose : sans cela, le second envoi trouverait un cache vide, relirait
 * l'environnement, et la panne changerait de forme entre deux messages.
 */
function once<T>(resolve: () => T): () => T {
  let settled: { readonly value: T } | { readonly error: unknown } | null = null;

  return (): T => {
    settled ??= attempt(resolve);

    if ('error' in settled) {
      throw settled.error;
    }

    return settled.value;
  };
}

function attempt<T>(resolve: () => T): { readonly value: T } | { readonly error: unknown } {
  try {
    return { value: resolve() };
  } catch (error) {
    return { error };
  }
}

@Injectable()
export class NotificationsConfig {
  /** `null` quand la variable est absente — jamais quand elle est trop courte : ce cas a fait échouer l'amorçage. */
  private readonly internalToken: string | null;

  private readonly ses: () => SesSettings | null;

  private readonly sns: () => SnsSettings | null;

  private readonly queue: () => QueueSettings | null;

  public constructor(source: NodeJS.ProcessEnv = process.env) {
    this.internalToken = resolveInternalToken(source);
    // Les trois lectures sont **capturées**, pas exécutées : l'environnement
    // n'est consulté qu'au premier appel du getter correspondant. C'est ce qui
    // fait qu'une API sans SES ni SNS ne lit jamais ces variables, et qu'une
    // valeur fautive échoue à l'envoi plutôt qu'à l'amorçage.
    this.ses = once(() => resolveSesSettings(source));
    this.sns = once(() => resolveSnsSettings(source));
    this.queue = once(() => resolveQueueSettings(source));
  }

  /** `false` sur un poste sans chaîne d'envoi branchée. */
  public get isInternalCallerConfigured(): boolean {
    return this.internalToken !== null;
  }

  /**
   * Le jeton attendu, ou `null`.
   *
   * Rendu tel quel plutôt que comparé ici : la comparaison doit être à temps
   * constant, et c'est la garde qui sait le faire. Ce que ce fournisseur
   * garantit, c'est qu'une valeur rendue est présente et d'une longueur
   * défendable.
   */
  public get expectedInternalToken(): string | null {
    return this.internalToken;
  }

  /**
   * L'expéditeur e-mail, ou `null` si aucun n'est branché.
   *
   * @throws {Error} si `SES_FROM_EMAIL` est présente mais invalide — au premier
   * appel, et à tous les suivants.
   */
  public get sesSettings(): SesSettings | null {
    return this.ses();
  }

  /**
   * L'expéditeur SMS, ou `null` si aucun n'est branché.
   *
   * @throws {Error} si `SNS_SMS_SENDER_ID` est présente mais invalide.
   */
  public get snsSettings(): SnsSettings | null {
    return this.sns();
  }

  /**
   * La file de découplage, ou `null` — auquel cas les abonnés du bus expédient
   * en processus, comme avant #799.
   *
   * @throws {Error} si `NOTIFICATION_QUEUE_URL` est présente mais invalide.
   */
  public get queueSettings(): QueueSettings | null {
    return this.queue();
  }
}
