import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STRIPE_JS_URL,
  StripeLoadError,
  loadStripeSdk,
  resetStripeLoaderForTests,
  type StripeSdk,
  type StripeSdkOptions,
} from '@/lib/admin/payment-stripe';

/**
 * Le chargement de Stripe.js (#59).
 *
 * Le premier test est le plus important du fichier, et il n'a rien d'un test de
 * plomberie : il vérifie que le script vient de **`js.stripe.com`** et de nulle
 * part ailleurs. C'est la condition du périmètre PCI SAQ A — les champs carte
 * sont des iframes servies par Stripe, qu'un script empaqueté chez nous ne
 * pourrait pas produire (payments-stripe §1).
 */

interface Carrier {
  Stripe?: (publishableKey: string, options?: StripeSdkOptions) => StripeSdk;
}

const sdk = { elements: vi.fn(), confirmPayment: vi.fn() } as unknown as StripeSdk;

function carrier(): Carrier {
  return window as unknown as Carrier;
}

function pendingScript(): HTMLScriptElement {
  const script = document.querySelector<HTMLScriptElement>('script');

  if (script === null) {
    throw new Error('aucune balise de script n’a été injectée');
  }

  return script;
}

afterEach(() => {
  resetStripeLoaderForTests();
  document.head.innerHTML = '';
  delete carrier().Stripe;
});

describe('l’origine du script', () => {
  it('charge Stripe.js depuis le domaine de Stripe, et rien d’autre', async () => {
    const loading = loadStripeSdk('pk_test_51ABC');
    const script = pendingScript();

    expect(script.src).toBe(STRIPE_JS_URL);
    expect(script.async).toBe(true);

    carrier().Stripe = () => sdk;
    script.dispatchEvent(new Event('load'));

    await expect(loading).resolves.toBe(sdk);
  });

  it('n’injecte rien si le script est déjà là', async () => {
    carrier().Stripe = () => sdk;

    await expect(loadStripeSdk('pk_test_51ABC')).resolves.toBe(sdk);
    expect(document.querySelector('script')).toBeNull();
  });

  it('remet la clé publiable à la fabrique — jamais une constante de build', async () => {
    const factory = vi.fn(() => sdk);
    carrier().Stripe = factory;

    await loadStripeSdk('pk_live_du_salon');

    expect(factory).toHaveBeenCalledWith('pk_live_du_salon', {});
  });
});

describe('la langue passée à Stripe.js', () => {
  /**
   * Le troisième critère d'acceptation de #850 : *« Stripe Elements reçoit la
   * langue courante (option `locale`). Ses propres messages, carte refusée
   * comprise, s'affichent donc dans la langue de l'interface. »*
   *
   * Elle est posée sur la **fabrique**, et non sur `elements()` : c'est le
   * réglage global de Stripe.js, le seul qui localise aussi les chaînes d'erreur
   * de `confirmPayment` — d'où viennent précisément les refus de carte.
   *
   * Rien de tout cela ne touche au périmètre PCI : `locale` est une option de
   * rendu. Le premier test de ce fichier reste la garde qui compte — le script
   * vient de `js.stripe.com` et de nulle part ailleurs.
   */
  it('remet la langue courante avec la clé', async () => {
    const factory = vi.fn(() => sdk);
    carrier().Stripe = factory;

    await loadStripeSdk('pk_live_du_salon', 'en');

    expect(factory).toHaveBeenCalledWith('pk_live_du_salon', { locale: 'en' });
  });

  it('n’envoie aucune option de langue quand l’appelant n’en passe pas', async () => {
    // Omise et non posée à `undefined` : Stripe recevrait sinon un `locale`
    // explicitement vide, là où l'absence de clé lui laisse son propre défaut.
    // La doublure déclare ses paramètres pour que `toHaveBeenCalledWith` porte
    // sur la signature réelle — sans eux, `vi.fn` la tient pour une fonction
    // sans argument, et `tsc` refuse toute assertion sur le second.
    const factory = vi.fn((_key: string, _options?: StripeSdkOptions) => sdk);
    carrier().Stripe = factory;

    await loadStripeSdk('pk_live_du_salon');

    expect(factory).toHaveBeenCalledWith('pk_live_du_salon', {});
    expect(factory.mock.calls[0]?.[1]).not.toHaveProperty('locale');
  });

  it('change de langue sans retirer la balise déjà chargée', async () => {
    // Le script n'est tiré qu'une fois ; c'est la fabrique qui produit une
    // instance par appel, et c'est elle qui porte le réglage. Un opérateur qui
    // bascule de langue obtient donc un Stripe dans la nouvelle langue au
    // montage suivant, sans rechargement de l'onglet.
    const factory = vi.fn(() => sdk);
    carrier().Stripe = factory;

    await loadStripeSdk('pk_live_du_salon', 'fr');
    await loadStripeSdk('pk_live_du_salon', 'en');

    expect(factory).toHaveBeenNthCalledWith(1, 'pk_live_du_salon', { locale: 'fr' });
    expect(factory).toHaveBeenNthCalledWith(2, 'pk_live_du_salon', { locale: 'en' });
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('quand le script n’arrive pas', () => {
  it('refuse en nommant sa raison, et non une phrase', async () => {
    // La raison et non le message : ce module est chargé une fois par processus
    // et sert les deux langues — une phrase figée à son évaluation en aurait
    // trahi une sur deux. C'est `checkout-card-form.tsx` qui va chercher la
    // phrase dans `admin-checkout`, comme partout ailleurs dans le front, où
    // l'on réagit sur un code et jamais sur un message (web-frontend §2).
    const loading = loadStripeSdk('pk_test_51ABC');

    pendingScript().dispatchEvent(new Event('error'));

    await expect(loading).rejects.toBeInstanceOf(StripeLoadError);
    await expect(loading).rejects.toMatchObject({ reason: 'script' });
  });

  it('laisse réessayer après un échec réseau', async () => {
    // Sans l'oubli de la promesse mémorisée **et** le retrait de la balise
    // fautive, une coupure condamnerait le paiement par carte jusqu'au prochain
    // rechargement complet de l'onglet : un `script` déjà tiré ne rejoue ni
    // `load` ni `error`, et la seconde tentative attendrait sans fin.
    const first = loadStripeSdk('pk_test_51ABC');
    pendingScript().dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow();

    // Rien n'est nettoyé à la main : c'est le module qui doit avoir retiré la
    // balise morte, sans quoi ce qui suit se raccrocherait à elle.
    expect(document.querySelector('script')).toBeNull();

    const second = loadStripeSdk('pk_test_51ABC');
    carrier().Stripe = () => sdk;
    pendingScript().dispatchEvent(new Event('load'));

    await expect(second).resolves.toBe(sdk);
  });

  it('refuse si le script se charge sans exposer son point d’entrée', async () => {
    const loading = loadStripeSdk('pk_test_51ABC');

    pendingScript().dispatchEvent(new Event('load'));

    await expect(loading).rejects.toMatchObject({ reason: 'entrypoint' });
  });
});
