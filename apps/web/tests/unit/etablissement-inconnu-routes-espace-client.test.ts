// @vitest-environment node
import { ERROR_CODES, LOCALES, errorMessage, type BookedAppointment, type Locale } from '@spa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlServerMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * Les deux **Route Handlers** de l'espace client nomment l'établissement — #1394,
 * et la fin de la classe ouverte par #1372, poursuivie par #1375, #1379 et #1391.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * Elle exerce les **vraies** routes, sans aucun double de leur logique : une suite
 * qui tendrait à l'écran un refus qu'aucune route ne produit resterait verte sur un
 * produit resté fautif. `etablissement-inconnu-routes-espace-client-ecran.test.tsx`
 * fait l'autre moitié — les deux écrans qui reçoivent ces refus les **nomment**,
 * dans les deux langues.
 *
 * ## Trois choses se mesurent ici, et pas une de moins
 *
 * 1. **le code** — `TENANT_NOT_FOUND` et non `VALIDATION_ERROR`, qui disait « La
 *    demande d'annulation est incomplète. » et « Les informations de réservation
 *    sont incomplètes. » pour un segment d'URL que personne n'avait tapé ;
 * 2. **le statut** — `404` et non `400`. C'est la seule chose que les dix modules
 *    d'actions de ce fil n'avaient pas eu à trancher : ils ne rendent qu'un
 *    résultat, une route porte un statut. La décision et ses raisons sont en tête
 *    de la route d'annulation ; elle s'éprouve ici, parce qu'un en-tête ne se
 *    vérifie pas tout seul ;
 * 3. **l'ordre** — le slug se juge **seul et en premier**, avant la charge utile et
 *    avant la session. L'annulation le jugeait du même `if` que l'identifiant du
 *    rendez-vous : le refus rendu dépendait de l'ordre des tests d'un `||`.
 *
 * Le cas « slug illisible **et** charge utile invalide » est celui qui porte le
 * ticket : c'est le seul que l'ancien `if` pouvait trancher dans les deux sens, et
 * le seul qu'un retour en arrière ferait tomber sans rien casser par ailleurs.
 *
 * ## Et le partage des phrases, qui est la règle de #1391
 *
 * Les deux refus ne tirent pas leur phrase du même endroit, et c'est voulu.
 * `TENANT_NOT_FOUND` la tient du **contrat partagé** — « Cet établissement est
 * introuvable. » est exactement ce qu'il y a à dire ; le refus de la charge utile la
 * garde du **catalogue** de sa surface, parce que le contrat ne sait pas dire de
 * quelle demande il s'agissait. Les deux moitiés sont exigées dans les deux
 * langues : la première seule laisserait passer une route qui aurait tout basculé au
 * contrat, et perdu « La demande d'annulation est incomplète. » en chemin.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat, les
 * catalogues du dépôt pour les libellés — et jamais recopiées : un littéral
 * resterait vert le jour où une route cesserait de consulter la table.
 *
 * Environnement Node : les routes manipulent des `Request` et des `Response` du
 * standard, que jsdom ne fournit pas — même raison que
 * `annulation-depuis-le-tunnel.test.ts`.
 */

// Les routes lisent la langue de la requête par `next-intl/server` : `getLocale`
// pour la phrase du contrat, `getTranslations` pour celle du catalogue.
vi.mock('next-intl/server', () => nextIntlServerMobile());

const cancelAppointment = vi.fn();
const bookGuestAppointment = vi.fn();
const refreshSession = vi.fn();

// Le module réel est repris et trois fonctions seulement sont remplacées :
// `ApiClientError` doit rester la vraie classe, sans quoi les `instanceof` des
// routes ne reconnaîtraient plus les refus de l'API.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  cancelAppointment: (...args: unknown[]) => cancelAppointment(...args),
  bookGuestAppointment: (...args: unknown[]) => bookGuestAppointment(...args),
  refreshSession: (...args: unknown[]) => refreshSession(...args),
}));

/** Les cookies que le navigateur envoie avec la requête. */
const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: vi.fn(),
      delete: vi.fn(),
    }),
  // `lib/api-client.ts` lit les en-têtes pour en déduire la langue de l'appel.
  // Aucun des refus mesurés ici ne l'atteint — ils précèdent tout appel —, mais
  // son import est évalué avec celui des routes.
  headers: () => Promise.resolve(new Headers()),
}));

import { POST as annuler } from '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/annulation/route';
import { POST as reserver } from '@/app/(account)/[tenantSlug]/compte/reservation/route';

/** Ce que `slugSchema` refuse : ni une adresse de salon, ni rien qui y ressemble. */
const SLUG_ILLISIBLE = 'Pas Un Slug !';
const SLUG = 'maison-lotus';

const RENDEZ_VOUS = '55555555-5555-4555-8555-555555555555';
/** Ce que `uuidSchema` refuse. */
const ID_ILLISIBLE = 'pas-un-uuid';

const JETON = 'jeton-de-la-cliente';

/** Ce que le tunnel poste — la sortie de `summary-step.tsx`, au champ près (#1222). */
const DEMANDE = {
  serviceId: '22222222-2222-4222-8222-222222222222',
  startsAt: '2026-09-01T06:00:00.000Z',
  dataConsent: true,
};

/** La même, sans l'accord que `dataConsentSchema` exige. */
const DEMANDE_INVALIDE = {
  serviceId: DEMANDE.serviceId,
  startsAt: DEMANDE.startsAt,
};

const PRIS: BookedAppointment = {
  id: RENDEZ_VOUS,
  reference: 'RDV-8F3K-27',
  status: 'pending',
  serviceId: DEMANDE.serviceId,
  staffId: '44444444-4444-4444-8444-444444444444',
  clientId: '66666666-6666-4666-8666-666666666666',
  startsAt: '2026-09-01T06:00:00.000Z',
  endsAt: '2026-09-01T07:00:00.000Z',
  price: { amountMinor: 3500, currency: 'EUR' },
  clientNote: null,
  rescheduledFromId: null,
  cancelledAt: null,
  cancelledBy: null,
};

function contexteAnnulation(
  tenantSlug: string,
  appointmentId: string,
): Parameters<typeof annuler>[1] {
  return { params: Promise.resolve({ tenantSlug, appointmentId }) };
}

function contexteReservation(tenantSlug: string): Parameters<typeof reserver>[1] {
  return { params: Promise.resolve({ tenantSlug }) };
}

/** La requête de l'annulation — son corps n'est pas lu, l'identifiant est dans le chemin. */
function requeteNue(): Request {
  return new Request('http://site.test', { method: 'POST' });
}

function requeteReservation(body: unknown = DEMANDE): Request {
  return new Request('http://site.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Un corps que `request.json()` ne sait pas lire — le refus qui précède le schéma. */
function requeteIllisible(): Request {
  return new Request('http://site.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'ceci n’est pas du JSON',
  });
}

/** Ce qu'un refus rend, sans transtyper : son statut, son code et sa phrase. */
async function refusDe(
  response: Response,
): Promise<{ statut: number; code: string; message: string }> {
  const corps: unknown = await response.json();
  const lu = corps as Partial<{ ok: boolean; code: string; message: string }>;

  return {
    statut: response.status,
    code: lu.ok === true ? 'ok' : (lu.code ?? 'sans code'),
    message: lu.message ?? '',
  };
}

/**
 * Un libellé du catalogue, lu là où la route le lit — le même `loadMessages` que
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

beforeEach(() => {
  jar.set('spa_account_access', JETON);
  cancelAppointment.mockResolvedValue({ ...PRIS, status: 'cancelled' });
  bookGuestAppointment.mockResolvedValue(PRIS);
});

afterEach(() => {
  jar.clear();
  vi.clearAllMocks();
  fixerLangue('fr');
});

describe('la route d’annulation juge l’établissement seul et en premier', () => {
  it('rend `TENANT_NOT_FOUND` en 404, identifiant valable', async () => {
    const refus = await refusDe(await annuler(requeteNue(), contexteAnnulation(SLUG_ILLISIBLE, RENDEZ_VOUS)));

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.statut).toBe(404);
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('le rend aussi quand l’identifiant refuse avec lui — le `||` est défait', async () => {
    // Le cas que l'ancien `if` tranchait au gré de l'ordre de ses tests. C'est ici
    // que se mesure « le slug se juge seul et en premier ».
    const refus = await refusDe(
      await annuler(requeteNue(), contexteAnnulation(SLUG_ILLISIBLE, ID_ILLISIBLE)),
    );

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.statut).toBe(404);
  });

  it('le rend avant même d’ouvrir la session, cookies absents', async () => {
    // L'ordre des gardes, éprouvé et non supposé : sans cette précaution, une
    // adresse illisible se serait dite « session expirée » dès que le navigateur
    // n'aurait plus eu de cookie — et aurait renvoyé se connecter pour un segment
    // d'URL. Le même ordre que les six sites de #1379.
    jar.clear();

    const refus = await refusDe(
      await annuler(requeteNue(), contexteAnnulation(SLUG_ILLISIBLE, RENDEZ_VOUS)),
    );

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.code).not.toBe(ERROR_CODES.UNAUTHORIZED);
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe('le refus de l’identifiant du rendez-vous garde son code et son 400', () => {
  it('rend `VALIDATION_ERROR` en 400, établissement lisible', async () => {
    const refus = await refusDe(await annuler(requeteNue(), contexteAnnulation(SLUG, ID_ILLISIBLE)));

    expect(refus.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(refus.statut).toBe(400);
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('et les deux gardes laissent passer ce qu’elles doivent laisser passer', async () => {
    // La garde qui rend les cas ci-dessus non vides : séparer les deux `if` ne
    // ferme pas le chemin qui aboutit.
    const response = await annuler(requeteNue(), contexteAnnulation(SLUG, RENDEZ_VOUS));

    expect(response.status).toBe(200);
    expect(cancelAppointment).toHaveBeenCalledWith(SLUG, RENDEZ_VOUS, JETON);
  });
});

describe('la route de réservation juge l’établissement seul et en premier', () => {
  it('rend `TENANT_NOT_FOUND` en 404, corps valable', async () => {
    const refus = await refusDe(
      await reserver(requeteReservation(), contexteReservation(SLUG_ILLISIBLE)),
    );

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.statut).toBe(404);
    expect(bookGuestAppointment).not.toHaveBeenCalled();
  });

  it('le rend aussi quand le schéma refuse le corps', async () => {
    const refus = await refusDe(
      await reserver(requeteReservation(DEMANDE_INVALIDE), contexteReservation(SLUG_ILLISIBLE)),
    );

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.statut).toBe(404);
  });

  it('le rend sans même lire le corps, quand celui-ci est illisible', async () => {
    const refus = await refusDe(await reserver(requeteIllisible(), contexteReservation(SLUG_ILLISIBLE)));

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.statut).toBe(404);
  });

  it('le rend avant même d’ouvrir la session, cookies absents', async () => {
    jar.clear();

    const refus = await refusDe(
      await reserver(requeteReservation(), contexteReservation(SLUG_ILLISIBLE)),
    );

    expect(refus.code).toBe(ERROR_CODES.TENANT_NOT_FOUND);
    expect(refus.code).not.toBe(ERROR_CODES.UNAUTHORIZED);
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe('le refus du corps de la réservation garde son code et son 400', () => {
  it('rend `VALIDATION_ERROR` en 400, établissement lisible', async () => {
    const refus = await refusDe(
      await reserver(requeteReservation(DEMANDE_INVALIDE), contexteReservation(SLUG)),
    );

    expect(refus.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(refus.statut).toBe(400);
    expect(bookGuestAppointment).not.toHaveBeenCalled();
  });

  it('et le chemin qui aboutit aboutit toujours', async () => {
    const response = await reserver(requeteReservation(), contexteReservation(SLUG));

    expect(response.status).toBe(201);
    expect(bookGuestAppointment).toHaveBeenCalled();
  });
});

/**
 * Le partage des phrases, dans les deux langues — quatrième critère du ticket, du
 * côté qui *fabrique* le refus. L'autre suite le tient du côté qui l'*affiche*.
 *
 * Le `message` n'est plus ce que l'écran montre — il garde le code et réécrit la
 * phrase à chaque rendu (#1354) —, mais il reste ce que le contrat JSON de ces deux
 * routes promet, et il est le diagnostic que l'onglet réseau et les journaux donnent
 * à lire.
 */
describe.each([...LOCALES])('la phrase de chaque refus, en « %s »', (locale) => {
  it('l’établissement illisible tient la sienne du contrat partagé, à l’annulation', async () => {
    fixerLangue(locale);

    const refus = await refusDe(
      await annuler(requeteNue(), contexteAnnulation(SLUG_ILLISIBLE, RENDEZ_VOUS)),
    );
    const attendue = errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);

    expect(refus.message).toBe(attendue);
    // La garde qui rend l'égalité non vide : ce n'est plus la phrase du geste, qui
    // est ce que cette route disait avant ce ticket.
    expect(attendue).not.toBe(libelle(locale, 'account.errors.invalidCancellation'));
  });

  it('et la même à la réservation', async () => {
    fixerLangue(locale);

    const refus = await refusDe(
      await reserver(requeteReservation(), contexteReservation(SLUG_ILLISIBLE)),
    );
    const attendue = errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);

    expect(refus.message).toBe(attendue);
    expect(attendue).not.toBe(libelle(locale, 'booking.tunnel.actions.bookingIncomplete'));
  });

  it('l’identifiant du rendez-vous garde la sienne, du catalogue de l’espace client', async () => {
    fixerLangue(locale);

    const refus = await refusDe(await annuler(requeteNue(), contexteAnnulation(SLUG, ID_ILLISIBLE)));
    const attendue = libelle(locale, 'account.errors.invalidCancellation');

    expect(refus.message).toBe(attendue);
    // Ce que le contrat aurait dit à sa place, et qui ne nomme pas la demande :
    // c'est la moitié de la décision qu'un basculement complet aurait perdue.
    expect(attendue).not.toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });

  it('le corps de la réservation garde la sienne, du catalogue du tunnel', async () => {
    fixerLangue(locale);

    const refus = await refusDe(
      await reserver(requeteReservation(DEMANDE_INVALIDE), contexteReservation(SLUG)),
    );
    const attendue = libelle(locale, 'booking.tunnel.actions.bookingIncomplete');

    expect(refus.message).toBe(attendue);
    expect(attendue).not.toBe(errorMessage(ERROR_CODES.VALIDATION_ERROR, locale));
  });
});
