import { describe, expect, it } from 'vitest';

import {
  CleLiveInterditeError,
  assertAucunAppelStripe,
  assertAucuneCleLiveEnVol,
  estAppelStripe,
  inspecterStripe,
  modeCle,
  motifDeSaut,
  refuserCleLive,
} from '@/tests/e2e/support/stripe-garde';

/**
 * La garde qui interdit à la suite E2E d'appeler Stripe en live — quatrième
 * critère de #80, et règle §7 de la skill `payments-stripe`.
 *
 * Ces cas sont la seule façon honnête d'éprouver la garde : la vérifier « en
 * vrai » demanderait de poser une clé live quelque part, c'est-à-dire de créer
 * exactement le danger qu'elle existe pour écarter.
 */

describe('modeCle', () => {
  it('reconnaît les clés de test, quel que soit leur préfixe de famille', () => {
    expect(modeCle('sk_test_51ABCdef')).toBe('test');
    expect(modeCle('pk_test_51ABCdef')).toBe('test');
    // Clé restreinte : même règle de mode.
    expect(modeCle('rk_test_51ABCdef')).toBe('test');
  });

  it('reconnaît les clés live', () => {
    expect(modeCle('sk_live_51ABCdef')).toBe('live');
    expect(modeCle('pk_live_51ABCdef')).toBe('live');
    expect(modeCle('rk_live_51ABCdef')).toBe('live');
  });

  it('traite une valeur vide ou absente comme absente', () => {
    expect(modeCle(undefined)).toBe('absente');
    expect(modeCle('')).toBe('absente');
    expect(modeCle('   ')).toBe('absente');
  });

  it("ne range jamais en « test » ce qu'il ne sait pas classer", () => {
    // Le défaut prudent est « invalide » : une valeur non classée n'est pas une
    // valeur qu'on peut déclarer inoffensive.
    expect(modeCle('sk_xxx')).toBe('invalide');
    expect(modeCle('pk_test')).toBe('invalide');
    expect(modeCle('bonjour')).toBe('invalide');
  });
});

describe('inspecterStripe', () => {
  it('déclare la scène carte jouable sur deux clés de test', () => {
    const diagnostic = inspecterStripe({
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_1',
    });

    expect(diagnostic.carteJouable).toBe(true);
    expect(diagnostic.live).toEqual([]);
    expect(motifDeSaut(diagnostic)).toBeNull();
  });

  it('repère une clé live même dans une variable dont la scène ne se sert pas', () => {
    // Le cas insidieux : rien ne la lirait, donc rien ne la révélerait.
    const diagnostic = inspecterStripe({
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_1',
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_danger',
    });

    expect(diagnostic.live).toEqual(['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']);
  });

  it('ne juge pas jouable une scène à laquelle il manque une clé', () => {
    const diagnostic = inspecterStripe({ STRIPE_SECRET_KEY: 'sk_test_1' });

    expect(diagnostic.carteJouable).toBe(false);
    expect(motifDeSaut(diagnostic)).toContain('STRIPE_PUBLISHABLE_KEY');
  });

  it('nomme les variables mal préfixées dans le motif de saut', () => {
    const diagnostic = inspecterStripe({
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_PUBLISHABLE_KEY: 'pas-une-cle',
    });

    expect(motifDeSaut(diagnostic)).toContain('STRIPE_PUBLISHABLE_KEY');
    expect(motifDeSaut(diagnostic)).toContain('préfixe');
  });
});

describe('refuserCleLive', () => {
  it("laisse passer un environnement sans la moindre clé", () => {
    expect(() => refuserCleLive(inspecterStripe({}))).not.toThrow();
  });

  it('laisse passer un environnement entièrement en mode test', () => {
    expect(() =>
      refuserCleLive(
        inspecterStripe({ STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_PUBLISHABLE_KEY: 'pk_test_1' }),
      ),
    ).not.toThrow();
  });

  it('lève, et nomme la variable fautive, sur une clé live', () => {
    const diagnostic = inspecterStripe({ STRIPE_SECRET_KEY: 'sk_live_danger' });

    expect(() => refuserCleLive(diagnostic)).toThrow(CleLiveInterditeError);
    expect(() => refuserCleLive(diagnostic)).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("ne lève pas sur une valeur invalide : l'API refuserait d'amorcer dessus", () => {
    expect(() => refuserCleLive(inspecterStripe({ STRIPE_SECRET_KEY: 'n’importe quoi' }))).not.toThrow();
  });
});

describe('estAppelStripe', () => {
  it('reconnaît les domaines du prestataire, sous-domaines compris', () => {
    expect(estAppelStripe('https://js.stripe.com/v3/')).toBe(true);
    expect(estAppelStripe('https://api.stripe.com/v1/payment_intents')).toBe(true);
    expect(estAppelStripe('https://stripe.com/')).toBe(true);
    // `stripe.network` porte les signaux de fraude que Stripe.js pose : c'est
    // un appel au prestataire au même titre que les autres.
    expect(estAppelStripe('https://m.stripe.network/inner.html')).toBe(true);
  });

  it('ne se laisse pas prendre à un domaine qui contient le mot', () => {
    expect(estAppelStripe('https://stripe.com.exemple.test/')).toBe(false);
    expect(estAppelStripe('https://notstripe.com/')).toBe(false);
  });

  it("rend false sur ce qui n'est pas une URL", () => {
    expect(estAppelStripe('about:blank')).toBe(false);
    expect(estAppelStripe('')).toBe(false);
  });
});

describe('assertAucunAppelStripe', () => {
  it('laisse passer un trafic qui ne sort pas du site', () => {
    expect(() =>
      assertAucunAppelStripe(
        ['http://127.0.0.1:3100/e2e-parcours', 'http://127.0.0.1:3100/_next/static/x.js'],
        'Règlement en espèces',
      ),
    ).not.toThrow();
  });

  it('lève dès qu’un appel part chez le prestataire', () => {
    expect(() =>
      assertAucunAppelStripe(['https://js.stripe.com/v3/'], 'Règlement en espèces'),
    ).toThrow(/Règlement en espèces.*Stripe/s);
  });
});

/**
 * L'URL d'essai est **assemblée**, jamais écrite d'un bloc.
 *
 * Une URL de requête écrite d'un bloc, où le nom de paramètre `k-e-y` précède
 * immédiatement un jeton `pk_live_…`, déclenche la règle `generic-api-key` de
 * gitleaks : c'est cette proximité-là qui la fait tirer, et le job « Fuite de
 * secrets » de la CI rougit — sur l'historique, qu'un correctif ultérieur ne
 * rattrape pas. Le détecteur a raison de ne pas savoir distinguer un contre-exemple
 * d'un vrai secret : c'est à l'appât de cesser de ressembler à une clé, pas à la
 * barrière qui protège les vrais secrets de se voir poser une exception.
 *
 * Le jumeau `pk_test_…` passait, lui — « test » est un mot d'arrêt de gitleaks.
 * S'en remettre à cette asymétrie aurait été un équilibre involontaire.
 */
function urlStripePortant(jeton: string): string {
  return `https://js.stripe.com/v3/?${'key'}=${jeton}`;
}

describe('assertAucuneCleLiveEnVol', () => {
  it('laisse passer une clé de test qui voyage', () => {
    expect(() => assertAucuneCleLiveEnVol([urlStripePortant('pk_test_51ABC')])).not.toThrow();
  });

  it('lève si une clé live part sur le réseau', () => {
    expect(() => assertAucuneCleLiveEnVol([urlStripePortant('pk_live_51ABC')])).toThrow(/live/);
  });
});
