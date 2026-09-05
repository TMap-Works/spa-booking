/**
 * Le chargement de Stripe.js, et la frontière PCI qu'il matérialise (#59).
 *
 * ## Pourquoi le script est chargé depuis `js.stripe.com` et non empaqueté
 *
 * Ce n'est pas une commodité, c'est **la condition du périmètre SAQ A**. Les
 * champs carte que Stripe Elements affiche sont des iframes servies par Stripe,
 * depuis son domaine : la page du salon ne les lit pas, notre JavaScript ne les
 * lit pas, et aucun numéro n'atteint jamais notre code, nos journaux ni notre
 * base (payments-stripe §1). Empaqueter Stripe.js dans notre bundle — ou en
 * héberger une copie — ferait basculer le projet en SAQ D, avec l'audit annuel
 * qui va avec : Stripe l'interdit explicitement pour cette raison.
 *
 * ## Pourquoi ce module et non `@stripe/stripe-js`
 *
 * Le paquet officiel ne fait rien d'autre que ce qui suit : il injecte la balise
 * `<script src="https://js.stripe.com/v3/">` et attend `window.Stripe`. Il ne
 * peut pas faire autre chose — le script *doit* venir de chez Stripe. Ajouter
 * une dépendance à `apps/web/package.json` pour trente lignes de chargement
 * aurait sorti ce ticket de son empreinte, sur un fichier que deux autres
 * branches de la vague modifient. Le jour où le front aura d'autres usages de
 * Stripe (Terminal, Payment Links), le paquet remplacera ce module sans que ses
 * appelants changent.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il ne connaît aucun montant, aucune devise, aucun rendez-vous. Il rend un SDK,
 * et c'est l'appelant qui lui remet le `clientSecret` que l'API a produit. La
 * seule valeur sensible qu'il touche est la clé **publiable**, publiable par
 * définition (payments-stripe §7).
 */

/** L'URL officielle, et la seule admissible. Voir l'en-tête. */
export const STRIPE_JS_URL = 'https://js.stripe.com/v3/';

/**
 * L'élément de paiement monté dans la page — une iframe servie par Stripe.
 *
 * Aucune méthode de lecture : il n'y a **rien** à en extraire côté salon, et
 * l'interface le dit. Ce qui sort de cet élément part directement chez Stripe,
 * par `confirmPayment`.
 */
export interface StripePaymentElement {
  mount(target: HTMLElement): void;
  unmount(): void;
  destroy(): void;
}

/** Le groupe d'éléments lié à une intention. */
export interface StripeElements {
  create(type: 'payment'): StripePaymentElement;
}

/**
 * L'issue d'une confirmation.
 *
 * `error.message` est le seul texte que Stripe rend à afficher — il ne porte
 * aucune donnée de carte, par construction du prestataire. `paymentIntent.status`
 * est l'état **côté Stripe** : `succeeded` y signifie que l'autorisation a
 * abouti chez lui, pas que notre encaissement est inscrit. Cette distinction est
 * tout l'objet de `receiptIsProvisional` dans `checkout-summary.ts`.
 */
export interface StripeConfirmation {
  readonly error?: { readonly message?: string };
  readonly paymentIntent?: { readonly status: string };
}

/** La part du SDK que cet écran emploie, et rien de plus. */
export interface StripeSdk {
  elements(options: { readonly clientSecret: string }): StripeElements;
  confirmPayment(options: {
    readonly elements: StripeElements;
    readonly redirect: 'if_required';
  }): Promise<StripeConfirmation>;
}

type StripeFactory = (publishableKey: string) => StripeSdk;

/**
 * `window`, vu comme le porteur éventuel du SDK.
 *
 * Déclaré structurellement plutôt que par un `declare global` : une déclaration
 * globale annoncerait `window.Stripe` à *tout* le front, y compris au parcours
 * public qui ne charge pas ce script — et un accès direct y compilerait pour
 * échouer à l'exécution.
 */
interface StripeCarrier {
  Stripe?: StripeFactory;
}

/**
 * Le chargement en cours, partagé.
 *
 * Deux montages successifs de l'élément — l'opérateur revient en arrière puis
 * repart sur la carte — ne doivent injecter qu'une balise : `document` ne
 * réexécuterait pas le script, et le second attendrait un `load` qui n'arrive
 * jamais. La promesse est donc mémorisée, et **oubliée en cas d'échec** pour
 * qu'un réseau revenu permette de réessayer.
 */
let pending: Promise<StripeFactory> | null = null;

function carrier(): StripeCarrier {
  return window as unknown as StripeCarrier;
}

/** Injecte la balise, ou se raccroche à celle qu'un montage précédent a posée. */
function injectStripeScript(): Promise<StripeFactory> {
  return new Promise<StripeFactory>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${STRIPE_JS_URL}"]`,
    );
    const script = existing ?? document.createElement('script');

    function settle(): void {
      const factory = carrier().Stripe;

      if (factory === undefined) {
        // Même raison que pour l'échec réseau ci-dessous : une balise déjà tirée
        // ne rejoue aucun de ses deux événements, et la garder ferait attendre
        // indéfiniment la tentative suivante au lieu de la faire échouer.
        script.remove();
        reject(new Error('Stripe.js s’est chargé sans exposer son point d’entrée.'));
        return;
      }

      resolve(factory);
    }

    script.addEventListener('load', settle, { once: true });
    script.addEventListener(
      'error',
      () => {
        // La balise fautive est **retirée** de la page. Un élément `script` ne
        // tire son URL qu'une fois : la laisser en place ferait trouver au
        // prochain essai une balise morte, sur laquelle ni `load` ni `error` ne
        // se rejouent — la promesse de reprise n'aboutirait jamais, et le
        // comptoir resterait devant un bouton inerte sans message.
        script.remove();
        reject(
          new Error(
            'Le module de paiement de Stripe n’a pas pu être chargé. Vérifiez la connexion du poste.',
          ),
        );
      },
      { once: true },
    );

    if (existing === null) {
      script.src = STRIPE_JS_URL;
      script.async = true;
      document.head.append(script);
    }
  });
}

/**
 * Le SDK Stripe, prêt à monter un élément de paiement.
 *
 * @param publishableKey la clé publiable **rendue par l'API** — jamais une
 * constante de build, pour qu'un changement de compte Stripe ne demande aucun
 * redéploiement du front.
 */
export async function loadStripeSdk(publishableKey: string): Promise<StripeSdk> {
  const ready = carrier().Stripe;

  if (ready !== undefined) {
    return ready(publishableKey);
  }

  pending ??= injectStripeScript();

  try {
    const factory = await pending;
    return factory(publishableKey);
  } catch (error) {
    // Oubliée : sans cela, une coupure réseau condamnerait le paiement par carte
    // jusqu'au prochain rechargement complet de l'onglet.
    pending = null;
    throw error;
  }
}

/**
 * Remet le module dans son état initial — **usage de test uniquement**.
 *
 * Une suite qui monte deux fois l'élément dans le même environnement jsdom
 * réutiliserait sinon la promesse résolue de la précédente, et ne vérifierait
 * plus rien de l'injection.
 */
export function resetStripeLoaderForTests(): void {
  pending = null;
}
