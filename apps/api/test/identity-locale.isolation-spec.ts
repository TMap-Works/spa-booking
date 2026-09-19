import request from 'supertest';

import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * La langue préférée d'un compte, posée **à l'inscription** — #844, huitième
 * critère d'acceptation, et l'isolation qui va avec.
 *
 * ## Ce que cette suite prouve, et ce qu'une autre prouve à sa place
 *
 * | Surface | Où elle est exercée |
 * |---|---|
 * | `POST /auth/register` | **ici** — la langue de la page est enregistrée sur le compte créé |
 * | `PATCH /users/me`, `GET /auth/me` | `identity-roles.isolation-spec.ts` |
 * | `GET`/`PATCH /tenant`, vitrine publique | `tenant-settings.isolation-spec.ts` |
 * | la réservation sans compte | `crm/__tests__/client-directory.service.spec.ts`, où le verrou et le prédicat `locale IS NULL` se lisent |
 *
 * ## Le risque propre à la langue
 *
 * Il n'est pas de confidentialité — savoir que quelqu'un lit en anglais
 * n'apprend rien de compromettant. Il est d'**écriture** : `users.locale`
 * décidera de la langue des notifications (#854), et une écriture qui
 * franchirait la frontière basculerait les envois d'un salon voisin sans que
 * personne le demande, ni ne s'en aperçoive. C'est ce que les deux derniers cas
 * de cette suite gardent.
 */

const REGISTER_PATH = '/api/v1/auth/register';

/** Une inscription complète, à laquelle chaque cas ajoute ou retire une chose. */
const INSCRIPTION = {
  email: 'camille@example.test',
  password: 'correct horse battery',
  firstName: 'Camille',
  lastName: 'Rakoto',
  dataConsent: true,
} as const;

describe('Langue préférée à l’inscription — #844', () => {
  let harness: TenantHarness;

  beforeEach(async () => {
    harness = await createTenantHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Les comptes réellement écrits pour cet établissement-**là**. */
  const comptesDe = (tenantId: string): readonly { locale: string | null }[] =>
    harness.identity.users.filter((compte) => compte.tenantId === tenantId);

  it('enregistre la langue de l’interface sur le compte créé, et la rend', async () => {
    const reponse = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION, locale: 'fr' })
      .expect(201);

    expect(reponse.body.user.locale).toBe('fr');
    expect(comptesDe(harness.a.id)[0]?.locale).toBe('fr');
  });

  it('laisse le compte sans préférence quand la langue n’est pas donnée', async () => {
    // `null` se lit « aucune préférence enregistrée », jamais « anglais » : c'est
    // la langue de l'établissement qui s'appliquera. Inventer ici un défaut
    // ferait paraître choisie une langue que personne n'a demandée, et rendrait
    // la règle « ne jamais écraser » inopérante — il n'y aurait plus de trou à
    // combler.
    const reponse = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION })
      .expect(201);

    expect(reponse.body.user.locale).toBeNull();
    expect(comptesDe(harness.a.id)[0]?.locale).toBeNull();
  });

  it('normalise la casse de l’étiquette de langue', async () => {
    // Une étiquette BCP 47 se recopie d'un en-tête `Accept-Language` ou d'un
    // sélecteur de navigateur, où rien ne la met en minuscules. La colonne, elle,
    // ne connaît que `fr` et `en` (`users_locale_check`).
    const reponse = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION, locale: 'EN' })
      .expect(201);

    expect(reponse.body.user.locale).toBe('en');
  });

  it('refuse en 400 une langue hors du contrat, sans créer de compte', async () => {
    // Le neuvième critère d'acceptation. Le refus porte le code du contrat
    // partagé et nomme le champ ; il tombe **avant** toute écriture, sinon un
    // compte serait créé puis rejeté par la contrainte de base, en 500.
    const refus = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION, locale: 'de' })
      .expect(400);

    expect(refus.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(refus.body.details)).toContain('locale');
    expect(comptesDe(harness.a.id)).toHaveLength(0);
  });

  it('n’écrit la préférence que dans l’établissement de l’inscription', async () => {
    // La même adresse chez deux salons donne deux comptes distincts
    // (`@@unique([tenantId, email])`), et chacun porte **sa** préférence. Le
    // risque exact : `users.locale` décidera de la langue des notifications, et
    // une écriture qui déborderait basculerait celles du voisin.
    await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION, locale: 'fr' })
      .expect(201);

    await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.b.slug, ...INSCRIPTION, locale: 'en' })
      .expect(201);

    expect(comptesDe(harness.a.id).map((compte) => compte.locale)).toEqual(['fr']);
    expect(comptesDe(harness.b.id).map((compte) => compte.locale)).toEqual(['en']);
  });

  it('ne pose aucune préférence sur les comptes déjà semés chez le voisin', async () => {
    const avant = harness.identity.users
      .filter((compte) => compte.tenantId === harness.b.id)
      .map((compte) => compte.locale);

    await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION, locale: 'fr' })
      .expect(201);

    expect(
      harness.identity.users
        .filter((compte) => compte.tenantId === harness.b.id)
        .map((compte) => compte.locale),
    ).toEqual(avant);
  });

  it('n’attribue aucune langue au compte du personnel qu’un administrateur invite', async () => {
    // L'administrateur qui invite ne connaît pas la langue de qui va se
    // connecter. La deviner depuis la sienne poserait une préférence que l'autre
    // n'a pas donnée — et `null` se lit précisément « aucune ».
    const invitation = await request(harness.server())
      .post('/api/v1/users')
      .set('Authorization', await harness.bearer('ADMIN'))
      .send({
        email: 'praticienne@lilas.test',
        role: 'STAFF',
        firstName: 'Alice',
        lastName: 'Durand',
      })
      .expect(201);

    expect(invitation.body.user.locale).toBeNull();
  });
});
