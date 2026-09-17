import { BadRequestException } from '@nestjs/common';
import { e164PhoneSchemaFor } from '@spa/shared';

/**
 * Forme canonique d'un numéro de téléphone — E.164, `+33612345678` (#824).
 *
 * Écrite **une fois**, et hors des services, pour la raison exacte qui a sorti
 * `normalizeEmail` d'`AuthService` : la règle doit être identique sur les six
 * portes que ce module sert — inscription, profil, compte du personnel,
 * invitation, fiche cliente au comptoir, réglages de l'établissement — sans quoi
 * elle ne sert à rien. Un numéro écrit « 06 12 34 56 78 » par une porte et
 * « +33612345678 » par une autre désigne la même personne sans qu'aucune
 * recherche par téléphone ne puisse les rapprocher, et le second seul est
 * composable par SNS (E.164 est ce qu'exige l'API SMS).
 *
 * La septième porte — la réservation **sans compte** — normalise déjà, et
 * ailleurs : `guestContactSchema` valide avec `e164PhoneSchema`, monté sur le
 * handler du tunnel public. Elle n'a donc pas de pays par défaut, et refuse
 * encore un national que `/auth/register` accepte désormais sur le même
 * établissement. L'écart est connu et assumé pour ce ticket : le combler demande
 * un pipe de validation à portée de requête (`apps/api/src/common/validation`),
 * le handler du tunnel (`apps/api/src/modules/appointments`) et son formulaire
 * (`apps/web`) — trois emplacements hors de l'empreinte de #824, et une issue de
 * suivi les porte.
 *
 * ## Pourquoi ici, et pas dans le schéma monté sur le handler
 *
 * Parce que le pays qui permet de compléter un numéro **national** est une
 * donnée de requête — `tenants.country_code` — et qu'un `ZodValidationPipe` est
 * construit à l'amorçage de l'application, une fois pour toutes. Le contrat
 * partagé porte donc la règle (`e164PhoneSchemaFor`), et c'est le service, qui a
 * lu l'établissement, qui l'instancie avec son pays. Sans cela il ne restait que
 * deux issues, toutes deux mauvaises : refuser tout numéro national — le défaut
 * que ce ticket corrige — ou deviner un pays, c'est-à-dire envoyer le rappel de
 * quelqu'un à un inconnu.
 *
 * ## Le refus a la forme d'un refus de validation
 *
 * `BadRequestException` avec un **tableau** de messages, exactement ce que lèvent
 * `ValidationPipe` et `ZodValidationPipe` : `DomainExceptionFilter` le sert en
 * `{ code: "VALIDATION_ERROR", message, details: { violations } }`, et chaque
 * message est préfixé du nom de son champ. Un client ne distingue donc pas ce
 * refus-ci de celui du DTO qui l'a précédé — c'est la condition pour que le
 * message s'affiche sous le champ plutôt qu'en bloc en tête de page
 * (web-frontend §4).
 *
 * Le message ne cite jamais la valeur reçue, comme tous les refus de validation
 * de ce dépôt : un corps d'erreur finit dans les journaux du front, où un numéro
 * de téléphone n'a rien à faire (CDC §5.1).
 *
 * ## Un module de vocabulaire, importé par `crm`
 *
 * Sans dépendance Nest, sans état : `crm` l'importe comme il importe déjà
 * `identity/email`, et pour la même raison — la fiche cliente et l'inscription
 * doivent appliquer *la même* fonction, pas deux copies qui divergeront au
 * premier durcissement.
 */
export function toE164(field: string, value: string, defaultCountry: string | null): string {
  const parsed = e164PhoneSchemaFor(defaultCountry).safeParse(value);

  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((issue) => `${field} : ${issue.message}`),
    );
  }

  return parsed.data;
}

/**
 * Le même contrôle, sur un champ facultatif — et c'est la variante que six des
 * sept portes emploient, la colonne `users.phone` étant nullable.
 *
 * `null` et `undefined` traversent inchangés : le premier est la valeur par
 * laquelle on **efface** un numéro, le second l'absence de toute demande. Une
 * chaîne vide ou réduite à des espaces vaut `null` — « pas de numéro », jamais
 * la chaîne vide : deux représentations d'une même absence finiraient par se
 * comparer mal, et c'est déjà l'arbitrage d'`emptyToNull` côté `crm`.
 */
export function toE164OrNull<T extends string | null | undefined>(
  field: string,
  value: T,
  defaultCountry: string | null,
): T extends string ? string | null : T {
  type Result = T extends string ? string | null : T;

  if (value === null || value === undefined) {
    return value as Result;
  }

  const trimmed = value.trim();

  return (trimmed === '' ? null : toE164(field, trimmed, defaultCountry)) as Result;
}
