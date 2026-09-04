import { randomUUID } from 'node:crypto';

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
      phone: '+261 34 12 345 67',
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

  const QUERY = { includeInactive: false, page: 1, pageSize: 20 };

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

describe('portée de tenant', () => {
  it('refuse toute opération hors portée — défaut fermé', async () => {
    const { service } = build();

    // Le vrai dépôt lève de même : l'extension de scoping ne retombe jamais sur
    // « toutes les données » quand aucun tenant n'est résolu.
    await expect(service.search({ includeInactive: false, page: 1, pageSize: 20 })).rejects.toThrow(
      /portée de tenant/,
    );
  });
});
