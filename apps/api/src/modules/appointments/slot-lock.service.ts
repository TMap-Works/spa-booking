import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { requireTenantId } from '../../common/tenant';
import {
  CacheConnection,
  type CacheLockOutcome,
} from '../../infrastructure/cache/cache.connection';
import { SlotNoLongerAvailableError } from './appointments.errors';

/**
 * Le verrou Redis de créneau — le « confort d'interface » de l'ADR 0002 (#38).
 *
 * ## Ce qu'il est, et ce qu'il n'est surtout pas
 *
 * Ce n'est **pas** un mécanisme d'unicité. L'ADR 0002 le dit dans les termes
 * exacts que ce fichier applique :
 *
 * > Un verrou Redis court est posé pendant la saisie du paiement pour éviter
 * > d'afficher un créneau à deux personnes, mais il ne conditionne jamais la
 * > validité de l'écriture.
 *
 * La garantie du zéro double réservation reste `appointments_no_overlap`, et
 * elle seule (CLAUDE.md, contrainte 4 ; booking-engine §1). Trois façons de le
 * vérifier sur ce fichier :
 *
 * - **tenir le verrou n'autorise rien.** L'écriture qu'il encadre est jugée par
 *   la contrainte, exactement comme si le verrou n'existait pas. Aucun chemin
 *   ici ne saute, n'allège ni ne devance un contrôle en base ;
 * - **ne pas tenir le verrou n'interdit rien de valide.** Le seul cas où ce
 *   service refuse est celui où un autre appelant est en train d'écrire **ce
 *   créneau-là chez ce praticien-là** — c'est-à-dire l'instant précis où la
 *   contrainte s'apprête à refuser la seconde demande de toute façon. Et ce refus
 *   n'arrête pas la réservation : sans préférence de praticien, l'appelant passe
 *   au candidat suivant (voir `AppointmentsService.insertWithFirstFree`) ;
 * - **une panne de Redis ne refuse jamais.** `CacheLockOutcome` distingue
 *   `taken` d'`unavailable`, et le second réserve sans verrou. C'est le troisième
 *   critère de #38, et c'est ce qui empêche une panne de cache de devenir une
 *   panne de la caisse.
 *
 * ## La clé, et pourquoi elle commence par le tenant
 *
 * `slot:{tenantId}:{staffId}:{instant}` — la forme de booking-engine §2, bâtie
 * comme celle du cache de disponibilité (`availability-cache.ts`) : une racine
 * d'espace de clés, puis l'établissement, puis le reste. Le tenant en **tête**
 * est ce qui rend impossible qu'un établissement verrouille — ou observe — le
 * créneau d'un autre (tenant-isolation §5). Il vient du contexte de requête et
 * jamais d'un argument : un appelant qui pourrait le choisir pourrait sonder
 * l'agenda du voisin en mesurant quels créneaux sont verrouillés.
 *
 * Le deux-points qui ferme le préfixe n'est pas décoratif, et c'est la même
 * raison qu'en face : sans lui, le préfixe du tenant `abc` couvrirait aussi les
 * clés du tenant `abcd`.
 *
 * ## L'instant de la clé est celui du **soin**, pas celui de l'occupation
 *
 * Un rendez-vous occupe `tampon avant + soin + tampon après` ; la cliente, elle,
 * voit l'heure du soin. Le verrou porte sur ce que le calendrier a **affiché**,
 * puisque son objet est de ne pas donner le même créneau affiché à deux
 * personnes. Prendre la borne occupée ferait manquer le verrou entre deux
 * prestations de tampons différents proposées à la même heure — deux clientes se
 * verraient offrir le même créneau, ce que la contrainte rattraperait, mais
 * tardivement et au prix d'un 409.
 *
 * Le corollaire est assumé : deux créneaux **voisins et chevauchants** (10:00 et
 * 10:15 pour un soin d'une heure) portent deux clés distinctes et ne se
 * verrouillent pas l'un l'autre. Les sérialiser demanderait un verrou par
 * intervalle, c'est-à-dire de réimplémenter en Redis ce que
 * `pg_advisory_xact_lock` fait déjà par agenda de praticien et que la contrainte
 * tranche ensuite (ADR 0006). Ce verrou-ci ne vise que la collision **visible**.
 */

/** Racine de l'espace de clés des verrous de créneau (booking-engine §2). */
export const SLOT_LOCK_NAMESPACE = 'slot';

/**
 * Durée de vie du verrou, en secondes — le « court » du premier critère de #38.
 *
 * Le verrou n'est tenu que le temps de l'écriture, quelques dizaines de
 * millisecondes en nominal, et il est relâché dans un `finally`. Le TTL n'est
 * donc pas la durée attendue : c'est la borne du seul cas où le `finally` ne
 * s'exécute pas, un processus abattu entre la prise et la libération.
 *
 * Dix secondes est l'arbitrage entre les deux façons de se tromper. Trop court,
 * le verrou expirerait pendant une écriture que trois tentatives d'insertion et
 * l'attente d'un verrou consultatif peuvent allonger (ADR 0006) — et il ne
 * protégerait plus rien. Trop long, un conteneur tué laisserait **un** créneau
 * chez **un** praticien refusé d'autant, et un créneau libre masqué est une vente
 * perdue (booking-engine §3). Dix secondes couvre largement la première et borne
 * la seconde à ce qu'un rafraîchissement de page efface.
 */
export const SLOT_LOCK_TTL_SECONDS = 10;

/**
 * Le préfixe de tous les verrous de créneau d'un établissement.
 *
 * Exporté pour la même raison que `tenantAvailabilityKeyPrefix` : c'est la
 * frontière d'isolation de cet espace de clés, et un test doit pouvoir
 * l'énoncer sans le recopier.
 */
export function tenantSlotLockKeyPrefix(tenantId: string): string {
  return `${SLOT_LOCK_NAMESPACE}:${tenantId}:`;
}

/** La clé d'un créneau — `slot:{tenant}:{staff}:{instant du soin, ISO 8601}`. */
export function slotLockKey(tenantId: string, staffId: string, startsAt: Date): string {
  return `${tenantSlotLockKeyPrefix(tenantId)}${staffId}:${startsAt.toISOString()}`;
}

/** Le créneau tel que la cliente le voit : un praticien, une heure de soin. */
export interface SlotRef {
  readonly staffId: string;
  readonly startsAt: Date;
}

@Injectable()
export class SlotLockService {
  public constructor(
    private readonly cache: CacheConnection,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Exécute `write` sous le verrou du créneau, et le relâche **quoi qu'il
   * arrive**.
   *
   * L'ordre est celui de booking-engine §2 — verrou (UX), puis transaction et
   * contrainte (vérité), puis libération dans un `finally`. Le `finally` couvre
   * les trois sorties de `write` : la réussite, le refus de la contrainte, et
   * n'importe quelle autre erreur. C'est le deuxième critère de #38, et c'est ce
   * qui empêche qu'une écriture ratée laisse le créneau bloqué pour le TTL.
   *
   * @throws {SlotNoLongerAvailableError} un autre appelant tient ce créneau. Le
   * message est celui du 409 de la contrainte, et c'est voulu : le front n'a
   * qu'une conduite pour les deux — réafficher les créneaux — et distinguer
   * « verrouillé » de « pris » ferait de cette réponse une sonde d'agenda.
   */
  public async aroundWrite<T>(slot: SlotRef, write: () => Promise<T>): Promise<T> {
    const key = slotLockKey(
      requireTenantId('Appointment', 'slot.lock'),
      slot.staffId,
      slot.startsAt,
    );

    const outcome = await this.acquire(key);

    if (outcome.state === 'taken') {
      throw new SlotNoLongerAvailableError(slot.staffId, slot.startsAt);
    }

    if (outcome.state === 'unavailable') {
      // Le mode dégradé, et il n'est pas une exception qu'on tolère : c'est le
      // comportement **attendu** quand le cache ne répond pas. On réserve, la
      // contrainte tranche, et personne ne perd sa place parce que Redis est
      // tombé.
      return write();
    }

    try {
      return await write();
    } finally {
      await this.release(key, outcome.token);
    }
  }

  /**
   * La prise de verrou, dont aucune issue ne remonte à l'appelant.
   *
   * ## Pourquoi ce `try`, alors que `CacheConnection` promet de ne jamais rejeter
   *
   * Parce que la promesse d'un collaborateur n'est pas une propriété du chemin de
   * réservation. Ce `catch` couvre ce que la promesse ne couvre pas : un
   * fournisseur substitué par un harnais, un double qui n'implémente pas encore
   * la primitive, une version du client qui lèverait de façon synchrone. Il coûte
   * trois lignes ; ce qu'il ferme est une réservation perdue à cause du cache,
   * c'est-à-dire précisément ce que le troisième critère de #38 interdit.
   */
  private async acquire(key: string): Promise<CacheLockOutcome> {
    try {
      return await this.cache.acquireLock(key, SLOT_LOCK_TTL_SECONDS);
    } catch (error: unknown) {
      this.degrade('prise', key, error);

      return { state: 'unavailable' };
    }
  }

  /** La libération, qui ne peut ni échouer ni masquer l'erreur de l'écriture. */
  private async release(key: string, token: string): Promise<void> {
    try {
      await this.cache.releaseLock(key, token);
    } catch (error: unknown) {
      // Rejeter ici depuis un `finally` **remplacerait** l'erreur de l'écriture
      // par celle du cache : une cliente recevrait « Redis injoignable » là où
      // son créneau venait d'être pris. Le TTL relâche de toute façon.
      this.degrade('libération', key, error);
    }
  }

  private degrade(operation: string, key: string, error: unknown): void {
    this.logger.warn(
      `Verrou de créneau ignoré (${operation}, « ${key} ») : ${
        error instanceof Error ? error.message : String(error)
      } — la réservation se poursuit, la contrainte d’exclusion tranche.`,
      SlotLockService.name,
    );
  }
}
