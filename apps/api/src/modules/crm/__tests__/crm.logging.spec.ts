import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { redact } from '../../../common/logging/redaction';
import { CustomerEmailTakenError } from '../crm.errors';
import { toCustomerDto } from '../dto/customer.dto';

/**
 * « Aucune donnée personnelle dans les logs » — le cinquième critère de #56, et
 * le seul qui ne se prouve pas en appelant une route.
 *
 * Le module tout entier ne manipule que des données personnelles : nom, adresse,
 * numéro, et une note de texte libre qu'un humain a saisie sur une cliente. La
 * garantie ne peut donc pas reposer sur « ne pas journaliser ce qu'il ne faut
 * pas » — elle repose sur deux propriétés, et cette suite les vérifie toutes les
 * deux :
 *
 * 1. **le module ne journalise rien du tout.** Ni logger injecté, ni `console`.
 *    Ce qui n'est pas écrit ne peut pas fuiter, et c'est plus sûr que de
 *    compter sur une rédaction en aval ;
 * 2. **la rédaction couvrirait quand même chacun des champs du module**, si un
 *    jour quelque chose en journalisait un. C'est la ceinture, le point 1 est
 *    les bretelles.
 *
 * ## Pourquoi un test qui relit le code source
 *
 * Parce que la propriété est une **absence**, et qu'une absence ne se teste pas
 * en exerçant un chemin : il n'y a pas d'appel à observer. Le seul témoin
 * possible est le texte du module. Le procédé a un précédent direct dans ce
 * dépôt — `appointment-status.spec.ts` relit le SQL d'une migration, et
 * `roles.spec.ts` relit l'énumération générée — pour la même raison : verrouiller
 * ce que le système de types ne sait pas dire.
 */

const MODULE_DIR = join(__dirname, '..');

/** Les sources du module, tests exclus — ce sont eux qui doivent être muets. */
function moduleSources(directory: string = MODULE_DIR): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : moduleSources(path);
    }
    return entry.endsWith('.ts') ? [path] : [];
  });
}

describe('le module ne journalise rien', () => {
  const sources = moduleSources();

  it('trouve bien les sources qu’il prétend relire', () => {
    // Sans cette borne, un renommage de dossier viderait la suite et la rendrait
    // verte sans avoir rien lu — le pire résultat pour un test d'absence.
    expect(sources.length).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['un logger applicatif', /StructuredLogger|LoggingModule|\bLogger\b/],
    ['la console', /\bconsole\s*\./],
  ])('n’emploie pas %s', (_label, pattern) => {
    const offenders = sources.filter((path) => pattern.test(readFileSync(path, 'utf8')));

    expect(offenders.map((path) => path.slice(MODULE_DIR.length + 1))).toEqual([]);
  });
});

describe('la rédaction couvrirait les champs du module', () => {
  it('masque nom, prénom, adresse, numéro et note d’une fiche', () => {
    const fiche = toCustomerDto({
      id: '11111111-1111-4111-8111-111111111111',
      firstName: 'Alice',
      lastName: 'Durand',
      email: 'alice@example.test',
      phone: '+261341234567',
      isActive: true,
      internalNote: 'allergique au monoï',
      createdAt: new Date('2026-09-01T08:00:00.000Z'),
    });

    const serialise = JSON.stringify(redact(fiche));

    for (const secret of ['Alice', 'Durand', 'alice@example.test', '+261341234567', 'monoï']) {
      expect({ secret, present: serialise.includes(secret) }).toEqual({ secret, present: false });
    }

    // L'identifiant et l'état, eux, restent lisibles : ce sont eux qui rendent
    // un journal diagnostiquable, et ni l'un ni l'autre n'est personnel.
    expect(serialise).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('n’a aucune donnée personnelle à masquer dans l’erreur de conflit', () => {
    const erreur = new CustomerEmailTakenError();

    // Le message ne nomme pas l'adresse en cause, et `details` est vide : le
    // corps d'erreur est précisément l'endroit d'où une donnée personnelle
    // repartirait vers un journal d'accès ou une capture d'écran de ticket.
    expect(erreur.details).toEqual({});
    expect(erreur.message).not.toMatch(/@/);
  });
});
