/**
 * Le corps **absent** des routes qui n'en exigent aucun (#510).
 *
 * ## Ce que cette suite prouve, et que rien d'autre ne prouve
 *
 * La substitution des DTO par les schémas du contrat déplace la validation d'un
 * pipe qui **normalisait** un corps nul vers un pipe qui ne le normalisait pas.
 * `ValidationPipe.toEmptyIfNil` ne s'applique qu'aux paramètres dont la
 * métadonnée est une classe à valider ; le paramètre du handler est désormais
 * typé par un alias, dont la métadonnée émise est `Object`. Express 5 et
 * body-parser 2, eux, laissent `req.body` à `undefined` quand la requête ne
 * porte aucun en-tête `Content-Type`.
 *
 * L'annulation n'a **aucun** champ obligatoire et répondait 200 à une requête
 * sans corps, des deux côtés du comptoir. C'est `optionalBody` qui le tient
 * désormais, et c'est ici que la propriété se garde : aucune suite
 * d'intégration ne l'attrape, `supertest.send(...)` posant toujours un type de
 * contenu. Le pendant côté catalogue vit dans
 * `catalog/__tests__/optional-body.spec.ts`.
 */

import { BadRequestException } from '@nestjs/common';

import { cancelAppointmentBody } from '../dto/cancel-appointment.dto';
import { changeAppointmentStatusBody } from '../dto/change-appointment-status.dto';

describe('annulation sans corps', () => {
  it('se lit comme une annulation sans motif', () => {
    expect(cancelAppointmentBody.transform(undefined)).toEqual({});
    expect(cancelAppointmentBody.transform(null)).toEqual({});
  });

  it('refuse toujours un champ inconnu — l’enveloppe ne relâche pas `.strict()`', () => {
    // C'est la garde que `forbidNonWhitelisted` tenait : un `tenantId` glissé
    // dans le corps est **refusé**, pas silencieusement ignoré
    // (tenant-isolation §2). L'envelopper d'un `preprocess` ne doit rien y
    // changer — `ZodValidationPipe` déballe les `ZodEffects` avant de vérifier,
    // et refuserait au montage un schéma qui ne serait pas `.strict()`.
    expect(() => cancelAppointmentBody.transform({ tenantId: 'x' })).toThrow(BadRequestException);
    expect(() => cancelAppointmentBody.transform({ cancelledBy: 'CLIENT' })).toThrow(
      BadRequestException,
    );
  });
});

describe('changement de statut sans corps', () => {
  it('reste refusé en 400 — le statut est obligatoire', () => {
    // Ce corps-ci n'est **pas** enveloppé, et c'est délibéré : une transition
    // sans destination n'a pas de sens, et la route la refusait déjà. Ce que la
    // substitution change est le libellé — « Required » sur la racine plutôt
    // que le nom du champ —, sur une requête qui ne porte aucun corps du tout.
    // Le cas courant, un corps JSON sans `status`, nomme bien le champ.
    expect(() => changeAppointmentStatusBody.transform(undefined)).toThrow(BadRequestException);

    expect(refusalFor(() => changeAppointmentStatusBody.transform({}))).toEqual([
      expect.stringContaining('status : '),
    ]);
  });
});

/**
 * Les messages de refus d'un pipe, ou l'échec explicite s'il a laissé passer.
 *
 * `getResponse()` rend l'enveloppe que Nest compose autour du tableau de
 * messages — c'est son champ `message` que `DomainExceptionFilter` sert en
 * `details.violations`.
 */
function refusalFor(attempt: () => unknown): string[] {
  try {
    attempt();
  } catch (error) {
    if (error instanceof BadRequestException) {
      return (error.getResponse() as { message: string[] }).message;
    }
    throw error;
  }

  throw new Error('le pipe a laissé passer un corps qu’il devait refuser');
}
