import { myStaffAppointmentClientSchema, myStaffAppointmentSchema } from '../index';

/**
 * Contrat de l'espace du praticien connecté — la cliente d'une ligne de planning
 * (#813, repris par #1404).
 *
 * Ce fichier ne couvre pas l'agenda entier : la fenêtre, les instants UTC et
 * l'offset par ligne sont tenus par `apps/api` (`my-staff.service.spec.ts`,
 * `appointments-me.integration-spec.ts`), qui les produit. Ce qui se vérifie ici
 * est ce dont le contrat est seul juge, et ce que #1404 a déplacé :
 *
 * 1. **ce que le bloc `client` porte**, maintenant qu'il n'abrège plus le nom ;
 * 2. **ce qu'il refuse encore** — la liste étant `.strict()`, un champ de plus
 *    n'entre pas par inadvertance, et c'est la seule forme de minimisation qui
 *    résiste au temps ;
 * 3. **`null` et non l'absence** sur les deux champs facultatifs. Un front qui
 *    distingue « clé absente » de « valeur vide » finit par afficher `undefined`
 *    là où il voulait écrire « Pas de numéro ».
 */

const CLIENTE = {
  id: '3f1c4d5e-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  firstName: 'Bruno',
  lastName: 'Nguyen',
  phone: '+33 6 00 00 00 02',
  internalNote: 'Allergie aux huiles essentielles d’agrumes.',
};

describe('myStaffAppointmentClientSchema', () => {
  it('porte le nom entier, le numéro, l’alerte de la fiche et de quoi l’ouvrir', () => {
    expect(myStaffAppointmentClientSchema.parse(CLIENTE)).toEqual(CLIENTE);
  });

  it('accepte `null` sur le numéro et sur l’alerte — une fiche peut n’en avoir aucun', () => {
    const parsed = myStaffAppointmentClientSchema.parse({
      ...CLIENTE,
      phone: null,
      internalNote: null,
    });

    expect(parsed.phone).toBeNull();
    expect(parsed.internalNote).toBeNull();
  });

  it('refuse l’absence des deux champs : l’API émet toujours la clé', () => {
    const refused = myStaffAppointmentClientSchema.safeParse({
      id: CLIENTE.id,
      firstName: CLIENTE.firstName,
      lastName: CLIENTE.lastName,
    });

    expect(refused.success).toBe(false);
  });

  /*
   * Le numéro garde l'écriture du salon — espaces compris. `storedPhoneSchema` et
   * non `phoneSchema` : c'est une sortie, et un plancher de chiffres posé depuis
   * ferait échouer la lecture d'un planning entier sur une ligne historique.
   */
  it('ne normalise pas le numéro : la forme lisible est celle qu’on relit', () => {
    expect(myStaffAppointmentClientSchema.parse(CLIENTE).phone).toBe('+33 6 00 00 00 02');
  });

  /*
   * La vraie minimisation est celle-ci, et elle survit à l'abandon de l'initiale :
   * l'adresse, la langue, l'état de délivrabilité et l'historique restent sur la
   * fiche, et un champ de plus ne traverse pas la frontière par accident.
   */
  it('refuse un champ que le contrat ne déclare pas — `.strict()`', () => {
    const refused = myStaffAppointmentClientSchema.safeParse({
      ...CLIENTE,
      email: 'bruno@example.test',
    });

    expect(refused.success).toBe(false);
  });
});

describe('myStaffAppointmentSchema', () => {
  const RENDEZ_VOUS = {
    id: '8a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    reference: 'RDV-SQMG-36',
    status: 'CONFIRMED',
    startsAt: '2026-09-23T08:05:00.000Z',
    endsAt: '2026-09-23T09:05:00.000Z',
    utcOffsetMinutes: 120,
    service: {
      id: '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      name: 'Massage suédois',
      durationMinutes: 60,
    },
    client: CLIENTE,
  };

  it('imbrique la cliente enrichie, et garde les deux notes distinctes', () => {
    const parsed = myStaffAppointmentSchema.parse({
      ...RENDEZ_VOUS,
      clientNote: 'Préfère une pression légère.',
      staffNote: 'Prévoir la cabine du fond.',
    });

    // L'alerte vaut pour la **personne** et survit à tous ses rendez-vous ; la
    // note interne est celle de **ce** rendez-vous. Les confondre ferait afficher
    // une consigne de cabine comme une contre-indication.
    expect(parsed.client.internalNote).toBe('Allergie aux huiles essentielles d’agrumes.');
    expect(parsed.staffNote).toBe('Prévoir la cabine du fond.');
  });

  it('accepte une ligne sans aucune note — les deux restent facultatives', () => {
    const parsed = myStaffAppointmentSchema.parse(RENDEZ_VOUS);

    expect(parsed.clientNote).toBeUndefined();
    expect(parsed.staffNote).toBeUndefined();
  });
});
