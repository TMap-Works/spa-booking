import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * L'écran des indicateurs d'activité en français et en anglais — #851.
 *
 * ## Ce que cette suite protège
 *
 * - **la barre de filtres et le bouton d'export parlent la langue de
 *   l'interface**, alors que les **valeurs** qu'ils posent dans l'URL restent
 *   françaises : `?periode=sept-jours`, `?filtre=praticien:<id>` sont des
 *   segments d'URL et non des mots, et un lien partagé doit ouvrir le même
 *   écran quelle que soit la langue de celui qui l'ouvre ;
 * - **les légendes, les axes et le tableau de lecture d'écran du graphique**
 *   viennent de l'appelant, et la graduation par défaut suit la langue — c'est
 *   le deuxième critère d'acceptation ;
 * - **le modèle de vue parle la langue hors de React** : « Tout
 *   l'établissement », « Non attribué » et la qualification de la tuile de
 *   volume se composent au milieu d'un calcul, là où aucun crochet n'est
 *   disponible ;
 * - **la langue ne change aucun chiffre** : les comptes et les taux sont les
 *   mêmes des deux côtés, seule leur mise en forme diffère.
 *
 * Le rendu d'un composant en anglais demande de remplacer l'amorce de langue des
 * suites, qui les fixe toutes en français (`tests/support/next-intl.ts`) : la
 * doublure ci-dessous lit le **vrai** catalogue anglais, par le même
 * `loadMessages` que le serveur.
 */

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');
  const messages = loadMessages('en');
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;
  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => 'en',
    useTranslations: (namespace?: string) => {
      const key = namespace ?? '';
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const made = translator(
        namespace === undefined
          ? { locale: 'en', messages }
          : { locale: 'en', messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const createExport = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/reporting/actions', () => ({
  createReportExportAction: (...args: unknown[]) => createExport(...args),
}));

import userEvent from '@testing-library/user-event';

import { ReportChart } from '@/app/(admin)/[tenantSlug]/admin/components/report-chart';
import { ReportExportButton } from '@/app/(admin)/[tenantSlug]/admin/components/report-export-button';
import { ReportFilters } from '@/app/(admin)/[tenantSlug]/admin/components/report-filters';
import type { AppointmentVolumeReport, NoShowReport } from '@/lib/admin/reporting-contract';
import {
  filterOptions,
  formatCount,
  formatRate,
  scopedActivity,
  volumePoints,
  volumeQualification,
  wholeTenant,
} from '@/lib/admin/reporting-view';
import { shortDayLabel } from '@/lib/admin/reporting-window';

afterEach(() => {
  cleanup();
  push.mockReset();
  createExport.mockReset();
});

const STAFF = [
  { key: 'a1', label: 'Hasina', total: 88 },
  { key: 'b2', label: 'Tiana', total: 76 },
];
const SERVICES = [{ key: 's1', label: 'Massage 60 min', total: 40 }];

describe('la barre de filtres en anglais', () => {
  function renderFilters() {
    return render(
      <ReportFilters
        period="trente-jours"
        range={{ from: '2026-09-01', to: '2026-09-30' }}
        scope={wholeTenant('en')}
        services={SERVICES}
        staff={STAFF}
        tenantSlug="maison-lotus"
        timeZone="Indian/Antananarivo"
      />,
    );
  }

  it('traduit les libellés, les groupes et le bouton', () => {
    renderFilters();

    expect(screen.getByLabelText('Period')).toBeTruthy();
    expect(screen.getByLabelText('Filter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy();
    expect(
      [...screen.getByLabelText('Filter').querySelectorAll('optgroup')].map((group) =>
        group.getAttribute('label'),
      ),
    ).toEqual(['Practitioners', 'Services']);
    expect(screen.getByRole('option', { name: 'Whole salon' })).toBeTruthy();
  });

  it('traduit les périodes sans traduire ce qu’elles posent dans l’URL', async () => {
    const user = userEvent.setup();
    renderFilters();

    expect(screen.getByRole('option', { name: 'Last 30 days' })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Period'), 'mois-precedent');
    await user.click(screen.getByRole('button', { name: 'Show' }));

    // La valeur reste française : c'est un segment d'URL, pas un mot.
    expect(push).toHaveBeenCalledWith('/maison-lotus/admin/reporting?periode=mois-precedent');
  });

  it('refuse une fenêtre inversée en anglais, sur le champ', async () => {
    const user = userEvent.setup();
    render(
      <ReportFilters
        period="personnalisee"
        range={{ from: '2026-09-01', to: '2026-09-30' }}
        scope={wholeTenant('en')}
        services={SERVICES}
        staff={STAFF}
        tenantSlug="maison-lotus"
        timeZone="Indian/Antananarivo"
      />,
    );

    await user.clear(screen.getByLabelText('To (inclusive)'));
    await user.type(screen.getByLabelText('To (inclusive)'), '2026-08-01');
    await user.click(screen.getByRole('button', { name: 'Show' }));

    expect(screen.getByRole('alert').textContent).toMatch(/before/);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('le bouton d’export en anglais', () => {
  it('traduit son libellé et transmet la langue de l’interface', async () => {
    // Le fichier est écrit par le serveur : c'est ce bouton qui lui dit dans
    // quelle langue l'écrire (#851, troisième critère).
    createExport.mockResolvedValue({
      ok: true,
      data: { id: 'x', url: 'https://exemple/x.csv', expiresAt: '2026-09-30T00:00:00Z', filename: 'x.csv' },
    });
    const user = userEvent.setup();

    render(
      <ReportExportButton
        tenantSlug="maison-lotus"
        window={{ from: '2026-08-31T21:00:00Z', to: '2026-09-30T21:00:00Z' }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Export to CSV' });

    await user.click(button);

    expect(createExport).toHaveBeenCalledWith(
      'maison-lotus',
      { from: '2026-08-31T21:00:00Z', to: '2026-09-30T21:00:00Z' },
      'en',
    );
    expect(screen.getByText('File downloaded: x.csv')).toBeTruthy();
  });
});

describe('le graphique en anglais', () => {
  it('gradue son axe dans la langue reçue et titre le tableau masqué', () => {
    // Le composant n'écrit aucun mot : tout arrive en propriétés. Seule la
    // graduation par défaut met en forme un nombre, et elle suit `display`.
    const { container } = render(
      <ReportChart
        bars={[{ key: 'a', label: 'Hasina', value: 1_400, valueLabel: '1,400 appointments' }]}
        display={{ locale: 'en', countryCode: 'GB' }}
        emptyLabel="No appointments over the period."
        labelHeader="Period"
        layout="colonnes"
        seriesLabel="Appointments"
        summary="Appointments per practitioner."
        title="Appointments per practitioner"
        valueHeader="Appointments"
      />,
    );

    const scale = [...container.querySelectorAll('.spa-admin-chart__scale')].map(
      (tick) => tick.textContent ?? '',
    );

    // « 1.5k » en anglais là où le français écrit « 1,5 k » : ce que le test
    // fixe est le **séparateur décimal**, seule chose que la langue décide ici.
    //
    // La casse du suffixe, elle, n'est pas fixée : CLDR l'écrit `K` en `en-US`
    // et `k` en `en-GB`, et la version d'ICU embarquée par Node décide laquelle
    // `en-GB` hérite — d'où un `1.5K` local et un `1.5k` en CI sur la même
    // assertion. Aucun des deux n'est un défaut du produit, et figer la casse
    // ferait échouer la suite au prochain relèvement de Node.
    expect(scale.join(' ')).toMatch(/1\.5\s?[kK]/);
    expect(screen.getByRole('columnheader', { name: 'Period' })).toBeTruthy();
  });
});

describe('le modèle de vue, hors de React', () => {
  const counts = (over: Partial<Record<string, number>> = {}) => ({
    pending: 0,
    confirmed: 0,
    completed: 0,
    cancelled: 0,
    no_show: 0,
    ...over,
  });

  const volume = (rows: AppointmentVolumeReport['rows']): AppointmentVolumeReport => ({
    window: { from: '2026-08-31T21:00:00Z', to: '2026-09-30T21:00:00Z' },
    groupBy: 'staff',
    timeZone: 'Indian/Antananarivo',
    rows,
    total: rows.reduce((sum, row) => sum + row.total, 0),
  });

  const NO_SHOWS: NoShowReport = {
    window: { from: '2026-08-31T21:00:00Z', to: '2026-09-30T21:00:00Z' },
    timeZone: 'Indian/Antananarivo',
    noShows: 1,
    honored: 1,
    cancelled: 8,
    pending: 7,
    total: 17,
    rate: 0.5,
  };

  it('nomme l’établissement entier et les groupes sans libellé dans les deux langues', () => {
    expect(wholeTenant('fr').label).toBe('Tout l’établissement');
    expect(wholeTenant('en').label).toBe('Whole salon');
    // La clé et le genre du filtre, eux, ne bougent pas : ils voyagent dans l'URL.
    expect(wholeTenant('en').kind).toBe(wholeTenant('fr').kind);
    expect(wholeTenant('en').key).toBeNull();

    const orphan = volume([{ key: 'x', label: null, total: 5, byStatus: counts({ completed: 5 }) }]);

    expect(
      volumePoints(wholeTenant('fr'), orphan, { from: '2026-09-01', to: '2026-09-02' }, (d) => d, {
        locale: 'fr',
      })[0]?.label,
    ).toBe('Non attribué');
    expect(
      volumePoints(wholeTenant('en'), orphan, { from: '2026-09-01', to: '2026-09-02' }, (d) => d, {
        locale: 'en',
      })[0]?.label,
    ).toBe('Unassigned');
  });

  it('qualifie la tuile de volume dans les deux langues, sans changer les comptes', () => {
    const activity = scopedActivity(
      wholeTenant('fr'),
      volume([]),
      NO_SHOWS,
      volume([{ key: 'j', label: null, total: 17, byStatus: counts({}) }]),
    );

    expect(volumeQualification(activity, { locale: 'fr' })).toBe('dont 8 annulés · 7 à venir');
    expect(volumeQualification(activity, { locale: 'en' })).toBe(
      'including 8 cancelled · 7 upcoming',
    );
    // Le chiffre, lui, ne dépend d'aucune langue.
    expect(activity.appointments).toBe(17);
  });

  it('met en forme les nombres selon la langue, sans changer leur valeur', () => {
    // `Intl` sépare les milliers français par une espace **fine insécable**
    // (U+202F) ou insécable (U+00A0) selon la version d'ICU : on les ramène à
    // l'espace ordinaire plutôt que de figer l'une des deux.
    expect(formatCount(1_200, { locale: 'fr' }).replace(/[\u202f\u00a0]/g, ' ')).toBe('1 200');
    expect(formatCount(1_200, { locale: 'en' })).toBe('1,200');
    expect(formatRate(0.0328, { locale: 'fr' })).toMatch(/3,3\s*%/);
    expect(formatRate(0.0328, { locale: 'en' })).toMatch(/3\.3%/);
    // Sans dénominateur, les deux langues disent la même chose : rien.
    expect(formatRate(null, { locale: 'en' })).toBe('—');
  });

  it('classe le sélecteur selon la langue, et le graphique avec lui', () => {
    // `localeCompare` range « Élodie » avant « Emma » en français et après en
    // anglais : un sélecteur qui ne suit pas la langue de l'écran se lit de
    // travers.
    const report = volume([
      { key: 'e1', label: 'Émma', total: 10, byStatus: counts({ completed: 10 }) },
      { key: 'e2', label: 'Emmanuelle', total: 10, byStatus: counts({ completed: 10 }) },
    ]);

    expect(filterOptions(report, { locale: 'fr' }).map((option) => option.label)).toEqual([
      'Émma',
      'Emmanuelle',
    ]);
  });

  it('abrège l’axe du jour dans la langue passée par référence', () => {
    // L'écran enveloppe `shortDayLabel` dans une lambda qui referme sur la
    // langue : `volumePoints` n'appelle son argument qu'avec la date.
    const byDay: AppointmentVolumeReport = {
      ...volume([]),
      groupBy: 'day',
      rows: [{ key: '2026-09-03', label: null, total: 2, byStatus: counts({ completed: 2 }) }],
    };
    const points = volumePoints(
      wholeTenant('en'),
      byDay,
      { from: '2026-09-03', to: '2026-09-03' },
      (date) => shortDayLabel(date, { locale: 'en', countryCode: 'GB' }),
      { locale: 'en' },
    );

    expect(points[0]?.label).toBe('3 Sept');
    expect(points[0]?.total).toBe(2);
  });
});
