import { describe, expect, it } from 'vitest';

import {
  etapeFautive,
  formaterEtapeFautive,
  type EtapeExecutee,
} from '@/tests/e2e/support/etape-fautive';

/**
 * Le rapport d'échec du parcours critique — cinquième critère de #80.
 *
 * Ce que ces cas éprouvent est une exigence, pas un détail de mise en forme :
 * « le rapport d'échec identifie l'étape fautive sans ambiguïté ». Les vérifier
 * ici plutôt qu'en observant une exécution E2E rouge est ce qui rend l'exigence
 * tenable — sinon, la seule façon de savoir si le rapport est bon serait de
 * casser le produit.
 */

function etape(
  titre: string,
  options: {
    category?: string;
    erreur?: string;
    enfants?: EtapeExecutee[];
    fichier?: string;
  } = {},
): EtapeExecutee {
  return {
    title: titre,
    category: options.category ?? 'test.step',
    error: options.erreur === undefined ? undefined : { message: options.erreur },
    location:
      options.fichier === undefined
        ? undefined
        : { file: options.fichier, line: 42, column: 7 },
    steps: options.enfants ?? [],
  };
}

describe('etapeFautive', () => {
  it("rend null quand aucune étape n'a échoué", () => {
    expect(etapeFautive([etape('Réserver'), etape('Encaisser')])).toBeNull();
  });

  it('descend jusqu’à la feuille en erreur et rend le chemin des étapes déclarées', () => {
    const arbre = [
      etape('Réserver'),
      etape('Encaisser', {
        erreur: 'échec',
        fichier: 'parcours-critique.e2e.ts',
        enfants: [
          etape('3. Régler en espèces', {
            erreur: 'échec',
            enfants: [
              etape('expect.toBeVisible', {
                category: 'expect',
                erreur: 'Timed out 10000ms waiting for expect(locator).toBeVisible()',
              }),
            ],
          }),
        ],
      }),
    ];

    const fautive = etapeFautive(arbre);

    expect(fautive?.chemin).toEqual(['Encaisser', '3. Régler en espèces']);
    expect(fautive?.titre).toBe('3. Régler en espèces');
    // La feuille n'est pas une étape déclarée : elle est rendue à part, comme
    // « ce qui a matériellement lâché ».
    expect(fautive?.detail).toBe('expect.toBeVisible');
    expect(fautive?.message).toBe(
      'Timed out 10000ms waiting for expect(locator).toBeVisible()',
    );
  });

  it("n'annonce aucun détail quand la feuille est elle-même l'étape déclarée", () => {
    const fautive = etapeFautive([etape('Confirmer', { erreur: 'boum' })]);

    expect(fautive?.titre).toBe('Confirmer');
    expect(fautive?.detail).toBeNull();
  });

  it('ignore la branche saine et ne suit que celle en erreur', () => {
    const fautive = etapeFautive([
      etape('Réserver', { enfants: [etape('1. Vitrine')] }),
      etape('Encaisser', { erreur: 'boum', enfants: [etape('2. Reçu', { erreur: 'boum' })] }),
    ]);

    expect(fautive?.chemin).toEqual(['Encaisser', '2. Reçu']);
  });

  it("retient l'emplacement de l'étape déclarée la plus fine", () => {
    const fautive = etapeFautive([
      etape('Encaisser', {
        erreur: 'boum',
        fichier: 'racine.e2e.ts',
        enfants: [etape('3. Reçu', { erreur: 'boum', fichier: 'feuille.e2e.ts' })],
      }),
    ]);

    expect(fautive?.emplacement).toBe('feuille.e2e.ts:42:7');
  });

  it('débarrasse le message de ses séquences ANSI et ne garde que la première ligne', () => {
    const esc = String.fromCharCode(27);
    const fautive = etapeFautive([
      etape('Encaisser', {
        erreur: `${esc}[31mAssertion rompue${esc}[39m\nCall log:\n  - waiting for locator`,
      }),
    ]);

    expect(fautive?.message).toBe('Assertion rompue');
  });
});

describe('formaterEtapeFautive', () => {
  it("met l'étape fautive en toutes lettres", () => {
    const bloc = formaterEtapeFautive(
      { titres: ['parcours-critique.e2e.ts', 'Parcours critique', 'réserver et encaisser'] },
      etapeFautive([
        etape('Encaisser', {
          erreur: 'boum',
          enfants: [etape('3. Reçu', { erreur: 'boum', fichier: 'a.e2e.ts' })],
        }),
      ]),
    );

    expect(bloc).toContain('ÉTAPE FAUTIVE : 3. Reçu');
    expect(bloc).toContain('↳ dans : Encaisser');
    expect(bloc).toContain('parcours-critique.e2e.ts › Parcours critique › réserver et encaisser');
    expect(bloc).toContain('fichier : a.e2e.ts:42:7');
  });

  it("dit explicitement quand l'échec n'a atteint aucune étape", () => {
    const bloc = formaterEtapeFautive(
      { titres: ['suite', 'un test'], message: 'Test timeout of 90000ms exceeded.' },
      null,
    );

    expect(bloc).toContain('ÉTAPE FAUTIVE : aucune');
    expect(bloc).toContain('Test timeout of 90000ms exceeded.');
  });

  it('signale les artefacts à ouvrir', () => {
    const bloc = formaterEtapeFautive(
      { titres: ['suite'], artefacts: ['trace', 'screenshot'] },
      null,
    );

    expect(bloc).toContain('artefacts : trace, screenshot');
  });
});
