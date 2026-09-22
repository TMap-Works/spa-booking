import { Controller, type MessageEvent, Sse } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { APPOINTMENT_FEED_EVENT, APPOINTMENT_FEED_HEARTBEAT } from '@spa/shared';
import { Observable } from 'rxjs';

import { Auth } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { AppointmentFeed, type AppointmentFeedAudience } from './appointment-feed.service';

/**
 * Battement de cœur du flux, en millisecondes.
 *
 * Sous les soixante secondes d'inactivité après lesquelles un répartiteur de
 * charge AWS coupe une connexion par défaut, avec de la marge : un planning
 * ouvert toute la journée sans réservation ne doit pas perdre son flux à la
 * première minute creuse.
 */
export const FEED_HEARTBEAT_MS = 25_000;

/**
 * Durée de vie d'une connexion, en millisecondes.
 *
 * Le jeton d'accès n'est vérifié qu'à l'ouverture : une connexion éternelle
 * survivrait à son expiration, à une déconnexion, à un compte désactivé. Au bout
 * de dix minutes — sous le quart d'heure du jeton d'accès —, le flux se referme
 * et le navigateur se reconnecte de lui-même, en présentant un jeton neuf.
 */
export const FEED_LIFETIME_MS = 10 * 60_000;

/**
 * Délai de reconnexion suggéré au navigateur, en millisecondes — le champ
 * `retry:` du protocole.
 */
export const FEED_RETRY_MS = 3_000;

/**
 * Le flux temps réel des rendez-vous — `GET /v1/appointments/stream`.
 *
 * Voir `appointment-feed.service.ts` pour ce qu'il transporte et d'où, et
 * `packages/shared/src/schemas/appointment-feed.ts` pour le contrat.
 *
 * ## `@Auth()` sans argument
 *
 * Toute identité vérifiée : la gérante, le praticien **et** la cliente ont
 * chacun un écran qui doit se tenir à jour. Ce qui les distingue n'est pas
 * l'accès mais le **périmètre**, et il se dérive du jeton
 * (`AppointmentFeed.audienceOf`) — il n'y a aucun paramètre par lequel en
 * demander un autre.
 *
 * ## Un contrôleur à lui
 *
 * `AppointmentsController` rend du JSON et se teste comme tel ; cette route tient
 * une connexion ouverte et parle `text/event-stream`. Les mêler aurait fait
 * porter à un contrôleur de lectures et d'écritures la question du cycle de vie
 * d'une connexion.
 */
@ApiTags('appointments')
@Controller({ path: 'appointments/stream', version: '1' })
export class AppointmentFeedController {
  public constructor(private readonly feed: AppointmentFeed) {}

  @Sse()
  @Auth()
  @ApiOperation({
    summary: 'Suivre en temps réel les rendez-vous de son périmètre (Server-Sent Events)',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description:
      'Flux `text/event-stream`. Événement `appointment` : un `AppointmentFeedEvent` en JSON. ' +
      'Événement `ping` : battement de cœur, sans contenu. Le flux se referme au bout de ' +
      'dix minutes ; le navigateur se reconnecte seul.',
  })
  public async stream(@CurrentUser() user: AuthenticatedUser): Promise<Observable<MessageEvent>> {
    // Résolu **avant** de rendre le flux, pendant que la portée de tenant de la
    // requête est encore là : la fiche praticien se lit dedans.
    const audience = await this.feed.audienceOf(user);

    return feedStream(this.feed, audience);
  }
}

/**
 * Le flux d'une connexion : ses changements, un battement de cœur, une fin.
 *
 * Exporté pour les tests, qui en pilotent les minuteries.
 */
export function feedStream(
  feed: Pick<AppointmentFeed, 'watch'>,
  audience: AppointmentFeedAudience,
  timing: { readonly heartbeatMs: number; readonly lifetimeMs: number } = {
    heartbeatMs: FEED_HEARTBEAT_MS,
    lifetimeMs: FEED_LIFETIME_MS,
  },
): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    // Un premier message tout de suite : il porte le délai de reconnexion, et il
    // fait passer des octets avant la première minute — un intermédiaire qui
    // attend le corps pour relayer les en-têtes ne tient pas le navigateur en
    // suspens.
    subscriber.next({ type: APPOINTMENT_FEED_HEARTBEAT, data: '', retry: FEED_RETRY_MS });

    const stop = feed.watch(audience, (event) => {
      subscriber.next({ type: APPOINTMENT_FEED_EVENT, data: event });
    });

    const heartbeat = setInterval(() => {
      subscriber.next({ type: APPOINTMENT_FEED_HEARTBEAT, data: '' });
    }, timing.heartbeatMs);

    const end = setTimeout(() => {
      subscriber.complete();
    }, timing.lifetimeMs);

    return () => {
      stop();
      clearInterval(heartbeat);
      clearTimeout(end);
    };
  });
}
