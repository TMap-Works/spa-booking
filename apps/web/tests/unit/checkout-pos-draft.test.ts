import { ERROR_CODES } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  POS_MAX_LINES,
  POS_MAX_QUANTITY,
  POS_MAX_TIP_AMOUNT_MINOR,
  addPosLine,
  emptyPosDraft,
  posDraftIsSubmittable,
  posLineCount,
  removePosLine,
  saleFailureMessage,
  saleTotalRows,
  setPosLineQuantity,
  setPosTip,
  toCreateSaleRequest,
  type PosCatalogItem,
} from '@/lib/admin/checkout-summary';
import type { SaleSummary } from '@/lib/admin/payment-contract';

/**
 * La composition d'un ticket de caisse, vérifiée sans monter d'écran (#61).
 *
 * L'invariant que ce fichier protège n'est pas ergonomique mais comptable :
 * **le brouillon ne fabrique aucun montant.** Il porte des natures, des
 * identifiants et des quantités, et le seul montant qu'il ait le droit
 * d'émettre est le pourboire — le seul que l'API accepte, parce qu'il n'existe
 * dans aucune table à relire (payments-stripe §4 et §5).
 */

const SHAMPOOING: PosCatalogItem = {
  kind: 'PRODUCT',
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  label: 'Shampoing hydratant 250 ml',
  unitPrice: { amountMinor: 1850, currency: 'EUR' },
};

const COUPE: PosCatalogItem = {
  kind: 'SERVICE',
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  label: 'Coupe et brushing',
  unitPrice: { amountMinor: 3500, currency: 'EUR' },
};

describe('ajouter des prestations et des articles au ticket', () => {
  it('ouvre un ticket vide, rattaché ou non à un rendez-vous', () => {
    expect(emptyPosDraft().appointmentId).toBeNull();
    expect(emptyPosDraft('cccccccc-0000-4000-8000-000000000003').appointmentId).toBe(
      'cccccccc-0000-4000-8000-000000000003',
    );
    // Une vente retail autonome est un cas de premier rang, pas une exception :
    // le modèle accepte les deux depuis le départ (payments-stripe §4).
    expect(posDraftIsSubmittable(emptyPosDraft())).toBe(false);
  });

  it('accepte les deux natures et conserve l’ordre de saisie — celui du reçu', () => {
    const draft = addPosLine(addPosLine(emptyPosDraft(), COUPE), SHAMPOOING);

    expect(draft.lines.map((line) => line.kind)).toEqual(['SERVICE', 'PRODUCT']);
    expect(draft.lines.map((line) => line.label)).toEqual([COUPE.label, SHAMPOOING.label]);
  });

  it('fusionne un élément déjà présent au lieu d’empiler une seconde ligne', () => {
    // Deux shampooings se lisent « ×2 » sur le reçu. Empiler obligerait la
    // cliente à recompter, et mettrait le plafond de cent lignes à portée d'une
    // vente réelle.
    const draft = addPosLine(addPosLine(emptyPosDraft(), SHAMPOOING), SHAMPOOING);

    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]?.quantity).toBe(2);
  });

  it('distingue une prestation et un article qui porteraient le même identifiant', () => {
    // Les deux tables ont chacune leurs UUID : rien ne garantit qu'ils ne se
    // croisent jamais, et une collision fusionnerait une coupe avec un flacon.
    const draft = addPosLine(addPosLine(emptyPosDraft(), COUPE), { ...SHAMPOOING, id: COUPE.id });

    expect(draft.lines).toHaveLength(2);
  });
});

describe('modifier les quantités et retirer des lignes', () => {
  it('retire la ligne quand la quantité tombe à zéro', () => {
    // Zéro veut dire « je n'en veux plus » dans tous les logiciels de caisse, et
    // l'API refuse une ligne de quantité nulle (`Min(1)`).
    const draft = setPosLineQuantity(
      addPosLine(emptyPosDraft(), SHAMPOOING),
      'PRODUCT',
      SHAMPOOING.id,
      0,
    );

    expect(draft.lines).toHaveLength(0);
  });

  it('retire aussi la ligne sur une quantité négative ou illisible', () => {
    const one = addPosLine(emptyPosDraft(), SHAMPOOING);

    expect(setPosLineQuantity(one, 'PRODUCT', SHAMPOOING.id, -3).lines).toHaveLength(0);
    expect(setPosLineQuantity(one, 'PRODUCT', SHAMPOOING.id, Number.NaN).lines).toHaveLength(0);
  });

  it('tronque une quantité fractionnaire vers le bas — on ne vend pas ce qui n’est pas demandé', () => {
    const draft = setPosLineQuantity(
      addPosLine(emptyPosDraft(), SHAMPOOING),
      'PRODUCT',
      SHAMPOOING.id,
      2.9,
    );

    expect(draft.lines[0]?.quantity).toBe(2);
  });

  it('plafonne la quantité à ce que l’API accepte', () => {
    const draft = setPosLineQuantity(
      addPosLine(emptyPosDraft(), SHAMPOOING),
      'PRODUCT',
      SHAMPOOING.id,
      POS_MAX_QUANTITY + 500,
    );

    expect(draft.lines[0]?.quantity).toBe(POS_MAX_QUANTITY);
    // Et un ajout de plus ne franchit pas le plafond en douce.
    expect(addPosLine(draft, SHAMPOOING).lines[0]?.quantity).toBe(POS_MAX_QUANTITY);
  });

  it('retire une ligne nommément, et laisse le ticket intact si elle n’y est pas', () => {
    const draft = addPosLine(addPosLine(emptyPosDraft(), COUPE), SHAMPOOING);

    expect(removePosLine(draft, 'PRODUCT', SHAMPOOING.id).lines.map((line) => line.id)).toEqual([
      COUPE.id,
    ]);
    expect(removePosLine(draft, 'PRODUCT', 'inconnu').lines).toHaveLength(2);
  });

  it('refuse d’ouvrir une ligne de plus au-delà du plafond du contrat', () => {
    let draft = emptyPosDraft();
    for (let index = 0; index < POS_MAX_LINES; index += 1) {
      draft = addPosLine(draft, { ...SHAMPOOING, id: `article-${String(index)}` });
    }

    expect(posLineCount(draft)).toBe(POS_MAX_LINES);
    // Refuser en silence plutôt qu'écrêter en silence : l'écran lit
    // `posLineCount` pour le dire, et le serveur refuserait de toute façon.
    expect(addPosLine(draft, { ...SHAMPOOING, id: 'article-de-trop' }).lines).toHaveLength(
      POS_MAX_LINES,
    );
  });

  it('compte le pourboire dans les lignes envoyées, puisque c’en est une', () => {
    const draft = setPosTip(addPosLine(emptyPosDraft(), SHAMPOOING), 200);

    expect(draft.lines).toHaveLength(1);
    expect(posLineCount(draft)).toBe(2);
  });
});

describe('le pourboire', () => {
  it('n’accepte qu’un entier strictement positif', () => {
    const draft = addPosLine(emptyPosDraft(), SHAMPOOING);

    expect(setPosTip(draft, 250).tipAmountMinor).toBe(250);
    // Toute autre valeur efface le pourboire plutôt que d'en poser un
    // approximatif : pas de pourboire vaut mieux qu'un mauvais pourboire.
    expect(setPosTip(draft, 0).tipAmountMinor).toBeNull();
    expect(setPosTip(draft, -100).tipAmountMinor).toBeNull();
    expect(setPosTip(draft, Number.NaN).tipAmountMinor).toBeNull();
    expect(setPosTip(draft, null).tipAmountMinor).toBeNull();
  });

  it('tronque un montant fractionnaire — un montant est un entier, jamais un flottant', () => {
    expect(setPosTip(emptyPosDraft(), 250.9).tipAmountMinor).toBe(250);
  });

  it('efface un montant au-delà de ce que la colonne porte, au lieu de l’écrêter', () => {
    // `@Max(2_147_483_647)` côté API : au-delà, l'envoi tombe en 400 devant la
    // cliente. L'écrêter aurait été pire — c'est le seul geste de ce module qui
    // ferait payer plus que ce qui a été demandé.
    expect(setPosTip(emptyPosDraft(), POS_MAX_TIP_AMOUNT_MINOR).tipAmountMinor).toBe(
      POS_MAX_TIP_AMOUNT_MINOR,
    );
    expect(setPosTip(emptyPosDraft(), POS_MAX_TIP_AMOUNT_MINOR + 1).tipAmountMinor).toBeNull();
  });

  it('ne se pose pas sur un ticket déjà plein — c’en est une ligne de plus', () => {
    let draft = emptyPosDraft();
    for (let index = 0; index < POS_MAX_LINES; index += 1) {
      draft = addPosLine(draft, { ...SHAMPOOING, id: `article-${String(index)}` });
    }

    // Sans ce refus, le corps envoyé porterait cent une lignes et
    // `ArrayMaxSize` le rejetterait en 400 — après que l'écran a annoncé un
    // ticket envoyable.
    expect(setPosTip(draft, 500).tipAmountMinor).toBeNull();
    expect(toCreateSaleRequest(setPosTip(draft, 500)).lines).toHaveLength(POS_MAX_LINES);
  });

  it('s’efface toujours, même sur un ticket plein — cela retire une ligne', () => {
    let draft = emptyPosDraft();
    for (let index = 0; index < POS_MAX_LINES - 1; index += 1) {
      draft = addPosLine(draft, { ...SHAMPOOING, id: `article-${String(index)}` });
    }

    const withTip = setPosTip(draft, 500);

    expect(posLineCount(withTip)).toBe(POS_MAX_LINES);
    expect(setPosTip(withTip, null).tipAmountMinor).toBeNull();
    // Et le remplacer sur un ticket au plafond n'ajoute rien non plus.
    expect(setPosTip(withTip, 700).tipAmountMinor).toBe(700);
  });

  it('reste unique par construction, ce que l’API exige', () => {
    // `POST /sales` refuse en 400 un second pourboire, parce que deux lignes
    // seraient silencieusement additionnées. Un brouillon qui porte un champ et
    // non une liste ne peut pas en fabriquer deux.
    const draft = setPosTip(setPosTip(emptyPosDraft(), 200), 500);

    expect(toCreateSaleRequest(draft).lines.filter((line) => line.kind === 'TIP')).toHaveLength(1);
  });

  it('suffit à lui seul à composer un ticket', () => {
    // Un pourboire laissé après coup s'enregistre sans refacturer la prestation.
    expect(posDraftIsSubmittable(setPosTip(emptyPosDraft(), 500))).toBe(true);
  });
});

describe('le corps envoyé à POST /sales', () => {
  it('ne porte aucun montant hors le pourboire', () => {
    // C'est l'invariant central du ticket : le montant envoyé par le front ne
    // fait jamais autorité, donc le front n'en envoie aucun.
    const draft = setPosTip(addPosLine(addPosLine(emptyPosDraft(), COUPE), SHAMPOOING), 300);
    const body = toCreateSaleRequest(draft);

    for (const line of body.lines) {
      if (line.kind === 'TIP') {
        continue;
      }

      const fields = Object.keys(line);
      expect(fields).not.toContain('unitPrice');
      expect(fields).not.toContain('unitAmount');
      expect(fields).not.toContain('lineAmount');
      expect(fields).not.toContain('amountMinor');
      expect(fields).not.toContain('currency');
    }

    expect(JSON.stringify(body)).not.toContain('1850');
    expect(JSON.stringify(body)).not.toContain('3500');
  });

  it('nomme l’identifiant selon la nature de la ligne', () => {
    const body = toCreateSaleRequest(addPosLine(addPosLine(emptyPosDraft(), COUPE), SHAMPOOING));

    expect(body.lines[0]).toEqual({ kind: 'SERVICE', serviceId: COUPE.id, quantity: 1 });
    expect(body.lines[1]).toEqual({ kind: 'PRODUCT', productId: SHAMPOOING.id, quantity: 1 });
  });

  it('place le pourboire en dernier, là où un ticket de caisse le porte', () => {
    const body = toCreateSaleRequest(setPosTip(addPosLine(emptyPosDraft(), COUPE), 300));

    expect(body.lines.at(-1)).toEqual({ kind: 'TIP', amountMinor: 300 });
  });

  it('porte `null` — et non l’absence — pour une vente retail autonome', () => {
    expect(toCreateSaleRequest(addPosLine(emptyPosDraft(), SHAMPOOING)).appointmentId).toBeNull();
  });

  it('ne porte ni opérateur ni établissement', () => {
    // Les deux viennent du jeton vérifié et de la revendication signée : les
    // envoyer aurait fait du navigateur l'autorité sur qui a encaissé, et pour
    // quel salon (tenant-isolation §2).
    const fields = Object.keys(toCreateSaleRequest(addPosLine(emptyPosDraft(), COUPE)));

    expect(fields).toEqual(['appointmentId', 'lines']);
  });
});

describe('les totaux affichés', () => {
  const SALE: SaleSummary = {
    id: 'dddddddd-0000-4000-8000-000000000004',
    appointmentId: null,
    cashierUserId: 'eeeeeeee-0000-4000-8000-000000000005',
    subtotal: { amountMinor: 5350, currency: 'EUR' },
    tax: { amountMinor: 1070, currency: 'EUR' },
    tip: { amountMinor: 300, currency: 'EUR' },
    total: { amountMinor: 6720, currency: 'EUR' },
    createdAt: '2026-09-06T09:30:00.000Z',
  };

  it('lisent le total du serveur sans jamais le recomposer', () => {
    // Le point du test : même si les quatre champs ne s'additionnaient pas
    // entre eux, c'est `total` qui s'affiche. Le serveur est la seule autorité
    // sur ce que la cliente doit — le front ne le vérifie pas, il l'affiche.
    const rows = saleTotalRows({ ...SALE, total: { amountMinor: 9999, currency: 'EUR' } });

    expect(rows.at(-1)).toEqual({
      label: 'Total',
      amount: { amountMinor: 9999, currency: 'EUR' },
      isGrand: true,
    });
  });

  it('portent la devise avec chaque montant', () => {
    for (const row of saleTotalRows(SALE)) {
      expect(row.amount.currency).toBe('EUR');
    }
  });

  it('n’impriment ni taxe ni pourboire nuls — une ligne à zéro se lit comme une erreur', () => {
    const rows = saleTotalRows({
      ...SALE,
      tax: { amountMinor: 0, currency: 'EUR' },
      tip: { amountMinor: 0, currency: 'EUR' },
    });

    expect(rows.map((row) => row.label)).toEqual(['Sous-total', 'Total']);
  });

  it('gardent une seule ligne mise en avant, celle qu’on annonce à voix haute', () => {
    expect(saleTotalRows(SALE).filter((row) => row.isGrand)).toHaveLength(1);
    expect(saleTotalRows(SALE).map((row) => row.label)).toEqual([
      'Sous-total',
      'Taxe',
      'Pourboire',
      'Total',
    ]);
  });
});

describe('les refus de la caisse', () => {
  it('dit quoi faire d’un article retiré du rayon', () => {
    expect(saleFailureMessage('SALE_ITEM_UNAVAILABLE', 'brut')).toMatch(/retirez-le/i);
  });

  it('traite les deux formes du refus de devise de la même façon', () => {
    // `SALE_CURRENCY_MISMATCH` vient du module `payments`, `CURRENCY_MISMATCH`
    // du contrat partagé : même incident, même conduite.
    expect(saleFailureMessage('SALE_CURRENCY_MISMATCH', 'brut')).toBe(
      saleFailureMessage(ERROR_CODES.CURRENCY_MISMATCH, 'brut'),
    );
  });

  it('ne distingue pas l’article inconnu de celui d’un autre établissement', () => {
    // L'écran n'a pas à distinguer ce que l'API refuse de distinguer
    // (tenant-isolation §4).
    expect(saleFailureMessage(ERROR_CODES.NOT_FOUND, 'brut')).toBe(
      saleFailureMessage('HTTP_404', 'brut'),
    );
  });

  it('affirme qu’un ticket refusé n’a pas été enregistré', () => {
    expect(saleFailureMessage(ERROR_CODES.SERVICE_UNAVAILABLE, 'brut')).toMatch(
      /n’a pas été enregistré/i,
    );
  });

  it('retombe sur le message de l’API pour un code qu’il ne connaît pas', () => {
    // Un code inconnu vaut mieux affiché que remplacé par une phrase générique
    // qui n'apprend rien (web-frontend §2).
    expect(saleFailureMessage('CODE_INEDIT', 'ce que l’API a dit')).toBe('ce que l’API a dit');
  });
});
