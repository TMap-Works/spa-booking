'use client';

import { REASON_MAX_LENGTH, type CalendarDate, type StaffTimeOff, type TimeZone } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import {
  defaultReturnDate,
  formatTimeOff,
  validateTimeOffDraft,
  type TimeOffDraft,
} from '@/lib/admin/staff-time-off';

import { createStaffTimeOffAction, deleteStaffTimeOffAction } from '../actions';

/**
 * Plages bloquées et congés d'un praticien (#53, troisième critère).
 *
 * ## Un seul formulaire pour les deux
 *
 * Un congé de deux semaines et un après-midi de formation sont la **même** forme
 * — un intervalle `[début, fin[` — et seule leur durée les distingue. Le moteur
 * de créneaux les soustrait des fenêtres de travail sans savoir lequel il tient ;
 * offrir deux formulaires aurait obligé à choisir avant de savoir, et à
 * recommencer quand la formation déborde sur le lendemain.
 *
 * Les heures sont donc **facultatives** : laissées vides, elles valent minuit, et
 * la saisie se réduit à deux dates. C'est le cas courant, et c'est celui qui doit
 * demander le moins de gestes.
 *
 * ## Le jour de reprise, et pourquoi il n'est pas « le dernier jour »
 *
 * La borne haute est exclue : un congé du 2 au 16 se termine à minuit du 17. Le
 * champ demande donc le **jour de reprise** en toutes lettres, et le pré-remplit
 * au lendemain du premier jour dès qu'on saisit celui-ci. Nommer ce champ « fin »
 * aurait garanti une journée de décalage à chaque saisie — celle qu'on découvre
 * le jour où une cliente n'a pas pu réserver.
 */

const EMPTY_DRAFT = { fromDate: '', fromTime: '', toDate: '', toTime: '', reason: '' } as const;

export function StaffTimeOffPanel({
  tenantSlug,
  staffId,
  timeZone,
  timeOff,
  windowLabel,
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly staffId: string;
  readonly timeZone: TimeZone;
  readonly timeOff: readonly StaffTimeOff[];
  /** Ce que couvre la liste — une fenêtre bornée, jamais tout l'historique. */
  readonly windowLabel: string;
  /**
   * `false` au rang praticien : `POST` et `DELETE /v1/staff-time-off` sont
   * `@AuthAtLeast('MANAGER')`. La liste reste lisible, le formulaire disparaît —
   * offrir des boutons qui répondraient 403 n'aide personne.
   */
  readonly canManage?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Omit<TimeOffDraft, 'staffId'>>(EMPTY_DRAFT);
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<{ field: keyof TimeOffDraft | null; message: string } | null>(
    null,
  );

  function fieldError(field: keyof TimeOffDraft): string | undefined {
    return error !== null && error.field === field ? error.message : undefined;
  }

  function change(changes: Partial<Omit<TimeOffDraft, 'staffId'>>): void {
    setDraft((current) => ({ ...current, ...changes }));
    setError(null);
  }

  /** Saisir le premier jour propose le lendemain en reprise — le cas d'un jour. */
  function changeFromDate(value: string): void {
    change({
      fromDate: value,
      ...(draft.toDate === '' && value !== ''
        ? { toDate: defaultReturnDate(value as CalendarDate) }
        : {}),
    });
  }

  async function create(): Promise<void> {
    const validation = validateTimeOffDraft({ ...draft, staffId }, timeZone);

    if (!validation.ok) {
      setError({ field: validation.field, message: validation.message });
      return;
    }

    setPending('create');
    setError(null);

    const result = await createStaffTimeOffAction(tenantSlug, validation.request);

    setPending(null);

    if (!result.ok) {
      setError({ field: null, message: result.message });
      return;
    }

    setDraft(EMPTY_DRAFT);
    startRefresh(() => {
      router.refresh();
    });
  }

  async function remove(timeOffId: string): Promise<void> {
    setPending(timeOffId);
    setError(null);

    const result = await deleteStaffTimeOffAction(tenantSlug, staffId, timeOffId);

    setPending(null);

    if (!result.ok) {
      setError({ field: null, message: result.message });
      return;
    }

    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="absences-titre">
      <h2 className="spa-admin__section-title" id="absences-titre">
        Plages bloquées et congés
      </h2>
      <p className="spa-admin-toolbar__hint">{windowLabel}</p>

      {error !== null && error.field === null ? (
        <Notification tone="danger" title="Absence non enregistrée">
          <p>{error.message}</p>
        </Notification>
      ) : null}

      {timeOff.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Aucune absence sur la période</p>
          <p className="spa-empty-state__description">
            Les créneaux de ce praticien suivent sa semaine de travail sans exception. Une plage
            bloquée les retire ponctuellement, sans toucher aux horaires récurrents.
          </p>
        </div>
      ) : (
        <ul className="spa-admin-schedule__exceptions">
          {timeOff.map((absence) => (
            <li className="spa-admin-schedule__exception" key={absence.id}>
              <span className="spa-admin-schedule__exception-date">
                {formatTimeOff(absence, timeZone)}
              </span>
              <span className="spa-admin-schedule__exception-label">
                {absence.reason ?? 'Sans motif'}
              </span>
              {canManage ? (
                <Button
                  disabled={refreshing}
                  loading={pending === absence.id}
                  loadingLabel="Retrait…"
                  onClick={() => void remove(absence.id)}
                  variant="quiet"
                >
                  Retirer
                  <span className="spa-visually-hidden">
                    {' '}
                    l’absence du {formatTimeOff(absence, timeZone)}
                  </span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? null : (
        <p className="spa-admin-toolbar__hint">
          La pose et le retrait d’une absence sont réservés au rang gérant.
        </p>
      )}

      {canManage ? (
        <>
          <Field
            error={fieldError('fromDate')}
            id="absence-debut"
            label="Premier jour d’absence"
            onChange={(event) => changeFromDate(event.target.value)}
            type="date"
            value={draft.fromDate}
          />
          <Field
            hint="Laissez vide pour une journée entière."
            id="absence-debut-heure"
            label="À partir de"
            onChange={(event) => change({ fromTime: event.target.value })}
            type="time"
            value={draft.fromTime}
          />
          <Field
            error={fieldError('toDate')}
            hint="Borne exclue : c’est le jour où le praticien reprend."
            id="absence-reprise"
            label="Jour de reprise"
            onChange={(event) => change({ toDate: event.target.value })}
            type="date"
            value={draft.toDate}
          />
          <Field
            hint="Laissez vide pour une journée entière."
            id="absence-reprise-heure"
            label="Jusqu’à"
            onChange={(event) => change({ toTime: event.target.value })}
            type="time"
            value={draft.toTime}
          />
          <Field
            error={fieldError('reason')}
            hint="Interne au salon — jamais montré à la clientèle."
            id="absence-motif"
            label="Motif"
            maxLength={REASON_MAX_LENGTH}
            onChange={(event) => change({ reason: event.target.value })}
            type="text"
            value={draft.reason}
          />

          <Button
            disabled={refreshing}
            loading={pending === 'create'}
            loadingLabel="Enregistrement…"
            onClick={() => void create()}
            variant="accent"
          >
            Bloquer cette période
          </Button>
        </>
      ) : null}
    </section>
  );
}
