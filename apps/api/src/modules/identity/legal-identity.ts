import { BadRequestException } from '@nestjs/common';
import { type LegalIdType, isValidLegalId } from '@spa/shared';

/**
 * L'identifiant d'entreprise du salon — la paire `(nature, identifiant)` que le
 * ticket de caisse imprime (#818, quatrième critère ; câblée par #913).
 *
 * ## Pourquoi une fonction, et pas un décorateur de DTO
 *
 * Parce que la règle porte sur **deux champs à la fois**, et que l'un des deux
 * peut ne pas être dans la requête. `PATCH /v1/tenant` est partiel par contrat :
 * un salon qui corrige la coquille de son SIRET envoie `legalId` seul, et la
 * nature à laquelle cet identifiant doit satisfaire est celle **déjà
 * enregistrée**. Un `class-validator` ne voit que la charge utile ; il ne peut
 * donc pas juger cette paire-là. Même arbitrage, et pour la même raison, que
 * `toE164` : la règle a besoin d'une donnée que seule la requête, une fois
 * l'établissement lu, met à disposition.
 *
 * Le contrat partagé garde la règle de forme — `isValidLegalId`, qui sait qu'un
 * SIRET porte une clé de Luhn et qu'un NIF malgache ne se vérifie pas. Rien n'est
 * recodé ici : ce fichier compose deux valeurs et rend un refus.
 *
 * ## Le refus a la forme d'un refus de validation
 *
 * `BadRequestException` avec un **tableau** de messages préfixés du nom du
 * champ, exactement comme `toE164` : `DomainExceptionFilter` le sert en
 * `{ code: "VALIDATION_ERROR", message, details: { violations } }`, et le
 * formulaire peut afficher le message **sous le champ** plutôt qu'en bloc en
 * tête de page (web-frontend §4). C'est le 400 que le quatrième point de #913
 * demande, « en nommant le champ ».
 *
 * Le message ne cite jamais la valeur reçue — un corps d'erreur finit dans les
 * journaux du front, et un identifiant d'entreprise n'y a rien à faire.
 */
export interface LegalIdentityChange {
  /** Ce que la charge utile pose — `undefined` : elle n'y touche pas. */
  readonly legalIdType?: LegalIdType | null;
  readonly legalId?: string | null;
}

export interface LegalIdentityState {
  readonly legalIdType: LegalIdType | null;
  readonly legalId: string | null;
}

/**
 * Compose la paire résultante et la juge, ou lève un refus de validation.
 *
 * Rend `undefined` quand la charge utile ne touche à aucun des deux champs :
 * « ne touche pas » doit rester distinct de « repose la même valeur », sans quoi
 * chaque enregistrement du formulaire réécrirait deux colonnes pour rien.
 *
 * Les trois refus possibles, et ils sont tous des 400 :
 *
 * 1. une nature sans identifiant — la contrainte
 *    `tenants_legal_id_completeness_check` la refuse en base, et l'y laisser
 *    descendre aurait rendu un 500 sur une saisie ;
 * 2. un identifiant sans nature — invérifiable, donc inutile sur une pièce ;
 * 3. un identifiant qui ne satisfait pas sa nature — un SIRET dont la clé de
 *    Luhn est fausse n'est rapprochable par aucune comptabilité, et l'erreur ne
 *    se découvrirait qu'au contrôle, des mois après la première impression.
 */
export function resolveLegalIdentity(
  changes: LegalIdentityChange,
  current: LegalIdentityState,
): LegalIdentityState | undefined {
  if (changes.legalIdType === undefined && changes.legalId === undefined) {
    return undefined;
  }

  const legalIdType = changes.legalIdType === undefined ? current.legalIdType : changes.legalIdType;
  const legalId = changes.legalId === undefined ? current.legalId : changes.legalId;

  if (legalIdType !== null && legalId === null) {
    throw new BadRequestException([
      'legalId : un identifiant d’entreprise est attendu avec sa nature',
    ]);
  }

  if (legalIdType === null && legalId !== null) {
    throw new BadRequestException([
      'legalIdType : la nature de l’identifiant d’entreprise est attendue avec lui',
    ]);
  }

  if (legalIdType !== null && legalId !== null && !isValidLegalId(legalIdType, legalId)) {
    throw new BadRequestException([
      `legalId : identifiant invalide pour la nature « ${legalIdType} »`,
    ]);
  }

  return { legalIdType, legalId };
}
