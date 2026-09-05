import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Les frontières internes du module, vérifiées plutôt qu'espérées (#410).
 *
 * #57 et #58 ont été écrites en parallèle et ont laissé `payments` en deux
 * moitiés qui ne se connaissaient pas. La consolidation a fondu ce qui n'avait
 * pas de raison d'être séparé — une seule `StripeConfig`, un seul
 * `payments.errors.ts` — et a **gardé** le découpage des dépôts, parce qu'un
 * critère le porte.
 *
 * Ce critère, c'est cette suite qui l'empêche de redevenir une simple intention
 * écrite dans un commentaire. Elle lit les sources du module, ce qui est
 * inhabituel et se justifie par ce qu'elle protège : une propriété de
 * **structure**, qu'aucun appel ne peut exercer. Un test qui monterait le module
 * ne verrait rien — un second dépôt recevant le client non scopé compilerait,
 * passerait ses tests, et n'échouerait qu'au jour d'une fuite entre
 * établissements.
 */

const MODULE_DIR = join(__dirname, '..');

/** Le jeton du client Prisma **non scopé** — l'unique dérogation inter-tenant du module. */
const UNSCOPED_TOKEN = 'PRISMA_UNSCOPED';

/**
 * Le seul fichier du module autorisé à le citer.
 *
 * Un webhook Stripe n'arrive ni avec un jeton ni avec un slug : il faut résoudre
 * l'établissement **avant** qu'une portée de tenant existe, et c'est la seule
 * lecture légitimement inter-tenant de tout le module (tenant-isolation §3).
 */
const AUTHORISED_HOLDER = 'stripe-webhook.repository.ts';

/**
 * Le fichier privé de ses commentaires.
 *
 * Sans cela, la règle interdirait de l'**expliquer** : `payments.module.ts`
 * nomme la dérogation dans son en-tête, et c'est exactement ce qu'on veut qu'il
 * fasse. Ce qui est proscrit est de la *détenir* — un import, une injection —,
 * pas d'en parler.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Les fichiers de source du module, tests exclus — récursivement. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }

    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('module payments — frontières internes', () => {
  it('confine le client Prisma non scopé au dépôt du webhook', () => {
    // Fondre `StripeWebhookRepository` dans `PaymentsRepository` — la lecture
    // paresseuse du critère « un seul repository » — mettrait `PRISMA_UNSCOPED`
    // dans le constructeur qui sert le tunnel public et le comptoir. C'est
    // exactement ce que tenant-isolation §3 demande de garder nommé, justifié et
    // confiné : la dérogation doit rester la propriété d'une classe qu'on peut
    // relire d'un seul tenant.
    const holders = sourceFiles(MODULE_DIR)
      .filter((path) => code(path).includes(UNSCOPED_TOKEN))
      .map((path) => path.slice(MODULE_DIR.length + 1).replace(/\\/g, '/'));

    expect(holders).toEqual([AUTHORISED_HOLDER]);
  });

  it('ne laisse qu’un seul fichier d’erreurs et qu’une seule porte de configuration Stripe', () => {
    // Le premier et le troisième critère de #410, rendus exécutables. Les deux
    // duplications venaient du parallélisme de #57 et #58 ; rien n'empêcherait
    // un ticket pressé de les recréer, sinon ceci.
    const names = sourceFiles(MODULE_DIR).map((path) =>
      path.slice(MODULE_DIR.length + 1).replace(/\\/g, '/'),
    );

    expect(names.filter((name) => name.endsWith('.errors.ts'))).toEqual(['payments.errors.ts']);
    expect(names.filter((name) => name.endsWith('.config.ts'))).toEqual(['stripe/stripe.config.ts']);
  });
});
