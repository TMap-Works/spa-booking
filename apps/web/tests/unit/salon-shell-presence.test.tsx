import { cleanup, render, screen } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountEntry } from '@/components/account/account-entry';
import { SalonShell, type SalonShellProps } from '@/components/salon/salon-shell';
import type { AccountName, AccountPresence } from '@/lib/account-presence';

import { tenant } from './fixtures';

/*
 * Ce qui franchit la frontière serveur / client dans l'en-tête du salon — #1088.
 *
 * ## Le défaut que cette suite tient fermé
 *
 * #1086 a élargi le cookie de présence à l'adresse e-mail et au numéro de la
 * cliente, pour que l'étape « Coordonnées » du tunnel n'ait plus à les lui
 * redemander. Trois écrans lisent ce cookie côté serveur — la vitrine publique,
 * la politique de données, l'espace client — et le descendent tous dans
 * `SalonShell`, qui le passait tel quel à `AccountEntry`.
 *
 * `AccountEntry` est un composant client. **Tout ce qu'un Server Component
 * passe en propriété à un composant client est sérialisé dans la charge utile
 * RSC, elle-même inscrite dans le HTML de la page.** L'adresse et le numéro se
 * retrouvaient donc dans la source de chaque page du salon, vitrine publique
 * comprise — à portée de n'importe quel script de la page ou extension du
 * navigateur, c'est-à-dire exactement ce que le `httpOnly` du cookie existe pour
 * empêcher (CDC §5.1, « Minimisation »).
 *
 * ## Pourquoi le DOM ne peut pas en témoigner, et ce qu'on regarde à la place
 *
 * `AccountEntry` n'a jamais **affiché** l'adresse : elle ne faisait que voyager.
 * Une assertion sur le DOM rendu passait donc déjà avant la correction, et ne
 * protège rien. Ce qui fuyait, ce sont les **propriétés** de l'îlot client — et
 * c'est elles que la suite lit, sur l'arbre que `SalonShell` retourne, sans
 * rendu ni simulacre : c'est littéralement ce que le sérialiseur de Next
 * écrirait.
 *
 * L'assertion de DOM est gardée tout de même, en second rideau : elle attrape le
 * jour où un autre nœud de l'en-tête se mettrait à rendre ces champs.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => `/${tenant.slug}`,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

/** La présence entière, telle que le cookie la porte depuis #1086. */
const alice: AccountPresence = {
  firstName: 'Alice',
  lastName: 'Marchand',
  email: 'alice@maison-lotus.test',
  phone: '+33612345678',
};

function proprietesDuGabarit(presence: AccountPresence | null): SalonShellProps {
  return {
    tenantSlug: tenant.slug,
    tenant,
    signedIn: presence !== null,
    presence,
    bookingHref: `/${tenant.slug}/reservation`,
    children: <p>contenu de l’écran</p>,
  };
}

function gabarit(presence: AccountPresence | null): ReactElement {
  return <SalonShell {...proprietesDuGabarit(presence)} />;
}

/**
 * Les propriétés que l'arbre rendu par `SalonShell` passe à `AccountEntry`.
 *
 * `SalonShell` est un Server Component synchrone : l'appeler rend l'arbre
 * d'éléments, et l'îlot client y figure comme un élément dont le `type` est la
 * fonction `AccountEntry` elle-même — l'identité, et non le nom, pour qu'un
 * renommage ne fasse pas passer la suite en silence.
 */
function proprietesDeLIlotClient(presence: AccountPresence | null): Record<string, unknown> {
  const trouve = (noeud: ReactNode): ReactElement | null => {
    if (Array.isArray(noeud)) {
      for (const enfant of noeud) {
        const dedans = trouve(enfant as ReactNode);
        if (dedans !== null) {
          return dedans;
        }
      }
      return null;
    }
    if (!isValidElement(noeud)) {
      return null;
    }
    if (noeud.type === AccountEntry) {
      return noeud;
    }
    return trouve((noeud.props as { children?: ReactNode }).children);
  };

  const ilot = trouve(SalonShell(proprietesDuGabarit(presence)));
  if (ilot === null) {
    throw new Error('`SalonShell` ne rend plus `AccountEntry` : la frontière n’est plus ici.');
  }
  return ilot.props as Record<string, unknown>;
}

afterEach(cleanup);

describe('la frontière serveur / client de l’en-tête du salon', () => {
  it('ne passe à l’îlot client que le prénom et le nom', () => {
    const proprietes = proprietesDeLIlotClient(alice);

    // L'égalité stricte, et non un `toMatchObject` : c'est elle qui refuse le
    // champ de trop, aujourd'hui l'adresse et le numéro, demain ce que le
    // cookie portera d'autre.
    expect(proprietes.presence).toEqual({ firstName: 'Alice', lastName: 'Marchand' });
  });

  it('n’écrit ni l’adresse ni le numéro dans la charge utile de la page', () => {
    // Les propriétés entières, et non la seule présence : c'est la totalité de
    // ce que le sérialiseur RSC écrira dans le HTML pour cet îlot.
    const serialisees = JSON.stringify(proprietesDeLIlotClient(alice));

    expect(serialisees).not.toContain(alice.email);
    expect(serialisees).not.toContain(alice.phone);
  });

  it('ne rend ni l’adresse ni le numéro dans le HTML de l’en-tête', () => {
    const { container } = render(gabarit(alice));

    expect(container.innerHTML).not.toContain(alice.email);
    expect(container.innerHTML).not.toContain(alice.phone);
  });

  it('salue toujours la cliente par son prénom', () => {
    render(gabarit(alice));

    // Le bouton du compte porte le prénom — c'est le critère que la réduction
    // ne doit pas emporter avec l'adresse (#1045, BM-COMPTE-01).
    expect(screen.getByRole('button', { name: /Alice/ })).toBeDefined();
  });

  it('garde « Se connecter » quand personne n’est connectée', () => {
    expect(proprietesDeLIlotClient(null).presence).toBeNull();

    render(gabarit(null));
    expect(screen.getByRole('link', { name: 'Se connecter' })).toBeDefined();
  });
});

describe('le type tient la frontière pour les écrans à venir', () => {
  it('refuse une présence entière à la compilation', () => {
    // Un `Pick` seul ne refuserait rien — le typage de TypeScript est
    // structurel, et une `AccountPresence` satisfait `{ firstName, lastName }`.
    // `AccountName` déclare donc les deux autres champs `never`, et c'est cette
    // ligne qui le prouve : si l'affectation cessait d'être une erreur, `tsc`
    // échouerait sur le `@ts-expect-error` inutilisé et la suite ne compilerait
    // plus. Elle n'a rien à vérifier à l'exécution, et c'est normal.
    // @ts-expect-error — `AccountEntry` doit refuser la présence entière (#1088)
    const refuse: AccountName = alice;

    expect(refuse.firstName).toBe('Alice');
  });
});
