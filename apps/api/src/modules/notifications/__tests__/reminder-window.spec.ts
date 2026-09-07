import {
  REMINDER_LEAD_MS,
  REMINDER_MAX_LEAD_MS,
  REMINDER_WINDOW_MS,
  reminderTiming,
  reminderWindow,
} from '../reminder-window';

/**
 * La règle horaire du rappel J-1 — #71.
 *
 * Quatre des cinq critères d'acceptation se décident dans `reminder-window.ts`,
 * et se prouvent donc ici : la fenêtre `now+24h → now+25h` en UTC, l'exclusion
 * d'un rendez-vous pris à moins de 24 h, l'interdiction du rappel « en retard »,
 * et le refus d'un rendez-vous repoussé hors fenêtre.
 *
 * Aucune horloge simulée : les fonctions prennent `now` en paramètre, ce qui
 * rend chaque cas explicite plutôt que suspendu à `jest.useFakeTimers`.
 */

const MINUTE_MS = 60_000;

/** Un instant de référence quelconque, mais **fixe** — et en UTC. */
const NOW = new Date('2026-09-07T09:00:00.000Z');

/** Le début de rendez-vous situé `lead` millisecondes après `NOW`. */
function startsAt(lead: number): Date {
  return new Date(NOW.getTime() + lead);
}

describe('reminderWindow — la fenêtre de sélection', () => {
  it('sélectionne entre now+24h et now+25h', () => {
    const window = reminderWindow(NOW);

    expect(window.from.toISOString()).toBe('2026-09-08T09:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-09-08T10:00:00.000Z');
  });

  it('a la largeur de la période de balayage — sans trou ni recouvrement', () => {
    const window = reminderWindow(NOW);

    expect(window.to.getTime() - window.from.getTime()).toBe(REMINDER_WINDOW_MS);

    // La fenêtre du balayage suivant reprend **exactement** là où celle-ci
    // s'arrête : c'est ce qui garantit qu'aucun rendez-vous n'échappe au rappel,
    // et qu'aucun n'est sélectionné deux fois.
    const next = reminderWindow(new Date(NOW.getTime() + REMINDER_WINDOW_MS));
    expect(next.from.getTime()).toBe(window.to.getTime());
  });

  it('ne dépend d’aucun calendrier local — le décalage est un nombre de millisecondes', () => {
    // La nuit du changement d'heure en Europe : le 25 octobre 2026 dure 25
    // heures à Paris. « Dans 24 heures » doit rester 24 heures.
    const dstNight = new Date('2026-10-24T23:30:00.000Z');
    const window = reminderWindow(dstNight);

    expect(window.from.getTime() - dstNight.getTime()).toBe(REMINDER_LEAD_MS);
    expect(window.to.getTime() - dstNight.getTime()).toBe(REMINDER_MAX_LEAD_MS);
  });
});

describe('reminderWindow — un rendez-vous pris à moins de 24 h n’y entre jamais', () => {
  /**
   * Le deuxième critère d'acceptation. Il ne demande **aucune règle
   * supplémentaire** : l'écart entre l'instant présent et le début du
   * rendez-vous ne fait que décroître, et il est déjà sous la borne basse.
   */
  it.each([
    ['dans 12 heures', 12 * 60 * MINUTE_MS],
    ['dans 23 h 59', REMINDER_LEAD_MS - MINUTE_MS],
    ['dans une minute', MINUTE_MS],
  ])('%s : hors de la fenêtre courante et de toutes les suivantes', (_label, lead) => {
    const appointment = startsAt(lead);

    // Aucun balayage à venir ne le rattrape : on éprouve les vingt-quatre
    // heures qui suivent, heure par heure.
    for (let hour = 0; hour <= 24; hour += 1) {
      const window = reminderWindow(new Date(NOW.getTime() + hour * REMINDER_WINDOW_MS));
      const selected = appointment >= window.from && appointment < window.to;

      expect(selected).toBe(false);
    }
  });

  it('un rendez-vous à 24 h pile est sélectionné, lui', () => {
    const window = reminderWindow(NOW);
    const appointment = startsAt(REMINDER_LEAD_MS);

    expect(appointment >= window.from && appointment < window.to).toBe(true);
  });

  it('la borne haute est exclue — elle appartient au balayage suivant', () => {
    const window = reminderWindow(NOW);
    const appointment = startsAt(REMINDER_MAX_LEAD_MS);

    expect(appointment >= window.from && appointment < window.to).toBe(false);
    expect(reminderTiming(appointment, NOW)).toBe('due');
  });
});

describe('reminderTiming — la revérification au moment de l’envoi', () => {
  it.each([
    ['au bas de la fenêtre', REMINDER_LEAD_MS],
    ['au milieu', REMINDER_LEAD_MS + REMINDER_WINDOW_MS / 2],
    ['au sommet', REMINDER_MAX_LEAD_MS],
    ['avec la tolérance d’une période de balayage', REMINDER_LEAD_MS - REMINDER_WINDOW_MS],
  ])('%s : le rappel part', (_label, lead) => {
    expect(reminderTiming(startsAt(lead), NOW)).toBe('due');
  });

  /**
   * Le quatrième critère d'acceptation : « aucun rappel envoyé en retard ».
   *
   * La tolérance vaut une période de balayage — au-delà, le message est celui
   * d'un balayage qu'on n'aurait pas dû rejouer, et un rappel qui annonce J-1
   * alors qu'il ne reste que quelques heures ne réduit aucun no-show.
   */
  it.each([
    ['une minute au-delà de la tolérance', REMINDER_LEAD_MS - REMINDER_WINDOW_MS - MINUTE_MS],
    ['douze heures avant', 12 * 60 * MINUTE_MS],
    ['une minute avant', MINUTE_MS],
    ['le rendez-vous a déjà commencé', -MINUTE_MS],
  ])('%s : le rappel ne part pas', (_label, lead) => {
    expect(reminderTiming(startsAt(lead), NOW)).toBe('late');
  });

  it('un rendez-vous repoussé au-delà de la fenêtre attend son propre balayage', () => {
    expect(reminderTiming(startsAt(REMINDER_MAX_LEAD_MS + MINUTE_MS), NOW)).toBe(
      'ahead-of-window',
    );
    expect(reminderTiming(startsAt(3 * REMINDER_LEAD_MS), NOW)).toBe('ahead-of-window');
  });

  it('tout ce que la fenêtre sélectionne est encore dû à l’instant du balayage', () => {
    // La cohérence des deux bouts de la chaîne : ce que `reminderWindow`
    // retient, `reminderTiming` doit l'accepter — sans quoi le balayage
    // publierait des messages que l'envoi refuserait aussitôt.
    const window = reminderWindow(NOW);

    for (let offset = 0; offset < REMINDER_WINDOW_MS; offset += 5 * MINUTE_MS) {
      const appointment = new Date(window.from.getTime() + offset);
      expect(reminderTiming(appointment, NOW)).toBe('due');
    }
  });
});
