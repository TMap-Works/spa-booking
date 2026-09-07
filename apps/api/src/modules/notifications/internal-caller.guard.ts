import { createHash, timingSafeEqual } from 'node:crypto';

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { INTERNAL_TOKEN_HEADER, NotificationsConfig } from './notifications.config';
import { InternalCallerRejectedError, InternalCallerUnconfiguredError } from './notifications.errors';

/**
 * La garde des routes **internes** de la chaîne de notifications (#71).
 *
 * ## Ce qu'elle protège, et pourquoi ce n'est pas `@AuthAtLeast`
 *
 * L'appelant n'est pas une personne : c'est une fonction Lambda, déclenchée par
 * EventBridge Scheduler, qui n'a ni compte, ni rôle, ni établissement. Lui faire
 * porter un JWT aurait voulu dire un utilisateur de service en base — donc un
 * compte à faire tourner, à ne pas confondre avec une gérante, et rattaché à un
 * tenant alors que le balayage les traverse tous.
 *
 * Le jeton partagé est la forme juste ici, et c'est déjà celle que la Lambda
 * d'envoi de #67 présente (`x-internal-token`). Ce que la garde établit n'est
 * pas « qui appelle » mais « l'appel vient de notre infrastructure », ce qui est
 * exactement la question posée.
 *
 * ## Elle ne résout aucun tenant, et c'est le propos
 *
 * Une route interne passe la garde **sans** portée de tenant résolue. C'est
 * voulu : le balayage ouvre lui-même une portée par établissement, et la seule
 * lecture non scopée du module est confinée à `ReminderSweepRepository`. Une
 * garde qui aurait posé un tenant aurait posé le mauvais.
 *
 * ## La comparaison est à temps constant, sur des condensats
 *
 * Une égalité de chaînes s'arrête au premier caractère qui diffère : le temps de
 * réponse dit alors combien de caractères sont bons, et un attaquant reconstruit
 * le secret octet par octet. `timingSafeEqual` corrige cela, mais exige deux
 * tampons de **même longueur** — et lever sur une longueur différente
 * réintroduit la fuite, en révélant la taille du secret.
 *
 * Comparer les condensats SHA-256 résout les deux d'un coup : ils font toujours
 * 32 octets, quelle que soit l'entrée. Le condensat n'est pas ici une protection
 * du secret au repos — il n'est jamais stocké —, c'est un **égaliseur de
 * longueur**.
 */
@Injectable()
export class InternalCallerGuard implements CanActivate {
  public constructor(private readonly config: NotificationsConfig) {}

  public canActivate(context: ExecutionContext): boolean {
    const expected = this.config.expectedInternalToken;

    if (expected === null) {
      // Défaut fermé. Sans jeton attendu, aucun jeton présenté ne peut être
      // reconnu : accepter reviendrait à ouvrir la route à tout le monde, et
      // c'est la faute que ce refus rend impossible.
      throw new InternalCallerUnconfiguredError();
    }

    const request = context.switchToHttp().getRequest<{
      readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    }>();

    const presented = request.headers[INTERNAL_TOKEN_HEADER];

    // Un en-tête répété arrive sous forme de tableau. On ne choisit pas
    // « lequel » : deux valeurs pour un secret est une requête malformée, pas
    // une requête à interpréter.
    if (typeof presented !== 'string' || !matches(presented, expected)) {
      throw new InternalCallerRejectedError();
    }

    return true;
  }
}

/** Égalité à temps constant, longueurs égalisées par le condensat. */
function matches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
