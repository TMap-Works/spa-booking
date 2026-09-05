import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STRIPE_JS_URL,
  loadStripeSdk,
  resetStripeLoaderForTests,
  type StripeSdk,
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
  Stripe?: (publishableKey: string) => StripeSdk;
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

    expect(factory).toHaveBeenCalledWith('pk_live_du_salon');
  });
});

describe('quand le script n’arrive pas', () => {
  it('refuse avec un message adressé au comptoir', async () => {
    const loading = loadStripeSdk('pk_test_51ABC');

    pendingScript().dispatchEvent(new Event('error'));

    await expect(loading).rejects.toThrow(/connexion du poste/i);
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

    await expect(loading).rejects.toThrow(/point d’entrée/i);
  });
});
