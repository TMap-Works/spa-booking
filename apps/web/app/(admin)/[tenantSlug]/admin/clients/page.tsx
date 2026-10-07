import {
  uuidSchema,
  type Customer,
  type CustomerPage,
  type CustomerSummary,
  type CustomerVisitHistory,
  type Locale,
  type Permission,
  type PublicTenant,
  type TimeZone,
} from '@spa/shared';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Notification } from '@/components/ui/notification';
import {
  ApiClientError,
  fetchCustomer,
  fetchCustomerHistory,
  fetchPublicTenant,
  searchCustomers,
} from '@/lib/api-client';
import { elisionForm } from '@/lib/elision';
import { initialsOf } from '@/lib/initials';
import { statusModifier, zonedFields } from '@/lib/admin/calendar-grid';
import { appointmentOutcomeLabel } from '@/lib/appointment-status';
import {
  formatCalendarDate,
  formatMoney,
  formatTimeInTimeZone,
  type DisplayLocale,
} from '@/lib/format';
import { formatPhoneForDisplay } from '@/lib/phone';

import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { loadAdminShell, type AdminShell } from '../layout';
import { adminCalendarPath } from '../paths';
import {
  customerContactLine,
  emailSuppressionNotice,
  isVoidVisit,
  parsePageNumber,
  parseSearchTerm,
  searchHintKey,
  visitClientNote,
} from './client-view';
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
 *
 * ## Les trois lectures n'ont pas le même seuil — #1416
 *
 * L'annuaire et la fiche s'ouvrent dès `customers:read:own`, l'historique
 * **agrégé** exige `customers:read:all`. Une praticienne obtient donc les deux
 * premières et se voit refuser la troisième, et ce refus-là est **partiel** : il
 * ne ferme pas l'écran, il vide un bloc. C'est `restrictedHistory` qui le
 * distingue, au plus près de l'appel ; tous les autres refus continuent de
 * passer par `adminLoadFailure`.
 *
 * ## Et l'écriture n'a pas le même seuil que la lecture — #1423
 *
 * Rendre la fiche atteignable au rang `STAFF` a du même coup rendu atteignables
 * les deux formulaires qu'elle porte. Tous deux postent `updateCustomerAction`
 * → `PATCH /api/v1/customers/:id`, au seuil `customers:write` — réservé à
 * `MANAGER` et `ADMIN` par l'[ADR 0013](../../../../../../docs/adr/0013-matrice-de-permissions-par-role.md),
 * « des décisions **sur** le fichier, pas des lectures dedans ». Une praticienne
 * saisissait donc un numéro, cliquait « Enregistrer », et ne récoltait qu'un
 * refus — après avoir saisi.
 *
 * La règle tenue ici : **un formulaire affiché aboutit, ou n'est pas affiché**.
 * `customers:write` manquant, les deux formulaires ne sont pas rendus — pas
 * désactivés : un champ `disabled` reste dans le DOM, se réactive au premier
 * outil de développement, et promet encore un geste. Ce que la praticienne perd,
 * c'est le geste ; ce qu'elle garde, c'est la donnée :
 *
 * - la **note interne** reste lisible, en lecture seule (`NoteReadOnly`). C'est
 *   précisément ce que `customers:read:own` existe pour donner — « le praticien
 *   a besoin de la fiche de la personne qu'il va recevoir : allergie,
 *   préférence ». La masquer aurait retiré l'information qu'on vient chercher
 *   avant de préparer la cabine ;
 * - les **coordonnées** restent affichées dans l'en-tête de la fiche, qui ne les
 *   tient pas du formulaire ; seul le bouton « Modifier les coordonnées »
 *   disparaît.
 *
 * Cette garde ne **protège** rien, et c'est l'ADR qui le dit : la seule
 * frontière est celle de l'API, et `PATCH /customers/:id` continue d'exiger
 * `customers:write` pour tout le monde. Elle évite de proposer un geste dont le
 * refus est acquis d'avance — exactement ce que la liste servie par `/auth/me`
 * est là pour permettre.
 *
 * Les permissions effectives viennent de `loadAdminShell`, que le layout a déjà
 * appelée pour peindre le rail : `cache` la mémoïse sur la durée du rendu, cette
 * seconde lecture ne coûte donc aucun aller-retour. Elles permettent au passage
 * d'**éviter** l'appel d'historique dont le 403 est acquis d'avance quand
 * `customers:read:all` manque — `restrictedHistory` reste en place pour le cas
 * où la liste serait inconnue, et c'est la garde de l'API qui fait foi dans les
 * deux cas.
 *
 * ## La langue de l'écran, et celle de la cliente — #852
 *
 * Deux langues se croisent ici, et les confondre serait une faute de fond :
 *
 * - **celle de l'écran** vient de la session (`getLocale`) et décide de tous les
 *   mots que cette page écrit, en-têtes, compteurs et historique compris. Les
 *   dates et les montants la suivent par `lib/format.ts`, augmentée du pays de
 *   l'établissement — sans quoi un salon de Montréal lirait ses dates comme
 *   Paris, ce qui est le même arbitrage que le planning ;
 * - **celle de la cliente** est une donnée de sa fiche (`customer.locale`, la
 *   colonne `users.locale` de #844), et elle ne change rien à ce que l'écran
 *   affiche : elle dit au comptoir dans quelle langue décrocher. `null` s'y lit
 *   « aucune préférence » et non « français » — la fiche l'écrit donc en toutes
 *   lettres plutôt que d'afficher la langue du salon comme si elle avait été
 *   choisie.
 *
 * Le vocabulaire du cycle de vie d'un rendez-vous n'est pas au catalogue de cet
 * écran : il vient de `lib/appointment-status.ts`, qui est le seul endroit du
 * front où il s'écrit (#917). Le fichier client y passe simplement sa langue.
 */

export const dynamic = 'force-dynamic';

/** Le traducteur de cet écran, passé aux sous-composants plutôt que relu. */
type ClientsTranslator = Awaited<ReturnType<typeof getTranslations<'admin-clients'>>>;

/**
 * Le traducteur des **noms de langues**, lu au namespace partagé `locale`.
 *
 * Séparé de celui de l'écran parce que ces deux mots-là ne lui appartiennent
 * pas : « Français » et « English » sont déjà écrits une fois, pour le
 * sélecteur du parcours public et pour les réglages, et les recopier au
 * catalogue du fichier client en aurait fait une seconde table à tenir d'accord
 * (#852).
 */
type LanguagesTranslator = Awaited<ReturnType<typeof getTranslations<'locale'>>>;

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

/**
 * Le titre de l'onglet de cet écran (#1329).
 *
 * Le gabarit de l'espace le situe — « … · Back-office ». Sans ce
 * titre-ci, l'onglet portait le seul nom de l'espace, et deux écrans ouverts
 * côte à côte étaient indiscernables.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin-clients');

  return { title: t('metadata.list') };
}

export default async function ClientsPage({ params, searchParams }: ClientsPageProps) {
  const { tenantSlug } = await params;
  const { recherche, fiche, page: requestedPage } = await searchParams;
  const t = await getTranslations('admin-clients');
  const languages = await getTranslations('locale');
  const locale = (await getLocale()) as Locale;

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
    deniedTitle: t('denied.title'),
    deniedHint: t('denied.hint'),
    failedTitle: t('denied.failedTitle'),
  };

  // Le fuseau vient de la **vitrine publique** et non de `GET /tenant`, qui est
  // au seuil `ADMIN` : le fichier client s'ouvre dès le rang `staff`, et
  // demander les réglages de l'établissement pour n'y lire que le fuseau
  // fermerait cet écran à ceux qui l'utilisent. Même arbitrage que
  // l'encaissement et le planning (#458).
  let tenant: PublicTenant;
  let directory: CustomerPage;
  /*
   * Les permissions effectives du compte — #1423.
   *
   * Lues sur le shell du back-office, que le layout appelle déjà pour peindre le
   * rail : `loadAdminShell` est mémoïsée par `cache`, cette seconde lecture ne
   * déclenche donc aucun appel de plus. Elle part avec les deux autres plutôt
   * qu'avant elles — une attente en série sur une valeur déjà en vol aurait
   * ajouté un palier à l'écran qu'on ouvre le plus souvent.
   *
   * `null` ne veut pas dire « aucun droit » mais « la liste n'a pas pu être
   * lue » — une panne de `GET /auth/me` pendant que les autres lectures passent.
   * Les deux décisions qui en dépendent la traitent donc différemment, et chacune
   * dans le sens qui ne trompe personne :
   *
   * - l'**écriture** demande une permission *prouvée* : sans liste, pas de
   *   formulaire. Proposer « Enregistrer » sur une liste qu'on n'a pas lue
   *   reviendrait à reposer le défaut de ce ticket sur un autre incident. C'est
   *   le même arbitrage que le rail, qui se rabat alors sur le rang le plus bas ;
   * - la **lecture** de l'historique, elle, part quand même : son refus est déjà
   *   rattrapé par `restrictedHistory`, et s'abstenir d'appeler sur un doute
   *   priverait une gérante de son agrégat pour une panne qui ne la concerne pas.
   */
  let shell: AdminShell | null;
  try {
    [shell, tenant, directory] = await Promise.all([
      loadAdminShell(tenantSlug),
      fetchPublicTenant(tenantSlug),
      searchCustomers(accessToken, { ...(term === null ? {} : { q: term }), page }),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, denial);
  }

  const permissions: readonly Permission[] | null = shell?.permissions ?? null;
  const canWriteCustomers = permissions?.includes('customers:write') === true;
  const aggregateDenied = permissions !== null && !permissions.includes('customers:read:all');

  /*
   * La langue de mise en forme des dates, des heures et des montants (#852).
   *
   * Avec le pays de l'établissement, lu sur la vitrine qu'on vient de charger :
   * c'est ce que fait le planning, et pour la même raison — « 09/01 » et
   * « 01/09 » sont tous deux de l'anglais, et seul le pays tranche. L'omettre
   * aurait fait dater les visites d'un salon de Toronto comme celles d'un salon
   * de New York.
   */
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };

  let record: {
    readonly customer: Customer;
    /** `null` quand le rang n'ouvre pas l'agrégat — voir `restrictedHistory` (#1416). */
    readonly history: CustomerVisitHistory | null;
  } | null = null;
  let missing = false;

  if (customerId !== null) {
    try {
      // Deux lectures indépendantes : les enchaîner ajouterait un aller-retour à
      // chaque ouverture de fiche, sur l'écran qu'on ouvre le plus souvent.
      //
      // Elles ne sont pas non plus indépendantes **en refus**, et c'est tout
      // l'objet de #1416 : seule la seconde est au seuil `customers:read:all`,
      // quand la première s'ouvre dès `customers:read:own`. Le 403 de
      // l'historique est donc rattrapé ici, au plus près de l'appel qui le
      // produit, plutôt qu'au `catch` commun — qui ne peut pas savoir laquelle
      // des deux lectures a été refusée.
      const [customer, history] = await Promise.all([
        fetchCustomer(accessToken, customerId),
        // L'appel est **sauté** quand la liste des permissions dit le refus
        // d'avance (#1423) : le bloc rendu est le même, et l'aller-retour en
        // moins est celui d'une requête dont on connaissait déjà la réponse.
        aggregateDenied
          ? null
          : fetchCustomerHistory(accessToken, customerId).catch(restrictedHistory),
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
        {t('list.title')}
      </h1>

      <div className="spa-admin__split">
        <section aria-labelledby="clients-liste-titre" className="spa-admin__section">
          <h2 className="spa-admin__section-title" id="clients-liste-titre">
            {t('list.searchTitle')}
          </h2>

          <ClientSearchForm
            tenantSlug={tenantSlug}
            term={term ?? ''}
            hint={t(searchHintKey(term, directory), {
              count: directory.totalItems,
              term: term ?? '',
            })}
          />

          <ClientDirectory
            customers={directory.items}
            openCustomerId={record?.customer.id ?? null}
            page={directory.page}
            t={t}
            tenantSlug={tenantSlug}
            term={term}
            totalItems={directory.totalItems}
          />

          <DirectoryPager
            openCustomerId={record?.customer.id ?? null}
            page={directory}
            t={t}
            tenantSlug={tenantSlug}
            term={term}
          />
        </section>

        <section aria-labelledby="clients-fiche-titre" className="spa-admin__section">
          <h2 className="spa-admin__section-title spa-visually-hidden" id="clients-fiche-titre">
            {record === null
              ? t('record.headingNone')
              : // `elision` porte la règle d'élision jusqu'au message — « Fiche
                // d'Alice » et non « Fiche de Alice » (`lib/elision.ts`, #1329).
                t('record.heading', {
                  name: fullName(record.customer),
                  elision: elisionForm(record.customer.firstName),
                })}
          </h2>

          {missing ? (
            <Notification tone="warning" title={t('record.missing.title')}>
              <p>{t('record.missing.body')}</p>
            </Notification>
          ) : null}

          {record === null ? (
            // Rien de plus quand la fiche demandée est introuvable : l'avis
            // ci-dessus dit déjà quoi faire, et lui ajouter « Aucune fiche
            // ouverte · choisissez une personne » se lirait comme si l'on
            // n'avait rien demandé.
            missing ? null : (
              <div className="spa-empty-state">
                <p className="spa-empty-state__title">{t('record.empty.title')}</p>
                <p className="spa-empty-state__description">{t('record.empty.description')}</p>
              </div>
            )
          ) : (
            <ClientRecord
              canWrite={canWriteCustomers}
              customer={record.customer}
              display={display}
              history={record.history}
              languages={languages}
              roleKnown={permissions !== null}
              t={t}
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
 * Le rattrapage du **seul** refus partiel de cet écran — `GET
 * /customers/:id/history` en 403 (#1416).
 *
 * ## Ce qui était cassé
 *
 * Les trois lectures de la fiche n'ont pas le même seuil : l'annuaire et la
 * fiche s'ouvrent dès `customers:read:own`, l'historique **agrégé** exige
 * `customers:read:all` (`identity/permissions.ts`). Une praticienne — rang
 * `STAFF` — recevait donc 200, 200 puis 403, et ce 403 passait par la cascade
 * commune : `adminLoadFailure` remplaçait l'écran entier par « Accès refusé »,
 * alors que les deux tiers de la fiche venaient d'arriver. L'annuaire, lui,
 * s'affichait normalement — ce qui rendait le refus d'autant plus incompréhensible.
 *
 * ## Pourquoi un `null` et non une permission élargie
 *
 * Parce que le défaut est une **erreur de gestion d'erreur du front**, et qu'un
 * refus partiel se traite là où il est partiel. Ouvrir `customers:read:own` sur
 * la route d'historique aurait donné à chaque praticienne les compteurs et les
 * dépenses de toutes les clientes du salon pour corriger un écran : c'est une
 * décision de permissions, et elle n'a pas sa place dans un correctif d'affichage.
 * Un historique borné aux rendez-vous de la praticienne, lui, est une
 * fonctionnalité à spécifier — pas la correction de ce bug.
 *
 * ## Ce que ce rattrapage ne masque pas
 *
 * Il ne couvre **que** la lecture de l'historique : un 403 sur
 * `GET /customers/:id` reste un vrai refus d'accès à la fiche et continue de
 * rendre l'écran de refus, parce que c'est bien toute la fiche qui est alors
 * fermée. Et les autres statuts de cette lecture-ci sont relancés tels quels —
 * un 404 y désigne la fiche introuvable, un 500 une panne : les confondre avec
 * un refus de rôle ferait lire « réservé aux gestionnaires » sur une panne de
 * l'API.
 */
function restrictedHistory(error: unknown): null {
  if (error instanceof ApiClientError && error.status === 403) {
    return null;
  }

  throw error;
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
  t,
  tenantSlug,
  term,
  totalItems,
}: {
  readonly customers: readonly CustomerSummary[];
  readonly openCustomerId: string | null;
  readonly page: number;
  readonly t: ClientsTranslator;
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
        <p className="spa-empty-state__title">{t('list.pageEmpty.title')}</p>
        <p className="spa-empty-state__description">
          {/* `t.rich` et non une phrase coupée en deux clés : le lien est au
              milieu du texte, et une découpe figerait l'ordre des morceaux d'une
              langue à l'autre (#849). */}
          {t.rich('list.pageEmpty.description', {
            count: totalItems,
            link: (parts) => (
              <Link href={adminClientsPath(tenantSlug, { ...(term === null ? {} : { term }) })}>
                {parts}
              </Link>
            ),
          })}
        </p>
      </div>
    );
  }

  if (customers.length === 0) {
    // La sortie est un **lien**, et non la phrase qu'elle était — #763. « Créez
    // la fiche depuis le planning » est une consigne dont l'écran connaît la
    // destination : la laisser en texte obligeait à retrouver le planning dans
    // le rail, au moment précis où l'on a quelqu'un au téléphone. Le chemin vient
    // d'`adminCalendarPath` comme partout ailleurs, jamais d'une URL concaténée.
    const planning = (parts: ReactNode) => <Link href={adminCalendarPath(tenantSlug)}>{parts}</Link>;

    return (
      <div className="spa-empty-state spa-empty-state--inline">
        {/*
          Le terme cherché est répété ici, et **seulement** ici : la légende du
          champ ne dit plus l'absence de résultat (`searchHintKey`), pour que la
          même phrase ne se lise pas deux fois à trois centimètres d'écart.
        */}
        <p className="spa-empty-state__title">
          {term === null ? t('list.empty.title') : t('list.empty.titleTerm', { term })}
        </p>
        <p className="spa-empty-state__description">
          {term === null
            ? t.rich('list.empty.descriptionAll', { link: planning })
            : t.rich('list.empty.descriptionTerm', { link: planning })}
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
            <span aria-hidden="true" className="spa-admin-client-list__avatar">
              {initialsOf(fullName(customer))}
            </span>
            <span className="spa-admin-client-list__text">
              <span className="spa-admin-client-list__name">{fullName(customer)}</span>
              <span className="spa-admin-client-list__meta">{customerContactLine(customer)}</span>
            </span>
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
  t,
  tenantSlug,
  term,
}: {
  readonly openCustomerId: string | null;
  readonly page: CustomerPage;
  readonly t: ClientsTranslator;
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
    <nav aria-label={t('list.pager.label')} className="spa-admin-toolbar">
      <div className="spa-admin-toolbar__group">
        {page.page > 1 ? (
          <Link
            className="spa-button spa-button--quiet"
            href={adminClientsPath(tenantSlug, { ...keep, page: page.page - 1 })}
          >
            {t('list.pager.previous')}
          </Link>
        ) : null}
        {page.page < page.totalPages ? (
          <Link
            className="spa-button spa-button--quiet"
            href={adminClientsPath(tenantSlug, { ...keep, page: page.page + 1 })}
          >
            {t('list.pager.next')}
          </Link>
        ) : null}
      </div>
      <p className="spa-admin-toolbar__caption">
        {t('list.pager.position', { page: page.page, total: page.totalPages })}
      </p>
    </nav>
  );
}

/**
 * La fiche : coordonnées, compteurs, note interne, historique — critères 2 à 4.
 *
 * `history` est **nullable** depuis #1416 : il vaut `null` quand le rang ouvre la
 * fiche sans ouvrir l'agrégat. Tout ce qui en dérive — l'avis d'absences, les
 * compteurs, la légende du récapitulatif, la liste des visites — cède alors la
 * place à un état explicite, et rien d'autre ne change. Les coordonnées, les
 * badges, l'avis de suppression et la note interne ne viennent pas de cette
 * lecture-là : ils restent affichés, parce qu'ils ont été obtenus.
 *
 * `canWrite` dit, depuis #1423, si le compte détient `customers:write`. C'est la
 * seule chose dont dépendent les deux formulaires d'écriture : à `false`, le
 * bouton d'édition des coordonnées n'est pas rendu et la note passe en lecture
 * seule. Un seul drapeau pour les deux, parce qu'une seule permission les ouvre
 * tous les deux — en poser un par formulaire aurait laissé croire à deux seuils.
 *
 * `roleKnown` ne change rien à ce qui est rendu : il dit seulement si l'absence
 * d'écriture s'explique **par le rôle** — liste de permissions lue — ou par le
 * doute d'une panne, et c'est la légende de la note qui en dépend.
 */
function ClientRecord({
  canWrite,
  customer,
  display,
  history,
  languages,
  roleKnown,
  t,
  tenantSlug,
  timeZone,
}: {
  readonly canWrite: boolean;
  readonly customer: Customer;
  readonly display: DisplayLocale;
  readonly history: CustomerVisitHistory | null;
  readonly languages: LanguagesTranslator;
  readonly roleKnown: boolean;
  readonly t: ClientsTranslator;
  readonly tenantSlug: string;
  readonly timeZone: TimeZone;
}) {
  const suppression = emailSuppressionNotice(customer);

  return (
    <div className="spa-admin-client">
      <div className="spa-admin-client__header">
        <span aria-hidden="true" className="spa-admin-client__avatar">
          {initialsOf(fullName(customer))}
        </span>
        <div className="spa-admin-client__identity">
          <p className="spa-admin-client__name">{fullName(customer)}</p>
          <div className="spa-admin-client__contact">
            <span className="spa-admin-client__contact-item">
              {customer.phone === null
                ? t('record.noPhone')
                : formatPhoneForDisplay(customer.phone)}
            </span>
            <span className="spa-admin-client__contact-item">{customer.email}</span>
            <PreferredLanguage languages={languages} locale={customer.locale} t={t} />
            <span className="spa-admin-client__contact-item">
              {t('record.createdAt', { date: dayLabel(customer.createdAt, timeZone, display) })}
            </span>
            {/*
              La marque est **collée à l'adresse**, et pas seulement dans le
              bandeau qui suit : c'est la ligne qu'on lit à voix haute au
              téléphone, et un gestionnaire qui la parcourt doit voir tout de
              suite que celle-ci ne sert plus à rien. Le libellé est écrit ;
              l'aplat ne fait que rendre le balayage rapide (WCAG 1.4.1).
            */}
            {suppression === null ? null : (
              <span className="spa-admin-badge spa-admin-badge--no-show">
                {t('record.badges.emailSuppressed')}
              </span>
            )}
            {customer.isActive ? null : (
              <span className="spa-admin-badge spa-admin-badge--cancelled">
                {t('record.badges.inactive')}
              </span>
            )}
          </div>
        </div>
        {/* La clé remonte le composant quand on passe d'une fiche à l'autre :
            sans elle, React conserverait l'état du formulaire précédent et le
            volet d'édition resterait ouvert sur la nouvelle cliente.

            Rien du tout sans `customers:write` (#1423) : les coordonnées sont
            juste au-dessus, en lecture, et c'est le **geste** d'édition qui
            disparaît — pas la donnée. */}
        {canWrite ? (
          <ClientContactForm key={customer.id} customer={customer} tenantSlug={tenantSlug} />
        ) : null}
      </div>

      {/*
        Le quatrième critère de #73, livré ici (#525) : sans cet avis, un
        gestionnaire voit une réservation confirmée sans jamais savoir que la
        cliente n'a rien reçu et ne recevra plus rien — et il n'a aucun moyen de
        le découvrir. `tone="danger"` plutôt que `warning` : ce n'est pas un
        risque à peser, c'est un fait acquis, et l'aplat le dit d'un coup d'œil.
        Le rôle ARIA, lui, ne les distingue pas — le composant rend `role="alert"`
        pour les deux tons, et l'avis interrompt donc la lecture d'un lecteur
        d'écran dans un cas comme dans l'autre.

        L'instant est rendu **au fuseau du salon**, comme toutes les dates de cet
        écran : une suppression lue en UTC daterait de la veille pour la moitié
        des établissements.
      */}
      {suppression === null ? null : (
        <Notification tone="danger" title={t('record.suppression.title')}>
          <p>
            {t('record.suppression.since', {
              date: dayLabel(suppression.suppressedAt, timeZone, display),
              time: formatTimeInTimeZone(suppression.suppressedAt, timeZone, display),
              reason: t(suppression.reasonKey),
            })}
          </p>
          <p>{t('record.suppression.body', { email: customer.email })}</p>
        </Notification>
      )}

      {history === null ? null : (
        <VisitCounters display={display} summary={history.summary} t={t} timeZone={timeZone} />
      )}

      {canWrite ? (
        <ClientNoteForm
          key={customer.id}
          customerId={customer.id}
          internalNote={customer.internalNote}
          tenantSlug={tenantSlug}
        />
      ) : (
        <NoteReadOnly internalNote={customer.internalNote} roleKnown={roleKnown} t={t} />
      )}

      <div>
        <h3 className="spa-admin__section-title">{t('record.history.title')}</h3>
        {history === null ? (
          /*
            Le refus partiel de #1416, dit à l'endroit où l'historique aurait
            été — et non en haut de page, où il se serait lu comme un refus de la
            fiche entière.

            Un état vide et non un `Notification` : rien n'est arrivé d'anormal, et
            l'encart d'avis rend `role="alert"`, ce qui aurait interrompu la
            lecture d'un lecteur d'écran à **chaque** fiche ouverte par une
            praticienne. Les classes sont celles de l'historique vide, déjà
            maquettées : il n'y a pas deux façons de ne rien avoir à montrer dans
            ce bloc.
          */
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{t('record.history.restrictedTitle')}</p>
            <p className="spa-empty-state__description">
              {t('record.history.restrictedDescription')}
            </p>
          </div>
        ) : (
          <VisitHistory display={display} history={history} t={t} timeZone={timeZone} />
        )}
      </div>
    </div>
  );
}

/**
 * La note interne **lue** et non écrite — #1423.
 *
 * Ce que `ClientNoteForm` rend quand le compte n'a pas `customers:write` : le
 * même titre et la même mention « Interne au salon », le texte de la note à la
 * place du champ, et aucun bouton. Le formulaire n'est pas désactivé, il n'est
 * pas là — un `textarea` grisé reste dans le DOM, se réactive d'un clic dans les
 * outils de développement, et continue de promettre un geste que l'API refusera.
 *
 * Un Server Component, et non une variante du formulaire : il n'y a plus aucun
 * état à tenir, et faire descendre `react-hook-form` et `zod` dans le bundle
 * d'une praticienne pour afficher un paragraphe serait payer l'écriture à qui
 * n'écrit pas (web-frontend §1).
 *
 * ## Un état vide, plutôt qu'un bloc muet
 *
 * Une fiche sans note n'affiche pas un cadre vide : elle dit qu'il n'y a rien
 * d'écrit. C'est le motif d'état vide déjà employé par l'historique de cet
 * écran, et il répond à la question qu'on se pose en arrivant — « la note
 * manque-t-elle, ou est-ce mon rôle qui me la cache ? ».
 *
 * Les classes sont celles que la feuille de style admin porte déjà
 * (`styles/admin/client.css`, maquette `mockups/admin/fiche-client.html`) :
 * cet écran n'en invente aucune, et la suite des maquettes refuserait une classe
 * qu'aucune maquette n'exerce.
 */
function NoteReadOnly({
  internalNote,
  roleKnown,
  t,
}: {
  readonly internalNote: string | null;
  /**
   * `true` quand la liste des permissions a bien été lue — et donc que la
   * lecture seule vient **du rôle** et non d'un doute.
   *
   * C'est ce qui décide de la légende : « en lecture seule pour votre rôle »
   * serait faux pour une gérante que seule une panne de `GET /auth/me` a privée
   * de ses formulaires — elle lirait, juste en dessous, l'agrégat que cette même
   * phrase dit réservé aux comptes de gestion.
   */
  readonly roleKnown: boolean;
  readonly t: ClientsTranslator;
}) {
  // Une note vide est une note absente : la chaîne vide ne descend pas jusqu'à
  // la colonne par le formulaire (`client-note-form.tsx`), mais `longTextSchema`
  // l'accepte à l'API — et un cadre vide est exactement le bloc muet que cet
  // état vide existe pour éviter.
  const note = internalNote === null || internalNote.trim() === '' ? null : internalNote;

  return (
    <div className="spa-admin-notes">
      <h3 className="spa-admin__section-title">
        {t('note.title')} <span className="spa-admin-notes__private">{t('note.private')}</span>
      </h3>

      {note === null ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">{t('note.readOnly.emptyTitle')}</p>
          <p className="spa-empty-state__description">{t('note.readOnly.emptyDescription')}</p>
        </div>
      ) : (
        <div className="spa-admin-notes__item">
          <p className="spa-admin-notes__body">{note}</p>
        </div>
      )}

      {/* Pourquoi il n'y a rien à enregistrer, dit une fois — et seulement quand
          une note existe : sous l'état vide, l'explication est déjà dans sa
          description, et la répéter aurait fait deux phrases pour une absence.
          Rien non plus quand le rôle est inconnu : la phrase l'invoque. */}
      {note === null || !roleKnown ? null : (
        <p className="spa-admin-toolbar__hint">{t('note.readOnly.hint')}</p>
      )}
    </div>
  );
}

/**
 * Les compteurs de l'agrégat, l'avis d'absences et la légende qui les explique —
 * les trois blocs que `GET /customers/:id/history` alimente **seul**.
 *
 * Extraits de la fiche en #1416 pour qu'ils disparaissent d'un même geste quand
 * le rang n'ouvre pas l'agrégat : trois gardes séparées dans `ClientRecord`
 * auraient fini par diverger, et il suffisait d'en oublier une pour relire
 * `summary` de `null`.
 */
function VisitCounters({
  display,
  summary,
  t,
  timeZone,
}: {
  readonly display: DisplayLocale;
  readonly summary: CustomerVisitHistory['summary'];
  readonly t: ClientsTranslator;
  readonly timeZone: TimeZone;
}) {
  return (
    <>
      {summary.noShowVisits > 0 ? (
        <Notification
          tone="warning"
          title={t('record.noShow.title', { count: summary.noShowVisits })}
        >
          <p>{t('record.noShow.body')}</p>
        </Notification>
      ) : null}

      {/*
        Chaque libellé s'accorde au compteur qu'il porte — #763, puis #852 : c'est
        ICU qui accorde désormais, et non un ternaire sur `> 1`. Le seuil du
        singulier n'est pas le même dans les deux langues — « 0 visite honorée »
        en français, « 0 completed visits » en anglais —, et une règle écrite en
        TypeScript aurait été une règle française déguisée en code. « À venir » et
        « Total honoré » restent invariables : rien à accorder.
      */}
      <div className="spa-admin-client__metrics">
        <Metric
          label={t('record.metrics.honored', { count: summary.honoredVisits })}
          value={String(summary.honoredVisits)}
        />
        <Metric label={t('record.metrics.upcoming')} value={String(summary.upcomingVisits)} />
        {/*
          Deux compteurs et non un — #917. « 5 Annulés » là où la fiche comptait
          trois abandons et deux déplacements donnait au salon un chiffre de
          fidélité faux, et c'est le constat de l'audit `d20260916-1` : un créneau
          déplacé n'est pas un créneau perdu. Les deux sont disjoints, et leur
          somme reste le nombre de rendez-vous annulés en base.
        */}
        <Metric
          label={t('record.metrics.cancelled', { count: summary.cancelledVisits })}
          value={String(summary.cancelledVisits)}
        />
        <Metric
          label={t('record.metrics.rescheduled', { count: summary.rescheduledVisits })}
          value={String(summary.rescheduledVisits)}
        />
        <Metric
          label={t('record.metrics.noShow', { count: summary.noShowVisits })}
          value={String(summary.noShowVisits)}
        />
        <Metric
          label={t('record.metrics.totalSpent')}
          value={
            summary.totalSpent === null
              ? t('record.metrics.none')
              : formatMoney(summary.totalSpent, display)
          }
        />
      </div>

      {/*
        La légende ne dépend plus de l'existence d'un rendez-vous — #763. Elle
        n'était rendue que sur une fiche qui en portait, si bien que la fiche
        **sans** visite — celle qui affiche justement « Total honoré — » —
        montrait un tiret cadratin que rien n'expliquait. C'est l'inverse de ce
        qu'il faut : le tiret a d'autant plus besoin d'être lu qu'il est seul.
        Seule la phrase d'ouverture varie donc ; l'explication est constante, et
        couvre les deux raisons du tiret — aucune visite honorée, ou plusieurs
        devises mêlées.
      */}
      <p className="spa-admin-toolbar__hint">
        {summary.totalVisits === 0
          ? t('record.summary.none')
          : t('record.summary.counts', {
              count: summary.totalVisits,
              first:
                summary.firstVisitAt === null
                  ? t('record.metrics.none')
                  : dayLabel(summary.firstVisitAt, timeZone, display),
              last:
                summary.lastVisitAt === null
                  ? t('record.metrics.none')
                  : dayLabel(summary.lastVisitAt, timeZone, display),
            })}{' '}
        {t('record.summary.caption')}
      </p>
    </>
  );
}

/**
 * La langue dans laquelle la cliente veut qu'on lui parle — #852, troisième
 * critère.
 *
 * Sur la ligne de coordonnées, et pas ailleurs : c'est la ligne qu'on lit avant
 * de décrocher, et une préférence de langue rangée en bas de fiche serait
 * découverte après avoir dit bonjour.
 *
 * `null` est écrit **en toutes lettres** plutôt que replié sur la langue du
 * salon. La nuance est celle que porte la colonne (`users.locale`, nullable
 * depuis #844) : replier aurait fait paraître choisie une langue que personne
 * n'a demandée, et le comptoir n'aurait plus eu aucun moyen de savoir qu'il peut
 * poser la question.
 *
 * Le nom de la langue vient du namespace `locale`, partagé par le sélecteur du
 * parcours public et par les réglages : « Français » et « English » s'écrivent
 * dans leur propre langue, quelle que soit celle de l'interface, et les
 * recopier ici en aurait fait une seconde table à tenir d'accord.
 */
function PreferredLanguage({
  languages,
  locale,
  t,
}: {
  readonly languages: LanguagesTranslator;
  readonly locale: Locale | null;
  readonly t: ClientsTranslator;
}) {
  return (
    <span className="spa-admin-client__contact-item">
      {locale === null
        ? t('record.language.unknown')
        : // L'assertion est l'idiome du sélecteur de langue et des réglages
          // (`locale-switcher.tsx`, `tenant-settings-form.tsx`) : `Locale` a deux
          // valeurs, le catalogue a les deux clés, et le type littéral d'une
          // interpolation ne s'infère pas.
          t('record.language.known', { language: languages(`names.${locale}` as 'names.en') })}
    </span>
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
 *
 * ## La remarque du client, et ce qui la distingue de la note interne — #870
 *
 * Chaque ligne porte ce que le client a écrit **lui-même** en réservant, quand
 * il a écrit quelque chose. Sans elle, « allergie aux huiles essentielles
 * d'agrumes » restait enfermée dans le tiroir du rendez-vous concerné, et la
 * praticienne qui prépare la cabine — laquelle ouvre la fiche, pas les quatre
 * agendas des quatre venues précédentes — ne la voyait jamais. C'est le constat
 * d'origine de l'audit `d20260916-1`.
 *
 * Deux notes coexistent désormais sur cet écran, et les confondre serait pire
 * que n'en montrer qu'une : la note **interne** est écrite par le salon, ne sort
 * jamais vers le client et vaut pour la fiche entière ; celle-ci est écrite par
 * le client, il l'a sous les yeux dans son espace, et elle ne vaut que pour ce
 * rendez-vous-là. Trois choses les séparent ici, dont deux survivent à une
 * impression en gris :
 *
 * 1. **l'emplacement** — la remarque est *dans* la ligne de la visite qu'elle
 *    concerne, la note interne est une section à part, au-dessus de
 *    l'historique ;
 * 2. **le libellé**, écrit en toutes lettres et jamais porté par la seule
 *    couleur (WCAG 1.4.1) : « Remarque du client, écrite à la réservation » face
 *    au « Interne au salon » de l'autre ;
 * 3. l'aplat, qui ne fait qu'accélérer le balayage.
 *
 * Aucun état vide par ligne : sur une fenêtre de cinquante visites, cinquante
 * « aucune remarque » diraient moins que le silence. L'absence de remarque est
 * l'absence de l'élément.
 */
function VisitHistory({
  display,
  history,
  t,
  timeZone,
}: {
  readonly display: DisplayLocale;
  readonly history: CustomerVisitHistory;
  readonly t: ClientsTranslator;
  readonly timeZone: TimeZone;
}) {
  if (history.visits.length === 0) {
    return (
      <div className="spa-empty-state">
        <p className="spa-empty-state__title">{t('record.history.emptyTitle')}</p>
        <p className="spa-empty-state__description">{t('record.history.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <>
      {/* `role="list"` explicite : le socle retire le marqueur de tout `<ol>`
          (#625), et Safari retire alors à VoiceOver la sémantique de liste. Ici
          l'ordre chronologique des visites fait sens — il doit rester annoncé
          comme une liste (styles/README.md §3). */}
      <ol className="spa-admin-history" role="list">
        {history.visits.map((visit) => {
          const note = visitClientNote(visit.clientNote);

          return (
            <li className="spa-admin-history__item" key={visit.appointmentId}>
              <span className="spa-admin-history__date">
                {dayLabel(visit.startsAt, timeZone, display)}
                <br />
                {formatTimeInTimeZone(visit.startsAt, timeZone, display)}
              </span>
              <span className="spa-admin-history__body">
                <span className="spa-admin-history__service">{visit.serviceName}</span>
                <span className="spa-admin-history__practitioner">
                  {visit.staffName === null
                    ? t('record.history.staffRemoved')
                    : t('record.history.withStaff', { name: visit.staffName })}
                </span>
                <span className={`spa-admin-badge spa-admin-badge--${statusModifier(visit.status)}`}>
                  {/* « Déplacé » plutôt qu'« Annulé » sur l'origine d'un report
                      — la visite n'a pas été perdue, elle a changé d'heure
                      (#917). Le mot est celui que l'espace client montre à la
                      cliente, à la personne grammaticale près, et il vient du
                      seul module du front qui écrive ce vocabulaire — d'où la
                      langue passée en troisième argument plutôt qu'une table de
                      plus au catalogue de cet écran. */}
                  {appointmentOutcomeLabel(visit, 'desk', display.locale)}
                </span>
                {note === null ? null : (
                  <span className="spa-admin-history__note">
                    {/* Le libellé porte l'appartenance, pas l'aplat : c'est lui
                        qui interdit de lire cette remarque comme la note interne
                        du salon, y compris sans couleur (WCAG 1.4.1). */}
                    <span className="spa-admin-history__note-label">
                      {t('record.history.clientNote')}
                    </span>
                    <span className="spa-admin-history__note-body">{note}</span>
                  </span>
                )}
              </span>
              <span
                className={
                  isVoidVisit(visit.status)
                    ? 'spa-admin-history__amount spa-admin-history__amount--void'
                    : 'spa-admin-history__amount'
                }
              >
                {formatMoney(visit.price, display)}
              </span>
            </li>
          );
        })}
      </ol>

      {history.summary.totalVisits > history.visits.length ? (
        <p className="spa-admin-toolbar__hint">
          {t('record.history.truncated', {
            shown: history.visits.length,
            total: history.summary.totalVisits,
          })}
        </p>
      ) : null}
    </>
  );
}

/**
 * La date civile d'un instant, dans le fuseau du salon et la langue de l'écran.
 *
 * Composée de deux fonctions existantes plutôt qu'écrite ici : `zonedFields`
 * découpe l'instant UTC à l'horloge du salon, `formatCalendarDate` met en forme
 * la date civile qui en sort. Aucun `Intl` de plus dans le front — c'est la
 * règle de `lib/format.ts`, et un troisième formateur finirait par diverger des
 * deux autres sur une frontière de jour.
 *
 * Le fuseau et la langue sont deux choses distinctes, et le restent : le
 * découpage se fait toujours à l'heure du salon (ADR 0006), seule la mise en
 * forme suit la langue de qui regarde (#852).
 */
function dayLabel(instant: string, timeZone: TimeZone, display: DisplayLocale): string {
  return formatCalendarDate(zonedFields(instant, timeZone).date, display);
}
