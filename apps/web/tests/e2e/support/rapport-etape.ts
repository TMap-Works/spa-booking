/**
 * Le rapporteur qui met l'étape fautive en tête du journal — #80, cinquième
 * critère.
 *
 * Il ne remplace pas les rapporteurs de Playwright : il s'ajoute à `list` et
 * `html`, et n'écrit que sur les tests en échec. Toute la logique utile vit dans
 * `etape-fautive.ts`, éprouvée par le harnais unitaire ; ce fichier n'est que la
 * jonction avec l'API des rapporteurs.
 */

import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { etapeFautive, formaterEtapeFautive, type EtapeExecutee } from './etape-fautive';

/**
 * `TestStep` de Playwright vers le type structurel du module pur.
 *
 * Recopié champ à champ plutôt que transtypé : `TestStep` porte des références
 * circulaires (`parent`) et un `error` de type `TestError`, dont seul le
 * `message` nous intéresse. La conversion documente ce qui est réellement lu.
 */
function convertir(etapes: TestResult['steps']): EtapeExecutee[] {
  return etapes.map((etape) => ({
    title: etape.title,
    category: etape.category,
    error: etape.error === undefined ? undefined : { message: etape.error.message },
    location:
      etape.location === undefined
        ? undefined
        : { file: etape.location.file, line: etape.location.line, column: etape.location.column },
    steps: convertir(etape.steps),
  }));
}

export default class RapportEtapeFautive implements Reporter {
  /**
   * Les échecs sont accumulés et rendus à la fin, non au fil de l'eau.
   *
   * En parallèle, une sortie au fil de l'eau s'entrelace avec celle de `list` et
   * le bloc — dont toute la valeur est d'être lisible d'un coup d'œil — se
   * retrouve coupé en deux par la ligne d'un autre test.
   */
  private readonly echecs: string[] = [];

  public onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' || result.status === 'skipped') {
      return;
    }

    // Une nouvelle tentative qui finira par passer n'est pas un échec du
    // parcours : ne rapporter que la dernière.
    //
    // La condition ne regarde **pas** le statut. La restreindre à `'failed'`
    // laissait passer les tentatives `'timedOut'` — c'est-à-dire le mode de
    // panne le plus probable d'une suite dont le budget est de 180 s —, et le
    // bloc « ÉCHEC » s'imprimait alors sous une exécution qui finissait verte.
    // Un rapport qui crie à l'échec d'un parcours qui a fini par passer est le
    // seul défaut qui ruine sa propre raison d'être.
    if (result.retry < test.retries) {
      return;
    }

    const artefacts = result.attachments
      .filter((piece) => piece.path !== undefined)
      .map((piece) => piece.name);

    this.echecs.push(
      formaterEtapeFautive(
        {
          titres: test.titlePath().filter((titre) => titre !== ''),
          message: result.error?.message,
          artefacts,
        },
        etapeFautive(convertir(result.steps)),
      ),
    );
  }

  public onEnd(): void {
    if (this.echecs.length === 0) {
      return;
    }
    process.stdout.write(`\n${this.echecs.join('\n')}\n`);
  }

  /** Ce rapporteur n'affiche rien pendant l'exécution : `list` s'en charge. */
  public printsToStdio(): boolean {
    return false;
  }
}
