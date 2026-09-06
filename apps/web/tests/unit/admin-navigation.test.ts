import type { UserRole } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  adminNavigation,
  isCurrentEntry,
  roleLabel,
} from '@/app/(admin)/[tenantSlug]/admin/components/navigation';
import { adminClientsPath } from '@/app/(admin)/[tenantSlug]/admin/clients/paths';
import {
  adminCatalogPath,
  adminSessionRefreshPath,
  safeAdminNext,
} from '@/app/(admin)/[tenantSlug]/admin/paths';
import {
  adminStaffMemberPath,
  adminStaffPath,
} from '@/app/(admin)/[tenantSlug]/admin/personnel/paths';

/*
 * Le sommaire du back-office et l'arithmétique de chemins qui l'entoure (#48).
 *
 * Ce qui est vérifié ici est ce qu'aucun rendu ne montre : qu'un rang ne se voie
 * pas proposer un écran que l'API lui refusera, qu'une entrée non livrée ne
 * porte jamais de chemin, et qu'un `next` d'URL ne puisse pas emmener ailleurs
 * que dans ce back-office.
 */

const SLUG = 'maison-lotus';

const labels = (role: UserRole): readonly string[] =>
  adminNavigation(SLUG, role).map((entry) => entry.label);

/** L'entrée d'une clé, ou l'échec du test — jamais un `undefined` silencieux. */
const navEntry = (key: string, role: UserRole = 'admin') => {
  const found = adminNavigation(SLUG, role).find((candidate) => candidate.key === key);

  if (found === undefined) {
    throw new Error(`Aucune entrée « ${key} » au rang ${role}.`);
  }
  return found;
};

describe('sommaire du back-office — ce que chaque rôle voit', () => {
  it('ouvre au rang praticien tout ce que les routes au seuil STAFF servent', () => {
    // Le personnel en fait partie depuis #480 : ses lectures sont au seuil
    // `STAFF`, et l'écran masque de lui-même les écritures de gestion.
    expect(labels('staff')).toEqual([
      'Planning',
      'Clients',
      'Prestations',
      'Personnel',
      'Encaissement',
    ]);
  });

  it('ajoute au rang gérant le reporting, sans les réglages', () => {
    // `GET /v1/tenant` est `@AuthAtLeast('ADMIN')` : proposer les réglages ici
    // mènerait à un 403, sur un écran qu'on ne peut pas déverrouiller.
    expect(labels('manager')).toEqual([
      'Planning',
      'Clients',
      'Prestations',
      'Personnel',
      'Encaissement',
      'Reporting',
    ]);
  });

  it('donne au rang administrateur les sept sections, réglages compris', () => {
    expect(labels('admin')).toHaveLength(7);
    expect(labels('admin').at(-1)).toBe('Réglages');
  });

  it('ne propose rien à un compte client', () => {
    // Il obtient une session — il n'y a qu'une identité par établissement — et
    // n'a aucun écran de back-office à ouvrir.
    expect(adminNavigation(SLUG, 'client')).toEqual([]);
  });

  it('inclut les six sections du critère, quel qu’en soit l’état de livraison', () => {
    const keys = adminNavigation(SLUG, 'admin').map((entry) => entry.key);

    for (const section of [
      'planning',
      'clients',
      'prestations',
      'personnel',
      'encaissement',
      'reporting',
    ]) {
      expect(keys).toContain(section);
    }
  });
});

describe('sommaire du back-office — aucun lien mort', () => {
  it('ne pointe que vers des écrans servis, et explique les autres', () => {
    for (const entry of adminNavigation(SLUG, 'admin')) {
      if (entry.href === null) {
        // Sans raison affichée, une entrée inerte passe pour un bug.
        expect(entry.upcoming, `« ${entry.label} » n’explique pas son absence`).toBeTruthy();
      } else {
        expect(entry.upcoming, `« ${entry.label} » est servie et annoncée à venir`).toBeNull();
        expect(entry.href.startsWith(`/${SLUG}/admin`)).toBe(true);
      }
    }
  });

  it('laisse sans chemin les écrans que la vague n’a pas encore livrés', () => {
    const pending = adminNavigation(SLUG, 'admin')
      .filter((candidate) => candidate.href === null)
      .map((candidate) => candidate.key);

    expect(pending).toEqual(['encaissement', 'reporting']);
  });

  it('mène au fichier client, entier et sans recherche figée', () => {
    // Le rail ouvre le fichier nu : y figer un terme, une page ou une fiche
    // ferait du sommaire le favori de quelqu'un d'autre.
    expect(navEntry('clients').href).toBe(adminClientsPath(SLUG));
    expect(navEntry('clients').href).toBe(`/${SLUG}/admin/clients`);
    expect(navEntry('clients').upcoming).toBeNull();
  });

  it('mène au personnel dès le rang praticien', () => {
    // Toutes les lectures de la section sont au seuil `STAFF` ; les écritures
    // de gestion sont masquées par les écrans eux-mêmes.
    expect(navEntry('personnel', 'staff').href).toBe(adminStaffPath(SLUG));
    expect(navEntry('personnel', 'staff').href).toBe(`/${SLUG}/admin/personnel`);
    expect(navEntry('personnel', 'staff').upcoming).toBeNull();
    expect(navEntry('personnel').minimumRole).toBe('staff');
  });

  it('encode le slug dans chaque chemin servi', () => {
    // Le slug vient d'un segment d'URL : le recopier tel quel dans un `href`
    // ferait sortir du back-office un slug portant une barre oblique.
    for (const entry of adminNavigation('salon/lilas', 'admin')) {
      expect(entry.href === null || entry.href.startsWith('/salon%2Flilas/admin')).toBe(true);
    }
  });
});

describe('l’entrée courante', () => {
  const planning = `/${SLUG}/admin/calendrier`;

  it('reste marquée quand la page change de vue ou de date', () => {
    // Le planning porte `?vue=semaine&date=…` : comparer les URL entières
    // éteindrait le repère à la première navigation dans le calendrier.
    expect(isCurrentEntry(planning, `${planning}?vue=semaine&date=2026-09-05`)).toBe(true);
  });

  it('reste marquée sur un écran descendant', () => {
    expect(isCurrentEntry(`/${SLUG}/admin/catalogue/nouveau`, `/${SLUG}/admin/catalogue`)).toBe(
      true,
    );
  });

  it('ne déborde pas sur une section voisine au préfixe commun', () => {
    // `startsWith` nu ferait de `/catalogue-public` un descendant de `/catalogue`.
    expect(isCurrentEntry(`/${SLUG}/admin/catalogue-public`, `/${SLUG}/admin/catalogue`)).toBe(
      false,
    );
  });

  it('ne marque pas une autre section', () => {
    expect(isCurrentEntry(`/${SLUG}/admin/reglages`, planning)).toBe(false);
  });

  it('reste marquée sur une recherche et une fiche du fichier client', () => {
    // Le fichier client met sa vue dans la **chaîne de requête** —
    // `?recherche=…&fiche=…&page=…` — et jamais dans un segment de chemin.
    // C'est ce qui fait tenir le repère : `usePathname` rend le chemin nu, celui
    // que le rail compare.
    const clients = navEntry('clients').href ?? '';
    const searched = adminClientsPath(SLUG, { term: 'rako', customerId: 'abc', page: 2 });

    expect(searched.startsWith(`${clients}?`)).toBe(true);
    expect(isCurrentEntry(`/${SLUG}/admin/clients`, clients)).toBe(true);

    // Et symétriquement, une entrée dont le `href` porterait déjà une vue —
    // `?actives=1` du catalogue — reste comparée sur son seul chemin.
    expect(isCurrentEntry(`/${SLUG}/admin/clients`, searched)).toBe(true);
  });

  it('reste marquée sur la fiche d’un praticien', () => {
    expect(
      isCurrentEntry(adminStaffMemberPath(SLUG, 'a1b2'), navEntry('personnel').href ?? ''),
    ).toBe(true);
  });
});

describe('libellés de rôle', () => {
  it('écrit chacun des quatre rangs', () => {
    for (const role of ['client', 'staff', 'manager', 'admin'] as const) {
      expect(roleLabel(role)).toMatch(/\S/);
    }
    expect(roleLabel('manager')).toBe('gérant·e');
  });
});

describe('retour après renouvellement de session', () => {
  it('rend la page demandée quand elle est dans ce back-office', () => {
    const target = `/${SLUG}/admin/catalogue?filtre=actives`;

    expect(safeAdminNext(target, SLUG)).toBe(target);
  });

  for (const hostile of [
    'https://exemple.test/vol',
    '//exemple.test/vol',
    '/autre-salon/admin/calendrier',
    '/maison-lotus/compte',
    null,
  ]) {
    it(`refuse « ${String(hostile)} » et retombe sur le planning`, () => {
      // Un `next` non vérifié est une redirection ouverte : la route de
      // renouvellement deviendrait un tremplin vers un site tiers, sous notre
      // domaine. Le salon voisin est refusé pour la même raison — un chemin
      // d'établissement n'est pas une preuve d'appartenance.
      expect(safeAdminNext(hostile, SLUG)).toBe(`/${SLUG}/admin/calendrier`);
    });
  }

  it('refuse de se renvoyer sur les routes de session', () => {
    // Chaque tour réussirait : rien n'arrêterait la boucle.
    expect(safeAdminNext(`/${SLUG}/admin/session/refresh`, SLUG)).toBe(
      `/${SLUG}/admin/calendrier`,
    );
  });

  it('refuse la racine du back-office, qui ne sert aucune page', () => {
    expect(safeAdminNext(`/${SLUG}/admin`, SLUG)).toBe(`/${SLUG}/admin/calendrier`);
    // La même racine, avec une chaîne de requête : c'est toujours le segment
    // sans page, et un renouvellement réussi y finirait sur un 404.
    expect(safeAdminNext(`/${SLUG}/admin?onglet=1`, SLUG)).toBe(`/${SLUG}/admin/calendrier`);
  });

  it('encode la destination dans le chemin de renouvellement', () => {
    expect(adminSessionRefreshPath(SLUG, `/${SLUG}/admin/catalogue?filtre=actives`)).toBe(
      `/${SLUG}/admin/session/refresh?next=%2F${SLUG}%2Fadmin%2Fcatalogue%3Ffiltre%3Dactives`,
    );
  });

  it('rend au catalogue filtré le chemin que la garde mémorise', () => {
    // Le filtre du catalogue est dans l'URL : un renouvellement de session doit
    // rendre la main sur la liste qu'on regardait, pas sur le catalogue entier
    // (#458, troisième critère).
    expect(adminCatalogPath(SLUG)).toBe(`/${SLUG}/admin/catalogue`);
    expect(adminCatalogPath(SLUG, {})).toBe(`/${SLUG}/admin/catalogue`);
    expect(adminCatalogPath(SLUG, { activeOnly: false })).toBe(`/${SLUG}/admin/catalogue`);
    expect(adminCatalogPath(SLUG, { activeOnly: true })).toBe(
      `/${SLUG}/admin/catalogue?actives=1`,
    );

    // Et il traverse le renouvellement intact.
    expect(
      safeAdminNext(adminCatalogPath(SLUG, { activeOnly: true }), SLUG),
    ).toBe(`/${SLUG}/admin/catalogue?actives=1`);
  });
});
