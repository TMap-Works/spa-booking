import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { MissingTenantContextError } from '../../../common/tenant/tenant-context.errors';
import {
  ClientDirectoryService,
  type ClientDirectoryScope,
} from '../client-directory.service';
import { CrmRepository } from '../crm.repository';

/**
 * La porte que `crm` ouvre à `appointments` (#313, #465) — et le seul endroit du
 * dépôt qui lise dans la transaction d'un autre module.
 *
 * ## Ce qu'elle est devenue
 *
 * Elle a eu deux battants : `resolveWithin`, qui obtenait une fiche depuis des
 * coordonnées et la créait au besoin, et `assertBookableWithin`, qui confirme
 * une fiche désignée. Le premier a été retiré par #1222, plus aucune route ne
 * l'atteignant depuis que réserver exige un compte (#1136) — et avec lui sont
 * partis le refus `CLIENT_EMAIL_NOT_BOOKABLE` et le signal de réessai
 * `ClientRecordRaceError`, qui n'avaient pas d'autre émetteur.
 *
 * Ce qui reste **juge**, et n'écrit rien.
 *
 * ## Ce que cette suite ne prouve pas
 *
 * Que la lecture est vraiment dans la transaction de l'appelant, et que
 * `FOR SHARE` fait vraiment attendre une promotion concurrente : c'est du
 * moteur, et cela s'exerce contre un vrai PostgreSQL —
 * `test/appointments-exclusion.integration-spec.ts` pour le rôle jugé à
 * l'insertion, `test/appointments-exclusion.concurrency-spec.ts` pour l'attente
 * sur le verrou lui-même. Ce qu'on vérifie ici est que **la portée reçue est
 * celle qui sert** — jamais un client de premier niveau — et que la requête
 * **demande** le verrou.
 */

/** L'établissement courant. */
const TENANT_ID = '55555555-5555-4555-8555-555555555555';

/** Le **vrai** service, branché sur le **vrai** dépôt — seule la portée est un double. */
function directory(): ClientDirectoryService {
  // Le client injecté n'est jamais touché : `assertClientBookableWithin` ne lit
  // que dans la portée qu'on lui passe. Un dépôt qui retomberait sur
  // `this.prisma` ferait échouer la suite sur un `undefined`, ce qui est
  // exactement le filet qu'on veut ici.
  return new ClientDirectoryService(new CrmRepository(undefined as never));
}

/**
 * La porte — la fiche **désignée** par l'appelant (#465).
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
