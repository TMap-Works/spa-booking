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
 *
 * ## La langue, et pourquoi elle ne change rien au périmètre PCI (#850)
 *
 * `Stripe(clé, { locale })` est une **option de rendu**, au même titre qu'un
 * thème : elle dit à Stripe dans quelle langue écrire les libellés de ses
 * champs et — c'est le point du ticket — ses messages d'erreur, « carte
 * refusée » comprise. Elle ne donne aucun accès aux données de carte, et ne
 * déplace donc pas d'un pouce la frontière du §1 ci-dessus : les champs restent
 * des iframes servies par `js.stripe.com`, que notre JavaScript ne lit pas. Le
 * périmètre reste SAQ A.
 *
 * Elle est posée sur la **fabrique** et non sur `elements()` : la documentation
 * de Stripe en fait le réglage global de Stripe.js, celui qui localise les
 * chaînes d'erreur de *toutes* ses méthodes — `confirmPayment` y comprise, d'où
 * viennent précisément les refus de carte. Un `locale` posé sur le seul groupe
 * d'éléments aurait traduit les champs et laissé les refus en anglais.
 *
 * La valeur passée est la langue nue — `fr` ou `en` —, et non l'étiquette
 * régionale de `lib/format.ts` : Stripe n'accepte qu'une liste close de codes,
 * où figurent `fr` et `en` mais ni `fr-FR` ni `en-US`.
 */

import type { Locale } from '@spa/shared';

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

/** Les options de la fabrique que ce module emploie, et rien de plus. */
export interface StripeSdkOptions {
  /** La langue de Stripe.js — voir l'en-tête. `undefined` laisse son défaut. */
  readonly locale?: Locale;
}

type StripeFactory = (publishableKey: string, options?: StripeSdkOptions) => StripeSdk;

/**
 * Pourquoi le SDK n'a pas pu être chargé — **un code, pas une phrase**.
 *
 * Ce module n'a pas de langue : il est chargé une fois par processus, sert les
 * deux langues, et un message figé à son évaluation en aurait trahi une sur
 * deux. Il rend donc la **raison**, et `checkout-card-form.tsx` va chercher la
 * phrase dans `admin-checkout` — même règle que partout ailleurs dans le front,
 * où l'on réagit sur un code et jamais sur un message (web-frontend §2).
 */
export type StripeLoadReason =
  /** La balise n'a pas pu être tirée — réseau du poste, filtrage, coupure. */
  | 'script'
  /** Le script est arrivé, mais `window.Stripe` n'existe pas. */
  | 'entrypoint';

/** Un échec de chargement de Stripe.js, porteur de sa raison. */
export class StripeLoadError extends Error {
  constructor(readonly reason: StripeLoadReason) {
    super(`stripe-load:${reason}`);
    this.name = 'StripeLoadError';
  }
}

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
        reject(new StripeLoadError('entrypoint'));
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
        reject(new StripeLoadError('script'));
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
 * @param locale la langue de l'interface, passée telle quelle à Stripe.js. Voir
 * l'en-tête : c'est une option de rendu, pas un accès aux données de carte.
 *
 * La langue est remise à **chaque** appel, et non mémorisée avec la balise : le
 * script n'est tiré qu'une fois, mais la fabrique produit une instance par
 * appel, et c'est elle qui porte le réglage. Un opérateur qui change de langue
 * sans recharger l'onglet obtient donc un Stripe dans la nouvelle langue au
 * montage suivant.
 */
export async function loadStripeSdk(
  publishableKey: string,
  locale?: Locale,
): Promise<StripeSdk> {
  // `exactOptionalPropertyTypes` est actif : la clé est omise plutôt que posée à
  // `undefined`, faute de quoi Stripe recevrait un `locale` explicitement vide.
  const options: StripeSdkOptions = locale === undefined ? {} : { locale };
  const ready = carrier().Stripe;

  if (ready !== undefined) {
    return ready(publishableKey, options);
  }

  pending ??= injectStripeScript();

  try {
    const factory = await pending;
    return factory(publishableKey, options);
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
