import {
  IdentityThrottlerStorage,
  SWEEP_INTERVAL_MS,
  type ThrottlerStorageRecord,
} from '../identity-throttler.storage';

/**
 * Le stockage des compteurs du limiteur (#1128).
 *
 * Ce que la suite tient, et pourquoi chaque point compte :
 *
 * - le quota lui-même — un compteur par clé, borné, qui rend la main quand son
 *   blocage expire. C'est le contrat que `ThrottlerGuard` consomme, et le
 *   remplacement du stockage ne l'a pas changé ;
 * - **l'expulsion des entrées expirées**, quatrième critère : sous des cibles
 *   toutes différentes, le nombre d'entrées suit une fenêtre de trafic et non le
 *   cumul depuis le démarrage ;
 * - **l'indépendance des compteurs**, cinquième critère : une entrée bloquée ne
 *   fige plus la décroissance des autres. C'est ce que
 *   `ThrottlerStorageService.resetBlockdRequest` faisait, en annulant les
 *   minuteries de *toutes* les clés du limiteur pour en remettre une à zéro ;
 * - l'absence de minuterie, qui est ce qui rend le point précédent
 *   inexprimable — et accessoirement ce qui dispense d'éteindre le stockage à la
 *   fin de chaque test.
 */

/** Une date fixe : le temps de cette suite est celui qu'elle pose. */
const T0 = Date.parse('2026-09-22T09:00:00.000Z');

/** Les paramètres d'une route d'identité : une minute, blocage d'une minute. */
const TTL = 60_000;
const BLOCK = 60_000;

/** Le quota des sondes — deux appels, pour que l'épuisement tienne en trois lignes. */
const LIMIT = 2;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

/** Un appel sur une clé, avec les paramètres d'une route d'identité. */
function hit(
  storage: IdentityThrottlerStorage,
  key: string,
  options: { limit?: number; name?: string } = {},
): Promise<ThrottlerStorageRecord> {
  return storage.increment(key, TTL, options.limit ?? LIMIT, BLOCK, options.name ?? 'default');
}

/** Avance l'horloge — sans dérouler la moindre minuterie, il n'y en a aucune. */
function advance(milliseconds: number): void {
  jest.setSystemTime(Date.now() + milliseconds);
}

describe('IdentityThrottlerStorage', () => {
  describe('le quota', () => {
    it('compte les appels d’une clé et bloque au-delà du plafond', async () => {
      const storage = new IdentityThrottlerStorage();

      await expect(hit(storage, 'cible')).resolves.toMatchObject({
        totalHits: 1,
        isBlocked: false,
      });
      await expect(hit(storage, 'cible')).resolves.toMatchObject({
        totalHits: 2,
        isBlocked: false,
      });
      await expect(hit(storage, 'cible')).resolves.toMatchObject({
        totalHits: 3,
        isBlocked: true,
        timeToBlockExpire: BLOCK / 1000,
      });
    });

    it('donne son propre quota à chaque clé', async () => {
      const storage = new IdentityThrottlerStorage();

      await hit(storage, 'premiere');
      await hit(storage, 'premiere');
      await expect(hit(storage, 'premiere')).resolves.toMatchObject({ isBlocked: true });

      await expect(hit(storage, 'seconde')).resolves.toMatchObject({
        totalHits: 1,
        isBlocked: false,
      });
    });

    it('ne compte pas les appels refusés — insister ne repousse pas le blocage', async () => {
      const storage = new IdentityThrottlerStorage();

      await hit(storage, 'cible');
      await hit(storage, 'cible');
      await expect(hit(storage, 'cible')).resolves.toMatchObject({
        totalHits: 3,
        timeToBlockExpire: 60,
      });

      advance(30_000);

      // Le blocage court toujours, et il finit trente secondes plus tôt qu'au
      // premier refus : qui insiste n'allonge pas sa propre peine.
      await expect(hit(storage, 'cible')).resolves.toMatchObject({
        totalHits: 3,
        isBlocked: true,
        timeToBlockExpire: 30,
      });
    });

    it('rend la main sur une fenêtre neuve une fois le blocage échu', async () => {
      const storage = new IdentityThrottlerStorage();

      await hit(storage, 'cible');
      await hit(storage, 'cible');
      await hit(storage, 'cible');

      advance(BLOCK + 1);

      await expect(hit(storage, 'cible')).resolves.toMatchObject({
        totalHits: 1,
        isBlocked: false,
      });
    });

    it('rouvre une fenêtre quand la précédente s’est écoulée sans blocage', async () => {
      const storage = new IdentityThrottlerStorage();

      await hit(storage, 'cible');
      advance(TTL + 1);

      await expect(hit(storage, 'cible')).resolves.toMatchObject({ totalHits: 1 });
    });

    it('ne confond pas deux limiteurs nommés qui partagent une clé', async () => {
      const storage = new IdentityThrottlerStorage();

      await expect(hit(storage, 'cible', { name: 'default' })).resolves.toMatchObject({
        totalHits: 1,
      });
      await expect(hit(storage, 'cible', { name: 'strict' })).resolves.toMatchObject({
        totalHits: 1,
      });
    });
  });

  describe('expulsion des entrées expirées — quatrième critère', () => {
    it('ne garde qu’une fenêtre de cibles, et non leur cumul', async () => {
      const storage = new IdentityThrottlerStorage();
      const parFenetre = 50;

      // Quatre fenêtres, cinquante cibles **toutes différentes** dans chacune :
      // exactement ce qu'un appelant obtient en inventant un slug par requête,
      // que la validation refuse après la garde.
      for (let fenetre = 0; fenetre < 4; fenetre += 1) {
        if (fenetre > 0) {
          advance(TTL + SWEEP_INTERVAL_MS);
        }

        for (let cible = 0; cible < parFenetre; cible += 1) {
          await hit(storage, `fenetre-${fenetre}-cible-${cible}`);
        }

        // Deux cents cibles ont été nommées en tout à la dernière itération ;
        // le stockage n'en porte jamais plus de cinquante.
        expect(storage.size).toBe(parFenetre);
      }
    });

    it('ne rend pas leur quota aux cibles encore dans leur fenêtre', async () => {
      const storage = new IdentityThrottlerStorage();

      await hit(storage, 'en-cours');

      // Un appel sur une autre clé, assez tard pour déclencher un balayage mais
      // avant la fin de la fenêtre de la première. Expulser un compteur vivant
      // rendrait un quota neuf à la cible expulsée — ce serait offrir à
      // l'attaquant le moyen de vider le compteur qui le gêne.
      advance(TTL / 2);
      await hit(storage, 'autre');

      expect(storage.size).toBe(2);
      await expect(hit(storage, 'en-cours')).resolves.toMatchObject({ totalHits: 2 });
    });

    it('conserve une entrée bloquée dont la fenêtre est close', async () => {
      const storage = new IdentityThrottlerStorage();

      await hit(storage, 'bloquee');
      await hit(storage, 'bloquee');

      // Le blocage naît au milieu de la fenêtre : il lui survit donc, la peine
      // courant depuis le refus et non depuis l'ouverture du compteur.
      advance(TTL / 2);
      await expect(hit(storage, 'bloquee')).resolves.toMatchObject({ isBlocked: true });

      // Fenêtre close, blocage encore en cours : l'entrée doit survivre au
      // balayage, sans quoi la peine se lèverait d'elle-même.
      advance(TTL / 2 + SWEEP_INTERVAL_MS);
      await hit(storage, 'declencheur-de-balayage');

      await expect(hit(storage, 'bloquee')).resolves.toMatchObject({ isBlocked: true });
    });
  });

  describe('indépendance des compteurs — cinquième critère', () => {
    it('un compteur bloqué ne fige pas la décroissance des autres', async () => {
      const storage = new IdentityThrottlerStorage();

      // Une première cible épuise son quota et se bloque.
      await hit(storage, 'cible-bloquee');
      await hit(storage, 'cible-bloquee');
      await expect(hit(storage, 'cible-bloquee')).resolves.toMatchObject({ isBlocked: true });

      // Une seconde consomme un appel dans la même fenêtre.
      await expect(hit(storage, 'cible-voisine')).resolves.toMatchObject({ totalHits: 1 });

      // Le temps passe : la fenêtre de la voisine s'achève, le blocage de la
      // première expire.
      advance(BLOCK + 1);

      // La première retrouve la main. C'est ce geste — `resetBlockdRequest` —
      // qui, dans le stockage de la bibliothèque, annulait les minuteries de
      // **toutes** les clés du limiteur.
      await expect(hit(storage, 'cible-bloquee')).resolves.toMatchObject({
        totalHits: 1,
        isBlocked: false,
      });

      // La voisine doit donc repartir d'une fenêtre neuve et disposer de son
      // quota entier. Compteur figé, elle serait à deux et se bloquerait un
      // appel trop tôt.
      await expect(hit(storage, 'cible-voisine')).resolves.toMatchObject({
        totalHits: 1,
        isBlocked: false,
      });
      await expect(hit(storage, 'cible-voisine')).resolves.toMatchObject({ isBlocked: false });
      await expect(hit(storage, 'cible-voisine')).resolves.toMatchObject({ isBlocked: true });
    });

    it('n’arme aucune minuterie — rien ne tient la boucle d’événements éveillée', async () => {
      const storage = new IdentityThrottlerStorage();

      for (let cible = 0; cible < 10; cible += 1) {
        await hit(storage, `cible-${cible}`);
        await hit(storage, `cible-${cible}`);
        await hit(storage, `cible-${cible}`);
      }

      // Trente appels, dix blocages, zéro minuterie : c'est ce qui rend le
      // défaut précédent inexprimable, et ce qui dispense d'un
      // `onApplicationShutdown` à appeler après chaque test.
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
