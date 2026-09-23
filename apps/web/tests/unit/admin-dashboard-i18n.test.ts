import type { Locale } from '@spa/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { loadMessages } from '@/i18n/messages';
import { formatCount, formatRate } from '@/lib/admin/reporting-view';
import { formatCalendarDate, formatMoney, formatTimeInTimeZone } from '@/lib/format';

/**
 * Le tableau de bord du back-office en français et en anglais — #1104.
 *
 * ## Ce que cette suite protège, et pourquoi c'est ici que ça se prouve
 *
 * Le tableau de bord est un Server Component qui lit six routes : le monter dans
 * une suite unitaire n'éprouverait que des doublures de `fetch`. Ce qui se
 * trompe, en revanche, tient entièrement hors du composant :
 *
 * 1. **Les accords de nombre**, portés par des formes plurielles ICU du
 *    catalogue et non par un `s` ajouté en JavaScript. « 1 encaissement » et
 *    « 1 payment » ne se pluralisent pas aux mêmes seuils, et le code d'avant le
 *    ticket écrivait `transactions > 1 ? 's' : ''` — une règle française déguisée
 *    en code. Un message qui perdrait sa branche `one` ne se verrait qu'à
 *    l'écran, un jour où le salon n'aurait eu qu'un rendez-vous.
 * 2. **La mise en forme des nombres suit la langue et la région de
 *    l'établissement**, pas celle du serveur : « 1 200 » d'un côté, « 1,200 » de
 *    l'autre. C'est le deuxième critère d'acceptation du ticket.
 * 3. **La langue ne déplace aucune heure.** Le fuseau reste celui du salon — un
 *    rendez-vous mal fuseau-horairé est un bug de sévérité haute (`CLAUDE.md`).
 *
 * Les messages sont lus par le **vrai** formateur ICU de `next-intl`, sur les
 * **vrais** catalogues du dépôt : une clé absente ou une substitution perdue
 * échoue ici comme elle échouerait en production.
 */

/** Le traducteur du namespace du tableau de bord, dans la langue demandée. */
function dashboard(locale: Locale): (key: string, values?: Record<string, unknown>) => string {
  // `createTranslator` est typé sur le catalogue complet ; l'appeler avec une
  // clé calculée demande de relâcher ce typage, comme le font les autres suites
  // de l'épique. Le formatage, lui, reste celui de la bibliothèque.
  const make = createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace: string;
  }) => (key: string, values?: Record<string, unknown>) => string;

  return make({ locale, messages: loadMessages(locale), namespace: 'admin-dashboard' });
}

/** Un salon parisien et un salon new-yorkais — deux langues, deux régions. */
const PARIS = { locale: 'fr', countryCode: 'FR' } as const;
const NEW_YORK = { locale: 'en', countryCode: 'US' } as const;

/** UTC+3 : le fuseau du salon de référence, celui d'Antananarivo. */
const TIME_ZONE = 'Indian/Antananarivo';

describe('la salutation et l’amorce du jour', () => {
  it('nomme la gérante quand le profil la donne, et se passe d’elle sinon', () => {
    expect(dashboard('fr')('hero.greeting')).toBe('Bonjour');
    expect(dashboard('fr')('hero.greetingNamed', { firstName: 'Hanta' })).toBe('Bonjour Hanta');
    expect(dashboard('en')('hero.greeting')).toBe('Hello');
    expect(dashboard('en')('hero.greetingNamed', { firstName: 'Hanta' })).toBe('Hello Hanta');
  });

  it('dit la journée vide sans détour, dans les deux langues', () => {
    // C'est le troisième critère d'acceptation : un état vide se traduit comme le
    // reste. La branche `=0` du message le porte — aucun `if` de la page ne le
    // décide.
    expect(dashboard('fr')('hero.lead', { count: 0, salon: 'Maison Lotus' })).toBe(
      'Aucun rendez-vous au programme de Maison Lotus aujourd’hui.',
    );
    expect(dashboard('en')('hero.lead', { count: 0, salon: 'Maison Lotus' })).toBe(
      'No appointments on the books at Maison Lotus today.',
    );
  });

  it('accorde le compte de rendez-vous à sa langue, au singulier comme au pluriel', () => {
    // « rendez-vous » est invariable, « appointment » ne l'est pas : la branche
    // `one` de l'anglais est exactement ce qu'un `s` ajouté en JavaScript aurait
    // manqué.
    expect(dashboard('fr')('hero.lead', { count: 1, salon: 'Maison Lotus' })).toBe(
      '1 rendez-vous au programme de Maison Lotus aujourd’hui.',
    );
    expect(dashboard('en')('hero.lead', { count: 1, salon: 'Maison Lotus' })).toBe(
      '1 appointment on the books at Maison Lotus today.',
    );
    expect(dashboard('fr')('hero.lead', { count: 3, salon: 'Maison Lotus' })).toBe(
      '3 rendez-vous au programme de Maison Lotus aujourd’hui.',
    );
    expect(dashboard('en')('hero.lead', { count: 3, salon: 'Maison Lotus' })).toBe(
      '3 appointments on the books at Maison Lotus today.',
    );
  });

  it('annonce ce qui reste à confirmer sans mêler les deux langues', () => {
    expect(
      dashboard('fr')('hero.leadPending', { count: 3, pending: '1', salon: 'Maison Lotus' }),
    ).toBe('3 rendez-vous au programme de Maison Lotus aujourd’hui, dont 1 à confirmer.');
    expect(
      dashboard('en')('hero.leadPending', { count: 3, pending: '1', salon: 'Maison Lotus' }),
    ).toBe('3 appointments on the books at Maison Lotus today, including 1 to confirm.');
  });
});

describe('les indicateurs du jour', () => {
  it('accorde « honoré » au compte, et laisse « à venir » invariable', () => {
    expect(dashboard('fr')('kpi.appointments.detail', { done: 1, upcoming: '2' })).toBe(
      '1 honoré · 2 à venir',
    );
    expect(dashboard('fr')('kpi.appointments.detail', { done: 2, upcoming: '2' })).toBe(
      '2 honorés · 2 à venir',
    );
    expect(dashboard('en')('kpi.appointments.detail', { done: 1, upcoming: '2' })).toBe(
      '1 completed · 2 still to come',
    );
  });

  it('accorde le compte d’encaissements, et dit l’absence d’encaissement', () => {
    expect(dashboard('fr')('kpi.revenue.detail', { count: 1 })).toBe('1 encaissement');
    expect(dashboard('fr')('kpi.revenue.detail', { count: 3 })).toBe('3 encaissements');
    expect(dashboard('en')('kpi.revenue.detail', { count: 1 })).toBe('1 payment');
    expect(dashboard('en')('kpi.revenue.detail', { count: 3 })).toBe('3 payments');
    expect(dashboard('fr')('kpi.revenue.detailEmpty')).toBe('Aucun encaissement pour l’instant');
    expect(dashboard('en')('kpi.revenue.detailEmpty')).toBe('No payment taken yet');
  });

  it('dit le dénominateur du taux de non-présentation dans les deux langues', () => {
    expect(dashboard('fr')('kpi.noShow.detail', { noShows: '2', total: 30 })).toBe(
      '2 sur 30 rendez-vous échus',
    );
    expect(dashboard('en')('kpi.noShow.detail', { noShows: '2', total: 30 })).toBe(
      '2 of 30 appointments past their time',
    );
  });

  it('accorde le dénominateur quand un seul rendez-vous est échu', () => {
    // Le nom suit le nombre : « 1 sur 1 rendez-vous échus » était un accord faux,
    // et « 1 of 1 appointments » un anglais faux — c'est exactement ce qu'un
    // paramètre pré-formaté ne peut pas porter.
    expect(dashboard('fr')('kpi.noShow.detail', { noShows: '1', total: 1 })).toBe(
      '1 sur 1 rendez-vous échu',
    );
    expect(dashboard('en')('kpi.noShow.detail', { noShows: '1', total: 1 })).toBe(
      '1 of 1 appointment past its time',
    );
  });
});

describe('les chiffres suivent la langue et la région de l’établissement', () => {
  it('groupe les milliers à la façon du pays du salon', () => {
    // La valeur ne change pas, seule son écriture : c'est la même règle que celle
    // des montants (`lib/format.ts`).
    expect(formatCount(1200, PARIS)).toMatch(/^1\s200$/u);
    expect(formatCount(1200, NEW_YORK)).toBe('1,200');
  });

  it('écrit le taux avec le séparateur décimal de la langue', () => {
    expect(formatRate(0.0335, PARIS)).toMatch(/^3,4\s?%$/u);
    expect(formatRate(0.0335, NEW_YORK)).toBe('3.4%');
  });

  it('garde le tiret cadratin faute de dénominateur, dans les deux langues', () => {
    // Un tiret n'est pas un mot : il n'a pas à être traduit, et une valeur
    // inventée serait pire qu'une absence assumée.
    expect(formatRate(null, PARIS)).toBe('—');
    expect(formatRate(null, NEW_YORK)).toBe('—');
  });

  it('retombe sur le français quand l’appelant ne dit pas encore sa langue', () => {
    // Le défaut transitoire de l'épique #843 : l'écran de reporting (#851) n'a pas
    // encore été branché, et son affichage ne doit pas basculer avant son ticket.
    expect(formatCount(1200)).toMatch(/^1\s200$/u);
  });

  it('écrit le montant dans la langue, sans jamais en changer la valeur', () => {
    const amount = { amountMinor: 3500, currency: 'EUR' };

    expect(formatMoney(amount, PARIS)).toMatch(/^35,00\s?€$/u);
    expect(formatMoney(amount, NEW_YORK)).toBe('€35.00');
  });
});

describe('la langue ne déplace ni la journée ni l’heure', () => {
  it('garde l’heure du salon quelle que soit la langue', () => {
    // 08:00 UTC = 11:00 au salon. La langue change la notation, jamais l'instant.
    const instant = '2026-08-26T08:00:00.000Z';

    expect(formatTimeInTimeZone(instant, TIME_ZONE, PARIS)).toBe('11:00');
    expect(formatTimeInTimeZone(instant, TIME_ZONE, NEW_YORK)).toMatch(/11:00/u);
  });

  it('nomme la journée en toutes lettres dans les deux langues', () => {
    expect(formatCalendarDate('2026-08-26', PARIS)).toBe('mercredi 26 août 2026');
    expect(formatCalendarDate('2026-08-26', NEW_YORK)).toBe('Wednesday, August 26, 2026');
  });

  it('décrit une barre de la semaine pour le lecteur d’écran, dans la langue', () => {
    expect(
      dashboard('fr')('week.barDescription', { count: 2, date: 'mercredi 26 août 2026' }),
    ).toBe(' : 2 rendez-vous le mercredi 26 août 2026');
    expect(
      dashboard('en')('week.barDescription', { count: 2, date: 'Wednesday, August 26, 2026' }),
    ).toBe(': 2 appointments on Wednesday, August 26, 2026');
    expect(
      dashboard('en')('week.barDescription', { count: 1, date: 'Wednesday, August 26, 2026' }),
    ).toBe(': 1 appointment on Wednesday, August 26, 2026');
  });

  it('accorde le compte de la semaine écoulée', () => {
    expect(dashboard('fr')('week.caption', { count: 12 })).toBe('encaissés · 12 rendez-vous');
    expect(dashboard('en')('week.caption', { count: 12 })).toBe('taken · 12 appointments');
    expect(dashboard('en')('week.caption', { count: 1 })).toBe('taken · 1 appointment');
  });
});

describe('les états vides et les sorties du tableau de bord', () => {
  it('dit une journée terminée et ce qu’on peut faire ensuite', () => {
    expect(dashboard('fr')('upcoming.emptyTitle')).toBe('Plus rien au programme aujourd’hui');
    expect(dashboard('en')('upcoming.emptyTitle')).toBe('Nothing left on today’s books');
    expect(dashboard('fr')('upcoming.more')).toBe('Tout le planning');
    expect(dashboard('en')('upcoming.more')).toBe('The whole schedule');
  });

  it('traduit les raccourcis du premier jour du salon, et la mention du nouvel onglet', () => {
    // Le raccourci vers la vitrine ouvre un onglet : la mention est lue par un
    // lecteur d'écran, elle se traduit donc comme le libellé qu'elle suit.
    expect(dashboard('fr')('shortcuts.newService')).toBe('Nouvelle prestation');
    expect(dashboard('en')('shortcuts.newService')).toBe('New service');
    expect(dashboard('fr')('shortcuts.newTab')).toBe(' (nouvel onglet)');
    expect(dashboard('en')('shortcuts.newTab')).toBe(' (new tab)');
  });

  it('traduit le titre d’onglet et les refus d’accès de l’écran', () => {
    expect(dashboard('fr')('metadata.title')).toBe('Tableau de bord');
    expect(dashboard('en')('metadata.title')).toBe('Dashboard');
    expect(dashboard('fr')('denied.failedTitle')).toBe('Tableau de bord indisponible');
    expect(dashboard('en')('denied.failedTitle')).toBe('Dashboard unavailable');
  });
});
