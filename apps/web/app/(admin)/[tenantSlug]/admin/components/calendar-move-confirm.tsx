'use client';

import type { TimeZone } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useId } from 'react';

import { Button } from '@/components/ui/button';
import { deskMoment, type DeskMove } from '@/lib/admin/appointment-desk';
import type { DisplayLocale } from '@/lib/format';

/**
 * La confirmation d'un report qui change de praticien — quatrième critère de #51.
 *
 * ## Pourquoi ce report-là seul se confirme
 *
 * Déplacer un rendez-vous dans la journée d'une praticienne est un geste qu'on
 * corrige d'un second glissement. Le passer à quelqu'un d'autre n'est pas du même
 * ordre : c'est une réaffectation de travail, elle se voit sur le planning de deux
 * personnes, et en vue jour deux colonnes voisines sont à quelques pixels l'une de
 * l'autre — la souris qui dérape d'une colonne coûte alors bien plus qu'un
 * déplacement d'une demi-heure. Les autres reports ne demandent rien : une
 * confirmation qu'on voit à chaque geste finit par se cliquer sans être lue.
 *
 * ## Le bloc a déjà bougé quand cette question s'affiche
 *
 * L'état optimiste est appliqué au lâcher, avant la confirmation, et c'est
 * délibéré : la question porte alors sur ce que l'écran **montre** — le bloc est
 * dans la colonne d'arrivée, sous les yeux — au lieu de demander de se figurer un
 * déplacement qui n'a pas encore eu lieu. Refuser le replace exactement comme le
 * ferait un 409, par le même chemin de retour arrière.
 *
 * ## `alertdialog` sans `aria-modal`
 *
 * Le rôle annonce une question qui attend une réponse, et le focus part sur le
 * bouton de confirmation au montage. `aria-modal` n'est pas posé : il promettrait
 * un piège de focus que ce bandeau n'installe pas, et une promesse ARIA fausse
 * dessert plus qu'un rôle simple. La touche Échap annule — c'est le geste qu'on
 * tente d'abord.
 */

interface CalendarMoveConfirmProps {
  readonly move: DeskMove;
  /** Fuseau de l'établissement — l'heure annoncée est celle du salon. */
  readonly timeZone: TimeZone;
  /**
   * Langue de la session et région de l'établissement — #848.
   *
   * La date est **insérée dans la question traduite** : sans elle, « Change
   * practitioner? … on mercredi 26 août » mêlerait les deux langues dans la
   * même phrase. Le fuseau reste `timeZone` : il décide de l'heure, jamais de
   * son écriture.
   */
  readonly display?: DisplayLocale;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function CalendarMoveConfirm({
  move,
  timeZone,
  display,
  onConfirm,
  onCancel,
}: CalendarMoveConfirmProps) {
  const titleId = useId();
  const t = useTranslations('admin-planning');

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };

    globalThis.addEventListener('keydown', onKey);

    return () => {
      globalThis.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const client = `${move.previous.client.firstName} ${move.previous.client.lastName}`;

  return (
    <div aria-labelledby={titleId} className="spa-admin-calendar__confirm" role="alertdialog">
      <p className="spa-admin-calendar__confirm-text" id={titleId}>
        {t('move.question', {
          client,
          from: move.previous.staff.displayName,
          to: move.optimistic.staff.displayName,
          moment: deskMoment(move.optimistic.startsAt, timeZone, display),
        })}
      </p>
      <div className="spa-admin-calendar__confirm-actions">
        <Button onClick={onCancel} variant="neutral">
          {t('move.cancel')}
        </Button>
        {/* Le focus part sur la réponse attendue : sans lui, la question posée
            après un lâcher à la souris resterait injoignable au clavier, et
            l'`alertdialog` annoncerait une décision que rien ne permet de
            prendre. `autoFocus` traverse le bouton du design system par ses
            attributs HTML — il n'expose pas de `ref`. */}
        <Button autoFocus onClick={onConfirm} variant="accent">
          {t('move.confirm')}
        </Button>
      </div>
    </div>
  );
}
