import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { CustomerHasUpcomingAppointmentsError } from '../crm.errors';
import { CustomerExportService } from '../customer-export.service';
import { CustomersService, anonymizedEmail } from '../customers.service';
import { FakeCrmRepository } from './crm.doubles';

/**
 * Les droits des personnes sur leurs données — #81, CDC §5.1, éprouvés sans
 * HTTP ni base (api-module §2).
 *
 * Ce que cette suite verrouille, et que ni l'intégration ni l'isolation ne
 * verrouillent aussi précisément :
 *
 * 1. **l'export est complet** — il porte les textes libres que l'historique
 *    écarte délibérément, et il n'est borné par aucune fenêtre. Un export
 *    tronqué a l'apparence d'une réponse à l'art. 15 sans en être une ;
 * 2. **l'anonymisation efface vraiment** — la fiche *et* les textes libres de
 *    ses rendez-vous. Un geste qui ne toucherait que `users` laisserait dans une
 *    note de rendez-vous exactement ce qu'il devait effacer ;
 * 3. **elle ne casse pas la comptabilité** — la ligne survit, ses rendez-vous
 *    aussi, avec leurs montants et leurs statuts. C'est le deuxième critère du
 *    ticket, et c'est ce qui distingue l'anonymisation d'une suppression ;
 * 4. **le consentement se date quand il change, et seulement alors** — la date
 *    est la preuve exigée par l'art. 7.1, et une preuve qui se réécrit à chaque
 *    enregistrement de formulaire ne prouve plus rien.
 */

const TENANT = randomUUID();
const VOISIN = randomUUID();

/** Exécute dans la portée d'un établissement — ce que fait `JwtAuthGuard` en vrai. */
async function chez<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, run);
}

function build(): {
  customers: CustomersService;
  dataExport: CustomerExportService;
  repository: FakeCrmRepository;
} {
  const repository = new FakeCrmRepository();
  return {
    customers: new CustomersService(repository.asRepository()),
    dataExport: new CustomerExportService(repository.asRepository()),
    repository,
  };
}

/** Un instant franchement passé — un rendez-vous qui n'occupe plus l'agenda. */
const PASSE = new Date('2026-01-15T09:00:00.000Z');
/** Un instant franchement futur — un rendez-vous qui l'occupe encore. */
const FUTUR = new Date('2099-01-15T09:00:00.000Z');

describe('export des données personnelles', () => {
  it('rend l’identité, les consentements, la note interne et tous les rendez-vous', async () => {
    const { dataExport, repository } = build();
    const fiche = repository.addCustomer({
      tenantId: TENANT,
      firstName: 'Alice',
      lastName: 'Durand',
      email: 'alice@example.test',
      phone: '+261341234567',
      internalNote: 'allergique au monoï',
      marketingConsent: true,
      marketingConsentAt: new Date('2026-09-01T08:00:00.000Z'),
    });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: PASSE,
      clientNote: 'plutôt en fin de journée',
      staffNote: 'habite au-dessus de la pharmacie',
    });

    const dossier = await chez(TENANT, () => dataExport.byCustomerId(fiche.id));

    expect({
      nom: dossier.identity.lastName,
      note: dossier.internalNote,
      consentement: dossier.consents.marketing,
      visites: dossier.appointments.length,
    }).toEqual({ nom: 'Durand', note: 'allergique au monoï', consentement: true, visites: 1 });

    // Les deux textes libres du rendez-vous : ce sont eux que l'historique
    // n'expose pas, et eux que le droit d'accès impose de restituer.
    expect({
      cliente: dossier.appointments[0]?.clientNote,
      salon: dossier.appointments[0]?.staffNote,
    }).toEqual({
      cliente: 'plutôt en fin de journée',
      salon: 'habite au-dessus de la pharmacie',
    });
  });

  it('n’est borné par aucune fenêtre, contrairement à l’historique', async () => {
    const { dataExport, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    // Au-delà des cinquante visites que `GET /customers/:id/history` montre au
    // plus : un export tronqué à la même fenêtre serait incomplet en silence.
    for (let index = 0; index < 60; index += 1) {
      repository.addVisit({
        tenantId: TENANT,
        clientId: fiche.id,
        startsAt: new Date(PASSE.getTime() + index * 86_400_000),
      });
    }

    const dossier = await chez(TENANT, () => dataExport.byCustomerId(fiche.id));

    expect(dossier.appointments).toHaveLength(60);
  });

  it('ordonne les rendez-vous du plus ancien au plus récent — un dossier se lit dans ce sens', async () => {
    const { dataExport, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    const recent = repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: new Date('2026-08-01T09:00:00.000Z'),
    });
    const ancien = repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: new Date('2026-02-01T09:00:00.000Z'),
    });

    const dossier = await chez(TENANT, () => dataExport.byCustomerId(fiche.id));

    expect(dossier.appointments.map((visite) => visite.id)).toEqual([ancien.id, recent.id]);
  });

  it('date le dossier — un export sans instant ne dit pas de quand il est', async () => {
    const { dataExport, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    const avant = Date.now();

    const dossier = await chez(TENANT, () => dataExport.byCustomerId(fiche.id));

    expect(dossier.generatedAt.getTime()).toBeGreaterThanOrEqual(avant);
  });

  it('rend 404 pour la fiche d’un autre établissement, et le même pour un inconnu', async () => {
    const { dataExport, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT });

    // Sans la relecture qui produit ce refus, l'export d'un identifiant inconnu
    // rendrait un document bien formé et vide en 200 — un document qui a
    // l'apparence d'une réponse au titre de l'art. 15 sans en être une.
    await expect(chez(VOISIN, () => dataExport.byCustomerId(chezA.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(chez(VOISIN, () => dataExport.byCustomerId(randomUUID()))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('ne lit aucun rendez-vous quand la fiche est introuvable — minimisation', async () => {
    const { dataExport, repository } = build();
    const lecture = jest.spyOn(repository, 'allAppointmentsForExport');

    await expect(chez(TENANT, () => dataExport.byCustomerId(randomUUID()))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Paralléliser les deux lectures aurait fait lire les données personnelles
    // d'un identifiant qu'on s'apprête à déclarer introuvable (CDC §5.1).
    expect(lecture).not.toHaveBeenCalled();
  });

  it('exporte une fiche anonymisée — c’est encore une réponse à « que reste-t-il de moi ? »', async () => {
    const { customers, dataExport, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, internalNote: 'à effacer' });

    await chez(TENANT, () => customers.anonymize(fiche.id));
    const dossier = await chez(TENANT, () => dataExport.byCustomerId(fiche.id));

    expect({
      email: dossier.identity.email,
      note: dossier.internalNote,
      anonymisee: dossier.identity.anonymizedAt !== null,
    }).toEqual({ email: anonymizedEmail(fiche.id), note: null, anonymisee: true });
  });
});

describe('anonymisation d’une fiche', () => {
  it('remplace l’identité, vide les coordonnées et désactive la fiche', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({
      tenantId: TENANT,
      email: 'alice@example.test',
      phone: '+261341234567',
      internalNote: 'allergique au monoï',
      marketingConsent: true,
      marketingConsentAt: new Date('2026-09-01T08:00:00.000Z'),
      passwordHash: 'une-empreinte',
    });

    const anonymisee = await chez(TENANT, () => customers.anonymize(fiche.id));

    expect({
      email: anonymisee.email,
      phone: anonymisee.phone,
      note: anonymisee.internalNote,
      active: anonymisee.isActive,
      consentement: anonymisee.marketingConsent,
      dateConsentement: anonymisee.marketingConsentAt,
      anonymisee: anonymisee.anonymizedAt !== null,
    }).toEqual({
      email: anonymizedEmail(fiche.id),
      phone: null,
      note: null,
      active: false,
      consentement: false,
      dateConsentement: null,
      anonymisee: true,
    });

    // L'empreinte de mot de passe part avec le reste : une identité anonymisée
    // ne doit plus ouvrir de session.
    expect(repository.customers.find((row) => row.id === fiche.id)?.passwordHash).toBeNull();
    // Plus aucune trace de l'ancienne adresse dans la ligne.
    expect(JSON.stringify(anonymisee)).not.toContain('alice@example.test');
  });

  it('vide les textes libres des rendez-vous — la moitié du droit à l’oubli', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    const visite = repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: PASSE,
      status: 'CANCELLED',
      clientNote: 'plutôt en fin de journée',
      staffNote: 'habite au-dessus de la pharmacie',
      cancellationReason: 'a déménagé rue des Lilas',
    });

    await chez(TENANT, () => customers.anonymize(fiche.id));

    const relue = repository.visits.find((row) => row.id === visite.id);
    expect({
      cliente: relue?.clientNote,
      salon: relue?.staffNote,
      motif: relue?.cancellationReason,
    }).toEqual({ cliente: null, salon: null, motif: null });
  });

  it('ne touche ni aux montants, ni aux statuts, ni aux dates — l’intégrité comptable', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    const visite = repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: PASSE,
      status: 'COMPLETED',
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    });

    await chez(TENANT, () => customers.anonymize(fiche.id));

    const relue = repository.visits.find((row) => row.id === visite.id);
    expect({
      statut: relue?.status,
      montant: relue?.priceAmountMinor,
      devise: relue?.priceCurrency,
      debut: relue?.startsAt,
    }).toEqual({ statut: 'COMPLETED', montant: 3500, devise: 'EUR', debut: PASSE });
    // La ligne `users` survit : c'est elle que la clé étrangère `Restrict` de
    // `appointments.client_id` exige, et sans elle la vente passée disparaîtrait.
    expect(repository.customers.some((row) => row.id === fiche.id)).toBe(true);
  });

  it('est idempotente — une seconde demande ne réattribue rien', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });

    const premiere = await chez(TENANT, () => customers.anonymize(fiche.id));
    const seconde = await chez(TENANT, () => customers.anonymize(fiche.id));

    expect(seconde.anonymizedAt).toEqual(premiere.anonymizedAt);
    expect(seconde.email).toBe(premiere.email);
  });

  it('refuse tant qu’un rendez-vous à venir occupe l’agenda, en disant combien', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: FUTUR,
      status: 'CONFIRMED',
    });

    // Le RGPD n'impose pas d'effacer tant que le traitement reste nécessaire à
    // l'exécution du contrat (art. 17.1.b) — et un rendez-vous de jeudi est ce
    // contrat. Le refus est temporaire : honorer, ou annuler.
    const refus = await chez(TENANT, () => customers.anonymize(fiche.id)).catch(
      (error: unknown) => error,
    );

    expect(refus).toBeInstanceOf(CustomerHasUpcomingAppointmentsError);
    expect((refus as CustomerHasUpcomingAppointmentsError).details).toEqual({
      upcomingAppointments: 1,
    });
    // Rien n'a été écrit : la fiche est intacte.
    expect(repository.customers.find((row) => row.id === fiche.id)?.anonymizedAt).toBeNull();
  });

  it('ne compte ni les rendez-vous passés, ni les annulés', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    repository.addVisit({ tenantId: TENANT, clientId: fiche.id, startsAt: PASSE, status: 'PENDING' });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: FUTUR,
      status: 'CANCELLED',
    });

    // Un `PENDING` du passé n'engage plus personne, et un rendez-vous annulé
    // n'occupe plus l'agenda : ni l'un ni l'autre ne retient l'effacement.
    await expect(chez(TENANT, () => customers.anonymize(fiche.id))).resolves.toMatchObject({
      isActive: false,
    });
  });

  it('retient le rendez-vous **commencé et non terminé** — le contrat est en cours', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT });
    // Commencé il y a dix minutes, terminé dans cinquante : la cliente est dans
    // le fauteuil. Une borne posée sur `starts_at` l'aurait laissée anonymiser,
    // et aurait effacé au passage les notes du rendez-vous en cours.
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: new Date(Date.now() - 10 * 60_000),
      status: 'CONFIRMED',
      staffNote: 'gel de massage sans parfum',
    });

    const refus = await chez(TENANT, () => customers.anonymize(fiche.id)).catch(
      (error: unknown) => error,
    );

    expect(refus).toBeInstanceOf(CustomerHasUpcomingAppointmentsError);
    expect(repository.visits[0]?.staffNote).toBe('gel de massage sans parfum');
  });

  it('ne laisse rien derrière elle quand elle refuse — le refus n’écrit pas', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, internalNote: 'allergique au monoï' });
    repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: PASSE,
      status: 'COMPLETED',
      staffNote: 'habite au-dessus de la pharmacie',
    });
    const aVenir = repository.addVisit({
      tenantId: TENANT,
      clientId: fiche.id,
      startsAt: FUTUR,
      status: 'CONFIRMED',
      clientNote: 'plutôt en fin de journée',
    });

    await expect(chez(TENANT, () => customers.anonymize(fiche.id))).rejects.toBeInstanceOf(
      CustomerHasUpcomingAppointmentsError,
    );

    // Le vrai dépôt écrit **avant** de compter — c'est ce qui rend le compte
    // fiable sous concurrence — et laisse la transaction annuler l'écriture. La
    // propriété observable est la même des deux côtés : rien n'a bougé.
    const relue = repository.customers.find((row) => row.id === fiche.id);
    expect({ note: relue?.internalNote, anonymisee: relue?.anonymizedAt }).toEqual({
      note: 'allergique au monoï',
      anonymisee: null,
    });
    expect(repository.visits.find((row) => row.id === aVenir.id)?.clientNote).toBe(
      'plutôt en fin de journée',
    );
  });

  it('rend 404 sur la fiche d’un autre établissement, sans rien y écrire', async () => {
    const { customers, repository } = build();
    const chezA = repository.addCustomer({ tenantId: TENANT, internalNote: 'note du salon A' });

    await expect(chez(VOISIN, () => customers.anonymize(chezA.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const relue = repository.customers.find((row) => row.id === chezA.id);
    expect({ note: relue?.internalNote, anonymisee: relue?.anonymizedAt }).toEqual({
      note: 'note du salon A',
      anonymisee: null,
    });
  });

  it('rend 404 sur un compte du personnel — il n’est pas au fichier client', async () => {
    const { customers, repository } = build();
    const praticienne = repository.addCustomer({ tenantId: TENANT, role: 'STAFF' });

    await expect(chez(TENANT, () => customers.anonymize(praticienne.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('donne un pseudonyme distinct à chaque fiche — l’unicité de l’adresse tient', async () => {
    const { customers, repository } = build();
    const une = repository.addCustomer({ tenantId: TENANT, email: 'une@example.test' });
    const autre = repository.addCustomer({ tenantId: TENANT, email: 'autre@example.test' });

    const premiere = await chez(TENANT, () => customers.anonymize(une.id));
    const seconde = await chez(TENANT, () => customers.anonymize(autre.id));

    // Un pseudonyme constant aurait fait échouer la deuxième anonymisation du
    // salon sur `@@unique([tenantId, email])`.
    expect(premiere.email).not.toBe(seconde.email);
  });
});

describe('consentement au démarchage', () => {
  it('vaut refus non daté quand personne n’a posé la question', async () => {
    const { customers } = build();

    const creee = await chez(TENANT, () =>
      customers.create({
        email: 'alice@example.test',
        firstName: 'Alice',
        lastName: 'Durand',
        phone: null,
        internalNote: null,
      }),
    );

    // « Jamais demandé » n'est pas « refusé le 6 septembre » : seule la seconde
    // se démontre, et c'est pourquoi la date reste nulle.
    expect({ consentement: creee.marketingConsent, date: creee.marketingConsentAt }).toEqual({
      consentement: false,
      date: null,
    });
  });

  it('date la réponse dès que quelqu’un se prononce, même pour un refus', async () => {
    const { customers } = build();

    const creee = await chez(TENANT, () =>
      customers.create({
        email: 'alice@example.test',
        firstName: 'Alice',
        lastName: 'Durand',
        phone: null,
        internalNote: null,
        marketingConsent: false,
      }),
    );

    expect({ consentement: creee.marketingConsent, datee: creee.marketingConsentAt !== null }).toEqual(
      { consentement: false, datee: true },
    );
  });

  it('écrit et date le changement de consentement', async () => {
    const { customers, repository } = build();
    const fiche = repository.addCustomer({ tenantId: TENANT, marketingConsent: false });

    const modifiee = await chez(TENANT, () =>
      customers.update(fiche.id, { marketingConsent: true }),
    );

    expect({ consentement: modifiee.marketingConsent, datee: modifiee.marketingConsentAt !== null }).toEqual(
      { consentement: true, datee: true },
    );
  });

  it('ne décale pas la date quand la valeur renvoyée est celle en place', async () => {
    const { customers, repository } = build();
    const recueilli = new Date('2026-09-01T08:00:00.000Z');
    const fiche = repository.addCustomer({
      tenantId: TENANT,
      marketingConsent: true,
      marketingConsentAt: recueilli,
    });

    // Un `PATCH` qui corrige un numéro en recopiant le formulaire entier ne doit
    // pas réécrire la preuve : elle répond à « depuis quand », pas à « quand
    // a-t-on enregistré pour la dernière fois ».
    const modifiee = await chez(TENANT, () =>
      customers.update(fiche.id, { phone: '+261341234567', marketingConsent: true }),
    );

    expect(modifiee.marketingConsentAt).toEqual(recueilli);
  });
});
