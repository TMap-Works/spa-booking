import { ERROR_CODES, LOCALES, errorMessage, type Locale } from '@spa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * Le tunnel **public** nomme l'établissement qu'il ne sait pas lire — #1391, fin
 * de la classe ouverte par #1372, poursuivie par #1375 et #1379.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * Elle exerce la **vraie** `loadAvailabilityAction`, sans aucun double de sa
 * logique : une suite qui tendrait à l'écran un refus qu'aucune action ne produit
 * resterait verte sur un produit resté fautif.
 * `etablissement-inconnu-tunnel-public-ecran.test.tsx` fait l'autre moitié — l'étape
 * « Créneau » qui reçoit ce refus le **nomme**, dans les deux langues.
 *
 * ## Le `||` est ce qu'on mesure ici, et il demande trois cas
 *
 * Ce module jugeait le slug et la charge utile du **même** `if`
 * (`!slug.success || !parsed.success`), si bien que le refus rendu dépendait de
 * l'ordre des tests. Un seul cas ne suffirait donc pas :
 *
 * | Slug | Requête | Attendu | Ce que le cas ferme |
 * |---|---|---|---|
 * | illisible | valable | `TENANT_NOT_FOUND` | le slug est **jugé** |
 * | illisible | invalide | `TENANT_NOT_FOUND` | il est jugé **le premier**, et non au gré d'un `\|\|` |
 * | lisible | invalide | `VALIDATION_ERROR` | la requête de créneaux **garde** son code |
 *
 * Le deuxième est celui qui porte le ticket : c'est le seul que l'ancien `if`
 * pouvait rendre dans les deux sens, et le seul qu'un retour en arrière ferait
 * tomber sans rien casser par ailleurs.
 *
 * ## Et le partage des phrases, qui est la décision de ce ticket
 *
 * Les deux refus ne tirent pas leur phrase du même endroit, et c'est voulu — la
 * règle est écrite en tête du module d'actions. `TENANT_NOT_FOUND` la tient du
 * **contrat partagé** ; le refus de la requête de créneaux la tient du **catalogue**,
 * parce que le contrat ne sait pas dire de quelle demande il s'agissait. Les deux
 * moitiés sont exigées dans les deux langues : la première seule laisserait passer un
 * module qui aurait tout basculé au contrat — et perdu « La demande de disponibilités
 * est incomplète. » en chemin.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat, les
 * catalogues du dépôt pour le libellé — et jamais recopiées : un littéral resterait
 * vert le jour où le module cesserait de consulter la table.
 */

// L'action lit la langue de la requête par `next-intl/server` : c'est elle que
// `unknownTenant()` interroge pour écrire son `message`, et `getTranslations` pour
// celui du refus de saisie.
vi.mock('next-intl/server', () => nextIntlServerMobile());

// `lib/api-client.ts` lit les en-têtes de la requête pour en déduire la langue.
// Aucun des deux refus mesurés ici ne l'atteint — ils précèdent tout appel —, mais
// son import est évalué avec le module d'actions.
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
  headers: () => Promise.resolve(new Headers()),
}));

import { loadAvailabilityAction } from '@/app/(booking)/[tenantSlug]/reservation/actions';

/** Ce que `slugSchema` refuse : ni une adresse de salon, ni rien qui y ressemble. */
const SLUG_ILLISIBLE = 'Pas Un Slug !';
const SLUG = 'maison-lotus';

/** Une requête de créneaux que `availabilityQuerySchema` accepte — hors de cause. */
const REQUETE_VALABLE = {
  serviceId: '22222222-2222-4222-8222-222222222222',
  from: '2026-09-01',
  to: '2026-09-07',
};

/** Une requête que le schéma refuse : la plage est à l'envers. */
const REQUETE_INVALIDE = { ...REQUETE_VALABLE, from: '2026-09-07', to: '2026-09-01' };

afterEach(() => {
  vi.clearAllMocks();
  fixerLangue('fr');
});

/** Le code d'un refus, ou `'ok'` si l'action a abouti — de quoi comparer sans transtyper. */
function codeDe(result: { readonly ok: boolean } & Partial<{ readonly code: string }>): string {
  return result.ok ? 'ok' : (result.code ?? 'sans code');
}

/** Le `message` d'un refus, ou `null` si l'action a abouti. */
function messageDe(
  result: { readonly ok: boolean } & Partial<{ readonly message: string }>,
): string | null {
  return result.ok ? null : (result.message ?? null);
}

/**
 * Un libellé du catalogue, lu là où l'action le lit — le même `loadMessages` que
 * le serveur emploie.
 */
function libelle(locale: Locale, chemin: string): string {
  const trouve = chemin
    .split('.')
    .reduce<string | MessageTree | undefined>(
      (noeud, cle) => (typeof noeud === 'object' ? noeud[cle] : undefined),
      loadMessages(locale),
    );

  if (typeof trouve !== 'string') {
    throw new Error(`libellé absent du catalogue « ${locale} » : ${chemin}`);
  }

  return trouve;
}

describe('l’établissement illisible a son propre code, sur le dernier module', () => {
  it('le rend, requête de créneaux valable', async () => {
    const refus = await loadAvailabilityAction(SLUG_ILLISIBLE, REQUETE_VALABLE);

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
  });

  it('le rend aussi quand la requête refuse avec lui — le slug est jugé le premier', async () => {
    // Le cas que l'ancien `if` tranchait au gré de l'ordre d'un `||`. C'est ici
    // que se mesure « le slug se juge seul et en premier ».
    const refus = await loadAvailabilityAction(SLUG_ILLISIBLE, REQUETE_INVALIDE);

    expect(codeDe(refus)).toBe(ERROR_CODES.TENANT_NOT_FOUND);
  });

  it('et n’emporte rien de la requête dans sa phrase', async () => {
    const refus = await loadAvailabilityAction(SLUG_ILLISIBLE, REQUETE_VALABLE);

    // La garde qui rend l'assertion ci-dessus non vide : c'est bien la phrase de
    // l'établissement, et non celle que ce module disait avant ce ticket.
    expect(messageDe(refus)).not.toBe(libelle('fr', 'booking.tunnel.actions.availabilityIncomplete'));
  });
});

describe('le refus de la requête de créneaux garde `VALIDATION_ERROR`', () => {
  it('la plage de dates à l’envers, établissement lisible', async () => {
    const refus = await loadAvailabilityAction(SLUG, REQUETE_INVALIDE);

    expect(codeDe(refus)).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('la requête qui n’a aucun des champs attendus', async () => {
    expect(codeDe(await loadAvailabilityAction(SLUG, {}))).toBe(ERROR_CODES.VALIDATION_ERROR);
  });
});

/**
 * Le partage décidé par ce ticket, dans les deux langues.
 *
 * Le `message` n'est plus ce que l'écran affiche — il garde le code et réécrit la
 * phrase à chaque rendu (#1354) —, mais il reste ce que le contrat d'une action
 * promet, et un appelant qui n'aurait que le résultat doit y trouver une phrase déjà
 * dans sa langue.
 */
describe.each([...LOCALES])('la phrase de chaque refus, en « %s »', (locale) => {
  it('l’établissement illisible tient la sienne du contrat partagé', async () => {
    fixerLangue(locale);

    const refus = await loadAvailabilityAction(SLUG_ILLISIBLE, REQUETE_VALABLE);
    const attendue = errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);

    expect(messageDe(refus)).toBe(attendue);
    // La garde qui rend l'égalité non vide : ce n'est pas la tournure générique du
    // refus de saisie, qui est ce que tous les modules de cette classe disaient.
    expect(attendue).not.toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });

  it('la requête de créneaux garde la sienne, du catalogue de la surface', async () => {
    fixerLangue(locale);

    const refus = await loadAvailabilityAction(SLUG, REQUETE_INVALIDE);
    const attendue = libelle(locale, 'booking.tunnel.actions.availabilityIncomplete');

    expect(messageDe(refus)).toBe(attendue);
    // Ce que le contrat aurait dit à sa place, et qui ne nomme pas la demande :
    // c'est la moitié de la décision qu'un basculement complet aurait perdue.
    expect(attendue).not.toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });
});
