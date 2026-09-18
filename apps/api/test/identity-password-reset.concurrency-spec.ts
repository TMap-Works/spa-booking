import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';

import { runInTenantScope } from '../src/common/tenant';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { AuthService } from '../src/modules/identity/auth.service';
import { IdentityEvents } from '../src/modules/identity/events/identity-events';
import type { PasswordResetRequestedEvent } from '../src/modules/identity/events/password-reset-requested.event';
import { IdentityRepository } from '../src/modules/identity/identity.repository';
import { PasswordHasher } from '../src/modules/identity/password.hasher';
import { hashJti, TokenService } from '../src/modules/identity/token.service';
import { fakeConfig, silentLogger } from '../src/modules/identity/__tests__/identity.doubles';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Demandes de réinitialisation concurrentes sur une même adresse — contre un
 * vrai PostgreSQL (#1034).
 *
 * `auth.service.spec.ts` prouve que le service n'émet rien quand l'écriture
 * rend `false`, mais il le prouve sur un double : rien n'y court, et la
 * condition du `where` y est réécrite à la main. Ce qui ne se prouve qu'ici :
 *
 * - que `UPDATE … WHERE password_reset_requested_at IS NULL OR <= $seuil`
 *   départage réellement N demandes simultanées sur la même adresse. La limite
 *   de débit par adresse était jusqu'ici une vérification applicative — lecture,
 *   comparaison, écriture —, et deux demandes parties ensemble lisaient la même
 *   valeur, passaient toutes deux, et armaient toutes deux : **deux courriers**
 *   pour une seule fenêtre, dont le premier lien n'ouvrait plus rien ;
 * - que sous `READ COMMITTED` la perdante réévalue bien son `where` contre la
 *   ligne que la gagnante vient d'écrire, et rend `count: 0` — c'est cette
 *   propriété du moteur, et non une précaution du code, qui fait tenir la
 *   limite ;
 * - qu'une seule empreinte survit, et que c'est celle du lien effectivement
 *   envoyé.
 *
 * Même classe de défaut que booking-engine §1 interdit au moteur de
 * réservation, même remède : la base tranche, l'application ne fait que
 * demander.
 *
 * Le service est le vrai, branché sur le dépôt réel et le client **scopé**,
 * comme en production.
 */

/**
 * Le nombre de demandes lancées de front, aligné sur les autres suites de
 * concurrence de ce dossier : deux requêtes peuvent se sérialiser par hasard sur
 * un pool de connexions, et un test qui passe par chance ne prouve rien.
 */
const CONCURRENT_ATTEMPTS = 8;

/** Au-delà, la barrière se rouvre d'elle-même : un test qui pend ne dit rien. */
const BARRIER_TIMEOUT_MS = 5_000;

/** Ce que la barrière laisse observer une fois les demandes retombées. */
interface Barriere {
  /** Le nombre de lectures d'état arrivées jusqu'à elle. */
  lectures: () => number;
  /** `true` si elle s'est ouverte parce que le compte y était — non par délai. */
  relachee: () => boolean;
}

/**
 * Retient chaque lecture d'état jusqu'à ce qu'elles soient toutes arrivées.
 *
 * ## Pourquoi il faut forcer la course, et ne pas se contenter de `Promise.all`
 *
 * Mesuré : N demandes lancées de front sur cette suite ne s'entrelacent pas
 * d'elles-mêmes. La gagnante boucle sa lecture, sa signature **et** son écriture
 * avant que la deuxième n'ait lu, si bien que les N−1 suivantes sont arrêtées
 * par le raccourci applicatif et n'atteignent jamais l'écriture. Le cas était
 * alors vert **avec ou sans** le `where` conditionnel — il ne prouvait rien.
 *
 * La fenêtre à exercer est pourtant réelle : en production les demandes arrivent
 * sur des tâches ECS distinctes, où rien ne les sérialise, et c'est là que deux
 * courriers partaient pour une seule fenêtre. La barrière reproduit exactement
 * cet état — toutes ont lu, aucune n'a encore écrit — et laisse ensuite les N
 * écritures se disputer la ligne. Ce qui départage est alors la base, et elle
 * seule.
 *
 * Elle porte sur la **lecture** et non sur l'écriture : retenir les écritures
 * les aurait sérialisées par un autre bout, et c'est précisément leur
 * simultanéité qu'on veut.
 */
function retenirLesLecturesJusquA(count: number): Barriere {
  const original = IdentityRepository.prototype.findPasswordResetState;
  let arrivees = 0;
  let relachee = false;
  let ouvrir: () => void = () => undefined;
  const toutesOntLu = new Promise<void>((resolve) => {
    ouvrir = () => {
      relachee = true;
      resolve();
    };
  });
  // La sortie de secours : sans elle, une demande qui n'arriverait jamais
  // jusqu'à la lecture ferait pendre la suite jusqu'au délai de Jest, et le
  // rapport ne dirait pas pourquoi. `unref` pour que ce timer ne retienne pas le
  // processus une fois le cas terminé.
  const echeance = new Promise<void>((resolve) => {
    setTimeout(resolve, BARRIER_TIMEOUT_MS).unref();
  });

  jest
    .spyOn(IdentityRepository.prototype, 'findPasswordResetState')
    .mockImplementation(async function (this: IdentityRepository, userId: string) {
      const state = await original.call(this, userId);
      arrivees += 1;

      if (arrivees >= count) {
        ouvrir();
      } else {
        await Promise.race([toutesOntLu, echeance]);
      }

      return state;
    });

  return { lectures: () => arrivees, relachee: () => relachee };
}

describe('Demandes de réinitialisation concurrentes — contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  let service: AuthService;
  let tokens: TokenService;
  /** Ce que le bus a publié — la seule façon d'observer qu'un courrier part. */
  let emitted: PasswordResetRequestedEvent[];

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      // Une requête réelle : c'est elle qui prouve que le schéma est en place.
      await prismaUnscoped.user.count();
    } catch (error: unknown) {
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }
  });

  beforeEach(() => {
    const config = fakeConfig();
    const events = new IdentityEvents(silentLogger());
    emitted = [];
    events.onPasswordResetRequested((event) => {
      emitted.push(event);
    });
    tokens = new TokenService(new JwtService(), config);
    service = new AuthService(
      new IdentityRepository(createScopedPrismaClient(prismaUnscoped), prismaUnscoped),
      new PasswordHasher(config),
      tokens,
      silentLogger(),
      events,
    );
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    try {
      await prismaUnscoped.$disconnect();
    } finally {
      await database.drop();
    }
  });

  /** Sème un établissement et une cliente active, avec un mot de passe posé. */
  const seedAccount = async (): Promise<{ slug: string; email: string; userId: string }> => {
    const slug = `i1034-${randomUUID()}`;
    const tenant = await prismaUnscoped.tenant.create({
      data: { slug, name: 'Salon des Lilas', timezone: 'Europe/Paris', defaultCurrency: 'EUR' },
    });

    const email = `alice-${randomUUID()}@example.test`;
    const user = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email,
        role: 'CLIENT',
        firstName: 'Alice',
        lastName: 'Martin',
        passwordHash: await new PasswordHasher(fakeConfig()).hash('correct-horse-battery'),
      },
    });

    return { slug, email, userId: user.id };
  };

  /** Une demande, dans sa propre portée de requête — comme derrière le middleware. */
  const request = (slug: string, email: string): Promise<void> =>
    runInTenantScope(async () => service.requestPasswordReset({ tenantSlug: slug, email }));

  /**
   * L'empreinte que la base doit porter pour un jeton donné — dérivée du `jti`,
   * par le vrai `TokenService`. Rien n'est réimplémenté ici : la suite compare
   * ce que le service a écrit à ce que le service aurait écrit.
   */
  const fingerprintOf = async (token: string): Promise<string> =>
    hashJti((await tokens.verifyPasswordResetToken(token)).jti);

  it('n’émet qu’un seul message pour N demandes simultanées sur la même adresse', async () => {
    const { slug, email, userId } = await seedAccount();
    const barriere = retenirLesLecturesJusquA(CONCURRENT_ATTEMPTS);

    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () => request(slug, email)),
    );

    // La barrière a bien tenu : les N demandes ont lu avant qu'aucune n'écrive,
    // et toutes ont donc tenté d'armer. Sans cette assertion, une barrière qui
    // cesserait de fonctionner rendrait le cas ci-dessous vert sans rien
    // prouver — c'est exactement ce qu'il faisait avant de l'avoir.
    expect(barriere.lectures()).toBe(CONCURRENT_ATTEMPTS);
    expect(barriere.relachee()).toBe(true);

    // Aucune n'échoue : la route rend 202 dans tous les cas, gagnante comme
    // perdantes. Un refus visible aurait dit que l'adresse existe.
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([]);

    // Le cœur du ticket : une seule fenêtre, un seul courrier.
    expect(emitted).toHaveLength(1);

    const stored = await prismaUnscoped.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        passwordResetTokenHash: true,
        passwordResetExpiresAt: true,
        passwordResetRequestedAt: true,
      },
    });

    // Et l'empreinte en base est celle du lien qui est parti : si une perdante
    // avait écrit après la gagnante, le lien envoyé n'ouvrirait plus rien.
    expect(stored.passwordResetTokenHash).toBe(await fingerprintOf(emitted[0]?.token ?? ''));
    expect(stored.passwordResetExpiresAt).toBeInstanceOf(Date);
    expect(stored.passwordResetRequestedAt).toBeInstanceOf(Date);
  });

  it('laisse passer la demande suivante une fois le seuil écoulé', async () => {
    const { slug, email, userId } = await seedAccount();

    await request(slug, email);
    // Ce que le temps aurait fait : la fenêtre est derrière nous.
    await prismaUnscoped.user.update({
      where: { id: userId },
      data: { passwordResetRequestedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await request(slug, email);

    // La limite borne le débit ; elle ne ferme pas la porte. Sans ce cas, un
    // `where` trop strict — une écriture conditionnée à `IS NULL` seul, par
    // exemple — passerait le premier test tout en interdisant à quiconque de
    // redemander un lien.
    expect(emitted).toHaveLength(2);

    const stored = await prismaUnscoped.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordResetTokenHash: true },
    });
    // La seconde demande a bien écrasé l'empreinte de la première : c'est le
    // deuxième critère de #809, et il ne doit pas tomber avec le `where` ajouté.
    expect(stored.passwordResetTokenHash).toBe(await fingerprintOf(emitted[1]?.token ?? ''));
    expect(stored.passwordResetTokenHash).not.toBe(await fingerprintOf(emitted[0]?.token ?? ''));
  });
});
