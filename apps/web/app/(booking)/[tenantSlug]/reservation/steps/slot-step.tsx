'use client';

import {
  MAX_AVAILABILITY_RANGE_DAYS,
  type CalendarDate,
  type DayAvailability,
  type PublicService,
  type PublicTenant,
  type UtcInstant,
} from '@spa/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { SlotPicker } from '@/components/booking/slot-picker';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { addCalendarDays, calendarDateInTimeZone, calendarWindow } from '@/lib/booking/calendar';

import { loadAvailabilityAction } from '../actions';

/** Fenêtre proposée d'emblée. Le contrat plafonne la plage à 31 jours. */
const WINDOW_DAYS = 14;

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

/** Valeur du choix « premier disponible » — l'absence de préférence, pas un praticien. */
const FIRST_AVAILABLE = '';

interface SlotStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  readonly onBack: () => void;
  /** Remonte le praticien retenu au brouillon : il survit au rafraîchissement et sert à la réservation. */
  readonly onStaffChange: (staffId: string | null) => void;
  readonly onChoose: (startsAt: UtcInstant) => void;
}

/**
 * Choix du praticien et du créneau (#44, #351).
 *
 * ## La bande de journées et la grille sont un composant partagé (#622)
 *
 * Elles vivent dans [`SlotPicker`](../../../../../components/booking/slot-picker.tsx),
 * que l'écran de report de l'espace client emploie aussi. Ce qui reste **ici**
 * est ce qui n'appartient qu'au tunnel : le choix du praticien, le chargement et
 * sa revalidation, l'élargissement de la fenêtre, et ce que l'écran dit quand
 * l'agenda est vide. Le sélecteur, lui, ne fait que montrer ce qu'on lui donne.
 *
 * ## Le praticien se change **ici**, pas un écran plus haut
 *
 * Il se choisit déjà à l'étape prestation, mais c'est devant le calendrier qu'on
 * découvre qu'on s'y est mal pris : la personne demandée n'a rien de libre cette
 * semaine, ou au contraire il n'y avait aucune raison de la demander. Renvoyer à
 * l'étape précédente pour cela ferait perdre la journée qu'on regardait. Le
 * sélecteur est donc rendu dans les deux écrans, sur le même état du brouillon.
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
 * trois : squelette de grille **sous une barre de dates restée opérable** — que
 * `SlotPicker` rend —, état vide qui offre d'élargir la fenêtre au-delà des
 * quatorze jours, état d'erreur qui offre de réessayer.
 */
export function SlotStep({
  tenant,
  service,
  staffId,
  onBack,
  onStaffChange,
  onChoose,
}: SlotStepProps) {
  const [days, setDays] = useState<readonly DayAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  /**
   * Largeur de la fenêtre demandée, en journées.
   *
   * Elle part à quatorze et ne s'élargit que sur demande explicite — « Voir plus
   * de jours », `states.md` étape 3. Trente et un jours d'agenda coûtent au
   * serveur, et la très grande majorité des clientes réservent dans la semaine.
   */
  const [windowDays, setWindowDays] = useState(WINDOW_DAYS);
  /**
   * Les dates civiles de la fenêtre en cours, posées au **lancement** de la
   * requête et non à son retour.
   *
   * C'est ce qui permet à la barre de dates d'être déjà là pendant que la grille
   * est en squelette. Elle est tenue en état plutôt que calculée au rendu parce
   * qu'elle dérive de `new Date()` : la calculer dans le corps du composant la
   * ferait diverger entre le rendu serveur et l'hydratation, une nuit sur
   * trois cent soixante-cinq, à minuit passé dans le fuseau du salon.
   */
  const [windowDates, setWindowDates] = useState<readonly CalendarDate[]>([]);
  const dateBarRef = useRef<HTMLDivElement | null>(null);
  /**
   * Le conteneur de l'état vide, pour pouvoir y poser le focus.
   *
   * Il n'est pas naturellement focalisable : c'est un `tabIndex={-1}` que
   * `SlotPicker` pose, qui le rend atteignable par programme sans l'ajouter à
   * l'ordre de tabulation.
   */
  const emptyStateRef = useRef<HTMLDivElement | null>(null);
  /**
   * Où en est le rattrapage du focus après un élargissement de fenêtre.
   *
   * Trois états et non un booléen, parce qu'il faut laisser passer **deux**
   * rendus : celui du clic, où les journées de l'ancienne fenêtre sont encore
   * là, puis celui du chargement. S'arrêter au premier ferait poser le focus sur
   * l'écran que l'élargissement est précisément en train de remplacer.
   *
   * Un `ref` et non un état : il ne décide de rien à l'écran, et en faire un
   * état déclencherait un rendu de plus pour une valeur consommée aussitôt.
   */
  const catchFocusAfterWidening = useRef<'inactif' | 'chargement' | 'resultat'>('inactif');
  /**
   * Numéro de la requête la plus récente.
   *
   * Deux chargements peuvent être en vol en même temps — un changement de
   * praticien pendant qu'une revalidation périodique traîne. Sans ce jeton, la
   * réponse la plus lente écraserait la plus fraîche, et l'écran afficherait
   * l'agenda du praticien qu'on vient de quitter.
   */
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const from = calendarDateInTimeZone(new Date(), tenant.timezone);
    const query = {
      serviceId: service.id,
      from,
      to: addCalendarDays(from, windowDays - 1),
      ...(staffId === null ? {} : { staffId }),
    };

    // Posée **avant** l'attente : c'est ce qui met la barre de dates à l'écran
    // en même temps que le squelette, et non une fois la réponse arrivée.
    setWindowDates(calendarWindow(from, windowDays));

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
  }, [service.id, staffId, tenant.slug, tenant.timezone, windowDays]);

  useEffect(() => {
    // `load` ne change d'identité que lorsque la question posée change —
    // prestation, praticien, établissement, largeur de fenêtre. Les créneaux
    // affichés ne répondent alors plus à la question, et les garder à l'écran le
    // temps de l'aller-retour proposerait l'agenda du praticien précédent. On
    // repasse par le chargement.
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
      : (service.staff.find((member) => member.id === staffId)?.displayName ?? 'ce praticien');

  /**
   * Le focus rattrapé quand le bouton qu'on vient d'actionner s'est effacé.
   *
   * « Voir plus de jours » emporte l'état vide qui le portait : sans cela le
   * focus retombe sur `<body>`, et le clavier repart du haut du document juste
   * après un geste délibéré — exactement ce que `keyboard-navigation.md` refuse
   * ailleurs, quand une revalidation emporte le créneau focalisé.
   *
   * On attend le **résultat** et pas le squelette : l'élargissement repasse par
   * un chargement, et se poser sur la barre de dates de l'écran d'attente ferait
   * perdre le focus une seconde fois à l'arrivée des données. Selon ce que le
   * serveur rend, la cible est la journée retenue de la barre, ou l'état vide
   * lui-même — qui dit alors, en `role="status"`, ce que l'élargissement a donné.
   *
   * Sans tableau de dépendances : ce n'est pas une valeur qu'on observe mais un
   * geste qu'on rattrape, au premier rendu où sa cible existe.
   */
  useEffect(() => {
    if (catchFocusAfterWidening.current === 'inactif') {
      return;
    }

    if (catchFocusAfterWidening.current === 'chargement') {
      if (days === null) {
        catchFocusAfterWidening.current = 'resultat';
      }

      return;
    }

    if (days === null) {
      return;
    }

    const target =
      dateBarRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]') ??
      emptyStateRef.current;

    if (target !== null && target !== undefined) {
      catchFocusAfterWidening.current = 'inactif';
      target.focus();
    }
  });

  return (
    <section aria-label="Choix du praticien et du créneau">
      <h2 className="spa-card__title">{service.name}</h2>

      <Select
        id="creneau-praticien"
        label="Praticien"
        value={staffId ?? FIRST_AVAILABLE}
        hint="Sans préférence, le salon vous attribue le premier praticien disponible."
        emptyLabel={
          service.staff.length === 0
            ? 'Aucun praticien ne propose cette prestation actuellement.'
            : undefined
        }
        onChange={(event) => {
          onStaffChange(event.target.value === FIRST_AVAILABLE ? null : event.target.value);
        }}
      >
        <option value={FIRST_AVAILABLE}>Premier disponible</option>
        {service.staff.map((member) => (
          <option key={member.id} value={member.id}>
            {member.displayName}
          </option>
        ))}
      </Select>

      {error === null ? null : (
        <Notification tone="danger" title="Les disponibilités n’ont pas pu être chargées">
          <p>{error}</p>
          <Button
            variant="neutral"
            loading={retrying}
            loadingLabel="Nouvelle tentative en cours…"
            onClick={retry}
          >
            Réessayer
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
          windowDates={windowDates}
          timeZone={tenant.timezone}
          dateBarRef={dateBarRef}
          emptyStateRef={emptyStateRef}
          onChoose={onChoose}
          emptyState={
            <div className="spa-empty-state">
              <p className="spa-empty-state__title">
                {staffLabel === null
                  ? `Aucun créneau sur les ${String(windowDays)} prochains jours`
                  : `Aucun créneau avec ${staffLabel} sur les ${String(windowDays)} prochains jours`}
              </p>
              <p className="spa-empty-state__description">
                {staffLabel === null
                  ? 'Essayez une autre prestation, ou contactez le salon directement.'
                  : 'Un autre praticien a peut-être de la place, sinon contactez le salon directement.'}
              </p>
              {/*
                « Voir plus de jours » — `states.md` étape 3. Le contrat autorise
                trente et un jours ; on n'en demande quatorze d'emblée que parce
                que la très grande majorité des clientes réservent dans la semaine.
                Une fois la fenêtre élargie, le bouton disparaît : il n'aurait plus
                rien à élargir.
              */}
              {windowDays < MAX_AVAILABILITY_RANGE_DAYS ? (
                <Button
                  variant="neutral"
                  onClick={() => {
                    // Le clic emporte le bouton lui-même : la fenêtre élargie
                    // repasse par le chargement, l'état vide disparaît, et le
                    // focus retomberait sur `<body>` — le clavier repartirait du
                    // haut du document juste après un geste délibéré. On le
                    // rattrape sur la barre de dates, qui prend justement la
                    // place de cet écran (`keyboard-navigation.md`, « Parcours
                    // complet réalisable sans souris »).
                    catchFocusAfterWidening.current = 'chargement';
                    setWindowDays(MAX_AVAILABILITY_RANGE_DAYS);
                  }}
                >
                  Voir plus de jours
                </Button>
              ) : null}
              {staffLabel === null ? null : (
                <Button
                  variant="neutral"
                  onClick={() => {
                    onStaffChange(null);
                  }}
                >
                  Voir tous les praticiens
                </Button>
              )}
            </div>
          }
        />
      )}

      <Button variant="quiet" onClick={onBack}>
        Changer de prestation
      </Button>
    </section>
  );
}
