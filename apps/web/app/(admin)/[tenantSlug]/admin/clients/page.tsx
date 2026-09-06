import {
  uuidSchema,
  type Customer,
  type CustomerPage,
  type CustomerSummary,
  type CustomerVisitHistory,
  type PublicTenant,
  type TimeZone,
} from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import {
  ApiClientError,
  fetchCustomer,
  fetchCustomerHistory,
  fetchPublicTenant,
  searchCustomers,
} from '@/lib/api-client';
import { STATUS_LABELS, statusModifier, zonedFields } from '@/lib/admin/calendar-grid';
import { formatCalendarDate, formatMoney, formatTimeInTimeZone } from '@/lib/format';

import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { customerContactLine, isVoidVisit, parsePageNumber, parseSearchTerm } from './client-view';
import { ClientContactForm } from './components/client-contact-form';
import { ClientNoteForm } from './components/client-note-form';
import { ClientSearchForm } from './components/client-search-form';
import { adminClientsPath } from './paths';

/**
 * Le fichier client du back-office — CDC §1.4, « le front-desk gère l'agenda, le
 * staff et les fiches clients » (#54).
 *
 * ## Un seul écran, en deux volets
 *
 * La recherche et la liste à gauche, la fiche ouverte à droite : la liste **ne
 * disparaît jamais** au profit du détail. C'est ce que demande le geste réel —
 * on cherche une cliente pendant qu'on l'a au téléphone, et on ouvre une fiche
 * pour vérifier un numéro sans perdre les trois homonymes qu'on venait de
 * trouver. Une route `/clients/{id}` aurait imposé un aller-retour par la liste
 * à chaque hésitation.
 *
 * Terme, page et fiche ouverte sont donc dans l'URL (`./paths.ts`), et la page
 * les passe à la garde de session : un renouvellement silencieux rend la main
 * sur la fiche qu'on regardait, pas sur le fichier entier (#458).
 *
 * ## Server Component, et rendu à la demande
 *
 * La liste, la fiche, les compteurs et l'historique sont du texte : rien n'y a
 * d'état, et les faire basculer côté client ne rendrait que le poids du bundle
 * (web-frontend §1). Seuls la recherche et les deux formulaires d'écriture sont
 * des Client Components, aussi bas que possible dans l'arbre.
 *
 * `force-dynamic` parce que la page lit un cookie de session : la mettre en
 * cache servirait le fichier client du premier arrivé à tout le monde — sur des
 * données personnelles, ce serait la fuite la plus grave que ce produit puisse
 * produire.
 *
 * ## Ce qui tient le cinquième critère — « aucune donnée client d'un autre
 * tenant n'est atteignable »
 *
 * Il ne tient pas par un filtre de cet écran, et c'est le point : **il n'y a
 * rien à filtrer ici**. Trois propriétés le portent, et chacune se vérifie en
 * lisant le code plutôt qu'en le supposant :
 *
 * 1. **aucun identifiant d'établissement ne descend jusqu'à l'API.** Ni
 *    `searchCustomers`, ni `fetchCustomer`, ni `fetchCustomerHistory`, ni
 *    `updateCustomer` n'ont de paramètre pour en accepter un ; leurs chemins
 *    n'en nomment aucun. L'établissement vient du **jeton vérifié**
 *    (tenant-isolation §2) ;
 * 2. **le jeton lui-même est borné à ce back-office.** Il est lu d'un cookie
 *    `httpOnly` posé sur `/{slug}/admin` : une session ouverte chez un autre
 *    salon ne l'atteint pas, et le `tenantSlug` de la route ne sert qu'à
 *    retrouver ce cookie — jamais à désigner des données ;
 * 3. **un identifiant du salon voisin est introuvable, pas refusé.** L'API rend
 *    404, indistinctement d'un identifiant qui n'existe nulle part et d'un
 *    compte du personnel. Cet écran le rend donc comme une fiche introuvable,
 *    sans jamais dire qu'elle existe ailleurs (tenant-isolation §4) — un message
 *    différent selon le cas ferait de `?fiche=…` une sonde du fichier voisin.
 */

export const dynamic = 'force-dynamic';

interface ClientsPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  // `string | string[]` et non `string` : une clé répétée arrive en tableau, et
  // le type doit dire ce que Next rend réellement — sans quoi les fonctions de
  // `./client-view.ts` croiraient tenir une chaîne.
  readonly searchParams: Promise<{
    readonly recherche?: string | string[];
    readonly fiche?: string | string[];
    readonly page?: string | string[];
  }>;
}

export default async function ClientsPage({ params, searchParams }: ClientsPageProps) {
  const { tenantSlug } = await params;
  const { recherche, fiche, page: requestedPage } = await searchParams;

  // Les trois paramètres sont lus **avant** la garde : ils ne demandent aucun
  // jeton, et c'est ce qui permet de dire à la garde où revenir. Chacun est
  // ramené à une valeur que l'API accepte — une URL est une entrée, au même
  // titre qu'un champ de formulaire.
  const term = parseSearchTerm(recherche);
  const page = parsePageNumber(requestedPage);
  const selected = uuidSchema.safeParse(fiche);
  const customerId = selected.success ? selected.data : null;

  const view = {
    ...(term === null ? {} : { term }),
    ...(customerId === null ? {} : { customerId }),
    page,
  };
  const accessToken = await requireAdminAccessToken(tenantSlug, adminClientsPath(tenantSlug, view));

  const denial = {
    deniedTitle: 'Accès réservé',
    deniedHint:
      'Le fichier client est réservé aux comptes du salon. Demandez l’accès à l’administrateur.',
    failedTitle: 'Fichier client indisponible',
  };

  // Le fuseau vient de la **vitrine publique** et non de `GET /tenant`, qui est
  // au seuil `ADMIN` : le fichier client s'ouvre dès le rang `staff`, et
  // demander les réglages de l'établissement pour n'y lire que le fuseau
  // fermerait cet écran à ceux qui l'utilisent. Même arbitrage que
  // l'encaissement et le planning (#458).
  let tenant: PublicTenant;
  let directory: CustomerPage;
  try {
    [tenant, directory] = await Promise.all([
      fetchPublicTenant(tenantSlug),
      searchCustomers(accessToken, { ...(term === null ? {} : { q: term }), page }),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, denial);
  }

  let record: { readonly customer: Customer; readonly history: CustomerVisitHistory } | null = null;
  let missing = false;

  if (customerId !== null) {
    try {
      // Deux lectures indépendantes : les enchaîner ajouterait un aller-retour à
      // chaque ouverture de fiche, sur l'écran qu'on ouvre le plus souvent.
      const [customer, history] = await Promise.all([
        fetchCustomer(accessToken, customerId),
        fetchCustomerHistory(accessToken, customerId),
      ]);
      record = { customer, history };
    } catch (error) {
      // Le 404 est nominal — identifiant inconnu, fiche du salon voisin, ou
      // compte du personnel : l'API ne les distingue pas, et cet écran non plus.
      // Tout le reste passe par la cascade commune, qui renvoie à la connexion
      // sur un 401 et relance ce qui n'est pas un refus de l'API.
      if (error instanceof ApiClientError && error.status === 404) {
        missing = true;
      } else {
        return adminLoadFailure(error, tenantSlug, denial);
      }
    }
  }

  return (
    <section aria-labelledby="clients-titre">
      <h1 className="spa-admin__title" id="clients-titre">
        Fichier client
      </h1>

      <div className="spa-admin__split">
        <section aria-labelledby="clients-liste-titre" className="spa-admin__section">
          <h2 className="spa-admin__section-title" id="clients-liste-titre">
            Rechercher
          </h2>

          <ClientSearchForm
            tenantSlug={tenantSlug}
            term={term ?? ''}
            hint={searchHint(term, directory)}
          />

          <ClientDirectory
            customers={directory.items}
            openCustomerId={record?.customer.id ?? null}
            page={directory.page}
            tenantSlug={tenantSlug}
            term={term}
            totalItems={directory.totalItems}
          />

          <DirectoryPager
            openCustomerId={record?.customer.id ?? null}
            page={directory}
            tenantSlug={tenantSlug}
            term={term}
          />
        </section>

        <section aria-labelledby="clients-fiche-titre" className="spa-admin__section">
          <h2 className="spa-admin__section-title spa-visually-hidden" id="clients-fiche-titre">
            {record === null ? 'Aucune fiche ouverte' : `Fiche de ${fullName(record.customer)}`}
          </h2>

          {missing ? (
            <Notification tone="warning" title="Fiche introuvable">
              <p>
                Aucune fiche de ce salon ne porte cet identifiant. Cherchez la personne par son
                nom, son téléphone ou son adresse dans le volet de gauche.
              </p>
            </Notification>
          ) : null}

          {record === null ? (
            // Rien de plus quand la fiche demandée est introuvable : l'avis
            // ci-dessus dit déjà quoi faire, et lui ajouter « Aucune fiche
            // ouverte · choisissez une personne » se lirait comme si l'on
            // n'avait rien demandé.
            missing ? null : (
              <div className="spa-empty-state">
                <p className="spa-empty-state__title">Aucune fiche ouverte</p>
                <p className="spa-empty-state__description">
                  Choisissez une personne dans le fichier pour voir ses coordonnées, sa note
                  interne et son historique de visites.
                </p>
              </div>
            )
          ) : (
            <ClientRecord
              customer={record.customer}
              history={record.history}
              tenantSlug={tenantSlug}
              timeZone={tenant.timezone}
            />
          )}
        </section>
      </div>
    </section>
  );
}

/** « Prénom Nom », écrit une fois. */
function fullName(customer: CustomerSummary): string {
  return `${customer.firstName} ${customer.lastName}`;
}

/**
 * Ce que le champ de recherche dit sous lui.
 *
 * Le nombre de résultats est celui de l'API — `totalItems`, pas la longueur de
 * la page : « 3 fiches » alors que le fichier en compte deux cents serait faux
 * dès la deuxième page.
 */
function searchHint(term: string | null, page: CustomerPage): string {
  const count =
    page.totalItems === 0
      ? 'aucune fiche'
      : `${String(page.totalItems)} fiche${page.totalItems > 1 ? 's' : ''}`;

  return term === null
    ? `Nom, téléphone ou e-mail — le fichier compte ${count}.`
    : `Nom, téléphone ou e-mail — ${count} pour « ${term} ».`;
}

/**
 * La liste du fichier — premier critère.
 *
 * Chaque ligne est un **lien** et non un bouton : elle change l'URL, elle
 * s'ouvre dans un onglet, elle se copie. La ligne ouverte porte
 * `aria-current="true"` ; l'aplat de la feuille de style suit cet attribut
 * plutôt qu'une classe qui pourrait diverger de lui.
 *
 * Le lien reporte la **page courante** en plus du terme : l'omettre ramenait à
 * la première page à chaque fiche ouverte depuis la deuxième, si bien que la
 * ligne sur laquelle on venait de cliquer disparaissait de la liste — et avec
 * elle l'aplat de la ligne ouverte.
 */
function ClientDirectory({
  customers,
  openCustomerId,
  page,
  tenantSlug,
  term,
  totalItems,
}: {
  readonly customers: readonly CustomerSummary[];
  readonly openCustomerId: string | null;
  readonly page: number;
  readonly tenantSlug: string;
  readonly term: string | null;
  /** Le total du **fichier**, pas de la page : c'est lui qui distingue les vides. */
  readonly totalItems: number;
}) {
  // Une page vide au-delà de la dernière n'est pas un fichier vide, et le dire
  // ainsi enverrait chercher une fiche qui existe. `?page=9` sur deux pages est
  // une URL qu'un favori périmé produit tout seul ; le repli est un lien vers la
  // première page, et non une redirection qui effacerait l'URL demandée.
  if (customers.length === 0 && totalItems > 0) {
    return (
      <div className="spa-empty-state spa-empty-state--inline">
        <p className="spa-empty-state__title">Cette page est vide</p>
        <p className="spa-empty-state__description">
          Le fichier compte {totalItems} fiche{totalItems > 1 ? 's' : ''}, mais aucune sur cette
          page.{' '}
          <Link href={adminClientsPath(tenantSlug, { ...(term === null ? {} : { term }) })}>
            Revenir à la première page
          </Link>
          .
        </p>
      </div>
    );
  }

  if (customers.length === 0) {
    return (
      <div className="spa-empty-state spa-empty-state--inline">
        <p className="spa-empty-state__title">
          {term === null ? 'Aucune fiche cliente' : `Aucune fiche pour « ${term} »`}
        </p>
        <p className="spa-empty-state__description">
          {term === null
            ? 'Le fichier se remplit à la première réservation, ou depuis le planning — la prise de rendez-vous au comptoir crée la fiche au passage.'
            : 'La recherche porte sur le début du nom, du téléphone ou de l’adresse. Essayez les premières lettres seulement, ou créez la fiche depuis le planning.'}
        </p>
      </div>
    );
  }

  return (
    <ul className="spa-admin-client-list">
      {/*
        `aria-current="true"` et non `"page"` : les deux volets sont **la même
        page**, seul le paramètre `fiche` change. C'est aussi la valeur que la
        feuille de style suit (`.spa-admin-client-list__item[aria-current='true']`),
        de sorte que l'aplat ne peut pas diverger de l'état annoncé aux lecteurs
        d'écran.
      */}
      {customers.map((customer) => (
        <li key={customer.id}>
          <Link
            className="spa-admin-client-list__item"
            href={adminClientsPath(tenantSlug, {
              ...(term === null ? {} : { term }),
              customerId: customer.id,
              page,
            })}
            aria-current={customer.id === openCustomerId ? 'true' : undefined}
          >
            {/*
              Aucune mention d'activation ici : `GET /customers` exclut les
              fiches désactivées par défaut, et cet écran ne demande pas le
              contraire — la marque n'aurait donc jamais été rendue. Elle vit sur
              la fiche, où elle est atteignable : `GET /customers/:id` sert une
              fiche désactivée, et c'est par là qu'on arrive dessus depuis un
              rendez-vous passé.
            */}
            <span className="spa-admin-client-list__name">{fullName(customer)}</span>
            <span className="spa-admin-client-list__meta">{customerContactLine(customer)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Le déplacement de page, rendu **seulement** quand il y a plus d'une page.
 *
 * Deux liens plutôt qu'un sélecteur : la pagination du fichier client sert à
 * dépasser une recherche trop large, pas à naviguer dans deux cents pages — et
 * un lien conserve le terme cherché, ce qu'un sélecteur aurait dû reconstruire.
 *
 * Il conserve aussi la **fiche ouverte** : les deux volets sont indépendants, et
 * refermer la fiche qu'on a sous les yeux parce qu'on est allé chercher un
 * homonyme page suivante est exactement ce que l'URL porteuse d'état existe pour
 * éviter. Une fiche introuvable, elle, n'est pas reportée — l'appelant passe
 * l'identifiant réellement chargé.
 */
function DirectoryPager({
  openCustomerId,
  page,
  tenantSlug,
  term,
}: {
  readonly openCustomerId: string | null;
  readonly page: CustomerPage;
  readonly tenantSlug: string;
  readonly term: string | null;
}) {
  if (page.totalPages <= 1) {
    return null;
  }

  /** Ce qu'un changement de page ne doit pas perdre : la recherche, la fiche. */
  const keep = {
    ...(term === null ? {} : { term }),
    ...(openCustomerId === null ? {} : { customerId: openCustomerId }),
  };

  return (
    <nav aria-label="Pages du fichier client" className="spa-admin-toolbar">
      <div className="spa-admin-toolbar__group">
        {page.page > 1 ? (
          <Link
            className="spa-button spa-button--quiet"
            href={adminClientsPath(tenantSlug, { ...keep, page: page.page - 1 })}
          >
            Page précédente
          </Link>
        ) : null}
        {page.page < page.totalPages ? (
          <Link
            className="spa-button spa-button--quiet"
            href={adminClientsPath(tenantSlug, { ...keep, page: page.page + 1 })}
          >
            Page suivante
          </Link>
        ) : null}
      </div>
      <p className="spa-admin-toolbar__caption">
        Page {page.page} sur {page.totalPages}
      </p>
    </nav>
  );
}

/** La fiche : coordonnées, compteurs, note interne, historique — critères 2 à 4. */
function ClientRecord({
  customer,
  history,
  tenantSlug,
  timeZone,
}: {
  readonly customer: Customer;
  readonly history: CustomerVisitHistory;
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
}) {
  const { summary } = history;

  return (
    <div className="spa-admin-client">
      <div className="spa-admin-client__header">
        <div className="spa-admin-client__identity">
          <p className="spa-admin-client__name">{fullName(customer)}</p>
          <div className="spa-admin-client__contact">
            <span className="spa-admin-client__contact-item">
              {customer.phone ?? 'Pas de numéro'}
            </span>
            <span className="spa-admin-client__contact-item">{customer.email}</span>
            <span className="spa-admin-client__contact-item">
              Fiche créée le {dayLabel(customer.createdAt, timeZone)}
            </span>
            {customer.isActive ? null : (
              <span className="spa-admin-badge spa-admin-badge--cancelled">Fiche désactivée</span>
            )}
          </div>
        </div>
        {/* La clé remonte le composant quand on passe d'une fiche à l'autre :
            sans elle, React conserverait l'état du formulaire précédent et le
            volet d'édition resterait ouvert sur la nouvelle cliente. */}
        <ClientContactForm key={customer.id} customer={customer} tenantSlug={tenantSlug} />
      </div>

      {summary.noShowVisits > 0 ? (
        <Notification
          tone="warning"
          title={`${String(summary.noShowVisits)} absence${summary.noShowVisits > 1 ? 's' : ''} non prévenue${summary.noShowVisits > 1 ? 's' : ''}`}
        >
          <p>À prendre en compte avant d’accorder un créneau de forte affluence.</p>
        </Notification>
      ) : null}

      <div className="spa-admin-client__metrics">
        <Metric label="Visites honorées" value={String(summary.honoredVisits)} />
        <Metric label="À venir" value={String(summary.upcomingVisits)} />
        <Metric label="Annulés" value={String(summary.cancelledVisits)} />
        <Metric label="Absences non prévenues" value={String(summary.noShowVisits)} />
        <Metric
          label="Total honoré"
          value={summary.totalSpent === null ? '—' : formatMoney(summary.totalSpent)}
        />
      </div>

      <p className="spa-admin-toolbar__hint">
        {summary.totalVisits === 0
          ? 'Aucun rendez-vous à ce jour.'
          : `${String(summary.totalVisits)} rendez-vous au total · première venue le ${
              summary.firstVisitAt === null ? '—' : dayLabel(summary.firstVisitAt, timeZone)
            } · dernière le ${
              summary.lastVisitAt === null ? '—' : dayLabel(summary.lastVisitAt, timeZone)
            }. Compteurs calculés sur la totalité des rendez-vous ; « total honoré » ne compte que les visites honorées, et reste vide quand la fiche mêle plusieurs devises.`}
      </p>

      <ClientNoteForm
        key={customer.id}
        customerId={customer.id}
        internalNote={customer.internalNote}
        tenantSlug={tenantSlug}
      />

      <div>
        <h3 className="spa-admin__section-title">Historique des visites</h3>
        <VisitHistory history={history} timeZone={timeZone} />
      </div>
    </div>
  );
}

/** Un compteur de l'agrégat, rendu tel que l'API le donne — jamais recalculé. */
function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="spa-admin-metric">
      <span className="spa-admin-metric__value">{value}</span>
      <span className="spa-admin-metric__label">{label}</span>
    </div>
  );
}

/**
 * L'historique — quatrième critère : les visites honorées, **et** les annulées,
 * **et** les absences.
 *
 * C'est exactement ce qu'on vient chercher avant d'accorder un créneau du samedi
 * matin, et les retirer aurait fait de cet écran un palmarès plutôt qu'un
 * historique. Le prix d'un rendez-vous jamais honoré est rendu barré : il dit
 * l'ordre de grandeur de ce qui a été perdu sans se laisser lire comme une
 * recette.
 */
function VisitHistory({
  history,
  timeZone,
}: {
  readonly history: CustomerVisitHistory;
  readonly timeZone: TimeZone;
}) {
  if (history.visits.length === 0) {
    return (
      <div className="spa-empty-state">
        <p className="spa-empty-state__title">Aucune visite pour l’instant</p>
        <p className="spa-empty-state__description">
          L’historique se remplit dès le premier rendez-vous posé — honoré, annulé ou non honoré.
        </p>
      </div>
    );
  }

  return (
    <>
      <ol className="spa-admin-history">
        {history.visits.map((visit) => (
          <li className="spa-admin-history__item" key={visit.appointmentId}>
            <span className="spa-admin-history__date">
              {dayLabel(visit.startsAt, timeZone)}
              <br />
              {formatTimeInTimeZone(visit.startsAt, timeZone)}
            </span>
            <span className="spa-admin-history__body">
              <span className="spa-admin-history__service">{visit.serviceName}</span>
              <span className="spa-admin-history__practitioner">
                {visit.staffName === null ? 'praticien retiré du salon' : `avec ${visit.staffName}`}
              </span>
              <span className={`spa-admin-badge spa-admin-badge--${statusModifier(visit.status)}`}>
                {STATUS_LABELS[visit.status]}
              </span>
            </span>
            <span
              className={
                isVoidVisit(visit.status)
                  ? 'spa-admin-history__amount spa-admin-history__amount--void'
                  : 'spa-admin-history__amount'
              }
            >
              {formatMoney(visit.price)}
            </span>
          </li>
        ))}
      </ol>

      {history.summary.totalVisits > history.visits.length ? (
        <p className="spa-admin-toolbar__hint">
          Les {history.visits.length} visites les plus récentes sont affichées ; les compteurs
          ci-dessus portent sur la totalité des {history.summary.totalVisits} rendez-vous.
        </p>
      ) : null}
    </>
  );
}

/**
 * La date civile d'un instant, dans le fuseau du salon.
 *
 * Composée de deux fonctions existantes plutôt qu'écrite ici : `zonedFields`
 * découpe l'instant UTC à l'horloge du salon, `formatCalendarDate` met en forme
 * la date civile qui en sort. Aucun `Intl` de plus dans le front — c'est la
 * règle de `lib/format.ts`, et un troisième formateur finirait par diverger des
 * deux autres sur une frontière de jour.
 */
function dayLabel(instant: string, timeZone: TimeZone): string {
  return formatCalendarDate(zonedFields(instant, timeZone).date);
}
