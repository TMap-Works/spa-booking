import { Injectable } from '@nestjs/common';

import { WebhookNotConfiguredError } from '../stripe-webhook.errors';

/**
 * Le secret de terminaison des webhooks Stripe — `STRIPE_WEBHOOK_SECRET`.
 *
 * ## Pourquoi ici et non dans `config/env.schema.ts`
 *
 * `env.schema.ts` l'annonce lui-même : « chaque module métier ajoutera ses
 * propres clés (JWT, Stripe, SES…) au moment où il les lit réellement ». Ce
 * fournisseur est cette lecture. La garder dans le module évite surtout
 * d'imposer une variable Stripe à **toutes** les suites d'intégration du dépôt
 * — `AppModule` monte les huit modules, y compris pour un test qui ne parle que
 * de créneaux.
 *
 * ## Ce que « refuser de démarrer » veut dire ici
 *
 * | | Secret mal préfixé | Secret absent |
 * |---|---|---|
 * | `staging`, `production` | **refus de démarrer** | **refus de démarrer** |
 * | `development`, `test` | **refus de démarrer** | démarre, la route répond 503 |
 *
 * Le secret absent **en déployé** est une faute de déploiement d'un genre
 * particulier : la route existe, elle répond, et rien dans l'API ne va mal —
 * seuls les paiements cessent silencieusement d'être confirmés, puisque c'est
 * le webhook et lui seul qui fait passer un rendez-vous en `CONFIRMED`
 * (payments-stripe §2). Refuser de démarrer transforme une panne silencieuse et
 * différée en un échec de déploiement immédiat (api-module §7).
 *
 * En local, l'absence décrit l'état ordinaire d'un poste qui travaille sur
 * l'agenda et n'a aucune raison de détenir le secret d'un compte Stripe. La
 * route répond alors 503, bruyamment et par requête, plutôt que d'immobiliser
 * toute l'API.
 *
 * Un secret **présent mais mal préfixé** est refusé partout, pour la même
 * raison que `StripeConfig` refuse une clé secrète dans la variable publiable :
 * c'est le symptôme de deux variables interverties, et l'inversion la plus
 * probable met ici une clé `sk_…`, c'est-à-dire un accès complet au compte du
 * salon dans une variable qu'on croit inoffensive.
 *
 * ## Le secret ne sort jamais d'ici
 *
 * Il n'entre dans aucune réponse, aucun journal, aucun message d'erreur — les
 * messages ci-dessous ne citent jamais la valeur reçue, exactement comme ceux
 * de `signingSecret` dans `env.schema.ts`, sans quoi il finirait en clair dans
 * les journaux de démarrage de la tâche ECS.
 */

/** Préfixe de tout secret de terminaison Stripe. */
const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Les environnements où l'absence du secret est une faute de déploiement. */
const DEPLOYED_ENVS: ReadonlySet<string> = new Set(['staging', 'production']);

@Injectable()
export class StripeWebhookConfig {
  /** `null` quand la variable est absente — jamais quand elle est mal formée : ce cas a fait échouer l'amorçage. */
  private readonly secret: string | null;

  public constructor(env: NodeJS.ProcessEnv) {
    const raw = env['STRIPE_WEBHOOK_SECRET'];
    // `""` est ce qu'une définition de tâche ECS produit pour une variable
    // déclarée sans valeur : cela veut dire « pas posée », pas « mal posée ».
    const value = raw === undefined || raw === '' ? null : raw;

    if (value !== null && !value.startsWith(WEBHOOK_SECRET_PREFIX)) {
      // Le message ne cite jamais la valeur reçue : c'est un secret.
      throw new Error(
        `Configuration Stripe invalide : STRIPE_WEBHOOK_SECRET doit commencer par « ${WEBHOOK_SECRET_PREFIX} » ` +
          '— une clé secrète de compte placée ici signalerait deux variables interverties.',
      );
    }

    if (value === null && DEPLOYED_ENVS.has(env['NODE_ENV'] ?? '')) {
      throw new Error(
        'Configuration Stripe invalide : STRIPE_WEBHOOK_SECRET est obligatoire en déployé — ' +
          'sans lui aucun paiement ne peut être confirmé, et rien ne le signalerait avant la première réservation.',
      );
    }

    this.secret = value;
  }

  /** `true` si la route est en mesure de vérifier une signature. */
  public get isConfigured(): boolean {
    return this.secret !== null;
  }

  /**
   * Le secret, ou un 503.
   *
   * Un accès plutôt qu'un champ public : c'est ce qui garantit qu'aucun
   * appelant ne vérifie une signature contre `null` — une comparaison qui, avec
   * un secret vide, aurait accepté tout corps accompagné du bon condensat de
   * chaîne vide.
   */
  public requireSecret(): string {
    if (this.secret === null) {
      throw new WebhookNotConfiguredError();
    }
    return this.secret;
  }
}
