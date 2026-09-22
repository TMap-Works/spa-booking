'use client';

import type {
  CalendarDate,
  DayAvailability,
  PublicService,
  PublicTenant,
  UtcInstant,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SlotPicker } from '@/components/booking/slot-picker';
import { StaffChoice } from '@/components/booking/staff-choice';
import { BookingActionBar, type BookingSummary } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Sheet } from '@/components/ui/sheet';
import { calendarDateInTimeZone } from '@/lib/booking/calendar';
import {
  addMonths,
  bookingWindow,
  formatMonth,
  isNavigableMonth,
  monthOf,
  monthRange,
  type CalendarMonth,
} from '@/lib/booking/month-grid';
import type { DisplayLocale } from '@/lib/format';

import { loadAvailabilityAction } from '../actions';

/**
 * Période de revalidation des disponibilités.
 *
 * Une minute est un compromis, pas une valeur ronde : assez court pour qu'une
 * cliente qui hésite ne choisisse pas dans une liste vieille de dix minutes,
 * assez long pour qu'une page laissée ouverte une après-midi ne fasse pas
 * quelques centaines d'appels. Le rendez-vous se joue de toute façon au verrou
 * serveur — ce rafraîchissement réduit la fenêtre d'erreur, il ne la ferme pas.
 */
const REFRESH_INTERVAL_MS = 60_000;

interface SlotStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  /**
   * Le créneau déjà retenu par le brouillon, quand on **revient** sur l'étape
   * (#947).
   *
   * `null` à la première visite : rien n'a encore été choisi, et l'écran ouvre
   * le mois courant. Non `null`, c'est le geste retour du navigateur, le fil
   * d'étapes ou un lien qui rouvrent l'étape sur un choix déjà fait — l'écran
   * doit alors montrer **ce** moment-là, pas le premier venu.
   */
  readonly startsAt: UtcInstant | null;
  /**
   * Ce que la barre basse rappelle de la réservation en cours (#1047).
   *
   * `null` ne se produit pas depuis le tunnel — cette étape ne s'affiche pas
   * sans prestation résolue — mais le type le porte : c'est l'orchestrateur qui
   * compose le rappel, et lui seul sait s'il a de quoi le faire.
   */
  readonly summary: BookingSummary | null;
  readonly onBack: () => void;
  /** Remonte le praticien retenu au brouillon : il survit au rafraîchissement et sert à la réservation. */
  readonly onStaffChange: (staffId: string | null) => void;
  readonly onChoose: (startsAt: UtcInstant) => void;
}

/**
 * Choix du praticien et du créneau (#44, #351).
 *
 * ## Le calendrier et la grille sont un composant partagé (#622, #827)
 *
 * Ils vivent dans [`SlotPicker`](../../../../../components/booking/slot-picker.tsx),
 * que l'écran de report de l'espace client emploie aussi. Ce qui reste **ici**
 * est ce qui n'appartient qu'au tunnel : le choix du praticien, le chargement et
 * sa revalidation, le mois qu'on regarde, et ce que l'écran dit quand l'agenda
 * est vide. Le sélecteur, lui, ne fait que montrer ce qu'on lui donne.
 *
 * ## La fenêtre chargée est le **mois visible** (#827)
 *
 * Elle était une fenêtre glissante de quatorze jours à partir d'aujourd'hui, que
 * « Voir plus de jours » portait à trente et un. Le choix de la date étant
 * devenu un calendrier mensuel, la question posée au serveur suit ce qu'on
 * regarde : le mois affiché, rogné à aujourd'hui d'un côté et à la fin de la
 * fenêtre de réservation de l'autre. Un mois civil ne dépasse jamais les trente
 * et un jours que `availabilityQuerySchema` plafonne, et le mois courant en
 * demande d'autant moins qu'il est entamé.
 *
 * ## On revient sur cette étape, et elle doit s'en souvenir (#947)
 *
 * Le composant se démonte à chaque fois qu'on la quitte : le geste retour du
 * navigateur, le fil d'étapes et un lien rouvert le remontent à neuf, sans rien
 * de ce qu'il avait à l'écran. Le créneau déjà retenu lui est donc **rendu** par
 * le tunnel (`startsAt`), et l'écran s'ouvre sur son mois, cet horaire marqué
 * comme retenu — plutôt que sur le mois courant.
 *
 * La **journée** ouverte, elle, appartient encore à `SlotPicker`, qui la replie
 * sur la première journée ouverte de la plage : le mois est juste, la grille
 * peut encore montrer un autre jour. Cet écart-là sort de l'empreinte de ce
 * ticket et reste ouvert — voir #947.
 *
 * ## Le praticien se change **ici**, pas un écran plus haut
 *
 * Il se choisit déjà à l'étape prestation, mais c'est devant les créneaux qu'on
 * découvre qu'on s'y est mal pris : la personne demandée n'a rien de libre cette
 * semaine, ou au contraire il n'y avait aucune raison de la demander. Renvoyer à
 * l'étape précédente pour cela ferait perdre la journée qu'on regardait. Le
 * sélecteur est donc rendu dans les deux écrans, sur le même état du brouillon.
 *
 * Une **puce** et non une liste déroulante depuis #1049 — `BM-PRATICIEN-04`,
 * *« au-dessus du calendrier, un sélecteur “Sans préférence ⌄” ; changer de
 * praticien recalcule les créneaux sur place »*. Elle tient sur une ligne, là où
 * la `<select>` et sa phrase d'aide prenaient trois hauteurs de texte au-dessus
 * de la date — sur un écran dont l'enjeu est précisément de remonter les horaires
 * au-dessus de la ligne de flottaison. Le choix lui-même s'ouvre dans un panneau
 * (`BM-TUNNEL-12`) et emploie les **cartes** de l'étape prestation
 * ([`StaffChoice`](../../../../../components/booking/staff-choice.tsx), #1048) :
 * un seul objet nomme et dessine le praticien sur tout le parcours.
 *
 * « Premier disponible » n'est pas une valeur manquante (CDC §1.4) : c'est
 * l'absence de préférence, et c'est le serveur qui affecte alors le praticien.
 * Le front ne choisit jamais à sa place — il déciderait sur un agenda périmé.
 *
 * ## Les journées et leurs créneaux viennent du serveur découpés
 *
 * Regrouper des instants UTC en journées demande le fuseau de l'établissement,
 * et c'est exactement le calcul qu'on ne veut pas voir réimplémenté dans un
 * navigateur. Les heures sont affichées dans ce fuseau, avec sa mention dès que
 * le visiteur n'y est pas — « 09:00 » ne veut rien dire à qui réserve en voyage.
 *
 * ## Les disponibilités se rafraîchissent pendant qu'on hésite
 *
 * À intervalle court **et** au retour sur l'onglet (skill web-frontend §3) :
 * entre le moment où la cliente ouvre la page et celui où elle choisit, un
 * créneau a pu partir. Les recharger ne supprime pas le 409 — seul le verrou
 * serveur le fait — mais évite de proposer longtemps ce qui n'existe plus.
 *
 * ## Les états non nominaux suivent les documents de conception
 *
 * [states.md](../../../../../../../docs/design/appointments/states.md) fixe les
 * trois : squelette de grille **sous une navigation de dates restée opérable** —
 * que `SlotPicker` rend —, état vide qui offre une sortie, état d'erreur qui
 * offre de réessayer. La sortie de l'état vide est passée d'« élargir la
 * fenêtre » à « voir le mois suivant » : c'est le même geste, dans l'idiome du
 * calendrier.
 *
 * ## La langue (#846)
 *
 * Le titre de l'état vide est **quatre messages** et non une phrase assemblée
 * de morceaux : « Aucun créneau avec Nivo en septembre 2026 » et « No available
 * times with Nivo in September 2026 » ne placent ni la préposition ni le nom au
 * même endroit, et une concaténation figerait l'ordre du français.
 *
 * Le message d'erreur affiché, lui, reste celui que l'action rend : les phrases
 * que le front écrit sont traduites (`actions.ts`), celle que l'API renvoie
 * appartient à l'API.
 */
export function SlotStep({
  tenant,
  service,
  staffId,
  startsAt,
  summary,
  onBack,
  onStaffChange,
  onChoose,
}: SlotStepProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  /** La langue du lecteur, la région de l'établissement — le fuseau reste à part. */
  const countryCode = tenant.address?.country ?? null;
  const display: DisplayLocale = { locale, countryCode };
  const [days, setDays] = useState<readonly DayAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** Le choix du praticien est-il ouvert dans son panneau ? — `BM-PRATICIEN-04`. */
  const [staffOpen, setStaffOpen] = useState(false);
  /**
   * La date du jour dans le fuseau du salon, et le mois que le calendrier
   * montre.
   *
   * Tenues en état plutôt que calculées au rendu parce qu'elles dérivent de
   * `new Date()` : les calculer dans le corps du composant les ferait diverger
   * entre le rendu serveur et l'hydratation, une nuit sur trois cent
   * soixante-cinq, à minuit passé dans le fuseau du salon. `null` tant qu'un
   * effet ne les a pas posées — le calendrier n'est alors pas rendu, comme la
   * bande ne l'était pas avant sa première fenêtre.
   */
  const [today, setToday] = useState<CalendarDate | null>(null);
  const [month, setMonth] = useState<CalendarMonth | null>(null);
  const calendarRef = useRef<HTMLDivElement | null>(null);
  /**
   * Où en est le rattrapage du focus après un changement de mois demandé depuis
   * l'état vide.
   *
   * Trois états et non un booléen, parce qu'il faut laisser passer **deux**
   * rendus : celui du clic, où les journées de l'ancien mois sont encore là,
   * puis celui du chargement. S'arrêter au premier ferait poser le focus sur
   * l'écran que le changement de mois est précisément en train de remplacer.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un
   * état déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const catchFocusAfterMonthChange = useRef<'inactif' | 'chargement' | 'resultat'>('inactif');
  /**
   * Numéro de la requête la plus récente.
   *
   * Deux chargements peuvent être en vol en même temps — un changement de
   * praticien pendant qu'une revalidation périodique traîne. Sans ce jeton, la
   * réponse la plus lente écraserait la plus fraîche, et l'écran afficherait
   * l'agenda du praticien qu'on vient de quitter.
   */
  const latestRequest = useRef(0);

  /**
   * La journée du créneau déjà retenu, dans le fuseau du salon (#947).
   *
   * Un instant UTC ne dit pas à lui seul de quelle journée il relève : 21:30 à
   * Antananarivo s'écrit `18:30Z`, et `2026-09-21T22:30:00Z` est déjà le 22 pour
   * le salon. C'est le référentiel de `availabilityQuerySchema` et celui du
   * calendrier — la conversion passe donc par la même fonction que « aujourd'hui ».
   */
  const retainedDate = useMemo(
    () => (startsAt === null ? null : calendarDateInTimeZone(new Date(startsAt), tenant.timezone)),
    [startsAt, tenant.timezone],
  );

  /**
   * Le mois de départ, posé **après le montage** seulement.
   *
   * C'est le pendant du `windowDates` d'avant : l'écran ne peut pas savoir quel
   * jour on est dans le fuseau du salon sans lire l'horloge, et la lire au rendu
   * ferait diverger le serveur et le navigateur une nuit par an. Le mois déjà
   * choisi n'est pas écrasé — un changement d'établissement en cours de tunnel
   * est le seul cas où cet effet se rejoue, et il ne doit pas ramener la
   * visiteuse au mois courant si elle en regardait un autre.
   *
   * Il part du **mois du créneau retenu** dès qu'il y en a un (#947). L'étape se
   * remonte à chaque retour dessus — geste retour du navigateur, fil d'étapes,
   * lien rouvert —, et repartir du mois courant reposait alors au serveur la
   * question de septembre pour un rendez-vous visé en octobre : la journée
   * choisie n'était même pas dans la réponse. `bookingWindow` plafonnant la
   * fenêtre à trente et un jours, ce mois-là est toujours le mois courant ou le
   * suivant ; `load` le repasse de toute façon par `isNavigableMonth`, qui a le
   * dernier mot si minuit l'a emporté derrière la fenêtre.
   */
  useEffect(() => {
    const now = calendarDateInTimeZone(new Date(), tenant.timezone);

    setToday(now);
    setMonth((current) => current ?? monthOf(retainedDate ?? now));
  }, [retainedDate, tenant.timezone]);

  const load = useCallback(async () => {
    if (month === null) {
      return;
    }

    // Relue à chaque chargement et non prise dans l'état : une page laissée
    // ouverte franchit minuit, et la fenêtre de réservation glisse avec.
    const now = calendarDateInTimeZone(new Date(), tenant.timezone);
    const bounds = bookingWindow(now);
    // Minuit a pu emporter le mois qu'on regardait derrière la fenêtre.
    const visible = isNavigableMonth(month, bounds) ? month : monthOf(now);
    const range = monthRange(visible, bounds);

    // Posés **avant** l'attente : c'est ce qui met le calendrier à l'écran en
    // même temps que le squelette, et non une fois la réponse arrivée.
    setToday(now);
    setMonth(visible);

    if (range === null) {
      // Un mois entièrement hors de la fenêtre de réservation n'a rien à
      // demander : le calendrier rend ses cases inertes, et l'écran dit qu'il
      // n'y a rien plutôt que d'attendre une réponse qui ne viendra pas.
      setError(null);
      setDays([]);
      return;
    }

    const query = {
      serviceId: service.id,
      from: range.from,
      to: range.to,
      ...(staffId === null ? {} : { staffId }),
    };

    latestRequest.current += 1;
    const ticket = latestRequest.current;
    const result = await loadAvailabilityAction(tenant.slug, query);

    if (ticket !== latestRequest.current) {
      return;
    }

    if (result.ok) {
      setError(null);
      setDays(result.data.days);
    } else {
      setError(result.message);
      // Une revalidation qui échoue ne vide pas une liste déjà affichée : la
      // panne est passagère, les créneaux montrés restent la meilleure
      // information disponible. Seul un premier chargement en échec pose la
      // liste vide, pour que l'écran ne reste pas en squelette indéfiniment.
      setDays((current) => current ?? []);
    }
  }, [month, service.id, staffId, tenant.slug, tenant.timezone]);

  useEffect(() => {
    // `load` ne change d'identité que lorsque la question posée change —
    // prestation, praticien, établissement, mois regardé. Les créneaux affichés
    // ne répondent alors plus à la question, et les garder à l'écran le temps de
    // l'aller-retour proposerait l'agenda du praticien précédent. On repasse par
    // le chargement.
    setDays(null);
    setError(null);
    void load();

    const revalidate = () => {
      // Un onglet caché n'a personne devant lui : le rafraîchir consommerait des
      // requêtes pour un écran que nul ne regarde.
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    const timer = globalThis.setInterval(revalidate, REFRESH_INTERVAL_MS);

    document.addEventListener('visibilitychange', revalidate);

    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [load]);

  /**
   * Le réessai explicite de l'état d'erreur — `states.md` étape 3.
   *
   * La revalidation périodique rattrape déjà seule au bout d'une minute, mais
   * une minute devant un écran en panne est très longue, et rien n'y dit que
   * quelque chose est en train de se faire. Le bouton se désactive le temps de
   * l'aller-retour : deux clics ne lancent pas deux requêtes (web-frontend §3).
   */
  const retry = useCallback(() => {
    setRetrying(true);
    void load().finally(() => {
      setRetrying(false);
    });
  }, [load]);

  /**
   * Le praticien demandé, tel qu'on peut le nommer à l'écran.
   *
   * `null` veut dire « aucune préférence », et **rien d'autre** : un `staffId`
   * relu du brouillon peut désigner quelqu'un que la prestation ne propose plus,
   * auquel cas le catalogue ne rend aucun nom. Le repli tient à ce que cette
   * préférence-là est justement celle dont il faut pouvoir sortir — la requête
   * la porte toujours, et elle ne rendra plus jamais un créneau.
   */
  const staffLabel =
    staffId === null
      ? null
      : (service.staff.find((member) => member.id === staffId)?.displayName ??
        t('tunnel.slotStep.unknownStaff'));

  /**
   * Ce que la puce porte — l'absence de préférence est un choix, pas un vide.
   *
   * Le libellé vient de la clé de `StaffChoice` (`tunnel.staffChoice`) et non
   * d'une clé à cette étape : c'est le même mot à l'étape « Prestation », dans
   * le panneau et ici, et `ds:libelles` relève comme un défaut la même chose
   * nommée de deux façons sur un seul parcours (#846).
   */
  const staffName = staffLabel ?? t('tunnel.staffChoice.noPreference');

  /** Les bornes réservables, dont le calendrier tire les mois qu'il atteint. */
  const bounds = useMemo(() => (today === null ? null : bookingWindow(today)), [today]);

  /** Le mois suivant se laisse-t-il atteindre, ou la fenêtre s'arrête-t-elle là ? */
  const canSeeNextMonth =
    month !== null && bounds !== null && isNavigableMonth(addMonths(month, 1), bounds);

  /**
   * Ce que l'état vide annonce — « Aucun créneau », et les précisions dont on
   * dispose (#846).
   *
   * Quatre clés et non une phrase assemblée : le praticien et le mois
   * n'entrent pas au même endroit dans les deux langues, et une concaténation
   * figerait l'ordre du français. Chaque clé est écrite en toutes lettres — la
   * règle du dépôt interdit d'en composer une par concaténation.
   */
  const emptyTitle =
    staffLabel === null
      ? month === null
        ? t('tunnel.slotStep.emptyTitle')
        : t('tunnel.slotStep.emptyTitleMonth', { month: formatMonth(month, display) })
      : month === null
        ? t('tunnel.slotStep.emptyTitleStaff', { staff: staffLabel })
        : t('tunnel.slotStep.emptyTitleStaffMonth', {
            staff: staffLabel,
            month: formatMonth(month, display),
          });

  /**
   * « Voir le mois suivant » — la sortie de l'état vide, `states.md` étape 3.
   *
   * Elle remplace « Voir plus de jours » : la fenêtre ne s'élargit plus, on
   * change de page de calendrier. Le chevron du calendrier fait le même geste et
   * reste à l'écran — celui-ci est là parce qu'un état vide sans sortie est un
   * cul-de-sac, et que la commande doit se trouver là où l'on vient de lire
   * qu'il n'y a rien.
   */
  const showNextMonth = useCallback(() => {
    if (month === null) {
      return;
    }

    // Le clic peut emporter le bouton lui-même — c'est le cas quand le mois
    // atteint est le dernier de la fenêtre. Sans rattrapage, le focus
    // retomberait sur `<body>` et le clavier repartirait du haut du document
    // juste après un geste délibéré (`keyboard-navigation.md`, « Parcours
    // complet réalisable sans souris »).
    catchFocusAfterMonthChange.current = 'chargement';
    setMonth(addMonths(month, 1));
  }, [month]);

  /**
   * Le focus rattrapé quand le bouton qu'on vient d'actionner s'est effacé.
   *
   * On attend le **résultat** et pas le squelette : le changement de mois
   * repasse par un chargement, et se poser sur la bande de l'écran d'attente
   * ferait perdre le focus une seconde fois à l'arrivée des données. La cible est
   * la journée que la **bande** retient dans le nouveau mois — elle est rendue
   * dans tous les états et ne disparaît jamais, là où le calendrier n'est dans le
   * document que tant que son panneau est ouvert (#1049). Ce que le mois a donné
   * est annoncé de son côté par le `role="status"` de l'état vide.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape, au premier rendu où sa cible existe.
   */
  useEffect(() => {
    if (catchFocusAfterMonthChange.current === 'inactif') {
      return;
    }

    if (catchFocusAfterMonthChange.current === 'chargement') {
      if (days === null) {
        catchFocusAfterMonthChange.current = 'resultat';
      }

      return;
    }

    if (days === null) {
      return;
    }

    const target = calendarRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]');

    if (target !== null && target !== undefined) {
      catchFocusAfterMonthChange.current = 'inactif';
      target.focus();
    }
  });

  return (
    <section
      className="spa-booking__step spa-booking__step--calendar"
      aria-label={t('tunnel.slotStep.label')}
    >
      <h2 className="spa-card__title">{service.name}</h2>

      {/*
        « Avec : Premier disponible ▾ » — `BM-PRATICIEN-04`. Le libellé est le
        même qu'à l'étape 1, et **le même mot** : `ds:libelles` relève comme un
        défaut la même chose nommée de deux façons sur un seul parcours, et il vit
        donc à un seul endroit (`components/booking/staff-choice.tsx`).

        Le nom accessible porte la préposition et le nom retenu ; le chevron est
        `aria-hidden`, un signe typographique ne se lisant pas.
      */}
      <div className="spa-booking__staff-chip">
        {service.staff.length === 0 ? (
          // Ouvrir un panneau pour y lire qu'il n'y a personne est un geste
          // perdu : la `<select>` d'avant portait déjà ce constat en clair, et
          // l'étape le garde. C'est aussi ce qui explique la grille vide en
          // dessous.
          <p className="spa-booking__staff-empty">{t('tunnel.staffChoice.noStaffNotice')}</p>
        ) : (
          <Button
            variant="neutral"
            aria-haspopup="dialog"
            aria-label={t('tunnel.slotStep.staffChipLabel', { staff: staffName })}
            onClick={() => {
              setStaffOpen(true);
            }}
          >
            <span aria-hidden="true">{t('tunnel.slotStep.staffChip', { staff: staffName })}</span>
            <span aria-hidden="true" className="spa-booking__staff-chip-caret">
              ▾
            </span>
          </Button>
        )}
      </div>

      {/*
        Le choix lui-même, dans un panneau qui garde l'étape dessous
        (`BM-TUNNEL-12`). Il se referme dès qu'un praticien est retenu : c'est le
        geste pour lequel on l'a ouvert, et les créneaux se recalculent derrière —
        « changer de praticien recalcule les créneaux sur place ».
      */}
      <Sheet
        open={staffOpen}
        title={t('tunnel.slotStep.staffSheetTitle')}
        onClose={() => {
          setStaffOpen(false);
        }}
      >
        {/* Monté seulement panneau ouvert : fermé, ses boutons radio resteraient
            focalisables derrière un voile. */}
        {staffOpen ? (
          <StaffChoice
            staff={service.staff}
            value={staffId}
            onSelect={(member) => {
              onStaffChange(member);
              setStaffOpen(false);
            }}
          />
        ) : null}
      </Sheet>

      {error === null ? null : (
        <Notification tone="danger" title={t('tunnel.slotStep.errorTitle')}>
          {/* La phrase de l'erreur vient de l'action, qui traduit les siennes
              et laisse passer celle de l'API — voir l'en-tête, « La langue ». */}
          <p>{error}</p>
          <Button
            variant="neutral"
            loading={retrying}
            loadingLabel={t('tunnel.slotStep.retrying')}
            onClick={retry}
          >
            {t('tunnel.slotStep.retry')}
          </Button>
        </Notification>
      )}

      {/*
        Le chargement a échoué et rien n'avait été affiché : la notification
        ci-dessus le dit déjà, et annoncer sous elle « aucun créneau » ferait
        passer une panne pour un agenda complet — en conseillant de changer de
        prestation, ce qui n'y changerait rien.

        La condition porte sur les journées reçues, pas sur celles qui ont des
        créneaux : le serveur rend toujours une entrée par jour demandé, même
        vide, si bien qu'une liste de journées vide ne peut venir que d'un
        premier chargement en échec. S'appuyer sur les journées *ouvertes*
        ferait disparaître un état vide déjà affiché — et avec lui le bouton
        qui lève la préférence de praticien — à la première revalidation ratée.
      */}
      {days !== null && error !== null && days.length === 0 ? null : (
        <SlotPicker
          days={days}
          month={month}
          bounds={bounds}
          // Ce que le salon **annonce** — le calendrier s'en sert pour écrire
          // « fermé » plutôt que « complet » sur un jour où il n'ouvre pas
          // (#742), jamais pour décider d'un créneau.
          openingHours={tenant.openingHours}
          onMonthChange={setMonth}
          timeZone={tenant.timezone}
          // La région de mise en forme des dates et des heures — le fuseau,
          // lui, reste celui du salon quelle que soit la langue (#846).
          countryCode={countryCode}
          // Le conteneur où rattraper le focus : la **bande de jours** depuis
          // #1049 — c'est elle qui reste à l'écran quand le mois change, le
          // calendrier n'étant dans le document que tant que son panneau est
          // ouvert.
          calendarRef={calendarRef}
          // Rendue conditionnelle, et non passée à `null` : `SlotPicker`
          // distingue « aucun créneau retenu » — le cas de la première visite,
          // où le clic avance aussitôt et où aucun bouton ne porte
          // `aria-pressed` — de « celui-ci l'est ». Annoncer « non pressé » sur
          // trente créneaux ferait chercher un état qui n'existe pas.
          //
          // Elle ne suffit pas à rouvrir l'étape sur la **journée** du créneau
          // retenu : le sélecteur tient sa journée dans son propre état, replié
          // sur la première journée ouverte de la plage tant qu'aucune n'est
          // désignée. Le mois est juste, la grille peut donc encore montrer un
          // autre jour — écart traité hors de l'empreinte de ce ticket, voir
          // #947.
          {...(startsAt === null ? {} : { selectedSlot: startsAt })}
          onChoose={onChoose}
          emptyState={
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">{emptyTitle}</p>
              <p className="spa-empty-state__description">
                {staffLabel === null
                  ? t('tunnel.slotStep.emptyDescription')
                  : t('tunnel.slotStep.emptyDescriptionStaff')}
              </p>
              {/*
                La sortie de l'état vide — `states.md` étape 3. Elle a remplacé
                « Voir plus de jours » : la fenêtre ne s'élargit plus, on tourne
                la page du calendrier. Au dernier mois de la fenêtre de
                réservation, le bouton disparaît : il n'aurait plus rien à
                ouvrir.
              */}
              {canSeeNextMonth ? (
                <Button variant="neutral" onClick={showNextMonth}>
                  {t('tunnel.slotStep.nextMonth')}
                </Button>
              ) : null}
              {staffLabel === null ? null : (
                <Button
                  variant="neutral"
                  onClick={() => {
                    onStaffChange(null);
                  }}
                >
                  {t('tunnel.slotStep.allStaff')}
                </Button>
              )}
            </div>
          }
        />
      )}

      {/* Seul, mais groupé quand même : la colonne flex de `.spa-booking__step`
          étirerait un `.spa-button` sur toute la largeur de la colonne.

          Il double « ← Retour » de l'en-tête, et c'est voulu : celui-ci nomme
          ce qu'on va changer, là où l'en-tête ne dit que « revenir ». Le motif
          est celui du benchmark — un retour générique en tête d'écran, une
          correction nommée à l'endroit qu'elle corrige. */}
      <div className="spa-booking__actions">
        <Button variant="quiet" onClick={onBack}>
          {t('tunnel.actions.changeService')}
        </Button>
      </div>

      {/* Aucune action primaire à cette étape : choisir un créneau avance de
          lui-même. La barre ne porte donc que le rappel — prestation, durée,
          prix —, sur une ligne, dépliable d'un doigt (BM-TUNNEL-07). */}
      <BookingActionBar summary={summary} />
    </section>
  );
}
