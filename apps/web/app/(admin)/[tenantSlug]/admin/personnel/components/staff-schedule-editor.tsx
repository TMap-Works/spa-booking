'use client';

import { type IsoWeekday, type StaffSchedule } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  ISO_WEEKDAYS,
  SCHEDULE_END_OF_DAY,
  newScheduleRow,
  rowsFromEntries,
  validateScheduleRows,
  weekdayLabel,
  type ScheduleRow,
} from '@/lib/admin/staff-schedule';
import { formatDuration } from '@/lib/format';

import { setStaffScheduleAction } from '../actions';

/**
 * La semaine de travail d'un praticien, saisissable (#53, deuxième critère).
 *
 * ## Client Component, et il ne pouvait pas ne pas l'être
 *
 * Sept jours, un nombre libre de plages par jour, des lignes qu'on ajoute et
 * qu'on retire : c'est de l'état local, et le rendre côté serveur demanderait un
 * aller-retour par frappe. Le composant est néanmoins **aussi bas que possible**
 * dans l'arbre (web-frontend §1) — la fiche du praticien, elle, reste un Server
 * Component.
 *
 * ## Une journée fermée est un état, pas une absence de saisie
 *
 * L'interrupteur « Ouvert » de chaque jour est ce qui distingue « le salon ferme
 * le mercredi » de « le mercredi n'est pas encore renseigné ». Le décocher retire
 * les plages du jour ; le recocher en propose une. Sans lui, une grille vide se
 * lirait des deux façons — et c'est la lecture optimiste qui fait qu'un praticien
 * se retrouve proposé un jour où il ne travaille pas.
 *
 * ## Pourquoi l'enregistrement porte la semaine entière
 *
 * Parce que l'API le demande, et pour une bonne raison : la seule invariante qui
 * compte — aucune plage ne se recouvre — porte sur l'ensemble. La vérifier à
 * chaque ajout ferait dépendre le verdict de l'ordre des appels, et deux plages
 * qui se recouvrent passeraient si on les posait dans le bon sens.
 *
 * ## `24:00`, et pourquoi une case à cocher plutôt qu'un champ
 *
 * Un `<input type="time">` s'arrête à `23:59` : c'est la borne de l'heure murale,
 * et elle est juste — minuit n'est pas une heure de la journée qui s'achève. Mais
 * la borne haute d'une plage est **exclue**, et un salon qui ferme à minuit n'a
 * aucune façon exacte de le dire en `HH:MM`. `23:59` perdrait une minute, donc le
 * dernier créneau de la soirée. La case pose le littéral `24:00` que le contrat
 * réserve à ce cas, et neutralise le champ tant qu'elle est cochée.
 */

/** Les plages d'un jour, dans l'ordre où elles ont été saisies. */
function rowsOf(rows: readonly ScheduleRow[], weekday: IsoWeekday): readonly ScheduleRow[] {
  return rows.filter((row) => row.weekday === weekday);
}

/** Minutes d'une plage saisie — `null` tant qu'une borne manque ou recule. */
function rowMinutes(row: ScheduleRow): number | null {
  if (row.startsAt === '' || row.endsAt === '') {
    return null;
  }

  const [startHour = '0', startMinute = '0'] = row.startsAt.split(':');
  const [endHour = '0', endMinute = '0'] = row.endsAt.split(':');
  const span =
    Number(endHour) * 60 + Number(endMinute) - (Number(startHour) * 60 + Number(startMinute));

  return span > 0 ? span : null;
}

export function StaffScheduleEditor({
  tenantSlug,
  staffId,
  schedule,
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly staffId: string;
  readonly schedule: StaffSchedule;
  /**
   * `false` au rang praticien : `PUT /v1/staff/:id/schedule` est
   * `@AuthAtLeast('MANAGER')`, et la grille n'est plus qu'une lecture. Les
   * contrôles sont neutralisés plutôt que retirés — c'est le seul affichage de
   * la semaine, et la masquer priverait le comptoir de la consulter.
   */
  readonly canManage?: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<readonly ScheduleRow[]>(() => rowsFromEntries(schedule.entries));
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<{ rowId: string | null; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  /** Le total de la semaine, recalculé à la frappe — le repère qui trahit l'oubli. */
  const total = rows.reduce((sum, row) => sum + (rowMinutes(row) ?? 0), 0);
  /** Saisie neutralisée : enregistrement en cours, ou rang insuffisant pour écrire. */
  const locked = saving || !canManage;

  function edit(next: readonly ScheduleRow[]): void {
    setRows(next);
    setError(null);
    setSaved(false);
  }

  function toggleDay(weekday: IsoWeekday, open: boolean): void {
    edit(
      open
        ? [...rows, newScheduleRow(weekday, `${String(Date.now())}-${String(rows.length)}`)]
        : rows.filter((row) => row.weekday !== weekday),
    );
  }

  function addRow(weekday: IsoWeekday): void {
    edit([...rows, newScheduleRow(weekday, `${String(Date.now())}-${String(rows.length)}`)]);
  }

  function removeRow(id: string): void {
    edit(rows.filter((row) => row.id !== id));
  }

  function updateRow(id: string, changes: Partial<Pick<ScheduleRow, 'startsAt' | 'endsAt'>>): void {
    edit(rows.map((row) => (row.id === id ? { ...row, ...changes } : row)));
  }

  async function save(): Promise<void> {
    const validation = validateScheduleRows(rows);

    if (!validation.ok) {
      setError({ rowId: validation.rowId, message: validation.message });
      return;
    }

    setSaving(true);
    setError(null);
    // Le succès précédent cesse d'être vrai dès qu'un nouvel enregistrement
    // part : sans cette remise à zéro, un second envoi refusé afficherait
    // « Horaires enregistrés » et « Semaine non enregistrée » côte à côte.
    setSaved(false);

    const result = await setStaffScheduleAction(tenantSlug, staffId, validation.request);

    setSaving(false);

    if (!result.ok) {
      setError({ rowId: null, message: result.message });
      return;
    }

    setRows(rowsFromEntries(result.data.entries));
    setSaved(true);
    // Le rafraîchissement est ce qui rend visible le cinquième critère : les
    // créneaux proposés, rendus par le serveur juste à côté, se recalculent sur
    // la semaine qu'on vient d'enregistrer.
    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="horaires-titre">
      <h2 className="spa-admin__section-title" id="horaires-titre">
        Horaires hebdomadaires
      </h2>
      <p className="spa-admin-toolbar__hint">
        Heures écrites dans le fuseau du salon ({schedule.timezone}), stockées en UTC. Total
        saisi&nbsp;: {formatDuration(total)} par semaine.
      </p>

      {error !== null && error.rowId === null ? (
        <Notification tone="danger" title="Semaine non enregistrée">
          <p>{error.message}</p>
        </Notification>
      ) : null}

      {saved ? (
        <Notification tone="success" title="Horaires enregistrés">
          <p>Les créneaux proposés à la clientèle tiennent compte de cette semaine.</p>
        </Notification>
      ) : null}

      <div className="spa-admin-schedule">
        {ISO_WEEKDAYS.map((weekday) => {
          const dayRows = rowsOf(rows, weekday);
          const toggleId = `jour-${String(weekday)}`;

          return (
            <div className="spa-admin-schedule__day" key={weekday}>
              <span className="spa-admin-schedule__day-label">{weekdayLabel(weekday)}</span>
              <span className="spa-admin-schedule__toggle">
                <input
                  checked={dayRows.length > 0}
                  disabled={locked}
                  id={toggleId}
                  onChange={(event) => toggleDay(weekday, event.target.checked)}
                  type="checkbox"
                />
                <label htmlFor={toggleId}>Ouvert</label>
              </span>
              <div className="spa-admin-schedule__ranges">
                {dayRows.length === 0 ? (
                  <span className="spa-admin-schedule__closed">Fermé — aucun créneau proposé</span>
                ) : (
                  dayRows.map((row) => {
                    const closesAtMidnight = row.endsAt === SCHEDULE_END_OF_DAY;

                    return (
                      <span className="spa-admin-schedule__range" key={row.id}>
                        <label className="spa-visually-hidden" htmlFor={`${row.id}-debut`}>
                          Début de la plage du {weekdayLabel(weekday).toLowerCase()}
                        </label>
                        <input
                          disabled={locked}
                          id={`${row.id}-debut`}
                          onChange={(event) => updateRow(row.id, { startsAt: event.target.value })}
                          type="time"
                          value={row.startsAt}
                        />
                        <span aria-hidden="true">–</span>
                        <label className="spa-visually-hidden" htmlFor={`${row.id}-fin`}>
                          Fin de la plage du {weekdayLabel(weekday).toLowerCase()}
                        </label>
                        <input
                          disabled={locked || closesAtMidnight}
                          id={`${row.id}-fin`}
                          onChange={(event) => updateRow(row.id, { endsAt: event.target.value })}
                          type="time"
                          value={closesAtMidnight ? '' : row.endsAt}
                        />
                        <label htmlFor={`${row.id}-minuit`}>
                          <input
                            checked={closesAtMidnight}
                            disabled={locked}
                            id={`${row.id}-minuit`}
                            onChange={(event) =>
                              updateRow(row.id, {
                                endsAt: event.target.checked ? SCHEDULE_END_OF_DAY : '18:00',
                              })
                            }
                            type="checkbox"
                          />{' '}
                          minuit
                        </label>
                        <Button
                          disabled={locked}
                          onClick={() => removeRow(row.id)}
                          variant="quiet"
                        >
                          Retirer
                          <span className="spa-visually-hidden">
                            {' '}
                            la plage du {weekdayLabel(weekday).toLowerCase()}
                          </span>
                        </Button>
                        {error !== null && error.rowId === row.id ? (
                          <span className="spa-field__error" role="alert">
                            {error.message}
                          </span>
                        ) : null}
                      </span>
                    );
                  })
                )}
                <Button disabled={locked} onClick={() => addRow(weekday)} variant="quiet">
                  Ajouter une plage
                  <span className="spa-visually-hidden">
                    {' '}
                    le {weekdayLabel(weekday).toLowerCase()}
                  </span>
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__spacer" />
        {canManage ? (
          <Button
            disabled={refreshing}
            loading={saving}
            loadingLabel="Enregistrement…"
            onClick={() => void save()}
            variant="accent"
          >
            Enregistrer la semaine
          </Button>
        ) : (
          <span className="spa-admin-toolbar__hint">
            La modification des horaires est réservée au rang gérant.
          </span>
        )}
      </div>
    </section>
  );
}
