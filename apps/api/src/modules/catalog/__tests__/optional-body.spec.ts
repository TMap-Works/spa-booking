/**
 * Le corps **absent** des deux `PATCH` du catalogue (#510).
 *
 * Pendant de `appointments/__tests__/optional-body.spec.ts`, dont l'en-tête
 * décrit ce que la substitution a déplacé : le `ValidationPipe` global ne
 * normalise plus un corps nul, le paramètre du handler n'étant plus typé par une
 * classe. `PATCH /services/{id}` et `PATCH /service-categories/{id}` n'ont aucun
 * champ obligatoire et répondaient 200 à une requête sans corps — un no-op, mais
 * un no-op qui réussissait.
 *
 * Les deux **créations**, elles, ne sont pas enveloppées : elles exigent un nom,
 * et leur refus reste un 400.
 */

import { BadRequestException } from '@nestjs/common';

import { createServiceCategoryBody, updateServiceCategoryBody } from '../dto/service-category.dto';
import { createServiceBody, updateServiceBody } from '../dto/service.dto';

describe('modification sans corps', () => {
  it('se lit comme un correctif vide', () => {
    expect(updateServiceBody.transform(undefined)).toEqual({});
    expect(updateServiceBody.transform(null)).toEqual({});
    expect(updateServiceCategoryBody.transform(undefined)).toEqual({});
  });

  it('refuse toujours un champ inconnu — l’enveloppe ne relâche pas `.strict()`', () => {
    // Un `tenantId` glissé dans le corps est **refusé**, pas silencieusement
    // ignoré (tenant-isolation §2) : `ZodValidationPipe` déballe les
    // `ZodEffects` avant de vérifier `.strict()`.
    expect(() => updateServiceBody.transform({ tenantId: 'x' })).toThrow(BadRequestException);
    expect(() => updateServiceCategoryBody.transform({ tenantId: 'x' })).toThrow(
      BadRequestException,
    );
  });

  it('garde le plafond de durée que le contrat ne porte pas', () => {
    // Le `.extend()` local survit à l'enveloppe : sans lui, `duration_minutes`
    // sortirait en `numeric value out of range` — un 500 là où l'appelant
    // recevait un 400 nommant le champ.
    expect(() => updateServiceBody.transform({ durationMinutes: 100_000 })).toThrow(
      BadRequestException,
    );
  });
});

describe('création sans corps', () => {
  it('reste refusée en 400', () => {
    expect(() => createServiceBody.transform(undefined)).toThrow(BadRequestException);
    expect(() => createServiceCategoryBody.transform(undefined)).toThrow(BadRequestException);
  });
});
