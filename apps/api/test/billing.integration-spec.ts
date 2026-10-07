import request from 'supertest';

import { PAYMENT_ERROR_CODES } from '@spa/shared';

import {
  BILLING_PATHS,
  createBillingHarness,
  MAIN_CUSTOMER_ID,
  type BillingHarness,
} from './billing.harness';

/**
 * L'abonnement du salon — les deux refus que les écrans doivent savoir lire,
 * ADR 0016, #1262.
 *
 * ## Ce que cette suite ajoute aux tests unitaires du module
 *
 * `billing.locale.spec.ts` et `billing.status.spec.ts` appellent le service
 * directement : ils voient une exception, jamais une **réponse**. Entre les deux
 * se trouve `DomainExceptionFilter`, et c'est lui qui décide du statut HTTP, du
 * `code` que le front compare et de la forme du corps. Un `DomainError` dont le
 * `status` serait mal posé passerait ses tests unitaires et rendrait 500 en vrai.
 *
 * Ce que la suite exige, pour chacun des deux refus :
 *
 * 1. le **statut 409** — un conflit avec l'état courant du salon, et non une
 *    requête malformée (400) ni un droit manquant (403) ;
 * 2. le **code du contrat partagé**, celui que le back-office compare pour
 *    choisir son message ;
 * 3. la **forme `{ code, message, details }`** exactement — les trois clés, et
 *    pas une de plus. C'est le contrat d'erreur de toute l'API, et un corps qui
 *    s'en écarterait obligerait l'écran d'abonnement à une lecture particulière ;
 * 4. qu'**aucune commande ne soit partie** chez Stripe, et qu'aucune ligne n'ait
 *    été écrite : un refus qui aurait déjà créé un client ou une session laisserait
 *    le salon dans un état que personne n'a demandé.
 *
 * Aucun appel à Stripe nulle part : la passerelle est doublée en mémoire
 * (payments-stripe §7).
 */

/** Le contrat d'erreur de l'API, en trois clés — et pas une de plus. */
const ERROR_KEYS = ['code', 'details', 'message'] as const;

describe('Abonnement du salon — les refus 409 (#1262)', () => {
  let harness: BillingHarness;

  afterEach(async () => {
    await harness.close();
  });

  /** Le porteur de l'administrateur du salon principal — le seul qui passe la garde. */
  const porteur = async (): Promise<string> =>
    harness.bearer(harness.accounts(harness.a).ADMIN);

  /** Les trois clés du contrat, et le code attendu. */
  const attendreRefus = (body: unknown, code: string): void => {
    expect(Object.keys(body as object).sort()).toEqual([...ERROR_KEYS]);
    const refus = body as { code: unknown; message: unknown; details: unknown };
    expect(refus.code).toBe(code);
    // `toEqual({})` et non `toMatchObject({})`, qui accepte n'importe quel objet :
    // ces deux refus n'ont rien à détailler, et un `details` qui se remplirait
    // sans qu'on l'ait voulu est exactement ce qu'on veut voir passer au rouge.
    expect(refus.details).toEqual({});
    expect(typeof refus.message).toBe('string');
    expect(refus.message as string).not.toBe('');
  };

  describe('un salon géré par la plateforme n’a pas d’abonnement à régler', () => {
    beforeEach(async () => {
      // `managed` : un salon ouvert par la console, hors facturation — l'état de
      // tous les établissements d'avant l'ADR 0016.
      //
      // L'abonnement Stripe est semé **exprès** : sans lui, « ne relit rien chez
      // Stripe » serait vrai pour la mauvaise raison — il n'y aurait rien à
      // relire. Avec lui, un `managed` qui se resynchroniserait appellerait
      // `retrieveSubscription`, et la relecture serait enregistrée.
      harness = await createBillingHarness({
        main: { status: 'managed', stripeSubscriptionId: 'sub_fixture_managed' },
      });
    });

    it('refuse la page de paiement en 409 BILLING_NOT_APPLICABLE', async () => {
      const reponse = await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await porteur())
        .expect(409);

      attendreRefus(reponse.body, PAYMENT_ERROR_CODES.BILLING_NOT_APPLICABLE);
      // Rien n'est parti, rien n'a été écrit : le refus tombe sur la lecture de
      // la fiche, avant la moindre commande.
      expect(harness.stripe.checkouts).toHaveLength(0);
      expect(harness.stripe.customers).toHaveLength(0);
      expect(harness.repository.rowOf(harness.a.id)?.stripeCheckoutSessionId).toBeNull();
    });

    it('rend quand même son abonnement en lecture, sans resynchronisation Stripe', async () => {
      // `managed` n'est pas un état d'erreur : l'écran d'abonnement s'ouvre et
      // montre un salon sans échéance. C'est ce qui donne son sens au 409
      // ci-dessus — il porte sur l'ouverture d'un paiement, pas sur la lecture.
      const reponse = await request(harness.server())
        .get(BILLING_PATHS.subscription)
        .set('Authorization', await porteur())
        .expect(200);

      expect(reponse.body).toMatchObject({ status: 'managed', hasBillingAccount: true });
      // Aucune relecture : un salon hors facturation n'a pas d'abonnement Stripe
      // à interroger, et l'interroger quand même ferait payer une requête réseau
      // à chaque affichage de l'écran pour un état qui ne bougera jamais.
      expect(harness.stripe.retrievals).toEqual([]);
    });
  });

  describe('un salon dont l’abonnement est déjà en cours', () => {
    beforeEach(async () => {
      harness = await createBillingHarness({
        main: { status: 'active', stripeSubscriptionId: null, stripeCheckoutSessionId: null },
      });
    });

    it('refuse une seconde page de paiement en 409 BILLING_NOT_APPLICABLE', async () => {
      // Le même code que le salon `managed`, et c'est voulu : du point de vue de
      // l'écran, les deux cas se disent « il n'y a rien à régler ici ». Seul le
      // message diffère.
      const reponse = await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await porteur())
        .expect(409);

      attendreRefus(reponse.body, PAYMENT_ERROR_CODES.BILLING_NOT_APPLICABLE);
      expect(harness.stripe.checkouts).toHaveLength(0);
    });
  });

  describe('un salon sans client Stripe', () => {
    beforeEach(async () => {
      // Le cas du salon qui n'a jamais ouvert de page de paiement : il n'a aucun
      // moyen de paiement enregistré, donc aucun portail à ouvrir.
      harness = await createBillingHarness({ main: { stripeCustomerId: null } });
    });

    it('refuse le portail en 409 BILLING_ACCOUNT_MISSING', async () => {
      const reponse = await request(harness.server())
        .post(BILLING_PATHS.portal)
        .set('Authorization', await porteur())
        .expect(409);

      attendreRefus(reponse.body, PAYMENT_ERROR_CODES.BILLING_ACCOUNT_MISSING);
      expect(harness.stripe.portals).toHaveLength(0);
    });

    it('annonce l’absence de compte de facturation en lecture', async () => {
      // `hasBillingAccount` est précisément ce qui permet au back-office de ne
      // pas proposer un portail qui refuserait : le 409 est le filet, pas le
      // parcours.
      const reponse = await request(harness.server())
        .get(BILLING_PATHS.subscription)
        .set('Authorization', await porteur())
        .expect(200);

      expect(reponse.body).toMatchObject({ hasBillingAccount: false });
    });

    it('crée le client Stripe à la première page de paiement, et l’inscrit', async () => {
      // Le pendant du refus : sans client, la page de paiement en crée un — c'est
      // par là que le salon acquiert le moyen de paiement dont le portail a
      // besoin.
      await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await porteur())
        .expect(201);

      expect(harness.stripe.customers).toHaveLength(1);
      expect(harness.stripe.customers[0]).toMatchObject({ tenantId: harness.a.id });

      const fiche = harness.repository.rowOf(harness.a.id);
      // `expect.any(String)` et non `not.toBeNull()` : derrière un `?.`, une
      // fiche absente rend `undefined`, et une assertion **négative** passe
      // alors au vert sans qu'aucun identifiant n'ait été écrit — c'est-à-dire
      // précisément dans le cas qu'elle existe pour attraper.
      expect(fiche?.stripeCustomerId).toEqual(expect.any(String));
      expect(fiche?.stripeCustomerId).not.toBe(MAIN_CUSTOMER_ID);
      expect(fiche?.stripeCheckoutSessionId).toEqual(expect.any(String));
    });
  });
});
