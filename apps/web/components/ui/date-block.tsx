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
   * **Obligatoire depuis #1297.** Elle était facultative le temps que les
   * écrans de l'épique #843 se branchent un à un, et le repli valait `fr-FR` :
   * trois surfaces du parcours de réservation — la bande de jours, la barre
   * récapitulative, la carte de confirmation — l'ont omise jusqu'au bout, et un
   * visiteur anglais lisait « lun. 1 sept. » au milieu d'un écran anglais. Un
   * repli sur `DEFAULT_LOCALE` aurait déplacé la faute sans la rendre visible ;
   * le type, lui, la nomme à la compilation.
   */
  readonly display: DisplayLocale;
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
export function dateBlockParts(value: DateBlockValue, display: DisplayLocale): DateParts {
  const [date, timeZone, machine] =
    'date' in value
      ? [new Date(`${value.date}T12:00:00Z`), 'UTC', value.date]
      : [new Date(value.instant), value.timeZone, value.instant];

  // La langue vient de l'appelant, sans repli : c'est le type qui l'exige, et
  // c'est ce qui garantit qu'aucun bloc de date ne se remet à écrire dans une
  // langue que l'écran qui le porte n'emploie pas (#1297).
  const tag = formattingLocale(display.locale, display.countryCode);
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
