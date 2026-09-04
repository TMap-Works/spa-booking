import { Inject, Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AppointmentNotPayableError, PaymentAlreadySettledError } from './payments.errors';
import { PaymentsRepository } from './payments.repository';
import type { Money, PaymentIntentView, PaymentRecord } from './payments.types';
import { StripeConfig } from './stripe/stripe.config';
import {
  STRIPE_GATEWAY,
  type StripeGateway,
  type StripePaymentIntent,
} from './stripe/stripe.gateway';

/**
 * Les règles de l'encaissement en ligne — le seul endroit du module qui décide.
 *
 * Il ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2), et il ne
 * connaît pas non plus le protocole de Stripe : il parle à `StripeGateway`.
 *
 * ## Les quatre invariants qu'il tient
 *
 * 1. **Le montant vient de la base, jamais de l'appelant.** Le corps de la
 *    requête ne porte qu'un identifiant de rendez-vous ; le prix est celui figé
 *    à la réservation. C'est la règle de payments-stripe §4 appliquée au tunnel
 *    public — un `amount` accepté du front aurait laissé payer un massage un
 *    centime.
 * 2. **Un rendez-vous, un encaissement.** Garanti en base par
 *    `@@unique([tenantId, appointmentId])`, pas par la vigilance de ce fichier.
 *    Deux appels concurrents rendent la **même** intention.
 * 3. **Aucune donnée de carte ne traverse ce service.** Il n'y a pas de
 *    paramètre pour en recevoir et pas de champ pour en rendre : la saisie se
 *    fait dans les iframes de Stripe, au navigateur (payments-stripe §1).
 * 4. **Ce service ne confirme rien.** Il crée une intention et rend de quoi la
 *    payer. Le passage du rendez-vous en `CONFIRMED` et du paiement en
 *    `SUCCEEDED` est l'affaire du webhook signé (#58), parce que la source de
 *    vérité du paiement est Stripe reçue côté serveur, jamais la réponse du
 *    navigateur (payments-stripe §2).
 */

/**
 * Les statuts de rendez-vous pour lesquels un paiement en ligne a encore un
 * sens.
 *
 * `PENDING` est le cas nominal — la cliente vient de réserver et paie dans la
 * foulée. `CONFIRMED` couvre la reprise : un tunnel abandonné, un onglet
 * rouvert, un lien de paiement relancé.
 *
 * Les trois autres sont exclus, et chacun pour sa raison : `CANCELLED` n'a plus
 * de prestation à vendre, `COMPLETED` et `NO_SHOW` relèvent du comptoir (#60)
 * — encaisser en ligne un soin déjà rendu rouvrirait un débit sur un dossier
 * clos.
 */
const PAYABLE_APPOINTMENT_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'CONFIRMED']);

/**
 * Les statuts d'**encaissement** depuis lesquels une reprise a encore un sens.
 *
 * `PENDING` est le tunnel abandonné. `FAILED` est le cas décisif, et il n'est
 * pas rare : c'est la carte refusée. Une intention Stripe refusée **reste
 * utilisable** — elle retourne à `requires_payment_method` et attend une autre
 * carte —, et c'est heureux, parce que `@@unique([tenantId, appointmentId])`
 * interdit d'en inscrire une seconde. Traiter `FAILED` comme un encaissement
 * clos rendrait le rendez-vous définitivement impayable : 409 à chaque
 * tentative, y compris au comptoir. Un refus de carte est un incident
 * ordinaire ; il ne doit pas coûter la vente.
 *
 * Les trois autres sont clos pour de bon : `SUCCEEDED` est payé, `REFUNDED` et
 * `PARTIALLY_REFUNDED` ont déjà rendu l'argent. Y rouvrir une intention
 * débiterait une seconde fois.
 */
const RESUMABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'FAILED']);

/**
 * Les statuts Stripe qui disent « cette intention ne sert plus à rien ».
 *
 * `succeeded` est le cas qui compte : le webhook (#58) peut avoir du retard, et
 * la ligne en base porter encore `PENDING` alors que Stripe a déjà encaissé.
 * Rendre alors un formulaire de paiement, fût-il étiqueté `PENDING`, ferait
 * ressaisir une carte pour un rendez-vous déjà payé. On se fie à la source de
 * vérité — Stripe, relue côté serveur — et non à notre copie.
 *
 * `canceled` y est aussi : une intention annulée n'est pas confirmable, et
 * rendre son `client_secret` produirait un formulaire qui échoue à la
 * soumission sans que la cliente sache pourquoi.
 */
const CLOSED_PROVIDER_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'canceled']);

/**
 * Préfixe de la clé d'idempotence envoyée à Stripe.
 *
 * La clé est dérivée du couple (établissement, rendez-vous) et de rien d'autre :
 * elle est donc **stable dans le temps**, là où un aléa la rendrait inutile dès
 * la seconde requête. Elle ne porte aucune donnée personnelle — deux
 * identifiants opaques — et le préfixe évite toute collision avec les clés que
 * le POS (#60) ou les remboursements (#63) émettront depuis le même compte.
 */
const IDEMPOTENCY_PREFIX = 'appointment-intent';

@Injectable()
export class PaymentsService {
  public constructor(
    private readonly payments: PaymentsRepository,
    private readonly tenants: TenantContextService,
    private readonly config: StripeConfig,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
  ) {}

  /**
   * Crée — ou reprend — l'intention de paiement d'un rendez-vous.
   *
   * Rejouable sans effet de bord : appelée deux fois, elle rend deux fois la
   * même intention, et le compte du salon n'est débité qu'une fois. Trois
   * mécanismes s'y emploient, du plus rapide au plus sûr :
   *
   * 1. la ligne `payments` déjà présente, qu'on reprend en relisant son
   *    intention chez Stripe ;
   * 2. la clé d'idempotence de Stripe, qui rend l'intention déjà créée plutôt
   *    que d'en créer une seconde quand deux requêtes se croisent ;
   * 3. la contrainte d'unicité en base, qui tranche la course perdue par
   *    l'insertion et renvoie le perdant sur la ligne du gagnant.
   *
   * @throws {NotFoundError} rendez-vous inconnu — ou appartenant à un autre
   * établissement, ce qui doit être indiscernable (tenant-isolation §4).
   * @throws {AppointmentNotPayableError} rendez-vous annulé, terminé ou no-show.
   * @throws {PaymentAlreadySettledError} encaissement déjà abouti, remboursé,
   * ou fait en espèces au comptoir.
   * @throws {PaymentProviderUnavailableError} Stripe a refusé ou n'a pas répondu.
   */
  public async createIntentForAppointment(appointmentId: string): Promise<PaymentIntentView> {
    const appointment = await this.payments.findPayableAppointment(appointmentId);

    if (appointment === null) {
      // Le message ne distingue pas « inconnu » de « chez le voisin » : la
      // différence servirait de sonde d'existence.
      //
      // Et `details` reste **vide**. L'identifiant est pourtant celui que
      // l'appelant vient d'envoyer, si bien que le lui rendre ne lui apprendrait
      // rien — mais un corps de 404 qui recopie l'identifiant visé rend le refus
      // *distinguable* d'un autre 404 du même tunnel, et c'est précisément ce
      // que le protocole de fuite interdit (tenant-isolation §6). Les deux
      // refus de cette route sont donc rigoureusement identiques, octet pour
      // octet.
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    if (!PAYABLE_APPOINTMENT_STATUSES.has(appointment.status)) {
      throw new AppointmentNotPayableError(appointment.status);
    }

    const existing = await this.payments.findPaymentByAppointment(appointmentId);

    if (existing !== null) {
      return this.resume(existing, appointmentId);
    }

    // Lue **avant** l'appel au prestataire, et pas au moment de composer la
    // réponse : sur un serveur sans clés Stripe, la demande est refusée avant
    // qu'une intention n'existe et qu'une ligne `payments` ne soit inscrite.
    // L'ordre inverse aurait laissé des encaissements fantômes, que la
    // contrainte d'unicité rend ensuite impossibles à reprendre.
    //
    // Mais après les refus qui précèdent, et c'est l'autre moitié du choix :
    // un rendez-vous inconnu, annulé ou déjà encaissé se refuse pour ce qu'il
    // est — 404, 422, 409 — sur un serveur configuré comme sur un serveur qui
    // ne l'est pas. Lire la clé en tête de méthode aurait fait répondre 503 à
    // tout, y compris à une requête malformée, et rendu le tunnel
    // indiagnosticable en recette.
    const publishableKey = this.config.publishableKey;

    let intent: StripePaymentIntent;

    try {
      intent = await this.stripe.createPaymentIntent({
        // Le prix figé en base, et lui seul.
        amountMinor: appointment.price.amountMinor,
        currency: appointment.price.currency,
        idempotencyKey: this.idempotencyKeyFor(appointmentId),
        metadata: this.metadataFor(appointmentId),
      });
    } catch (error) {
      // Un échec de création n'est pas toujours une indisponibilité. Stripe
      // répond `409 idempotency_error` quand **une autre requête portant la
      // même clé est encore en vol** — c'est-à-dire, très exactement, le
      // deuxième clic que cette route promet de rendre inoffensif. Rendre 503
      // à ce clic-là contredirait la garantie, alors que la première requête
      // est en train d'aboutir.
      //
      // On relit donc avant de conclure : si la concurrente a déjà inscrit sa
      // ligne, on rend la même intention qu'elle. Sinon l'échec est réel et
      // remonte tel quel — on ne retente pas l'appel, ce qui transformerait
      // une panne du prestataire en tempête de requêtes.
      const concurrent = await this.payments.findPaymentByAppointment(appointmentId);

      if (concurrent === null) {
        throw error;
      }

      return this.resume(concurrent, appointmentId);
    }

    const created = await this.payments.recordCardIntent({
      appointmentId,
      amount: appointment.price,
      providerPaymentIntentId: intent.id,
    });

    if (created === null) {
      // Course perdue : une requête concurrente a inscrit la ligne entre notre
      // lecture et notre écriture. La clé d'idempotence a fait que les deux
      // parlent de la **même** intention Stripe ; il n'y a donc rien à
      // compenser, seulement la ligne gagnante à relire.
      const winner = await this.payments.findPaymentByAppointment(appointmentId);

      if (winner === null) {
        // La contrainte a refusé l'insertion, mais la ligne est introuvable :
        // l'état est incohérent et se signale plutôt que de se deviner. Même
        // corps que ci-dessus, pour la même raison.
        throw new NotFoundError('Rendez-vous introuvable.');
      }

      return this.resume(winner, appointmentId);
    }

    return this.view(created, appointmentId, intent, publishableKey);
  }

  /**
   * Reprend un encaissement déjà inscrit.
   *
   * Le `client_secret` n'est **pas conservé en base** — rien côté serveur n'a à
   * le relire, et le stocker en ferait un secret de plus à protéger. Il se
   * redemande donc à sa source, ce qui a l'avantage de rendre au passage l'état
   * réel de l'intention chez Stripe.
   */
  private async resume(payment: PaymentRecord, appointmentId: string): Promise<PaymentIntentView> {
    if (!RESUMABLE_PAYMENT_STATUSES.has(payment.status) || payment.providerPaymentIntentId === null) {
      // Deux cas sous un seul code : l'encaissement abouti ou remboursé, et la
      // vente réglée en espèces au comptoir — qui n'a pas d'intention à
      // reprendre. Le tunnel n'a qu'une conduite pour les deux.
      throw new PaymentAlreadySettledError(payment.status);
    }

    // Même règle qu'à la création : la clé se lit juste avant l'appel au
    // prestataire, après le refus qui la précède.
    const publishableKey = this.config.publishableKey;
    const intent = await this.stripe.retrievePaymentIntent(payment.providerPaymentIntentId);

    if (CLOSED_PROVIDER_STATUSES.has(intent.status)) {
      // La relecture ne sert pas qu'à récupérer le `client_secret` : elle sert
      // à ne pas se fier à notre propre copie. Si Stripe dit « payé » pendant
      // que la ligne dit encore `PENDING` — un webhook en retard —, c'est
      // Stripe qui a raison, et rendre un formulaire ici ferait ressaisir une
      // carte pour un rendez-vous déjà réglé.
      throw new PaymentAlreadySettledError(payment.status);
    }

    return this.view(payment, appointmentId, intent, publishableKey);
  }

  private view(
    payment: PaymentRecord,
    appointmentId: string,
    intent: StripePaymentIntent,
    publishableKey: string,
  ): PaymentIntentView {
    return {
      paymentId: payment.id,
      appointmentId,
      // Le montant que **nous** avons inscrit, pas celui que Stripe renvoie :
      // c'est la ligne en base qui fait foi pour la réconciliation (CDC §4.9).
      amount: this.amountOf(payment),
      status: payment.status,
      clientSecret: intent.clientSecret,
      publishableKey,
    };
  }

  private amountOf(payment: PaymentRecord): Money {
    return { amountMinor: payment.amount.amountMinor, currency: payment.amount.currency };
  }

  /**
   * Ce que Stripe conservera avec l'intention.
   *
   * `tenantId` n'est pas décoratif : le schéma Prisma le dit en toutes lettres —
   * `provider_payment_intent_id` est unique **par tenant**, et un webhook Stripe
   * n'arrive qu'avec `pi_xxx`. C'est cette métadonnée qui permettra à #58 de
   * résoudre l'établissement avant de chercher la ligne, plutôt que d'ajouter un
   * index non préfixé de `tenant_id`.
   *
   * Aucune donnée personnelle n'y entre : ni nom, ni e-mail, ni téléphone
   * (CDC §5.1). Deux identifiants opaques suffisent.
   */
  private metadataFor(appointmentId: string): Record<string, string> {
    return { tenantId: this.tenants.requireTenantId(), appointmentId };
  }

  private idempotencyKeyFor(appointmentId: string): string {
    return `${IDEMPOTENCY_PREFIX}:${this.tenants.requireTenantId()}:${appointmentId}`;
  }
}
