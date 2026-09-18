import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminRail } from '@/app/(admin)/[tenantSlug]/admin/components/admin-rail';

/*
 * Le rail du back-office (#48).
 *
 * Ce que la suite protège : qu'aucune entrée inerte ne se présente comme un
 * lien, que le repère de section survive aux paramètres d'URL, que le contexte
 * du salon soit lu tel qu'il est écrit, que la déconnexion ne parte qu'une fois
 * même sur un double clic, et qu'une entrée atteinte au clavier demande son
 * cadrage entier (#701).
 */

const adminLogoutAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
let pathname = '/maison-lotus/admin/calendrier';

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

const LOTUS = { slug: 'maison-lotus', name: 'Maison Lotus' };

afterEach(() => {
  cleanup();
  pathname = '/maison-lotus/admin/calendrier';
  adminLogoutAction.mockReset();
  replace.mockReset();
  refresh.mockReset();
});

function renderRail(
  overrides: Partial<Parameters<typeof AdminRail>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <AdminRail
      establishments={[LOTUS]}
      role="manager"
      tenantSlug="maison-lotus"
      timeZone="Indian/Antananarivo"
      userName="Hasina R."
      {...overrides}
    />,
  );
}

describe('rail — la navigation', () => {
  it('mène aux écrans servis et n’en invente aucun', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/calendrier',
    );
    expect(screen.getByRole('link', { name: 'Prestations' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/catalogue',
    );
    // Branchés depuis #480 : les deux écrans existaient et n'étaient
    // atteignables qu'en tapant leur URL.
    expect(screen.getByRole('link', { name: 'Clients' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/clients',
    );
    expect(screen.getByRole('link', { name: 'Personnel' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/personnel',
    );
    // Troisième et dernière entrée du même défaut (#484) : l'écran est servi
    // depuis #59, et le rail l'ouvre sur la journée courante — l'URL est nue,
    // sans `?date=` ni `?rdv=`.
    expect(screen.getByRole('link', { name: 'Encaissement' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/encaissement',
    );
    // Quatrième et dernière entrée à passer de l'annonce au lien (#75) : l'URL
    // est nue elle aussi — ni période, ni filtre —, et le rail ouvre donc les
    // trente derniers jours pour l'établissement entier.
    expect(screen.getByRole('link', { name: 'Reporting' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/reporting',
    );
  });

  it('marque l’encaissement pendant qu’une cliente règle', () => {
    // L'écran porte sa journée et son rendez-vous dans la chaîne de requête, que
    // `usePathname` ne rend pas : le repère tient donc sur le seul chemin.
    pathname = '/maison-lotus/admin/encaissement';
    renderRail();

    expect(screen.getByRole('link', { name: 'Encaissement' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('aria-current')).toBeNull();
  });

  it('marque le reporting pendant qu’une période est filtrée', () => {
    // Comme l'encaissement : la période et le filtre voyagent dans la chaîne de
    // requête, que `usePathname` ne rend pas. Le repère tient sur le chemin seul.
    pathname = '/maison-lotus/admin/reporting';
    renderRail();

    expect(screen.getByRole('link', { name: 'Reporting' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('aria-current')).toBeNull();
  });

  it('ne laisse plus aucune section annoncée sans écran', () => {
    // Le sommaire annonçait six sections dont une inerte — « Indicateurs
    // d'activité — écran à venir ». #75 a livré la dernière : toute entrée que le
    // rang voit est désormais un lien, et une entrée inerte qui réapparaîtrait
    // serait une régression, pas un jalon.
    renderRail();

    for (const label of ['Planning', 'Clients', 'Prestations', 'Personnel', 'Encaissement', 'Reporting']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }

    expect(document.querySelector('[aria-disabled="true"]')).toBeNull();
  });

  it('marque la section courante, paramètres d’URL compris', () => {
    pathname = '/maison-lotus/admin/calendrier';
    renderRail();

    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      screen.getByRole('link', { name: 'Prestations' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('suit la section jusque dans ses écrans descendants', () => {
    pathname = '/maison-lotus/admin/catalogue/nouveau';
    renderRail();

    expect(screen.getByRole('link', { name: 'Prestations' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('cache les réglages à une gérante et les montre à une administratrice', () => {
    renderRail();
    expect(screen.queryByText('Réglages')).toBeNull();

    cleanup();
    renderRail({ role: 'admin' });
    expect(screen.getByRole('link', { name: 'Réglages' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/reglages',
    );
  });
});

describe('rail — le bandeau du téléphone', () => {
  /*
   * Le sommaire devient un bandeau qui défile sous 48rem, et Blink n'y déplace le
   * défilement que pour une entrée *entièrement* hors champ : une entrée que le
   * bord coupe est tenue pour visible, et le clavier laissait son libellé dehors
   * — 22 px de « Réglages » sur 82 au septième `Tab` à 360 px.
   *
   * Ce que cette suite peut prouver et ce qu'elle ne peut pas : jsdom ne met rien
   * en page, il n'y a donc ici ni largeur, ni défilement, ni bord. Ce qui se
   * vérifie est la **demande** — que l'entrée focalisée réclame son cadrage
   * entier, et le réclame sur les deux axes. Que le cadrage ait bien lieu à
   * 360 px est de la recette, pas de l'unitaire.
   *
   * La garde `:focus-visible` du rail échappe elle aussi à l'unitaire : jsdom
   * fait correspondre ce sélecteur à tout élément focalisé, souris comprise, si
   * bien qu'un test du geste au doigt passerait ici sans rien prouver. Qu'un
   * doigt ne déplace pas le bandeau se constate au navigateur, et s'est constaté.
   */
  const scrollIntoView = vi.fn();
  /*
   * jsdom ne fournit pas `scrollIntoView` du tout. On l'installe pour l'observer,
   * et on le retire ensuite : le laisser en place ferait passer, ailleurs dans la
   * suite, un composant qui compte sur une API que jsdom n'a pas.
   */
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    /*
     * `delete`, et non une réaffectation : jsdom ne définit pas `scrollIntoView`
     * du tout, si bien que réaffecter `original` — qui vaut `undefined` —
     * laisserait sur le prototype une propriété propre que la plateforme n'avait
     * pas, et `'scrollIntoView' in element` répondrait `true` pour le reste de la
     * suite. On ne remet la valeur que si la plateforme en avait une.
     */
    if (original === undefined) {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    } else {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('amène l’entrée atteinte au clavier entièrement en vue', async () => {
    renderRail({ role: 'admin' });

    // La reproduction du ticket : autant de tabulations que d'entrées (huit
    // depuis le tableau de bord) mènent à la dernière entrée du sommaire.
    for (let index = 0; index < 8; index += 1) {
      await userEvent.tab();
    }

    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Réglages' }));
    /*
     * `'nearest'` sur les deux axes : il ne déplace que ce qu'il faut pour rendre
     * l'entrée entière. `'center'` recentrerait le bandeau à chaque tabulation,
     * et `'start'` le ferait sauter d'une entrée à l'autre.
     */
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('le demande pour chaque entrée, et pas seulement pour la dernière', async () => {
    // « Personnel » à 360 px, « Encaissement » à 400 px, « Réglages » à 600 px :
    // le défaut frappait toute entrée que le bord coupe, d'où un cadrage demandé
    // à chaque prise de focus et non sur la seule fin du bandeau.
    renderRail({ role: 'admin' });

    // Les sections sont rangées par usage : le groupe « Au quotidien » ouvre
    // sur le tableau de bord, puis le planning.
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Tableau de bord' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Planning' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('ne le demande pas pour la déconnexion, qui n’est pas dans le bandeau', async () => {
    // Le pied de rail s'enroule, il ne défile pas : lui faire réclamer un cadrage
    // déplacerait la page sans rien révéler.
    renderRail({ role: 'admin' });

    screen.getByRole('button', { name: 'Se déconnecter' }).focus();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('rail — le contexte du salon', () => {
  it('nomme l’établissement et écrit son fuseau en clair', () => {
    // Toutes les heures du back-office sont écrites dans le fuseau du salon :
    // un opérateur qui consulte depuis ailleurs doit pouvoir le constater sans
    // le chercher.
    renderRail();

    expect(screen.getAllByText('Maison Lotus').length).toBeGreaterThan(0);
    expect(screen.getByText(/Indian\/Antananarivo/)).toBeDefined();
    // Le compte se lit en deux lignes : le nom, puis le rôle.
    expect(screen.getByText('Hasina R.')).toBeDefined();
    expect(screen.getByText('gérant·e')).toBeDefined();
  });

  /*
   * Le layout ne renonce plus au rail quand l'API tombe : il lui passe ce qu'il a
   * (#755). Le contrat du composant est donc de savoir rendre sans fuseau et sans
   * compte — et de ne rien inventer à leur place, un fuseau de repli faisant lire
   * la journée dans celui de personne.
   */
  it('s’en tient à ce qu’il sait quand le fuseau et le compte manquent', () => {
    renderRail({ establishments: [], timeZone: null, userName: null });

    expect(screen.queryByText(/Fuseau du salon/)).toBeNull();
    expect(screen.queryByText(/Connecté·e/)).toBeNull();
    expect(screen.getByText(/Compte non vérifié/)).toBeDefined();
    // Le salon se nomme alors par le slug de l'URL, et la navigation reste
    // entière : c'est elle que la panne emportait.
    expect(screen.getAllByText('maison-lotus').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Planning' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeDefined();
  });

  it('n’offre aucun choix quand le compte ne gère qu’un salon', () => {
    renderRail();

    expect(screen.queryByRole('navigation', { name: /Changer d’établissement/ })).toBeNull();
  });

  it('offre les autres établissements dès qu’il y en a', () => {
    renderRail({
      establishments: [LOTUS, { slug: 'villa-ravinala', name: 'Villa Ravinala' }],
    });

    const switcher = screen.getByRole('navigation', { name: /Changer d’établissement/ });

    // Le salon courant n'est pas répété dans la liste : on n'y va pas, on y est.
    expect(within(switcher).queryByRole('link', { name: 'Maison Lotus' })).toBeNull();
    expect(within(switcher).getByRole('link', { name: 'Villa Ravinala' }).getAttribute('href')).toBe(
      '/villa-ravinala/admin/calendrier',
    );
  });
});

describe('rail — la déconnexion', () => {
  it('ferme la session et quitte l’écran sans le laisser dans l’historique', async () => {
    renderRail();

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }));

    expect(adminLogoutAction).toHaveBeenCalledWith('maison-lotus');
    // `replace` et non `push` : sur un poste de comptoir partagé, un
    // « précédent » réafficherait le planning depuis le cache du routeur.
    expect(replace).toHaveBeenCalledWith('/maison-lotus/admin/connexion');
    expect(refresh).toHaveBeenCalled();
  });

  it('ne part qu’une fois sur un double clic', async () => {
    let release = (): void => {};
    adminLogoutAction.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            resolve();
          };
        }),
    );

    renderRail();
    const button = screen.getByRole('button', { name: 'Se déconnecter' });

    await userEvent.dblClick(button);

    expect(adminLogoutAction).toHaveBeenCalledTimes(1);
    release();
  });
});
