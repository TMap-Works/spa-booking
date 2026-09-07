import { getTenantId } from '../../../common/tenant';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import type { DeliveryEventRepository } from '../delivery-event.repository';
import { DeliveryEventService } from '../delivery-event.service';
import type { EmailSuppressionReason } from '../notifications.types';
import { recordingLogger } from './notifications.doubles';

/**
 * L'ingestion des événements de remise — #73.
 *
 * Le classement lui-même est éprouvé par `delivery-event.spec.ts`, sur des
 * fonctions pures. Ce qui se prouve **ici**, et seulement ici :
 *
 * | Exigence | Pourquoi |
 * |---|---|
 * | une adresse morte est supprimée dans **tous** les établissements qui la connaissent | la réputation d'envoi est celle du domaine ; en oublier un le laisse dégrader celle de tous |
 * | chaque écriture se fait dans la portée de son établissement | une écriture hors portée, ou dans la mauvaise, supprimerait l'adresse d'un salon en croyant traiter celle d'un autre |
 * | un rebond transitoire n'écrit **rien** | c'est le troisième critère d'acceptation, et l'écrire coûterait à une cliente ses confirmations |
 * | un rejeu n'écrit rien de plus | SQS garantit au-moins-une-fois, et l'instant de suppression ne doit pas se réécrire |
 * | aucune adresse ne part au journal | notifications §7, et un journal de Lambda garde ce qu'on y met |
 *
 * ## Ce que le double refuse de faire
 *
 * Écrire hors portée de tenant. Il lit `getTenantId()` — le **vrai** contexte,
 * celui que l'extension Prisma consulterait — et lève sinon. Une ingestion qui
 * oublierait d'ouvrir la portée, ou qui l'ouvrirait une fois pour toutes sur le
 * premier salon, fait donc rougir cette suite plutôt que de passer.
 */

const SALON_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SALON_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SALON_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Une écriture telle que le double l'a reçue — avec la portée qui l'a portée. */
interface Write {
  readonly tenantId: string;
  readonly addresses: readonly string[];
  readonly reason: EmailSuppressionReason;
  readonly at: Date;
}

/**
 * Le dépôt d'ingestion, en mémoire.
 *
 * Il tient une table `(tenant, adresse) → supprimée ?` et y reproduit
 * l'idempotence de `suppressEmails` : une adresse déjà supprimée n'est pas
 * réécrite, et l'écriture rend `0`. C'est la propriété qui décide du verdict du
 * test de rejeu, et un double qui compterait naïvement ses appels ne l'aurait
 * pas vue.
 */
class FakeDeliveryEventRepository {
  public readonly writes: Write[] = [];

  /** `tenantId` → adresses connues de cet établissement, et leur état. */
  private readonly fiches = new Map<string, Map<string, boolean>>();

  public constructor(private readonly tenantIds: readonly string[]) {}

  /** Sème une fiche cliente vivante. */
  public seed(tenantId: string, email: string): void {
    const salon = this.fiches.get(tenantId) ?? new Map<string, boolean>();
    salon.set(email, false);
    this.fiches.set(tenantId, salon);
  }

  public isSuppressed(tenantId: string, email: string): boolean {
    return this.fiches.get(tenantId)?.get(email) === true;
  }

  public listTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.tenantIds);
  }

  public suppressEmails(
    addresses: readonly string[],
    reason: EmailSuppressionReason,
    at: Date,
  ): Promise<number> {
    const tenantId = getTenantId();

    if (tenantId === undefined) {
      throw new Error('suppressEmails appelé hors de toute portée de tenant');
    }

    this.writes.push({ tenantId, addresses, reason, at });

    const salon = this.fiches.get(tenantId);

    if (salon === undefined) {
      return Promise.resolve(0);
    }

    let count = 0;

    for (const address of addresses) {
      if (salon.get(address) === false) {
        salon.set(address, true);
        count += 1;
      }
    }

    return Promise.resolve(count);
  }
}

function hardBounce(...addresses: readonly string[]): Record<string, unknown> {
  return {
    eventType: 'Bounce',
    mail: { messageId: 'ses-0102' },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: addresses.map((emailAddress) => ({ emailAddress })),
    },
  };
}

describe('DeliveryEventService — l’ingestion des rebonds et des plaintes', () => {
  let repository: FakeDeliveryEventRepository;
  let logs: ReturnType<typeof recordingLogger>;
  let service: DeliveryEventService;

  const build = (tenantIds: readonly string[] = [SALON_A, SALON_B, SALON_C]): void => {
    repository = new FakeDeliveryEventRepository(tenantIds);
    logs = recordingLogger();
    service = new DeliveryEventService(
      repository as unknown as DeliveryEventRepository,
      new TenantContextService(),
      logs.logger,
    );
  };

  beforeEach(() => {
    build();
  });

  describe('un rebond permanent', () => {
    it('supprime l’adresse dans tous les établissements qui la connaissent', async () => {
      // La même personne est cliente de deux salons ; le troisième ne la connaît
      // pas. La réputation d'envoi est celle du domaine : en laisser un
      // continuer d'écrire dégraderait la délivrabilité des trois.
      repository.seed(SALON_A, 'morte@exemple.test');
      repository.seed(SALON_B, 'morte@exemple.test');

      const result = await service.ingest(hardBounce('morte@exemple.test'));

      expect(result).toMatchObject({
        outcome: 'suppress',
        eventType: 'BOUNCE',
        reason: 'HARD_BOUNCE',
        recipientCount: 1,
        tenantCount: 3,
        suppressed: 2,
      });
      expect(repository.isSuppressed(SALON_A, 'morte@exemple.test')).toBe(true);
      expect(repository.isSuppressed(SALON_B, 'morte@exemple.test')).toBe(true);
    });

    it('écrit dans la portée de chaque établissement, jamais hors portée', () => {
      // Le double lève si `getTenantId()` est vide : cette attente est donc
      // celle d'une ingestion qui ouvre bien une portée par salon.
      return service.ingest(hardBounce('morte@exemple.test')).then(() => {
        expect(repository.writes.map((write) => write.tenantId)).toEqual([
          SALON_A,
          SALON_B,
          SALON_C,
        ]);
      });
    });

    it('inscrit l’instant qu’on lui donne, et le même partout', async () => {
      // `now` est un paramètre et non `new Date()` pris au vol : c'est ce qui
      // rend l'instant observable, et ce qui garantit que deux salons datent la
      // même suppression du même instant.
      const at = new Date('2026-09-07T15:00:00.000Z');

      await service.ingest(hardBounce('morte@exemple.test'), at);

      expect(repository.writes.map((write) => write.at.toISOString())).toEqual([
        at.toISOString(),
        at.toISOString(),
        at.toISOString(),
      ]);
    });

    it('rend zéro quand l’adresse n’est connue de personne, sans que ce soit une anomalie', async () => {
      const result = await service.ingest(hardBounce('inconnue@exemple.test'));

      expect(result).toMatchObject({ outcome: 'suppress', suppressed: 0, tenantCount: 3 });
      expect(logs.entries.some((entry) => entry.level === 'error')).toBe(false);
    });

    it('ne réécrit rien au rejeu — SQS garantit au-moins-une-fois', async () => {
      repository.seed(SALON_A, 'morte@exemple.test');

      const first = await service.ingest(hardBounce('morte@exemple.test'));
      const replay = await service.ingest(hardBounce('morte@exemple.test'));

      expect(first.suppressed).toBe(1);
      // Zéro, et non un : l'instant de suppression est resté celui de la
      // première livraison, qui est celui où la boîte est réellement morte.
      expect(replay.suppressed).toBe(0);
    });

    it('supprime chaque adresse d’un rebond groupé', async () => {
      repository.seed(SALON_A, 'alice@exemple.test');
      repository.seed(SALON_A, 'bob@exemple.test');

      const result = await service.ingest(
        hardBounce('Alice@Exemple.test', 'bob@exemple.test', '"Alice" <alice@exemple.test>'),
      );

      // Deux adresses distinctes après normalisation et déduplication, pas trois.
      expect(result).toMatchObject({ recipientCount: 2, suppressed: 2 });
    });
  });

  describe('une plainte', () => {
    it('condamne l’adresse avec son propre motif', async () => {
      repository.seed(SALON_B, 'plainte@exemple.test');

      const result = await service.ingest({
        eventType: 'Complaint',
        mail: { messageId: 'ses-0203' },
        complaint: {
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'plainte@exemple.test' }],
        },
      });

      expect(result).toMatchObject({ outcome: 'suppress', reason: 'COMPLAINT', suppressed: 1 });
      expect(repository.writes[0]?.reason).toBe('COMPLAINT');
    });
  });

  describe('ce qui n’écrit rien', () => {
    it.each([
      ['un rebond transitoire', { eventType: 'Bounce', bounce: { bounceType: 'Transient' } }, 'transient'],
      ['un retard de livraison', { eventType: 'DeliveryDelay' }, 'transient'],
      ['un refus de SES', { eventType: 'Reject' }, 'ignored'],
      ['un échec de rendu', { eventType: 'Rendering Failure' }, 'ignored'],
      ['une remise réussie', { eventType: 'Delivery' }, 'ignored'],
    ])('%s ne touche aucune fiche', async (_label, payload, outcome) => {
      repository.seed(SALON_A, 'vivante@exemple.test');

      const result = await service.ingest(payload);

      expect(result).toMatchObject({ outcome, suppressed: 0, reason: null });
      // Pas même une visite : rien n'est à écrire, et le balayage des
      // établissements n'a donc pas lieu.
      expect(repository.writes).toEqual([]);
      expect(repository.isSuppressed(SALON_A, 'vivante@exemple.test')).toBe(false);
    });

    it('accepte une charge illisible sans lever', async () => {
      // Lever ferait rejouer le message jusqu'à la file d'attente morte, et
      // l'alarme de profondeur signalerait une panne là où il n'y a qu'un
      // message inattendu que rien ne réparera.
      const result = await service.ingest('ceci n’est pas un événement SES');

      expect(result).toMatchObject({ outcome: 'unreadable', eventType: null, suppressed: 0 });
    });
  });

  describe('le journal', () => {
    it('ne porte jamais d’adresse, quel que soit le verdict', async () => {
      repository.seed(SALON_A, 'morte@exemple.test');

      await service.ingest(hardBounce('morte@exemple.test'));
      await service.ingest({ eventType: 'Reject', mail: { messageId: 'ses-0304' } });
      await service.ingest({ eventType: 'Inconnu', victime: 'fuite@exemple.test' });

      const journal = JSON.stringify(logs.entries);

      expect(journal).not.toContain('morte@exemple.test');
      expect(journal).not.toContain('fuite@exemple.test');
      // L'accusé de SES, lui, est opaque et non personnel : c'est le seul
      // identifiant que notifications §7 autorise au journal.
      expect(journal).toContain('ses-0102');
    });
  });
});
