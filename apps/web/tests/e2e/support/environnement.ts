/**
 * L'environnement de la suite E2E — un seul endroit qui décide des ports, des
 * URL et de l'établissement d'essai.
 *
 * ## Pourquoi des ports dédiés, et non 3000 / 3001
 *
 * Un développeur qui lance la suite a presque toujours un `next dev` et un
 * `nest start` déjà ouverts sur les ports du `.env.example`. Réutiliser ces
 * ports donnerait au mieux un « port déjà pris », au pire une suite verte contre
 * un serveur qui n'est pas celui qu'elle a construit — le pire des deux, parce
 * qu'il ne se voit pas. La suite prend donc 3100 et 3101, et `webServer` de
 * Playwright refuse de démarrer si un intrus les tient.
 *
 * ## `APP_URL` doit valoir l'origine réelle du front
 *
 * `bootstrap.ts` n'autorise qu'une seule origine CORS, et c'est `APP_URL`. Ces
 * constantes sont donc reprises telles quelles dans les processus lancés par
 * `playwright.config.ts` : les faire diverger casserait le parcours d'une
 * manière qui accuserait l'IHM.
 */

import path from 'node:path';

/**
 * La racine du workspace web — `apps/web`.
 *
 * `__dirname` et non `config.rootDir` : Playwright résout `rootDir` sur le
 * **répertoire des tests** (`tests/e2e`), pas sur le workspace, et les chemins
 * bâtis dessus visaient `tests/e2e/tests/e2e/…`. `__dirname` est fourni par la
 * transpilation CommonJS que Playwright applique à sa configuration comme à ses
 * suites — `apps/web/package.json` ne déclare pas `"type": "module"`.
 */
export const RACINE_WEB = path.join(__dirname, '..', '..', '..');

function lire(nom: string, defaut: string): string {
  const valeur = process.env[nom];
  return valeur === undefined || valeur.trim() === '' ? defaut : valeur.trim();
}

/** Le port du front Next servi à la suite. */
export const PORT_WEB = Number(lire('E2E_WEB_PORT', '3100'));
/** Le port de l'API NestJS servie à la suite. */
export const PORT_API = Number(lire('E2E_API_PORT', '3101'));

/** L'origine du front — `baseURL` de Playwright et `APP_URL` des deux processus. */
export const URL_WEB = lire('E2E_WEB_URL', `http://127.0.0.1:${PORT_WEB}`);
/** L'origine de l'API — `API_URL` des deux processus, et cible des appels de service. */
export const URL_API = lire('E2E_API_URL', `http://127.0.0.1:${PORT_API}`);

/** Le préfixe que `bootstrap.ts` impose à toute route métier. */
export const BASE_API = `${URL_API}/api/v1`;

/**
 * L'établissement d'essai. Distinct de `recette-*` : la recette MCP et cette
 * suite peuvent tourner en même temps sur la même base sans se voir.
 */
export const SLUG = lire('E2E_TENANT_SLUG', 'e2e-parcours');
export const FUSEAU = 'Europe/Paris';

/** Ce que `fixtures/seed.mjs` pose. Recopié ici pour rester lisible côté suite. */
export const MOT_DE_PASSE = 'Recette-2026!';

export const COMPTES = {
  admin: 'admin@e2e.test',
  manager: 'manager@e2e.test',
  /** Le comptoir. `STAFF` est le rang le plus bas qu'acceptent les routes d'agenda. */
  staff: 'staff@e2e.test',
  client: 'client@e2e.test',
} as const;

/** La cliente que le tunnel public renseigne, et que le comptoir retrouve. */
export const CLIENTE = {
  prenom: 'Chloé',
  nom: 'Trénois',
  email: 'chloe.trenois@e2e.test',
  telephone: '+33612345678',
} as const;

/** Les chemins du front, construits une fois. */
export const chemins = {
  salon: () => `/${SLUG}`,
  reservation: () => `/${SLUG}/reservation`,
  connexionAdmin: () => `/${SLUG}/admin/connexion`,
  calendrier: (date?: string) =>
    date === undefined ? `/${SLUG}/admin/calendrier` : `/${SLUG}/admin/calendrier?date=${date}`,
  encaissement: (date: string, rendezVous?: string) =>
    rendezVous === undefined
      ? `/${SLUG}/admin/encaissement?date=${date}`
      : `/${SLUG}/admin/encaissement?date=${date}&rdv=${rendezVous}`,
} as const;

/**
 * La date d'un instant, dans le fuseau de l'établissement.
 *
 * Les écrans du comptoir sont paramétrés par une date **locale au salon**
 * (`?date=YYYY-MM-DD`), tandis que l'API rend des instants UTC. Convertir avec
 * `toISOString()` décalerait d'un jour toute la soirée d'hiver — exactement le
 * bug de fuseau que le CLAUDE.md classe en sévérité haute. `en-CA` est utilisé
 * pour sa seule propriété utile ici : il formate en `YYYY-MM-DD`.
 */
export function dateDuSalon(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSEAU,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * La date du salon dans `n` jours.
 *
 * Chaque scénario du comptoir travaille sur **son** jour, à l'écart des autres :
 * un report qui déplace un rendez-vous ne doit pas retirer à un no-show le
 * créneau qu'il visait, et une suite ne doit pas devenir dépendante de son ordre
 * d'exécution. C'est ce qui rend `fullyParallel` envisageable plus tard sans
 * réécrire les scénarios.
 */
export function dansNJours(n: number): string {
  return dateDuSalon(new Date(Date.now() + n * 24 * 60 * 60 * 1000));
}

/** L'heure `HH:MM` d'un instant, dans le fuseau de l'établissement. */
export function heureDuSalon(instant: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: FUSEAU,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}
