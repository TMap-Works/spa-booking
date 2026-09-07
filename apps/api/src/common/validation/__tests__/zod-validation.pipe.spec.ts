/**
 * Le pipe qui monte un schéma du contrat partagé sur un handler (ADR 0008).
 *
 * Ce que cette suite tient, et que rien d'autre ne tient : la substitution
 * décrite par l'ADR ne change **rien de visible** pour un appelant. Trois
 * propriétés y suffisent, et chacune correspond à une garantie que le
 * `ValidationPipe` global assurait avant elle :
 *
 * 1. la valeur rendue est celle du schéma, **transformations comprises** — c'est
 *    ce qui remplace `transform: true` ;
 * 2. un champ inconnu est **refusé**, pas ignoré — c'est ce qui remplace
 *    `forbidNonWhitelisted`, et c'est une propriété d'isolation
 *    (tenant-isolation §2) ;
 * 3. le refus a la forme que `DomainExceptionFilter` sait servir en
 *    `VALIDATION_ERROR` — c'est ce qui permet de substituer les routes une par
 *    une sans qu'aucun client ne voie la frontière bouger.
 */

import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../zod-validation.pipe';

const schema = z
  .object({
    email: z.string().trim().toLowerCase().email({ message: 'adresse e-mail invalide' }),
    nested: z.object({ count: z.number().int() }).strict().optional(),
  })
  .strict();

/** Le tableau de messages que le pipe a levé, ou l'échec si rien n'a été levé. */
function violationsFor(body: unknown): string[] {
  try {
    new ZodValidationPipe(schema).transform(body);
  } catch (error) {
    const payload = (error as BadRequestException).getResponse() as { message: string[] };

    return payload.message;
  }

  throw new Error('la frontière a laissé passer un corps qu’elle devait refuser');
}

describe('ZodValidationPipe', () => {
  it('rend la valeur transformée par le schéma, et non la valeur reçue', () => {
    const parsed = new ZodValidationPipe(schema).transform({ email: '  Camille@Example.TEST ' });

    expect(parsed.email).toBe('camille@example.test');
  });

  it('refuse un champ inconnu plutôt que de l’ignorer', () => {
    // C'est exactement le scénario de fuite que `forbidNonWhitelisted` fermait :
    // un `tenantId` glissé dans un corps JSON ne doit jamais traverser.
    expect(violationsFor({ email: 'camille@example.test', tenantId: 'x' })).toContainEqual(
      expect.stringContaining('tenantId'),
    );
  });

  it('lève une BadRequestException dont le corps porte un tableau de messages', () => {
    // La forme exacte que `DomainExceptionFilter` reconnaît pour produire
    // `{ code: "VALIDATION_ERROR", details: { violations: [...] } }`.
    let caught: unknown = null;

    try {
      new ZodValidationPipe(schema).transform({ email: 'pas-une-adresse' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getStatus()).toBe(400);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      message: expect.arrayContaining([expect.stringContaining('adresse e-mail invalide')]),
    });
  });

  it('nomme le champ fautif, chemin imbriqué compris', () => {
    expect(violationsFor({ email: 'camille@example.test', nested: { count: 1.5 } })).toEqual([
      expect.stringContaining('nested.count : '),
    ]);
  });

  it('laisse un refus posé sur la racine sans préfixe de champ orphelin', () => {
    const rootRefusal = z
      .object({ from: z.number(), to: z.number() })
      .strict()
      .refine((value) => value.to >= value.from, { message: 'la fin précède le début' });

    let messages: string[] = [];

    try {
      new ZodValidationPipe(rootRefusal).transform({ from: 2, to: 1 });
    } catch (error) {
      messages = ((error as BadRequestException).getResponse() as { message: string[] }).message;
    }

    expect(messages).toEqual(['la fin précède le début']);
  });

  it('refuse au montage un schéma d’objet qui n’est pas `.strict()`', () => {
    // À l'amorçage, sur une ligne de code — pas à la première requête d'un
    // appelant qui aurait deviné le nom d'un champ.
    expect(() => new ZodValidationPipe(z.object({ email: z.string() }))).toThrow(TypeError);
  });

  it('accepte un schéma sans clé possible — une énumération, un tableau', () => {
    expect(() => new ZodValidationPipe(z.enum(['upcoming', 'past']))).not.toThrow();
    expect(() => new ZodValidationPipe(z.array(z.string()))).not.toThrow();
  });

  it('voit à travers un `.refine()` — l’enveloppe ne fait pas taire la garde', () => {
    // `ZodEffects` masque le `ZodObject` qu'il enrobe. S'arrêter à l'enveloppe
    // rendrait la garde muette sur tout schéma portant une règle inter-champs —
    // `appointmentListQuerySchema` en est un —, et il n'y a plus de
    // `forbidNonWhitelisted` derrière elle pour rattraper l'oubli.
    const laxe = z
      .object({ from: z.number(), to: z.number() })
      .refine((value) => value.to >= value.from);

    expect(() => new ZodValidationPipe(laxe)).toThrow(TypeError);

    const strict = z
      .object({ from: z.number(), to: z.number() })
      .strict()
      .refine((value) => value.to >= value.from);

    expect(() => new ZodValidationPipe(strict)).not.toThrow();
  });
});
