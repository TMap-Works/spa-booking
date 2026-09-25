import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegisterForm } from '@/app/(account)/[tenantSlug]/compte/components/register-form';
import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import { loadMessages, type MessageTree } from '@/i18n/messages';
import * as consentModule from '@/lib/booking/consent';
import { emptyBookingDraft } from '@/lib/booking/draft';

/**
 * Le bloc de consentement dans la langue de l'interface — #1264.
 *
 * ## Ce que la recette de #1232 a relevé
 *
 * `/{salon}/compte/inscription` rendu **en anglais** gardait trois phrases
 * françaises : le paragraphe d'information, le résumé du dépliant et le libellé
 * de la case. Le refus de la case, lui, était bien traduit — ce ne sont donc pas
 * les messages de validation qui manquaient, mais les libellés du bloc.
 *
 * La cause tenait en un import : `lib/booking/consent.tsx` lisait
 * `@/messages/fr/booking.json` pour fabriquer `ACCOUNT_CONSENT`, une copie
 * **figée en français** que l'écran d'inscription recevait en propriété. L'étape
 * « Coordonnées » du tunnel, elle, était passée à `variant` avec #846 et lisait
 * le catalogue de la requête. Deux écritures, donc, dont une seule traduite —
 * alors que `lib/booking/consent.tsx` existe précisément pour qu'il n'y en ait
 * qu'une.
 *
 * ## Ce que cette suite tient
 *
 * 1. le bloc de l'inscription cliente s'affiche dans la langue lue, ses trois
 *    libellés compris ;
 * 2. rendu en anglais, il ne porte **aucune** phrase du catalogue français — le
 *    troisième critère d'acceptation, vérifié contre le catalogue lui-même
 *    plutôt que contre trois phrases recopiées ici, qui auraient vieilli à la
 *    première reformulation ;
 * 3. les deux surfaces — inscription et étape « Coordonnées » — lisent la même
 *    écriture : ce qui leur est commun sort identique des deux côtés, dans les
 *    deux langues ;
 * 4. aucune copie figée ne subsiste dans le module, seule façon d'empêcher la
 *    seconde écriture d'y revenir.
 *
 * ## Pourquoi sa propre doublure de `next-intl`
 *
 * L'amorce des suites fixe la langue à `fr` une fois pour toutes
 * (`tests/support/next-intl.ts`, #845), et la promesse éprouvée ici est
 * précisément que l'écran **change** de langue. La doublure ci-dessous est celle
 * de l'amorce, à une chose près : la langue est une variable que chaque test
 * pose. Le formatage reste celui de la bibliothèque, sur les catalogues du
 * dépôt — même conduite que `signup-i18n.test.tsx`.
 */

const state = vi.hoisted(() => ({ locale: 'fr' as 'fr' | 'en' }));

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages: load } = await import('@/i18n/messages');

  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;

  /** Un traducteur par langue et par namespace — voir l'amorce sur le coût. */
  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => state.locale,
    useTranslations: (namespace?: string) => {
      const key = `${state.locale}:${namespace ?? ''}`;
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const messages = load(state.locale);
      const made = translator(
        namespace === undefined
          ? { locale: state.locale, messages }
          : { locale: state.locale, messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

const registerAction = vi.fn();

// Mêmes doubles que `booking-consent.test.tsx` : l'action serveur et le routeur
// n'existent pas hors de Next, et ce qu'on éprouve ici est le texte du bloc.
vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const SLUG = 'maison-lotus';

beforeEach(() => {
  state.locale = 'fr';
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  registerAction.mockReset();
});

/** Le texte du bloc de consentement rendu, ramené à une seule forme d'espace. */
function texteDuBloc(): string {
  const bloc = document.querySelector('.spa-consent');

  if (bloc === null) {
    throw new Error('aucun bloc de consentement rendu');
  }

  return (bloc.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function rendreInscription(langue: 'fr' | 'en'): string {
  state.locale = langue;
  render(<RegisterForm tenantSlug={SLUG} />);

  return texteDuBloc();
}

function rendreEtapeCoordonnees(langue: 'fr' | 'en'): string {
  state.locale = langue;
  render(
    <ContactStep
      contact={emptyBookingDraft().contact}
      tenantSlug={SLUG}
      countryCode={null}
      summary={null}
      presence={null}
      onSave={vi.fn()}
      onBack={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );

  return texteDuBloc();
}

/** La copie de consentement d'une langue, lue là où l'application la lit. */
function catalogue(langue: 'fr' | 'en'): MessageTree {
  const booking = loadMessages(langue).booking as MessageTree;

  return (booking.tunnel as MessageTree).consent as MessageTree;
}

/** Une phrase du catalogue de consentement, désignée par son chemin pointé. */
function phrase(langue: 'fr' | 'en', chemin: string): string {
  const trouvee = chemin
    .split('.')
    .reduce<string | MessageTree>(
      (node, segment) => (node as MessageTree)[segment] as string | MessageTree,
      catalogue(langue),
    );

  if (typeof trouvee !== 'string') {
    throw new Error(`tunnel.consent.${chemin} n’est pas une phrase du catalogue ${langue}`);
  }

  return trouvee;
}

/**
 * Toutes les phrases d'un sous-arbre de catalogue, à plat.
 *
 * Les balises de `t.rich` sont retirées : `policyLink` s'écrit
 * `<policy>Lire la politique de données…</policy>` dans le catalogue, et seul le
 * texte du chunk atterrit dans le document.
 */
function toutesLesPhrases(tree: MessageTree): readonly string[] {
  return Object.values(tree).flatMap((value) =>
    typeof value === 'string'
      ? [value.replace(/<\/?[a-zA-Z]+>/gu, '').trim()]
      : toutesLesPhrases(value),
  );
}

describe('le bloc de consentement de l’inscription suit la langue lue (#1264)', () => {
  it('rend ses trois libellés en français', () => {
    const texte = rendreInscription('fr');

    expect(texte).toContain(phrase('fr', 'account.intro'));
    expect(texte).toContain(phrase('fr', 'summary'));
    expect(texte).toContain(phrase('fr', 'account.label'));
  });

  it('rend ses trois libellés en anglais', () => {
    // Le paragraphe d'information, le résumé du dépliant et le libellé de la
    // case — les trois éléments que le constat de #1264 relève un à un.
    const texte = rendreInscription('en');

    expect(texte).toContain(phrase('en', 'account.intro'));
    expect(texte).toContain(phrase('en', 'summary'));
    expect(texte).toContain(phrase('en', 'account.label'));
  });

  it('n’y laisse aucune phrase du catalogue français', () => {
    // Le troisième critère d'acceptation. Éprouvé contre le catalogue entier
    // plutôt que contre trois phrases recopiées : une quatrième clé oubliée
    // serait relevée ici sans que personne ait à y penser.
    const texte = rendreInscription('en');

    for (const francaise of toutesLesPhrases(catalogue('fr'))) {
      expect(texte).not.toContain(francaise);
    }
  });

  it('nomme la variante « compte » et non celle du tunnel', () => {
    // Les deux variantes ne diffèrent que par l'introduction et le libellé de la
    // case : un écran qui lirait le catalogue mais la mauvaise variante
    // annoncerait « for this appointment » à qui crée un compte.
    const texte = rendreInscription('en');

    expect(texte).not.toContain(phrase('en', 'booking.intro'));
    expect(texte).not.toContain(phrase('en', 'booking.label'));
    // Et les finalités propres au compte : l'adresse e-mail y est aussi
    // l'identifiant de connexion, et le mot de passe n'existe que de ce côté.
    expect(texte).toContain(phrase('en', 'purposes.emailAccount.why'));
    expect(texte).toContain(phrase('en', 'purposes.password.data'));
  });
});

describe('les deux surfaces lisent la même écriture (#1264)', () => {
  /** Ce qui est commun aux deux variantes : dépliant, finalités partagées, droits. */
  const COMMUN = [
    'summary',
    'rights',
    'purposes.identity.data',
    'purposes.identity.why',
    'purposes.email.data',
    'purposes.phone.why',
  ] as const;

  for (const langue of ['fr', 'en'] as const) {
    it(`sort le même texte commun des deux côtés du parcours, en ${langue}`, () => {
      const tunnel = rendreEtapeCoordonnees(langue);

      cleanup();

      const inscription = rendreInscription(langue);
      const attendues = COMMUN.map((chemin) => phrase(langue, chemin));

      for (const attendue of attendues) {
        // Des deux côtés, au mot près : c'est la définition d'une écriture
        // unique, et ce que le deuxième critère demande de tenir.
        expect(tunnel).toContain(attendue);
        expect(inscription).toContain(attendue);
      }
    });
  }

  it('ne garde aucune copie figée dans le module', () => {
    // La seconde écriture est revenue par là une fois : une constante de module
    // fabriquée sur le catalogue français, passée en propriété à l'écran. Rien
    // ne l'empêchait de réapparaître — sinon ceci.
    const exports = consentModule as Record<string, unknown>;

    expect(exports).not.toHaveProperty('ACCOUNT_CONSENT');
    expect(exports).not.toHaveProperty('BOOKING_CONSENT');
  });
});
