import { getTenantId } from '../../../common/tenant';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { appointmentDedupeKey, type DueReminder } from '../notifications.types';
import type { ReminderSweepRepository } from '../reminder-sweep.repository';
import {
  ReminderSweepService,
  sweepStartOffset,
  type ReminderSweepResult,
} from '../reminder-sweep.service';
import { REMINDER_LEAD_MS, REMINDER_WINDOW_MS } from '../reminder-window';
import { recordingLogger } from './notifications.doubles';

/**
 * Le balayage horaire du rappel J-1 — #71.
 *
 * ## Ce que le double prouve, et ce qu'un double complaisant n'aurait pas prouvé
 *
 * Le dépôt bouchonné lit le **vrai** contexte de tenant — celui que l'extension
 * Prisma consulterait — et **refuse** de répondre hors portée. Un balayage qui
 * oublierait d'ouvrir la portée, ou qui l'ouvrirait une fois pour toutes sur le
 * premier établissement, fait donc rougir cette suite. C'est la même conduite
 * que `FakeNotificationsJournal` chez #70, et pour la même raison : un double
 * indexé sur un tenant passé en argument n'aurait rien attesté.
 */

const NOW = new Date('2026-09-07T09:00:00.000Z');

/** Le début de rendez-vous situé `lead` millisecondes après `NOW`. */
function startsAt(lead: number): Date {
  return new Date(NOW.getTime() + lead);
}

/** Un rendez-vous dû, au milieu de la fenêtre, joignable sur les deux canaux. */
function due(overrides: Partial<DueReminder> = {}): DueReminder {
  return {
    tenantId: 'tenant-a',
    appointmentId: 'appointment-1',
    clientId: 'client-1',
    startsAt: startsAt(REMINDER_LEAD_MS + REMINDER_WINDOW_MS / 2),
    hasEmail: true,
    hasSms: true,
    liveChannels: [],
    ...overrides,
  };
}

/** Échec du double quand aucune portée de tenant n'est ouverte. */
class OutOfScopeError extends Error {
  public constructor() {
    super('findDueAppointments appelé hors de toute portée de tenant');
  }
}

interface FakeSweepRepository {
  readonly repository: ReminderSweepRepository;
  /** Les portées effectivement ouvertes, dans l'ordre — la preuve du scoping. */
  readonly scopes: string[];
  /** Les plafonds demandés page après page. */
  readonly pages: number[];
}

function fakeSweepRepository(
  tenantIds: readonly string[],
  seeded: readonly DueReminder[],
): FakeSweepRepository {
  const scopes: string[] = [];
  const pages: number[] = [];

  const repository = {
    listTenantIds: (): Promise<readonly string[]> => Promise.resolve(tenantIds),

    findDueAppointments: (
      window: { readonly from: Date; readonly to: Date },
      limit: number,
    ): Promise<readonly Omit<DueReminder, 'tenantId'>[]> => {
      const tenantId = getTenantId();

      if (tenantId === undefined) {
        throw new OutOfScopeError();
      }

      scopes.push(tenantId);
      pages.push(limit);

      const rows = seeded
        .filter((reminder) => reminder.tenantId === tenantId)
        .filter(
          (reminder) => reminder.startsAt >= window.from && reminder.startsAt < window.to,
        )
        .slice(0, limit)
        .map(({ tenantId: _ignored, ...rest }) => rest);

      return Promise.resolve(rows);
    },
  } as unknown as ReminderSweepRepository;

  return { repository, scopes, pages };
}

function build(tenantIds: readonly string[], seeded: readonly DueReminder[]) {
  const fake = fakeSweepRepository(tenantIds, seeded);
  const { logger, entries } = recordingLogger();
  const service = new ReminderSweepService(fake.repository, new TenantContextService(), logger);

  return { service, entries, ...fake };
}

describe('ReminderSweepService — la sélection', () => {
  it('ouvre une portée par établissement, et lit chacun dans la sienne', async () => {
    const { service, scopes } = build(
      ['tenant-a', 'tenant-b'],
      [due(), due({ tenantId: 'tenant-b', appointmentId: 'appointment-2' })],
    );

    const result = await service.sweep(NOW);

    // La preuve du scoping : deux portées, distinctes, une par salon. L'ordre
    // dans lequel elles s'ouvrent dépend de la rotation du départ (#514) et se
    // vérifie dans la suite qui lui est consacrée, pas ici.
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes)).toEqual(new Set(['tenant-a', 'tenant-b']));
    expect(result.tenantCount).toBe(2);
    expect(result.appointmentCount).toBe(2);
  });

  it('rattache chaque enveloppe à l’établissement dont la portée l’a produite', async () => {
    const { service } = build(
      ['tenant-a', 'tenant-b'],
      [
        due({ hasSms: false }),
        due({ tenantId: 'tenant-b', appointmentId: 'appointment-2', hasSms: false }),
      ],
    );

    const { messages } = await service.sweep(NOW);

    expect(messages).toHaveLength(2);
    // Un rattachement, pas un ordre : c'est le couple salon/rendez-vous qui est
    // en cause, et la rotation du départ (#514) rend l'ordre indifférent.
    expect(new Map(messages.map((message) => [message.tenantId, message.appointmentId]))).toEqual(
      new Map([
        ['tenant-a', 'appointment-1'],
        ['tenant-b', 'appointment-2'],
      ]),
    );
  });

  it('ne retient que ce qui tombe dans la fenêtre du balayage', async () => {
    const { service } = build(
      ['tenant-a'],
      [
        due({ appointmentId: 'trop-tot', startsAt: startsAt(12 * 3_600_000) }),
        due({ appointmentId: 'dans-la-fenetre' }),
        due({ appointmentId: 'trop-tard', startsAt: startsAt(3 * REMINDER_LEAD_MS) }),
      ],
    );

    const { messages, appointmentCount } = await service.sweep(NOW);

    expect(appointmentCount).toBe(1);
    expect(new Set(messages.map((message) => message.appointmentId))).toEqual(
      new Set(['dans-la-fenetre']),
    );
  });
});

describe('ReminderSweepService — les enveloppes', () => {
  it('compose une enveloppe par canal joignable, avec la clé de livraison canonique', async () => {
    const { service } = build(['tenant-a'], [due()]);

    const { messages } = await service.sweep(NOW);

    expect(messages.map((message) => message.channel)).toEqual(['EMAIL', 'SMS']);
    expect(messages.map((message) => message.dedupeKey)).toEqual([
      appointmentDedupeKey('appointment-1', 'REMINDER_24H', 'EMAIL'),
      appointmentDedupeKey('appointment-1', 'REMINDER_24H', 'SMS'),
    ]);
    expect(messages.every((message) => message.type === 'REMINDER_24H')).toBe(true);
    expect(messages.every((message) => message.recipientUserId === 'client-1')).toBe(true);
  });

  it('deux balayages du même rendez-vous composent les mêmes clés — c’est ce qui rend le rejeu inoffensif', async () => {
    const { service } = build(['tenant-a'], [due()]);

    const first = await service.sweep(NOW);
    const second = await service.sweep(NOW);

    expect(second.messages.map((message) => message.dedupeKey)).toEqual(
      first.messages.map((message) => message.dedupeKey),
    );
  });

  it('republie le canal qui manque quand un rappel vivant n’en couvre qu’un', async () => {
    // Le cas d'un lot SQS partiellement refusé : l'e-mail est parti, le SMS
    // n'a jamais été publié, et la Lambda rejoue le balayage. Une exclusion au
    // rendez-vous aurait perdu le SMS pour de bon — la fenêtre suivante ne
    // couvre plus ce rendez-vous.
    const { service } = build(['tenant-a'], [due({ liveChannels: ['EMAIL'] })]);

    const { messages } = await service.sweep(NOW);

    expect(messages.map((message) => message.channel)).toEqual(['SMS']);
  });

  it('n’émet rien quand un rappel vivant couvre déjà tous les canaux', async () => {
    const { service, entries } = build(
      ['tenant-a'],
      [due({ liveChannels: ['EMAIL', 'SMS'] })],
    );

    const { messages } = await service.sweep(NOW);

    expect(messages).toEqual([]);
    // Un rendez-vous déjà couvert n'est pas un rendez-vous injoignable : rien
    // ne doit ressembler à une anomalie dans le journal.
    expect(entries.some((entry) => entry.level === 'warn')).toBe(false);
  });

  it('n’émet pas de SMS quand le numéro n’est pas composable', async () => {
    const { service } = build(['tenant-a'], [due({ hasSms: false })]);

    const { messages } = await service.sweep(NOW);

    expect(messages.map((message) => message.channel)).toEqual(['EMAIL']);
  });

  it('porte l’échéance voulue : le début du rendez-vous moins 24 heures', async () => {
    const start = startsAt(REMINDER_LEAD_MS + 15 * 60_000);
    const { service } = build(['tenant-a'], [due({ startsAt: start, hasSms: false })]);

    const { messages } = await service.sweep(NOW);

    expect(messages[0]?.scheduledFor?.getTime()).toBe(start.getTime() - REMINDER_LEAD_MS);
  });

  it('signale, sans rien émettre, un rendez-vous dû dont personne n’est joignable', async () => {
    const { service, entries } = build(
      ['tenant-a'],
      [due({ hasEmail: false, hasSms: false })],
    );

    const { messages, appointmentCount } = await service.sweep(NOW);

    expect(messages).toEqual([]);
    // Le rendez-vous a bien été retenu : c'est l'absence de canal qu'on veut
    // voir dans le journal, pas une sélection qui l'aurait ignoré.
    expect(appointmentCount).toBe(1);
    expect(entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});

describe('ReminderSweepService — le plafond', () => {
  it('s’arrête au plafond et le dit', async () => {
    const seeded = Array.from({ length: 5 }, (_unused, index) =>
      due({ appointmentId: `appointment-${index}`, hasSms: false }),
    );
    const { service } = build(['tenant-a', 'tenant-b'], seeded);

    const result = await service.sweep(NOW, 3);

    expect(result.appointmentCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('ne se déclare pas tronqué quand tout est passé', async () => {
    const { service } = build(['tenant-a'], [due({ hasSms: false })]);

    const result = await service.sweep(NOW, 10);

    expect(result.truncated).toBe(false);
  });

  it('répartit le budget restant d’un établissement au suivant', async () => {
    const { service, pages } = build(
      ['tenant-a', 'tenant-b'],
      [due({ hasSms: false }), due({ tenantId: 'tenant-b', appointmentId: 'appointment-2' })],
    );

    await service.sweep(NOW, 10);

    // Le second salon ne peut plus prendre que ce que le premier a laissé. Une
    // ligne de plus est demandée à chaque fois : c'est la sonde qui distingue
    // « le budget est exactement rempli » de « il en restait ».
    expect(pages).toEqual([11, 10]);
  });

  it('ne se déclare pas tronqué quand le budget est exactement consommé', async () => {
    // Le faux positif que la sonde supprime : trois rendez-vous dus, un budget
    // de trois, et rien derrière. Le déclarer tronqué ferait sonner l'alarme
    // `SweepTruncated` toutes les heures sur un balayage complet.
    const seeded = Array.from({ length: 3 }, (_unused, index) =>
      due({ appointmentId: `appointment-${index}`, hasSms: false }),
    );
    const { service } = build(['tenant-a'], seeded);

    const result = await service.sweep(NOW, 3);

    expect(result.appointmentCount).toBe(3);
    expect(result.truncated).toBe(false);
  });
});

describe('sweepStartOffset — la rotation du départ', () => {
  it('avance d’un établissement par fenêtre horaire', () => {
    const first = sweepStartOffset(NOW, 3);
    const next = sweepStartOffset(new Date(NOW.getTime() + REMINDER_WINDOW_MS), 3);

    expect(next).toBe((first + 1) % 3);
  });

  it('revient à son point de départ après un tour complet', () => {
    const first = sweepStartOffset(NOW, 3);
    const afterFullTurn = sweepStartOffset(new Date(NOW.getTime() + 3 * REMINDER_WINDOW_MS), 3);

    expect(afterFullTurn).toBe(first);
  });

  it('ne bouge pas dans la même fenêtre — un balayage rejoué reste identique', () => {
    // C'est ce qui préserve l'innocuité du rejeu : la Lambda peut réappeler la
    // route dans l'heure, elle retrouve les mêmes salons et les mêmes clés.
    const replayed = new Date(NOW.getTime() + REMINDER_WINDOW_MS / 2);

    expect(sweepStartOffset(replayed, 3)).toBe(sweepStartOffset(NOW, 3));
  });

  it('reste dans les bornes du tableau, y compris avant l’époque', () => {
    // `%` garde le signe du dividende en JavaScript : sans le repli, un instant
    // antérieur à 1970 rendrait un décalage négatif, donc une rotation qui
    // sortirait du tableau et un balayage qui ne visiterait plus personne.
    const offset = sweepStartOffset(new Date('1965-01-01T00:00:00.000Z'), 7);

    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(7);
  });

  it('ne tourne pas quand il n’y a aucun établissement', () => {
    expect(sweepStartOffset(NOW, 0)).toBe(0);
  });
});

describe('ReminderSweepService — la famine du plafond ne se répète pas (#514)', () => {
  /** Trois salons, dont le premier dépasse à lui seul le plafond du balayage. */
  const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'];

  /** Le plafond de ces balayages — deux rendez-vous, que `tenant-a` déborde. */
  const BUDGET = 2;

  /**
   * Le balayage de la `hour`-ième heure après `NOW`, sur un jeu où `tenant-a`
   * déborde à lui seul le plafond et où les deux autres ont un rappel dû.
   *
   * C'est le cas de l'issue : un import de planning chez un salon, et un budget
   * global consommé dans un ordre stable.
   *
   * Le jeu est **repositionné dans la fenêtre de l'heure balayée**, et il le faut
   * : chaque balayage a sa propre fenêtre `[now+24h, now+25h)`, et des rendez-vous
   * figés autour de `NOW` sortiraient de la fenêtre dès le deuxième balayage —
   * lequel ne verrait plus rien, et la rotation ne se prouverait pas.
   */
  async function sweepHour(hour: number): Promise<ReminderSweepResult> {
    const at = new Date(NOW.getTime() + hour * REMINDER_WINDOW_MS);
    const start = new Date(at.getTime() + REMINDER_LEAD_MS + REMINDER_WINDOW_MS / 2);

    const { service } = build(TENANTS, [
      ...Array.from({ length: 5 }, (_unused, index) =>
        due({ appointmentId: `glouton-${hour}-${index}`, startsAt: start, hasSms: false }),
      ),
      due({
        tenantId: 'tenant-b',
        appointmentId: `appointment-b-${hour}`,
        startsAt: start,
        hasSms: false,
      }),
      due({
        tenantId: 'tenant-c',
        appointmentId: `appointment-c-${hour}`,
        startsAt: start,
        hasSms: false,
      }),
    ]);

    return service.sweep(at, BUDGET);
  }

  /** Les établissements qui ont réellement obtenu un rappel. */
  function served(result: ReminderSweepResult): Set<string> {
    return new Set(result.messages.map((message) => message.tenantId));
  }

  it('deux balayages successifs ne servent pas les mêmes établissements', async () => {
    const first = await sweepHour(0);
    const second = await sweepHour(1);

    // Le plafond tronque toujours — c'est son rôle, et le jeu le dépasse.
    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
    // Ce qui change, c'est qui en fait les frais.
    expect(served(second)).not.toEqual(served(first));
  });

  it('sur un tour complet, aucun établissement n’est privé de bout en bout', async () => {
    const swept = new Set<string>();

    for (let hour = 0; hour < TENANTS.length; hour += 1) {
      // Des heures successives, donc en séquence : les paralléliser leur ferait
      // perdre l'ordre qui est précisément l'objet de l'assertion.
      const result = await sweepHour(hour);

      for (const message of result.messages) {
        swept.add(message.tenantId);
      }
    }

    // Avant #514, le glouton vidait le budget à chaque balayage et l'ordre `id
    // asc` ne bougeait pas : cet ensemble se serait réduit à `tenant-a` seul,
    // quel que soit le nombre de balayages.
    expect(swept).toEqual(new Set(TENANTS));
  });
});
