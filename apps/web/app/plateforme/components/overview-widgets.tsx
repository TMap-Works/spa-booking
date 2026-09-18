import type { PlatformOverview, PlatformSignupWeek } from '@spa/shared';

import { Icon, type IconName } from '@/components/ui/icon';

/**
 * Les briques du tableau de bord de l'éditeur — tuiles, ouvertures par semaine,
 * entonnoir d'activation.
 *
 * Mêmes classes que le tableau de bord d'un salon (`styles/admin/dashboard.css`)
 * pour les tuiles : la console et le back-office parlent la même langue
 * visuelle. Ce qui leur est propre vit dans `styles/admin/platform-console.css`.
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

/** « 14 sept. » — l'étiquette d'une semaine, par son lundi. */
function weekLabel(weekStart: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
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
  const totals = weeks.map((week) => week.console + week.signup);
  const peak = Math.max(1, ...totals);

  return (
    <figure className="spa-console-weeks">
      <ol aria-label="Ouvertures de salons par semaine" className="spa-console-weeks__bars" role="list">
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
                {index % 2 === 0 || index === weeks.length - 1 ? weekLabel(week.weekStart) : ''}
              </span>
              <span className="spa-visually-hidden">
                {`Semaine du ${weekLabel(week.weekStart)} : ${String(week.signup)} inscription${week.signup > 1 ? 's' : ''} en ligne, ${String(week.console)} ouverture${week.console > 1 ? 's' : ''} par la console`}
              </span>
            </li>
          );
        })}
      </ol>
      <figcaption className="spa-console-legend">
        <span className="spa-console-legend__item">
          <span aria-hidden="true" className="spa-console-legend__swatch spa-console-legend__swatch--signup" />
          Inscription en ligne
        </span>
        <span className="spa-console-legend__item">
          <span aria-hidden="true" className="spa-console-legend__swatch spa-console-legend__swatch--console" />
          Ouvert par la console
        </span>
      </figcaption>
    </figure>
  );
}

/** Un pourcentage entier — `—` quand la base est vide, plutôt qu'un 0 % trompeur. */
function share(part: number, whole: number): string {
  return whole === 0 ? '—' : `${String(Math.round((part / whole) * 100))} %`;
}

/**
 * L'entonnoir d'activation : de l'ouverture au salon qui vit. Chaque étape est
 * rapportée aux salons ouverts — c'est la question qu'on se pose : « sur tous
 * ceux qu'on a ouverts, combien s'en servent ? ».
 */
export function ActivationFunnel({ activation }: { readonly activation: PlatformOverview['activation'] }) {
  const steps = [
    { key: 'ouverts', label: 'Salons ouverts', value: activation.opened },
    { key: 'configures', label: 'Prestation et praticien en place', value: activation.configured },
    { key: 'reserves', label: 'Au moins un rendez-vous', value: activation.booked },
    { key: 'actifs', label: 'Un rendez-vous ces 30 derniers jours', value: activation.activeLast30Days },
  ];

  return (
    <ol className="spa-console-funnel" role="list">
      {steps.map((step) => (
        <li className="spa-console-funnel__step" key={step.key}>
          <span className="spa-console-funnel__head">
            <span className="spa-console-funnel__label">{step.label}</span>
            <span className="spa-console-funnel__value">
              <strong>{step.value}</strong>
              <span>{share(step.value, activation.opened)}</span>
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
