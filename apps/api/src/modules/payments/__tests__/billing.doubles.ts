import type { Locale, TenantBillingStatus } from '@spa/shared';

import { getTenantId } from '../../../common/tenant';
import { toAccountLocale, toTenantLocale } from '../../identity/locale';
import type {
  BillingChanges,
  BillingRecord,
  BillingRepository,
} from '../billing/billing.repository';
import type {
  CreatePortalSessionCommand,
  CreateSubscriptionCheckoutCommand,
  StripeBillingGateway,
  StripeCheckoutSnapshot,
  StripeSubscriptionSnapshot,
} from '../billing/stripe-billing.gateway';

/**
 * Doubles de l'abonnement des salons — ADR 0016, #1262.
 *
 * Le module `billing` n'avait jusqu'ici que des doubles **anonymes**, écrits à
 * l'intérieur de `billing.locale.spec.ts` : un objet littéral transtypé en
 * `BillingRepository`, qui rend toujours la même fiche quelle que soit la portée
 * ouverte. Il prouve très bien la règle de priorité des langues, et ne peut rien
 * dire de la frontière entre deux salons — un dépôt qui ignore le tenant courant
 * rend la même réponse au voisin qu'au titulaire.
 *
 * Ces deux doubles-ci existent pour ce que l'autre ne peut pas prouver, et ils
 * reproduisent **trois propriétés précises** du vrai dépôt :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent sur le **vrai** contexte de
 *    requête, `getTenantId()`, celui-là même que consulte l'extension Prisma. Ce
 *    n'est pas une commodité : un double qui tiendrait sa propre idée du tenant
 *    courant ne testerait que sa comptabilité interne, et laisserait passer la
 *    faute qu'on cherche — une garde qui n'ouvre pas la portée, ou qui l'ouvre
 *    sur le mauvais établissement ;
 * 2. le **défaut fermé** — sans portée résolue, aucune opération. Le vrai dépôt
 *    lèverait `MissingTenantContextError` ; le mode ouvert par défaut est
 *    exactement ce qui produit les fuites ;
 * 3. la **normalisation des langues** — `toTenantLocale` sur la colonne de
 *    l'établissement, `toAccountLocale` sur celle du compte. Les deux fonctions
 *    sont celles du vrai dépôt, et la nuance qu'elles portent est tout l'objet de
 *    #1231 : `null` se lit « aucune préférence », jamais « anglais ».
 *
 * La passerelle, elle, ne parle **jamais** au réseau : aucun test de ce dépôt
 * n'atteint l'environnement Stripe, live ou test (payments-stripe §7).
 */

/** Sans portée résolue, rien ne passe — c'est la propriété 2. */
function requireTenant(): string {
  const tenantId = getTenantId();

  if (tenantId === undefined) {
    throw new Error(
      'FakeBillingRepository : aucune portée de tenant ouverte. Le vrai dépôt ' +
        'lèverait `MissingTenantContextError` — un double qui rendrait « la ' +
        'première ligne » ferait verdir la fuite qu’on cherche.',
    );
  }

  return tenantId;
}

/**
 * La facturation d'un établissement, telle que la table `tenants` la porte.
 *
 * `defaultLocale` est une **chaîne** et non une `Locale`, comme la colonne : elle
 * est `NOT NULL` mais seule `tenants_default_locale_check` en borne les valeurs,
 * et c'est `toTenantLocale` qui couvre côté dépôt ce qui aurait échappé à la
 * contrainte. Stocker ici une `Locale` déjà validée aurait rendu cette
 * normalisation inobservable.
 */
interface StoredBilling {
  slug: string;
  name: string;
  contactEmail: string | null;
  status: TenantBillingStatus;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeCheckoutSessionId: string | null;
  defaultLocale: string;
}

/** Ce qu'une suite déclare pour un établissement — tout le reste a un défaut. */
export interface SeedBillingInput extends Partial<Omit<StoredBilling, 'slug'>> {
  readonly slug: string;
}

/**
 * La table `users`, réduite à ce que `findAccountLocale` en lit.
 *
 * Structurelle, et non l'import du double d'`identity` : le harnais passe
 * directement le tableau de comptes que ce double tient, si bien qu'il n'existe
 * **qu'une** table des comptes dans une suite. Deux tables tenues en parallèle
 * auraient fini par diverger d'un `locale`, et c'est précisément la valeur dont
 * dépend le cas de repli de #1231.
 */
export interface AccountRow {
  readonly id: string;
  readonly tenantId: string;
  readonly locale: string | null;
}

/**
 * La surface publique du vrai dépôt, et rien d'autre.
 *
 * `Pick` plutôt qu'`implements BillingRepository` directement : le vrai porte un
 * champ privé (`prisma`), et TypeScript n'autorise à implémenter un type à
 * membres privés que par héritage. Le témoin qu'on veut ici n'est pas la
 * parenté, c'est la **substituabilité** — une méthode renommée dans le vrai fait
 * échouer la compilation de ce fichier, ce qui est exactement le moment où il
 * faut l'apprendre.
 */
type BillingRepositoryPort = Pick<
  BillingRepository,
  'findCurrent' | 'findAccountLocale' | 'updateCurrent'
>;

export class FakeBillingRepository implements BillingRepositoryPort {
  private readonly rows = new Map<string, StoredBilling>();

  /**
   * Les comptes, par **référence vive** sur la table du harnais.
   *
   * Un instantané pris à la construction ne verrait pas les comptes qu'une suite
   * sème ensuite — et c'est le cas normal : le harnais compile l'application
   * avant de semer.
   */
  public constructor(private readonly accounts: readonly AccountRow[] = []) {}

  /**
   * Déclare la facturation d'un établissement.
   *
   * Le `tenantId` est **explicite** et non pris dans le contexte : une suite de
   * fuite sème chez A pour tenter de lire chez B, ce qu'un ensemencement scopé
   * rendrait impossible à écrire.
   */
  public seedTenant(tenantId: string, input: SeedBillingInput): void {
    this.rows.set(tenantId, {
      name: `Établissement ${input.slug}`,
      contactEmail: `contact@${input.slug}.test`,
      // `pending` : un salon inscrit seul qui n'a pas encore payé — l'état dont
      // partent la page de paiement et le portail. `managed` aurait fait refuser
      // les deux par `BILLING_NOT_APPLICABLE`, qui est un cas et non le défaut.
      status: 'pending',
      trialEndsAt: null,
      currentPeriodEndsAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeCheckoutSessionId: null,
      defaultLocale: 'en',
      ...input,
    });
  }

  /**
   * La ligne d'un établissement, hors portée et en copie — pour l'assertion
   * « intacte » du protocole de fuite (tenant-isolation §6, pas 4).
   *
   * Une copie, et non la ligne vivante : comparer une référence à elle-même est
   * vert quoi qu'il soit arrivé entre-temps.
   */
  public rowOf(tenantId: string): StoredBilling | null {
    const row = this.rows.get(tenantId);
    return row === undefined ? null : { ...row };
  }

  public findCurrent(): Promise<BillingRecord | null> {
    const row = this.rows.get(requireTenant());

    if (row === undefined) {
      return Promise.resolve(null);
    }

    const { defaultLocale, ...rest } = row;
    return Promise.resolve({ ...rest, defaultLocale: toTenantLocale(defaultLocale) });
  }

  /**
   * La langue de ce compte, **dans l'établissement courant**.
   *
   * Le filtre porte sur le couple `(tenantId, id)` et non sur le seul
   * identifiant : c'est ce que fait l'extension Prisma sur `User`, qui porte un
   * `tenantId`. Un compte du voisin est donc introuvable, et se lit « aucune
   * préférence » — jamais la préférence du voisin.
   */
  public findAccountLocale(userId: string): Promise<Locale | null> {
    const tenantId = requireTenant();
    const row = this.accounts.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === userId,
    );

    return Promise.resolve(toAccountLocale(row?.locale ?? null));
  }

  /**
   * Écrit sur l'établissement courant, et sur lui seul.
   *
   * Un établissement absent ne produit **aucune** erreur : le vrai passe par
   * `updateMany`, qui rend `{ count: 0 }` quand la portée ne désigne rien.
   */
  public updateCurrent(changes: BillingChanges): Promise<void> {
    const row = this.rows.get(requireTenant());

    if (row !== undefined) {
      Object.assign(row, changes);
    }

    return Promise.resolve();
  }
}

/** La commande de création de client — nommée, le port la décrivant en ligne. */
export interface CreateBillingCustomerCommand {
  readonly tenantId: string;
  readonly email: string | null;
  readonly name: string;
}

/**
 * La passerelle d'abonnement, en mémoire.
 *
 * Elle **enregistre** ce qu'on lui demande plutôt que de le vérifier : ce que les
 * suites jugent est la commande que le service compose — le client visé, la
 * langue retenue, les adresses de retour —, et c'est
 * `stripe-billing.gateway.spec.ts` qui juge la mise en forme du formulaire HTTP.
 *
 * Aucun appel réseau, nulle part : ni live, ni test (payments-stripe §7). Une
 * suite qui dépendrait du réseau d'un tiers rougirait pour des raisons qui ne
 * nous appartiennent pas.
 */
export class FakeStripeBillingGateway implements StripeBillingGateway {
  /** Les clients créés, dans l'ordre. */
  public readonly customers: CreateBillingCustomerCommand[] = [];
  /** Les sessions de paiement demandées, dans l'ordre. */
  public readonly checkouts: CreateSubscriptionCheckoutCommand[] = [];
  /** Les ouvertures de portail demandées, dans l'ordre. */
  public readonly portals: CreatePortalSessionCommand[] = [];
  /**
   * Les relectures demandées — session Checkout ou abonnement, dans l'ordre.
   *
   * C'est la seule façon d'observer qu'une resynchronisation n'a **pas** eu lieu.
   * `BillingService.current` rattrape toute erreur de la passerelle pour montrer
   * l'état connu plutôt qu'une page en échec : un double qui se contenterait de
   * lever sur une relecture imprévue serait donc muet, et le cas « un salon
   * `managed` ne relit rien chez Stripe » passerait au vert sans rien exercer.
   */
  public readonly retrievals: string[] = [];

  private readonly checkoutSnapshots = new Map<string, StripeCheckoutSnapshot>();
  private readonly subscriptionSnapshots = new Map<string, StripeSubscriptionSnapshot>();
  private nextCustomerId = 1;
  private nextSessionId = 1;

  /** Ce qu'une relecture de session Checkout rendra pour cet identifiant. */
  public seedCheckoutSession(snapshot: StripeCheckoutSnapshot): void {
    this.checkoutSnapshots.set(snapshot.id, snapshot);
  }

  /** Ce qu'une relecture d'abonnement rendra pour cet identifiant. */
  public seedSubscription(snapshot: StripeSubscriptionSnapshot): void {
    this.subscriptionSnapshots.set(snapshot.id, snapshot);
  }

  /** La dernière session de paiement demandée — la forme courante d'assertion. */
  public lastCheckout(): CreateSubscriptionCheckoutCommand | undefined {
    return this.checkouts.at(-1);
  }

  /** La dernière ouverture de portail demandée. */
  public lastPortal(): CreatePortalSessionCommand | undefined {
    return this.portals.at(-1);
  }

  public createCustomer(command: CreateBillingCustomerCommand): Promise<{ id: string }> {
    this.customers.push(command);
    const id = `cus_fake_${this.nextCustomerId}`;
    this.nextCustomerId += 1;
    return Promise.resolve({ id });
  }

  public createSubscriptionCheckout(
    command: CreateSubscriptionCheckoutCommand,
  ): Promise<{ id: string; url: string }> {
    this.checkouts.push(command);
    const id = `cs_fake_${this.nextSessionId}`;
    this.nextSessionId += 1;
    return Promise.resolve({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
  }

  public retrieveCheckoutSession(id: string): Promise<StripeCheckoutSnapshot> {
    this.retrievals.push(id);
    // Le défaut est une session **ouverte** et sans abonnement : c'est l'état
    // d'une session dont personne n'a encore payé, et la relecture ne doit alors
    // rien changer à l'état connu du salon.
    return Promise.resolve(
      this.checkoutSnapshots.get(id) ?? { id, status: 'open', subscriptionId: null },
    );
  }

  public retrieveSubscription(id: string): Promise<StripeSubscriptionSnapshot> {
    this.retrievals.push(id);
    const snapshot = this.subscriptionSnapshots.get(id);

    if (snapshot === undefined) {
      // Jamais un instantané inventé : un abonnement que la suite n'a pas semé
      // est une relecture qu'elle n'attendait pas, et la lui rendre « active »
      // ferait verdir une resynchronisation dont elle ignore tout.
      throw new Error(
        `FakeStripeBillingGateway : aucun abonnement « ${id} » semé. ` +
          'Appeler `seedSubscription` avant d’exercer la resynchronisation.',
      );
    }

    return Promise.resolve(snapshot);
  }

  public createPortalSession(command: CreatePortalSessionCommand): Promise<{ url: string }> {
    this.portals.push(command);
    return Promise.resolve({ url: `https://billing.stripe.test/p/session/ps_fake_${this.portals.length}` });
  }
}
