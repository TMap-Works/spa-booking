import type { Response } from 'supertest';

/**
 * Les assertions du protocole de fuite inter-tenant (#27) — tenant-isolation §6,
 * écrit une fois pour les huit modules.
 *
 * Le protocole tient en quatre pas, et chaque module doit les jouer sur chacun
 * de ses endpoints :
 *
 * 1. créer une ressource avec le tenant A ;
 * 2. s'authentifier comme tenant B ;
 * 3. tenter lecture, modification et suppression **par identifiant** ;
 * 4. attendre 404 sur les trois, et vérifier que la ressource de A est intacte.
 *
 * Une liste qui ne contient aucun identifiant de A complète l'ensemble.
 *
 * Les pas 1 et 2 relèvent du harnais (`./tenant-harness.ts`) ; les pas 3 et 4
 * sont ici. Ce qui est factorisé n'est pas l'appel HTTP — il diffère par route —
 * mais **ce qu'on en exige**, et c'est là que les suites divergeaient : les unes
 * vérifiaient le code de statut seul, d'autres y ajoutaient `code`, d'autres
 * encore l'absence de fuite dans le corps. Une seule d'entre elles relisait la
 * ressource visée.
 *
 * ## Pourquoi 404 et jamais 403
 *
 * Un 403 dit « cette ressource existe, mais pas pour vous » : c'est une sonde
 * d'existence offerte à qui énumère des identifiants (tenant-isolation §4). Le
 * refus doit être indiscernable de celui que reçoit un identifiant qui
 * n'existe nulle part — d'où `UNKNOWN_ID` dans le harnais, et d'où le fait que
 * ces assertions refusent explicitement le 403 plutôt que d'accepter « tout sauf
 * 200 ».
 *
 * ## Pourquoi les échecs nomment leur cas
 *
 * Jest ne prend pas de message sur `expect(x).toBe(y)`. Le libellé de la
 * tentative est donc **comparé avec** la valeur : un échec affiche
 * `{ tentative: 'modification', statut: 200 }` au lieu d'un `200 ≠ 404` qui ne
 * dirait pas laquelle des trois tentatives a traversé.
 */

/** Le code que le filtre d'exceptions rend pour une ressource hors de portée. */
const NOT_FOUND = 'NOT_FOUND';

/** Une tentative croisée : un libellé, et la requête telle que B l'émettrait. */
export interface CrossTenantAttempt {
  /** `lecture`, `modification`, `suppression` — repris tel quel dans l'échec. */
  readonly label: string;
  /**
   * La requête, **construite à l'appel** et non passée déjà construite : une
   * requête `supertest` part dès qu'on l'attend, et deux scénarios qui
   * partageraient la même instance rejoueraient la première réponse.
   */
  readonly send: () => PromiseLike<Response>;
}

export interface CrossTenantScenario {
  /**
   * Les tentatives à jouer — lecture, modification et suppression pour un
   * endpoint qui les offre toutes.
   */
  readonly attempts: readonly CrossTenantAttempt[];
  /**
   * Ce qu'aucune réponse ne doit contenir : l'identifiant de la ressource visée,
   * celui de son établissement, et toute donnée qui trahirait son existence.
   */
  readonly hidden: readonly string[];
  /**
   * L'état de la ressource de A, relu à la source après les tentatives — pas 4
   * du protocole. Sans lui, une modification croisée qui écrirait *puis*
   * répondrait 404 passerait pour un refus.
   *
   * Doit rendre des données simples : l'instantané est pris par
   * `structuredClone`, sans quoi une comparaison portant sur l'objet vivant se
   * ferait contre lui-même — verte quoi qu'il arrive.
   */
  readonly intact?: () => unknown;
}

/**
 * Un refus qui ne dit rien de la ressource : 404, code `NOT_FOUND`, et aucun
 * secret recopié dans le corps.
 */
export function expectNotFoundWithoutLeak(
  response: Response,
  options: { readonly hidden: readonly string[]; readonly label?: string },
): void {
  const label = options.label ?? 'tentative croisée';
  requireSecrets(options.hidden);

  // Le statut d'abord : les deux assertions suivantes n'ont pas de sens sur une
  // réponse qui a réussi, et un `expect` qui échoue interrompt la fonction.
  expect({ tentative: label, statut: response.status }).toEqual({ tentative: label, statut: 404 });

  const body: unknown = response.body;
  expect({ tentative: label, code: codeOf(body) }).toEqual({ tentative: label, code: NOT_FOUND });

  const serialized = JSON.stringify(body ?? null);
  for (const secret of options.hidden) {
    expect({ tentative: label, fuite: serialized.includes(secret) ? secret : null }).toEqual({
      tentative: label,
      fuite: null,
    });
  }
}

/**
 * Le protocole complet : chaque tentative répond 404 sans rien divulguer, et la
 * ressource de A est intacte au bout.
 */
export async function expectCrossTenantNotFound(scenario: CrossTenantScenario): Promise<void> {
  if (scenario.attempts.length === 0) {
    // Un scénario vide est vert sans rien avoir exercé : c'est le pire résultat
    // possible pour un test de fuite, parce qu'il se lit comme une garantie.
    throw new Error(
      'expectCrossTenantNotFound : aucune tentative. Le protocole exige au moins ' +
        "une requête croisée — lecture, modification ou suppression par identifiant.",
    );
  }
  requireSecrets(scenario.hidden);

  const before = scenario.intact === undefined ? undefined : snapshot(scenario.intact());

  for (const attempt of scenario.attempts) {
    const response = await attempt.send();
    expectNotFoundWithoutLeak(response, { hidden: scenario.hidden, label: attempt.label });
  }

  if (scenario.intact !== undefined) {
    // Pas 4 : le refus ne suffit pas, encore faut-il que rien n'ait été écrit
    // chez le voisin avant que le 404 ne parte.
    expect(snapshot(scenario.intact())).toEqual(before);
  }
}

/**
 * Une liste ne laisse voir aucun identifiant d'un autre établissement.
 *
 * La recherche porte sur le corps **sérialisé**, et non sur les seuls champs
 * `id` : un identifiant étranger fuit aussi bien par une clé étrangère, un lien
 * `next`, un message d'erreur ou un compteur agrégé.
 */
export function expectExcludesForeignIds(body: unknown, foreignIds: readonly string[]): void {
  requireSecrets(foreignIds);
  const serialized = JSON.stringify(body ?? null);
  for (const foreign of foreignIds) {
    expect({ identifiantEtranger: serialized.includes(foreign) ? foreign : null }).toEqual({
      identifiantEtranger: null,
    });
  }
}

/**
 * La forme forte de l'assertion précédente, pour une liste rendue en tableau
 * d'objets identifiés : elle contient **exactement** les ressources du tenant
 * courant, et rien d'ailleurs.
 *
 * L'égalité d'ensemble compte autant que l'absence : une liste vide satisferait
 * « aucun identifiant du voisin » sans rien prouver du filtrage.
 *
 * `foreignIds` peut être vide, et c'est la seule différence de contrat avec
 * `expectExcludesForeignIds` : ici l'égalité d'ensemble a déjà tout exercé, un
 * voisin sans ressource de ce type est un cas légitime, et refuser la liste vide
 * ferait échouer l'assertion en annonçant « rien n'est vérifié » alors que le
 * filtrage vient de l'être.
 */
export function expectListScopedTo(
  body: unknown,
  scope: { readonly ownIds: readonly string[]; readonly foreignIds: readonly string[] },
): void {
  expect(Array.isArray(body)).toBe(true);
  const items = body as readonly unknown[];

  const ids = items.map((item) => idOf(item));
  expect([...ids].sort()).toEqual([...scope.ownIds].sort());

  if (scope.foreignIds.length > 0) {
    expectExcludesForeignIds(body, scope.foreignIds);
  }
}

/** Le champ `code` d'un corps d'erreur, ou `undefined` si le corps n'en a pas. */
function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'code' in body
    ? (body as { code: unknown }).code
    : undefined;
}

/** Le champ `id` d'un élément de liste, ou l'élément lui-même s'il n'en a pas. */
function idOf(item: unknown): unknown {
  return typeof item === 'object' && item !== null && 'id' in item
    ? (item as { id: unknown }).id
    : item;
}

/**
 * Instantané comparable de l'état de la ressource.
 *
 * `structuredClone` et non l'objet vivant : les doubles en mémoire rendent des
 * références sur leurs propres enregistrements, et comparer une référence à
 * elle-même est vert quoi qu'il soit arrivé entre-temps.
 */
function snapshot(value: unknown): unknown {
  return structuredClone(value);
}

/**
 * Refuse une liste de secrets vide ou contenant une chaîne vide.
 *
 * `''` est contenu dans n'importe quelle chaîne : passé par mégarde — un
 * identifiant pas encore semé, une variable non initialisée — il ferait échouer
 * l'assertion pour une raison que le message ne dirait pas. Une liste vide, elle,
 * n'exerce rien : le scénario croirait vérifier l'absence de fuite.
 */
function requireSecrets(secrets: readonly string[]): void {
  if (secrets.length === 0) {
    throw new Error(
      "aucun identifiant à surveiller : préciser au moins l'identifiant de la " +
        'ressource du tenant voisin, sans quoi rien n’est vérifié.',
    );
  }
  if (secrets.some((secret) => secret === '')) {
    throw new Error(
      'un identifiant à surveiller est vide — probablement une ressource pas ' +
        'encore semée au moment de construire le scénario.',
    );
  }
}
