'use client';

import type { DayAvailability, PublicService, PublicTenant, UtcInstant } from '@spa/shared';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import { formatCalendarDate, formatTimeInTimeZone } from '@/lib/format';

import { loadAvailabilityAction } from '../actions';

/** Fenêtre proposée d'emblée. Le contrat plafonne la plage à 31 jours. */
const WINDOW_DAYS = 14;

interface SlotStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  readonly onBack: () => void;
  readonly onChoose: (startsAt: UtcInstant) => void;
}

/**
 * Choix du créneau.
 *
 * Les journées et leurs créneaux viennent du serveur déjà découpés : regrouper
 * des instants UTC en journées demande le fuseau de l'établissement, et c'est
 * exactement le calcul qu'on ne veut pas voir réimplémenté dans un navigateur.
 *
 * Les disponibilités sont **rechargées au retour sur l'onglet** (skill
 * web-frontend §3) : entre le moment où la cliente ouvre la page et celui où
 * elle choisit, un créneau a pu partir. Les recharger ne supprime pas le 409 —
 * seul le verrou serveur le fait — mais évite de proposer longtemps ce qui
 * n'existe plus.
 */
export function SlotStep({ tenant, service, staffId, onBack, onChoose }: SlotStepProps) {
  const [days, setDays] = useState<readonly DayAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    const from = calendarDateInTimeZone(new Date(), tenant.timezone);
    const query = {
      serviceId: service.id,
      from,
      to: addCalendarDays(from, WINDOW_DAYS - 1),
      ...(staffId === null ? {} : { staffId }),
    };

    const result = await loadAvailabilityAction(tenant.slug, query);

    if (result.ok) {
      setError(null);
      setDays(result.data.days);
    } else {
      setError(result.message);
      setDays([]);
    }
  }, [service.id, staffId, tenant.slug, tenant.timezone]);

  useEffect(() => {
    void load();

    const revalidate = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    document.addEventListener('visibilitychange', revalidate);

    return () => {
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [load]);

  const openDays = (days ?? []).filter((day) => day.slots.length > 0);
  // La journée retenue est cherchée **dans le rechargement en cours**, pas
  // conservée telle quelle : entre deux passages, la dernière place de la
  // journée choisie a pu partir. Elle disparaît alors de `openDays`, et s'y
  // tenir laisserait un sélecteur pointant une option qui n'existe plus au-dessus
  // d'une liste de créneaux vide, sans un mot. On retombe sur la première
  // journée encore ouverte.
  const activeDay = openDays.find((day) => day.date === selectedDate) ?? openDays[0] ?? null;
  const activeDate = activeDay?.date ?? null;

  return (
    <section aria-label="Choix du créneau">
      <h2 className="spa-card__title">{service.name}</h2>

      {error === null ? null : (
        <Notification tone="danger" title="Les disponibilités n’ont pas pu être chargées">
          <p>{error}</p>
        </Notification>
      )}

      {days === null ? (
        <p className="spa-field__skeleton" aria-busy="true">
          <span className="spa-visually-hidden">Chargement des disponibilités…</span>
        </p>
      ) : error !== null ? (
        // Le chargement a échoué : la notification ci-dessus le dit déjà, et
        // annoncer sous elle « aucun créneau sur deux semaines » ferait passer
        // une panne pour un agenda complet — en conseillant de changer de
        // prestation, ce qui n'y changerait rien.
        null
      ) : openDays.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Aucun créneau sur les deux prochaines semaines</p>
          <p className="spa-empty-state__description">
            Essayez une autre prestation, un autre praticien, ou contactez le salon directement.
          </p>
        </div>
      ) : (
        <>
          <Select
            id="journee"
            label="Journée"
            value={activeDate ?? ''}
            onChange={(event) => {
              setSelectedDate(event.target.value);
            }}
          >
            {openDays.map((day) => (
              <option key={day.date} value={day.date}>
                {formatCalendarDate(day.date)} — {String(day.slots.length)}{' '}
                créneaux
              </option>
            ))}
          </Select>

          <ul aria-label="Créneaux disponibles">
            {(activeDay?.slots ?? []).map((slot) => (
              <li key={`${slot.startsAt}-${slot.staffId}`}>
                <Button
                  variant="neutral"
                  onClick={() => {
                    onChoose(slot.startsAt);
                  }}
                >
                  {formatTimeInTimeZone(slot.startsAt, tenant.timezone)}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Button variant="quiet" onClick={onBack}>
        Changer de prestation
      </Button>
    </section>
  );
}
