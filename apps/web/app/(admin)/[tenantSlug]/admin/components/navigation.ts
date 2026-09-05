import { hasAtLeastRole, type UserRole } from '@spa/shared';

import {
  adminCalendarPath,
  adminCatalogPath,
  adminSettingsPath,
} from '../paths';

/**
 * Le sommaire du back-office — **la liste, pas son rendu** (#48, deuxième et
 * troisième critères).
 *
 * Séparé du composant qui la peint pour une raison simple : c'est une décision
 * métier — qui voit quoi, et ce qui existe déjà — et elle se teste sans monter
 * un arbre React ni simuler un routeur. Le rail, lui, n'a plus qu'à parcourir ce
 * que cette fonction rend.
 *
 * ## Deux états, et la différence compte
 *
 * Une entrée porte un chemin (`href`) ou n'en porte pas. Les six sections du
 * critère sont annoncées dès maintenant — c'est le sommaire du produit, et le
 * masquer donnerait à croire que le back-office s'arrête au planning — mais
 * **seules celles qui sont servies sont cliquables**. Une entrée sans `href` se
 * rend inerte et dit pourquoi ; elle ne pointe pas vers une route que personne
 * ne sert, ce qui donnerait un 404 au premier clic.
 *
 * Le jour où l'écran arrive, c'est une ligne à changer ici : le `href` remplace
 * le `upcoming`, et rien d'autre ne bouge.
 *
 * ## Le rôle filtre, il ne protège pas
 *
 * `minimumRole` reprend l'exigence de l'API — `@AuthAtLeast(...)` sur la route
 * que l'écran appelle — pour ne pas proposer un écran qui répondrait 403. C'est
 * du **confort**, pas une frontière : la seule garde qui compte est celle de
 * l'API, qu'aucun front ne peut contourner. Un rail qui se tromperait de rang
 * afficherait une entrée de trop ; il n'ouvrirait aucune donnée.
 */

/** Une entrée du sommaire, servie ou annoncée. */
export interface AdminNavEntry {
  /** Clé de rendu, stable — jamais l'index d'un tableau. */
  readonly key: string;
  readonly label: string;
  /** Chemin servi, ou `null` tant que l'écran n'existe pas. */
  readonly href: string | null;
  /** Rôle minimal, aligné sur l'`@AuthAtLeast` de la route appelée. */
  readonly minimumRole: UserRole;
  /** Ce qu'on dit d'une entrée sans chemin — jamais un lien mort. */
  readonly upcoming: string | null;
}

/**
 * Les libellés de rôle, écrits une fois.
 *
 * Le rail annonce qui est connecté **et à quel titre** : c'est ce qui explique
 * qu'une entrée manque, sur un poste partagé entre plusieurs personnes.
 */
const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  client: 'compte client',
  staff: 'praticien·ne',
  manager: 'gérant·e',
  admin: 'administrateur·rice',
};

/** Le rôle, tel qu'on l'écrit à l'écran. */
export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role];
}

/**
 * Le sommaire, pour un établissement et un rôle.
 *
 * L'ordre est celui de la journée d'un comptoir : ce qu'on regarde en arrivant,
 * puis ce qu'on ouvre à la demande, puis ce qu'on paramètre une fois par
 * trimestre. Les réglages ferment donc la liste, et non l'inverse.
 */
export function adminNavigation(tenantSlug: string, role: UserRole): readonly AdminNavEntry[] {
  const entries: readonly AdminNavEntry[] = [
    {
      key: 'planning',
      label: 'Planning',
      href: adminCalendarPath(tenantSlug),
      /*
       * `GET /v1/appointments` — l'agenda du comptoir se lit dès le rang staff,
       * et c'est bien l'écran que le CDC destine au front-desk.
       *
       * **Écart connu, et il n'est pas ici.** `calendrier/page.tsx` charge
       * aujourd'hui le fuseau du salon par `fetchTenantSettings`
       * (`GET /v1/tenant`, `@AuthAtLeast('ADMIN')`), si bien qu'un rang staff ou
       * manager qui ouvre le planning reçoit « Accès réservé ». Le rang annoncé
       * ci-dessous est celui du produit ; le durcir à `admin` pour coller au
       * symptôme reviendrait à graver dans la navigation un défaut de la page —
       * et à cacher au comptoir l'écran qu'il regarde toute la journée. La page
       * a de quoi s'en passer : le fuseau est aussi servi par
       * `GET /public/{slug}`, sans jeton, comme le fait le layout de ce shell.
       * Le correctif appartient à cette page, hors de l'empreinte de #48.
       */
      minimumRole: 'staff',
      upcoming: null,
    },
    {
      key: 'clients',
      label: 'Clients',
      href: null,
      // `GET /v1/customers` — @AuthAtLeast('STAFF').
      minimumRole: 'staff',
      upcoming: 'Fiches clients — écran en cours de livraison (#54).',
    },
    {
      key: 'prestations',
      label: 'Prestations',
      href: adminCatalogPath(tenantSlug),
      // `GET /v1/services` — @AuthAtLeast('STAFF').
      minimumRole: 'staff',
      upcoming: null,
    },
    {
      key: 'personnel',
      label: 'Personnel',
      href: null,
      // Créer et modifier un compte praticien — @AuthAtLeast('MANAGER').
      minimumRole: 'manager',
      upcoming: 'Personnel et horaires — écran en cours de livraison (#53).',
    },
    {
      key: 'encaissement',
      label: 'Encaissement',
      href: null,
      // `POST /v1/payments/counter` et `GET /v1/sales` — @AuthAtLeast('STAFF').
      minimumRole: 'staff',
      upcoming: 'Encaissement au comptoir — écran en cours de livraison (#59).',
    },
    {
      key: 'reporting',
      label: 'Reporting',
      href: null,
      // Chiffre d'affaires et taux de remplissage : une lecture de gestion.
      minimumRole: 'manager',
      upcoming: 'Indicateurs d’activité — écran à venir.',
    },
    {
      key: 'reglages',
      label: 'Réglages',
      href: adminSettingsPath(tenantSlug),
      // `GET /v1/tenant` — @AuthAtLeast('ADMIN'). Proposé plus bas, l'écran
      // répondrait 403 à un rang gérant.
      minimumRole: 'admin',
      upcoming: null,
    },
  ];

  return entries.filter((entry) => hasAtLeastRole(role, entry.minimumRole));
}

/**
 * `true` si le chemin courant est celui de l'entrée, ou l'un de ses écrans.
 *
 * Deux raffinements, et chacun corrige un défaut visible :
 *
 * 1. **la chaîne de requête est ignorée.** `?vue=semaine&date=…` ne change pas
 *    de section, et comparer les URL entières éteindrait le repère du planning
 *    dès la première navigation dans le calendrier ;
 * 2. **les descendants comptent.** `/{slug}/admin/catalogue/nouveau` est encore
 *    « Prestations ». La comparaison se fait sur un segment entier —
 *    `startsWith` nu ferait de `/catalogue-public` un descendant de
 *    `/catalogue`.
 */
export function isCurrentEntry(pathname: string, href: string): boolean {
  const base = href.split('?')[0] ?? href;

  return pathname === base || pathname.startsWith(`${base}/`);
}
