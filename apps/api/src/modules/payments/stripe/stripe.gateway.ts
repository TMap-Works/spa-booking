/**
 * Le port vers Stripe — **la seule frontière que les données de carte ne
 * franchissent pas dans notre sens**.
 *
 * Ce fichier est délibérément minuscule, et sa taille est une garantie. Il
 * n'existe ici aucun champ où un numéro de carte, un cryptogramme ou une date
 * d'expiration pourrait entrer : ni `CreatePaymentIntentCommand`, ni
 * `StripePaymentIntent` n'en portent, et le service ne saurait pas quoi en
 * faire s'il en recevait. C'est ce qui maintient le périmètre en SAQ A
 * (payments-stripe §1) — la tokenisation se fait dans une iframe servie par
 * Stripe, au navigateur, et notre serveur ne voit jamais que des références
 * opaques.
 *
 * Un port plutôt qu'un appel direct, pour deux raisons :
 *
 * 1. le service se teste sans réseau — un double en mémoire suffit, et aucun
 *    test n'atteint l'environnement live (payments-stripe §7) ;
 * 2. le jour où `stripe-node` entrera dans les dépendances, il s'installera
 *    derrière cette interface sans qu'une ligne de `payments.service.ts` ne
 *    bouge.
 */

/** Jeton d'injection du port — l'implémentation HTTP est un détail du module. */
export const STRIPE_GATEWAY = Symbol('STRIPE_GATEWAY');

/**
 * Une intention de paiement, réduite à ce que nous avons le droit de connaître.
 *
 * `clientSecret` **n'est pas une donnée de carte** : c'est le laissez-passer, à
 * usage unique et lié à cette intention, avec lequel le navigateur parle
 * directement à Stripe. Il n'est pas conservé en base — rien n'aurait à le
 * relire côté serveur — et il ne part dans aucun journal : `redaction.ts`
 * expurge tout champ dont le nom contient « secret ».
 */
export interface StripePaymentIntent {
  /** `pi_…` — la référence opaque que la ligne `payments` conserve. */
  readonly id: string;
  /** Le laissez-passer du navigateur. Rendu à l'appelant, jamais persisté. */
  readonly clientSecret: string;
  /** Statut Stripe brut (`requires_payment_method`, `succeeded`, …). */
  readonly status: string;
  /** Montant, dans la plus petite unité de la devise — jamais un flottant. */
  readonly amountMinor: number;
  /** Code ISO 4217, tel que Stripe le rend (minuscules). */
  readonly currency: string;
}

/**
 * Ce qu'il faut pour créer une intention — et **rien de ce qui touche à la
 * carte**.
 *
 * `idempotencyKey` est ce qui rend l'appel rejouable sans risque : deux clics,
 * deux requêtes concurrentes ou un renvoi après coupure réseau produisent la
 * même intention plutôt que deux, et donc un seul débit possible. Stripe
 * mémorise la clé 24 heures ; la nôtre est dérivée du rendez-vous, donc stable
 * bien au-delà du temps d'un tunnel de réservation.
 */
export interface CreatePaymentIntentCommand {
  readonly amountMinor: number;
  /** ISO 4217. La passerelle se charge de la casse attendue par Stripe. */
  readonly currency: string;
  readonly idempotencyKey: string;
  /**
   * Métadonnées rattachées à l'intention chez Stripe.
   *
   * Elles portent l'établissement et le rendez-vous — c'est ce qui permettra au
   * webhook de #58 de **résoudre le tenant** avant de chercher la ligne, comme
   * le schéma Prisma l'exige (« un index non préfixé de `tenant_id` n'est pas
   * une option ici »). Aucune donnée personnelle n'y entre : ni nom, ni
   * e-mail, ni téléphone (CDC §5.1) — seulement des identifiants opaques.
   */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StripeGateway {
  /**
   * Crée une intention de paiement.
   *
   * L'appel est **idempotent** : rejoué avec la même `idempotencyKey` et les
   * mêmes paramètres, il rend l'intention déjà créée au lieu d'en créer une
   * seconde.
   */
  createPaymentIntent(command: CreatePaymentIntentCommand): Promise<StripePaymentIntent>;

  /**
   * Relit une intention déjà créée.
   *
   * C'est ce qui sert la reprise d'un tunnel abandonné : le `client_secret`
   * n'étant pas conservé, on le redemande à sa source plutôt que de créer une
   * seconde intention pour le même rendez-vous.
   */
  retrievePaymentIntent(id: string): Promise<StripePaymentIntent>;
}
