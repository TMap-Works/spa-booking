import {
  ERROR_CODES,
  errorMessage,
  validationMessage,
  validationPhrases,
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

const { signupSalonAction } = await import('@/app/inscription/actions');
const { updateTenantSettingsAction } = await import('@/app/(admin)/[tenantSlug]/admin/actions');
const { provisionTenantAction, reissueTenantInvitationAction } = await import(
  '@/app/plateforme/actions'
);

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
});
