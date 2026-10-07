/**
 * Les champs facultatifs de la console plateforme, à la frontière HTTP (#1340).
 *
 * Le critère porte sur ce qui **entre** : « facultatif veut dire absent, jamais
 * vide ». Il ne se démontre pas en relisant un décorateur — `@IsOptional()` et
 * `@MinLength(1)` se lisent très bien côte à côte sans qu'on voie lequel juge
 * `''` —, il se démontre en faisant passer un corps de requête par le
 * `ValidationPipe` réellement monté dans `app.module.ts`, avec `whitelist` et
 * `forbidNonWhitelisted`, et en constatant le refus.
 *
 * Ce qui rendait le défaut coûteux : `''` enregistré en colonne ressortait tel
 * quel de `toPostalAddress`, et `postalAddressSchema` exige au moins un
 * caractère. La vitrine du salon devenait alors inaccessible, en
 * `INTERNAL_ERROR`, pour une adresse que l'opératrice croyait avoir saisie
 * correctement. Un salon ouvert avec un code postal vide est un salon dont la
 * page ne s'ouvre pas. La lecture écarte désormais `''` elle aussi, pour les
 * lignes que cette borne-ci ne peut plus rattraper.
 *
 * La moitié de ces cas garde contre l'excès inverse : une borne qui rendrait
 * `addressLine2` ou `postalCode` obligatoires refuserait l'ouverture d'un salon
 * dont l'adresse tient sur une ligne, ou d'un salon d'un pays sans code postal.
 */

import { ValidationPipe } from '@nestjs/common';

import { CreateTenantDto, ListTenantsQueryDto, toTenantPageQuery } from '../dto/platform.dto';

/** Le pipe tel qu'`app.module.ts` le monte pour toute l'application. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

/** Une ouverture de salon que le DTO accepte — la base des cas ci-dessous. */
const OPENING = {
  slug: 'maison-lotus',
  name: 'Maison Lotus',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  countryCode: 'FR',
  addressLine1: '12 rue des Lilas',
  city: 'Paris',
  adminEmail: 'gerante@maison-lotus.test',
  adminFirstName: 'Alice',
  adminLastName: 'Durand',
} as const;

async function body(value: unknown): Promise<CreateTenantDto> {
  return (await pipe.transform(value, { type: 'body', metatype: CreateTenantDto })) as CreateTenantDto;
}

async function query(value: unknown): Promise<ListTenantsQueryDto> {
  return (await pipe.transform(value, {
    type: 'query',
    metatype: ListTenantsQueryDto,
  })) as ListTenantsQueryDto;
}

/**
 * Les violations rendues par le pipe, ou un tableau vide si la charge passe.
 *
 * C'est bien la charge utile de l'exception qui est lue, et non son seul type :
 * le contrat annonce un 400 `{ code, message, details }` dont les `details`
 * nomment le champ fautif, et cette liste est ce que le filtre y recopie.
 */
async function violations(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();

    return [];
  } catch (error) {
    const payload = (error as { getResponse: () => unknown }).getResponse();
    const message = (payload as { message?: unknown }).message;

    return Array.isArray(message) ? message.map((item) => String(item)) : [String(message)];
  }
}

describe('CreateTenantDto — les compléments d’adresse refusent la chaîne vide', () => {
  it.each(['addressLine2', 'postalCode', 'region'] as const)(
    'refuse `""` sur %s, en nommant le champ fautif',
    async (field) => {
      const refusal = await violations(() => body({ ...OPENING, [field]: '' }));

      expect(refusal).toHaveLength(1);
      expect(refusal[0]).toContain(field);
      expect(refusal[0]).toContain('au moins un caractère');
    },
  );

  it.each(['addressLine2', 'postalCode', 'region'] as const)(
    'refuse une saisie faite d’espaces sur %s — `@Trim()` ne la sauve pas',
    async (field) => {
      // La borne juge la valeur **élaguée** : sans cela, « " " » aurait traversé
      // et laissé en colonne une chaîne que la vitrine relit comme un morceau
      // d'adresse écrit.
      expect((await violations(() => body({ ...OPENING, [field]: '   ' }))).join(' ')).toContain(
        field,
      );
    },
  );

  it('laisse les trois champs facultatifs — l’absence ne vaut pas une faute', async () => {
    // L'autre moitié du critère : la correction ne rend rien obligatoire. Une
    // adresse qui tient sur une ligne, dans un pays sans code postal et sans
    // subdivision, reste une adresse qu'on a le droit d'ouvrir.
    expect(await violations(() => body(OPENING))).toHaveLength(0);
  });

  it('accepte les trois champs renseignés, élagués', async () => {
    const opening = await body({
      ...OPENING,
      addressLine2: '  Bâtiment B  ',
      postalCode: ' 10118 ',
      region: ' NY ',
    });

    expect(opening).toMatchObject({ addressLine2: 'Bâtiment B', postalCode: '10118', region: 'NY' });
  });

  it('accepte `null`, qui dit la même chose que l’absence', async () => {
    // La borne ne vise que `''`. `null` est ce qu'`@IsOptional()` laisse passer
    // par construction, et le contrôleur l'écrit tel quel (`?? null`) : la
    // colonne reçoit l'absence, pas une chaîne vide. Rien à refuser ici — ce
    // test est la contre-épreuve du précédent, qui dirait n'importe quoi si la
    // borne refusait tout ce qui n'est pas une chaîne non vide.
    for (const field of ['addressLine2', 'postalCode', 'region'] as const) {
      expect(await violations(() => body({ ...OPENING, [field]: null }))).toHaveLength(0);
    }
  });
});

describe('CreateTenantDto — la règle vaut pour les autres champs facultatifs', () => {
  it('refuse `""` sur la langue, par sa liste fermée', async () => {
    // `defaultLocale` n'a pas besoin d'une longueur minimale : `@IsIn` sur
    // `LOCALES` refuse déjà tout ce qui n'est ni `fr` ni `en`, `''` compris.
    expect((await violations(() => body({ ...OPENING, defaultLocale: '' }))).join(' ')).toContain(
      'defaultLocale',
    );
  });

  it('laisse la langue facultative — le salon muet s’ouvre en anglais', async () => {
    expect((await body(OPENING)).defaultLocale).toBeUndefined();
  });
});

describe('ListTenantsQueryDto — la même règle, et son unique exception', () => {
  it.each(['billingStatus', 'state'] as const)('refuse `""` sur %s', async (field) => {
    expect((await violations(() => query({ [field]: '' }))).join(' ')).toContain(field);
  });

  it.each(['page', 'pageSize'] as const)('refuse `""` sur %s', async (field) => {
    // `@Type(() => Number)` convertit `''` en `0`, que `@Min(1)` refuse : un
    // champ de pagination vidé ne doit pas rendre la page 0.
    expect((await violations(() => query({ [field]: '' }))).join(' ')).toContain(field);
  });

  it('tolère un terme de recherche vide — l’exception assumée', async () => {
    // Vider le champ de recherche est la façon normale de revenir à la liste
    // entière : ce terme ne s'écrit dans aucune colonne, et le refuser en 400
    // ferait échouer la liste au moment où l'opératrice efface sa recherche.
    expect(await violations(() => query({ q: '' }))).toHaveLength(0);
  });

  it('un terme vide ne filtre pas — l’exception est bornée là', async () => {
    // Ce qui rend l'exception sûre : `toTenantPageQuery` ramène `''` à l'absence
    // de filtre, plutôt que de chercher les salons dont le nom contient `''`.
    expect(toTenantPageQuery(await query({ q: '   ' }))).not.toHaveProperty('q');
  });
});
