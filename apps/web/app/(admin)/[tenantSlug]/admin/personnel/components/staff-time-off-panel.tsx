'use client';

import { REASON_MAX_LENGTH, type CalendarDate, type StaffTimeOff, type TimeZone } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';

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
 *
 * ## Pourquoi le retrait se confirme, alors que la désactivation d'une prestation non
 *
 * `ServiceActivationButton` ne demande rien avant de retirer une prestation du
 * catalogue, et c'est justifié : le bouton redevient « Réactiver » au même endroit,
 * le geste s'annule d'un second clic. Rien de tel ici. `DELETE /v1/staff-time-off`
 * efface la ligne ; ses dates et son motif ne sont écrits nulle part ailleurs, et
 * la seule façon de revenir en arrière est de les ressaisir de mémoire. Entre-temps
 * le praticien est redevenu réservable sur ses congés — le parcours client peut
 * placer un rendez-vous dessus avant qu'on s'en aperçoive (#620).
 *
 * La confirmation est donc posée sur le seul geste irréversible de l'écran, et
 * nulle part ailleurs : une question qui s'affiche à chaque clic finit par se
 * cliquer sans être lue, et un gérant qui solde une liste d'absences en enchaîne
 * plusieurs de suite.
 *
 * Elle est **en ligne, sur la ligne concernée**, et non en modale : la question
 * porte sur l'absence qu'on a sous les yeux, et elle en redonne les dates et le
 * motif — c'est précisément ce que le retrait ferait disparaître. Un voile qui
 * masquerait la liste demanderait de se souvenir de ce qu'on vient de désigner,
 * sur un écran où deux absences ne sont séparées que de 54 px.
 */

const EMPTY_DRAFT = { fromDate: '', fromTime: '', toDate: '', toTime: '', reason: '' } as const;

/**
 * Ce qu'on dit quand l'action serveur elle-même n'a pas abouti — réseau coupé,
 * déploiement en cours. Les actions renvoient déjà un `AdminActionResult` pour
 * tout ce que l'API refuse ; il reste le transport, et sans ce rattrapage
 * l'attente resterait affichée pour toujours, boutons désactivés compris.
 */
const UNREACHABLE = 'Le serveur n’a pas répondu. Vérifiez la connexion et réessayez.';

/** L'identifiant du déclencheur, seul moyen de lui rendre le focus : `Button` n'expose pas de `ref`. */
function removeButtonId(timeOffId: string): string {
  return `absence-retirer-${timeOffId}`;
}

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
  const confirmTitleId = useId();
  /** Où le focus atterrit quand la ligne qui le portait vient d'être retirée. */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState<Omit<TimeOffDraft, 'staffId'>>(EMPTY_DRAFT);
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<{
    field: keyof TimeOffDraft | null;
    message: string;
    /** Ce qui a échoué — « Absence non enregistrée » sur un retrait raté serait un contresens. */
    title: string;
  } | null>(null);
  /** L'absence dont le retrait attend un second geste — une seule à la fois. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** L'absence dont le bouton « Retirer » doit reprendre le focus après un renoncement. */
  const [restoreFocus, setRestoreFocus] = useState<string | null>(null);

  /**
   * Renoncer au clavier. Échap est le geste qu'on tente d'abord devant une
   * question, et c'est celui qui doit coûter le moins : il ne retire rien.
   */
  useEffect(() => {
    if (confirming === null) {
      return;
    }

    const armed = confirming;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }

      // Un `DELETE` déjà parti ne se rappelle pas. Fermer la question à ce
      // moment-là laisserait croire qu'on y a renoncé alors que l'absence
      // disparaîtra quand même — le contresens exact que #620 corrige.
      if (pending === armed) {
        return;
      }

      setConfirming(null);
      setRestoreFocus(armed);
    };

    globalThis.addEventListener('keydown', onKey);

    return () => {
      globalThis.removeEventListener('keydown', onKey);
    };
  }, [confirming, pending]);

  /**
   * Le focus revient d'où il venait. Sans cela, renoncer le renverrait sur le
   * `body` : au clavier, la liste serait à reparcourir depuis le début à chaque
   * fois — et c'est au clavier qu'un clic de travers se répare.
   */
  useEffect(() => {
    if (restoreFocus === null) {
      return;
    }

    document.getElementById(removeButtonId(restoreFocus))?.focus();
    setRestoreFocus(null);
  }, [restoreFocus]);

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
      setError({
        field: validation.field,
        message: validation.message,
        title: 'Absence non enregistrée',
      });
      return;
    }

    setPending('create');
    setError(null);

    try {
      const result = await createStaffTimeOffAction(tenantSlug, validation.request);

      if (!result.ok) {
        setError({ field: null, message: result.message, title: 'Absence non enregistrée' });
        return;
      }

      setDraft(EMPTY_DRAFT);
      startRefresh(() => {
        router.refresh();
      });
    } catch {
      setError({ field: null, message: UNREACHABLE, title: 'Absence non enregistrée' });
    } finally {
      setPending(null);
    }
  }

  /**
   * Le retrait lui-même, une fois confirmé. Un échec **laisse la question posée** :
   * l'absence est toujours là, le bouton qui la retire aussi, et réessayer ne
   * redemande pas de désigner la bonne ligne.
   */
  async function remove(timeOffId: string): Promise<void> {
    setPending(timeOffId);
    setError(null);

    try {
      const result = await deleteStaffTimeOffAction(tenantSlug, staffId, timeOffId);

      if (!result.ok) {
        setError({ field: null, message: result.message, title: 'Absence non retirée' });
        return;
      }

      setConfirming(null);
      // La ligne s'en va, et avec elle le bouton qui portait le focus. Le rendre
      // au titre de la section plutôt qu'au `body` : sinon la liste est à
      // reparcourir depuis le haut de page pour retirer l'absence suivante.
      headingRef.current?.focus();
      startRefresh(() => {
        router.refresh();
      });
    } catch {
      setError({ field: null, message: UNREACHABLE, title: 'Absence non retirée' });
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="spa-admin__section" aria-labelledby="absences-titre">
      {/* `tabIndex={-1}` ne met pas le titre dans l'ordre de tabulation : il le
          rend seulement joignable au programme, pour lui rendre le focus quand
          la ligne qui le portait vient d'être retirée. */}
      <h2 className="spa-admin__section-title" id="absences-titre" ref={headingRef} tabIndex={-1}>
        Plages bloquées et congés
      </h2>
      <p className="spa-admin-toolbar__hint">{windowLabel}</p>

      {error !== null && error.field === null ? (
        <Notification tone="danger" title={error.title}>
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
                  disabled={refreshing || pending !== null}
                  id={removeButtonId(absence.id)}
                  onClick={() => setConfirming(absence.id)}
                  variant="quiet"
                >
                  Retirer
                  <span className="spa-visually-hidden">
                    {' '}
                    l’absence du {formatTimeOff(absence, timeZone)}
                  </span>
                </Button>
              ) : null}
              {canManage && confirming === absence.id ? (
                <div
                  aria-labelledby={`${confirmTitleId}-${absence.id}`}
                  className="spa-admin-schedule__exception-confirm"
                  role="alertdialog"
                >
                  <p
                    className="spa-admin-schedule__exception-confirm-text"
                    id={`${confirmTitleId}-${absence.id}`}
                  >
                    Retirer l’absence du {formatTimeOff(absence, timeZone)} (
                    {absence.reason ?? 'sans motif'})&nbsp;? Elle ne pourra pas être
                    rétablie, et le praticien redeviendra réservable sur cette période.
                  </p>
                  <div className="spa-admin-schedule__exception-confirm-actions">
                    {/* Désactivé une fois le retrait parti : le `DELETE` ne se
                        rappelle pas, et un « Annuler » qui fermerait la question
                        pendant qu'elle s'exécute annoncerait un renoncement que
                        rien ne tient. */}
                    <Button
                      disabled={pending === absence.id}
                      onClick={() => {
                        setConfirming(null);
                        setRestoreFocus(absence.id);
                      }}
                      variant="neutral"
                    >
                      Annuler
                    </Button>
                    {/* Le focus part sur la réponse attendue, comme pour le
                        changement de praticien du planning : sans lui,
                        l'`alertdialog` annoncerait une décision qu'aucun geste
                        clavier ne permettrait de prendre. `autoFocus` traverse le
                        bouton du design system par ses attributs HTML. */}
                    <Button
                      autoFocus
                      disabled={refreshing}
                      loading={pending === absence.id}
                      loadingLabel="Retrait…"
                      onClick={() => void remove(absence.id)}
                      variant="danger"
                    >
                      Retirer définitivement
                    </Button>
                  </div>
                </div>
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
