import type { CalendarDate, TimeZone, UtcInstant } from '@spa/shared';

import { formattingLocale, type DisplayLocale } from '@/lib/format';

type DateBlockValue =
  /** Un instant, lu dans le fuseau du salon (ADR 0006). */
  | { readonly instant: UtcInstant; readonly timeZone: TimeZone }
  /** Une date civile déjà découpée par le serveur dans le fuseau du salon. */
  | { readonly date: CalendarDate };

type DateBlockProps = DateBlockValue & {
  /** `sm` pour une bande de jours, `lg` pour une carte de rendez-vous. */
  readonly size?: 'sm' | 'lg';
  /**
   * La langue et la région de la mise en forme (#847) — « LUN · 21 · SEPT »
   * d'un côté, « MON · 21 · SEP » de l'autre.
   *
   * Facultative : sans elle, le bloc retombe sur le repli documenté de
   * `lib/format.ts` (`fr-FR`), c'est-à-dire exactement ce qu'il écrivait avant
   * que la langue n'existe. Les surfaces qui ont déjà la langue résolue sous la
   * main la passent ; les autres la passeront dans leur propre ticket de
   * l'épique #843.
   */
  readonly display?: DisplayLocale;
};

interface DateParts {
  readonly weekday: string;
  readonly day: string;
  readonly month: string;
  readonly full: string;
  readonly machine: string;
}

/** « ven. » → « ven » : l'abréviation se lit en capitales, sans son point. */
function bare(text: string): string {
  return text.replace(/\.$/u, '');
}

/**
 * Les trois morceaux du bloc, et la date en toutes lettres pour les lecteurs
 * d'écran. Une date civile se lit à midi UTC **dans** UTC — comme
 * `formatCalendarDate` : aucun fuseau ne peut la faire glisser d'un jour.
 */
export function dateBlockParts(value: DateBlockValue, display?: DisplayLocale): DateParts {
  const [date, timeZone, machine] =
    'date' in value
      ? [new Date(`${value.date}T12:00:00Z`), 'UTC', value.date]
      : [new Date(value.instant), value.timeZone, value.instant];

  // `formattingLocale` sans argument rend `fr-FR` : le repli de l'épique #843,
  // et donc le comportement d'avant la langue pour les appelants qui n'en
  // passent pas encore.
  const tag = formattingLocale(display?.locale, display?.countryCode);
  const parts = new Intl.DateTimeFormat(tag, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    bare(parts.find((candidate) => candidate.type === type)?.value ?? '');

  return {
    weekday: part('weekday'),
    day: part('day'),
    month: part('month'),
    full: new Intl.DateTimeFormat(tag, { timeZone, dateStyle: 'full' }).format(date),
    machine,
  };
}

/**
 * Une date en bloc (#1044) — « VEN · 18 · SEPT ».
 *
 * L'œil trouve le jour avant de lire la ligne : c'est ce qui rend une liste de
 * rendez-vous ou une bande de jours balayable. Les trois morceaux sont masqués
 * aux lecteurs d'écran, qui entendent la date entière.
 */
export function DateBlock({ size = 'sm', display, ...value }: DateBlockProps) {
  const parts = dateBlockParts(value, display);

  return (
    <time className={`spa-date-block spa-date-block--${size}`} dateTime={parts.machine}>
      <span className="spa-date-block__weekday" aria-hidden="true">
        {parts.weekday}
      </span>
      <span className="spa-date-block__day" aria-hidden="true">
        {parts.day}
      </span>
      <span className="spa-date-block__month" aria-hidden="true">
        {parts.month}
      </span>
      <span className="spa-visually-hidden">{parts.full}</span>
    </time>
  );
}
