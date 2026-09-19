import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Paramétrage de l'établissement — adresse, horaires, coordonnées (#343).
 *
 * La suite exerce en HTTP, sur l'application réellement câblée par
 * `configureApp`, les deux routes que #343 ajoute au module `identity` :
 *
 * | Route | Rôle | Ce que la suite en prouve |
 * |---|---|---|
 * | `GET /tenant` | admin | on lit **son** établissement, jamais celui d'un autre |
 * | `PATCH /tenant` | admin | on écrit **son** établissement, et l'écriture ne déborde pas |
 *
 * ## Ce qu'un 404 ne peut pas prouver ici
 *
 * Le protocole habituel — rejouer la route avec le jeton du voisin et attendre
 * 404 — ne s'applique pas : **aucune de ces deux routes ne prend d'identifiant
 * d'établissement**. Il n'y a rien à désigner, donc rien à refuser. C'est une
 * propriété plus forte que le 404, et non plus faible : la seule façon d'écrire
 * un test de traversée serait d'ajouter un paramètre que le contrôleur n'a pas.
 *
 * Ce que la suite vérifie à la place est ce qui reste vérifiable, et qui est
 * exactement le risque :
 *
 * 1. **la lecture rend l'établissement du jeton**, pas le premier venu — deux
 *    jetons, deux réponses distinctes ;
 * 2. **l'écriture ne franchit pas la frontière** — le voisin enregistre, et les
 *    horaires comme l'adresse de l'appelant sont intacts. C'est le point le plus
 *    coûteux à rater : la part « horaires » d'`updateTenantSettings` commence par
 *    un `deleteMany({})` sans `where`, et c'est l'extension de scoping — pas
 *    l'appelant — qui y pose `tenant_id` ;
 * 3. **la vitrine publique du voisin ne montre pas l'adresse de l'appelant**,
 *    l'inverse du même risque, du côté non authentifié ;
 * 4. **le seuil de rôle tient** — sans jeton 401, au rang `MANAGER` 403.
 *
 * Le harnais substitue `IdentityRepository` par un double **qui filtre sur le
 * vrai contexte de tenant** (`getTenantId()`), celui-là même que consulte
 * l'extension Prisma. Un double qui tiendrait sa propre comptabilité ne
 * testerait que lui-même.
 */

const CHEMIN = '/api/v1/tenant';
const CHEMIN_PUBLIC = (slug: string): string => `/api/v1/public/${slug}`;

/** Une adresse et une semaine complètes — de quoi voir si quelque chose déborde. */
const REGLAGES = {
  address: {
    line1: '12 rue des Lilas',
    line2: 'Bâtiment B',
    postalCode: '75011',
    city: 'Paris',
    country: 'FR',
  },
  openingHours: [
    { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
    { weekday: 2, opensAt: '14:00', closesAt: '19:00' },
    { weekday: 6, opensAt: '10:00', closesAt: '24:00' },
  ],
};

describe('Réglages de l’établissement — #343', () => {
  let harness: TenantHarness;

  beforeEach(async () => {
    harness = await createTenantHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.server();

  describe('la lecture rend l’établissement du jeton', () => {
    it('rend le sien, et le voisin rend le sien', async () => {
      const chezA = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);
      const chezB = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN', harness.b))
        .expect(200);

      expect(chezA.body).toMatchObject({ id: harness.a.id, slug: harness.a.slug });
      expect(chezB.body).toMatchObject({ id: harness.b.id, slug: harness.b.slug });
      expect(chezA.body).not.toMatchObject({ slug: harness.b.slug });
    });

    it('n’expose que les champs des réglages — la liste est close', async () => {
      // Égalité de clés, et non `toContain` : un champ interne ajouté par
      // mégarde à la projection doit faire échouer ce test. `isActive` en fait
      // partie ici — et seulement ici : la vitrine publique ne le porte pas.
      const response = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'contactEmail',
        'contactPhone',
        'defaultCurrency',
        'defaultLocale',
        'id',
        'isActive',
        'name',
        'receiptPrefix',
        'slug',
        'taxRateBps',
        'timezone',
      ]);
      // Adresse et horaires **omis** tant qu'ils ne sont pas saisis, ici comme
      // sur la vitrine : c'est ce qui rend la migration transparente. Les cinq
      // champs d'identité légale suivent le même régime depuis #913 ;
      // `receiptPrefix` et `taxRateBps` non, leurs colonnes étant `NOT NULL`.
      expect(response.body).not.toHaveProperty('address');
      expect(response.body).not.toHaveProperty('openingHours');
      expect(response.body).not.toHaveProperty('legalName');
      expect(response.body).not.toHaveProperty('legalId');
    });
  });

  describe('le seuil de rôle tient', () => {
    it('refuse sans jeton', async () => {
      await request(server()).get(CHEMIN).expect(401);
      await request(server()).patch(CHEMIN).send({ name: 'Salon' }).expect(401);
    });

    it('refuse au rang manager', async () => {
      // Le paramétrage de l'établissement n'est pas une décision de planning :
      // adresse, horaires publiés, nom et devise relèvent de l'administration.
      const manager = await harness.bearer('MANAGER');

      await request(server()).get(CHEMIN).set('Authorization', manager).expect(403);
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', manager)
        .send({ name: 'Salon' })
        .expect(403);
    });
  });

  describe('l’écriture ne franchit pas la frontière', () => {
    it('l’enregistrement du voisin laisse intacts l’adresse et les horaires de l’appelant', async () => {
      // Le risque exact : la part « horaires » d'`updateTenantSettings` ouvre
      // sur un `deleteMany({})` sans `where`. Si le scoping ne l'attrapait pas,
      // l'enregistrement du voisin viderait la semaine de tout le monde — sans
      // erreur, sans trace.
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send(REGLAGES)
        .expect(200);

      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN', harness.b))
        .send({ openingHours: [], address: null, name: 'Barbier repeint' })
        .expect(200);

      const apres = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);

      expect(apres.body.address).toEqual(REGLAGES.address);
      expect(apres.body.openingHours).toEqual(REGLAGES.openingHours);
      expect(apres.body.name).toBe(harness.a.name);
    });

    it('n’accepte aucun identifiant d’établissement dans le corps', async () => {
      // `whitelist` + `forbidNonWhitelisted` : un `tenantId` ou un `slug` glissé
      // dans la charge utile ne passe pas la validation. C'est le scénario de
      // fuite le plus direct (tenant-isolation §2), et il se ferme au DTO.
      const admin = await harness.bearer('ADMIN');

      await request(server())
        .patch(CHEMIN)
        .set('Authorization', admin)
        .send({ tenantId: harness.b.id })
        .expect(400);
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', admin)
        .send({ slug: harness.b.slug })
        .expect(400);
    });
  });

  describe('l’identité légale ne franchit pas la frontière — #913', () => {
    /** Le SIRET du jeu d'essai — clé de Luhn juste. */
    const IDENTITE = {
      legalName: 'SPA LUMIERE SAS',
      legalIdType: 'SIRET',
      legalId: '73282932000074',
      vatNumber: 'FR40303265045',
      receiptFooter: 'Réclamation sous 14 jours sur présentation de ce ticket.',
      receiptPrefix: 'SPL',
      taxRateBps: 2000,
    };

    it('s’écrit chez l’appelant, se relit chez lui, et laisse le voisin au défaut', async () => {
      // Le risque exact : ces sept colonnes composent une **pièce comptable**.
      // Une écriture qui déborderait ferait imprimer le SIRET d'un salon sur le
      // ticket d'un autre — et la numérotation des deux se confondrait, le
      // préfixe étant la première moitié du numéro.
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send(IDENTITE)
        .expect(200);

      const chezA = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);
      const chezB = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN', harness.b))
        .expect(200);

      expect(chezA.body).toMatchObject(IDENTITE);
      expect(chezB.body).not.toHaveProperty('legalId');
      expect(chezB.body).not.toHaveProperty('vatNumber');
      // Le défaut de la colonne, et non la valeur du voisin.
      expect(chezB.body.receiptPrefix).toBe('TIC');
      expect(chezB.body.taxRateBps).toBe(0);
    });

    it('n’apparaît jamais sur la vitrine publique, qui n’est pas authentifiée', async () => {
      // Un SIRET et un taux de taxe s'impriment sur la pièce remise à la cliente
      // qui a payé. Ils ne se publient pas à qui connaît le slug du salon.
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send(IDENTITE)
        .expect(200);

      const vitrine = await request(server()).get(CHEMIN_PUBLIC(harness.a.slug)).expect(200);

      for (const champ of ['legalName', 'legalIdType', 'legalId', 'vatNumber', 'taxRateBps']) {
        expect(vitrine.body).not.toHaveProperty(champ);
      }
    });

    it('refuse en 400 un identifiant qui ne satisfait pas sa nature', async () => {
      const refus = await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send({ legalIdType: 'SIRET', legalId: '73282932000075' })
        .expect(400);

      expect(refus.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(refus.body.details)).toContain('legalId');
    });

    it('refuse en 400 un préfixe que la base refuserait, et n’écrit rien', async () => {
      const admin = await harness.bearer('ADMIN');

      await request(server())
        .patch(CHEMIN)
        .set('Authorization', admin)
        .send({ name: 'Salon repeint', receiptPrefix: 'TI-C' })
        .expect(400);

      const apres = await request(server()).get(CHEMIN).set('Authorization', admin).expect(200);
      expect(apres.body.name).toBe(harness.a.name);
      expect(apres.body.receiptPrefix).toBe('TIC');
    });
  });

  describe('la vitrine publique reste bornée à son établissement', () => {
    it('ne montre chez le voisin ni l’adresse ni les horaires de l’appelant', async () => {
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send(REGLAGES)
        .expect(200);

      const chezA = await request(server()).get(CHEMIN_PUBLIC(harness.a.slug)).expect(200);
      const chezB = await request(server()).get(CHEMIN_PUBLIC(harness.b.slug)).expect(200);

      expect(chezA.body.address).toEqual(REGLAGES.address);
      expect(chezB.body).not.toHaveProperty('address');
      expect(chezB.body).not.toHaveProperty('openingHours');
      // Ni `isActive` ne franchit la frontière du back-office vers la vitrine.
      expect(chezA.body).not.toHaveProperty('isActive');
    });

    it('sert un établissement sans adresse ni horaires', async () => {
      // Le critère de #343 : les deux champs sont facultatifs, et un salon
      // fraîchement inscrit n'a rien saisi. Sa vitrine a rigoureusement la forme
      // qu'elle avait avant la migration — un front antérieur la valide encore.
      const response = await request(server()).get(CHEMIN_PUBLIC(harness.b.slug)).expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'contactEmail',
        'contactPhone',
        'defaultCurrency',
        // Présente sur la vitrine depuis #844, et **toujours** : la colonne est
        // `NOT NULL` avec un défaut, et c'est la page publique — affichée avant
        // toute authentification — qui en a le plus besoin.
        'defaultLocale',
        'id',
        'name',
        'slug',
        'timezone',
      ]);
    });
  });

  describe('la langue de l’établissement ne franchit pas la frontière — #844', () => {
    it('s’écrit chez l’appelant et laisse le voisin au défaut du système', async () => {
      // Le risque est celui de toute colonne de `tenants` écrite par cette
      // route : un `updateMany` dont le scoping ne poserait pas `tenant_id`
      // basculerait la langue de tous les salons d'un coup — y compris celle de
      // leurs notifications.
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send({ defaultLocale: 'fr' })
        .expect(200);

      const chezA = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);
      const chezB = await request(server())
        .get(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN', harness.b))
        .expect(200);

      expect(chezA.body.defaultLocale).toBe('fr');
      // `en` — la langue par défaut du système (décision du PO du 2026-09-19),
      // pas celle que le voisin vient de choisir.
      expect(chezB.body.defaultLocale).toBe('en');
    });

    it('se voit sur la vitrine de son salon, et sur elle seule', async () => {
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send({ defaultLocale: 'fr' })
        .expect(200);

      const vitrineA = await request(server()).get(CHEMIN_PUBLIC(harness.a.slug)).expect(200);
      const vitrineB = await request(server()).get(CHEMIN_PUBLIC(harness.b.slug)).expect(200);

      expect(vitrineA.body.defaultLocale).toBe('fr');
      expect(vitrineB.body.defaultLocale).toBe('en');
    });

    it('normalise la casse d’une étiquette de langue', async () => {
      // « FR » et « fr » désignent la même langue, et une étiquette BCP 47 se
      // recopie d'un en-tête ou d'un sélecteur où rien ne la normalise. La
      // colonne, elle, ne connaît que la minuscule
      // (`tenants_default_locale_check`) : sans normalisation à la frontière, la
      // saisie serait refusée par une contrainte, donc en 500.
      const admin = await harness.bearer('ADMIN');

      await request(server())
        .patch(CHEMIN)
        .set('Authorization', admin)
        .send({ defaultLocale: ' FR ' })
        .expect(200);

      const apres = await request(server()).get(CHEMIN).set('Authorization', admin).expect(200);
      expect(apres.body.defaultLocale).toBe('fr');
    });

    it('refuse en 400 une langue hors du contrat, et n’écrit rien', async () => {
      // Le neuvième critère d'acceptation : le refus est un **400** portant le
      // code du contrat partagé, jamais une violation de `CHECK` remontée en
      // 500 — et il tombe avant que le reste de la charge utile ne soit écrit.
      const admin = await harness.bearer('ADMIN');

      const refus = await request(server())
        .patch(CHEMIN)
        .set('Authorization', admin)
        .send({ name: 'Salon repeint', defaultLocale: 'de' })
        .expect(400);

      expect(refus.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(refus.body.details)).toContain('defaultLocale');

      const apres = await request(server()).get(CHEMIN).set('Authorization', admin).expect(200);
      expect(apres.body.name).toBe(harness.a.name);
      expect(apres.body.defaultLocale).toBe('en');
    });

    it('refuse `null` : la colonne est obligatoire', async () => {
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send({ defaultLocale: null })
        .expect(400);
    });

    it('refuse au rang manager — la langue du salon est une décision d’administration', async () => {
      await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ defaultLocale: 'fr' })
        .expect(403);
    });
  });

  describe('les plages incohérentes sont refusées avant la base', () => {
    it('rend 422 sur deux plages du même jour qui se recouvrent, sans rien avoir écrit', async () => {
      // La base la refuserait aussi (`tenant_opening_hours_no_overlap`), mais en
      // violation de contrainte brute : 500 sur une saisie fautive, là où le
      // contrat annonce 422. Et le contrôle a lieu **avant** la première
      // écriture, sans quoi le nom de la même charge utile serait passé quand
      // même.
      const admin = await harness.bearer('ADMIN');

      const refus = await request(server())
        .patch(CHEMIN)
        .set('Authorization', admin)
        .send({
          name: 'Salon repeint',
          openingHours: [
            { weekday: 2, opensAt: '09:00', closesAt: '13:00' },
            { weekday: 2, opensAt: '12:00', closesAt: '19:00' },
          ],
        })
        .expect(422);

      expect(refus.body).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      const apres = await request(server()).get(CHEMIN).set('Authorization', admin).expect(200);
      expect(apres.body.name).toBe(harness.a.name);
    });

    it('rend 400 sur un code pays qui n’est pas un code ISO', async () => {
      const refus = await request(server())
        .patch(CHEMIN)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send({ address: { line1: '12 rue des Lilas', city: 'Paris', country: 'France' } })
        .expect(400);

      expect(refus.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(refus.body).toHaveProperty('details');
    });
  });
});
