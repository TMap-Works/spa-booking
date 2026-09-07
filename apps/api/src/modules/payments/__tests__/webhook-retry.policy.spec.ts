import {
  DEFAULT_RETRY_SCHEDULE,
  DEFAULT_SWEEP_SCHEDULE,
  hasAttemptsLeft,
  retryDelayMs,
  type RetrySchedule,
} from '../webhook-retry.policy';

/**
 * La politique de réessai — de l'arithmétique, et rien d'autre (#409).
 *
 * C'est précisément pour pouvoir l'éprouver ainsi qu'elle a été sortie de la
 * file : sans minuteur, sans promesse et sans double. Ce qui est vérifié ici
 * est ce qu'un lecteur du calendrier de production doit pouvoir tenir pour vrai
 * — la borne est franchie au cran annoncé, le délai double puis plafonne, et la
 * gigue ne rend jamais un délai plus court que la moitié du nominal.
 */

const SCHEDULE: RetrySchedule = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 };

describe('hasAttemptsLeft', () => {
  it('laisse réessayer tant que la borne n’est pas atteinte', () => {
    expect(hasAttemptsLeft(1, SCHEDULE)).toBe(true);
    expect(hasAttemptsLeft(3, SCHEDULE)).toBe(true);
  });

  it('arrête au cran annoncé, pas un de plus', () => {
    // Le décalage d'un cran est l'erreur classique de ce genre de borne : elle
    // offrirait une tentative de plus que le calendrier n'en annonce, et la
    // durée d'attente maximale ne serait plus celle qu'on croit.
    expect(hasAttemptsLeft(SCHEDULE.maxAttempts, SCHEDULE)).toBe(false);
    expect(hasAttemptsLeft(SCHEDULE.maxAttempts + 1, SCHEDULE)).toBe(false);
  });

  it('désactive le réessai quand une seule tentative est prévue', () => {
    // La valeur qu'emploie une suite qui veut observer la file d'attente morte
    // tout de suite.
    expect(hasAttemptsLeft(1, { ...SCHEDULE, maxAttempts: 1 })).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('attend le délai de base après la première tentative', () => {
    // `attempt - 1` dans l'exposant : la première attend le nominal, pas son
    // double.
    expect(retryDelayMs(1, SCHEDULE, () => 1)).toBe(500);
  });

  it('double le nominal à chaque échec suivant', () => {
    expect(retryDelayMs(2, SCHEDULE, () => 1)).toBe(1_000);
    expect(retryDelayMs(3, SCHEDULE, () => 1)).toBe(2_000);
  });

  it('cesse de doubler au plafond', () => {
    // Sans plafond, la dixième tentative attendrait des heures — et la file
    // retiendrait le processus d'autant.
    expect(retryDelayMs(20, SCHEDULE, () => 1)).toBe(SCHEDULE.maxDelayMs);
  });

  it('ne rend jamais moins que la moitié du nominal', () => {
    // La gigue « égale » : moitié fixe, moitié tirée. Elle étale la reprise
    // d'une panne partagée sans jamais rendre un délai dégénéré — un tirage à
    // zéro attend tout de même la moitié.
    expect(retryDelayMs(1, SCHEDULE, () => 0)).toBe(250);
    expect(retryDelayMs(2, SCHEDULE, () => 0)).toBe(500);
  });

  it('tient l’intervalle de la gigue quel que soit le tirage', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const nominal = Math.min(SCHEDULE.baseDelayMs * 2 ** (attempt - 1), SCHEDULE.maxDelayMs);
      const delay = retryDelayMs(attempt, SCHEDULE);

      expect(delay).toBeGreaterThanOrEqual(nominal / 2);
      expect(delay).toBeLessThanOrEqual(nominal);
    }
  });
});

describe('calendriers de production', () => {
  it('borne l’attente cumulée à ce qu’un arrêt de conteneur absorbe', () => {
    // Quatre tentatives, trois attentes : 500 + 1000 + 2000 au pire. Le chiffre
    // n'est pas choisi pour lui-même — c'est ce que le délai de grâce d'un
    // `SIGTERM` d'ECS doit pouvoir absorber sans que le déploiement ne traîne.
    let worst = 0;
    for (let attempt = 1; hasAttemptsLeft(attempt, DEFAULT_RETRY_SCHEDULE); attempt += 1) {
      worst += retryDelayMs(attempt, DEFAULT_RETRY_SCHEDULE, () => 1);
    }

    expect(worst).toBe(3_500);
  });

  it('laisse deux ordres de grandeur entre le bail et les réessais', () => {
    // Un bail trop court ferait reprendre une livraison encore en cours par une
    // autre instance, et les deux tentatives partiraient de front.
    expect(DEFAULT_SWEEP_SCHEDULE.leaseMs).toBeGreaterThan(10 * 3_500);
    expect(DEFAULT_SWEEP_SCHEDULE.intervalMs).toBeLessThan(DEFAULT_SWEEP_SCHEDULE.leaseMs);
    expect(DEFAULT_SWEEP_SCHEDULE.batchSize).toBeGreaterThan(0);
  });
});
