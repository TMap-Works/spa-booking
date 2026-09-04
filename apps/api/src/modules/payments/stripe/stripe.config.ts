import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PaymentProviderUnavailableError } from '../payments.errors';

/**
 * Les deux clés Stripe, validées **au démarrage** et jamais ailleurs.
 *
 * ## Pourquoi ici et non dans `config/env.schema.ts`
 *
 * `env.schema.ts` l'annonce lui-même : « chaque module métier ajoutera ses
 * propres clés (JWT, Stripe, SES…) au moment où il les lit réellement ». Ce
 * fournisseur est cette lecture. La garder dans le module la met là où elle se
 * relit — à côté du seul code qui s'en sert — et évite d'imposer une variable
 * Stripe à chaque suite de test des sept autres modules.
 *
 * ## La frontière PCI passe entre les deux champs de ce fichier
 *
 * | Clé | Où elle vit | Qui la voit |
 * |---|---|---|
 * | `STRIPE_SECRET_KEY` | AWS Secrets Manager → variable de tâche ECS | le conteneur d'API, et rien d'autre |
 * | `STRIPE_PUBLISHABLE_KEY` | la même source, mais **publiable par nature** | le navigateur, pour monter Stripe Elements |
 *
 * La secrète ne sort d'ici que vers l'en-tête `Authorization` de la passerelle
 * HTTP. Elle n'entre dans aucune réponse, aucun journal, aucun message
 * d'erreur — les messages de validation ci-dessous ne citent jamais la valeur
 * reçue, exactement comme ceux de `signingSecret` dans `env.schema.ts`, sans
 * quoi une clé live finirait en clair dans les journaux de démarrage de la
 * tâche ECS.
 *
 * ## Les préfixes sont vérifiés, et ce n'est pas cosmétique
 *
 * Intervertir les deux clés est l'erreur de déploiement la plus banale, et la
 * plus chère : la clé **secrète** partirait alors au navigateur dans la réponse
 * de création d'intention, ce qui donne à quiconque ouvre la page un accès
 * complet au compte Stripe du salon. `sk_` et `pk_` sont ce qui rend cette
 * inversion incapable de démarrer.
 *
 * ## Ce que « refuser de démarrer » veut dire ici, exactement
 *
 * api-module §7 pose la règle : « l'application refuse de démarrer si une
 * variable manque — mieux vaut échouer au **déploiement** qu'à la première
 * requête client ». C'est ce que fait ce fournisseur, et il distingue deux
 * fautes de nature différente :
 *
 * | | Une clé mal préfixée | Configuration incomplète | Aucune clé |
 * |---|---|---|---|
 * | `staging`, `production` | **refus de démarrer** | **refus de démarrer** | **refus de démarrer** |
 * | `development`, `test` | **refus de démarrer** | démarre, paiements hors service | démarre, paiements hors service |
 *
 * La colonne de gauche est **dangereuse partout** : une clé secrète posée dans
 * la variable publiable partirait au navigateur. Elle est donc refusée quel que
 * soit l'environnement, et c'est la seule faute qui empêche un poste de
 * développement de démarrer.
 *
 * Les deux autres colonnes ne sont dangereuses qu'en déployé, où elles disent
 * « ce salon ne peut pas encaisser ». En local, elles décrivent l'état ordinaire
 * d'un poste qui travaille sur l'agenda et n'a aucune raison de détenir les clés
 * d'un compte Stripe — ou dont l'environnement porte une variable `STRIPE_*`
 * héritée d'un autre projet. Refuser de démarrer pour cela immobiliserait
 * **toute** l'API, alors que la seule capacité perdue est l'encaissement : les
 * tentatives y répondent 503, bruyamment et par requête.
 *
 * Exiger les clés en `test` aurait par ailleurs un coût sans contrepartie :
 * `AppModule` monte les huit modules, donc **toutes** les suites d'intégration
 * du dépôt — y compris celles qui ne parlent que de créneaux — auraient refusé
 * de démarrer sans une variable Stripe.
 */

/** Préfixe de toute clé secrète Stripe — `sk_test_…` en recette, `sk_live_…` en production. */
const SECRET_KEY_PREFIX = 'sk_';

/** Préfixe de toute clé publiable Stripe — la seule qui ait le droit d'atteindre un navigateur. */
const PUBLISHABLE_KEY_PREFIX = 'pk_';

/** Les environnements où l'absence de clés est une faute de déploiement. */
const DEPLOYED_ENVS: ReadonlySet<string> = new Set(['staging', 'production']);

/**
 * Version d'API Stripe épinglée sur chaque appel.
 *
 * Sans elle, le compte suit la version par défaut du tableau de bord Stripe :
 * un changement fait côté Stripe modifierait la forme des réponses sans qu'une
 * seule ligne d'ici ne bouge. L'épingler fait de la montée de version un
 * changement versionné et relu.
 */
export const STRIPE_API_VERSION = '2025-08-27.basil';

const stripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z
    .string()
    .min(1, { message: 'est obligatoire' })
    .refine((value) => value.startsWith(SECRET_KEY_PREFIX), {
      // Le message ne cite jamais la valeur reçue : c'est une clé.
      message: `doit commencer par « ${SECRET_KEY_PREFIX} » — une clé publiable ici ne signerait aucun appel`,
    }),
  STRIPE_PUBLISHABLE_KEY: z
    .string()
    .min(1, { message: 'est obligatoire' })
    .refine((value) => value.startsWith(PUBLISHABLE_KEY_PREFIX), {
      message: `doit commencer par « ${PUBLISHABLE_KEY_PREFIX} » — une clé secrète ici partirait au navigateur`,
    }),
});

/** L'environnement dont ce module a besoin, une fois validé. */
export type StripeEnv = z.infer<typeof stripeEnvSchema>;

/**
 * Refuse une valeur **présente** mais mal préfixée — dangereux dans tout
 * environnement.
 *
 * Une variable absente ou vide n'est pas jugée ici : `""` est ce qu'une
 * définition de tâche ECS produit pour une variable déclarée sans valeur, et
 * cela veut dire « pas posée », pas « mal posée ». La complétude, elle, se juge
 * plus bas et seulement en déployé.
 */
function assertPrefix(name: string, value: string | undefined, prefix: string, why: string): void {
  if (value !== undefined && value !== '' && !value.startsWith(prefix)) {
    // Le message ne cite jamais la valeur reçue : c'est une clé.
    throw new Error(`Configuration Stripe invalide : ${name} doit commencer par « ${prefix} » — ${why}`);
  }
}

/**
 * Résout les clés Stripe depuis un environnement.
 *
 * Rend `null` — et non une erreur — quand la configuration est absente ou
 * incomplète **hors environnement déployé** : c'est l'état ordinaire d'un poste
 * qui n'encaisse pas, et il ne doit pas immobiliser les sept autres modules.
 *
 * Fonction pure et exportée pour elle-même : c'est le cœur testable du
 * fournisseur, exercé sans monter la moindre application Nest.
 *
 * @throws {Error} si une clé présente porte le mauvais préfixe — quel que soit
 * l'environnement —, ou s'il en manque une en déployé. Le message nomme la
 * variable fautive et **jamais** sa valeur.
 */
export function resolveStripeKeys(source: NodeJS.ProcessEnv): StripeEnv | null {
  // D'abord les préfixes, et sur les valeurs **présentes** : c'est la seule
  // faute qui expose le compte du salon, et elle se juge indépendamment de
  // savoir si l'autre clé est là.
  assertPrefix(
    'STRIPE_SECRET_KEY',
    source['STRIPE_SECRET_KEY'],
    SECRET_KEY_PREFIX,
    'une clé publiable ici ne signerait aucun appel',
  );
  assertPrefix(
    'STRIPE_PUBLISHABLE_KEY',
    source['STRIPE_PUBLISHABLE_KEY'],
    PUBLISHABLE_KEY_PREFIX,
    'une clé secrète ici partirait au navigateur',
  );

  const parsed = stripeEnvSchema.safeParse(source);

  if (parsed.success) {
    return parsed.data;
  }

  if (!DEPLOYED_ENVS.has(source['NODE_ENV'] ?? '')) {
    return null;
  }

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')} ${issue.message}`)
    .join(' · ');

  throw new Error(`Configuration Stripe invalide : ${detail}`);
}

@Injectable()
export class StripeConfig {
  private readonly keys: StripeEnv | null;

  public constructor(source: NodeJS.ProcessEnv = process.env) {
    this.keys = resolveStripeKeys(source);
  }

  /**
   * `false` sur un poste de développement sans compte Stripe.
   *
   * Ce que ce drapeau **ne fait pas** : dégrader silencieusement. La passerelle
   * le consulte avant tout appel et répond 503 — chaque tentative
   * d'encaissement le signale, plutôt qu'un démarrage qui échoue une fois et
   * qu'on oublie.
   */
  public get isConfigured(): boolean {
    return this.keys !== null;
  }

  /**
   * La clé secrète — **usage unique** : l'en-tête `Authorization` de
   * `StripeHttpGateway`. Aucun autre appelant n'a de raison de la lire, et un
   * second serait le signe qu'une clé s'apprête à sortir du serveur.
   */
  public get secretKey(): string {
    return this.require().STRIPE_SECRET_KEY;
  }

  /**
   * La clé publiable — la seule qui ait le droit d'atteindre le navigateur
   * (payments-stripe §7).
   *
   * Elle est rendue **par l'API**, avec l'intention de paiement, plutôt que
   * gravée dans le build du front : un salon qui change de compte Stripe, ou un
   * passage de recette en production, ne demande alors aucun redéploiement du
   * front — et le navigateur n'a jamais à détenir de configuration Stripe qui
   * lui soit propre.
   */
  public get publishableKey(): string {
    return this.require().STRIPE_PUBLISHABLE_KEY;
  }

  /**
   * Les clés, ou l'erreur de domaine que la route sait traduire.
   *
   * `PaymentProviderUnavailableError` plutôt qu'une erreur nue : une API sans
   * clés est un prestataire indisponible du point de vue de l'appelant, et son
   * corps de réponse ne doit rien dire de notre configuration.
   */
  private require(): StripeEnv {
    if (this.keys === null) {
      throw new PaymentProviderUnavailableError();
    }
    return this.keys;
  }
}
