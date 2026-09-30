import type { Locale } from '@spa/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { loadMessages } from '@/i18n/messages';
import { elisionForm } from '@/lib/elision';

/**
 * L'élision française, telle que le catalogue la reçoit — #1329.
 *
 * Le planning annonçait « Ouvrir la fiche de Alice ». Le mot juste est
 * « d'Alice », et aucun `select` d'ICU ne peut le décider seul : `{client}` est un
 * trou, et rien dans le message ne voit ce qui s'y pose. La règle est donc
 * calculée ici, puis passée en argument — et c'est le catalogue **français** qui
 * sait qu'elle veut dire quelque chose, l'anglais portant deux branches
 * identiques pour la parité des paramètres ICU.
 *
 * Ce que ces assertions tiennent, c'est que la fonction reste **neutre** : elle
 * rend deux étiquettes, `vowel` et `consonant`, et pas un morceau de français.
 */
describe('la forme d’élision d’un nom', () => {
  it('reconnaît une voyelle initiale, accentuée ou non', () => {
    for (const nom of ['Alice', 'Émile', 'Ophélie', 'Ève', 'Inès', 'Oscar', 'Ulysse', 'Àna']) {
      expect(elisionForm(nom), nom).toBe('vowel');
    }
  });

  it('compte `y` parmi les voyelles — « d’Yvon »', () => {
    expect(elisionForm('Yvon')).toBe('vowel');
  });

  it('rend la forme pleine devant une consonne', () => {
    for (const nom of ['Rina', 'Fara', 'Hasina', 'Zoé', 'Ranaivo']) {
      expect(elisionForm(nom), nom).toBe('consonant');
    }
  });

  it('ne cherche pas à deviner un h muet', () => {
    // « d'Hélène » et « de Hugo » se distinguent par l'oreille, pas par leurs
    // lettres. Devant un h, la forme pleine reste rendue : lourde, jamais fausse.
    expect(elisionForm('Hélène')).toBe('consonant');
    expect(elisionForm('Hugo')).toBe('consonant');
  });

  it('ignore l’espace de tête, et supporte un nom vide', () => {
    expect(elisionForm('  Alice')).toBe('vowel');
    // Rien à élider quand il n'y a rien à nommer : la forme pleine reste lisible.
    expect(elisionForm('')).toBe('consonant');
    expect(elisionForm('   ')).toBe('consonant');
  });

  it('juge sur la première lettre du prénom, pas du nom complet', () => {
    // C'est bien le mot qui suit « de » qui décide, et l'appelant passe le libellé
    // entier — « Alice Martin » comme « Alice M. ».
    expect(elisionForm('Alice Martin')).toBe('vowel');
    expect(elisionForm('Martin Alice')).toBe('consonant');
  });

  it('ne rend jamais de français — deux étiquettes, et rien d’autre', () => {
    // C'est ce qui permet au catalogue anglais d'ignorer l'argument sans que la
    // fonction ait à connaître la langue de l'écran.
    for (const nom of ['Alice', 'Rina', '', '9 rue', '—']) {
      expect(['vowel', 'consonant']).toContain(elisionForm(nom));
    }
  });
});

/** Un traducteur de namespace, sur les **vrais** catalogues du dépôt. */
function traducteur(
  locale: Locale,
  namespace: string,
): (key: string, values?: Record<string, unknown>) => string {
  // `createTranslator` est typé sur le catalogue complet ; l'appeler avec une clé
  // calculée demande de relâcher ce typage, comme le font les autres suites de
  // l'épique. Le formatage, lui, reste celui de la bibliothèque.
  const make = createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace: string;
  }) => (key: string, values?: Record<string, unknown>) => string;

  return make({ locale, messages: loadMessages(locale), namespace });
}

/** Le traducteur du planning. */
function planning(locale: Locale): (key: string, values?: Record<string, unknown>) => string {
  return traducteur(locale, 'admin-planning');
}

/**
 * Le tour complet — la fonction, l'argument, le message.
 *
 * Les assertions au-dessus ne disent rien de ce que le catalogue **fait** de
 * l'étiquette. Celles-ci passent par le formateur ICU de `next-intl` sur les
 * vrais fichiers : c'est la seule façon de prouver que le `select` est bien écrit,
 * que l'anglais ignore l'argument sans broncher, et qu'une branche ne perd pas
 * son espace de tête.
 */
describe('les deux noms accessibles du planning qui élident (#1329)', () => {
  const ALICE = { client: 'Alice Martin', elision: elisionForm('Alice Martin') };
  const RINA = { client: 'Rina Andriamana', elision: elisionForm('Rina Andriamana') };

  it('élide devant une voyelle, en français', () => {
    expect(planning('fr')('grid.openRecord', { ...ALICE, time: '09:00' })).toBe(
      'Ouvrir la fiche d’Alice Martin, 09:00',
    );
    expect(planning('fr')('grid.dropHint', ALICE)).toBe(
      ' — déplacer ici le rendez-vous d’Alice Martin',
    );
  });

  it('garde la forme pleine devant une consonne', () => {
    expect(planning('fr')('grid.openRecord', { ...RINA, time: '09:00' })).toBe(
      'Ouvrir la fiche de Rina Andriamana, 09:00',
    );
    expect(planning('fr')('grid.dropHint', RINA)).toBe(
      ' — déplacer ici le rendez-vous de Rina Andriamana',
    );
  });

  it('rend la même phrase en anglais, quelle que soit l’étiquette', () => {
    // L'anglais porte le `select` pour la parité des paramètres
    // (`messages-parity.test.ts`), branches identiques : il n'élide rien, et rien
    // ne doit dépendre de l'argument.
    for (const qui of [ALICE, RINA]) {
      expect(planning('en')('grid.openRecord', { ...qui, time: '09:00' })).toBe(
        `Open ${qui.client}’s appointment, 09:00`,
      );
      expect(planning('en')('grid.dropHint', qui)).toBe(
        ` — move ${qui.client}’s appointment here`,
      );
    }
  });
});

/**
 * Les trois autres phrases qui reçoivent un nom de client après « de ».
 *
 * Elles vivent sur le même geste que les deux au-dessus — la confirmation du
 * changement de praticien, l'avis de remise en place, et le titre de la fiche
 * cliente —, et les oublier laissait « Le rendez-vous de Alice » dans la boîte de
 * dialogue qui suit exactement le glissement dont l'infobulle, elle, était
 * corrigée.
 */
describe('les autres phrases qui nomment une cliente après « de » (#1329)', () => {
  const clients = (locale: Locale) => traducteur(locale, 'admin-clients');
  const MOMENT = { from: 'Rina', to: 'Fara', moment: 'mercredi à 15:00', staff: 'Fara' };

  it('élide dans la confirmation de changement de praticien', () => {
    const question = planning('fr')('move.question', {
      client: 'Alice Martin',
      elision: elisionForm('Alice Martin'),
      ...MOMENT,
    });

    expect(question).toContain('rendez-vous d’Alice Martin');
    expect(question).not.toContain('de Alice');
  });

  it('élide dans l’avis de remise en place', () => {
    const restored = planning('fr')('move.restored', {
      client: 'Alice Martin',
      elision: elisionForm('Alice Martin'),
      ...MOMENT,
    });

    expect(restored).toContain('rendez-vous d’Alice Martin');
    expect(restored).not.toContain('de Alice');
  });

  it('élide dans le titre de la fiche cliente', () => {
    expect(
      clients('fr')('record.heading', {
        name: 'Alice Martin',
        elision: elisionForm('Alice Martin'),
      }),
    ).toBe('Fiche d’Alice Martin');
    expect(
      clients('fr')('record.heading', { name: 'Rina Andriamana', elision: elisionForm('Rina') }),
    ).toBe('Fiche de Rina Andriamana');
  });

  it('rend la même phrase en anglais, quelle que soit l’étiquette', () => {
    for (const forme of ['vowel', 'consonant']) {
      expect(clients('en')('record.heading', { name: 'Alice Martin', elision: forme })).toBe(
        'Alice Martin’s record',
      );
      expect(
        planning('en')('move.restored', { client: 'Alice Martin', elision: forme, ...MOMENT }),
      ).toContain('Alice Martin’s appointment stayed');
    }
  });
});
