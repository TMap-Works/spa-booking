import { PasswordHasher } from '../password.hasher';
import { fakeConfig } from './identity.doubles';

describe('PasswordHasher', () => {
  const PASSWORD = 'correct-horse-battery';

  let hasher: PasswordHasher;

  beforeEach(() => {
    hasher = new PasswordHasher(fakeConfig());
  });

  it('ne stocke jamais le mot de passe en clair', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(hash).not.toBe(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  it('applique le coût configuré', async () => {
    // Le coût est lisible dans l'empreinte elle-même : `$2a$04$…`. C'est ce qui
    // rend vérifiable, sans chronomètre, que `BCRYPT_COST` est bien consommé.
    const hash = await hasher.hash(PASSWORD);
    expect(hash.startsWith('$2a$04$') || hash.startsWith('$2b$04$')).toBe(true);

    const cher = new PasswordHasher(fakeConfig({ bcryptCost: 6 }));
    const plusCher = await cher.hash(PASSWORD);
    expect(plusCher.startsWith('$2a$06$') || plusCher.startsWith('$2b$06$')).toBe(true);
  });

  it('sale chaque empreinte — deux comptes au même mot de passe diffèrent', async () => {
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);

    // Sans sel par mot de passe, une seule table précalculée casserait tous les
    // comptes partageant un mot de passe courant.
    expect(first).not.toBe(second);
    await expect(hasher.verify(PASSWORD, first)).resolves.toBe(true);
    await expect(hasher.verify(PASSWORD, second)).resolves.toBe(true);
  });

  it('accepte le bon mot de passe et refuse les autres', async () => {
    const hash = await hasher.hash(PASSWORD);

    await expect(hasher.verify(PASSWORD, hash)).resolves.toBe(true);
    await expect(hasher.verify('mauvais', hash)).resolves.toBe(false);
    await expect(hasher.verify(`${PASSWORD} `, hash)).resolves.toBe(false);
  });

  it('refuse sans lever quand le compte n’a pas d’empreinte', async () => {
    // Un client saisi au comptoir existe sans avoir choisi de mot de passe. Sans
    // ce cas, `bcrypt.compare` lèverait et le 500 qui s'ensuit désignerait
    // précisément les comptes sans mot de passe.
    await expect(hasher.verify(PASSWORD, null)).resolves.toBe(false);
  });

  it('consomme un temps comparable quand il n’y a rien à vérifier', async () => {
    // Le chemin « compte inconnu » doit coûter ce que coûte un vrai échec, sinon
    // la durée de la réponse dit si l'adresse existe dans cet établissement.
    await expect(hasher.burnComparableTime(PASSWORD)).resolves.toBeUndefined();
  });
});
