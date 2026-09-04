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
 *    coûteux à rater : `replaceOpeningHours` commence par un `deleteMany({})`
 *    sans `where`, et c'est l'extension de scoping — pas l'appelant — qui y pose
 *    `tenant_id` ;
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
        'id',
        'isActive',
        'name',
        'slug',
        'timezone',
      ]);
      // Adresse et horaires **omis** tant qu'ils ne sont pas saisis, ici comme
      // sur la vitrine : c'est ce qui rend la migration transparente.
      expect(response.body).not.toHaveProperty('address');
      expect(response.body).not.toHaveProperty('openingHours');
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
      // Le risque exact : `replaceOpeningHours` ouvre sur un `deleteMany({})`
      // sans `where`. Si le scoping ne l'attrapait pas, l'enregistrement du
      // voisin viderait la semaine de tout le monde — sans erreur, sans trace.
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
        'id',
        'name',
        'slug',
        'timezone',
      ]);
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
