'use client';

import {
  ERROR_CODES,
  type AvailabilityResponse,
  type OpeningHoursEntry,
  type TimeZone,
  type UtcInstant,
} from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { SlotPicker } from '@/components/booking/slot-picker';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  addMonths,
  formatMonth,
  isNavigableMonth,
  type BookingWindow,
  type CalendarMonth,
} from '@/lib/booking/month-grid';
import { formatDateTimeInTimeZone, timeZoneMention } from '@/lib/format';

import { rescheduleOwnAppointmentAction } from '../actions';
import { accountPath } from '../paths';
import { useAccountAnnouncement } from './account-announcement';
import { useAccountSessionRenewal } from './use-account-session-renewal';

/**
 * Choix d'un nouveau créneau pour un rendez-vous existant (#47, troisième
 * critère).
 *
 * ## Ce que cet écran ne refait pas
 *
 * Le tunnel de réservation. Reporter ne change ni la prestation, ni le
 * praticien, ni le prix — l'API le refuse explicitement
 * (`rescheduleAppointmentRequestSchema` ne porte que l'instant et, au plus, un
 * praticien). Il n'y a donc qu'un choix à faire, et l'écran ne montre que
 * celui-là : les créneaux que le calendrier propose pour **cette** prestation
 * chez **ce** praticien.
 *
 * ## Le sélecteur de créneau est celui du tunnel (#622)
 *
 * Il l'était par l'intention et pas par le code : cet écran dépliait les quinze
 * journées d'un coup, toutes leurs heures visibles, sans bande de journées ni
 * regroupement Matin / Après-midi / Soir. Mesuré à 360 px, cela faisait 4 960 px
 * de haut — six hauteurs d'écran — et le bouton de validation restait deux mille
 * pixels sous le créneau qu'on venait de choisir : rien à l'écran ne disait
 * comment poursuivre.
 *
 * C'est maintenant [`SlotPicker`](../../../../../components/booking/slot-picker.tsx),
 * le composant de l'étape 3 du tunnel, qui rend le choix : un calendrier
 * mensuel, puis la grille d'**une seule** journée. Le même geste se fait donc au
 * même endroit, au clavier comme à la souris, et une correction apportée à l'un
 * des deux écrans profite à l'autre. Le calendrier de #827 est arrivé par là :
 * il a été écrit une fois, et les deux écrans l'ont eu ensemble.
 *
 * ## Le mois regardé passe par l'adresse (#827)
 *
 * Cette page est rendue par le serveur, et c'est lui qui lit le calendrier :
 * changer de mois est donc une navigation, là où le tunnel change un état. C'est
 * ce que `monthHref` porte — et c'est aussi ce qui fait survivre le mois au
 * rafraîchissement, comme la fenêtre élargie qu'il remplace (#738).
 *
 * ## Le créneau actuel se montre, il ne se choisit pas (#442)
 *
 * Depuis que le calendrier écarte de son calcul le rendez-vous en cours de
 * déplacement, la liste contient les créneaux qui le **chevauchent** — c'est
 * l'objet du ticket : un soin d'une heure doit pouvoir bouger d'un quart
 * d'heure. Elle contient donc aussi, nécessairement, l'heure actuelle du
 * rendez-vous.
 *
 * Ce créneau-là est rendu, mais inerte, et porte le mot « actuel ». Le retirer
 * ferait un trou inexplicable dans la journée ; le laisser cliquable ferait
 * proposer « déplacer au samedi 14:00 » un rendez-vous déjà fixé au samedi
 * 14:00 — un aller-retour en base pour rien, et une phrase qui se contredit.
 *
 * ## Le 409 n'est pas une erreur exceptionnelle
 *
 * Entre l'affichage et le clic, le créneau a pu être pris. C'est un cas normal
 * sous concurrence (web-frontend §3) : l'écran le dit, recharge les créneaux, et
 * ne perd rien de ce que la visiteuse avait déjà choisi — le rendez-vous
 * d'origine est intact, le report ayant échoué en bloc.
 *
 * ## Le report abouti s'annonce sur la liste (#746)
 *
 * L'écran disait tout de l'échec et rien du succès : le bouton de validation
 * ramenait à la liste sans un mot, la carte ayant simplement changé d'heure
 * quelque part plus bas. Le succès part maintenant vers la région `aria-live` du
 * layout (`account-announcement.tsx`), qui survit à cette navigation et n'affiche
 * l'annonce qu'à l'arrivée.
 *
 * ## Le geste porte le mot du CDC, du lien jusqu'au bouton (#749)
 *
 * Une même action s'écrivait de deux façons : le lien de la carte dit
 * « Reporter », le titre de cet écran « Reporter mon rendez-vous », et son bouton
 * disait « Déplacer au … ». Le CDC nomme l'action **report** — §1.4
 * (« réservation/report/annulation ») et §2.4 (« création, report, annulation,
 * no-show ») —, et c'est donc le bouton qui s'aligne : « Reporter au … ».
 *
 * Le bouton nomme toujours l'**effet** et non le geste tant que rien n'est
 * retenu — « Choisissez un créneau » dit ce qui manque, comme
 * `docs/design/appointments/wireframes.md` le demande d'un CTA désactivé.
 *
 * Reste l'**état** d'un rendez-vous reporté, la pastille « Déplacé » : elle est
 * tenue par `lib/appointment-status.ts` (`RESCHEDULED_LABEL`), que le
 * back-office lit aussi depuis #917. Elle sort de l'empreinte de ce ticket et
 * n'a pas été touchée.
 */
interface RescheduleFormProps {
  readonly tenantSlug: string;
  readonly appointmentId: string;
  /** L'instant actuel du rendez-vous, pour que la visiteuse sache ce qu'elle déplace. */
  readonly currentStartsAt: string;
  readonly serviceName: string | null;
  readonly availability: AvailabilityResponse;
  readonly timeZone: TimeZone;
  /** Le mois que le calendrier affiche — celui que l'adresse demandait. */
  readonly month: CalendarMonth;
  /** Les bornes réservables, calculées par le serveur dans le fuseau du salon. */
  readonly bounds: BookingWindow;
  /**
   * Les plages d'ouverture publiées par l'établissement.
   *
   * Le report montre le même calendrier que le tunnel, et il doit donc y lire le
   * même mot : « fermé » là où le salon n'ouvre pas, « complet » là où il ouvre
   * sans créneau libre (#742). L'écart relevé par l'audit se retrouvait à
   * l'identique sur les deux écrans, puisqu'ils montent le même sélecteur.
   */
  readonly openingHours?: readonly OpeningHoursEntry[] | undefined;
  /**
   * Le gabarit d'adresse d'un changement de mois : le mois s'y ajoute.
   *
   * Une adresse et non un geste, parce que c'est le rendu serveur de la page qui
   * lit le calendrier. Un gabarit et non une adresse toute faite, parce que le
   * calendrier peut mener vers n'importe lequel des mois de la fenêtre, et que
   * le formulaire n'a pas à connaître la route qui le rend.
   */
  readonly monthHref: string;
}

export function RescheduleForm({
  tenantSlug,
  appointmentId,
  currentStartsAt,
  serviceName,
  availability,
  timeZone,
  month,
  bounds,
  openingHours,
  monthHref,
}: RescheduleFormProps) {
  const router = useRouter();
  const announce = useAccountAnnouncement();
  const { renewIfExpired } = useAccountSessionRenewal(tenantSlug);
  const [chosen, setChosen] = useState<UtcInstant | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);
  /**
   * Le changement de mois est en vol.
   *
   * Il repasse par le serveur, et rien ne le dirait sans cela : le calendrier
   * resterait sur son mois le temps de l'aller-retour, comme si le chevron
   * n'avait pas fonctionné. Pendant ce temps les créneaux affichés sont ceux de
   * l'ancien mois — `busy` les rend inertes plutôt que de laisser en retenir un
   * qui disparaîtra du rendu suivant.
   */
  const [changingMonth, startMonthChange] = useTransition();
  /** Le conteneur du calendrier, pour y rattraper le focus après un changement de mois. */
  const calendarRef = useRef<HTMLDivElement | null>(null);
  /**
   * Un changement de mois demandé depuis l'état vide est en cours, et son focus
   * reste à rattraper.
   *
   * « Voir le mois suivant » peut emporter le bouton qu'on vient d'actionner —
   * au dernier mois de la fenêtre, il n'a plus rien à ouvrir —, et sans
   * rattrapage le focus retombe sur `<body>` : le clavier repartirait du haut du
   * document juste après un geste délibéré, ce que `keyboard-navigation.md`
   * refuse ailleurs. La cible est le calendrier, qui reste à l'écran.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un
   * état déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const catchFocusAfterMonthChange = useRef(false);

  /**
   * La mention du fuseau, calculée **après le montage** seulement (#654).
   *
   * `timeZoneMention` lit le fuseau du **navigateur**
   * (`Intl.DateTimeFormat().resolvedOptions().timeZone`), qui n'existe pas au
   * rendu serveur : `Intl` y rend celui du conteneur, c'est-à-dire UTC. Cet
   * écran étant rendu par le serveur avec ses journées déjà chargées, la phrase
   * « actuellement le … (heure de Europe/Paris) » partait donc du serveur pour
   * une visiteuse parisienne, qui ne doit précisément rien lire — React signale
   * la divergence et réécrit le nœud à l'hydratation.
   *
   * Le drapeau est le même que celui de
   * [`SlotPicker`](../../../../../components/booking/slot-picker.tsx) et de
   * `booking-tunnel.tsx` : au premier rendu — serveur comme client — la mention
   * est absente des deux côtés, donc les balises s'accordent ; l'effet ne joue
   * qu'ensuite, sur le client seul, et c'est là que la phrase se complète.
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const mention = mounted ? timeZoneMention(timeZone) : null;

  /**
   * Le focus rattrapé quand « Voir le mois suivant » s'est effacé.
   *
   * On attend la fin de la transition : tant qu'elle court, la page affichée est
   * encore l'ancienne, et se poser sur son calendrier ferait perdre le focus une
   * seconde fois à l'arrivée des journées.
   *
   * La cible est la journée que le calendrier retient dans le nouveau mois —
   * lui, contrairement à la bande d'avant, ne disparaît jamais. Ce que le mois a
   * donné est annoncé de son côté par le `role="status"` de l'état vide.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape, au premier rendu où sa cible existe.
   */
  useEffect(() => {
    if (!catchFocusAfterMonthChange.current || changingMonth) {
      return;
    }

    const target = calendarRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]');

    if (target !== null && target !== undefined) {
      catchFocusAfterMonthChange.current = false;
      target.focus();
    }
  });

  /**
   * Changer de mois — le geste des chevrons du calendrier et celui de la sortie
   * de l'état vide.
   *
   * Une navigation, parce que c'est le rendu serveur de la page qui lit le
   * calendrier. `replace` et non `push` : le mois qu'on vient de quitter n'est
   * pas une étape du parcours, et « Précédent » doit ramener à la liste des
   * rendez-vous, pas à la page d'avant du même écran.
   */
  const goToMonth = useCallback(
    (target: CalendarMonth) => {
      startMonthChange(() => {
        router.replace(`${monthHref}${target}`);
      });
    },
    [monthHref, router],
  );

  /** La sortie de l'état vide, qui peut emporter le bouton qui la porte. */
  const showNextMonth = useCallback(() => {
    catchFocusAfterMonthChange.current = true;
    goToMonth(addMonths(month, 1));
  }, [goToMonth, month]);

  /** Le mois suivant se laisse-t-il atteindre, ou la fenêtre s'arrête-t-elle là ? */
  const canSeeNextMonth = isNavigableMonth(addMonths(month, 1), bounds);

  // Comparaison d'instants et non de chaînes : rien ne garantit que le
  // calendrier et l'historique écrivent le même moment avec la même précision,
  // et « …T14:00:00Z » ne s'égale pas à « …T14:00:00.000Z ».
  const currentInstant = Date.parse(currentStartsAt);
  const currentSlotNote = useCallback(
    (startsAt: UtcInstant): string | null =>
      Date.parse(startsAt) === currentInstant ? 'actuel' : null,
    [currentInstant],
  );

  const confirm = async (): Promise<void> => {
    // Deux verrous : celui-ci et le `disabled` du bouton. Un double clic ne doit
    // jamais produire deux reports — le second déplacerait un rendez-vous que le
    // premier vient déjà de remplacer.
    if (submitting || chosen === null) {
      return;
    }

    setSubmitting(true);
    setFailure(null);

    const result = await rescheduleOwnAppointmentAction(tenantSlug, appointmentId, {
      startsAt: chosen,
    });

    if (!result.ok) {
      if (renewIfExpired(result)) {
        // Le rendez-vous n'a pas bougé : le choix reste en place, et le bouton
        // doit être de nouveau utilisable au retour sur la page.
        setSubmitting(false);
        return;
      }

      if (result.code === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE) {
        setFailure({
          title: 'Ce créneau vient d’être pris',
          message:
            'Votre rendez-vous n’a pas bougé. Choisissez un autre créneau dans la liste remise à jour.',
        });
        setChosen(null);
        setSubmitting(false);
        // Recharger la page serveur : c'est elle qui lit les créneaux.
        router.refresh();
        return;
      }

      setFailure({ title: 'Le report n’a pas abouti', message: result.message });
      setSubmitting(false);
      return;
    }

    // L'annonce part d'ici, mais ne se lira que là-bas : elle porte le chemin de
    // la liste, et la région du layout la garde en attente le temps de la
    // navigation (#746). Un bandeau de succès posé une demi-seconde au-dessus de
    // « Reporter mon rendez-vous » se lirait comme un second déplacement.
    announce({
      kind: 'appointment-rescheduled',
      when: formatDateTimeInTimeZone(chosen, timeZone),
      path: accountPath(tenantSlug),
    });
    router.replace(accountPath(tenantSlug));
    router.refresh();
  };

  return (
    <section className="spa-account__panel" aria-labelledby="report-titre">
      <h2 className="spa-account__section-title" id="report-titre">
        Reporter mon rendez-vous
      </h2>

      <p className="spa-account__lead">
        {serviceName ?? 'Votre prestation'} — actuellement le{' '}
        <strong>{formatDateTimeInTimeZone(currentStartsAt, timeZone)}</strong>
        {mention === null ? null : <span className="spa-appointment__timezone"> ({mention})</span>}.
      </p>

      {failure === null ? null : (
        <Notification tone="warning" title={failure.title}>
          <p>{failure.message}</p>
        </Notification>
      )}

      <SlotPicker
        days={availability.days}
        month={month}
        bounds={bounds}
        openingHours={openingHours}
        onMonthChange={goToMonth}
        timeZone={timeZone}
        headingId="report-creneaux-titre"
        selectedSlot={chosen}
        lockedSlotNote={currentSlotNote}
        busy={submitting || changingMonth}
        calendarRef={calendarRef}
        onChoose={setChosen}
        emptyState={
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{`Aucun créneau en ${formatMonth(month)}`}</p>
            <p className="spa-empty-state__description">
              Le calendrier ne propose rien pour cette prestation ce mois-ci. Essayez un autre
              mois, ou contactez le salon pour convenir d’une autre date.
            </p>
            {/*
              La sortie est **aussi** ici, et pas seulement sur les chevrons du
              calendrier : `states.md` étape 3 — *« Vide (aucune dispo sur toute
              la plage) : proposer d'élargir la plage »* — demande que la
              commande se trouve là où l'on vient de lire qu'il n'y a rien.
            */}
            {canSeeNextMonth ? (
              <Button variant="neutral" onClick={showNextMonth}>
                Voir le mois suivant
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="spa-account__actions">
        <Button
          variant="accent"
          disabled={chosen === null}
          loading={submitting}
          loadingLabel="Report en cours…"
          onClick={() => void confirm()}
        >
          {chosen === null
            ? 'Choisissez un créneau'
            : `Reporter au ${formatDateTimeInTimeZone(chosen, timeZone)}`}
        </Button>
        <Link className="spa-account__nav-link" href={accountPath(tenantSlug)}>
          Renoncer au report
        </Link>
      </div>
    </section>
  );
}
