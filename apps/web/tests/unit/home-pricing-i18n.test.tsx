import { SUBSCRIPTION_PLAN, type Locale } from '@spa/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile, nextIntlServerMobile } from '../support/langue-mobile';

import HomePage from '@/app/page';
import { planPriceLabel } from '@/lib/plan';
import en from '@/messages/en/booking.json';
import fr from '@/messages/fr/booking.json';

/**
 * #1308 — le tarif de l'accueil, dans les deux langues.
 *
 * ## Ce que cette suite éprouve, et ce qu'elle refuse d'éprouver
 *
 * L'accueil anglais montre deux devises : « $75.00 » dans la vignette du héros
 * (une prestation d'illustration, #1300) et « €29 » dans le bloc tarifaire. La
 * seconde est le prix **facturé** de l'abonnement — `SUBSCRIPTION_PLAN`, que
 * `billing.service.ts` passe à Stripe Checkout —, et c'est pourquoi il ne suit
 * pas la langue lue : une facture ne change pas de montant selon la langue dans
 * laquelle on la lit. La raison est écrite à côté du montant,
 * `packages/shared/src/schemas/billing.ts`.
 *
 * Ce qui est donc vérifié ici est **l'invariance de la devise** et la **variance
 * de l'écriture** : le même montant, la même devise, dans les deux langues, mais
 * mis en forme selon la langue. Sans la réciproque — l'écriture qui change —, un
 * tarif figé en dur passerait la suite ; sans l'invariance, une conversion
 * silencieuse la passerait aussi.
 *
 * Les séparateurs et la place du symbole ne sont pas redits : ils relèvent
 * d'`Intl`, et les recopier ferait de cette suite une copie de la table ICU du
 * moteur qui l'exécute. Le tarif affiché est comparé à `planPriceLabel()`, la
 * source unique du prix de l'offre — c'est ce qui empêche l'écran d'en annoncer
 * une variante qui lui serait propre.
 *
 * ## Deux doublures, une seule langue
 *
 * L'amorce des suites fixe la langue à `fr` (`tests/support/next-intl.ts`) ; il
 * faut ici rendre le **même** écran en anglais. L'accueil est un Server Component
 * et lit ses messages par `getTranslations`, mais les briques qu'il monte sont des
 * Client Components et passent par les crochets : les deux doublures viennent de
 * la langue mobile partagée (`tests/support/langue-mobile.ts`, #1277), sur la même
 * variable — un seul `fixerLangue()` les déplace.
 */

const readSalonIdentity = vi.fn();

vi.mock('@/lib/salon-identity', () => ({
  readSalonIdentity: (...args: unknown[]) => readSalonIdentity(...args),
}));

vi.mock('@/app/actions', () => ({ openSalonAction: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: vi.fn() }),
}));

vi.mock('next-intl', () => nextIntlMobile());

vi.mock('next-intl/server', () => nextIntlServerMobile());

const CATALOGUE = { fr, en } as const;

/** Aucun établissement sur la racine du domaine — c'est ce que l'écran passe aussi. */
const AFFICHAGE = (locale: Locale) => ({ locale, countryCode: null }) as const;

/**
 * Les espaces d'un montant mis en forme sont fines et insécables en français ;
 * les comparer à l'espace ordinaire d'un fichier source ferait échouer la
 * comparaison sur une différence que personne ne voit.
 */
function normalise(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim();
}

/** Le montant peint par le bloc tarifaire, section `#tarifs`. */
function montantAffiche(container: HTMLElement): string {
  return normalise(container.querySelector('.spa-home-pricing__amount')?.textContent);
}

/** La réponse de la question tarifaire de la FAQ, dans la langue rendue. */
function reponseTarifaire(container: HTMLElement, langue: Locale): string {
  const question = normalise(CATALOGUE[langue].home.faq.price.question);
  const item = [...container.querySelectorAll('.spa-home-faq__item')].find(
    (bloc) => normalise(bloc.querySelector('summary')?.textContent) === question,
  );

  return normalise(item?.querySelector('.spa-home-faq__answer')?.textContent);
}

async function rendreLAccueil(): Promise<HTMLElement> {
  return render(await HomePage()).container;
}

afterEach(() => {
  cleanup();
  readSalonIdentity.mockReset();
  fixerLangue('fr');
});

describe('le bloc tarifaire de l’accueil', () => {
  it('annonce le prix de l’offre mis en forme pour le français', async () => {
    // La comparaison porte sur `planPriceLabel()` et non sur une chaîne recopiée :
    // `lib/plan.ts` est la source unique du tarif — l'inscription et l'écran
    // d'abonnement la lisent aussi. Un écran qui recomposerait `{ amountMinor,
    // currency }` pour son compte pourrait dériver sans que rien ne le dise.
    const montant = montantAffiche(await rendreLAccueil());

    expect(montant).toBe(normalise(planPriceLabel(AFFICHAGE('fr'))));
    expect(montant).toContain('29');
    expect(montant).toContain('€');
  });

  it('l’annonce mis en forme pour l’anglais quand la requête est en anglais', async () => {
    fixerLangue('en');

    const montant = montantAffiche(await rendreLAccueil());

    expect(montant).toBe(normalise(planPriceLabel(AFFICHAGE('en'))));
    expect(montant).toContain('29');
    expect(montant).toContain('€');
  });

  it('écrit ce même montant différemment selon la langue', () => {
    // La réciproque des deux tests ci-dessus : sans elle, un tarif recopié en dur
    // dans l'écran les passerait tous les deux.
    expect(normalise(planPriceLabel(AFFICHAGE('en')))).not.toBe(
      normalise(planPriceLabel(AFFICHAGE('fr'))),
    );
  });

  it('garde la devise facturée dans les deux langues — ce n’est pas un prix d’illustration (#1308)', async () => {
    for (const langue of ['fr', 'en'] as const) {
      fixerLangue(langue);

      const montant = montantAffiche(await rendreLAccueil());

      // La vignette du héros passe au dollar en anglais parce que son prix ne
      // correspond à aucune facture ; celui-ci est prélevé par Stripe en euros.
      expect(montant, langue).not.toContain('$');
      expect(montant, langue).toContain('29');

      cleanup();
    }
  });

  it('reprend le même prix dans la question tarifaire de la FAQ', async () => {
    for (const langue of ['fr', 'en'] as const) {
      fixerLangue(langue);

      const container = await rendreLAccueil();

      expect(reponseTarifaire(container, langue), langue).toContain(
        normalise(planPriceLabel(AFFICHAGE(langue))),
      );

      cleanup();
    }
  });
});

describe('l’offre que l’accueil affiche', () => {
  it('reste un entier de plus petite unité avec une devise explicite', () => {
    // `CLAUDE.md`, « Argent » : jamais de flottant, jamais de devise implicite.
    expect(Number.isInteger(SUBSCRIPTION_PLAN.amountMinor)).toBe(true);
    expect(SUBSCRIPTION_PLAN.amountMinor).toBe(2900);
    expect(SUBSCRIPTION_PLAN.currency).toMatch(/^[A-Z]{3}$/u);
  });
});
