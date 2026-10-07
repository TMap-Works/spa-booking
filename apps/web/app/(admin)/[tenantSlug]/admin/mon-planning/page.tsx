import {
  ERROR_CODES,
  hasAtLeastRole,
  type CalendarDate,
  type MyStaffAgenda,
  type MyStaffAppointment,
  type MyStaffProfile,
  type MyStaffSchedule,
} from '@spa/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { telUri } from '@/components/salon/salon-contact';
import { DateBlock } from '@/components/ui/date-block';
import { NavTabs } from '@/components/ui/nav-tabs';
import {
  ApiClientError,
  fetchMyAgenda,
  fetchMySchedule,
  fetchMyStaffProfile,
  fetchPublicTenant,
} from '@/lib/api-client';
import { parseCalendarDate, rangeLabel, todayInTimeZone } from '@/lib/admin/calendar-range';
import { statusModifier } from '@/lib/admin/calendar-grid';
import {
  MY_PLANNING_VIEWS,
  UPCOMING_DAYS,
  appointmentsByDay,
  bookedCount,
  cancelledCount,
  clientLabel,
  dayBoundsInTimeZone,
  daysOf,
  myPlanningViewLabels,
  nextAppointment,
  parseMyPlanningView,
  parseShowCancelled,
  planningRange,
  shiftPlanningAnchor,
  showsToday,
  upcomingOnly,
  withCancelledShown,
  withoutCancelled,
  workingDay,
  type MyPlanningView,
  type WorkingLine,
} from '@/lib/admin/my-planning';
import { appointmentStatusLabels } from '@/lib/appointment-status';
import {
  formatCalendarDate,
  formatDuration,
  formatTimeInTimeZone,
  formattingLocale,
  type DisplayLocale,
} from '@/lib/format';
import { formatPhoneForDisplay } from '@/lib/phone';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

import { adminClientsPath } from '../clients/paths';
import { MyAppointmentActions, MyPlanningAutoRefresh } from '../components/my-planning-client';
import { PeriodNav } from '../components/period-nav';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { loadAdminShell } from '../layout';
import { adminCalendarPath, adminMyPlanningPath } from '../paths';
import { adminNewStaffMemberPath } from '../personnel/paths';

/**
 * « Mon planning » — l'emploi du temps du praticien connecté (#813).
 *
 * ## Ce que l'écran montre, et d'où il le tient
 *
 * Ses rendez-vous (`GET /v1/me/appointments`), ses horaires, ses absences et
 * les jours de fermeture du salon (`GET /v1/me/schedule`) — **les siens
 * seulement** : les routes `me` résolvent la fiche par le jeton, aucun
 * identifiant n'y entre. C'est l'arbitrage du PO du 16/09 : « le praticien ne
 * voit que son propre planning ».
 *
 * ## Pensé pour le téléphone d'abord
 *
 * Une liste par journée plutôt qu'une grille horaire : entre deux soins, la
 * praticienne veut savoir **qui** vient **quand**, pas mesurer des colonnes.
 * Un appui sur un rendez-vous déplie son détail — référence, notes, gestes.
 *
 * ## Ce que le détail déplié dit de la cliente (#1404)
 *
 * Il ne disait que « Bruno N. » et la référence : ni numéro, ni alerte, ni chemin
 * vers la fiche. Il porte désormais, dans cet ordre, **l'alerte de la fiche
 * au-dessus des notes** (allergie, contre-indication), le **téléphone
 * cliquable**, la référence, les notes, puis un lien **« Voir la fiche »**
 * (BM-AGENDA-09, BM-COMPTOIR-05).
 *
 * Rien de cela n'ouvre une donnée nouvelle à la praticienne : `customers:read:own`
 * lui donne déjà la fiche des personnes qu'elle reçoit, et elle lisait ces trois
 * champs dans « Clients » — sur un second écran, après le soin. L'arbitrage et ce
 * qui reste dehors sont écrits une seule fois, dans
 * `myStaffAppointmentClientSchema` du contrat partagé.
 *
 * ## Trois vues
 *
 * Jour (par défaut), Semaine, et « À venir » : les trente et un prochains
 * jours, rendez-vous encore attendus seulement. Vue et date sont dans
 * l'adresse, pour qu'un rafraîchissement ne ramène pas à aujourd'hui.
 *
 * ## La reprise de conception
 *
 * L'écran empilait trois niveaux de cadre — barre en carte, journée en carte,
 * rendez-vous en carte — et la vue semaine rangeait sept boîtes de hauteurs
 * inégales en deux colonnes : on y voyait des boîtes, pas une semaine. Il est
 * désormais **un agenda** : une seule surface (`.spa-my-agenda`), où une
 * journée est une section à colonne de date et un rendez-vous une ligne séparée
 * par un filet. Le détail s'y déplie dans la ligne, qui devient un bloc teinté.
 *
 * Il dessinait aussi sa propre barre de période et son propre libellé de
 * semaine ; il emprunte désormais ceux du reste du back-office — `PeriodNav`
 * dans une `.spa-admin-toolbar`, `rangeLabel` pour la période. Trois conséquences
 * qui se voient :
 *
 *   - le retour « Aujourd'hui » se **désactive** quand la période ouverte
 *     contient déjà la journée du salon. C'est l'état où l'écran s'ouvre : le
 *     lien pointait la page où l'on était déjà, et le tout premier clic de la
 *     praticienne ne produisait rien ;
 *   - la date n'est plus écrite trois fois — barre du haut, sous-titre, en-tête
 *     de journée — mais une fois, entre les deux chevrons ;
 *   - la barre dit ce que la période pèse, annulés exclus.
 *
 * ## Ce que la barre tenait encore de travers (#1405)
 *
 * La promesse « une fois, entre les deux chevrons » n'était pas tenue en vue
 * Jour : la barre annonçait « Vendredi 2 octobre 2026 », et la journée unique
 * qu'elle coiffe réécrivait la même date juste dessous. Une vue qui ne montre
 * **qu'un** jour n'a pas à le nommer deux fois — sa colonne de date ne porte
 * donc plus qu'un titre masqué, pour que la section garde son nom accessible.
 * Les deux vues qui en montrent plusieurs, elles, en ont besoin : chaque journée
 * y porte sa date, et c'est le **bloc de date du design system**
 * (`components/ui/date-block.tsx`) qui la dessine. L'écran le redessinait à
 * l'identique sous `.spa-my-day__date` — trois morceaux, les mêmes abréviations,
 * la même date entière masquée — là où un composant existait déjà.
 *
 * Deux conséquences de plus, toutes deux relevées à 360 px :
 *
 *   - le libellé de la vue Jour est **court** (« Ven. 2 oct. 2026 ») là où la
 *     date entière chassait le chevron « › » seul à la ligne sous « ‹ » ;
 *   - le retour « Aujourd'hui » désactivé était peint par la règle générique du
 *     bouton — aplat gris plein, bordure comprise —, ce qui en faisait le bloc
 *     le plus lourd de la barre alors qu'actif c'est un simple lien. Il reste
 *     plat et atténué (`styles/admin/my-planning.css`).
 *
 * ## Un annulé quitte la grille, pas l'écran (#1410, BM-AGENDA-11)
 *
 * Ils restaient tous dans la liste, barrés et grisés, au motif que la
 * praticienne doit savoir qu'un créneau s'est libéré. Une campagne de QA a
 * relevé ce que cela donne au bout de quelques jours : quatre lignes « Annulé »
 * empilées sur un lundi, sous une barre de période qui annonçait « Aucun
 * rendez-vous » — le compte, lui, les excluait déjà (`bookedCount`). On lisait
 * donc une journée chargée là où il n'y avait rien.
 *
 * Ils sont désormais **masqués par défaut**, et un interrupteur « Afficher les
 * annulés (n) » les rappelle depuis la barre de période. Trois choix qui se
 * voient :
 *
 *   - l'état vit dans l'adresse (`?annules=1`), comme la vue et la date : le
 *     rafraîchissement d'une minute de l'écran et un renouvellement de session
 *     rendent la main sur la liste qu'on regardait, et le lien se partage ;
 *   - l'interrupteur n'existe que si la période porte un annulé — un contrôle
 *     qui ne change rien se lit comme une panne — et il **compte** ce qu'il
 *     montrerait, pour qu'on sache s'il vaut le clic ;
 *   - la vue « À venir » ne bouge pas : elle ne gardait déjà que les rendez-vous
 *     encore attendus, annulés exclus par définition (`upcomingOnly`).
 *
 * Il est rendu par cet écran et non par `PeriodNav`, la barre partagée avec le
 * planning du salon : celui-ci attend le même interrupteur (#982), et c'est ce
 * ticket-là qui lui donnera un emplacement de filtre, en une seule fois pour les
 * deux écrans.
 *
 * Le reste est dans `styles/admin/my-planning.css`, qui porte le détail de la
 * mise en page et la discipline de l'accent — il était sur chaque ligne, il ne
 * reste que là où il désigne (BM-VISUEL-01).
 *
 * ## Le compte sans fiche praticien, et à qui l'écran parle (#1411)
 *
 * `GET /v1/me/staff-profile` répond 404 à tout compte du salon qui n'a pas de
 * fiche praticien — y compris une gérante ou une administratrice, qui en
 * obtiennent une parce qu'elles donnent aussi des soins. L'écran leur disait
 * « Demandez à la gérance de créer votre fiche dans « Personnel » » : la
 * gérance, c'est elle, et le seul bouton de l'état vide ouvrait le planning du
 * salon — pas « Personnel », qu'elle a pourtant dans son rail.
 *
 * Le message et l'action dépendent donc du **rang**, et le seuil est
 * `manager` : c'est celui de `POST /v1/staff` (`catalog/staff.controller.ts`,
 * `@AuthAtLeast('MANAGER')`), et c'est celui que `personnel/nouveau/page.tsx`
 * relit déjà avant de servir son formulaire. Le rang plutôt qu'une permission
 * parce que la création d'une fiche n'en consomme aucune — `accounts:read` n'ouvre
 * que l'annuaire —, et parce que deux conditions écrites séparément pour la même
 * route finissent par diverger.
 *
 * Ce qui en découle, et qui est la conduite déjà tranchée au rang praticien
 * (#1176) — **un état vide ne propose pas un écran fermé au rôle, et il nomme le
 * vrai motif** :
 *
 *   - à partir de `manager`, le texte dit qu'elle tient le personnel de ce salon
 *     et l'action accentuée mène à la création de sa fiche. Son propre compte
 *     figure dans la liste des comptes rattachables, `manager` étant un rôle du
 *     personnel (`STAFF_ROLES`) : le geste aboutit, il ne promet pas un 403 ;
 *   - au rang praticien, rien ne change — « demandez à la gérance » est le vrai
 *     motif, et aucun lien ne lui est offert ;
 *   - une panne de `GET /auth/me` rabat le shell sur `staff` (`OUTAGE_ROLE`) et
 *     donc sur le second message. C'est le bon sens du doute : on ne propose pas
 *     un geste sur un rang qu'on ignore.
 *
 * La sortie « Ouvrir le planning du salon » reste, derrière `agenda:read:all` qui
 * la conditionnait déjà, mais en action **secondaire** : elle ne répond pas à la
 * question que l'écran pose.
 *
 * ## La langue (#1104)
 *
 * Les mots viennent du namespace `admin-my-planning` — sauf le statut d'un
 * rendez-vous, qui vient de `lib/appointment-status.ts`, seul endroit du front
 * où ce vocabulaire s'écrit. Les **clés** de vue restent françaises : ce sont des
 * segments d'URL (`?vue=semaine`), et les traduire changerait les adresses d'un
 * salon anglophone sans rien lui apprendre.
 *
 * Le **fuseau reste celui du salon**, dans les deux langues : l'agenda le porte
 * (`agenda.timezone`) et c'est lui qui décide de la journée sur laquelle on
 * ouvre. La langue et la région — le pays de l'établissement, lu sur la coquille
 * du back-office — ne disent que la façon d'écrire une heure, jamais quelle heure
 * il est (`CLAUDE.md`).
 *
 * ## L'écart d'hydratation de la vue Semaine — l'instrument, pas l'écran (#1407)
 *
 * Une campagne de QA a relevé ici, au chargement de `?vue=semaine`, le
 * « A tree hydrated but some attributes of the server rendered HTML didn't match
 * the client properties » de React. Rien n'a été corrigé dans cet écran, et c'est
 * le résultat de l'enquête, consigné pour que la prochaine campagne ne la
 * recommence pas.
 *
 * Le diff que React joint à son message ne nomme **qu'un** attribut, et il n'est
 * pas dans cette page : `style={{caret-color:"transparent"}}`, sur les trois
 * boutons radio du sélecteur de thème de la barre du back-office
 * (`components/ui/theme-toggle.tsx`). Trois faits le rattachent au navigateur de
 * recette et non au produit :
 *
 *   - `caret-color` ne s'écrit nulle part sous `apps/` ni `packages/` ;
 *   - `playwright-core` le pose en ligne, `!important`, sur chaque
 *     `input, textarea, [contenteditable]` avant une capture d'écran — c'est le
 *     masquage du curseur de saisie, actif par défaut —, puis le **retire** après
 *     coup. Une capture prise pendant que React hydrate laisse donc l'attribut
 *     dans le DOM au moment précis où il est comparé ;
 *   - un relevé voisin de la même série porte la trace du retrait : le même
 *     message, avec `style={{}}` pour seul écart — l'attribut vidé que la
 *     restauration laisse derrière elle.
 *
 * Rechargée sans capture concurrente, la vue Semaine de ce même écran — semaine
 * peuplée, rendez-vous confirmé et ses gestes montés — rend une console vide.
 * C'est le critère du ticket, et il est tenu sans qu'une ligne de cette page
 * change.
 *
 * Ce qu'il ne fallait surtout pas faire : poser un `suppressHydrationWarning`.
 * Il aurait éteint le témoin sur les seuls champs capables de signaler, demain,
 * une vraie divergence — une heure mise en forme dans le fuseau du poste plutôt
 * que dans celui du salon, par exemple, qui est le défaut que `CLAUDE.md` classe
 * en sévérité haute. Le défaut est dans la façon de mesurer : il se répare du
 * côté de l'outil de recette, pas du côté de l'écran mesuré.
 */

export const dynamic = 'force-dynamic';

type MyPlanningTranslator = Awaited<ReturnType<typeof getTranslations<'admin-my-planning'>>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin-my-planning');

  return { title: t('metadata.title') };
}

interface MyPlanningPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{
    readonly vue?: string;
    readonly date?: string;
    /** `1` quand l'interrupteur « Afficher les annulés » est enclenché (#1410). */
    readonly annules?: string;
    readonly session?: string | readonly string[];
  }>;
}

/**
 * Ce qu'annonce la barre de période.
 *
 * La **semaine** emprunte `rangeLabel` — le libellé du planning du salon et de
 * l'encaissement. Il n'y a ainsi qu'une écriture d'une semaine dans le
 * back-office, et elle s'y dit « 21 – 27 septembre 2026 » là où cet écran
 * l'écrivait en toutes lettres des deux côtés : à 360 px, les cinquante-quatre
 * caractères de « Du lundi 21 septembre 2026 au dimanche 27 septembre 2026 »
 * chassaient les deux chevrons sur trois lignes.
 *
 * `rangeLabel` compte la semaine du lundi par défaut — c'est aussi ce que
 * `planningRange` demande à l'API, et les deux ne peuvent donc pas diverger.
 *
 * Le **jour**, lui, s'écrit court — « Ven. 2 oct. 2026 » et non la date
 * entière que rend `rangeLabel`. C'est la suite du même raisonnement, poussée
 * d'un cran parce que le constat s'est répété (#1405) : vingt-trois caractères
 * dans une rangée de 360 px qui porte déjà deux chevrons et un retour au jour
 * courant, et le « › » passait seul à la ligne sous le « ‹ ». Rien n'est perdu
 * — jour de la semaine, quantième, mois et année sont tous là, abrégés — et
 * l'écran ne montre qu'une journée dans cette vue, qui n'a donc pas d'autre
 * endroit où lire sa date.
 *
 * Le planning du salon garde `rangeLabel` dans ses deux vues : il affiche une
 * grille horaire, pas une journée unique, et sa barre n'a pas le même voisinage.
 *
 * « À venir » n'est pas une période datée mais un horizon : son libellé reste
 * une phrase du catalogue, paramétrée par la borne de l'API.
 */
function periodLabel(
  view: MyPlanningView,
  anchor: CalendarDate,
  t: MyPlanningTranslator,
  display: DisplayLocale,
): string {
  if (view === 'a-venir') return t('period.upcoming', { days: UPCOMING_DAYS });
  // La vue Jour est le cas particulier, et c'est elle qu'on nomme : `rangeLabel`
  // — l'écriture d'une période partagée avec le planning du salon et
  // l'encaissement — reste le défaut, pour qu'une vue datée ajoutée demain
  // hérite d'elle et non du libellé d'une journée unique.
  if (view === 'jour') return shortDayLabel(anchor, display);

  return rangeLabel(view, anchor, display);
}

/**
 * « Ven. 2 oct. 2026 » — la journée en abrégé, dans la langue et la région de
 * l'écran.
 *
 * Mise en forme **en UTC** sur minuit, comme `formatCalendarDate` et
 * `agendaDate` : une date civile est déjà celle de l'établissement, et la
 * reprojeter dans un fuseau la décalerait d'un jour à l'est de Greenwich.
 *
 * La première lettre est mise en capitale parce qu'`Intl` rend « ven. » en
 * français et que la barre ouvre une phrase — c'est ce que `rangeLabel` fait
 * déjà de son côté pour la vue Jour du planning du salon.
 *
 * Écrit ici et non dans `lib/admin/my-planning.ts`, où le reste de ce que cet
 * écran décide d'une date se trouve : ce ticket a pour empreinte la barre de
 * période et l'écran, pas la bibliothèque — deux tickets du même jalon se
 * partagent l'arborescence. Le déplacement, et la suppression d'`agendaDate`
 * que ce diff laisse sans appelant de production, sont notés dans la PR.
 */
function shortDayLabel(day: CalendarDate, display: DisplayLocale): string {
  const text = new Intl.DateTimeFormat(formattingLocale(display.locale, display.countryCode), {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));

  return text.length === 0
    ? text
    : `${text.charAt(0).toLocaleUpperCase(display.locale)}${text.slice(1)}`;
}

export default async function MyPlanningPage({ params, searchParams }: MyPlanningPageProps) {
  const { tenantSlug } = await params;
  const query = await searchParams;
  const t = await getTranslations('admin-my-planning');
  const locale = await getLocale();
  const view = parseMyPlanningView(query.vue);
  const requested = parseCalendarDate(query.date);
  const showCancelled = parseShowCancelled(query.annules);
  // La période ouverte, sans l'interrupteur : c'est la base des deux adresses
  // qui suivent, et la seule construite par `adminMyPlanningPath`.
  const period = adminMyPlanningPath(tenantSlug, {
    view,
    ...(requested === null ? {} : { date: requested }),
  });
  // L'adresse où l'on est — annulés compris : un renouvellement de session doit
  // rendre la main sur la liste qu'on regardait, et non sur celle d'avant le
  // clic (#1410, même raison que le filtre du catalogue).
  const here = withCancelledShown(period, showCancelled);
  const renewal = { returnTo: here, attempted: isRenewalReturn(query[RENEWAL_PARAM]) };
  const accessToken = await requireAdminAccessToken(tenantSlug, here);

  // Le fuseau du salon, déjà lu par le layout ; relu de la vitrine si le shell
  // n'a pas pu le dire. La journée par défaut est **celle du salon**. Le pays
  // vient de la même source, et ne sert qu'à la mise en forme (#1104).
  const shell = await loadAdminShell(tenantSlug);
  let timeZone = shell?.timeZone ?? null;
  let countryCode = shell?.countryCode ?? null;

  let profile: MyStaffProfile;
  let agenda: MyStaffAgenda;
  let schedule: MyStaffSchedule;

  try {
    if (timeZone === null) {
      const vitrine = await fetchPublicTenant(tenantSlug);
      timeZone = vitrine.timezone;
      countryCode ??= vitrine.address?.country ?? null;
    }
    const today = todayInTimeZone(timeZone);
    const range = planningRange(view, requested ?? today, today);

    [profile, agenda, schedule] = await Promise.all([
      fetchMyStaffProfile(accessToken),
      fetchMyAgenda(accessToken, range),
      fetchMySchedule(accessToken, range),
    ]);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === ERROR_CODES.STAFF_PROFILE_NOT_FOUND) {
      // Qui tient le personnel de ce salon n'a personne à qui demander : le rang
      // décide du message et de l'action. Le seuil, la raison d'un rang plutôt
      // que d'une permission, et ce qu'un shell muet donne : en tête de fichier,
      // « Le compte sans fiche praticien, et à qui l'écran parle » (#1411).
      const managesStaff = shell !== null && hasAtLeastRole(shell.role, 'manager');

      return (
        <section aria-labelledby="mon-planning-titre" className="spa-my-planning">
          <h1 className="spa-admin__title" id="mon-planning-titre">
            {t('title')}
          </h1>
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{t('noProfile.title')}</p>
            <p className="spa-empty-state__description">
              {managesStaff ? t('noProfile.managerBody') : t('noProfile.body')}
            </p>
            {/* L'action d'abord, et accentuée : c'est le geste qui fait sortir de
                cet état. La sortie vers le planning du salon la suit, en retrait
                — regarder la journée des autres ne crée aucune fiche. */}
            {managesStaff ? (
              <Link
                className="spa-button spa-button--accent"
                href={adminNewStaffMemberPath(tenantSlug)}
              >
                <span className="spa-button__label">{t('noProfile.createRecord')}</span>
              </Link>
            ) : null}
            {shell?.permissions?.includes('agenda:read:all') === true ? (
              <Link className="spa-button spa-button--neutral" href={adminCalendarPath(tenantSlug)}>
                <span className="spa-button__label">{t('noProfile.openCalendar')}</span>
              </Link>
            ) : null}
          </div>
        </section>
      );
    }
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.hint'),
      failedTitle: t('denied.failedTitle'),
      renewal,
    });
  }

  const zone = agenda.timezone;
  const display: DisplayLocale = { locale, countryCode };
  const now = new Date();
  const today = todayInTimeZone(zone);
  const anchor = requested ?? today;
  const viewLabels = myPlanningViewLabels(locale);
  // Ce que la période porte, avant l'interrupteur. « À venir » n'en garde déjà
  // que les rendez-vous encore attendus — annulés exclus par définition —, et
  // l'interrupteur n'y a donc rien à proposer : son compte y vaut zéro, et c'est
  // ce qui l'efface de la barre sans qu'un cas particulier ait à le dire.
  const inPeriod =
    view === 'a-venir' ? upcomingOnly(agenda.appointments, now) : agenda.appointments;
  // Les annulés quittent la grille, pas l'écran (#1410, BM-AGENDA-11).
  const cancelled = cancelledCount(inPeriod);
  const shown = showCancelled ? inPeriod : withoutCancelled(inPeriod);
  const byDay = appointmentsByDay(shown, zone);
  const days = view === 'a-venir' ? [...byDay.keys()] : daysOf(agenda.from, agenda.to);
  // Le prochain rendez-vous est désigné sur **toute** la période affichée et non
  // journée par journée : une semaine dont le lundi est passé met la marque au
  // mardi, ce qu'un calcul par jour ne saurait pas faire.
  const next = nextAppointment(shown, now);

  return (
    <section aria-labelledby="mon-planning-titre" className="spa-my-planning">
      <MyPlanningAutoRefresh />

      <header className="spa-my-planning__head">
        <span className="spa-my-planning__who">{profile.displayName}</span>
        <h1 className="spa-admin__title" id="mon-planning-titre">
          {t('title')}
        </h1>
      </header>

      <NavTabs
        items={MY_PLANNING_VIEWS.map((candidate) => ({
          // L'interrupteur des annulés suit la vue comme la date la suit, et pour
          // la même raison : on change d'onglet sans vouloir rouvrir ce qu'on
          // venait de refermer. Il tombe sur « À venir », qui n'affiche que les
          // rendez-vous encore attendus — un `?annules=1` y resterait écrit dans
          // l'adresse sans rien y changer (#1410).
          href: withCancelledShown(
            adminMyPlanningPath(tenantSlug, {
              view: candidate,
              ...(requested === null || candidate === 'a-venir' ? {} : { date: requested }),
            }),
            candidate !== 'a-venir' && showCancelled,
          ),
          label: viewLabels[candidate],
          current: candidate === view,
        }))}
        label={t('tabsLabel')}
      />

      {/*
       * La barre de période est celle du planning du salon et de l'encaissement
       * (`PeriodNav`, #629) : même geste, même rendu, même place. Elle remplace
       * trois liens dessinés à part, où la date était à chercher dans l'en-tête
       * plutôt qu'entre les deux chevrons.
       *
       * Des liens et non des gestes : l'écran est rendu par le serveur, et la
       * vue comme la date vivent dans l'adresse (web-frontend §1).
       */}
      <div className="spa-admin-toolbar">
        {view === 'a-venir' ? (
          <span className="spa-admin-toolbar__caption">
            {periodLabel(view, anchor, t, display)}
          </span>
        ) : (
          <PeriodNav
            label={periodLabel(view, anchor, t, display)}
            next={{
              href: withCancelledShown(
                adminMyPlanningPath(tenantSlug, {
                  view,
                  date: shiftPlanningAnchor(view, anchor, 1),
                }),
                showCancelled,
              ),
            }}
            nextLabel={view === 'semaine' ? t('nav.nextWeek') : t('nav.nextDay')}
            previous={{
              href: withCancelledShown(
                adminMyPlanningPath(tenantSlug, {
                  view,
                  date: shiftPlanningAnchor(view, anchor, -1),
                }),
                showCancelled,
              ),
            }}
            previousLabel={view === 'semaine' ? t('nav.previousWeek') : t('nav.previousDay')}
            today={{
              href: withCancelledShown(
                adminMyPlanningPath(tenantSlug, { view }),
                showCancelled,
              ),
            }}
            todayIsCurrent={showsToday(agenda.from, agenda.to, today)}
          />
        )}

        <div className="spa-admin-toolbar__group spa-admin-toolbar__spacer">
          <span className="spa-admin-toolbar__hint">
            {t('toolbar.load', { count: bookedCount(shown) })}
          </span>
          {/*
           * L'interrupteur des annulés — #1410, BM-AGENDA-11.
           *
           * Après le compte et non avant : c'est lui qui répond à la question que
           * le compte soulève. « Aucun rendez-vous · Afficher les annulés (4) »
           * se lit d'une traite, là où quatre lignes barrées sous un compte à
           * zéro se contredisaient.
           *
           * Un lien et non une case à cocher : l'écran est rendu par le serveur
           * et le filtre vit dans l'adresse, comme la vue et la date
           * (web-frontend §1). Son libellé **dit l'état où il mène** — « Afficher »
           * quand ils sont masqués, « Masquer » quand ils sont là —, ce qui lui
           * suffit comme nom accessible : un `aria-pressed` n'existe pas sur un
           * lien, et le dupliquer en `aria-label` n'ajouterait rien à ce qui est
           * déjà écrit.
           *
           * Absent quand la période n'en porte aucun : il n'y aurait rien à
           * montrer, et un contrôle qui ne change rien se lit comme une panne.
           *
           * Dans la barre de cet écran et non dans `PeriodNav` : la barre est
           * partagée avec le planning du salon, qui attend le même interrupteur
           * (#982) — c'est là qu'elle gagnera un emplacement de filtre, en une
           * seule fois pour les deux écrans.
           */}
          {cancelled === 0 ? null : (
            <Link
              className="spa-button spa-button--quiet"
              href={withCancelledShown(period, !showCancelled)}
            >
              <span className="spa-button__label">
                {showCancelled
                  ? t('toolbar.hideCancelled', { count: cancelled })
                  : t('toolbar.showCancelled', { count: cancelled })}
              </span>
            </Link>
          )}
        </div>
      </div>

      {days.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">{t('empty.title')}</p>
          <p className="spa-empty-state__description">
            {t('empty.body', { days: UPCOMING_DAYS })}
          </p>
        </div>
      ) : (
        <div className="spa-my-agenda">
          {days.map((day) => (
            <MyDay
              appointments={byDay.get(day) ?? []}
              day={day}
              display={display}
              key={day}
              nextId={next?.id ?? null}
              now={now}
              schedule={schedule}
              // La vue Jour n'en montre qu'une : la barre l'a déjà nommée, entre
              // ses deux chevrons. Les deux autres en alignent plusieurs, et
              // chacune doit se reconnaître d'un coup d'œil (#1405).
              showDate={view !== 'jour'}
              showSchedule={view !== 'a-venir'}
              t={t}
              tenantSlug={tenantSlug}
              today={today}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Un paragraphe du rail : des plages de travail qui se suivent, ou une absence. */
type RailBlock =
  | { readonly timeOff: false; readonly hours: readonly string[] }
  | { readonly timeOff: true; readonly text: string };

/**
 * Les lignes d'une journée regroupées en paragraphes.
 *
 * Deux plages qui se suivent tiennent dans **un même** paragraphe : c'est ce qui
 * les empile à 0,125 rem l'une de l'autre dès 48 rem (`.spa-my-day__hours` passe
 * en colonne), là où deux paragraphes seraient écartés de l'interligne du rail.
 * Une absence, elle, fait toujours son propre paragraphe — sa couleur
 * d'avertissement et son libellé ne se mélangent pas à des heures travaillées.
 *
 * `withHours` est faux dans la vue « À venir », qui ne garde que les absences.
 */
function railBlocks(lines: readonly WorkingLine[], withHours: boolean): readonly RailBlock[] {
  const blocks: ({ timeOff: false; hours: string[] } | { timeOff: true; text: string })[] = [];

  for (const line of lines) {
    const last = blocks.at(-1);
    if (line.timeOff) {
      blocks.push({ timeOff: true, text: line.text });
    } else if (!withHours) {
      continue;
    } else if (last !== undefined && !last.timeOff) {
      last.hours.push(line.text);
    } else {
      blocks.push({ timeOff: false, hours: [line.text] });
    }
  }

  return blocks;
}

/** Une journée : ses horaires, ses absences, puis ses rendez-vous. */
function MyDay({
  appointments,
  day,
  display,
  nextId,
  now,
  schedule,
  showDate,
  showSchedule,
  t,
  tenantSlug,
  today,
}: {
  readonly appointments: readonly MyStaffAppointment[];
  readonly day: CalendarDate;
  readonly display: DisplayLocale;
  /** Le rendez-vous à suivre, désigné sur toute la période — ou aucun. */
  readonly nextId: string | null;
  readonly now: Date;
  readonly schedule: MyStaffSchedule;
  /**
   * La journée porte son bloc de date.
   *
   * Faux en vue Jour, où l'écran n'en aligne qu'une et où la barre de période
   * l'annonce déjà : le titre de la section reste alors écrit pour les lecteurs
   * d'écran, mais plus rien ne le redit à l'œil (#1405).
   */
  readonly showDate: boolean;
  readonly showSchedule: boolean;
  readonly t: MyPlanningTranslator;
  readonly tenantSlug: string;
  readonly today: CalendarDate;
}) {
  const bounds = dayBoundsInTimeZone(day, schedule.timezone);
  const work = workingDay(schedule, day, bounds.start, bounds.end, display);
  const headingId = `jour-${day}`;

  return (
    <section
      aria-labelledby={headingId}
      className={`spa-my-day${day === today ? ' spa-my-day--today' : ''}`}
    >
      {/* La colonne de date — une bande au-dessus des lignes sur téléphone, une
          colonne à leur gauche dès 48 rem. Elle porte tout ce qui vaut pour la
          journée entière : sa date, ses horaires, ses absences. */}
      <div className="spa-my-day__rail">
        {/* Le bloc de date du design system, et non un troisième dessin du même
            objet : l'écran en redessinait un à l'identique — trois morceaux, les
            mêmes abréviations, la même date entière en texte masqué — alors que
            la bande de jours du tunnel et l'historique d'une fiche cliente
            emploient déjà `DateBlock` (#1044, #1405). Il porte la date entière
            pour qui écoute l'écran et les abréviations pour qui le regarde, ce
            qui fait de lui le nom accessible de la section.

            En vue Jour il n'y a rien à distinguer — une seule journée, déjà
            nommée par la barre : le titre reste, masqué, pour que
            `aria-labelledby` ait de quoi s'accrocher. */}
        {showDate ? (
          <h2 className="spa-my-day__heading" id={headingId}>
            <DateBlock date={day} display={display} />
          </h2>
        ) : (
          <h2 className="spa-visually-hidden" id={headingId}>
            {formatCalendarDate(day, display)}
          </h2>
        )}
        {day === today ? <span className="spa-my-day__today">{t('day.today')}</span> : null}
        {/* La journée se lit dans l'ordre que `workingDay` lui donne : ses plages
            encore travaillées, et l'absence qui coupe l'une d'elles juste après
            elle. Un jour fermé ne rend que son mot, et une absence qui a emporté
            toutes les plages prend leur place (#1408).

            Une plage par élément, et non une chaîne jointe par un point médian :
            dans une colonne de neuf rem, « 09:00 – 13:00 · 14:00 – 19:00 » se
            coupait entre le tiret et l'heure de fin. Ce sont les plages qui se
            rangent l'une sous l'autre, pas les heures.

            La clé est le rang et non le texte : deux absences du même praticien
            peuvent tomber sur le même créneau avec le même motif — l'API les
            accepte — et React signalait alors deux enfants de même clé, en
            promettant d'en omettre un (relevé en recette de #1104).

            La vue « À venir » couvre trente et un jours : y répéter les horaires
            d'un mois n'apprendrait rien, mais une absence reste ce qui change
            une journée, et elle s'y affiche seule. */}
        {showSchedule && work.closed ? (
          <p className="spa-my-day__hours">{t('day.closed')}</p>
        ) : showSchedule && work.lines.length === 0 ? (
          <p className="spa-my-day__hours">{t('day.noShift')}</p>
        ) : (
          railBlocks(work.lines, showSchedule).map((block, rank) =>
            block.timeOff ? (
              <p className="spa-my-day__absence" key={`${day}-${String(rank)}`}>
                {work.away
                  ? t('day.away', { span: block.text })
                  : t('day.absence', { span: block.text })}
              </p>
            ) : (
              <p className="spa-my-day__hours" key={`${day}-${String(rank)}`}>
                {block.hours.map((range, index) => (
                  <span key={`${day}-${String(rank)}-${String(index)}`}>{range}</span>
                ))}
              </p>
            ),
          )
        )}
      </div>

      {appointments.length === 0 ? (
        <p className="spa-my-day__empty">{t('day.empty')}</p>
      ) : (
        <ol className="spa-my-day__list" role="list">
          {appointments.map((appointment) => (
            <li key={appointment.id}>
              <MyAppointment
                appointment={appointment}
                display={display}
                isNext={appointment.id === nextId}
                now={now}
                t={t}
                tenantSlug={tenantSlug}
                timeZone={schedule.timezone}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Un rendez-vous — l'essentiel à l'œil, le détail à l'appui (`<details>`,
 * natif : clavier, lecteur d'écran et tactile viennent avec).
 */
function MyAppointment({
  appointment,
  display,
  isNext,
  now,
  t,
  tenantSlug,
  timeZone,
}: {
  readonly appointment: MyStaffAppointment;
  readonly display: DisplayLocale;
  /** Celui vers lequel l'œil doit aller — le prochain encore attendu. */
  readonly isNext: boolean;
  readonly now: Date;
  readonly t: MyPlanningTranslator;
  readonly tenantSlug: string;
  readonly timeZone: string;
}) {
  const classes = [
    'spa-my-appointment',
    appointment.status === 'cancelled' ? 'spa-my-appointment--cancelled' : null,
    isNext ? 'spa-my-appointment--next' : null,
  ]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <details className={classes}>
      <summary className="spa-my-appointment__summary">
        <span className="spa-my-appointment__time">
          <strong>{formatTimeInTimeZone(appointment.startsAt, timeZone, display)}</strong>
          <span>{formatTimeInTimeZone(appointment.endsAt, timeZone, display)}</span>
        </span>
        <span className="spa-my-appointment__what">
          <strong>{appointment.service.name}</strong>
          <span>
            {clientLabel(appointment)} ·{' '}
            {formatDuration(appointment.service.durationMinutes, display)}
          </span>
        </span>
        {/* Statut et marque « prochain » dans la même boîte : ils occupent la même
            place dans la lecture d'une ligne, et c'est cette boîte que la mise en
            page large déplace à droite d'un seul tenant. */}
        <span className="spa-my-appointment__tags">
          <span
            className={`spa-admin-badge spa-admin-badge--${statusModifier(appointment.status)}`}
          >
            {appointmentStatusLabels(display.locale)[appointment.status]}
          </span>
          {isNext ? (
            <span className="spa-my-appointment__flag">{t('appointment.next')}</span>
          ) : null}
        </span>
      </summary>
      <div className="spa-my-appointment__details">
        {/*
         * L'alerte de la fiche — allergie, contre-indication — **au-dessus** des
         * notes et non parmi elles (BM-COMPTOIR-05) : c'est la seule ligne du
         * tiroir qui change ce qu'on fait du produit qu'on va poser sur la peau,
         * et une liste de définitions l'aurait rangée à hauteur de la référence
         * du rendez-vous. Son libellé est **écrit**, pas seulement suggéré par
         * l'aplat ambre : une alerte qui ne tiendrait qu'à une couleur
         * disparaîtrait en impression grise comme pour un daltonien (WCAG 1.4.1).
         */}
        {appointment.client.internalNote === null ? null : (
          <p className="spa-my-appointment__alert">
            {/* Deux éléments et non un texte nu après le libellé : collés, ils
                s'annonceraient « Alerte de la ficheAllergie… » d'une seule
                haleine, et la grille n'aurait rien à espacer. */}
            <strong>{t('appointment.clientAlert')}</strong>
            <span>{appointment.client.internalNote}</span>
          </p>
        )}
        <dl className="spa-my-appointment__facts">
          {/*
           * Le téléphone avant la référence : entre deux soins, la question est
           * « comment je la joins », pas « quel est son code ». Cliquable, parce
           * que l'écran se consulte sur le téléphone qui va composer le numéro —
           * `telUri` est le point d'écriture unique d'un `tel:` du front, et il
           * retire les séparateurs que RFC 3966 n'admet pas. Le libellé, lui,
           * garde l'écriture lisible du numéro.
           */}
          <div>
            <dt>{t('appointment.phone')}</dt>
            <dd>
              {appointment.client.phone === null ? (
                t('appointment.noPhone')
              ) : (
                <a href={telUri(appointment.client.phone)}>
                  {formatPhoneForDisplay(appointment.client.phone)}
                </a>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('appointment.reference')}</dt>
            <dd>{appointment.reference}</dd>
          </div>
          <div>
            <dt>{t('appointment.clientNote')}</dt>
            <dd>{appointment.clientNote ?? t('appointment.noNote')}</dd>
          </div>
          {appointment.staffNote === undefined ? null : (
            <div>
              <dt>{t('appointment.staffNote')}</dt>
              <dd>{appointment.staffNote}</dd>
            </div>
          )}
        </dl>
        {/*
         * « Voir la fiche » — le reste de ce que la praticienne a le droit de
         * lire : préférences, historique, langue (BM-AGENDA-09). Le chemin vient
         * d'`adminClientsPath` et n'est pas concaténé ici ; la fiche s'ouvre dans
         * le volet de droite du fichier client, et la garde de portée de `crm`
         * refusera une fiche qui n'est pas de sa clientèle.
         *
         * ## Ce que l'écran d'arrivée ne tient pas encore
         *
         * `GET /customers/:id` s'ouvre bien au rang praticien
         * (`customers:read:own`), mais `clients/page.tsx` charge **aussi**
         * `GET /customers/:id/history`, qui exige `customers:read:all`. Le 403
         * qui en revient n'est pas un 404, donc `adminLoadFailure` remplace la
         * page entière par « Accès refusé » : le praticien qui suit ce lien
         * n'atteint pas la fiche. Y remédier demande de rendre l'historique
         * facultatif sur cet écran-là ; ce qu'il montre à sa place au rang
         * praticien est une décision de produit, et elle reste à prendre.
         *
         * Le nom accessible du lien porte **celui de la cliente** : trois
         * rendez-vous dépliés offriraient autrement trois liens « Voir la fiche »
         * indiscernables dans la liste des liens d'un lecteur d'écran (WCAG
         * 2.4.4).
         *
         * Il **contient** le libellé visible, et c'est une contrainte sur les
         * deux catalogues : WCAG 2.5.3 demande que `openRecordOf` porte
         * `openRecord` tel quel, sans l'intercaler. D'où « View record for
         * {name} » plutôt que « View {name}'s record », où le nom coupe le
         * libellé en deux et où une commande vocale « click View record » ne
         * trouverait plus rien.
         */}
        <div className="spa-my-appointment__actions">
          <Link
            aria-label={t('appointment.openRecordOf', { name: clientLabel(appointment) })}
            className="spa-button spa-button--quiet"
            href={adminClientsPath(tenantSlug, { customerId: appointment.client.id })}
          >
            <span className="spa-button__label">{t('appointment.openRecord')}</span>
          </Link>
        </div>
        {/* L'heure du soin part telle quelle, et l'instant du rendu avec elle :
            la règle « on ne constate pas ce qui n'a pas eu lieu » est lue par le
            composant, dans le contrat partagé, et non recalculée ici (#1210).
            `renderedAt` est la graine de son horloge — c'est ce qui rend le
            premier rendu du navigateur identique à celui-ci.

            La cliente et l'heure **écrite** partent avec : c'est ce que la
            question d'un constat définitif nomme (#1409), et les deux sont
            composées ici — le nom par `clientLabel`, l'heure par le formateur du
            fuseau de l'établissement, exactement la chaîne que le résumé de la
            ligne affiche. Les recomposer dans le navigateur les exposerait au
            fuseau du poste. */}
        <MyAppointmentActions
          appointmentId={appointment.id}
          clientName={clientLabel(appointment)}
          renderedAt={now.toISOString()}
          startsAt={appointment.startsAt}
          status={appointment.status}
          tenantSlug={tenantSlug}
          timeLabel={formatTimeInTimeZone(appointment.startsAt, timeZone, display)}
        />
      </div>
    </details>
  );
}
