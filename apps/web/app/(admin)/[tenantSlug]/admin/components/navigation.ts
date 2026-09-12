import { hasAtLeastRole, type UserRole } from '@spa/shared';

import { adminClientsPath } from '../clients/paths';
import {
  adminCalendarPath,
  adminCatalogPath,
  adminCheckoutPath,
  adminReportingPath,
  adminSettingsPath,
} from '../paths';
import { adminStaffPath } from '../personnel/paths';

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
       * L'écart que cette entrée signalait est corrigé (#458) :
       * `calendrier/page.tsx` lisait le fuseau du salon par
       * `fetchTenantSettings` (`GET /v1/tenant`, `@AuthAtLeast('ADMIN')`), si
       * bien qu'un rang staff ou manager recevait « Accès réservé » sur l'écran
       * que le rail lui annonçait. Elle le lit désormais de la vitrine publique
       * (`GET /public/{slug}`, sans jeton), comme le layout de ce shell et comme
       * l'encaissement. Le rang annoncé ici est donc exact.
       */
      minimumRole: 'staff',
      upcoming: null,
    },
    {
      key: 'clients',
      label: 'Clients',
      /*
       * Le fichier client est servi depuis #54 : l'entrée porte donc son chemin,
       * et l'écran cesse de n'être atteignable qu'en tapant son URL (#480).
       *
       * `adminClientsPath(tenantSlug)` sans vue : le rail ouvre le fichier
       * entier, sans terme, sans page et sans fiche. Y figer une recherche
       * ferait du sommaire un favori de quelqu'un d'autre.
       */
      href: adminClientsPath(tenantSlug),
      // `GET /v1/customers` — @AuthAtLeast('STAFF'). Le fuseau vient de la
      // vitrine publique, comme sur le planning : rien sur cet écran ne demande
      // `GET /v1/tenant`, qui l'aurait refermé au rang staff.
      minimumRole: 'staff',
      upcoming: null,
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
      // Le personnel et les fiches praticien sont servis depuis #53 (#480).
      href: adminStaffPath(tenantSlug),
      /*
       * `staff`, et non le `manager` que cette entrée annonçait avant d'avoir un
       * écran à désigner.
       *
       * Le rang annoncé est celui de l'`@AuthAtLeast` des routes que l'écran
       * **appelle**, et toutes les lectures de cette section sont au seuil
       * `STAFF` : `GET /v1/users` et `GET /v1/staff` pour la liste,
       * `GET /v1/staff-schedule`, `GET /v1/staff-time-off` et
       * `GET /v1/services/{id}/staff` pour la fiche d'un praticien. Les
       * écritures — inviter, changer un rôle, enregistrer des horaires, poser un
       * congé — sont au seuil `MANAGER` ou `ADMIN`, et les deux écrans les
       * masquent déjà à qui ne les a pas (`canManage`, `canAdminister`) : un
       * praticien ouvre la section en lecture, sans jamais rencontrer un 403.
       *
       * Annoncer `manager` cachait donc un écran qui fonctionne — la variante
       * exacte du défaut que ce ticket corrige, et celle que #458 avait déjà
       * corrigée sur le planning.
       */
      minimumRole: 'staff',
      upcoming: null,
    },
    {
      key: 'encaissement',
      label: 'Encaissement',
      /*
       * L'encaissement au comptoir est servi depuis #59 (PR #460, `e7008b5`) :
       * l'entrée porte donc son chemin, et l'écran cesse de n'être atteignable
       * qu'en tapant son URL ou depuis le planning (#484). Troisième et dernière
       * entrée du défaut que #480 a corrigé sur « Clients » et « Personnel ».
       *
       * `adminCheckoutPath(tenantSlug)` **nu** : ni `date`, ni `rdv`. L'écran
       * ouvre alors la journée courante du salon, sans rendez-vous sélectionné —
       * ce que fait déjà l'URL qu'on tape. Y figer une date rendrait le sommaire
       * périmé dès le lendemain ; y figer un rendez-vous en ferait le règlement
       * de quelqu'un d'autre.
       */
      href: adminCheckoutPath(tenantSlug),
      /*
       * `staff`, inchangé — c'est bien le rang de l'`@AuthAtLeast` des routes
       * **gardées** que l'écran appelle : `GET /v1/appointments` pour la journée
       * et `POST /v1/payments/cash` pour le règlement en espèces, toutes deux au
       * seuil `STAFF`, comme `GET /v1/sales` que l'historique du comptoir
       * ouvrira. Le fuseau vient de la vitrine publique (`GET /public/{slug}`)
       * et l'intention carte de `POST /public/{slug}/payments/intents` : ni
       * l'une ni l'autre ne demande de jeton, et rien ici n'appelle
       * `GET /v1/tenant`, qui aurait refermé l'écran au rang staff. Encaisser
       * est le geste de comptoir par excellence — le réserver à la gestion
       * cacherait l'écran à ceux qui s'en servent.
       */
      minimumRole: 'staff',
      upcoming: null,
    },
    {
      key: 'reporting',
      label: 'Reporting',
      /*
       * L'écran d'indicateurs est servi depuis #75 : l'entrée porte donc son
       * chemin, et cesse d'être inerte. Quatrième entrée à passer de l'annonce
       * au lien, après « Clients » et « Personnel » (#480) et « Encaissement »
       * (#484) — et la dernière du sommaire.
       *
       * `adminReportingPath(tenantSlug)` **nu** : ni période, ni filtre. L'écran
       * ouvre alors les trente derniers jours pour l'établissement entier, ce
       * que fait déjà l'URL qu'on tape. Y figer une période la rendrait périmée
       * dès le mois suivant ; y figer un filtre ferait du sommaire le tableau de
       * bord de quelqu'un d'autre.
       */
      href: adminReportingPath(tenantSlug),
      /*
       * `manager`, inchangé — et cette fois vérifié contre les routes que
       * l'écran appelle. Les trois rapports sont au seuil `MANAGER`
       * (`GET /v1/reports/revenue`, `/appointments`, `/no-shows`), et le fuseau
       * vient de la vitrine publique `GET /public/{slug}`, sans jeton, comme sur
       * le planning et l'encaissement. Rien ici n'appelle `GET /v1/tenant`, qui
       * aurait refermé l'écran au rang gérant — le défaut que #458 a corrigé
       * ailleurs.
       */
      minimumRole: 'manager',
      upcoming: null,
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
 * Le premier écran du back-office qu'un rôle a le droit d'ouvrir — ou `null`
 * s'il n'y en a aucun (#618).
 *
 * ## Pourquoi ici, et pas dans le formulaire de connexion
 *
 * « Qui peut ouvrir quoi » est déjà écrit une fois, juste au-dessus : c'est
 * `minimumRole`, aligné entrée par entrée sur l'`@AuthAtLeast` de la route que
 * l'écran appelle. Déduire la destination d'après-connexion de ce même sommaire
 * plutôt que d'une seconde table de rangs évite la seule chose qui rende ces
 * tables nuisibles : qu'elles divergent. Le jour où un écran change de seuil —
 * et c'est arrivé trois fois, #458, #480, #484 — le rail **et** l'atterrissage
 * suivent du même geste.
 *
 * ## Le premier servi, pas le premier annoncé
 *
 * Une entrée sans `href` est annoncée mais inerte : y envoyer quelqu'un donnerait
 * un 404. On prend donc la première entrée **servie**, dans l'ordre du sommaire —
 * celui de la journée d'un comptoir, qui met en tête ce qu'on regarde en
 * arrivant. C'est le planning pour les trois rangs du back-office.
 *
 * ## `null` n'est pas un repli, c'est une réponse
 *
 * Un compte `client` obtient une session ici — il n'y a qu'une identité par
 * établissement — et ce sommaire ne lui propose rien. Lui choisir malgré tout une
 * destination reviendrait à le conduire là où on va le refuser, c'est-à-dire
 * exactement le défaut que ce ticket corrige. L'appelant doit traiter ce cas, et
 * le type l'y oblige.
 */
export function adminLandingPath(tenantSlug: string, role: UserRole): string | null {
  return adminNavigation(tenantSlug, role).find((entry) => entry.href !== null)?.href ?? null;
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
