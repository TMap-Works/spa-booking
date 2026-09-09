import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ITXClientDenyList } from '@prisma/client/runtime/library';

import {
  PRISMA,
  PRISMA_UNSCOPED,
  type ScopedPrismaClient,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';
import {
  reviveWebhookEvent,
  type StripeWebhookEvent,
  type WebhookFact,
} from './stripe-webhook.types';
import { WEBHOOK_CLOCK, type WebhookClock } from './webhook-clock';

/**
 * Accès Prisma du point d'entrée des webhooks (api-module §2).
 *
 * ## Pourquoi il reste un dépôt à part (#410)
 *
 * C'est **le seul du module à recevoir `PRISMA_UNSCOPED`** — l'unique dérogation
 * inter-tenant de `payments`. Fondre cette classe dans `PaymentsRepository`,
 * comme la lecture paresseuse du critère « un seul repository » y invitait,
 * mettrait le client non scopé dans le constructeur qui sert le tunnel public et
 * le comptoir : la dérogation cesserait d'être une propriété qu'on peut relire
 * d'un seul tenant, ce que tenant-isolation §3 demande précisément de garder
 * nommé, justifié et confiné. Le confinement est vérifié, pas espéré —
 * `__tests__/payments.boundaries.spec.ts` échoue si un second fichier du module
 * cite ce jeton.
 *
 * Il porte deux responsabilités que rien d'autre ne peut porter à sa place, une
 * règle d'idempotence que #410 a tranchée, et — depuis #409 — la file durable
 * des livraisons.
 *
 * ## 1. Résoudre l'établissement, avant toute portée de tenant
 *
 * Un webhook Stripe n'arrive avec aucun jeton et sur aucun slug : il n'a ni
 * l'une ni l'autre des deux entrées de tenant décrites par
 * `tenant-scope.middleware.ts`. Il arrive avec `pi_…`, et le schéma dit
 * explicitement ce qu'il faut en faire — « `provider_payment_intent_id` est
 * unique **par tenant** […] le module `payments` devra donc résoudre le tenant
 * avant de chercher ».
 *
 * C'est la seule lecture légitimement inter-tenant de ce module, et elle passe
 * par `prismaUnscoped` avec les trois obligations de tenant-isolation §3 : le
 * nom, la justification, et un filtre écrit à la main. Elle ne rend **que** le
 * `tenant_id` — aucune ligne, aucun montant, aucune donnée personnelle ne sort
 * de cette porte.
 *
 * ## 2. Écrire l'effet et sa marque d'idempotence dans une seule transaction
 *
 * `processed_webhook_events` n'est pas un journal posé à côté du traitement :
 * c'est ce qui le rend rejouable sans dommage. La ligne s'insère **avant**
 * l'effet et **dans la même transaction**, si bien qu'un échec de l'effet
 * annule aussi la marque, et qu'une seconde livraison concurrente attend sur
 * l'unique plutôt que d'appliquer l'effet une seconde fois.
 *
 * `createMany({ skipDuplicates })` plutôt qu'un `create` sous `try` : un
 * `INSERT` en conflit avorte la transaction PostgreSQL entière, et tout ce qui
 * suivrait échouerait sur « current transaction is aborted ». `ON CONFLICT DO
 * NOTHING` — ce que `skipDuplicates` produit — prend le même verrou, attend la
 * concurrente de la même façon, et rend un compte de zéro sans rien casser.
 *
 * ## 3. La marque enregistre ce qui a été **appliqué**, pas ce qui a été reçu (#410)
 *
 * C'est le point de conception que #58 avait laissé en suspens, faute de
 * connaître l'ordre d'écriture que #57 allait fixer. Cet ordre est maintenant
 * écrit noir sur blanc dans `PaymentsService.createIntentForAppointment` :
 * **l'intention est créée chez Stripe d'abord, la ligne `payments` est inscrite
 * ensuite**. Il existe donc un état — court, mais réel — où Stripe connaît un
 * `pi_…` dont nous n'avons aucune trace.
 *
 * | Comment on y arrive | Fréquence |
 * |---|---|
 * | l'API meurt, ou l'écriture échoue, entre l'appel à Stripe et `recordCardIntent` | rare, mais c'est une panne, pas une hypothèse |
 * | une intention créée hors de notre tunnel : tableau de bord, lien de paiement, Terminal | ordinaire |
 * | un `charge.refunded` émis à la main depuis le tableau de bord | ordinaire |
 *
 * Marquer un tel événement « traité » alors qu'il n'a rien touché serait la
 * **perte silencieuse d'une confirmation d'encaissement** : le 200 est déjà
 * parti, Stripe ne redélivre plus, et le renvoi manuel depuis le tableau de
 * bord — le recours qui reste quand la ligne `payments` n'existera jamais —
 * serait alors avalé comme un rejeu. Le rendez-vous ne serait jamais confirmé,
 * et rien ne le dirait.
 *
 * La règle est donc : **si aucune ligne `payments` ne porte la référence citée,
 * la transaction est annulée en entier** — pas de marque, pas d'effet, et un
 * renvoi ultérieur s'applique normalement. Deux garde-fous encadrent cette
 * règle, sans quoi elle ferait plus de mal que de bien :
 *
 * - **`dispute-opened` garde sa marque.** Son effet *est* l'alerte, et il n'a
 *   par nature aucune ligne à toucher (payments-stripe §6). L'annuler ferait
 *   ré-alerter l'équipe à chaque rejeu.
 * - **La ligne existe mais le garde décline** — un `payment_intent.payment_failed`
 *   arrivé après le succès, un `payment_intent.succeeded` sur un encaissement
 *   déjà remboursé — reste **appliqué**, et marqué. Ce n'est pas un événement
 *   sans destinataire, c'est une décision prise en connaissance de cause ;
 *   l'annuler ferait rejouer sans fin un événement dont la conduite juste est
 *   précisément de ne rien écrire.
 *
 * L'ordre d'écriture reste inchangé : la marque s'insère toujours **avant**
 * l'effet, parce que c'est ce qui sérialise deux livraisons concurrentes. C'est
 * l'annulation qui la retire, pas un test préalable — un test préalable aurait
 * relâché le verrou et laissé deux livraisons appliquer l'effet deux fois.
 *
 * ## 4. Il porte aussi la file durable des livraisons (#409)
 *
 * `stripe_webhook_deliveries` est le **travail à faire** ; `processed_webhook_events`
 * est la preuve que c'est fait. Les deux vivent ici pour la même raison qui a
 * fait exister cette classe : le balayage de reprise lit **sans portée de
 * tenant**, parce qu'une livraison qu'un processus mort a laissée derrière lui
 * n'appartient à aucune requête et n'a personne pour ouvrir sa portée. C'est la
 * même dérogation que la résolution d'établissement, au même endroit, sous le
 * même contrôle de `__tests__/payments.boundaries.spec.ts` — la loger ailleurs
 * ferait un second détenteur de `PRISMA_UNSCOPED` dans le module, ce que
 * tenant-isolation §3 refuse.
 *
 * Toutes les autres opérations de la file — inscrire, aboutir, replanifier,
 * enterrer — passent par le client **scopé**, sous la portée ouverte par la
 * file. La dérogation se réduit donc à ceci : lire les identifiants des
 * livraisons prenables, et poser leur bail. Aucune de ces deux opérations ne
 * fait sortir une donnée d'établissement de sa frontière — la seconde écrit
 * `claimed_at`, et rien d'autre.
 */

/**
 * Le client tel que `$transaction` le passe à son rappel — le client étendu
 * privé de ce qu'on ne peut pas appeler dans une transaction. La forme est
 * celle que Prisma documente ; l'écrire à la main dériverait du client généré.
 */
type ScopedTransaction = Omit<ScopedPrismaClient, ITXClientDenyList>;

/**
 * Charge utile de création **sans** le tenant.
 *
 * Même conversion, et pour la même raison, que dans `appointments.repository.ts` :
 * le type généré exige `tenantId` — la colonne est `NOT NULL` — alors que le
 * repository ne doit justement pas le fournir. C'est l'extension de scoping qui
 * le pose depuis le contexte, et qui écrase ce qui s'y trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * Ce qu'une livraison a produit, du point de vue de l'idempotence.
 *
 * Trois issues et non deux : « appliqué » et « rejoué » laissent tous deux une
 * marque, `unmatched` n'en laisse aucune — c'est très exactement la distinction
 * que #410 avait à trancher, et elle décide si un renvoi manuel servira à
 * quelque chose.
 */
export type WebhookOutcome =
  /** L'événement a été traité, et la marque d'idempotence est posée. */
  | 'applied'
  /** Déjà traité : Stripe l'a rejoué, la marque était là. */
  | 'replayed'
  /**
   * Aucune ligne `payments` ne porte la référence citée. **Rien n'a été écrit,
   * marque comprise** : l'événement reste applicable, et un renvoi depuis le
   * tableau de bord Stripe l'appliquera.
   */
  | 'unmatched';

/** Ce qu'une livraison a réellement produit — matière du journal, et rien d'autre. */
export interface WebhookApplication {
  readonly outcome: WebhookOutcome;
  /** Nombre de lignes `payments` touchées — 0 quand le garde de statut a décliné. */
  readonly paymentsTouched: number;
  /** Nombre de rendez-vous passés en `CONFIRMED` — 0 ou 1. */
  readonly appointmentsConfirmed: number;
}

/** L'effet d'un fait sur la base, ou `null` quand aucune ligne ne porte sa référence. */
type WebhookEffect = Omit<WebhookApplication, 'outcome'> | null;

/**
 * Une livraison inscrite en file durable, telle que la file la manipule (#409).
 *
 * Elle porte son établissement, parce qu'elle a pu être reprise par un
 * balayage qui n'en avait aucun : c'est la ligne qui dit sous quelle portée le
 * traitement doit s'ouvrir, et non l'inverse.
 */
export interface SpooledDelivery {
  readonly id: string;
  readonly tenantId: string;
  /** Tentatives déjà consommées — la reprise ne remet pas le compteur à zéro. */
  readonly attempts: number;
  readonly serializationKey: string;
  readonly event: StripeWebhookEvent;
}

/** Ce qu'il faut pour inscrire une livraison — l'événement, et ce qu'on en déduit. */
export interface SpoolRequest {
  readonly event: StripeWebhookEvent;
  readonly serializationKey: string;
}

/** Les paramètres d'un tour de balayage — la fenêtre du bail, et sa borne. */
export interface ClaimRequest {
  readonly now: Date;
  readonly leaseMs: number;
  readonly batchSize: number;
}

/**
 * Le conflit d'unicité, et lui seul.
 *
 * `P2002` est le code que Prisma pose sur une violation de contrainte unique.
 * Le distinguer d'une panne quelconque est ce qui sépare « Stripe a redélivré »
 * — normal, rien à faire — de « la base ne répond pas » — qu'il faut laisser
 * remonter jusqu'au contrôleur, pour que la route ne rende pas 2xx et que
 * Stripe redélivre.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * La valeur mal formée, et elle seule.
 *
 * `P2023` est le code que Prisma pose quand PostgreSQL refuse une valeur pour la
 * colonne visée — ici, une chaîne comparée à un `uuid`. Ce n'est pas une panne :
 * c'est une donnée qui ne peut désigner aucune ligne, et la traiter comme un
 * « introuvable » est exactement ce qu'elle mérite.
 */
function isMalformedValue(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2023';
}

/**
 * Le nom et le message d'une panne, tronqués à ce que `last_error` accepte.
 *
 * La troncature n'est pas cosmétique : la colonne est un `VARCHAR(500)`, et une
 * trace un peu bavarde — Prisma en produit — ferait échouer l'écriture qui
 * enregistre la panne. Perdre la ligne de file pour cause de message trop long
 * serait le comble.
 */
const MAX_ERROR_LENGTH = 500;

export function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text;
}

const ALREADY_PROCESSED: WebhookApplication = {
  outcome: 'replayed',
  paymentsTouched: 0,
  appointmentsConfirmed: 0,
};

const UNMATCHED: WebhookApplication = {
  outcome: 'unmatched',
  paymentsTouched: 0,
  appointmentsConfirmed: 0,
};

/** Ce qu'on écrit dans `last_error` quand la ligne elle-même n'est plus lisible. */
const UNREADABLE_PAYLOAD = 'payload illisible : forme inconnue du lecteur courant';

/**
 * Sentinelle interne : le seul moyen d'annuler une transaction Prisma est d'en
 * faire échouer le rappel.
 *
 * Elle ne quitte jamais ce fichier — `apply` la rattrape immédiatement et la
 * traduit en `unmatched`. La laisser filer ferait passer pour une panne ce qui
 * est une décision : la file journaliserait une erreur, et un lecteur du journal
 * chercherait un incident inexistant.
 */
class UnmatchedWebhookEvent extends Error {}

@Injectable()
export class StripeWebhookRepository {
  public constructor(
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
    // Résolution de l'établissement **avant** qu'une portée de tenant existe :
    // un webhook n'arrive ni avec un jeton ni avec un slug, seulement avec la
    // référence opaque de l'intention. Le filtre par référence est écrit à la
    // main ci-dessous, et la projection est réduite au seul `tenant_id`
    // (tenant-isolation §3). La reprise des livraisons orphelines relève de la
    // même nécessité, et de la même dérogation.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
    // L'horloge du bail, injectée plutôt qu'appelée (#523). Toutes les dates
    // que ce dépôt **pose** sur une ligne de file en viennent, et le balayage
    // compare à cette même horloge : c'est ce qui rend le prédicat de reprise
    // décidable sans dépendre de la vitesse de la machine. Voir
    // `webhook-clock.ts`.
    @Inject(WEBHOOK_CLOCK) private readonly clock: WebhookClock,
  ) {}

  /**
   * L'établissement propriétaire de l'encaissement désigné, ou `null`.
   *
   * Interrogé **avant** l'indication portée par les métadonnées, et c'est
   * délibéré : la base est ce qui fait autorité sur nos propres lignes. Une
   * métadonnée qui désignerait un autre établissement que celui de la ligne
   * ferait écrire la marque d'idempotence sous le mauvais tenant, et laisserait
   * l'encaissement réel sans effet — un désaccord silencieux, dans le sens le
   * plus difficile à diagnostiquer.
   */
  public async findTenantIdByProviderReference(reference: {
    readonly paymentIntentId: string | null;
    readonly chargeId: string | null;
  }): Promise<string | null> {
    const candidates: Prisma.PaymentWhereInput[] = [];
    if (reference.paymentIntentId !== null) {
      candidates.push({ providerPaymentIntentId: reference.paymentIntentId });
    }
    if (reference.chargeId !== null) {
      candidates.push({ providerChargeId: reference.chargeId });
    }
    if (candidates.length === 0) {
      return null;
    }

    // Les deux références sont opaques et uniques à l'échelle du compte Stripe :
    // au plus une ligne, tous établissements confondus, peut les porter.
    const found = await this.prismaUnscoped.payment.findFirst({
      where: { OR: candidates },
      select: { tenantId: true },
    });

    return found?.tenantId ?? null;
  }

  /**
   * L'établissement que désigne une **indication** de métadonnée, s'il existe.
   *
   * `StripeWebhookEvent.tenantHint` annonce depuis toujours qu'elle est « une
   * *indication* — le résolveur la confronte à la base avant d'ouvrir quoi que
   * ce soit ». Jusqu'à #409 rien ne le faisait, et cela ne coûtait rien : la
   * valeur n'était employée que pour ouvrir une portée, et une portée ouverte
   * sur un établissement inexistant ne trouvait simplement aucune ligne.
   *
   * Depuis #409 elle sert à **écrire** — c'est sous cet établissement que la
   * livraison est inscrite, pendant la requête HTTP. Une indication qui ne
   * désigne rien fait alors violer la clé étrangère, `enqueue` rejette, la route
   * rend 500, et Stripe redélivre trois jours durant un événement que rien ne
   * rendra jamais inscriptible. La confrontation promise devient donc
   * nécessaire, et c'est ici qu'elle se fait.
   *
   * Deux formes de « ne désigne rien » sont traitées de la même façon, parce
   * qu'elles appellent la même conduite : l'établissement supprimé ou jamais
   * créé — `findFirst` rend `null` —, et la chaîne qui n'est pas un UUID —
   * PostgreSQL refuse la comparaison, Prisma lève `P2023`. La seconde n'est pas
   * théorique : la métadonnée est recopiée telle quelle depuis une intention que
   * n'importe qui peut créer dans le tableau de bord Stripe.
   *
   * `prismaUnscoped`, forcément : on cherche un établissement avant qu'aucune
   * portée n'existe, et la projection est réduite à son identifiant — c'est la
   * même dérogation, au même endroit, que `findTenantIdByProviderReference`
   * (tenant-isolation §3).
   */
  public async findTenantIdByHint(hint: string): Promise<string | null> {
    try {
      const found = await this.prismaUnscoped.tenant.findFirst({
        where: { id: hint },
        select: { id: true },
      });
      return found?.id ?? null;
    } catch (error) {
      if (isMalformedValue(error)) {
        return null;
      }
      // Toute autre panne remonte : une base injoignable ne doit pas se
      // déguiser en « cet établissement n'existe pas », qui ferait acquitter à
      // Stripe un événement qu'on n'a pas su traiter.
      throw error;
    }
  }

  /**
   * Inscrit une livraison en file durable, ou rend `null` si elle y est déjà.
   *
   * **C'est l'appel qui se produit pendant la requête HTTP**, avant que le 200
   * ne parte. Tout le troisième critère de #409 tient dans ce placement : après
   * lui, la livraison est sur disque et survit à l'arrêt du processus ; avant
   * lui, elle n'existe que chez Stripe — qui redélivrera, précisément parce que
   * nous n'aurons rien acquitté.
   *
   * `null` veut dire « Stripe a redélivré pendant que la première attendait » :
   * l'unique `(tenant_id, event_id)` a tranché, et il n'y a pas de second
   * travail à faire. Ce n'est pas une erreur, c'est la contrainte qui fait son
   * office — la même mécanique que `processed_webhook_events`, un cran plus
   * tôt.
   *
   * **Sauf si la ligne en conflit est morte.** Une livraison `DEAD` n'attend
   * plus rien : le balayage l'exclut, et l'alerte qui l'a accompagnée demandait
   * précisément une intervention humaine — dont le seul geste disponible est le
   * renvoi de l'événement depuis le tableau de bord Stripe. Rendre `null` sur
   * cette ligne-là avalerait ce renvoi comme un rejeu et laisserait
   * l'encaissement `PENDING` pour de bon. La redélivrance **ressuscite** donc la
   * ligne morte au lieu d'être ignorée : voir `reviveDeadDelivery`.
   *
   * Un `create` sous `try`, et non le `createMany({ skipDuplicates })` de
   * `apply` : la raison qui impose l'autre là-bas — un `INSERT` en conflit
   * avorte la transaction PostgreSQL entière — n'existe pas ici, puisqu'il n'y
   * a pas de transaction autour. Et `create` rend l'identifiant, dont la file a
   * besoin pour aboutir ou replanifier.
   *
   * ## L'échéance est posée par le processus, pas par le moteur (#555)
   *
   * `next_attempt_at` a pour défaut le `now()` **du serveur**, et le balayage
   * compare cette colonne au `now` que l'appelant lui donne — un `new Date()`
   * **du processus** (`sweepOnce`). Laisser le défaut décider met donc deux
   * horloges de part et d'autre du même prédicat, pour une valeur qui vaut
   * « maintenant » dans les deux cas.
   *
   * L'écart mesuré entre les deux est de l'ordre de quelques millisecondes ici,
   * et il n'a aucune portée en exploitation : le bail dure une minute, le
   * balayage passe tous les quarts de minute, et une échéance en retard de
   * quelques millisecondes n'y change rien. Il en a une dès que l'intervalle
   * entre l'inscription et la reprise se compte en millisecondes — c'est le cas
   * d'une suite d'intégration, où la livraison inscrite se retrouvait « pas
   * encore échue » selon l'humeur du moment (#555).
   *
   * Toutes les autres écritures de la file datent déjà depuis le processus :
   * `rescheduleDelivery` reçoit un `Date` calculé par `DurableWebhookQueue`, et
   * `reviveDeadDelivery` pose le sien. L'inscription était la seule à déléguer
   * la sienne au moteur — le double en mémoire, lui, ne l'a jamais fait
   * (`__tests__/webhook.doubles.ts`). C'est cette divergence-là qui est levée.
   *
   * ## Et l'horloge est **injectée**, pas appelée (#523)
   *
   * Poser l'instant depuis le processus a supprimé l'écart, mais l'a laissé
   * **subi** : une suite ne pouvait qu'espérer que la machine irait assez vite
   * entre l'inscription et la reprise. `WEBHOOK_CLOCK` rend cet instant
   * pilotable — en exploitation `new Date()`, dans une suite une horloge qu'on
   * avance d'un TTL pour périmer le bail sans attendre. L'invariant reste le
   * même, et il est désormais tenu par construction : **une seule horloge de la
   * pose du bail à sa péremption**.
   */
  public async spool(request: SpoolRequest): Promise<SpooledDelivery | null> {
    // Un seul instant pour les deux colonnes : la livraison est échue au moment
    // même où elle est prise en charge, et c'est l'instance qui l'inscrit qui la
    // tient.
    const now = this.clock();

    try {
      const created = await this.prisma.stripeWebhookDelivery.create({
        data: withScopedTenant<Prisma.StripeWebhookDeliveryUncheckedCreateInput>({
          eventId: request.event.eventId,
          eventType: request.event.eventType,
          serializationKey: request.serializationKey,
          // L'événement **réduit**, jamais le corps brut de Stripe : aucun champ
          // de carte n'y figure, parce que `stripe-webhook.types.ts` n'en
          // déclare aucun (payments-stripe §1).
          payload: request.event as unknown as Prisma.InputJsonValue,
          // Échue tout de suite, et depuis l'horloge du balayage — voir
          // l'en-tête de cette méthode.
          nextAttemptAt: now,
          // Le bail est posé d'emblée : l'instance qui inscrit est celle qui
          // traite. Sans cela, le balayage d'une autre instance pourrait
          // reprendre la livraison dans la seconde qui suit, et deux traitements
          // partiraient de front.
          claimedAt: now,
        }),
        // `tenantId` est relu de la ligne écrite plutôt que recopié de
        // l'appelant : c'est l'extension de scoping qui l'a posé depuis le
        // contexte, et le relire est la seule façon d'être sûr que la livraison
        // reprise s'ouvrira sous la portée où elle a été inscrite.
        select: { id: true, tenantId: true, attempts: true },
      });

      return {
        id: created.id,
        tenantId: created.tenantId,
        attempts: created.attempts,
        serializationKey: request.serializationKey,
        event: request.event,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.reviveDeadDelivery(request);
      }
      throw error;
    }
  }

  /**
   * La redélivrance qui retombe sur une livraison **enterrée** la remet au
   * travail (#409).
   *
   * C'est ce qui rend le recours humain effectif. `bury` pose `DEAD` et émet
   * l'alerte « intervention humaine requise » ; le seul geste que cette alerte
   * appelle est le renvoi de l'événement depuis le tableau de bord Stripe, une
   * fois l'incident tranché. Sans cette résurrection, ce renvoi buterait sur
   * l'unique `(tenant_id, event_id)`, serait acquitté comme un rejeu, et la
   * ligne morte resterait morte — l'alerte demanderait donc une action qu'aucun
   * chemin n'exécute.
   *
   * `updateMany` filtré sur `DEAD`, et non un `update` : c'est le filtre de
   * statut, réévalué après la prise du verrou de ligne, qui départage deux
   * redélivrances arrivées ensemble. Une seule voit `count = 1` et rend la
   * livraison ; l'autre rend `null`, comme n'importe quelle redélivrance
   * arrivée pendant qu'une livraison vivante attendait.
   *
   * Le compteur de tentatives repart de zéro, et le `payload` est réécrit :
   * l'événement qui revient est le même, mais il est relu par le code courant —
   * ce qui répare au passage la ligne qu'un `payload` devenu illisible avait
   * fait enterrer.
   */
  private async reviveDeadDelivery(request: SpoolRequest): Promise<SpooledDelivery | null> {
    const now = this.clock();
    const revived = await this.prisma.stripeWebhookDelivery.updateMany({
      where: { eventId: request.event.eventId, status: 'DEAD' },
      data: {
        status: 'PENDING',
        attempts: 0,
        serializationKey: request.serializationKey,
        payload: request.event as unknown as Prisma.InputJsonValue,
        nextAttemptAt: now,
        // Le bail est reposé comme à l'inscription : l'instance qui ressuscite
        // est celle qui traite.
        claimedAt: now,
        lastError: null,
      },
    });

    if (revived.count === 0) {
      return null;
    }

    // `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
    // `where`, et le couple `(tenant_id, event_id)` est unique.
    const row = await this.prisma.stripeWebhookDelivery.findFirst({
      where: { eventId: request.event.eventId },
      select: { id: true, tenantId: true, attempts: true },
    });

    return row === null
      ? null
      : {
          id: row.id,
          tenantId: row.tenantId,
          attempts: row.attempts,
          serializationKey: request.serializationKey,
          event: request.event,
        };
  }

  /**
   * La livraison a abouti : elle n'a plus de raison d'exister.
   *
   * La preuve qu'elle a eu lieu est la ligne de `processed_webhook_events`,
   * écrite dans la transaction du traitement. Conserver ici un second
   * enregistrement du même fait ferait grossir une table de file pour redire ce
   * qu'un journal d'idempotence dit déjà mieux.
   *
   * `deleteMany` et non `delete` : la ligne a pu être emportée entre-temps —
   * par une purge, par un autre chemin — et un `delete` sur une ligne absente
   * lèverait là où il n'y a rien à signaler.
   */
  public async completeDelivery(deliveryId: string): Promise<void> {
    await this.prisma.stripeWebhookDelivery.deleteMany({ where: { id: deliveryId } });
  }

  /**
   * Le traitement a échoué et il reste des tentatives : on replanifie.
   *
   * Le bail est **repoussé**, pas relâché : cette instance tient toujours la
   * livraison et va la reprendre après le délai. Le relâcher ferait reprendre
   * la même livraison par le balayage d'une autre instance pendant que celle-ci
   * attend, et les deux tentatives partiraient de front.
   */
  public async rescheduleDelivery(
    deliveryId: string,
    next: { readonly attempts: number; readonly nextAttemptAt: Date; readonly lastError: string },
  ): Promise<void> {
    await this.prisma.stripeWebhookDelivery.updateMany({
      where: { id: deliveryId },
      data: {
        attempts: next.attempts,
        nextAttemptAt: next.nextAttemptAt,
        lastError: next.lastError,
        // Reposé depuis l'horloge de la file, comme à l'inscription : le bail
        // n'a qu'une seule horloge, de sa pose à sa péremption (#523).
        claimedAt: this.clock(),
      },
    });
  }

  /**
   * La borne de réessais est franchie : la livraison passe en file d'attente
   * morte.
   *
   * Le bail est relâché — plus personne ne la tient, et plus personne ne doit
   * la reprendre : c'est le statut `DEAD` qui l'exclut du balayage, et le
   * relâchement du bail évite qu'une ligne morte n'ait l'air d'être en cours de
   * traitement pour qui la relira.
   */
  public async deadLetterDelivery(
    deliveryId: string,
    outcome: { readonly attempts: number; readonly lastError: string },
  ): Promise<void> {
    await this.prisma.stripeWebhookDelivery.updateMany({
      where: { id: deliveryId },
      data: {
        status: 'DEAD',
        attempts: outcome.attempts,
        lastError: outcome.lastError,
        claimedAt: null,
      },
    });
  }

  /**
   * Les livraisons que plus personne ne tient — la reprise après un arrêt
   * brutal.
   *
   * **La seule lecture inter-tenant de la file**, et elle l'est par nécessité :
   * une livraison orpheline n'appartient à aucune requête, aucun jeton ne la
   * désigne, et il n'existe personne pour ouvrir sa portée avant qu'on ne
   * l'ait lue. C'est le même raisonnement, mot pour mot, que
   * `findTenantIdByProviderReference` — d'où la présence des deux dans cette
   * classe et pas ailleurs (tenant-isolation §3).
   *
   * La prise est un `UPDATE` **conditionnel**, jamais un `SELECT` suivi d'un
   * `UPDATE` : sous `READ COMMITTED`, PostgreSQL réévalue le prédicat après
   * avoir pris le verrou de ligne, si bien que de deux instances qui prennent
   * la même livraison, une seule voit `count = 1`. C'est la base qui tranche,
   * pas une fenêtre de code (ADR 0002).
   *
   * Une ligne dont le `payload` ne se relit plus est **enterrée sur place** :
   * la rendre ferait tomber le traitement à chaque tour de balayage, et la
   * laisser telle quelle la ferait reprendre indéfiniment. C'est très
   * exactement ce à quoi la file d'attente morte sert.
   *
   * ## L'instant vient de l'appelant, et il vient de la même horloge (#523)
   *
   * `claim.now` n'est pas une commodité de test : c'est la moitié gauche du
   * prédicat de bail, dont la moitié droite (`claimed_at`, `next_attempt_at`)
   * a été posée par `spool`. Les deux doivent venir de la **même** horloge —
   * `WEBHOOK_CLOCK`, celle que `DurableWebhookQueue.sweepOnce` lit avant
   * d'appeler ici. Deux horloges de part et d'autre de cette comparaison, et le
   * verdict se joue sur leur écart : c'est #555, mot pour mot.
   */
  public async claimAbandonedDeliveries(claim: ClaimRequest): Promise<SpooledDelivery[]> {
    const staleBefore = new Date(claim.now.getTime() - claim.leaseMs);
    const takeable: Prisma.StripeWebhookDeliveryWhereInput = {
      status: 'PENDING',
      nextAttemptAt: { lte: claim.now },
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
    };

    const candidates = await this.prismaUnscoped.stripeWebhookDelivery.findMany({
      where: takeable,
      orderBy: { createdAt: 'asc' },
      take: claim.batchSize,
      select: {
        id: true,
        tenantId: true,
        attempts: true,
        serializationKey: true,
        payload: true,
      },
    });

    const claimed: SpooledDelivery[] = [];

    for (const candidate of candidates) {
      const won = await this.prismaUnscoped.stripeWebhookDelivery.updateMany({
        // Le prédicat est répété à l'identique : c'est lui, réévalué après la
        // prise du verrou de ligne, qui départage deux instances.
        where: { ...takeable, id: candidate.id },
        data: { claimedAt: claim.now },
      });

      if (won.count === 0) {
        continue;
      }

      const event = reviveWebhookEvent(candidate.payload);
      if (event === null) {
        await this.prismaUnscoped.stripeWebhookDelivery.updateMany({
          where: { id: candidate.id },
          data: { status: 'DEAD', lastError: UNREADABLE_PAYLOAD, claimedAt: null },
        });
        continue;
      }

      claimed.push({
        id: candidate.id,
        tenantId: candidate.tenantId,
        attempts: candidate.attempts,
        serializationKey: candidate.serializationKey,
        event,
      });
    }

    return claimed;
  }

  /**
   * Applique l'événement, une fois et une seule.
   *
   * À appeler **dans une portée de tenant déjà résolue** : tout ce qui suit
   * passe par le client scopé, et l'extension refuse la moindre opération sans
   * contexte. C'est ce qui garantit qu'un événement d'un établissement ne peut
   * pas toucher la ligne d'un autre, même si sa référence était falsifiée.
   */
  public async apply(event: StripeWebhookEvent): Promise<WebhookApplication> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.processedWebhookEvent.createMany({
          data: [
            withScopedTenant<Prisma.ProcessedWebhookEventUncheckedCreateInput>({
              eventId: event.eventId,
              eventType: event.eventType,
            }),
          ],
          skipDuplicates: true,
        });

        if (claimed.count === 0) {
          return ALREADY_PROCESSED;
        }

        const effect = await this.applyFact(tx, event.fact);

        if (effect === null) {
          // Aucune ligne ne porte la référence : on annule tout, marque
          // comprise. C'est ce qui laisse un renvoi manuel s'appliquer plutôt
          // que d'être avalé comme un rejeu (voir l'en-tête, §3).
          throw new UnmatchedWebhookEvent();
        }

        return { outcome: 'applied' as const, ...effect };
      });
    } catch (error) {
      if (error instanceof UnmatchedWebhookEvent) {
        return UNMATCHED;
      }
      throw error;
    }
  }

  /**
   * L'effet du fait sur la base, ou `null` si aucune ligne ne porte sa
   * référence.
   *
   * La recherche de la ligne est faite **une fois, ici**, et non répétée dans
   * chaque branche : c'est elle qui distingue « événement sans destinataire »
   * — qui annule la transaction — de « le garde de statut a décliné » — qui la
   * valide. Les trois branches qui suivent opèrent donc sur un identifiant de
   * ligne connu, jamais sur une référence de prestataire.
   */
  private async applyFact(tx: ScopedTransaction, fact: WebhookFact): Promise<WebhookEffect> {
    if (fact.kind === 'dispute-opened') {
      // Aucune écriture, et pourtant appliqué : un litige déclenche une alerte
      // vers l'équipe et n'est pas traité automatiquement au MVP
      // (payments-stripe §6). L'alerte **est** l'effet, et la ligne de
      // `processed_webhook_events` est ce qui évite qu'un rejeu ne la réémette.
      // Un litige peut d'ailleurs porter sur une charge dont nous n'avons aucune
      // ligne : l'exiger ici ferait ré-alerter à chaque livraison.
      return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    // `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
    // `where`, et le couple `(tenant_id, provider_payment_intent_id)` est unique.
    // Une intention d'un autre établissement est donc simplement introuvable.
    const payment = await tx.payment.findFirst({
      where: { providerPaymentIntentId: fact.paymentIntentId },
      select: { id: true, appointmentId: true },
    });

    if (payment === null) {
      return null;
    }

    switch (fact.kind) {
      case 'payment-succeeded':
        return this.settle(tx, fact, payment);

      case 'payment-failed': {
        // Seul un encaissement encore en attente devient `FAILED`. Une carte
        // refusée après un succès — Stripe peut livrer dans le désordre —
        // n'annule pas un paiement déjà abouti. Le compte de zéro qui en résulte
        // n'est **pas** un événement sans destinataire : la ligne est là, la
        // conduite juste est de ne rien écrire, et la marque reste posée.
        const { count } = await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        // Le rendez-vous reste `PENDING` : la cliente peut présenter une autre
        // carte, et l'annuler ici lui prendrait son créneau pour un refus de
        // banque (payments-stripe §2).
        return { paymentsTouched: count, appointmentsConfirmed: 0 };
      }

      case 'charge-refunded': {
        // Le montant vient de Stripe, qui fait foi (payments-stripe §6). Il n'est
        // pas plafonné ici : `payments_refunded_amount_minor_check` refuse en
        // base un remboursement supérieur à l'encaissement, la transaction est
        // annulée et l'événement n'est pas marqué traité — rien de faux n'est
        // écrit. La panne remonte alors jusqu'à la file durable, qui réessaie
        // puis enterre la livraison avec une alerte (#409) : la contrainte étant
        // déterministe, les réessais échoueront tous, et c'est bien l'alerte de
        // file d'attente morte qui doit amener quelqu'un à trancher
        // l'incident de réconciliation.
        const { count } = await tx.payment.updateMany({
          where: { id: payment.id },
          data: {
            refundedAmountMinor: fact.refundedAmountMinor,
            status: fact.fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            ...(fact.chargeId === null ? {} : { providerChargeId: fact.chargeId }),
          },
        });
        return { paymentsTouched: count, appointmentsConfirmed: 0 };
      }
    }
  }

  /**
   * Le succès de paiement — le seul événement qui fasse avancer le rendez-vous.
   *
   * « C'est le webhook, et lui seul, qui fait passer le rendez-vous en
   * `confirmed` » (payments-stripe §2). Les deux écritures sont dans la même
   * transaction que la marque d'idempotence : jamais un encaissement abouti
   * sans son rendez-vous confirmé, jamais l'inverse.
   */
  private async settle(
    tx: ScopedTransaction,
    fact: Extract<WebhookFact, { kind: 'payment-succeeded' }>,
    payment: { readonly id: string; readonly appointmentId: string | null },
  ): Promise<Omit<WebhookApplication, 'outcome'>> {
    // Le filtre de statut est un test-et-pose atomique : un encaissement déjà
    // remboursé ne redevient pas abouti parce qu'une livraison arrive en retard.
    const settled = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ['PENDING', 'FAILED'] } },
      data: {
        status: 'SUCCEEDED',
        capturedAt: new Date(),
        ...(fact.chargeId === null ? {} : { providerChargeId: fact.chargeId }),
      },
    });

    if (payment.appointmentId === null || settled.count === 0) {
      // Deux sorties sans confirmation, pour deux raisons distinctes :
      //
      // - vente au comptoir sans rendez-vous — le modèle l'accepte depuis #19 ;
      // - l'encaissement n'a **pas** transité vers `SUCCEEDED`, parce qu'il
      //   était déjà `REFUNDED` ou `PARTIALLY_REFUNDED` quand cette livraison
      //   est arrivée. Stripe ne garantit ni l'ordre des livraisons, ni leur
      //   traitement séquentiel : un `charge.refunded` appliqué avant le
      //   `payment_intent.succeeded` correspondant laisse la ligne remboursée.
      //   Confirmer le rendez-vous à ce moment-là bloquerait le créneau sur un
      //   paiement qui a été rendu — le filtre de statut de l'encaissement doit
      //   valoir pour les deux écritures, pas pour la première seulement.
      return { paymentsTouched: settled.count, appointmentsConfirmed: 0 };
    }

    // `PENDING` seulement : un rendez-vous annulé entre-temps ne ressuscite pas
    // parce que le paiement aboutit. Le remboursement se traite alors au
    // comptoir, il ne se devine pas ici.
    const confirmed = await tx.appointment.updateMany({
      where: { id: payment.appointmentId, status: 'PENDING' },
      data: { status: 'CONFIRMED' },
    });

    return { paymentsTouched: settled.count, appointmentsConfirmed: confirmed.count };
  }
}
