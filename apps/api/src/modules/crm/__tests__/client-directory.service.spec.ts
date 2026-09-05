import { Prisma } from '@prisma/client';

import {
  ClientDirectoryService,
  type ClientContact,
  type ClientDirectoryScope,
} from '../client-directory.service';
import { CrmRepository } from '../crm.repository';
import { ClientEmailNotBookableError, ClientRecordRaceError } from '../crm.errors';

/**
 * La porte que `crm` ouvre à `appointments` (#313) — et le seul endroit du dépôt
 * qui écrive dans la transaction d'un autre module.
 *
 * ## Ce que cette suite prouve
 *
 * Les quatre décisions qui, prises autrement, produiraient soit un 500, soit une
 * fuite :
 *
 * 1. la lecture ne filtre **pas** sur le rôle, et juge ce qu'elle trouve. Le
 *    filtrer aurait rendu `null` pour une adresse de compte du personnel, donc
 *    conduit à une création que l'unicité refuse en `P2002` nu ;
 * 2. une adresse portée par un compte du personnel est **refusée**, jamais
 *    réutilisée — c'est la décision produit du ticket ;
 * 3. une fiche trouvée n'est pas mise à jour : un appel public ne réécrit pas le
 *    nom d'une cliente existante ;
 * 4. une violation d'unicité concurrente devient `ClientRecordRaceError`, un
 *    signal de réessai, et non un 409 ni un 500.
 *
 * ## Ce qu'elle ne prouve pas
 *
 * Que l'écriture est vraiment dans la transaction de l'appelant, et que le
 * `ROLLBACK` emporte la fiche : c'est de l'atomicité de PostgreSQL, exercée par
 * `test/appointments-exclusion.integration-spec.ts` contre un vrai moteur. Ce
 * qu'on vérifie ici est que **la portée reçue est celle qui sert**, et jamais un
 * client de premier niveau.
 */

const CONTACT: ClientContact = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
};

/** Ce que `users.findFirst` rend, réduit au `select` de la résolution. */
interface UserRow {
  id: string;
  role: string;
}

interface Scope {
  scope: ClientDirectoryScope;
  /** Les `where` de lecture, dans l'ordre — c'est là que le filtre se voit. */
  reads(): Record<string, unknown>[];
  /** Les charges utiles de création, dans l'ordre. */
  writes(): Record<string, unknown>[];
}

/**
 * Une portée de transaction réduite aux deux opérations que la résolution émet.
 *
 * `found` est la ligne que la lecture rend — `null` pour « cette adresse est
 * libre ». `onCreate` permet de faire échouer l'insertion, seule façon d'exercer
 * la course sans deux transactions réelles.
 */
function scopeWith(options: { found?: UserRow | null; onCreate?: Error } = {}): Scope {
  const reads: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];

  const user = {
    findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
      reads.push(args.where);
      return options.found ?? null;
    }),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      writes.push(args.data);
      if (options.onCreate !== undefined) {
        throw options.onCreate;
      }
      return { id: 'fiche-creee' };
    }),
  };

  return {
    scope: { user } as unknown as ClientDirectoryScope,
    reads: () => reads,
    writes: () => writes,
  };
}

/** Le **vrai** service, branché sur le **vrai** dépôt — seule la portée est un double. */
function directory(): ClientDirectoryService {
  // Le client injecté n'est jamais touché : `resolveClientWithin` n'écrit que
  // dans la portée qu'on lui passe. Un dépôt qui retomberait sur `this.prisma`
  // ferait échouer la suite sur un `undefined`, ce qui est exactement le filet
  // qu'on veut ici.
  return new ClientDirectoryService(new CrmRepository(undefined as never));
}

function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.12.0',
  });
}

describe('ClientDirectoryService.resolveWithin', () => {
  it('rend la fiche cliente existante, sans rien écrire', async () => {
    const target = scopeWith({ found: { id: 'fiche-connue', role: 'CLIENT' } });

    await expect(directory().resolveWithin(target.scope, CONTACT)).resolves.toBe('fiche-connue');

    // Aucune mise à jour : un appel public ne réécrit ni le nom ni le numéro
    // d'une cliente déjà fichée.
    expect(target.writes()).toEqual([]);
  });

  it('cherche sur la seule adresse, sans filtre de rôle', async () => {
    // C'est ce qui rend la collision **décidable**. Filtrer `role: 'CLIENT'` ici
    // aurait rendu `null` sur l'adresse d'un `MANAGER`, donc mené à une création
    // que `@@unique([tenantId, email])` refuse — un `P2002` nu, donc un 500.
    const target = scopeWith();

    await directory().resolveWithin(target.scope, CONTACT);

    expect(target.reads()).toEqual([{ email: 'camille@example.test' }]);
  });

  it('ne nomme jamais le tenant : c’est l’extension qui le pose', async () => {
    // Un `tenantId` recopié ici serait une seconde source de vérité, et la
    // première occasion de se tromper d'établissement (tenant-isolation §3).
    const target = scopeWith();

    await directory().resolveWithin(target.scope, CONTACT);

    expect(target.reads()[0]).not.toHaveProperty('tenantId');
    expect(target.writes()[0]).not.toHaveProperty('tenantId');
  });

  it('crée une fiche `CLIENT` inconnectable quand l’adresse est libre', async () => {
    const target = scopeWith();

    await expect(directory().resolveWithin(target.scope, CONTACT)).resolves.toBe('fiche-creee');

    expect(target.writes()[0]).toEqual({
      email: 'camille@example.test',
      role: 'CLIENT',
      // La colonne est nullable exactement pour cela : la fiche existe pour être
      // jointe à un rendez-vous, pas pour ouvrir une session.
      passwordHash: null,
      firstName: 'Camille',
      lastName: 'Rakoto',
      phone: '+261 34 12 345 67',
    });
  });

  it('n’écrit aucune note interne : le dossier du salon ne s’ouvre pas au public', async () => {
    const target = scopeWith();

    await directory().resolveWithin(target.scope, CONTACT);

    expect(target.writes()[0]).not.toHaveProperty('internalNote');
  });

  it('canonise l’adresse avant de chercher et d’écrire', async () => {
    // La porte est ouverte à tout module, et l'unicité `(tenant_id, email)` porte
    // sur les octets : faire confiance à l'appelant laisserait naître deux fiches
    // pour la même personne le jour où un second appelant oublierait de canoniser.
    const target = scopeWith();

    await directory().resolveWithin(target.scope, { ...CONTACT, email: '  Camille@Example.TEST ' });

    expect(target.reads()).toEqual([{ email: 'camille@example.test' }]);
    expect(target.writes()[0]).toMatchObject({ email: 'camille@example.test' });
  });

  it('refuse une adresse portée par un compte du personnel', async () => {
    // La décision produit de #313 : une réservation publique ne s'accroche jamais
    // à un compte du salon. Le refus est explicite et sort en 409.
    const target = scopeWith({ found: { id: 'compte-gerante', role: 'MANAGER' } });

    await expect(directory().resolveWithin(target.scope, CONTACT)).rejects.toBeInstanceOf(
      ClientEmailNotBookableError,
    );
    expect(target.writes()).toEqual([]);
  });

  it.each(['STAFF', 'MANAGER', 'ADMIN'])('refuse aussi un compte %s', async (role) => {
    const target = scopeWith({ found: { id: 'compte', role } });

    await expect(directory().resolveWithin(target.scope, CONTACT)).rejects.toBeInstanceOf(
      ClientEmailNotBookableError,
    );
  });

  it('ne dit pas l’adresse dans le refus', async () => {
    // Une adresse e-mail est une donnée personnelle (CDC §5.1), et le corps
    // d'erreur est précisément ce qui repart vers un journal ou une capture
    // d'écran de ticket. Celui qui vient de la saisir la connaît déjà.
    const target = scopeWith({ found: { id: 'compte-gerante', role: 'MANAGER' } });

    const refused = await directory()
      .resolveWithin(target.scope, CONTACT)
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: 'CLIENT_EMAIL_NOT_BOOKABLE', status: 409, details: {} });
    expect(JSON.stringify(refused)).not.toContain('camille@example.test');
  });

  it('réutilise une fiche désactivée plutôt que de la refuser', async () => {
    // La désactivation gouverne les écrans du back-office, pas l'identité de qui
    // réserve. La refuser aurait fait de cette route publique un oracle sur le
    // fichier client du salon — la donnée même que ce module protège.
    const target = scopeWith({ found: { id: 'fiche-archivee', role: 'CLIENT' } });

    await expect(directory().resolveWithin(target.scope, CONTACT)).resolves.toBe('fiche-archivee');
  });

  it('traduit une unicité violée en signal de réessai, jamais en refus', async () => {
    // Deux réservations d'invité concurrentes sur la même adresse : la perdante
    // n'a rien fait de mal. Relire ici serait vain — la violation a abandonné la
    // transaction —, et c'est l'appelant qui rejoue.
    const target = scopeWith({ onCreate: uniqueViolation() });

    await expect(directory().resolveWithin(target.scope, CONTACT)).rejects.toBeInstanceOf(
      ClientRecordRaceError,
    );
  });

  it('laisse remonter telle quelle une erreur qui n’est pas une unicité', async () => {
    const boom = new Error('Connection refused');
    const target = scopeWith({ onCreate: boom });

    await expect(directory().resolveWithin(target.scope, CONTACT)).rejects.toBe(boom);
  });
});
