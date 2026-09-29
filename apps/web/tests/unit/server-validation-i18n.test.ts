import {
  ERROR_CODES,
  createPlatformNoteRequestSchema,
  errorMessage,
  validationMessage,
  validationPhrases,
  zodErrorMap,
  type Locale,
} from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

/**
 * Les refus de validation **serveur**, dits dans la langue de la requête — #1299.
 *
 * ## Ce que cette suite protège
 *
 * Une action serveur revalide sa charge utile avec le schéma du contrat partagé
 * (web-frontend §4) : rien ne garantit qu'un appel vienne du formulaire. Ce
 * `safeParse` ne recevait aucune carte d'erreurs, et retombait donc sur la carte
 * **globale** que `@spa/shared` pose à son chargement, en
 * `DIAGNOSTIC_LOCALE = 'fr'` pour les journaux de l'API (#1232). Le message qui
 * remontait à l'écran était en français, quelle que soit la langue de la
 * session — un filet de sécurité qui, le jour où il sert, parle la mauvaise
 * langue.
 *
 * `validation-i18n.test.tsx` éprouve le **formulaire** : la carte que
 * `zodResolver` reçoit, et la phrase sous le champ. Celle-ci éprouve l'autre
 * moitié du même contrat — le chemin qu'emprunte une charge utile qui n'est pas
 * passée par ce formulaire. Les deux écrans nommés par le troisième critère
 * d'acceptation du ticket y sont : l'inscription d'un salon (`signupSalonAction`)
 * et les réglages du salon (`updateTenantSettingsAction`). La console de
 * l'éditeur s'y ajoute, parce que c'est elle qui portait les phrases françaises
 * écrites en dur.
 *
 * ## Les phrases sont lues, jamais recopiées
 *
 * Elles viennent de `validationPhrases`, `validationMessage` et `errorMessage` —
 * le contrat partagé lui-même. Un test qui réécrirait « This field is
 * required. » resterait vert le jour où l'action cesserait de lire la carte de
 * la requête, pourvu que quelqu'un ait recopié la même phrase ailleurs.
 *
 * ## Pourquoi une langue **mobile**
 *
 * Le même refus est exigé dans les deux langues, à la suite : c'est ce qui
 * distingue « la phrase est traduite » de « la phrase est anglaise ». Une langue
 * figée ne le permettrait pas, et une suite par langue doublerait le fichier.
 * La doublure est celle de `tests/support/langue-mobile.ts` (#1277) — une action
 * serveur lit sa langue par `next-intl/server`, pas par un crochet.
 */

vi.mock('next-intl/server', () => nextIntlServerMobile());

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: vi.fn() }),
}));

const { invalidFromZod, validationRefusal } = await import(
  '@/app/(admin)/[tenantSlug]/admin/action-result'
);
const { signupSalonAction } = await import('@/app/inscription/actions');
const { adminAcceptInvitationAction, updateTenantSettingsAction } = await import(
  '@/app/(admin)/[tenantSlug]/admin/actions'
);
const {
  addTenantNoteAction,
  provisionTenantAction,
  reissueTenantInvitationAction,
  updateTenantStatusAction,
} = await import('@/app/plateforme/actions');

afterEach(() => {
  fixerLangue('fr');
});

const LANGUES: readonly Locale[] = ['en', 'fr'];

/** Le refus d'une action, une fois qu'on a vérifié que c'en est bien un. */
async function refus(action: Promise<{ ok: boolean }>): Promise<{ code: string; message: string }> {
  const resultat = (await action) as { ok: boolean; code?: string; message?: string };

  expect(resultat.ok).toBe(false);

  return { code: resultat.code ?? '', message: resultat.message ?? '' };
}

/** Une charge utile de réglages dont un seul champ est fautif. */
const CONTACT_FAUTIF = { contactEmail: 'pas-une-adresse' };

/**
 * Un identifiant de salon que `uuidSchema` accepte : il sert à dépasser le
 * contrôle de l'URL pour atteindre celui de la charge utile, qui est l'objet du
 * cas.
 */
const SALON_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Une acceptation d'invitation que `acceptInvitationRequestSchema` accepte — le
 * mot de passe dépasse les douze caractères exigés. Elle sert le cas inverse du
 * précédent : c'est le **slug** qui doit être refusé, la charge utile étant hors
 * de cause.
 */
const INVITATION_VALABLE = { token: 'jeton-de-test', password: 'mot-de-passe-de-test' };

/**
 * Un salon que `createTenantRequestSchema` accepte — il sert à dépasser la
 * validation pour atteindre le contrôle qui la suit, celui de la clé
 * d'idempotence.
 */
const SALON_VALABLE = {
  slug: 'spa-lumiere',
  name: 'Spa Lumière',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'MGA',
  countryCode: 'MG',
  addressLine1: '12 rue des Orchidées',
  city: 'Antananarivo',
  adminEmail: 'gerante@spa-lumiere.mg',
  adminFirstName: 'Hanta',
  adminLastName: 'Rakoto',
};

/**
 * Le repli lui-même, depuis qu'il n'est plus recopié — #1310.
 *
 * Les suites qui suivent éprouvent des **actions** ; celle-ci éprouve la
 * fonction sur laquelle elles retombent toutes. Deux choses s'y jouent, et
 * chacune est une décision du ticket : la phrase est bien celle de
 * `VALIDATION_ERROR` — jamais celle d'un code choisi pour ce qu'il dit, puisque
 * l'écran trie sur le code —, et la langue est celle du **paramètre**, non celle
 * de la requête. Ce second point ne se mesure qu'à langue de requête **fixe** :
 * elle reste `fr` — celui de l'`afterEach` pour le premier cas, un
 * `fixerLangue('fr')` explicite pour le second —, si bien qu'une phrase anglaise
 * ne peut venir que du paramètre. Un `validationRefusal` qui se remettrait à
 * lire `getLocale()` lui-même tomberait donc sur le cas `en`. Le second cas
 * l'énonce en une ligne, et pose en outre la garde qui rend l'égalité non
 * vide : les deux langues ne partagent pas cette phrase.
 */
describe('le repli de validation — une seule phrase, tenue en un seul point', () => {
  it.each(LANGUES)('rend la phrase de VALIDATION_ERROR, en %s', (locale) => {
    // Aucune langue à fixer ici : la laisser sur le `fr` de l'`afterEach` est
    // précisément ce qui prouve, au cas `en`, que la fonction ne lit pas la
    // requête.
    expect(validationRefusal(locale)).toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });

  it('rend la langue demandée, et non celle de la requête', () => {
    fixerLangue('fr');

    const anglais = validationRefusal('en');

    expect(anglais).toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, 'en'));
    // La garde qui rend les deux assertions ci-dessus non vides : si le contrat
    // cessait de traduire ce code, elles passeraient sur la même phrase.
    expect(anglais).not.toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'));
  });
});

/**
 * La **forme d'appel**, depuis qu'elle n'est plus recopiée non plus — #1319.
 *
 * #1310 avait ramené la phrase de repli dans `action-result.ts` ; la forme qui
 * l'emploie — `issues[0]?.message ?? validationRefusal(locale)` — restait
 * recopiée à cinq sites. `invalidFromZod` l'assemble, et la décision de l'y
 * mettre est écrite dans l'en-tête de ce module-là.
 *
 * Ce que cette suite protège est la promesse du ticket : **le refus rendu est
 * inchangé**. Trois choses le composent, et chacune a son cas — le code, qui est
 * toujours `VALIDATION_ERROR` et jamais celui que la phrase suggère ; la phrase,
 * qui est celle du premier refus du schéma **quand il en nomme un** ; et la
 * langue, qui est celle du paramètre. Ce dernier point se mesure à langue de
 * requête fixe, pour la même raison que ci-dessus : une phrase anglaise ne peut
 * alors venir que du paramètre.
 *
 * L'`undefined` du premier paramètre n'est pas une commodité : il sert le site
 * où le refus peut venir d'ailleurs que du schéma — l'acceptation d'invitation
 * juge aussi le slug de l'URL. Son cas est plus bas, sur l'action elle-même.
 */
describe('le refus d’un schéma — même code, même phrase, même langue', () => {
  /** Une `ZodError` véritable, dans la langue demandée — jamais une doublure. */
  function refusDuSchema(locale: Locale) {
    const parsed = createPlatformNoteRequestSchema.safeParse({}, { errorMap: zodErrorMap(locale) });

    expect(parsed.success).toBe(false);

    return parsed.success ? undefined : parsed.error;
  }

  it.each(LANGUES)('rend le message du premier refus du schéma, en %s', (locale) => {
    fixerLangue('fr');

    expect(invalidFromZod(refusDuSchema(locale), locale)).toEqual({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: validationPhrases(locale).required,
    });
  });

  it.each(LANGUES)('retombe sur la phrase du code quand rien ne le nomme, en %s', (locale) => {
    fixerLangue('fr');

    expect(invalidFromZod(undefined, locale)).toEqual({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: errorMessage(ERROR_CODES.VALIDATION_ERROR, locale),
    });
  });
});

describe('inscription d’un salon — le refus suit la langue de la requête', () => {
  it.each(LANGUES)('champ obligatoire vide, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(signupSalonAction({}));

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(validationPhrases(locale).required);
  });
});

describe('réglages du salon — le refus suit la langue de la requête', () => {
  it.each(LANGUES)('adresse de contact mal formée, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(
      updateTenantSettingsAction('spa-lumiere', CONTACT_FAUTIF),
    );

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(validationMessage('identifier.email', locale));
  });
});

describe('console de l’éditeur — plus aucune phrase écrite en dur', () => {
  it.each(LANGUES)('ouverture d’un salon : charge utile vide, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(provisionTenantAction('cle-de-soumission-1299', {}));

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(validationPhrases(locale).required);
  });

  it.each(LANGUES)('clé de soumission trop courte, en %s', async (locale) => {
    fixerLangue(locale);

    // La charge utile est valable : c'est la clé d'idempotence qui est refusée,
    // et sa phrase est celle du code — aucun schéma ne nomme ce refus-là.
    const { message } = await refus(provisionTenantAction('court', SALON_VALABLE));

    expect(message).toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });

  it.each(LANGUES)('identifiant de salon illisible, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(reissueTenantInvitationAction('pas-un-uuid'));

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });

  // Les deux derniers des cinq sites repliés sur `invalidFromZod` (#1319). Ils y
  // sont pour la promesse du ticket — le refus rendu est inchangé —, et non pour
  // éprouver une règle que les schémas portent déjà.
  it.each(LANGUES)('note interne vide, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(addTenantNoteAction(SALON_ID, {}));

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(validationPhrases(locale).required);
  });

  it.each(LANGUES)('changement d’état sans motif, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(updateTenantStatusAction(SALON_ID, {}));

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(validationPhrases(locale).required);
  });
});

/**
 * Le site où le refus peut venir d'**ailleurs** que du schéma — #1319.
 *
 * `adminAcceptInvitationAction` juge le slug de l'URL et la charge utile d'un
 * même `if` : une charge utile valable sur un slug illisible refuse sans qu'aucune
 * `ZodError` n'existe. C'est ce cas-là que l'`undefined` d'`invalidFromZod` sert,
 * et c'est ici qu'il se mesure en situation — la phrase attendue est celle du
 * code, exactement ce que rendait le `parsed.success ? generique : …` d'avant.
 */
describe('acceptation d’invitation — un slug illisible se dit par la phrase du code', () => {
  it.each(LANGUES)('charge utile valable, slug refusé, en %s', async (locale) => {
    fixerLangue(locale);

    const { code, message } = await refus(
      adminAcceptInvitationAction('Spa Lumière', INVITATION_VALABLE),
    );

    expect(code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(message).toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });
});
