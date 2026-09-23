/**
 * Réservation invitée — coordonnées, normalisation E.164, réponse du tunnel (#45).
 *
 * Les deux premiers critères d'acceptation de l'issue se vérifient ici et nulle
 * part ailleurs : le formulaire du front n'a pas de règle propre, il applique ce
 * schéma. Une régression de ce fichier est une régression du formulaire.
 */

import { normalizeToE164 } from '../common/identifiers';
import {
  bookGuestAppointmentRequestSchema,
  bookedAppointmentSchema,
  createAppointmentRequestSchema,
  guestContactSchema,
} from '../schemas/appointment';

describe('normalizeToE164', () => {
  it.each([
    ['+261341234567', '+261341234567'],
    ['+261 34 12 345 67', '+261341234567'],
    ['+261-34-12-345-67', '+261341234567'],
    ['00261341234567', '+261341234567'],
    ['  +261 34 12 345 67  ', '+261341234567'],
  ])('normalise « %s »', (input, expected) => {
    expect(normalizeToE164(input)).toBe(expected);
  });

  it.each([
    // Numéro national : le pays manque, et le deviner enverrait le SMS ailleurs.
    ['0341234567'],
    ['341234567'],
    // Un indicatif ne commence pas par zéro.
    ['+0261341234567'],
    // Quinze chiffres significatifs au plus (UIT-T E.164).
    ['+2613412345678901'],
    // Une lettre n'est pas un chiffre, même dans un numéro « vanity ».
    ['+261 34 SPA 4567'],
    [''],
    ['+'],
  ])('refuse « %s »', (input) => {
    expect(normalizeToE164(input)).toBeNull();
  });
});

describe('guestContactSchema', () => {
  const contact = {
    firstName: '  Camille ',
    lastName: 'Rakoto',
    email: '  Camille@Example.TEST ',
    phone: '+261 34 12 345 67',
  };

  it('élague, canonise l’e-mail et normalise le téléphone', () => {
    expect(guestContactSchema.parse(contact)).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '+261341234567',
    });
  });

  it('accepte l’absence de téléphone — l’e-mail est le canal obligatoire', () => {
    const { phone: _phone, ...withoutPhone } = contact;

    expect(guestContactSchema.parse(withoutPhone)).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
    });
  });

  it('nomme le champ en défaut plutôt que de rendre un refus global', () => {
    const result = guestContactSchema.safeParse({ ...contact, phone: '0341234567' });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(['phone']);
  });

  it('refuse un prénom vide une fois élagué', () => {
    expect(guestContactSchema.safeParse({ ...contact, firstName: '   ' }).success).toBe(false);
  });

  /**
   * La borne de la partie locale, qui est celle de l'API et non celle de Zod (#314).
   *
   * `.email()` seul laisse passer une partie locale de trois cents caractères
   * pourvu que l'adresse entière tienne dans `EMAIL_MAX_LENGTH` ; `@IsEmail()`,
   * côté API, applique les 64 octets de la RFC 5321. Sans la borne, ce
   * formulaire annoncerait bonne une adresse que la réservation refuserait.
   */
  it.each([
    [64, true],
    [65, false],
  ])('borne la partie locale à 64 octets — %i caractères : %s', (length, accepted) => {
    const email = `${'a'.repeat(length)}@example.test`;

    expect(guestContactSchema.safeParse({ ...contact, email }).success).toBe(accepted);
  });

  /**
   * La borne de l'adresse entière, qui est celle de l'API et non la largeur de
   * la colonne (#314).
   *
   * `EMAIL_MAX_LENGTH` vaut 320 parce que `users.email` est un `VARCHAR(320)`,
   * mais `@IsEmail()` refuse au-delà des 254 octets de la RFC 5321 §4.5.3.1.3 :
   * c'est cette borne-là, la plus étroite, que le contrat doit porter. Le
   * domaine est découpé en labels de 47 caractères pour qu'aucun ne bute sur la
   * borne de 63 d'un label DNS — ce qui est éprouvé ici est la longueur totale.
   */
  it.each([
    [254, true],
    [255, false],
  ])('borne l’adresse entière à 254 octets — %i caractères : %s', (length, accepted) => {
    const domain = `${['b', 'c', 'd', 'e'].map((label) => label.repeat(47)).join('.')}.test`;
    const email = `${'a'.repeat(length - domain.length - 1)}@${domain}`;

    expect(email).toHaveLength(length);
    expect(guestContactSchema.safeParse({ ...contact, email }).success).toBe(accepted);
  });

  /**
   * Une adresse mal formée ne se refuse qu'**une** fois (#314).
   *
   * `.email()` et le motif de partie locale sont deux checks du même schéma :
   * sur une chaîne sans `@`, un motif qui exigerait le `@` échouerait avec le
   * premier et poserait deux `issues` de même message. Un formulaire qui rend
   * toutes les erreurs du champ afficherait alors « adresse e-mail invalide »
   * deux fois sous la même saisie.
   */
  it('ne pose qu’une erreur sur une adresse sans arobase', () => {
    const result = guestContactSchema.safeParse({ ...contact, email: 'camille' });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toHaveLength(1);
  });

  it('refuse un champ inconnu — un mot de passe n’a rien à faire ici', () => {
    expect(
      guestContactSchema.safeParse({ ...contact, password: 'motdepassetreslong' }).success,
    ).toBe(false);
  });
});

describe('bookGuestAppointmentRequestSchema', () => {
  const request = {
    serviceId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21',
    startsAt: '2026-09-01T11:00:00+02:00',
    client: {
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
    },
    // L'accord au traitement des données, obligatoire depuis #790.
    dataConsent: true,
  };

  it('normalise l’instant de début en UTC', () => {
    expect(bookGuestAppointmentRequestSchema.parse(request).startsAt).toBe(
      '2026-09-01T09:00:00.000Z',
    );
  });

  it('accepte l’omission de staffId — c’est « premier disponible »', () => {
    expect(bookGuestAppointmentRequestSchema.parse(request)).not.toHaveProperty('staffId');
  });

  it('refuse un clientId — le tunnel public ne réserve pas au nom d’un autre', () => {
    expect(
      bookGuestAppointmentRequestSchema.safeParse({
        ...request,
        clientId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22',
      }).success,
    ).toBe(false);
  });

  /**
   * Le champ qui désignait la cliente, et qui ne désigne plus personne (#1136).
   *
   * Réserver exige un compte depuis la décision produit du 22/09/2026 : la
   * cliente du rendez-vous est celle du jeton, et `client` est devenu facultatif
   * et sans effet. Les deux cas ci-dessous tiennent les deux moitiés de cette
   * phrase — il peut manquer, et il reste validé quand il est là, le temps que
   * le tunnel cesse de l'envoyer.
   */
  describe('les coordonnées, depuis que réserver exige un compte', () => {
    it('accepte une demande sans coordonnées — la cliente vient du jeton', () => {
      const { client: _sansCoordonnees, ...request2 } = request;

      expect(bookGuestAppointmentRequestSchema.safeParse(request2).success).toBe(true);
    });

    it('valide encore les coordonnées présentes, plutôt que de les laisser passer', () => {
      expect(
        bookGuestAppointmentRequestSchema.safeParse({
          ...request,
          client: { ...request.client, email: 'camille' },
        }).success,
      ).toBe(false);
    });
  });

  it('refuse une date-heure nue, dont le fuseau ne pourrait qu’être deviné', () => {
    expect(
      bookGuestAppointmentRequestSchema.safeParse({ ...request, startsAt: '2026-09-01T11:00:00' })
        .success,
    ).toBe(false);
  });

  /**
   * Le consentement, tenu **par le contrat** et non par le formulaire (#790).
   *
   * La case est bloquante à l'écran depuis #734, et une barrière qui ne tient
   * que dans le navigateur n'est pas une barrière : un appel direct à la route
   * publique la contournerait, et le salon garderait une fiche cliente sans
   * base légale pour l'avoir constituée (CDC §5.1).
   */
  describe('le consentement au traitement des données', () => {
    it('refuse une demande qui ne le porte pas', () => {
      const { dataConsent: _absent, ...sansConsentement } = request;

      expect(bookGuestAppointmentRequestSchema.safeParse(sansConsentement).success).toBe(false);
    });

    it('refuse un consentement refusé — `false` n’est pas un accord', () => {
      expect(
        bookGuestAppointmentRequestSchema.safeParse({ ...request, dataConsent: false }).success,
      ).toBe(false);
    });

    it('refuse une date envoyée par l’appelant — le serveur horodate seul', () => {
      // `.strict()` ferme la porte : une preuve dont l'horloge appartient à
      // celui qu'elle engage n'en est pas une (RGPD art. 7.1).
      expect(
        bookGuestAppointmentRequestSchema.safeParse({
          ...request,
          dataConsentAt: '2026-09-01T09:00:00.000Z',
        }).success,
      ).toBe(false);
    });
  });
});

/**
 * La séparation des deux formes de demande, **dans les deux sens** (#314).
 *
 * Le sens « invité » est exercé juste au-dessus. Celui-ci est l'autre moitié, et
 * il n'est pas symétrique par politesse : un `client` glissé dans une demande de
 * back-office ferait créer une fiche neuve là où le comptoir venait d'en
 * désigner une par `clientId` — deux fiches pour la même personne, et un
 * historique de visites coupé en deux. C'est le `.strict()` qui l'empêche, et
 * rien d'autre ne l'empêcherait.
 */
describe('createAppointmentRequestSchema — la forme de back-office', () => {
  const request = {
    serviceId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21',
    startsAt: '2026-09-01T11:00:00+02:00',
    clientId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22',
  };

  it('accepte un clientId — au comptoir, le staff réserve pour quelqu’un d’autre', () => {
    expect(createAppointmentRequestSchema.parse(request).clientId).toBe(request.clientId);
  });

  it('refuse un client — désigner une fiche et en décrire une neuve s’excluent', () => {
    expect(
      createAppointmentRequestSchema.safeParse({
        ...request,
        client: {
          firstName: 'Camille',
          lastName: 'Rakoto',
          email: 'camille@example.test',
        },
      }).success,
    ).toBe(false);
  });

  it('refuse le corps du tunnel public tel quel — les deux ne sont pas substituables', () => {
    const { clientId: _clientId, ...withoutClientId } = request;

    expect(
      createAppointmentRequestSchema.safeParse({
        ...withoutClientId,
        client: { firstName: 'Camille', lastName: 'Rakoto', email: 'camille@example.test' },
      }).success,
    ).toBe(false);
  });
});

describe('bookedAppointmentSchema', () => {
  const response = {
    id: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21',
    // La référence citable, requise depuis #796 : l'API l'émet sur toute
    // réponse de réservation, et c'est elle que l'écran de confirmation montre.
    reference: 'RDV-8F3K-27',
    status: 'PENDING',
    serviceId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b22',
    staffId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b23',
    clientId: '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b24',
    startsAt: '2026-09-01T09:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };

  it('ramène le statut du fil au vocabulaire du contrat', () => {
    expect(bookedAppointmentSchema.parse(response).status).toBe('pending');
  });

  it('ramène l’auteur d’annulation de la même façon', () => {
    const cancelled = bookedAppointmentSchema.parse({
      ...response,
      status: 'CANCELLED',
      cancelledAt: '2026-08-27T14:32:10.000Z',
      cancelledBy: 'CLIENT',
    });

    expect(cancelled.cancelledBy).toBe('client');
  });

  it('refuse un statut hors énumération plutôt que de le laisser passer', () => {
    expect(bookedAppointmentSchema.safeParse({ ...response, status: 'ARCHIVED' }).success).toBe(
      false,
    );
  });

  it('refuse un instant porteur d’offset — la sortie n’a qu’un référentiel', () => {
    expect(
      bookedAppointmentSchema.safeParse({ ...response, startsAt: '2026-09-01T11:00:00+02:00' })
        .success,
    ).toBe(false);
  });
});
