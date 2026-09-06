import { Prisma } from '@prisma/client';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { MissingTenantContextError } from '../../../common/tenant/tenant-context.errors';
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
 * Les décisions qui, prises autrement, produiraient soit un 500, soit une
 * fuite :
 *
 * 1. la lecture ne filtre **pas** sur le rôle, et juge ce qu'elle trouve. Le
 *    filtrer aurait rendu zéro ligne pour une adresse de compte du personnel,
 *    donc conduit à une création que l'unicité refuse en `P2002` nu ;
 * 2. elle porte le `FOR SHARE` et le filtre `tenant_id` écrit à la main (#468) —
 *    le premier parce que sans lui le refus n'est pas atomique par rapport à
 *    l'insertion qu'il garde, le second parce que le SQL brut ne repasse pas par
 *    l'extension de scoping (ADR 0006) ;
 * 3. une adresse portée par un compte du personnel est **refusée**, jamais
 *    réutilisée — c'est la décision produit du ticket ;
 * 4. une fiche trouvée n'est pas mise à jour : un appel public ne réécrit pas le
 *    nom d'une cliente existante ;
 * 5. une violation d'unicité concurrente devient `ClientRecordRaceError`, un
 *    signal de réessai, et non un 409 ni un 500. C'est la fenêtre que le verrou
 *    ne ferme pas — une lecture sans ligne ne verrouille rien — et que l'unicité
 *    arbitre à sa place.
 *
 * ## Ce qu'elle ne prouve pas
 *
 * Que l'écriture est vraiment dans la transaction de l'appelant, que le
 * `ROLLBACK` emporte la fiche, et que `FOR SHARE` fait vraiment attendre une
 * promotion concurrente : c'est du moteur, et cela s'exerce contre un vrai
 * PostgreSQL — `test/appointments-exclusion.integration-spec.ts` pour la
 * transaction et le rôle jugé à l'insertion,
 * `test/appointments-exclusion.concurrency-spec.ts` pour l'attente sur le verrou
 * lui-même. Ce qu'on vérifie ici est que **la portée reçue est celle qui sert** —
 * jamais un client de premier niveau — et que la requête **demande** le verrou.
 */

const CONTACT: ClientContact = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
};

/** L'établissement courant, pour les deux battants de la porte. */
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

/** Ce que la lecture verrouillée rend, réduit à ce que la résolution juge. */
interface UserRow {
  id: string;
  role: string;
  /** `anonymized_at IS NOT NULL`, tel que le `SELECT` le réduit (#81). */
  anonymized?: boolean;
}

interface Scope {
  scope: ClientDirectoryScope;
  /** Le SQL de lecture, gabarit recollé — c'est là que `FOR SHARE` se voit. */
  sql(): string[];
  /** Les paramètres liés de la lecture, dans l'ordre : l'adresse, puis l'établissement. */
  values(): unknown[];
  /** Les charges utiles de création, dans l'ordre. */
  writes(): Record<string, unknown>[];
}

/**
 * Une portée de transaction réduite aux deux opérations que la résolution émet.
 *
 * La lecture mime `$queryRaw` et non `user.findFirst` depuis #468 : le rôle est
 * désormais lu sous `FOR SHARE`, que le client Prisma n'exprime pas, et le
 * double est donc le même que celui d'`assertBookableWithin` plus bas — il
 * recolle le gabarit et retient les paramètres liés.
 *
 * `found` est la ligne que la lecture rend — absente pour « cette adresse est
 * libre ». `onCreate` permet de faire échouer l'insertion, seule façon d'exercer
 * la course sans deux transactions réelles.
 */
function scopeWith(options: { found?: UserRow | null; onCreate?: Error } = {}): Scope {
  const sql: string[] = [];
  const values: unknown[] = [];
  const writes: Record<string, unknown>[] = [];

  const queryRaw = jest.fn(async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    sql.push(strings.join('?'));
    values.push(...bound);
    return options.found === undefined || options.found === null ? [] : [options.found];
  });

  const user = {
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      writes.push(args.data);
      if (options.onCreate !== undefined) {
        throw options.onCreate;
      }
      return { id: 'fiche-creee' };
    }),
  };

  return {
    scope: { $queryRaw: queryRaw, user } as unknown as ClientDirectoryScope,
    sql: () => sql,
    values: () => values,
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
  /** La résolution, jouée dans une portée de tenant — comme en production. */
  async function resolveWithin(target: Scope, contact: ClientContact = CONTACT): Promise<string> {
    return runWithTenant(TENANT_ID, async () => directory().resolveWithin(target.scope, contact));
  }

  it('rend la fiche cliente existante, sans rien écrire', async () => {
    const target = scopeWith({ found: { id: 'fiche-connue', role: 'CLIENT' } });

    await expect(resolveWithin(target)).resolves.toBe('fiche-connue');

    // Aucune mise à jour : un appel public ne réécrit ni le nom ni le numéro
    // d'une cliente déjà fichée.
    expect(target.writes()).toEqual([]);
  });

  it('cherche sur la seule adresse, sans filtre de rôle', async () => {
    // C'est ce qui rend la collision **décidable**. Filtrer sur le rôle ici
    // aurait rendu zéro ligne sur l'adresse d'un `MANAGER`, donc mené à une
    // création que `@@unique([tenantId, email])` refuse — un `P2002` nu, un 500.
    const target = scopeWith();

    await resolveWithin(target);

    // Le rôle est **projeté** — c'est ce qui se juge —, jamais comparé.
    expect(target.sql()[0]).toContain('"role"::text');
    expect(target.sql()[0]).not.toMatch(/"role"\s*(?:=|IN)/i);
    expect(target.sql()[0]).toMatch(/"email"\s*=/);
    expect(target.values()[0]).toBe('camille@example.test');
  });

  it('pose un verrou partagé sur la ligne lue', async () => {
    // Le trou que #468 referme. Sans `FOR SHARE`, une transaction concurrente
    // peut promouvoir la fiche au personnel entre cette lecture et l'insertion
    // qui suit : les clés étrangères de `appointments.client_id` prouvent
    // l'existence de la ligne et son établissement, jamais son rôle.
    const target = scopeWith({ found: { id: 'fiche-connue', role: 'CLIENT' } });

    await resolveWithin(target);

    expect(target.sql()[0]).toContain('FOR SHARE');
  });

  it('borne la lecture à l’établissement courant, dans le SQL même', async () => {
    // Le SQL brut ne repasse pas par l'extension de scoping (ADR 0006) : le
    // filtre est écrit à la main, et il vient du contexte de requête — jamais
    // d'un paramètre que l'appelant choisirait.
    const target = scopeWith();

    await resolveWithin(target);

    expect(target.sql()[0]).toContain('tenant_id');
    expect(target.values()).toEqual(['camille@example.test', TENANT_ID]);
  });

  it('refuse de lire sans portée de tenant ouverte', async () => {
    // Le mode ouvert par défaut est ce qui produit les fuites : sans contexte,
    // le filtre `tenant_id` n'aurait aucune valeur à porter, et la lecture
    // traverserait les établissements (tenant-isolation §3).
    const target = scopeWith();

    await expect(directory().resolveWithin(target.scope, CONTACT)).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    // Et rien n'est écrit : le refus tombe avant la lecture, donc avant la
    // création qu'elle commande.
    expect(target.sql()).toEqual([]);
    expect(target.writes()).toEqual([]);
  });

  it('ne nomme jamais le tenant dans la création : c’est l’extension qui le pose', async () => {
    // La lecture l'écrit — elle est en SQL brut, hors du champ de l'extension —,
    // la création surtout pas : un `tenantId` recopié dans le `data` serait une
    // seconde source de vérité, et la première occasion de se tromper
    // d'établissement (tenant-isolation §3).
    const target = scopeWith();

    await resolveWithin(target);

    expect(target.writes()[0]).not.toHaveProperty('tenantId');
  });

  it('crée une fiche `CLIENT` inconnectable quand l’adresse est libre', async () => {
    const target = scopeWith();

    await expect(resolveWithin(target)).resolves.toBe('fiche-creee');

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

    await resolveWithin(target);

    expect(target.writes()[0]).not.toHaveProperty('internalNote');
  });

  it('canonise l’adresse avant de chercher et d’écrire', async () => {
    // La porte est ouverte à tout module, et l'unicité `(tenant_id, email)` porte
    // sur les octets : faire confiance à l'appelant laisserait naître deux fiches
    // pour la même personne le jour où un second appelant oublierait de canoniser.
    const target = scopeWith();

    await resolveWithin(target, { ...CONTACT, email: '  Camille@Example.TEST ' });

    // L'adresse canonisée est ce qui part **en paramètre lié**, jamais recopiée
    // dans le gabarit : le SQL est le même quelle que soit la saisie.
    expect(target.values()).toEqual(['camille@example.test', TENANT_ID]);
    expect(target.writes()[0]).toMatchObject({ email: 'camille@example.test' });
  });

  it('refuse une adresse portée par un compte du personnel', async () => {
    // La décision produit de #313 : une réservation publique ne s'accroche jamais
    // à un compte du salon. Le refus est explicite et sort en 409.
    const target = scopeWith({ found: { id: 'compte-gerante', role: 'MANAGER' } });

    await expect(resolveWithin(target)).rejects.toBeInstanceOf(ClientEmailNotBookableError);
    expect(target.writes()).toEqual([]);
  });

  it.each(['STAFF', 'MANAGER', 'ADMIN'])('refuse aussi un compte %s', async (role) => {
    const target = scopeWith({ found: { id: 'compte', role } });

    await expect(resolveWithin(target)).rejects.toBeInstanceOf(ClientEmailNotBookableError);
  });

  it('refuse une fiche anonymisée, comme le comptoir (#81)', async () => {
    // La jumelle `assertBookableWithin` écarte la fiche anonymisée dans son SQL ;
    // celle-ci cherche par adresse et doit la juger sur la ligne rendue. Le
    // pseudonyme étant dérivé de l'`id` — donc reconstructible par quiconque tient
    // l'export remis à la personne —, sans ce refus une réservation publique
    // rattachait un rendez-vous à qui venait d'exercer son droit à l'oubli.
    const target = scopeWith({ found: { id: 'fiche-oubliee', role: 'CLIENT', anonymized: true } });

    await expect(resolveWithin(target)).rejects.toBeInstanceOf(ClientEmailNotBookableError);
    // Et surtout : aucune fiche créée en repli, qui aurait heurté
    // `@@unique([tenantId, email])` et fait boucler le réessai de `writingAgenda`.
    expect(target.writes()).toEqual([]);
  });

  it('projette l’anonymisation dans le SELECT, sans paramètre lié de plus (#81)', async () => {
    const target = scopeWith({ found: { id: 'fiche-connue', role: 'CLIENT', anonymized: false } });

    await expect(resolveWithin(target)).resolves.toBe('fiche-connue');

    expect(target.sql()[0]).toMatch(/"anonymized_at"\s+IS\s+NOT\s+NULL/i);
    expect(target.values()).toEqual(['camille@example.test', TENANT_ID]);
  });

  it('ne dit pas l’adresse dans le refus', async () => {
    // Une adresse e-mail est une donnée personnelle (CDC §5.1), et le corps
    // d'erreur est précisément ce qui repart vers un journal ou une capture
    // d'écran de ticket. Celui qui vient de la saisir la connaît déjà.
    const target = scopeWith({ found: { id: 'compte-gerante', role: 'MANAGER' } });

    const refused = await resolveWithin(target).catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: 'CLIENT_EMAIL_NOT_BOOKABLE', status: 409, details: {} });
    expect((refused as Error).message).not.toContain('camille@example.test');
    expect(JSON.stringify(refused)).not.toContain('camille@example.test');
  });

  it('réutilise une fiche désactivée plutôt que de la refuser', async () => {
    // La désactivation gouverne les écrans du back-office, pas l'identité de qui
    // réserve. La refuser aurait fait de cette route publique un oracle sur le
    // fichier client du salon — la donnée même que ce module protège.
    const target = scopeWith({ found: { id: 'fiche-archivee', role: 'CLIENT' } });

    await expect(resolveWithin(target)).resolves.toBe('fiche-archivee');
  });

  it('traduit une unicité violée en signal de réessai, jamais en refus', async () => {
    // Deux réservations d'invité concurrentes sur la même adresse : la perdante
    // n'a rien fait de mal. Relire ici serait vain — la violation a abandonné la
    // transaction —, et c'est l'appelant qui rejoue.
    //
    // Le `FOR SHARE` de #468 ne referme **pas** cette fenêtre-là, et ne le
    // pouvait pas : une lecture qui ne rend aucune ligne ne verrouille rien.
    // C'est l'unicité `(tenant_id, email)` qui arbitre, et `writingAgenda` qui
    // rejoue — d'où ce test, qui garde ce chemin vivant.
    const target = scopeWith({ onCreate: uniqueViolation() });

    await expect(resolveWithin(target)).rejects.toBeInstanceOf(ClientRecordRaceError);
  });

  it('laisse remonter telle quelle une erreur qui n’est pas une unicité', async () => {
    const boom = new Error('Connection refused');
    const target = scopeWith({ onCreate: boom });

    await expect(resolveWithin(target)).rejects.toBe(boom);
  });
});

/**
 * Le second battant de la porte — la fiche **désignée** par le comptoir (#465).
 *
 * ## Ce que cette suite prouve
 *
 * 1. le contrôle passe par la **portée reçue**, jamais par un client de premier
 *    niveau : c'est ce qui fait qu'un refus n'a rien à défaire, le `ROLLBACK` de
 *    l'appelant s'en chargeant ;
 * 2. la requête porte le filtre `tenant_id` **et** le `FOR SHARE`. Le premier
 *    parce que le SQL brut ne repasse pas par l'extension de scoping ; le second
 *    parce que sans lui la lecture serait la « vérification applicative suivie
 *    d'un `INSERT` » que booking-engine §1 interdit ;
 * 3. les quatre rôles : `CLIENT` passe, les trois autres sont refusés ;
 * 4. le refus est un **404**, le même que pour une fiche inconnue — l'arbitrage
 *    du ticket — et il ne recopie ni le rôle ni rien de la ligne.
 *
 * ## Ce qu'elle ne prouve pas
 *
 * Que `FOR SHARE` verrouille vraiment, et qu'une promotion concurrente attend le
 * `COMMIT` : c'est du moteur, et cela s'exerce contre un vrai PostgreSQL
 * (`test/appointments-exclusion.integration-spec.ts`). Ce qui se vérifie ici est
 * que la requête **le demande**.
 */
describe('ClientDirectoryService.assertBookableWithin', () => {
  const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

  interface RawScope {
    scope: ClientDirectoryScope;
    /** Le SQL émis, gabarit recollé — c'est là que `FOR SHARE` se voit. */
    sql(): string[];
    /** Les paramètres liés, dans l'ordre : la fiche, puis l'établissement. */
    values(): unknown[];
  }

  /** Une portée réduite au seul `$queryRaw` que le contrôle émet. */
  function scopeReturning(...rows: { role: string }[]): RawScope {
    const sql: string[] = [];
    const values: unknown[] = [];

    const queryRaw = jest.fn(async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      sql.push(strings.join('?'));
      values.push(...bound);
      return rows;
    });

    return {
      scope: { $queryRaw: queryRaw } as unknown as ClientDirectoryScope,
      sql: () => sql,
      values: () => values,
    };
  }

  /** Le contrôle, joué dans une portée de tenant — comme en production. */
  async function assertWithin(target: RawScope, clientId = CLIENT_ID): Promise<string> {
    return runWithTenant(TENANT_ID, async () =>
      directory().assertBookableWithin(target.scope, clientId),
    );
  }

  it('rend l’identifiant d’une fiche du fichier client', async () => {
    const target = scopeReturning({ role: 'CLIENT' });

    await expect(assertWithin(target)).resolves.toBe(CLIENT_ID);
  });

  it('lit dans la portée reçue, et pose un verrou partagé sur la ligne', async () => {
    // `FOR SHARE` est ce qui distingue ce contrôle d'une vérification
    // applicative : sans lui, une transaction concurrente pourrait promouvoir la
    // fiche au personnel entre cette lecture et l'insertion qui suit, et les
    // clés étrangères — qui ne voient pas le rôle — la laisseraient passer.
    const target = scopeReturning({ role: 'CLIENT' });

    await assertWithin(target);

    expect(target.sql()[0]).toContain('FOR SHARE');
  });

  it('borne la lecture à l’établissement courant, dans le SQL même', async () => {
    // Le SQL brut ne repasse pas par l'extension de scoping (ADR 0006) : le
    // filtre est écrit à la main, et il vient du contexte de requête — jamais
    // d'un paramètre que l'appelant choisirait.
    const target = scopeReturning({ role: 'CLIENT' });

    await assertWithin(target);

    expect(target.sql()[0]).toContain('tenant_id');
    expect(target.values()).toEqual([CLIENT_ID, TENANT_ID]);
  });

  it('écarte une fiche anonymisée dans le SQL même (#81)', async () => {
    // Une fiche anonymisée reste de rôle `CLIENT` — elle doit le rester, sinon
    // elle disparaîtrait du fichier client et de son propre export —, si bien
    // que le seul filtre de rôle la laissait passer. Sans ce prédicat, le
    // comptoir pouvait rattacher un nouveau rendez-vous à une personne qui
    // venait d'exercer son droit à l'oubli, et la réinscrire au fichier par la
    // bande.
    const target = scopeReturning({ role: 'CLIENT' });

    await assertWithin(target);

    expect(target.sql()[0]).toMatch(/"anonymized_at"\s+IS\s+NULL/i);
    // Le prédicat est constant : il n'ajoute aucun paramètre lié, et ne change
    // donc ni le plan de la requête ni la portée du verrou.
    expect(target.values()).toEqual([CLIENT_ID, TENANT_ID]);
  });

  it.each(['STAFF', 'MANAGER', 'ADMIN'])('refuse en 404 un compte %s du salon', async (role) => {
    // Le trou que le ticket referme : les deux clés étrangères prouvent
    // l'existence et l'établissement de la ligne, jamais son rôle.
    const target = scopeReturning({ role });

    await expect(assertWithin(target)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rend le même 404 pour une ligne absente — inconnue ou du salon voisin', async () => {
    // Le `where` porte le tenant : une fiche du voisin ne rend aucune ligne, et
    // devient donc indiscernable d'un identifiant inventé (tenant-isolation §4).
    const target = scopeReturning();

    await expect(assertWithin(target)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ne dit ni le rôle ni rien de la ligne dans le refus', async () => {
    // Un refus qui nommerait le rôle ferait de cette route une sonde de
    // l'annuaire du personnel, interrogeable identifiant par identifiant.
    const target = scopeReturning({ role: 'MANAGER' });

    const refused = await assertWithin(target).catch((error: unknown) => error);

    expect(refused).toMatchObject({ status: 404 });
    // Le **message** d'abord, et explicitement : `JSON.stringify` d'une `Error`
    // ne le sérialise pas — il est propre non énumérable —, si bien qu'un refus
    // qui nommerait le rôle dans sa phrase satisferait une assertion qui ne
    // regarderait que la forme sérialisée. C'est précisément la régression que
    // ce test existe pour attraper.
    expect((refused as NotFoundError).message).toBe('Cliente introuvable.');
    expect(JSON.stringify(refused)).not.toContain('MANAGER');
  });

  it('refuse de lire sans portée de tenant ouverte', async () => {
    // Le mode ouvert par défaut est ce qui produit les fuites : sans contexte,
    // le filtre `tenant_id` n'aurait aucune valeur à porter, et la lecture
    // traverserait les établissements (tenant-isolation §3).
    const target = scopeReturning({ role: 'CLIENT' });

    await expect(directory().assertBookableWithin(target.scope, CLIENT_ID)).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });
});
