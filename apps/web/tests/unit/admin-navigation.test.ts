import type { UserRole } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  adminLandingPath,
  adminNavigation,
  isCurrentEntry,
  roleLabel,
} from '@/app/(admin)/[tenantSlug]/admin/components/navigation';
import { adminClientsPath } from '@/app/(admin)/[tenantSlug]/admin/clients/paths';
import {
  adminCalendarPath,
  adminCatalogPath,
  adminCheckoutPath,
  adminReportingPath,
  adminSessionRefreshPath,
  adminSettingsPath,
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

describe('où la connexion dépose chaque rôle (#618)', () => {
  it('dépose une praticienne sur le planning, et non sur les réglages', () => {
    // Le défaut corrigé : la redirection était inconditionnelle vers
    // `adminSettingsPath`, écran `@AuthAtLeast('ADMIN')`. Le premier écran d'une
    // praticienne après son mot de passe était « Accès réservé ».
    expect(adminLandingPath(SLUG, 'staff')).toBe(adminCalendarPath(SLUG));
    expect(adminLandingPath(SLUG, 'staff')).not.toBe(adminSettingsPath(SLUG));
  });

  it('dépose les trois rangs du back-office sur leur première section ouverte', () => {
    // Le sommaire est ordonné comme la journée d'un comptoir : ce qu'on regarde
    // en arrivant vient en tête. C'est le planning pour les trois rangs — et
    // c'est bien ce que le rail leur propose en premier.
    for (const role of ['staff', 'manager', 'admin'] as const) {
      const first = adminNavigation(SLUG, role)[0];

      expect(adminLandingPath(SLUG, role)).toBe(first?.href);
      expect(adminLandingPath(SLUG, role)).toBe(adminCalendarPath(SLUG));
    }
  });

  it('n’a aucune destination pour un compte client', () => {
    // Le sommaire ne lui propose rien : lui en choisir une malgré tout serait
    // recommencer le défaut, en le conduisant là où on va le refuser.
    expect(adminLandingPath(SLUG, 'client')).toBeNull();
  });

  it('ne dépose jamais personne sur un écran que son rang ne peut ouvrir', () => {
    // La garantie qui tient dans le temps : la destination est **une entrée du
    // sommaire de ce rôle**, quoi qu'il advienne des seuils. Aucune seconde
    // table de rangs à tenir à jour ici.
    for (const role of ['client', 'staff', 'manager', 'admin'] as const) {
      const landing = adminLandingPath(SLUG, role);

      if (landing === null) {
        continue;
      }
      expect(adminNavigation(SLUG, role).map((entry) => entry.href)).toContain(landing);
    }
  });

  it('ne dépose jamais personne sur une entrée annoncée mais non servie', () => {
    // Une entrée sans `href` est inerte : y envoyer quelqu'un donnerait un 404.
    for (const role of ['staff', 'manager', 'admin'] as const) {
      expect(adminLandingPath(SLUG, role)).not.toBeNull();
    }
  });

  it('encode le slug de sa destination', () => {
    expect(adminLandingPath('salon/lilas', 'staff')?.startsWith('/salon%2Flilas/admin')).toBe(
      true,
    );
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

  it('ne laisse plus aucun écran sans chemin', () => {
    // Le fichier client et le personnel ont été branchés par #480,
    // l'encaissement par #484, le reporting par #75. La liste est vide, et elle
    // doit le rester : une entrée qui y rejoindrait serait une régression du
    // sommaire, pas un jalon en attente.
    const pending = adminNavigation(SLUG, 'admin')
      .filter((candidate) => candidate.href === null)
      .map((candidate) => candidate.key);

    expect(pending).toEqual([]);
  });

  it('mène aux indicateurs, sans période ni filtre figés', () => {
    // Y figer une période la rendrait périmée dès le mois suivant ; y figer un
    // filtre ferait du sommaire le tableau de bord de quelqu'un d'autre.
    expect(navEntry('reporting').href).toBe(adminReportingPath(SLUG));
    expect(navEntry('reporting').href).toBe(`/${SLUG}/admin/reporting`);
    expect(navEntry('reporting').href).not.toContain('?');
    expect(navEntry('reporting').upcoming).toBeNull();
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

  it('mène à l’encaissement du jour, sans date ni rendez-vous figés', () => {
    // L'écran est servi depuis #59 : l'entrée porte son chemin, et l'URL est
    // **nue**. Une date figée périmerait le sommaire dès le lendemain ; un `rdv`
    // figé en ferait le règlement de quelqu'un d'autre — c'est la journée
    // courante du salon que l'écran ouvre alors de lui-même.
    expect(navEntry('encaissement').href).toBe(adminCheckoutPath(SLUG));
    expect(navEntry('encaissement').href).toBe(`/${SLUG}/admin/encaissement`);
    expect(navEntry('encaissement').href).not.toContain('?');
    expect(navEntry('encaissement').upcoming).toBeNull();
  });

  it('ouvre l’encaissement dès le rang praticien', () => {
    // Le rang annoncé est celui de l'`@AuthAtLeast` des routes gardées que
    // l'écran appelle — `GET /v1/appointments` et `POST /v1/payments/cash` sont
    // au seuil `STAFF`, comme `GET /v1/sales`. Encaisser est un geste de
    // comptoir : l'annoncer `manager` cacherait un écran qui fonctionne.
    expect(navEntry('encaissement', 'staff').href).toBe(adminCheckoutPath(SLUG));
    expect(navEntry('encaissement').minimumRole).toBe('staff');
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

  it('reste marquée pendant qu’on encaisse un rendez-vous', () => {
    // L'écran d'encaissement met sa journée et le rendez-vous en cours de
    // règlement dans la **chaîne de requête** — `?date=…&rdv=…` — et l'opérateur
    // y navigue toute la journée. Le repère de section doit y survivre : c'est
    // exactement le défaut que `isCurrentEntry` corrige pour le planning.
    const checkout = navEntry('encaissement').href ?? '';
    const settling = adminCheckoutPath(SLUG, { date: '2026-09-06', appointmentId: 'a1b2' });

    expect(settling.startsWith(`${checkout}?`)).toBe(true);
    expect(isCurrentEntry(`/${SLUG}/admin/encaissement`, checkout)).toBe(true);
    expect(isCurrentEntry(`/${SLUG}/admin/encaissement`, settling)).toBe(true);

    // Et le planning ne se marque pas parce qu'on encaisse : les deux écrans
    // partagent la journée, pas la section.
    expect(isCurrentEntry(`/${SLUG}/admin/encaissement`, planning)).toBe(false);
  });

  it('reste marquée sur la fiche d’un praticien', () => {
    expect(
      isCurrentEntry(adminStaffMemberPath(SLUG, 'a1b2'), navEntry('personnel').href ?? ''),
    ).toBe(true);
  });
});

describe('le chemin des indicateurs', () => {
  it('omet la période quand elle vaut le défaut', () => {
    // L'URL nue est celle qu'on tape, et c'est aussi celle que le rail ouvre.
    expect(adminReportingPath(SLUG, { period: 'trente-jours' })).toBe(`/${SLUG}/admin/reporting`);
    expect(adminReportingPath(SLUG, { period: 'mois-precedent' })).toBe(
      `/${SLUG}/admin/reporting?periode=mois-precedent`,
    );
  });

  it('n’écrit les deux bornes que sur une période personnalisée', () => {
    // Sur une période nommée, elles seraient périmées dès le lendemain : « les
    // 30 derniers jours » se recalcule chaque matin, et c'est son intérêt.
    expect(
      adminReportingPath(SLUG, { period: 'sept-jours', from: '2026-09-01', to: '2026-09-30' }),
    ).toBe(`/${SLUG}/admin/reporting?periode=sept-jours`);
    expect(
      adminReportingPath(SLUG, {
        period: 'personnalisee',
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    ).toBe(`/${SLUG}/admin/reporting?periode=personnalisee&du=2026-09-01&au=2026-09-30`);
  });

  it('porte le filtre tel quel, et l’omet sur l’établissement entier', () => {
    expect(adminReportingPath(SLUG, { scope: 'praticien:a1b2' })).toBe(
      `/${SLUG}/admin/reporting?filtre=praticien%3Aa1b2`,
    );
    expect(adminReportingPath(SLUG, { scope: null })).toBe(`/${SLUG}/admin/reporting`);
  });

  it('encode le slug plutôt que de le recopier', () => {
    // Même exigence que les autres chemins : le slug vient d'un segment d'URL.
    expect(adminReportingPath('salon/lilas')).toBe('/salon%2Flilas/admin/reporting');
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
