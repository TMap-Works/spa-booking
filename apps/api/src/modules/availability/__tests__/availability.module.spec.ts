import 'reflect-metadata';

import {
  AVAILABILITY_CACHE_STORE,
  AvailabilityCacheService,
} from '../availability-cache';
import { RedisAvailabilityCacheStore } from '../availability-cache.redis';
import { AvailabilityModule } from '../availability.module';
import { AvailabilityQueryService } from '../availability.query.service';
import { AvailabilityService } from '../availability.service';

/**
 * Le témoin de la frontière du cache — #35, cinquième critère.
 *
 * « Un cache périmé ne peut jamais provoquer une double réservation » n'est pas
 * une propriété qu'un test de comportement puisse établir : il faudrait
 * démontrer une **absence**, sur tous les chemins d'écriture présents et à
 * venir. Elle est en revanche exactement vérifiable sur le graphe d'injection,
 * parce qu'elle y tient à une seule chose :
 *
 * > `AvailabilityQueryService` — le seul à lire le cache — n'est pas exporté.
 *
 * Tant que c'est vrai, aucun module extérieur ne peut l'injecter, donc aucun
 * chemin d'écriture ne peut décider d'un créneau sur une réponse cachée. Le jour
 * où quelqu'un l'ajouterait à `exports` pour un besoin de lecture, cette suite
 * rougit — et c'est le bon moment pour se demander qui va le lire.
 *
 * C'est le même genre de témoin que `roles.spec.ts`, qui compare une liste du
 * code à l'énumération réellement générée : il ne prouve pas un comportement, il
 * verrouille une décision.
 */

/** Les clés que `@Module` pose sur la classe — voir `MODULE_METADATA` de Nest. */
function metadataOf(key: 'providers' | 'exports' | 'controllers'): unknown[] {
  return (Reflect.getMetadata(key, AvailabilityModule) as unknown[] | undefined) ?? [];
}

describe('AvailabilityModule', () => {
  it('n’exporte pas le service de lecture caché', () => {
    // La garantie du cinquième critère de #35, en une assertion.
    expect(metadataOf('exports')).not.toContain(AvailabilityQueryService);
  });

  it('exporte le moteur nu, celui que la réservation doit appeler', () => {
    expect(metadataOf('exports')).toContain(AvailabilityService);
  });

  it('exporte l’invalidation, dont les écritures d’agenda ont besoin', () => {
    // `appointments` écrit dans l'agenda : il doit pouvoir chasser le cache.
    // C'est la seule part du cache qui traverse la frontière du module.
    expect(metadataOf('exports')).toContain(AvailabilityCacheService);
  });

  it('déclare le service de lecture comme fournisseur privé', () => {
    // Privé, mais bien présent : les deux contrôleurs l'injectent.
    expect(metadataOf('providers')).toContain(AvailabilityQueryService);
  });

  it('branche l’entrepôt de cache sur Redis', () => {
    // #33 l'avait laissé sur son entrepôt inerte, en annonçant que #35
    // remplacerait cette ligne. C'est cette ligne-là.
    expect(metadataOf('providers')).toContainEqual({
      provide: AVAILABILITY_CACHE_STORE,
      useClass: RedisAvailabilityCacheStore,
    });
  });
});
