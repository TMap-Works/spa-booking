import { BadRequestException } from '@nestjs/common';

import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  readIdempotencyKey,
} from '../idempotency-key';

/**
 * La lecture de l'en-tête `Idempotency-Key` — #1027, troisième point.
 *
 * Ce que cette suite protège, et qui n'était protégé nulle part quand la
 * fonction vivait en deux exemplaires : la **forme du refus**. Un 400 dont le
 * `message` n'est pas un tableau sort du filtre d'exception sous une autre
 * forme que `{ code: "VALIDATION_ERROR", details.violations }`, et l'appelant
 * se retrouve avec deux 400 à traiter pour une seule faute.
 */

/** Le refus, lu tel que `DomainExceptionFilter` le lira. */
function refusalOf(raw: string | undefined): { message: string[] } {
  try {
    readIdempotencyKey(raw);
  } catch (error) {
    return (error as BadRequestException).getResponse() as { message: string[] };
  }

  throw new Error(`« ${String(raw)} » a été acceptée alors qu'elle devait être refusée`);
}

describe('readIdempotencyKey', () => {
  it('rend la clé élaguée — un en-tête recopié avec une espace est la même clé', () => {
    expect(readIdempotencyKey('  a1b2c3d4e5  ')).toBe('a1b2c3d4e5');
  });

  it.each<[string | undefined, string]>([
    [undefined, 'en-tête absent'],
    ['', 'en-tête vide'],
    ['       ', 'que des espaces — élaguée, elle ne reste rien'],
    ['a1b2c3d', `${String(IDEMPOTENCY_KEY_MIN_LENGTH - 1)} caractères, sous la borne basse`],
    ['k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1), 'au-delà de la largeur de la colonne'],
  ])('refuse « %s » — %s', (raw) => {
    expect(() => readIdempotencyKey(raw)).toThrow(BadRequestException);
  });

  it('accepte les deux bornes, qui sont incluses', () => {
    const shortest = 'k'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH);
    const longest = 'k'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH);

    expect(readIdempotencyKey(shortest)).toBe(shortest);
    expect(readIdempotencyKey(longest)).toBe(longest);
  });

  it('refuse sous la forme d’un rapport de validation, en nommant l’en-tête', () => {
    const response = refusalOf(undefined);

    expect(Array.isArray(response.message)).toBe(true);
    expect(response.message).toHaveLength(1);
    expect(response.message[0]).toContain(IDEMPOTENCY_HEADER);
    expect(response.message[0]).toContain(String(IDEMPOTENCY_KEY_MIN_LENGTH));
    expect(response.message[0]).toContain(String(IDEMPOTENCY_KEY_MAX_LENGTH));
  });

  /**
   * La borne haute est la largeur des deux colonnes qui portent la clé —
   * `platform_tenant_provisionings.idempotency_key` et
   * `payments.idempotency_key`, toutes deux `VARCHAR(128)`. Le témoin est ici
   * pour que l'élargissement d'une seule des deux ne passe pas inaperçu.
   */
  it('borne la clé à la largeur de la colonne qui la porte', () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });
});
