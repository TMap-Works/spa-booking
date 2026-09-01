import { randomUUID } from 'node:crypto';

import { MissingTenantContextError, runWithTenant } from '../../../common/tenant';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import {
  SLOT_LOCK_TTL_SECONDS,
  slotLockKey,
  tenantSlotLockKeyPrefix,
} from '../slot-lock.service';
import { FakeCacheLocks } from './appointments.doubles';

/**
 * Le verrou Redis de créneau — #38.
 *
 * Cette suite tient les quatre critères du ticket, un par bloc, et elle est le
 * seul endroit où ils sont énoncés :
 *
 * 1. un `SET NX EX` **court** sur la clé du créneau, préfixée par le tenant ;
 * 2. la libération dans un `finally`, y compris quand l'écriture a échoué ;
 * 3. une panne Redis qui dégrade l'expérience sans casser la réservation ;
 * 4. un verrou qui ne conditionne **jamais** la validité de l'écriture — ce qui
 *    se prouve ici par ce que le service *ne fait pas* : il n'inspecte rien, ne
 *    juge rien, et l'écriture qu'il encadre est la même, verrou ou pas.
 */

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const STAFF_ID = randomUUID();
const START = new Date('2026-09-01T10:00:00.000Z');

describe('la clé du verrou de créneau', () => {
  it('commence par la racine puis l’établissement', () => {
    // Le tenant en tête est ce qui rend impossible qu'un établissement
    // verrouille — ou observe — le créneau d'un autre (tenant-isolation §5).
    expect(slotLockKey(TENANT, STAFF_ID, START)).toBe(
      `slot:${TENANT}:${STAFF_ID}:2026-09-01T10:00:00.000Z`,
    );
  });

  it('sépare deux établissements qui partagent praticien et heure', () => {
    // Les identifiants de praticien sont propres à chaque établissement, mais
    // la clé ne doit pas en dépendre : c'est le tenant qui tient la frontière.
    expect(slotLockKey(TENANT, STAFF_ID, START)).not.toBe(
      slotLockKey(OTHER_TENANT, STAFF_ID, START),
    );
  });

  it('ferme le préfixe d’établissement par un deux-points', () => {
    // Sans lui, le préfixe du tenant `abc` couvrirait les clés du tenant `abcd`
    // — même raison qu'en face, dans le cache de disponibilité.
    expect(tenantSlotLockKeyPrefix('abc')).toBe('slot:abc:');
    expect(slotLockKey('abcd', STAFF_ID, START).startsWith(tenantSlotLockKeyPrefix('abc'))).toBe(
      false,
    );
  });

  it('porte l’instant en UTC, quel que soit le fuseau de la machine', () => {
    // Deux écritures du même instant écrit autrement doivent tomber sur la même
    // clé, sans quoi le verrou ne verrouille rien.
    expect(slotLockKey(TENANT, STAFF_ID, new Date('2026-09-01T12:00:00+02:00'))).toBe(
      slotLockKey(TENANT, STAFF_ID, START),
    );
  });
});

describe('SlotLockService — le cas nominal', () => {
  it('pose le verrou, écrit, puis le relâche', async () => {
    const locks = new FakeCacheLocks();
    const service = locks.asService();
    const key = slotLockKey(TENANT, STAFF_ID, START);

    const written = await runWithTenant(TENANT, () =>
      service.aroundWrite({ staffId: STAFF_ID, startsAt: START }, () => {
        // Pendant l'écriture, le verrou est tenu : c'est tout ce qu'il fait.
        expect(locks.held.has(key)).toBe(true);
        return Promise.resolve('rendez-vous');
      }),
    );

    expect(written).toBe('rendez-vous');
    expect(locks.releases).toEqual([key]);
    expect(locks.held.has(key)).toBe(false);
  });

  it('demande un TTL court', async () => {
    // Le verrou n'est tenu que le temps de l'écriture ; le TTL ne borne que le
    // cas où le `finally` ne s'exécute pas — un processus abattu.
    const locks = new FakeCacheLocks();

    await runWithTenant(TENANT, () =>
      locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, () => Promise.resolve(1)),
    );

    expect(locks.ttls.get(slotLockKey(TENANT, STAFF_ID, START))).toBe(SLOT_LOCK_TTL_SECONDS);
    expect(SLOT_LOCK_TTL_SECONDS).toBeLessThanOrEqual(120);
  });

  it('refuse de verrouiller hors de toute portée d’établissement', async () => {
    // Défaut fermé, comme partout : une clé de verrou sans tenant serait une
    // clé partagée par tous les salons.
    const locks = new FakeCacheLocks();

    await expect(
      locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });
});

describe('SlotLockService — la libération dans un finally (2ᵉ critère)', () => {
  it('relâche le verrou quand la contrainte refuse le créneau', async () => {
    // C'est le cas qui compte : un 409 laisse la cliente réessayer, et un verrou
    // resté posé lui refuserait son propre créneau pendant tout le TTL.
    const locks = new FakeCacheLocks();
    const key = slotLockKey(TENANT, STAFF_ID, START);

    await expect(
      runWithTenant(TENANT, () =>
        locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, () =>
          Promise.reject(new SlotNoLongerAvailableError(STAFF_ID, START)),
        ),
      ),
    ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

    expect(locks.releases).toEqual([key]);
    expect(locks.held.has(key)).toBe(false);
  });

  it('relâche le verrou sur n’importe quelle erreur, pas seulement un 409', async () => {
    // « y compris en cas d'erreur » se lit au sens large : une panne de base, un
    // bug, une erreur de programmation. Le `finally` ne trie pas.
    const locks = new FakeCacheLocks();

    await expect(
      runWithTenant(TENANT, () =>
        locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, () =>
          Promise.reject(new Error('la base a coupé')),
        ),
      ),
    ).rejects.toThrow('la base a coupé');

    expect(locks.held.size).toBe(0);
  });

  it('laisse remonter l’erreur de l’écriture, pas celle du cache', async () => {
    // Une libération qui rejetterait depuis le `finally` **remplacerait**
    // l'erreur de l'appelant : la cliente lirait « Redis injoignable » là où son
    // créneau venait d'être pris.
    const locks = new FakeCacheLocks();

    await expect(
      runWithTenant(TENANT, () =>
        locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, async () => {
          locks.failWith = new Error('ECONNRESET pendant la libération');
          throw new SlotNoLongerAvailableError(STAFF_ID, START);
        }),
      ),
    ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);
  });
});

describe('SlotLockService — la panne Redis (3ᵉ critère)', () => {
  it('réserve quand même quand le cache est injoignable', async () => {
    // La propriété du ticket : une panne Redis dégrade l'expérience — plus de
    // verrou — sans jamais faire échouer une réservation valide.
    const locks = new FakeCacheLocks();
    locks.failWith = new Error('ECONNREFUSED 127.0.0.1:6379');

    await expect(
      runWithTenant(TENANT, () =>
        locks
          .asService()
          .aroundWrite({ staffId: STAFF_ID, startsAt: START }, () => Promise.resolve('écrit')),
      ),
    ).resolves.toBe('écrit');
  });

  it('n’essaie pas de relâcher un verrou qu’il n’a pas pris', async () => {
    // Relâcher sans jeton supprimerait le verrou de quelqu'un d'autre — la
    // panne se propagerait alors en incident d'isolation.
    const locks = new FakeCacheLocks();
    const key = slotLockKey(TENANT, STAFF_ID, START);
    locks.seedHeld(key);
    locks.failWith = new Error('ECONNREFUSED');

    await runWithTenant(TENANT, () =>
      locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, () => Promise.resolve(1)),
    );

    expect(locks.held.get(key)).toBe('jeton-d-un-autre');
    expect(locks.releases).toEqual([]);
  });
});

describe('SlotLockService — la contention (1ᵉʳ et 4ᵉ critères)', () => {
  it('refuse le créneau qu’un autre appelant est en train d’écrire', async () => {
    // Le refus est celui de la contrainte, mot pour mot : le front n'a qu'une
    // conduite pour les deux, et les distinguer ferait de la réponse une sonde
    // d'agenda.
    const locks = new FakeCacheLocks();
    locks.seedHeld(slotLockKey(TENANT, STAFF_ID, START));
    const write = jest.fn(() => Promise.resolve(1));

    await expect(
      runWithTenant(TENANT, () =>
        locks.asService().aroundWrite({ staffId: STAFF_ID, startsAt: START }, write),
      ),
    ).rejects.toBeInstanceOf(SlotNoLongerAvailableError);

    // Et l'écriture n'a pas eu lieu : c'est la seule chose que le verrou empêche.
    expect(write).not.toHaveBeenCalled();
  });

  it('ne laisse pas un établissement verrouiller le créneau de son voisin', async () => {
    // Deux salons qui partagent l'identifiant d'un praticien — ce que rien
    // n'interdit — écrivent sur deux clés distinctes. Le verrou de l'un ne peut
    // donc pas refuser la réservation de l'autre (tenant-isolation §5).
    const locks = new FakeCacheLocks();
    locks.seedHeld(slotLockKey(OTHER_TENANT, STAFF_ID, START));

    await expect(
      runWithTenant(TENANT, () =>
        locks
          .asService()
          .aroundWrite({ staffId: STAFF_ID, startsAt: START }, () => Promise.resolve('écrit')),
      ),
    ).resolves.toBe('écrit');
  });

  it('ne verrouille que le créneau demandé, pas l’agenda du praticien', async () => {
    // Le verrou porte sur le créneau **affiché**. Ordonner les intervalles qui
    // se chevauchent est le rôle du verrou consultatif PostgreSQL (ADR 0006), et
    // trancher leur unicité celui de la contrainte.
    const locks = new FakeCacheLocks();
    locks.seedHeld(slotLockKey(TENANT, STAFF_ID, START));

    await expect(
      runWithTenant(TENANT, () =>
        locks
          .asService()
          .aroundWrite(
            { staffId: STAFF_ID, startsAt: new Date('2026-09-01T10:15:00.000Z') },
            () => Promise.resolve('écrit'),
          ),
      ),
    ).resolves.toBe('écrit');
  });
});
