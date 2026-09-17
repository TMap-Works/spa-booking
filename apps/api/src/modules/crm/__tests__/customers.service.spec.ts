import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { CustomerEmailTakenError } from '../crm.errors';
import { CustomersService } from '../customers.service';
import { FakeCrmRepository } from './crm.doubles';

/**
 * Le fichier client, éprouvé sans HTTP ni base (api-module §2).
 *
 * Trois propriétés se vérifient ici, et nulle part ailleurs aussi vite :
 *
 * 1. **une fiche hors portée est introuvable, pas refusée** — le service ne
 *    compare aucun tenant, il traduit un `null` en 404. C'est la différence
 *    entre un 404 et le 403 qui confirmerait l'existence (tenant-isolation §4) ;
 * 2. **un compte du personnel n'est pas une fiche cliente** — le filtre de rôle
 *    du dépôt le rend invisible aux six routes, sans qu'aucun `if` ne l'écrive ;
 * 3. **aucune donnée personnelle ne sort par un canal d'erreur** — les messages
 *    et les `details` des erreurs de ce module ne portent ni nom, ni adresse, ni
 *    numéro.
 */

const TENANT = randomUUID();
const VOISIN = randomUUID();

/** Exécute dans la portée d'un établissement — ce que fait `JwtAuthGuard` en vrai. */
async function chez<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, run);
}

function build(): { service: CustomersService; repository: FakeCrmRepository } {
  const repository = new FakeCrmRepository();
  return { service: new CustomersService(repository.asRepository()), repository };
}

describe('lecture d’une fiche', () => {
  it('rend la fiche de l’établissement courant, note interne comprise', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Alice',
      lastName: 'Durand',
      internalNote: 'allergique au monoï',
    });

    const lue = await chez(TENANT, () => service.byId(fiche.id));

    expect({ id: lue.id, note: lue.internalNote }).toEqual({
      id: fiche.id,
      note: 'allergique au monoï',
    });
  });

  it('rend 404 — et non 403 — pour la fiche d’un autre établissement', async () => {
    const { service, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT });

    await expect(chez(VOISIN, () => service.byId(chezA.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rend le même 404 pour un identifiant qui n’existe nulle part', async () => {
    const { service } = build();

    // Indiscernable du cas précédent : c'est exactement ce qu'on veut. Une
    // différence de réponse servirait de sonde d'existence.
    await expect(chez(VOISIN, () => service.byId(randomUUID()))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rend 404 sur un compte du personnel — le fichier client n’est pas le trombinoscope', async () => {
    const { service, repository } = build();
    const praticienne = repository.addCustomer({ tenantId: TENANT, role: 'STAFF' });

    await expect(chez(TENANT, () => service.byId(praticienne.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('création d’une fiche', () => {
  it('canonise l’adresse et élague les coordonnées', async () => {
    const { service, repository } = build();

    const creee = await chez(TENANT, () =>
      service.create({
        email: '  Alice@Example.TEST ',
        firstName: '  Alice ',
        lastName: ' Durand  ',
        phone: '  +261 34 12 345 67 ',
        internalNote: '   ',
      }),
    );

    expect({
      email: creee.email,
      firstName: creee.firstName,
      lastName: creee.lastName,
      phone: creee.phone,
      // Une note réduite à des espaces vaut « aucune note » : deux
      // représentations d'une même absence finiraient par se comparer mal.
      note: creee.internalNote,
    }).toEqual({
      email: 'alice@example.test',
      firstName: 'Alice',
      lastName: 'Durand',
      // Plus seulement élagué : **normalisé** en E.164 (#824). Les séparateurs
      // d'un numéro dicté au comptoir ne portent aucune information, et les
      // garder faisait de `+261 34 12 345 67` et de `+261341234567` deux clés
      // de recherche pour un seul destinataire.
      phone: '+261341234567',
      note: null,
    });

    expect(repository.customers[0]?.tenantId).toBe(TENANT);
  });

  it('refuse une adresse déjà prise dans cet établissement, sans la recopier', async () => {
    const { service, repository } = build();
    repository.addCustomer({ tenantId: TENANT, email: 'alice@example.test' });

    const erreur = await chez(TENANT, () =>
      service
        .create({
          email: 'ALICE@example.test',
          firstName: 'Alice',
          lastName: 'Durand',
          phone: null,
          internalNote: null,
        })
        .catch((caught: unknown) => caught),
    );

    expect(erreur).toBeInstanceOf(CustomerEmailTakenError);
    // Cinquième critère de #56 : aucune donnée personnelle ne repart par le
    // corps d'erreur, d'où elle gagnerait un journal d'accès ou un ticket.
    const serialise = JSON.stringify({
      message: (erreur as CustomerEmailTakenError).message,
      details: (erreur as CustomerEmailTakenError).details,
    });
    expect(serialise).not.toContain('alice@example.test');
  });

  it('laisse la même adresse cohabiter dans deux établissements', async () => {
    const { service } = build();

    const chezA = await chez(TENANT, () =>
      service.create({
        email: 'alice@example.test',
        firstName: 'Alice',
        lastName: 'Durand',
        phone: null,
        internalNote: null,
      }),
    );
    const chezB = await chez(VOISIN, () =>
      service.create({
        email: 'alice@example.test',
        firstName: 'Alice',
        lastName: 'Durand',
        phone: null,
        internalNote: null,
      }),
    );

    // L'unicité est **par tenant** : une même personne peut être cliente de deux
    // salons sans que l'un puisse deviner l'existence de l'autre.
    expect(chezA.id).not.toBe(chezB.id);
  });
});

/**
 * Le téléphone en E.164 — #824.
 *
 * La fiche cliente est la porte la plus exposée au numéro **national** : le
 * front-desk recopie ce qu'une cliente dicte, et personne ne dicte son
 * indicatif pays. Ce qui se vérifie ici est que le service lise le pays de
 * l'établissement — le sien, pas celui du voisin — et refuse plutôt que de
 * deviner quand il n'y en a pas.
 */
describe('téléphone en E.164 — #824', () => {
  it('complète un national avec le pays de l’établissement, à la création', async () => {
    const { service, repository } = build();
    repository.tenantCountryCodes.set(TENANT, 'MG');

    const creee = await chez(TENANT, () =>
      service.create({
        email: 'camille@example.test',
        firstName: 'Camille',
        lastName: 'Rakoto',
        phone: '034 12 345 67',
        internalNote: null,
      }),
    );

    expect(creee.phone).toBe('+261341234567');
    expect(repository.customers[0]?.phone).toBe('+261341234567');
  });

  it('complète un national à la modification, et rend la forme écrite', async () => {
    const { service, repository } = build();
    repository.tenantCountryCodes.set(TENANT, 'FR');
    const fiche = repository.addCustomer({ tenantId: TENANT, phone: null });

    const modifiee = await chez(TENANT, () =>
      service.update(fiche.id, { phone: '06 12 34 56 78' }),
    );

    expect(modifiee.phone).toBe('+33612345678');
    expect(repository.customers[0]?.phone).toBe('+33612345678');
  });

  it('lit le pays de **son** établissement, pas celui du voisin', async () => {
    const { service, repository } = build();
    repository.tenantCountryCodes.set(TENANT, 'FR');
    repository.tenantCountryCodes.set(VOISIN, 'MG');
    const fiche = repository.addCustomer({ tenantId: TENANT, phone: null });

    const modifiee = await chez(TENANT, () =>
      service.update(fiche.id, { phone: '06 12 34 56 78' }),
    );

    // `+261…` ici serait une lecture sortie de la portée — le même défaut
    // qu'une fuite inter-tenant, sur un champ qui n'en a pas l'air.
    expect(modifiee.phone).toBe('+33612345678');
  });

  it('refuse un numéro invalide en 400 nommant le champ, sans rien écrire', async () => {
    const { service, repository } = build();
    repository.tenantCountryCodes.set(TENANT, 'FR');
    const fiche = repository.addCustomer({ tenantId: TENANT, phone: null });

    // Une saisie choisie pour n'être le fragment d'aucun exemple du message :
    // sans quoi l'assertion de non-recopie ci-dessous serait vraie par accident.
    const erreur = await chez(TENANT, () =>
      service.update(fiche.id, { phone: '07 77 77' }).catch((caught: unknown) => caught),
    );

    expect(erreur).toBeInstanceOf(BadRequestException);
    const reponse = (erreur as BadRequestException).getResponse() as { message: unknown };
    expect(reponse.message).toEqual([expect.stringMatching(/^phone : /)]);
    expect(repository.customers[0]?.phone).toBeNull();

    // Cinquième critère de #56 : le corps d'erreur ne recopie pas la saisie.
    // Un message de validation finit dans les journaux du front, où un numéro
    // de téléphone n'a rien à faire.
    expect(JSON.stringify(reponse)).not.toContain('07 77 77');
  });

  it('refuse un national quand l’établissement n’a pas de pays', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, phone: null });

    const erreur = await chez(TENANT, () =>
      service.update(fiche.id, { phone: '06 12 34 56 78' }).catch((caught: unknown) => caught),
    );

    expect(erreur).toBeInstanceOf(BadRequestException);
  });

  it('efface toujours sur `null`, et ne lit alors aucun pays', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, phone: '+261341234567' });

    const modifiee = await chez(TENANT, () => service.update(fiche.id, { phone: null }));

    expect(modifiee.phone).toBeNull();
  });
});

describe('modification d’une fiche', () => {
  it('n’écrit que les champs présents', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Alice',
      lastName: 'Durand',
      phone: '+261 34 12 345 67',
      internalNote: 'allergique au monoï',
    });

    const modifiee = await chez(TENANT, () => service.update(fiche.id, { lastName: ' Martin ' }));

    expect({
      firstName: modifiee.firstName,
      lastName: modifiee.lastName,
      phone: modifiee.phone,
      note: modifiee.internalNote,
    }).toEqual({
      firstName: 'Alice',
      lastName: 'Martin',
      phone: '+261 34 12 345 67',
      note: 'allergique au monoï',
    });
  });

  it('efface le numéro et la note sur `null`', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({
      tenantId: TENANT,
      phone: '+261 34 12 345 67',
      internalNote: 'allergique au monoï',
    });

    const modifiee = await chez(TENANT, () =>
      service.update(fiche.id, { phone: null, internalNote: null }),
    );

    expect({ phone: modifiee.phone, note: modifiee.internalNote }).toEqual({
      phone: null,
      note: null,
    });
  });

  it('répond 200 sur une modification qui ne change rien', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, lastName: 'Durand' });

    // Le dépôt rendrait `false` si le service ne relisait pas d'abord : c'est ce
    // qui distingue « inconnue ici » d'une non-modification.
    await expect(chez(TENANT, () => service.update(fiche.id, { lastName: 'Durand' }))).resolves
      .toMatchObject({ lastName: 'Durand' });
  });

  it('refuse d’écrire sur la fiche d’un autre établissement, et n’écrit rien', async () => {
    const { service, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT, lastName: 'Durand' });

    await expect(
      chez(VOISIN, () => service.update(chezA.id, { lastName: 'Piraté' })),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Pas 4 du protocole : le refus ne suffit pas, encore faut-il que rien n'ait
    // été écrit avant que le 404 ne parte.
    expect(repository.customers[0]?.lastName).toBe('Durand');
  });
});

describe('désactivation d’une fiche', () => {
  it('bascule l’état sans rien supprimer', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    const desactivee = await chez(TENANT, () => service.setActive(fiche.id, false));

    expect(desactivee.isActive).toBe(false);
    expect(repository.customers).toHaveLength(1);
  });

  it('est idempotente et rend l’état demandé', async () => {
    const { service, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, isActive: false });

    await expect(chez(TENANT, () => service.setActive(fiche.id, false))).resolves.toMatchObject({
      isActive: false,
    });
  });

  it('refuse la fiche d’un autre établissement, et la laisse active', async () => {
    const { service, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT });

    await expect(chez(VOISIN, () => service.setActive(chezA.id, false))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(repository.customers[0]?.isActive).toBe(true);
  });
});

describe('recherche', () => {
  /** Cinq fiches, dont une chez le voisin et une désactivée. */
  function seed(repository: FakeCrmRepository): void {
    repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Alice',
      lastName: 'Durand',
      email: 'alice@example.test',
      phone: '+261341234567',
    });
    repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Bruno',
      lastName: 'Duval',
      email: 'bruno@example.test',
      phone: '+261349999999',
    });
    repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Chloé',
      lastName: 'Martin',
      email: 'chloe@example.test',
      phone: null,
    });
    repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Dorian',
      lastName: 'Ancien',
      email: 'dorian@example.test',
      isActive: false,
    });
    repository.addCustomer({
      tenantId: VOISIN,
      firstName: 'Alice',
      lastName: 'Durand',
      email: 'alice@voisin.test',
    });
  }

  // `ownedByUserId: null` — « tout le fichier », le périmètre d'un rang gérant.
  // Il est **obligatoire** dans la signature depuis #812 : un défaut à `null`
  // aurait fait retomber sur le fichier entier toute surface qui oublierait de
  // se prononcer, c'est-à-dire ouvert en silence ce que ce ticket ferme.
  const QUERY = { includeInactive: false, page: 1, pageSize: 20, ownedByUserId: null };

  it('ne rend que les fiches actives de l’établissement courant', async () => {
    const { service, repository } = build();
    seed(repository);

    const page = await chez(TENANT, () => service.search(QUERY));

    expect(page.items.map((item) => item.lastName)).toEqual(['Durand', 'Duval', 'Martin']);
    expect({ totalItems: page.totalItems, totalPages: page.totalPages }).toEqual({
      totalItems: 3,
      totalPages: 1,
    });
  });

  it('ouvre les fiches désactivées sur demande explicite', async () => {
    const { service, repository } = build();
    seed(repository);

    const page = await chez(TENANT, () => service.search({ ...QUERY, includeInactive: true }));

    expect(page.totalItems).toBe(4);
  });

  it('cherche par préfixe de nom, insensible à la casse', async () => {
    const { service, repository } = build();
    seed(repository);

    const page = await chez(TENANT, () => service.search({ ...QUERY, q: 'DU' }));

    expect(page.items.map((item) => item.lastName)).toEqual(['Durand', 'Duval']);
  });

  it('cherche par adresse e-mail et par numéro du même terme', async () => {
    const { service, repository } = build();
    seed(repository);

    const parEmail = await chez(TENANT, () => service.search({ ...QUERY, q: 'chloe@' }));
    const parNumero = await chez(TENANT, () => service.search({ ...QUERY, q: '+26134123' }));

    expect(parEmail.items.map((item) => item.firstName)).toEqual(['Chloé']);
    expect(parNumero.items.map((item) => item.firstName)).toEqual(['Alice']);
  });

  it('traite une recherche vide comme une absence de recherche', async () => {
    const { service, repository } = build();
    seed(repository);

    // `'   '` ne doit pas devenir le préfixe `''`, vrai de toutes les lignes et
    // payé d'un balayage complet pour rendre ce que rend l'absence de terme.
    const page = await chez(TENANT, () => service.search({ ...QUERY, q: '   ' }));

    expect(page.totalItems).toBe(3);
  });

  it('ne laisse voir aucune fiche du voisin, même sur le même nom', async () => {
    const { service, repository } = build();
    seed(repository);
    const chezVoisin = repository.customers.find((row) => row.tenantId === VOISIN);

    const page = await chez(TENANT, () => service.search({ ...QUERY, q: 'durand' }));

    expect(JSON.stringify(page)).not.toContain(chezVoisin?.id ?? 'sentinelle');
    expect(JSON.stringify(page)).not.toContain('alice@voisin.test');
  });

  it('pagine, et rend « page 1 sur 0 » sur un fichier vide', async () => {
    const { service, repository } = build();
    seed(repository);

    const page2 = await chez(TENANT, () => service.search({ ...QUERY, page: 2, pageSize: 2 }));
    expect(page2.items.map((item) => item.lastName)).toEqual(['Martin']);
    expect(page2.totalPages).toBe(2);

    const vide = await chez(TENANT, () => service.search({ ...QUERY, q: 'zzz' }));
    expect({ items: vide.items.length, totalPages: vide.totalPages }).toEqual({
      items: 0,
      totalPages: 0,
    });
  });

  it('n’expose jamais la note interne dans une liste', async () => {
    const { service, repository } = build();
    repository.addCustomer({ tenantId: TENANT, internalNote: 'allergique au monoï' });

    const page = await chez(TENANT, () => service.search(QUERY));

    expect(JSON.stringify(page)).not.toContain('monoï');
  });
});

describe('portée du praticien — « ses clientes, et elles seules » (#812)', () => {
  /*
   * Le quatrième critère de #812 : `GET /v1/customers` ne rend au praticien que
   * les clientes de ses rendez-vous.
   *
   * Ce que ces cas protègent est la **portée**, pas l'accès : `PermissionsGuard`
   * a déjà laissé entrer — le fichier client s'ouvre avec `customers:read:own`
   * comme avec `customers:read:all` — et c'est le critère de recherche qui décide
   * de ce qui revient. Le refus n'est donc pas un 403 mais une liste plus courte,
   * et un 404 sur la fiche qu'on n'a pas le droit de lire : là où l'appelant
   * connaît déjà l'existence d'un rendez-vous, il ne connaît pas celle d'une
   * fiche, et un refus distinct aurait fait de cette route un oracle qui énumère
   * la clientèle du salon (capture 3 du ticket).
   */

  const CLAIRE = randomUUID();
  const COLLEGUE = randomUUID();

  const PORTEE_GERANTE = { includeInactive: false, page: 1, pageSize: 20, ownedByUserId: null };

  function seedDeuxPraticiennes(repository: FakeCrmRepository): {
    readonly aMoi: string;
    readonly aLaCollegue: string;
  } {
    const aMoi = repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Camille',
      lastName: 'Bernard',
      email: 'camille@example.test',
    });
    const aLaCollegue = repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Ines',
      lastName: 'Bertrand',
      email: 'ines@example.test',
    });

    repository.addVisit({ tenantId: TENANT, clientId: aMoi.id, staffUserId: CLAIRE });
    repository.addVisit({ tenantId: TENANT, clientId: aLaCollegue.id, staffUserId: COLLEGUE });

    return { aMoi: aMoi.id, aLaCollegue: aLaCollegue.id };
  }

  it('ne rend que les clientes de ses propres rendez-vous', async () => {
    const { service, repository } = build();
    seedDeuxPraticiennes(repository);

    const page = await chez(TENANT, () =>
      service.search({ ...PORTEE_GERANTE, ownedByUserId: CLAIRE }),
    );

    expect(page.items.map((item) => item.firstName)).toEqual(['Camille']);
    expect(page.totalItems).toBe(1);
  });

  it('rend le fichier entier quand la portée est celle de la gérante', async () => {
    const { service, repository } = build();
    seedDeuxPraticiennes(repository);

    const page = await chez(TENANT, () => service.search(PORTEE_GERANTE));

    expect(page.items.map((item) => item.firstName)).toEqual(['Camille', 'Ines']);
  });

  it('garde une cliente dont le rendez-vous a été annulé — elle reste la sienne', async () => {
    const { service, repository } = build();
    const desistee = repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Nour',
      lastName: 'Aubry',
      email: 'nour@example.test',
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: desistee.id,
      staffUserId: CLAIRE,
      status: 'CANCELLED',
    });

    const page = await chez(TENANT, () =>
      service.search({ ...PORTEE_GERANTE, ownedByUserId: CLAIRE }),
    );

    // Le praticien qui la rappelle pour reproposer un créneau a besoin de son
    // numéro : restreindre aux visites honorées aurait fait disparaître la fiche
    // le jour où elle devient la plus utile.
    expect(page.items.map((item) => item.firstName)).toEqual(['Nour']);
  });

  it('rend une page vide à un compte sans clientèle, plutôt que le fichier', async () => {
    const { service, repository } = build();
    seedDeuxPraticiennes(repository);

    const page = await chez(TENANT, () =>
      service.search({ ...PORTEE_GERANTE, ownedByUserId: randomUUID() }),
    );

    // Le défaut fail-open aurait été de traiter « aucune ligne rattachée » comme
    // « aucune restriction ».
    expect({ items: page.items.length, totalItems: page.totalItems }).toEqual({
      items: 0,
      totalItems: 0,
    });
  });

  it('ouvre la fiche d’une de ses clientes', async () => {
    const { service, repository } = build();
    const { aMoi } = seedDeuxPraticiennes(repository);

    const fiche = await chez(TENANT, () => service.byId(aMoi, CLAIRE));

    expect(fiche.firstName).toBe('Camille');
  });

  it('rend « introuvable » sur la fiche d’une cliente qui n’est pas la sienne', async () => {
    const { service, repository } = build();
    const { aLaCollegue } = seedDeuxPraticiennes(repository);

    await expect(chez(TENANT, () => service.byId(aLaCollegue, CLAIRE))).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('portée de tenant', () => {
  it('refuse toute opération hors portée — défaut fermé', async () => {
    const { service } = build();

    // Le vrai dépôt lève de même : l'extension de scoping ne retombe jamais sur
    // « toutes les données » quand aucun tenant n'est résolu.
    await expect(
      service.search({ includeInactive: false, page: 1, pageSize: 20, ownedByUserId: null }),
    ).rejects.toThrow(/portée de tenant/);
  });
});
