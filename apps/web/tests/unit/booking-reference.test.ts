/**
 * La référence courte d'un rendez-vous — `RDV-XXXX-NN` (#736).
 *
 * L'écran de confirmation rendait l'identifiant tel quel :
 * `8425dc59-e63d-4ff5-b679-5714157cb046`. Ce que la suite tient, c'est ce sur
 * quoi une preuve de réservation repose — sa **forme**, sa **stabilité** et le
 * fait qu'elle se **recopie** sans ambiguïté.
 */

import { describe, expect, it } from 'vitest';

import { appointmentReference } from '@/lib/booking/reference';

/** La forme que le wireframe — Étape 6 — écrit : « Réf. RDV-8F3K-27 ». */
const SHAPE = /^RDV-[0-9A-Z]{4}-[0-9]{2}$/;

/** Un UUID v4 déterministe, forgé à partir d'un compteur. */
function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');

  return `00000000-0000-4000-8000-${hex}`;
}

describe('la forme de la référence', () => {
  it('rend `RDV-XXXX-NN`, comme le wireframe l’écrit', () => {
    expect(appointmentReference('8425dc59-e63d-4ff5-b679-5714157cb046')).toMatch(SHAPE);
  });

  it('tient en onze caractères, contre les trente-six de l’identifiant', () => {
    // C'est le constat de #736 : à 360 px, un panneau de tunnel offre ~280 px
    // utiles, et trente-six caractères s'y replient sur deux lignes.
    const reference = appointmentReference('8425dc59-e63d-4ff5-b679-5714157cb046');

    expect(reference).not.toBeNull();
    expect(reference?.length).toBe(11);
  });
});

describe('la stabilité de la référence', () => {
  it('rend toujours la même référence pour le même rendez-vous', () => {
    const id = '8425dc59-e63d-4ff5-b679-5714157cb046';

    expect(appointmentReference(id)).toBe(appointmentReference(id));
  });

  it('ne dépend pas de la casse de l’identifiant', () => {
    const id = '8425dc59-e63d-4ff5-b679-5714157cb046';

    // Le même rendez-vous cité en majuscules reste le même rendez-vous : une
    // référence qui changerait de valeur selon l'écriture de l'UUID ne serait
    // plus une preuve de rien.
    expect(appointmentReference(id.toUpperCase())).toBe(appointmentReference(id));
  });

  it('rend exactement ces valeurs-là, et le jour où elle en rend d’autres est un défaut', () => {
    // Les vecteurs sont le cœur de la suite. La référence est *dérivée* et non
    // stockée : rien en base ne la retient, donc rien ne rattraperait un
    // changement d'algorithme. Une cliente qui a noté « RDV-A5HY-14 » sur un
    // coin de table doit lire la même chose au rafraîchissement suivant, et
    // après le déploiement d'après.
    expect(appointmentReference('8425dc59-e63d-4ff5-b679-5714157cb046')).toBe('RDV-A5HY-14');
    expect(appointmentReference('55555555-5555-4555-8555-555555555555')).toBe('RDV-RQWJ-77');
    expect(appointmentReference('ffffffff-ffff-4fff-bfff-ffffffffffff')).toBe('RDV-HXE2-55');
  });

  it('distingue deux rendez-vous voisins', () => {
    // Deux identifiants qui ne diffèrent que d'un bit de poids faible : c'est
    // exactement ce que la réduction modulaire pourrait confondre si elle lisait
    // les bits de poids fort, ceux que la version et la variante d'un UUID v4
    // figent.
    expect(appointmentReference(uuid(1))).not.toBe(appointmentReference(uuid(2)));
  });
});

describe('la référence se recopie et se dicte', () => {
  it('n’emploie jamais `I`, `L`, `O` ni `U`', () => {
    // `I` et `L` se confondent avec `1`, `O` avec `0`, dans à peu près toutes
    // les fontes — et une référence est faite pour être recopiée à la main ou
    // épelée au téléphone. `U` part avec elles pour la raison qu'a Crockford.
    //
    // ## Le pas, et pourquoi il n'est pas de 1
    //
    // La référence ne lit que les bits de poids faible de l'identifiant :
    // `uuid(0)`, `uuid(1)`, … `uuid(511)` donnent cinq cents références
    // **voisines**, qui ne diffèrent que par leur suffixe décimal. Un compteur
    // simple n'exerçait donc que six groupes — « GMFB » à « GMFG », soit sept
    // symboles sur trente-deux —, et l'assertion passait au vert sur un
    // alphabet qui aurait réintroduit `I`, `L`, `O` et `U` : aucun des quatre
    // n'était atteignable dans la fenêtre parcourue.
    //
    // Le pas balaie donc tout l'espace des références — `32⁴ × 100` —, et la
    // couverture est **vérifiée**, faute de quoi rien ne signalerait que la
    // boucle a cessé de le balayer.
    const symbols = new Set<string>();

    for (let index = 0; index < 4096; index += 1) {
      const reference = appointmentReference(uuid(index * 25_601));

      expect(reference).toMatch(SHAPE);
      expect(reference).not.toMatch(/[ILOU]/);

      for (const symbol of reference?.slice(4, 8) ?? '') {
        symbols.add(symbol);
      }
    }

    // Les trente-deux symboles de l'alphabet ont tous été rendus : l'assertion
    // ci-dessus a donc vu tout ce qu'elle pouvait voir, et non une fenêtre.
    expect(symbols.size).toBe(32);
  });
});

describe('ce qui n’est pas un identifiant', () => {
  it('ne rend aucune référence plutôt qu’une référence inventée', () => {
    // Le cas ne se produit pas en service — `BookedAppointment.id` est validé en
    // UUID à la réception comme à la relecture du brouillon. Mais un
    // `sessionStorage` bricolé ne doit pas produire ce qui ressemblerait à une
    // preuve de réservation.
    expect(appointmentReference('')).toBeNull();
    expect(appointmentReference('pas-un-identifiant')).toBeNull();
    expect(appointmentReference('8425dc59e63d4ff5b6795714157cb046')).toBeNull();
  });
});
