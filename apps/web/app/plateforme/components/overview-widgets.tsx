import type { Locale, PlatformOverview, PlatformSignupWeek } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

import { Icon, type IconName } from '@/components/ui/icon';
import { formattingLocale } from '@/lib/format';

/**
 * Les briques du tableau de bord de l'éditeur — tuiles, ouvertures par semaine,
 * entonnoir d'activation.
 *
 * Mêmes classes que le tableau de bord d'un salon (`styles/admin/dashboard.css`)
 * pour les tuiles : la console et le back-office parlent la même langue
 * visuelle. Ce qui leur est propre vit dans `styles/admin/platform-console.css`.
 *
 * Des Server Components : `useTranslations` et `useLocale` s'y appellent comme
 * dans un composant client, la seule contrainte étant de ne pas être asynchrone.
 * Aucun état, aucun écouteur — il n'y a rien à hydrater ici.
 */

export type KpiTone = 'accent' | 'success' | 'warning' | 'danger';

/** Une tuile chiffrée : une valeur, ce qu'elle mesure, et ce qu'elle cache. */
export function PlatformKpi({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: KpiTone;
}) {
  return (
    <div className={`spa-admin-metric spa-admin-dashboard__kpi spa-admin-dashboard__kpi--${tone}`}>
      <span className="spa-admin-dashboard__kpi-head">
        <span className="spa-admin-dashboard__kpi-icon">
          <Icon name={icon} />
        </span>
        <span className="spa-admin-dashboard__kpi-label">{label}</span>
      </span>
      <span className="spa-admin-metric__value">{value}</span>
      <span className="spa-admin-metric__label">{detail}</span>
    </div>
  );
}

/**
 * « 14 sept. », « Sep 14 » — l'étiquette d'une semaine, par son lundi.
 *
 * `timeZone: 'UTC'` et non le fuseau d'un salon : `weekStart` est une date civile
 * découpée en UTC par l'API (`platformSignupWeekSchema`), et la reprojeter dans un
 * autre fuseau la ferait reculer d'un jour à l'ouest de Greenwich.
 */
function weekLabel(weekStart: string, locale: Locale): string {
  return new Intl.DateTimeFormat(formattingLocale(locale), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${weekStart}T00:00:00Z`));
}

/**
 * Douze semaines d'ouvertures, en barres empilées : ouvertures par la console
 * en bas, inscriptions en ligne au-dessus. Le total est écrit sur la barre ; le
 * détail est lu par les lecteurs d'écran.
 */
export function SignupWeeksChart({ weeks }: { readonly weeks: readonly PlatformSignupWeek[] }) {
  const t = useTranslations('platform');
  const locale = useLocale() as Locale;
  const totals = weeks.map((week) => week.console + week.signup);
  const peak = Math.max(1, ...totals);

  return (
    <figure className="spa-console-weeks">
      <ol aria-label={t('widgets.weeksLabel')} className="spa-console-weeks__bars" role="list">
        {weeks.map((week, index) => {
          const total = totals[index] ?? 0;
          return (
            <li className="spa-console-weeks__bar" key={week.weekStart}>
              <span className="spa-console-weeks__value">{total === 0 ? '' : total}</span>
              <span className="spa-console-weeks__track" aria-hidden="true">
                <span
                  className="spa-console-weeks__fill spa-console-weeks__fill--signup"
                  style={{ blockSize: `${Math.round((week.signup / peak) * 100)}%` }}
                />
                <span
                  className="spa-console-weeks__fill spa-console-weeks__fill--console"
                  style={{ blockSize: `${Math.round((week.console / peak) * 100)}%` }}
                />
              </span>
              <span className="spa-console-weeks__label" aria-hidden="true">
                {index % 2 === 0 || index === weeks.length - 1
                  ? weekLabel(week.weekStart, locale)
                  : ''}
              </span>
              <span className="spa-visually-hidden">
                {t('widgets.weekSummary', {
                  week: weekLabel(week.weekStart, locale),
                  signup: week.signup,
                  console: week.console,
                })}
              </span>
            </li>
          );
        })}
      </ol>
      <figcaption className="spa-console-legend">
        <span className="spa-console-legend__item">
          <span
            aria-hidden="true"
            className="spa-console-legend__swatch spa-console-legend__swatch--signup"
          />
          {t('widgets.legendSignup')}
        </span>
        <span className="spa-console-legend__item">
          <span
            aria-hidden="true"
            className="spa-console-legend__swatch spa-console-legend__swatch--console"
          />
          {t('widgets.legendConsole')}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Un pourcentage entier — `—` quand la base est vide, plutôt qu'un 0 % trompeur.
 *
 * Le chiffre passe par `Intl.NumberFormat` : l'espace avant le signe pour cent
 * est insécable en français et absente en anglais, et c'est `Intl` qui le sait.
 */
function share(part: number, whole: number, locale: Locale): string {
  return whole === 0
    ? '—'
    : new Intl.NumberFormat(formattingLocale(locale), {
        style: 'percent',
        maximumFractionDigits: 0,
      }).format(part / whole);
}

/**
 * L'entonnoir d'activation : de l'ouverture au salon qui vit. Chaque étape est
 * rapportée aux salons ouverts — c'est la question qu'on se pose : « sur tous
 * ceux qu'on a ouverts, combien s'en servent ? ».
 */
export function ActivationFunnel({
  activation,
}: {
  readonly activation: PlatformOverview['activation'];
}) {
  const t = useTranslations('platform');
  const locale = useLocale() as Locale;
  const steps = [
    { key: 'opened', value: activation.opened },
    { key: 'configured', value: activation.configured },
    { key: 'booked', value: activation.booked },
    { key: 'active', value: activation.activeLast30Days },
  ] as const;

  return (
    <ol className="spa-console-funnel" role="list">
      {steps.map((step) => (
        <li className="spa-console-funnel__step" key={step.key}>
          <span className="spa-console-funnel__head">
            <span className="spa-console-funnel__label">{t(`widgets.funnel.${step.key}`)}</span>
            <span className="spa-console-funnel__value">
              <strong>{step.value}</strong>
              <span>{share(step.value, activation.opened, locale)}</span>
            </span>
          </span>
          <span className="spa-console-funnel__track" aria-hidden="true">
            <span
              className="spa-console-funnel__fill"
              style={{
                inlineSize:
                  activation.opened === 0
                    ? '0%'
                    : `${String(Math.round((step.value / activation.opened) * 100))}%`,
              }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}
