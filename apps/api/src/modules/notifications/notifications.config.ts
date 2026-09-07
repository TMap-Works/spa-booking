import { Injectable } from '@nestjs/common';

/**
 * La configuration propre au module `notifications` — pour l'instant, un seul
 * secret : le jeton que présentent les fonctions Lambda de la chaîne d'envoi.
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

@Injectable()
export class NotificationsConfig {
  /** `null` quand la variable est absente — jamais quand elle est trop courte : ce cas a fait échouer l'amorçage. */
  private readonly internalToken: string | null;

  public constructor(source: NodeJS.ProcessEnv = process.env) {
    this.internalToken = resolveInternalToken(source);
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
}
