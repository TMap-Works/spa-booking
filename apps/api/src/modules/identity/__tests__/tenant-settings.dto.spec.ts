/**
 * Le fuseau horaire des réglages d'établissement, à la frontière HTTP (#597).
 *
 * Le critère porte sur ce qui **entre** : « le champ `timezone` est validé
 * contre la base IANA ; une valeur inconnue rend 400 ». Il ne se démontre pas en
 * relisant un décorateur — il se démontre en faisant passer un corps de requête
 * par le `ValidationPipe` réellement monté dans `app.module.ts`, avec
 * `whitelist` et `forbidNonWhitelisted`, et en constatant le refus.
 *
 * Ce qui rendait le défaut coûteux : `tenants.timezone` convertit à l'affichage
 * **tous** les rendez-vous de l'établissement. Une valeur inventée persistée ne
 * produit aucun message d'erreur au moment où elle est écrite — elle casse
 * l'agenda entier plus tard, ce que le CLAUDE.md classe en sévérité haute.
 *
 * La moitié de ces cas garde contre l'excès inverse : une validation qui
 * n'accepterait qu'une liste courte serait pire que l'absence de validation,
 * puisqu'elle refuserait des fuseaux que le moteur sait convertir.
 */

import { ValidationPipe } from '@nestjs/common';

import { UpdateTenantDto } from '../dto/tenant-settings.dto';

/** Le pipe tel qu'`app.module.ts` le monte pour toute l'application. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

async function run(value: unknown): Promise<UpdateTenantDto> {
  return (await pipe.transform(value, { type: 'body', metatype: UpdateTenantDto })) as UpdateTenantDto;
}

/**
 * Les violations rendues par le pipe, ou un tableau vide si le corps passe.
 *
 * C'est bien la charge utile de l'exception qui est lue, et non son seul type :
 * le contrat annonce un 400 `{ code, message, details }` dont les `details`
 * nomment le champ fautif, et cette liste est ce que le filtre y recopie.
 */
async function violations(value: unknown): Promise<string[]> {
  try {
    await run(value);

    return [];
  } catch (error) {
    const payload = (error as { getResponse: () => unknown }).getResponse();
    const message = (payload as { message?: unknown }).message;

    return Array.isArray(message) ? message.map((item) => String(item)) : [String(message)];
  }
}

describe('UpdateTenantDto — le fuseau horaire est validé contre la base IANA', () => {
  it('accepte un fuseau IANA courant', async () => {
    expect((await run({ timezone: 'Europe/Paris' })).timezone).toBe('Europe/Paris');
  });

  it('accepte un fuseau exotique — celui du jeu de données du dépôt', async () => {
    // `Indian/Antananarivo` est le fuseau du second établissement du seed. Une
    // validation qui ne connaîtrait que les capitales européennes rendrait le
    // jeu d'essai du dépôt inutilisable.
    expect((await run({ timezone: 'Indian/Antananarivo' })).timezone).toBe('Indian/Antananarivo');
  });

  it('accepte les liens tzdata que `supportedValuesOf` ne liste pas', async () => {
    // Le garde-fou de la décision d'implémentation : ces trois identifiants sont
    // des fuseaux valides que le moteur résout, et qu'une validation par liste
    // canonique aurait refusés en 400. Le test vérifie les deux moitiés — que
    // la liste canonique en laisse au moins un dehors, et qu'ils sont acceptés.
    //
    // La première moitié porte sur l'ensemble, et non identifiant par
    // identifiant : `supportedValuesOf` s'adosse à CLDR, dont le choix des
    // identifiants canoniques bouge d'une version d'ICU à l'autre — exiger de
    // chacun qu'il reste hors liste ferait rougir la suite au premier
    // rafraîchissement de tzdata, sans que rien du code testé ait changé.
    const canonical = new Set(Intl.supportedValuesOf('timeZone'));
    const links = ['UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires'];

    expect(links.some((timezone) => !canonical.has(timezone))).toBe(true);

    for (const timezone of links) {
      expect((await run({ timezone })).timezone).toBe(timezone);
    }
  });

  it('refuse la valeur inventée de #597, en nommant le champ fautif', async () => {
    const refusal = await violations({ timezone: 'Pas/UnFuseau' });

    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain('timezone');
    expect(refusal[0]).toContain('fuseau horaire IANA');
  });

  it('refuse ce qui ressemble à un fuseau sans en être un', async () => {
    // Un offset numérique, un continent seul, une abréviation composée, une
    // ville rattachée au mauvais continent : autant de saisies plausibles
    // qu'`Intl` ne résout pas.
    for (const timezone of ['+05:00', 'Europe', 'CET+2', 'America/Paris']) {
      expect((await violations({ timezone })).join(' ')).toContain('fuseau horaire IANA');
    }
  });

  it('refuse une valeur vide ou d’un autre type', async () => {
    for (const timezone of ['', '   ', null, 42]) {
      expect(await violations({ timezone })).not.toHaveLength(0);
    }
  });

  it('laisse le champ facultatif — l’absence ne vaut pas une faute', async () => {
    // La correction ne rend pas `timezone` obligatoire : un `PATCH` qui ne
    // touche qu'au nom ne doit pas se mettre à exiger un fuseau.
    expect(await violations({ name: 'Salon des Lilas' })).toHaveLength(0);
  });
});

/**
 * L'identité légale et le taux de taxe, à la même frontière (#913).
 *
 * Ce qui se démontre ici est ce que le DTO peut juger **seul** : la forme d'un
 * champ. La paire `(legalIdType, legalId)` ne s'y prête pas — un `PATCH` a le
 * droit de n'en porter qu'une moitié, l'autre étant en base —, et elle est
 * exercée par `tenant-settings.service.spec.ts`.
 */
describe('UpdateTenantDto — identité légale et fiscalité', () => {
  it('normalise en majuscules ce qui se recopie d’un document officiel', async () => {
    // « fr40303265045 » et « FR40303265045 » sont le même numéro, et la base ne
    // connaît que le second. Sans normalisation, la saisie en minuscules
    // tomberait sur une contrainte — donc en 500 — au lieu d'un message de
    // champ.
    const body = await run({
      legalId: ' 73282932000074 ',
      vatNumber: 'fr40303265045',
      receiptPrefix: ' spl ',
      legalIdType: 'siret',
    });

    expect(body).toMatchObject({
      legalId: '73282932000074',
      vatNumber: 'FR40303265045',
      receiptPrefix: 'SPL',
      legalIdType: 'SIRET',
    });
  });

  it('refuse un numéro de TVA dont la clé française est fausse', async () => {
    // La forme est bonne — deux lettres puis onze caractères. C'est la clé,
    // recalculée depuis le SIREN, qui ne tombe pas juste : le contrat partagé
    // est seul à le savoir, et ce décorateur l'interroge plutôt que de recoder
    // le calcul.
    const refus = await violations({ vatNumber: 'FR41303265045' });

    expect(refus).toHaveLength(1);
    expect(refus[0]).toContain('vatNumber');
  });

  it('accepte un numéro de TVA étranger, que le MVP ne sait pas juger', async () => {
    // Refuser un numéro belge valide coûterait plus cher que d'accepter une
    // saisie libre : les vingt-six plans de numérotation de l'Union n'ont pas de
    // règle commune au-delà de la forme.
    expect(await violations({ vatNumber: 'BE0403170701' })).toHaveLength(0);
  });

  it('refuse un préfixe de ticket hors du motif de la base', async () => {
    // `tenants_receipt_prefix_check` porte la même règle : le tiret est le
    // séparateur du format, un préfixe qui en porterait rendrait
    // `TI-C-2026-000123` indécomposable.
    for (const receiptPrefix of ['A', 'TROPLONGPREFIXE', 'TI-C', 'TI C', 'tic!']) {
      expect((await violations({ receiptPrefix })).join(' ')).toContain('receiptPrefix');
    }
  });

  it('n’accepte pas d’effacer le préfixe ni le taux — leurs colonnes sont `NOT NULL`', async () => {
    expect(await violations({ receiptPrefix: null })).not.toHaveLength(0);
    expect(await violations({ taxRateBps: null })).not.toHaveLength(0);
  });

  it('refuse un taux hors bornes ou à virgule', async () => {
    // Jamais de flottant sur le chemin de l'argent : un taux à virgule ferait du
    // calcul de la ligne de taxe une opération non reproductible.
    for (const taxRateBps of [-1, 10_001, 19.6]) {
      expect((await violations({ taxRateBps })).join(' ')).toContain('taxRateBps');
    }
  });

  it('accepte les deux bornes du taux', async () => {
    expect((await run({ taxRateBps: 0 })).taxRateBps).toBe(0);
    expect((await run({ taxRateBps: 10_000 })).taxRateBps).toBe(10_000);
  });

  it('refuse une nature d’identifiant inconnue', async () => {
    expect((await violations({ legalIdType: 'KBIS' })).join(' ')).toContain('legalIdType');
  });

  it('accepte d’effacer les cinq champs nullables', async () => {
    expect(
      await violations({
        legalName: null,
        legalIdType: null,
        legalId: null,
        vatNumber: null,
        receiptFooter: null,
      }),
    ).toHaveLength(0);
  });
});
