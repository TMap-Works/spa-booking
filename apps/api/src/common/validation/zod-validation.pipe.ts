import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { type ZodError, type ZodTypeAny, ZodEffects, ZodObject, type z } from 'zod';

/**
 * Monte un schéma du contrat partagé comme validateur d'un paramètre de handler
 * ([ADR 0008](../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 *
 * ## Ce qu'il remplace, et ce qu'il ne remplace pas
 *
 * Il remplace **la validation** que `class-validator` faisait sur une classe
 * DTO. Il ne remplace pas la classe : elle reste la porteuse des décorateurs
 * `@nestjs/swagger` d'où sort `/api/docs`, et le handler la déclare désormais
 * par `@ApiBody({ type: … })` plutôt qu'en typant son paramètre.
 *
 * ## Pourquoi le pipe global ne gêne pas
 *
 * `app.module.ts` monte un `ValidationPipe` global. Il s'applique d'abord, sur la
 * **métadonnée** du paramètre — et un paramètre typé par un alias de type (ce
 * qu'est `z.infer<…>`) émet `Object`, que `ValidationPipe` laisse passer sans le
 * regarder. Les deux régimes cohabitent donc pendant toute la durée de la
 * reprise, module par module.
 *
 * Le corollaire est un piège à connaître : typer le paramètre par la **classe**
 * DTO ferait rejouer le pipe global sur une classe qui n'a plus aucun
 * décorateur, et `whitelist` viderait le corps de tous ses champs. C'est ce que
 * la garde `.strict()` ci-dessous ne pourrait pas rattraper — d'où le type de
 * retour, qui est celui du schéma et non celui d'une classe.
 *
 * ## La forme du refus est celle qui existait déjà
 *
 * `ValidationPipe` lève une `BadRequestException` portant un **tableau** de
 * messages, que `DomainExceptionFilter` reconnaît et sert en
 * `{ code: "VALIDATION_ERROR", message: "La requête est invalide.",
 * details: { violations: […] } }`. Ce pipe lève exactement la même chose : un
 * client ne peut pas distinguer une route substituée d'une route qui ne l'est
 * pas encore, et c'est la condition pour que la reprise se fasse par étapes.
 *
 * Les messages citent des **noms de champs**, jamais les valeurs reçues — comme
 * ceux de class-validator, et pour la même raison : un corps d'erreur finit dans
 * les journaux du front, où une adresse e-mail n'a rien à faire.
 */
export class ZodValidationPipe<TSchema extends ZodTypeAny>
  implements PipeTransform<unknown, z.infer<TSchema>>
{
  public constructor(private readonly schema: TSchema) {
    assertRefusesUnknownKeys(schema);
  }

  public transform(value: unknown): z.infer<TSchema> {
    const parsed = this.schema.safeParse(value);

    if (!parsed.success) {
      throw new BadRequestException(violationsOf(parsed.error));
    }

    return parsed.data as z.infer<TSchema>;
  }
}

/**
 * Refuse au montage un schéma d'entrée qui laisserait passer un champ inconnu.
 *
 * C'est la propriété que `forbidNonWhitelisted` tenait sur le pipe global, et
 * elle n'est pas décorative : un `tenantId` glissé dans un corps JSON doit être
 * **rejeté**, pas silencieusement ignoré (tenant-isolation §2). Zod ignore par
 * défaut les clés qu'il ne connaît pas ; seul `.strict()` les refuse.
 *
 * La vérification a lieu à la construction — donc à l'amorçage de
 * l'application, sur une ligne de code, et non à la première requête d'un
 * appelant qui aurait deviné le nom d'un champ.
 *
 * Un schéma qui n'est pas un objet (une énumération, un tableau) n'a pas de clé
 * inconnue possible : il passe.
 *
 * Un objet enveloppé dans un `.refine()`, en revanche, est **déballé** avant
 * d'être jugé : `ZodEffects` masque le `ZodObject` qu'il enrobe, et s'arrêter à
 * l'enveloppe ferait taire la garde exactement sur les schémas qui portent une
 * règle inter-champs — `appointmentListQuerySchema` en est un, et c'est l'un des
 * premiers que la reprise de #510 montera. Une garde qui ne dit rien sur la
 * moitié des schémas qu'on lui présente n'est pas une garde : ici il n'y a plus
 * de `forbidNonWhitelisted` derrière elle pour rattraper l'oubli.
 */
function assertRefusesUnknownKeys(schema: ZodTypeAny): void {
  const unwrapped = unwrapEffects(schema);

  if (unwrapped instanceof ZodObject && unwrapped._def.unknownKeys !== 'strict') {
    throw new TypeError(
      'ZodValidationPipe : un schéma d’entrée doit être `.strict()` — sans quoi un champ ' +
        'inconnu (un `tenantId`, par exemple) traverserait la frontière sans être refusé.',
    );
  }
}

/** Le schéma sous ses `.refine()` / `.transform()` successifs, s'il y en a. */
function unwrapEffects(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;

  while (current instanceof ZodEffects) {
    current = current._def.schema as ZodTypeAny;
  }

  return current;
}

/**
 * Les refus d'un schéma, sous la forme `champ : message` qu'emploient déjà les
 * messages de ce dépôt.
 *
 * Le chemin est joint par des points pour porter l'imbrication —
 * `client.email` —, ce que les messages plats de class-validator ne faisaient
 * pas toujours. Un refus posé sur la racine (le `.refine()` d'un schéma entier)
 * n'a pas de chemin : son message part seul, sans préfixe orphelin.
 */
function violationsOf(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');

    return path === '' ? issue.message : `${path} : ${issue.message}`;
  });
}
