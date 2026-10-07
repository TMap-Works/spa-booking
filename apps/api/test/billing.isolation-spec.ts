import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import {
  BILLING_PATHS,
  createBillingHarness,
  MAIN_CUSTOMER_ID,
  MAIN_TENANT_LOCALE,
  MAIN_TRIAL_ENDS_AT,
  OTHER_CUSTOMER_ID,
  OTHER_PERIOD_ENDS_AT,
  OTHER_TENANT_LOCALE,
  type BillingHarness,
} from './billing.harness';

/**
 * L'abonnement du salon — la frontière entre deux établissements, ADR 0016,
 * #1262.
 *
 * ## Ce que cette suite prouve, et ce qui le prouvait avant elle
 *
 * | Surface | Où elle est exercée |
 * |---|---|
 * | la priorité des langues (soumise > compte > salon) | `payments/__tests__/billing.locale.spec.ts` |
 * | la mise en forme du formulaire envoyé à Stripe | `payments/__tests__/stripe-billing.gateway.spec.ts` |
 * | la traduction des statuts Stripe | `payments/__tests__/billing.status.spec.ts` |
 * | **la portée de tenant des trois routes** | **ici** |
 * | **la portée de `findAccountLocale`** | **ici** |
 *
 * Les trois premières lignes partagent un angle mort : leurs doubles rendent la
 * même fiche quelle que soit la portée ouverte. Elles ne peuvent donc rien dire
 * de la quatrième et de la cinquième, et c'est tout l'objet de #1262 — la portée
 * de `findAccountLocale` n'était jusqu'ici **affirmée que par un commentaire**,
 * et un commentaire ne casse pas quand la propriété disparaît.
 *
 * ## Pourquoi le protocole habituel ne s'applique pas tel quel
 *
 * `expectCrossTenantNotFound` (tenant-isolation §6) suppose une ressource
 * **désignée par identifiant** : on la crée chez A, on la demande comme B, on
 * exige 404. Aucune des trois routes de ce contrôleur ne désigne quoi que ce
 * soit — ni paramètre de chemin, ni slug, ni identifiant dans le corps, et
 * `billing-redirect.dto.ts` refuse en `.strict()` tout champ qui en porterait un.
 * L'établissement vient de la revendication signée du jeton.
 *
 * La tentative croisée prend donc l'autre forme que §4 décrit : le voisin obtient
 * **sa** réponse, 200 ou 201, et ce qu'il faut prouver est qu'elle ne contient
 * rien du salon principal — ni son client Stripe, ni son identifiant, ni son
 * état d'abonnement — et que rien n'a été écrit chez lui au passage.
 */

describe('Abonnement du salon — isolation inter-établissements (#1262)', () => {
  let harness: BillingHarness;

  beforeEach(async () => {
    harness = await createBillingHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** La fiche du salon principal, relue à la source — le pas 4 du protocole. */
  const fichePrincipale = (): unknown => harness.repository.rowOf(harness.a.id);

  describe('GET /billing/subscription', () => {
    it('rend l’abonnement du salon du jeton, et seulement ses quatre champs', async () => {
      const reponse = await request(harness.server())
        .get(BILLING_PATHS.subscription)
        .set('Authorization', await harness.bearer(harness.accounts(harness.a).ADMIN))
        .expect(200);

      // `toEqual` et non `toMatchObject` : l'égalité exacte est ce qui refuse le
      // **cinquième** champ. Ni `tenantId`, ni `stripeCustomerId`, ni
      // `defaultLocale` n'ont de raison de franchir le contrat — le premier
      // appartient au jeton, le deuxième ouvre le portail de facturation du
      // salon, le troisième est un réglage d'établissement qui a sa propre
      // route. C'est cette assertion qui casse le jour où quelqu'un élargit le
      // `select` du dépôt ou renvoie `BillingRecord` tel quel.
      expect(reponse.body).toEqual({
        status: 'pending',
        trialEndsAt: MAIN_TRIAL_ENDS_AT.toISOString(),
        currentPeriodEndsAt: null,
        hasBillingAccount: true,
      });
    });

    it('rend au voisin son propre abonnement, jamais celui du salon principal', async () => {
      const reponse = await request(harness.server())
        .get(BILLING_PATHS.subscription)
        .set('Authorization', await harness.bearer(harness.accounts(harness.b).ADMIN))
        .expect(200);

      // Les deux fiches ne se ressemblent sur **aucun** champ du contrat : cette
      // égalité exacte est donc à la fois la preuve positive que la portée a été
      // appliquée et la preuve négative que rien du salon principal n'a filtré.
      // Une assertion de non-fuite en plus n'ajouterait rien qu'elle ne dise
      // déjà — il n'y a pas de cinquième champ où se cacher.
      expect(reponse.body).toEqual({
        status: 'canceled',
        trialEndsAt: null,
        currentPeriodEndsAt: OTHER_PERIOD_ENDS_AT.toISOString(),
        hasBillingAccount: true,
      });
    });
  });

  describe('POST /billing/checkout', () => {
    it('ouvre la page de paiement sur le client Stripe du salon du jeton', async () => {
      await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await harness.bearer(harness.accounts(harness.a).ADMIN))
        .expect(201);

      expect(harness.stripe.lastCheckout()).toMatchObject({
        customerId: MAIN_CUSTOMER_ID,
        tenantId: harness.a.id,
      });
      // Aucun client créé : le salon en a déjà un. Un `createCustomer` ici
      // signifierait que la fiche lue n'était pas la sienne.
      expect(harness.stripe.customers).toHaveLength(0);
    });

    it('n’ouvre jamais la page de paiement du salon principal pour le voisin', async () => {
      const avant = fichePrincipale();

      await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await harness.bearer(harness.accounts(harness.b).ADMIN))
        .expect(201);

      const commande = harness.stripe.lastCheckout();
      expect(commande).toMatchObject({
        customerId: OTHER_CUSTOMER_ID,
        tenantId: harness.b.id,
      });
      // Les adresses de retour portent le slug du salon : c'est par elles qu'une
      // session ouverte pour le voisin ramènerait son gérant sur la vitrine du
      // salon principal.
      expect(commande?.successUrl).toContain(harness.b.slug);
      expect(commande?.successUrl).not.toContain(harness.a.slug);
      expect(commande?.cancelUrl).not.toContain(harness.a.slug);

      // La session Checkout est **écrite** sur la fiche du salon : c'est
      // l'écriture que le pas 4 du protocole surveille. Elle doit atterrir chez
      // le voisin, et nulle part ailleurs.
      //
      // `expect.any(String)` plutôt que `not.toBeNull()` : derrière le `?.`,
      // une fiche absente rendrait `undefined`, qu'une assertion négative
      // accepte — la moitié « l'écriture atterrit bien chez le voisin » du pas 4
      // serait alors verte sans avoir rien constaté.
      expect(harness.repository.rowOf(harness.b.id)?.stripeCheckoutSessionId).toEqual(
        expect.any(String),
      );
      expect(fichePrincipale()).toEqual(avant);
    });

    it('ne rend qu’une adresse, sans rien du dossier de facturation', async () => {
      const reponse = await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await harness.bearer(harness.accounts(harness.a).ADMIN))
        .expect(201);

      // `BillingRedirect` ne porte qu'une URL. Y voir apparaître l'identifiant
      // de session ou celui du client serait un élargissement silencieux du
      // contrat, et le second ouvre le portail de facturation du salon.
      expect(Object.keys(reponse.body as object)).toEqual(['url']);
    });
  });

  describe('POST /billing/portal', () => {
    it('ouvre le portail sur le client Stripe du salon du jeton', async () => {
      const reponse = await request(harness.server())
        .post(BILLING_PATHS.portal)
        .set('Authorization', await harness.bearer(harness.accounts(harness.a).ADMIN))
        .expect(201);

      expect(harness.stripe.lastPortal()).toMatchObject({ customerId: MAIN_CUSTOMER_ID });
      expect(Object.keys(reponse.body as object)).toEqual(['url']);
    });

    it('n’ouvre jamais le portail du salon principal pour le voisin', async () => {
      const avant = fichePrincipale();

      await request(harness.server())
        .post(BILLING_PATHS.portal)
        .set('Authorization', await harness.bearer(harness.accounts(harness.b).ADMIN))
        .expect(201);

      const commande = harness.stripe.lastPortal();
      // Le portail client de Stripe donne accès à la carte, aux factures et à la
      // résiliation : l'ouvrir sur le client d'un autre salon serait la fuite la
      // plus coûteuse de ce module.
      expect(commande).toMatchObject({ customerId: OTHER_CUSTOMER_ID });
      expect(commande?.returnUrl).toContain(harness.b.slug);
      expect(commande?.returnUrl).not.toContain(harness.a.slug);

      expect(fichePrincipale()).toEqual(avant);
    });
  });

  describe('la garde des trois routes', () => {
    /**
     * Les trois routes, chacune avec sa requête **construite à l'appel**.
     *
     * Une requête `supertest` part dès qu'on l'attend : deux cas qui
     * partageraient la même instance rejoueraient la première réponse. Le
     * verbe est porté par la fermeture plutôt que par une chaîne indexée, ce
     * qui laisse chaque appel typé.
     */
    const routes = [
      {
        label: 'GET /billing/subscription',
        send: () => request(harness.server()).get(BILLING_PATHS.subscription),
      },
      {
        label: 'POST /billing/checkout',
        send: () => request(harness.server()).post(BILLING_PATHS.checkout),
      },
      {
        label: 'POST /billing/portal',
        send: () => request(harness.server()).post(BILLING_PATHS.portal),
      },
    ] as const;

    it.each(routes)('refuse $label sans jeton, en 401', async ({ send }) => {
      const reponse = await send().expect(401);

      expect(reponse.body).toMatchObject({ code: 'UNAUTHORIZED' });
    });

    /**
     * Les trois rôles qui ne portent pas `settings:write`.
     *
     * L'administrateur est seul à la porter (ADR 0013), et c'est bien la
     * permission qui tranche et non le rang : les trois autres rôles sont donc
     * rejoués un par un, y compris le `MANAGER` — le rang immédiatement en
     * dessous, et celui qu'une reprise de la matrice promouvrait par distraction.
     */
    const rolesSansDroit = ['CLIENT', 'STAFF', 'MANAGER'] as const satisfies readonly UserRole[];

    it.each(
      routes.flatMap((route) => rolesSansDroit.map((role) => ({ ...route, role }))),
    )('refuse $label au rôle $role, en 403', async ({ send, role }) => {
      const porteur = await harness.bearer(harness.accounts(harness.a)[role]);
      const reponse = await send().set('Authorization', porteur).expect(403);

      expect(reponse.body).toMatchObject({ code: 'FORBIDDEN' });
      // Aucune commande n'est partie : le refus tombe avant le service.
      expect(harness.stripe.checkouts).toHaveLength(0);
      expect(harness.stripe.portals).toHaveLength(0);
    });
  });

  /**
   * La portée de `findAccountLocale` — le cas que #1231 n'a laissé qu'en
   * commentaire, et que #1262 verrouille.
   *
   * `JwtAuthGuard` lit `tenantId` et `sub` de la **même** revendication signée,
   * sans vérifier que le second appartient au premier : une portée posée sur un
   * salon avec le compte d'un autre est donc une requête que l'application
   * accepte de servir. Ce qui empêche alors de lire la préférence de langue du
   * voisin est la portée du dépôt, et rien d'autre.
   *
   * Les trois cas forment un tout : sans le premier, les deux suivants seraient
   * verts même si `findAccountLocale` ne trouvait **jamais** rien.
   */
  describe('la préférence de langue d’un compte ne traverse pas la frontière', () => {
    it('suit la préférence d’un compte du salon courant', async () => {
      // La langue du voisin, posée sur un compte **du salon courant** : l'intérêt
      // est qu'elle diffère de celle de l'établissement, pas d'où elle vient.
      const gerant = harness.seedAccount(harness.a, {
        role: 'ADMIN',
        locale: OTHER_TENANT_LOCALE,
      });

      await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await harness.bearer(gerant))
        .expect(201);

      // Le contrôle positif : la lecture fonctionne, et elle n'est pas
      // court-circuitée par la langue de l'établissement — qui est l'autre. Sans
      // ce cas, les deux suivants seraient verts même si `findAccountLocale` ne
      // trouvait jamais rien.
      expect(gerant.locale).not.toBe(MAIN_TENANT_LOCALE);
      expect(harness.stripe.lastCheckout()?.locale).toBe(gerant.locale);
    });

    it('retombe sur la langue de l’établissement quand le compte n’a rien choisi', async () => {
      const gerant = harness.accounts(harness.a).ADMIN;
      expect(gerant.locale).toBeNull();

      await request(harness.server())
        .post(BILLING_PATHS.checkout)
        .set('Authorization', await harness.bearer(gerant))
        .expect(201);

      expect(harness.stripe.lastCheckout()?.locale).toBe(MAIN_TENANT_LOCALE);
    });

    it('lit « aucune préférence » sur un compte du voisin, et retombe sur le salon courant', async () => {
      const gerantVoisin = harness.seedAccount(harness.b, {
        role: 'ADMIN',
        locale: OTHER_TENANT_LOCALE,
      });
      // Sans quoi le cas serait vide de sens : la préférence à ne pas lire doit
      // exister, et différer de la langue du salon courant.
      expect(gerantVoisin.locale).not.toBe(MAIN_TENANT_LOCALE);

      await request(harness.server())
        .post(BILLING_PATHS.checkout)
        // Le sujet est un compte du voisin, la portée est le salon principal.
        .set('Authorization', await harness.bearer(gerantVoisin, harness.a))
        .expect(201);

      // La langue du salon **courant**, jamais celle du compte d'ailleurs.
      expect(harness.stripe.lastCheckout()?.locale).toBe(MAIN_TENANT_LOCALE);
      expect(harness.stripe.lastCheckout()?.tenantId).toBe(harness.a.id);
      // Et rien n'a été écrit chez le voisin au passage.
      expect(harness.repository.rowOf(harness.b.id)?.stripeCheckoutSessionId).toBeNull();
    });
  });
});
