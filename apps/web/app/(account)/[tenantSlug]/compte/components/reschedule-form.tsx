'use client';

import { ERROR_CODES, type AvailabilityResponse, type TimeZone, type UtcInstant } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { SlotPicker } from '@/components/booking/slot-picker';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { formatDateTimeInTimeZone, timeZoneMention } from '@/lib/format';

import { rescheduleOwnAppointmentAction } from '../actions';
import { accountPath } from '../paths';

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
 * le composant de l'étape 3 du tunnel, qui rend le choix : une bande de journées
 * compacte, puis la grille d'**une seule** journée. Le même geste se fait donc au
 * même endroit, au clavier comme à la souris, et une correction apportée à l'un
 * des deux écrans profite à l'autre.
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
 */
interface RescheduleFormProps {
  readonly tenantSlug: string;
  readonly appointmentId: string;
  /** L'instant actuel du rendez-vous, pour que la visiteuse sache ce qu'elle déplace. */
  readonly currentStartsAt: string;
  readonly serviceName: string | null;
  readonly availability: AvailabilityResponse;
  readonly timeZone: TimeZone;
  /**
   * L'adresse de la même page en fenêtre élargie — ce que « Voir plus de jours »
   * ouvre (#738). `null` : la fenêtre est déjà au maximum du contrat, le bouton
   * n'aurait plus rien à élargir et n'est pas rendu.
   *
   * Une adresse et non un geste : c'est le rendu serveur de la page qui lit le
   * calendrier, et lui seul sait jusqu'où le contrat le laisse aller.
   */
  readonly widerHref: string | null;
}

export function RescheduleForm({
  tenantSlug,
  appointmentId,
  currentStartsAt,
  serviceName,
  availability,
  timeZone,
  widerHref,
}: RescheduleFormProps) {
  const router = useRouter();
  const [chosen, setChosen] = useState<UtcInstant | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);
  /**
   * L'élargissement de la fenêtre est en vol.
   *
   * Il repasse par le serveur, et rien ne le dirait sans cela : la bande resterait
   * à quinze jours le temps de l'aller-retour, comme si le bouton n'avait pas
   * fonctionné. Pendant ce temps les créneaux affichés sont ceux de l'ancienne
   * fenêtre — `busy` les rend inertes plutôt que de laisser en retenir un qui
   * disparaîtra du rendu suivant.
   */
  const [widening, startWidening] = useTransition();
  /** Le conteneur de la bande, pour y rattraper le focus après un élargissement. */
  const dateBarRef = useRef<HTMLDivElement | null>(null);
  /**
   * Le conteneur de l'état vide, cible de repli du même rattrapage.
   *
   * Quand la fenêtre élargie ne rend toujours aucune journée ouverte, il n'y a
   * pas de bande où se poser : `SlotPicker` rend l'état vide **à la place** du
   * sélecteur. Sans ce repli, le focus resterait sur `<body>` — précisément ce
   * que le rattrapage existe pour éviter. `slot-step.tsx` tient le même repli.
   */
  const emptyStateRef = useRef<HTMLDivElement | null>(null);
  /**
   * Un élargissement est en cours, et son focus reste à rattraper.
   *
   * « Voir plus de jours » emporte le bouton qu'on vient d'actionner : la
   * fenêtre élargie n'a plus rien à élargir, et sans rattrapage le focus
   * retombe sur `<body>` — le clavier repartirait du haut du document juste
   * après un geste délibéré, ce que `keyboard-navigation.md` refuse ailleurs.
   * La cible est la bande elle-même, qui prend la place du bouton.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un
   * état déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const catchFocusAfterWidening = useRef(false);

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
   * Le focus rattrapé quand « Voir plus de jours » s'est effacé.
   *
   * On attend la fin de la transition : tant qu'elle court, la page affichée est
   * encore l'ancienne, et se poser sur sa bande ferait perdre le focus une
   * seconde fois à l'arrivée des journées.
   *
   * Selon ce que le serveur rend, la cible est la journée retenue de la bande,
   * ou l'état vide lui-même — qui dit alors, en `role="status"`, ce que
   * l'élargissement a donné. S'en tenir à la bande laisserait le focus sur
   * `<body>` le jour où la fenêtre élargie ne rend rien de plus.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape, au premier rendu où sa cible existe.
   */
  useEffect(() => {
    if (!catchFocusAfterWidening.current || widening) {
      return;
    }

    const target =
      dateBarRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]') ??
      emptyStateRef.current;

    if (target !== null && target !== undefined) {
      catchFocusAfterWidening.current = false;
      target.focus();
    }
  });

  /**
   * « Voir plus de jours » — `states.md` étape 3.
   *
   * Un seul geste pour deux boutons : celui que `SlotPicker` pose en bout de
   * bande et celui que porte l'état vide. Les deux ne sont jamais à l'écran en
   * même temps — le sélecteur rend la bande **ou** l'état vide —, mais ils
   * doivent faire exactement la même chose, rattrapage de focus compris.
   *
   * `null` quand la fenêtre est déjà au maximum du contrat : ni l'un ni l'autre
   * n'est alors rendu, ils n'auraient plus rien à élargir.
   */
  const widen = useCallback(() => {
    if (widerHref === null) {
      return;
    }

    catchFocusAfterWidening.current = true;
    startWidening(() => {
      // `replace` et non `push` : la fenêtre étroite qu'on vient de quitter
      // n'est pas une étape du parcours, et « Précédent » doit ramener à la
      // liste des rendez-vous, pas à une bande plus courte de la même page.
      router.replace(widerHref);
    });
  }, [router, widerHref]);

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
        timeZone={timeZone}
        headingId="report-creneaux-titre"
        selectedSlot={chosen}
        lockedSlotNote={currentSlotNote}
        busy={submitting || widening}
        dateBarRef={dateBarRef}
        emptyStateRef={emptyStateRef}
        onWiden={widerHref === null ? undefined : widen}
        onChoose={setChosen}
        emptyState={
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun créneau disponible</p>
            <p className="spa-empty-state__description">
              Le calendrier ne propose rien pour cette prestation dans les prochaines semaines.
              Contactez le salon pour convenir d’une autre date.
            </p>
            {/*
              La sortie de bande est **aussi** ici : quand aucune journée n'est
              ouverte, `SlotPicker` rend cet écran **à la place** du sélecteur,
              et le bouton qu'il pose en bout de bande n'est donc pas rendu. Sans
              ce second exemplaire, le seul écran qui a vraiment besoin
              d'élargir la fenêtre serait le seul à ne pas le proposer —
              `states.md` étape 3 : *« Vide (aucune dispo sur toute la plage) :
              proposer d'élargir la plage »*.
            */}
            {widerHref === null ? null : (
              <Button variant="neutral" onClick={widen}>
                Voir plus de jours
              </Button>
            )}
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
            : `Déplacer au ${formatDateTimeInTimeZone(chosen, timeZone)}`}
        </Button>
        <Link className="spa-account__nav-link" href={accountPath(tenantSlug)}>
          Renoncer au report
        </Link>
      </div>
    </section>
  );
}
