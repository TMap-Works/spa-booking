import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { IdentityRepository, TenantTimeZoneRecord } from '../identity.repository';
import { TenantTimeZoneAudit } from '../tenant-timezone.audit';

/**
 * Le relevé de démarrage des fuseaux d'établissement (#604).
 *
 * Trois propriétés, et ce sont exactement celles qu'un incident ferait regretter
 * de ne pas avoir tenues :
 *
 * 1. un fuseau que le moteur résout ne déclenche **rien** — un signalement qui
 *    crie à chaque démarrage n'est plus lu, et le jour où une vraie ligne
 *    fautive apparaît, personne ne la distingue ;
 * 2. un fuseau que le moteur ne résout pas est relevé et **nommé** — un
 *    avertissement qui dit « un établissement est mal réglé » sans dire lequel
 *    n'avance à rien sur dix-neuf salons ;
 * 3. sa présence **ne fait pas lever**. C'est la propriété qui rend ce contrôle
 *    acceptable au démarrage : un établissement mal configuré ne doit pas
 *    empêcher les autres d'être servis.
 *
 * Le prédicat n'est pas testé ici — c'est `isValidTimeZone` de `@spa/shared`,
 * celui-là même qu'applique `@IsIanaTimeZone()` depuis #603, et il a sa propre
 * suite. Ce qui est testé, c'est ce que le relevé en fait.
 */

const TENANT_VALIDE: TenantTimeZoneRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Salon des Lilas',
  timezone: 'Europe/Paris',
};

const TENANT_FAUTIF: TenantTimeZoneRecord = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Spa du Baobab',
  timezone: 'Pas/UnFuseau',
};

/**
 * Un fuseau que `Intl.supportedValuesOf('timeZone')` ne liste pas et que l'ICU
 * résout pourtant. Il est ici pour une raison précise : c'est le faux positif
 * qu'un relevé écrit contre la liste canonique produirait, et il vaut mieux
 * qu'une suite le refuse une fois pour toutes qu'un opérateur découvre en
 * production qu'on lui signale `UTC` comme fuseau inconnu.
 */
const TENANT_LIEN_TZDATA: TenantTimeZoneRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Institut UTC',
  timezone: 'UTC',
};

interface LigneJournal {
  message: unknown;
  params: unknown[];
}

/** Journal qui retient ce qu'on lui écrit, au lieu de l'émettre. */
class JournalEnregistreur {
  public readonly warns: LigneJournal[] = [];
  public readonly debugs: LigneJournal[] = [];

  public warn(message: unknown, ...params: unknown[]): void {
    this.warns.push({ message, params });
  }

  public debug(message: unknown, ...params: unknown[]): void {
    this.debugs.push({ message, params });
  }

  public error(): void {
    // Le relevé n'écrit jamais en `error` : une base injoignable au démarrage
    // est prévue par conception, et un fuseau fautif est un réglage, pas un
    // incident d'instance. La méthode existe pour que le double satisfasse le
    // type, et son appel serait un défaut.
    throw new Error('le relevé de fuseaux ne doit rien écrire en error');
  }

  /** Les objets de contexte fusionnés d'une ligne — la convention de `splitLogParams`. */
  public static meta(ligne: LigneJournal): Record<string, unknown> {
    let meta: Record<string, unknown> = {};
    for (const param of ligne.params) {
      if (param !== null && typeof param === 'object' && !Array.isArray(param)) {
        meta = { ...meta, ...(param as Record<string, unknown>) };
      }
    }
    return meta;
  }
}

/** Un dépôt qui rend la liste donnée — la seule méthode que le relevé appelle. */
function depotRendant(tenants: TenantTimeZoneRecord[]): IdentityRepository {
  return {
    listTenantTimeZones: async (): Promise<TenantTimeZoneRecord[]> => tenants,
  } as unknown as IdentityRepository;
}

function monter(tenants: TenantTimeZoneRecord[]): {
  audit: TenantTimeZoneAudit;
  journal: JournalEnregistreur;
} {
  const journal = new JournalEnregistreur();
  const audit = new TenantTimeZoneAudit(
    depotRendant(tenants),
    journal as unknown as StructuredLogger,
  );
  return { audit, journal };
}

describe('TenantTimeZoneAudit', () => {
  it('ne signale rien quand tous les fuseaux se résolvent', async () => {
    const { audit, journal } = monter([TENANT_VALIDE, TENANT_LIEN_TZDATA]);

    await expect(audit.audit()).resolves.toEqual([]);

    expect(journal.warns).toHaveLength(0);
    // La trace de passage reste, en `debug` : sans elle, « rien dans le journal »
    // et « le contrôle n'a pas tourné » seraient indiscernables.
    expect(journal.debugs).toHaveLength(1);
    expect(String(journal.debugs[0]?.message)).toContain('2 établissement(s)');
  });

  it('relève le fuseau inconnu et nomme l’établissement concerné', async () => {
    const { audit, journal } = monter([TENANT_VALIDE, TENANT_FAUTIF]);

    await expect(audit.audit()).resolves.toEqual([TENANT_FAUTIF]);

    // Une ligne, pour le seul établissement fautif : le salon correctement réglé
    // n'a pas à apparaître dans un avertissement.
    expect(journal.warns).toHaveLength(1);
    const ligne = journal.warns[0];
    expect(ligne).toBeDefined();
    expect(JournalEnregistreur.meta(ligne as LigneJournal)).toEqual({
      tenantId: TENANT_FAUTIF.id,
      tenantName: TENANT_FAUTIF.name,
      timezone: TENANT_FAUTIF.timezone,
    });
  });

  it('journalise une ligne par établissement fautif', async () => {
    const autre: TenantTimeZoneRecord = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Barbier du Port',
      timezone: 'Europe/Pariss',
    };
    const { audit, journal } = monter([TENANT_FAUTIF, TENANT_VALIDE, autre]);

    await expect(audit.audit()).resolves.toEqual([TENANT_FAUTIF, autre]);
    expect(journal.warns).toHaveLength(2);
    expect(
      journal.warns.map((ligne) => JournalEnregistreur.meta(ligne).tenantName),
    ).toEqual([TENANT_FAUTIF.name, autre.name]);
  });

  it('n’écrit dans le journal que l’identifiant, le nom et le fuseau', async () => {
    const { audit, journal } = monter([TENANT_FAUTIF]);

    await audit.audit();

    // Le contrôle est de forme, pas de contenu : c'est l'ajout d'une clé de plus
    // qu'on refuse ici, parce qu'une clé de plus est le chemin par lequel un
    // contact client entrerait dans un journal (CDC §5.1). La projection du
    // dépôt le borne déjà ; cette assertion est la seconde barrière.
    expect(Object.keys(JournalEnregistreur.meta(journal.warns[0] as LigneJournal)).sort()).toEqual([
      'tenantId',
      'tenantName',
      'timezone',
    ]);
  });

  it('ne lève pas — ni sur un fuseau fautif, ni au démarrage', async () => {
    const { audit } = monter([TENANT_FAUTIF]);

    await expect(audit.audit()).resolves.toHaveLength(1);
    // Le démarrage n'attend pas le relevé : `onApplicationBootstrap` rend la
    // main sans rien lever, et la promesse qu'il lâche ne peut pas rejeter.
    expect(() => {
      audit.onApplicationBootstrap();
    }).not.toThrow();
  });

  it('laisse le relevé finir avant que l’arrêt ne ferme la connexion', async () => {
    // Sans cette attente, `PrismaService.onModuleDestroy` couperait la requête
    // en vol — une suite d'intégration qui ferme son application, un conteneur
    // qui reçoit SIGTERM peu après son démarrage — et le relevé signalerait une
    // base injoignable là où il n'y a qu'un arrêt en cours.
    let libere: (() => void) | undefined;
    const journal = new JournalEnregistreur();
    const depot = {
      listTenantTimeZones: async (): Promise<TenantTimeZoneRecord[]> => {
        await new Promise<void>((resolve) => {
          libere = resolve;
        });
        return [TENANT_FAUTIF];
      },
    } as unknown as IdentityRepository;
    const audit = new TenantTimeZoneAudit(depot, journal as unknown as StructuredLogger);

    audit.onApplicationBootstrap();
    // Le démarrage, lui, n'a rien attendu : la requête est toujours en vol.
    expect(journal.warns).toHaveLength(0);

    const arret = audit.onApplicationShutdown();
    libere?.();
    await arret;

    expect(journal.warns).toHaveLength(1);
  });

  it('s’arrête sans rien attendre quand aucun relevé n’est en vol', async () => {
    const { audit } = monter([TENANT_VALIDE]);

    await expect(audit.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('ne lève pas non plus quand la base est injoignable', async () => {
    const journal = new JournalEnregistreur();
    const depot = {
      listTenantTimeZones: async (): Promise<TenantTimeZoneRecord[]> => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
      },
    } as unknown as IdentityRepository;
    const audit = new TenantTimeZoneAudit(depot, journal as unknown as StructuredLogger);

    // Le conteneur démarre alors même que Postgres n'est pas encore là —
    // `PrismaService` ne se connecte volontairement pas à l'initialisation pour
    // cette raison exacte, et ce relevé ne doit pas la reprendre à son compte.
    await expect(audit.audit()).resolves.toEqual([]);
    expect(journal.warns).toHaveLength(1);
    expect(String(journal.warns[0]?.message)).toContain('impossible');
  });
});
