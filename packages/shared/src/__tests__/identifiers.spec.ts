/**
 * `uuidSchema` — la version d'UUID que le contrat accepte (#403, tranché
 * par #404).
 *
 * ## Ce que cette suite tient, et que rien d'autre ne tient
 *
 * Le schéma était `z.string().uuid()`, qui accepte **toutes** les versions, là
 * où tous les DTO de l'API validaient avec `@IsUUID('4')`. Depuis que le contrat
 * est monté comme validateur sur le tunnel public
 * ([ADR 0008](../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)),
 * ce schéma **est** la frontière : le laisser permissif aurait relâché ce que
 * l'API accepte, sans que rien ne le signale.
 *
 * La moitié API de la paire est
 * `apps/api/src/modules/appointments/__tests__/guest-booking-frontier.spec.ts`,
 * qui rejoue le refus à travers le pipe monté sur la route. Les deux ensemble
 * sont ce que le troisième critère de #403 demande : un cas de part et d'autre
 * de la frontière, pour rendre visible le jour où l'un des deux côtés bougerait
 * seul.
 */

import { UUID_V4_PATTERN, uuidSchema } from '../common/identifiers';

/** Un identifiant tel que `@default(uuid())` de Prisma en produit. */
const V4 = '2b0f3a1c-6a4d-4a2e-9d3b-8f7c1e5a4b21';

describe('uuidSchema', () => {
  it('accepte un UUID v4, la seule version que le produit émette', () => {
    expect(uuidSchema.parse(V4)).toBe(V4);
  });

  it('accepte la casse haute — un UUID n’est pas sensible à la casse', () => {
    expect(uuidSchema.safeParse(V4.toUpperCase()).success).toBe(true);
  });

  it.each([
    // v1 : horodaté, donc porteur de l'adresse MAC de la machine qui l'a émis.
    ['v1', '2b0f3a1c-6a4d-1a2e-9d3b-8f7c1e5a4b21'],
    // v7 : ordonnable dans le temps, donc partiellement énumérable — c'est
    // exactement la propriété que le choix de l'UUID sur un entier séquentiel
    // existe pour supprimer.
    ['v7', '2b0f3a1c-6a4d-7a2e-9d3b-8f7c1e5a4b21'],
    // Variante hors RFC 4122 : le cinquième groupe doit commencer par 8, 9, a ou b.
    ['variante invalide', '2b0f3a1c-6a4d-4a2e-1d3b-8f7c1e5a4b21'],
    // L'UUID nil, que `z.string().uuid()` acceptait : ce n'est l'identifiant
    // d'aucune ressource, c'est une valeur par défaut oubliée.
    ['nil', '00000000-0000-0000-0000-000000000000'],
  ])('refuse un UUID %s', (_label, value) => {
    expect(uuidSchema.safeParse(value).success).toBe(false);
  });

  it('refuse ce qui n’est pas un UUID du tout, en un seul message', () => {
    const refused = uuidSchema.safeParse('42');

    expect(refused.success).toBe(false);
    // Un seul `issue` : deux vérifications qui échouent ensemble feraient
    // afficher deux fois le même message sous le même champ d'un formulaire.
    // C'est la raison pour laquelle le motif remplace `.uuid()` au lieu de s'y
    // ajouter — même conduite que l'alternative `[^@]*$` d'`emailSchema`.
    expect(refused.error?.issues).toHaveLength(1);
    expect(refused.error?.issues[0]?.message).toBe('identifiant attendu au format UUID v4');
  });

  it('expose son motif, pour les surfaces qui valident sans Zod', () => {
    expect(UUID_V4_PATTERN.test(V4)).toBe(true);
    expect(UUID_V4_PATTERN.test('2b0f3a1c-6a4d-1a2e-9d3b-8f7c1e5a4b21')).toBe(false);
  });
});
