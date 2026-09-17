import {
  CUSTOMER_SEARCH_MAX_LENGTH,
  type Customer,
  type CustomerPage,
  type CustomerSummary,
} from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  countedLabel,
  customerContactLine,
  emailSuppressionNotice,
  isVoidVisit,
  parsePageNumber,
  parseSearchTerm,
  searchHint,
  visitClientNote,
} from '@/app/(admin)/[tenantSlug]/admin/clients/client-view';
import { adminClientsPath } from '@/app/(admin)/[tenantSlug]/admin/clients/paths';

/**
 * Ce que l'écran du fichier client déduit de l'URL, et ce qu'il en construit
 * (#54).
 *
 * L'URL est une **entrée** : elle se partage entre deux postes du comptoir, se
 * met en favori et se corrige à la main. Ces fonctions sont ce qui empêche une
 * URL bricolée de devenir un écran en erreur — un `?recherche=a` ferait répondre
 * 400 à `GET /customers`, pour une saisie qui n'est qu'incomplète.
 */

const FARA: CustomerSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Fara',
  lastName: 'Rakotoson',
  email: 'fara.rakotoson@example.mg',
  phone: '+261341234567',
  isActive: true,
};

describe('le terme de recherche lu de l’URL', () => {
  it('retient un terme utilisable tel quel', () => {
    expect(parseSearchTerm('rako')).toBe('rako');
  });

  it('découpe les blancs — un terme collé à un espace reste le même terme', () => {
    expect(parseSearchTerm('  rako  ')).toBe('rako');
  });

  it('écarte une lettre seule plutôt que de la faire refuser par l’API', () => {
    // Sous la borne du contrat, l'API répond 400. Ne rien envoyer affiche le
    // fichier entier, ce qui est faux dans aucun sens.
    expect(parseSearchTerm('a')).toBeNull();
    expect(parseSearchTerm(' ')).toBeNull();
    expect(parseSearchTerm(undefined)).toBeNull();
  });

  it('survit à une clé répétée — `?recherche=a&recherche=b` arrive en tableau', () => {
    // Next rend `searchParams` tel que l'URL l'écrit : une clé répétée y est un
    // tableau. Le prendre pour une chaîne lèverait dans le Server Component,
    // soit l'écran en erreur que cette fonction existe pour éviter.
    expect(parseSearchTerm(['rako', 'hasina'])).toBeNull();
    expect(parsePageNumber(['1', '2'])).toBe(1);
  });

  it('écarte un terme plus long que la colonne la plus large qu’il interroge', () => {
    expect(parseSearchTerm('x'.repeat(CUSTOMER_SEARCH_MAX_LENGTH))).not.toBeNull();
    expect(parseSearchTerm('x'.repeat(CUSTOMER_SEARCH_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('le numéro de page lu de l’URL', () => {
  it('prend le numéro demandé quand il en est un', () => {
    expect(parsePageNumber('3')).toBe(3);
  });

  it('retombe sur la première page sur tout ce que l’API refuserait', () => {
    for (const raw of [undefined, '', '0', '-3', 'deux', '1.5', 'NaN']) {
      expect(parsePageNumber(raw)).toBe(1);
    }
  });
});

/**
 * L'accord en nombre des libellés — #763.
 *
 * L'audit de conception relevait « 1 Visites honorées » et « 1 Absences non
 * prévenues » sur les tuiles de la fiche : un compteur et son libellé se lisent
 * d'un seul tenant, et le désaccord se voit avant le chiffre.
 */
describe('un libellé accordé au nombre qu’il porte', () => {
  it('bascule au pluriel à partir de deux', () => {
    expect(countedLabel(2, 'Visite honorée', 'Visites honorées')).toBe('Visites honorées');
    expect(countedLabel(37, 'Absence non prévenue', 'Absences non prévenues')).toBe(
      'Absences non prévenues',
    );
  });

  it('garde le singulier à un — le cas qui avait produit « 1 Visites honorées »', () => {
    expect(countedLabel(1, 'Visite honorée', 'Visites honorées')).toBe('Visite honorée');
  });

  it('garde le singulier à zéro, comme le veut le français', () => {
    // « 0 visite honorée », et non « 0 visites honorées » : c'est la bascule à
    // deux, pas à un, et c'est déjà la règle que suivent les autres libellés de
    // cet écran.
    expect(countedLabel(0, 'Annulé', 'Annulés')).toBe('Annulé');
  });
});

/**
 * La légende du champ de recherche — #763.
 *
 * Ce qu'elle protège : que l'absence de résultat ne se lise pas deux fois, une
 * fois sous le champ et une fois dans le bloc de résultat, à trois centimètres
 * d'écart et avec le même terme entre guillemets.
 */
describe('la légende du champ de recherche', () => {
  function directory(totalItems: number): CustomerPage {
    // `totalPages` vaut 0 sur un ensemble vide, comme le rend l'API : « page 1
    // sur 0 » décrit une liste sans résultat (`common/pagination.ts`).
    return { items: [], page: 1, pageSize: 20, totalItems, totalPages: totalItems === 0 ? 0 : 1 };
  }

  it('compte le fichier entier quand on n’a rien cherché', () => {
    expect(searchHint(null, directory(12))).toBe(
      'Nom, téléphone ou e-mail — le fichier compte 12 fiches.',
    );
  });

  it('accorde « fiche » au nombre trouvé', () => {
    expect(searchHint('rako', directory(1))).toBe(
      'Nom, téléphone ou e-mail — 1 fiche pour « rako ».',
    );
    expect(searchHint('rako', directory(3))).toBe(
      'Nom, téléphone ou e-mail — 3 fiches pour « rako ».',
    );
  });

  it('se tait sur le vide — c’est le bloc de résultat qui le dit', () => {
    // Et cela retire du même geste le « le fichier compte aucune fiche » que
    // l'ancienne légende produisait sur un fichier neuf.
    expect(searchHint('zzzzz', directory(0))).toBe('Nom, téléphone ou e-mail.');
    expect(searchHint(null, directory(0))).toBe('Nom, téléphone ou e-mail.');
  });
});

describe('le prix d’une visite qui n’a rien encaissé', () => {
  it('barre l’annulation et l’absence — ni l’une ni l’autre n’est une recette', () => {
    expect(isVoidVisit('cancelled')).toBe(true);
    expect(isVoidVisit('no_show')).toBe(true);
  });

  it('laisse le prix d’une visite honorée ou encore à venir', () => {
    expect(isVoidVisit('completed')).toBe(false);
    expect(isVoidVisit('confirmed')).toBe(false);
    expect(isVoidVisit('pending')).toBe(false);
  });
});

/**
 * La remarque du client sur une ligne d'historique — #870.
 *
 * Ce que cette fonction tranche tient en une phrase : « rien d'écrit » et
 * « écrit du blanc » sont le même cas. Le contrat accepte les deux — il borne la
 * longueur d'un texte libre, pas son contenu —, et les distinguer à l'affichage
 * aurait fait apparaître, sur une ligne de visite, l'étiquette « Remarque du
 * client » suivie de rien.
 */
describe('la remarque écrite par le client à la réservation', () => {
  it('rend le texte tel quel, retours à la ligne compris', () => {
    const consigne = 'Allergie aux agrumes.\nMerci d’en tenir compte pour le gommage.';

    expect(visitClientNote(consigne)).toBe(consigne);
  });

  it('ne rend rien quand rien n’a été écrit — `null` comme une chaîne blanche', () => {
    for (const vide of [null, '', '   ', '\n', ' \t ']) {
      expect(visitClientNote(vide)).toBeNull();
    }
  });
});

describe('la ligne de coordonnées de la liste', () => {
  it('met le numéro d’abord — c’est ce qu’un comptoir compose', () => {
    expect(customerContactLine(FARA)).toBe('+261341234567 · fara.rakotoson@example.mg');
  });

  it('n’affiche que l’adresse quand la fiche n’a pas de numéro', () => {
    // Une fiche saisie au comptoir n'en a pas toujours ; une ligne vide
    // obligerait à ouvrir la fiche pour savoir si la personne est joignable.
    expect(customerContactLine({ ...FARA, phone: null })).toBe('fara.rakotoson@example.mg');
  });
});

/**
 * L'avis d'adresse supprimée — #525, quatrième critère de #73.
 *
 * Ce que ces cas protègent : un gestionnaire de salon voit une réservation
 * confirmée sans jamais savoir que la cliente n'a rien reçu et ne recevra plus
 * rien. La fonction est le seul endroit qui décide **si** l'avis se montre et
 * **ce qu'il dit** ; l'écran ne fait que le rendre.
 */
describe('l’avis d’adresse supprimée', () => {
  /** Une fiche complète, adresse vivante — le socle des cas ci-dessous. */
  const VIVANTE: Customer = {
    ...FARA,
    internalNote: null,
    createdAt: '2026-03-04T08:00:00.000Z',
    anonymizedAt: null,
    emailSuppressedAt: null,
    emailSuppressionReason: null,
  };

  /**
   * La même fiche après exercice du droit à l'effacement — #529.
   *
   * C'est exactement ce que `CustomerService.anonymize` laisse en base : le
   * pseudonyme, l'adresse en `.invalid`, le téléphone et la note vidés, la fiche
   * désactivée — et les **deux colonnes de suppression intactes**, posées du
   * temps où l'adresse existait.
   */
  const ANONYMISEE: Customer = {
    ...VIVANTE,
    firstName: 'Client',
    lastName: 'anonymisé',
    email: `anonymise-${FARA.id}@anonymise.invalid`,
    phone: null,
    isActive: false,
    anonymizedAt: '2026-09-08T09:00:00.000Z',
    emailSuppressedAt: '2026-09-05T10:30:00.000Z',
    emailSuppressionReason: 'hard_bounce',
  };

  it('ne dit rien d’une adresse vivante — l’état de la quasi-totalité du fichier', () => {
    expect(emailSuppressionNotice(VIVANTE)).toBeNull();
  });

  it('nomme le motif en toutes lettres, jamais par la seule couleur du bandeau', () => {
    const rebond = emailSuppressionNotice({
      ...VIVANTE,
      emailSuppressedAt: '2026-09-05T10:30:00.000Z',
      emailSuppressionReason: 'hard_bounce',
    });
    const plainte = emailSuppressionNotice({
      ...VIVANTE,
      emailSuppressedAt: '2026-09-05T10:30:00.000Z',
      emailSuppressionReason: 'complaint',
    });

    // Les deux motifs n'appellent pas la même conversation au comptoir : le
    // premier se corrige en redemandant l'adresse, le second ne se corrige pas.
    expect(rebond?.reason).toMatch(/rebond définitif/);
    expect(plainte?.reason).toMatch(/plainte/);
    expect(rebond?.reason).not.toBe(plainte?.reason);
  });

  it('rend l’instant tel quel — c’est l’écran qui le passe au fuseau du salon', () => {
    // La fonction est pure et sans fuseau : convertir ici aurait obligé à lui
    // passer le `timeZone` du salon, et deux formateurs auraient fini par
    // diverger sur une frontière de jour.
    expect(
      emailSuppressionNotice({
        ...VIVANTE,
        emailSuppressedAt: '2026-09-05T10:30:00.000Z',
        emailSuppressionReason: 'complaint',
      })?.suppressedAt,
    ).toBe('2026-09-05T10:30:00.000Z');
  });

  it('c’est la date qui supprime, pas le motif — un motif orphelin n’affiche rien', () => {
    // Les deux colonnes sont posées ensemble par l'unique écriture qui les
    // écrit, mais aucun `CHECK` ne le garde en base. `emailSuppressedAt` est le
    // fait : « depuis quand n'écrit-on plus ».
    expect(
      emailSuppressionNotice({ ...VIVANTE, emailSuppressionReason: 'hard_bounce' }),
    ).toBeNull();
  });

  it('affiche quand même une date sans motif — savoir que rien ne part prime', () => {
    const notice = emailSuppressionNotice({
      ...VIVANTE,
      emailSuppressedAt: '2026-09-05T10:30:00.000Z',
    });

    expect(notice?.reason).toBe('motif non enregistré');
  });

  it('se tait sur une fiche anonymisée — l’adresse visée n’a jamais existé (#529)', () => {
    // L'anonymisation laisse les deux colonnes de suppression en place : sans
    // cette garde, l'écran annonçait « plus aucun envoi ne part vers
    // anonymise-….invalid · prévenez la cliente par téléphone » — une consigne
    // de rattrapage visant une personne effacée, dont le numéro a été vidé par
    // la même opération. Le bandeau **et** le badge lisent cette fonction : les
    // deux disparaissent d'un même geste.
    expect(emailSuppressionNotice(ANONYMISEE)).toBeNull();
  });

  it('ne se tait que sur l’anonymisation — une fiche désactivée dit toujours ce qui ne part plus', () => {
    // Deux états à ne pas confondre : une fiche désactivée désigne encore
    // quelqu'un, qu'on peut avoir au téléphone et à qui l'avis dit quoi faire.
    // Seule l'anonymisation retire la personne, et donc le sens de l'avis.
    const desactivee = emailSuppressionNotice({
      ...ANONYMISEE,
      email: 'fara.rakotoson@example.mg',
      phone: '+261341234567',
      firstName: 'Fara',
      lastName: 'Rakotoson',
      anonymizedAt: null,
    });

    expect({ affiche: desactivee !== null, instant: desactivee?.suppressedAt }).toEqual({
      affiche: true,
      instant: '2026-09-05T10:30:00.000Z',
    });
  });
});

describe('les chemins du fichier client', () => {
  it('rend l’URL nue quand rien n’est demandé', () => {
    expect(adminClientsPath('maison-lotus')).toBe('/maison-lotus/admin/clients');
  });

  it('omet la première page — deux liens identiques ne font pas deux entrées d’historique', () => {
    expect(adminClientsPath('maison-lotus', { page: 1 })).toBe('/maison-lotus/admin/clients');
    expect(adminClientsPath('maison-lotus', { page: 2 })).toBe(
      '/maison-lotus/admin/clients?page=2',
    );
  });

  it('porte le terme et la fiche ouverte, chacun encodé', () => {
    expect(adminClientsPath('maison-lotus', { term: 'rako ka', customerId: FARA.id })).toBe(
      `/maison-lotus/admin/clients?recherche=rako+ka&fiche=${FARA.id}`,
    );
  });

  it('garde la page en ouvrant une fiche — la ligne cliquée reste sous les yeux', () => {
    // Sans le numéro de page, ouvrir une fiche depuis la deuxième page ramenait
    // à la première : la ligne sur laquelle on venait de cliquer disparaissait
    // de la liste, et avec elle l'aplat de la ligne ouverte.
    expect(adminClientsPath('maison-lotus', { customerId: FARA.id, page: 2 })).toBe(
      `/maison-lotus/admin/clients?fiche=${FARA.id}&page=2`,
    );
  });

  it('ne porte aucun identifiant d’établissement — le slug est le segment, rien d’autre', () => {
    // Le tenant vient du jeton vérifié (tenant-isolation §2). Un paramètre qui
    // le nommerait serait précisément l'entrée contrôlée par l'appelant que la
    // règle interdit.
    const path = adminClientsPath('maison-lotus', { term: 'rako', customerId: FARA.id, page: 4 });

    expect(path.startsWith('/maison-lotus/admin/clients?')).toBe(true);
    expect(path).not.toMatch(/tenant/i);
  });
});
