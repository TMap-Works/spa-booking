import { BadRequestException } from '@nestjs/common';

/**
 * L'en-tête `Idempotency-Key`, lu une seule fois pour tout le produit — #1027,
 * troisième point.
 *
 * ## Pourquoi ici, et pas dans chaque module
 *
 * Deux routes l'exigent — ouvrir un salon (`identity/platform`) et régler un
 * ticket (`payments`) —, et elles en avaient chacune leur copie : même nom
 * d'en-tête, mêmes bornes, même message de refus, mot pour mot. La seconde
 * écriture assumait la duplication faute de mieux, un module n'ayant pas à
 * atteindre les internes d'un autre (api-module §3). Le tronc commun est
 * précisément ce que cette règle laisse ouvert : `common/` ne connaît aucun
 * module, et les deux contrôleurs l'appellent sans se connaître.
 *
 * Deux écritures d'une même borne, c'est un jour où l'une passe à 256 et l'autre
 * non — et deux formes de 400 pour la même faute, selon la route.
 *
 * ## Ce que ce fichier n'est pas
 *
 * Il ne **garantit** pas l'idempotence : il lit une clé et refuse ce qui n'en
 * est pas une. La garantie vit en base, sur l'unique qui porte la colonne —
 * `platform_tenant_provisionings` et `payments` en ont chacun un, et c'est lui
 * qui distingue la double soumission du double geste. Une clé bien formée
 * n'assure rien à elle seule.
 */

/**
 * Le nom de l'en-tête, écrit une fois.
 *
 * C'est celui que la RFC de l'idempotence des API HTTP nomme, et celui que
 * Stripe emploie : un appelant qui intègre déjà un prestataire n'a pas à
 * apprendre une seconde orthographe.
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * La borne haute : `VARCHAR(128)`, la largeur des deux colonnes qui la portent
 * — `platform_tenant_provisionings.idempotency_key` et
 * `payments.idempotency_key`.
 *
 * Elle est ici et non dans un DTO de module parce qu'elle est la **même** des
 * deux côtés : la couper au plus étroit des deux schémas serait refuser en 400
 * une clé que la base accepterait, et la prendre au plus large ferait tomber
 * l'écriture en 500 sur un dépassement de colonne.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Le minimum qui rend une clé d'idempotence non devinable par accident. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/**
 * Lit l'en-tête d'idempotence, ou refuse la requête.
 *
 * **Obligatoire** sur les routes qui l'appellent, et ce n'est pas un excès de
 * zèle : chacune inscrit une écriture qu'un rejeu doublerait — un second salon
 * sur l'adresse e-mail du même gérant, une seconde pièce comptable sur le même
 * ticket. Une clé facultative aurait rendu la garantie conditionnelle au soin
 * de l'appelant, c'est-à-dire inexistante le jour où un réseau coupe entre la
 * requête et sa réponse.
 *
 * La valeur est **élaguée** avant d'être jugée : un en-tête recopié avec une
 * espace de fin est la même clé, et la faire tomber en 400 — ou pire, l'inscrire
 * comme une clé distincte — aurait fait dépendre l'idempotence d'un détail de
 * transport.
 *
 * Le refus prend la forme d'un **rapport de validation** — `message` en
 * tableau — pour que `DomainExceptionFilter` le rende sous le même
 * `{ code: "VALIDATION_ERROR", details.violations }` que n'importe quel champ de
 * corps invalide. Un appelant n'a pas à traiter deux formes de 400 selon que la
 * faute est dans le corps ou dans un en-tête.
 */
export function readIdempotencyKey(raw: string | undefined): string {
  const key = (raw ?? '').trim();

  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new BadRequestException({
      message: [
        `${IDEMPOTENCY_HEADER} : en-tête obligatoire, de ` +
          `${String(IDEMPOTENCY_KEY_MIN_LENGTH)} à ${String(IDEMPOTENCY_KEY_MAX_LENGTH)} caractères`,
      ],
    });
  }

  return key;
}
