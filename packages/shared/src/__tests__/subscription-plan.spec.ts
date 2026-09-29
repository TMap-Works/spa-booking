/**
 * Le prix de l'offre — #1330, troisième critère d'acceptation.
 *
 * ## Ce que cette suite protège, et ce qu'elle ne tranche pas
 *
 * La recette de traduction a relevé « 14 days free, then €29 a month » sur
 * l'inscription d'un salon américain. Deux choses s'y mêlaient :
 *
 * - **un prix libellé en dur** dans un écran, ce qui est un défaut d'affichage et
 *   se corrige ;
 * - **un salon de Chicago facturé en euros**, ce qui est une question de prix et
 *   relève du PO — signalée le 2026-09-19, toujours ouverte, et laissée ouverte par
 *   #1330 lui-même.
 *
 * Ces cas ne décident donc **pas** de la devise : ils vérifient que la décision,
 * quand elle tombera, n'aura qu'un seul endroit à changer et qu'aucun écran n'aura
 * à être retouché. C'est tout ce qu'un test peut garder ici.
 */

import { moneySchema } from '../common/money';
import { SUBSCRIPTION_PLAN, SUBSCRIPTION_PLAN_PRICE } from '../schemas/billing';

describe('le prix de l’offre', () => {
  it('est un montant valide du contrat', () => {
    expect(moneySchema.safeParse(SUBSCRIPTION_PLAN_PRICE).success).toBe(true);
    // Un entier dans la plus petite unité, jamais un flottant — CLAUDE.md,
    // « Argent ».
    expect(Number.isInteger(SUBSCRIPTION_PLAN_PRICE.amountMinor)).toBe(true);
  });

  it('dérive de l’offre au lieu de la recopier', () => {
    // Deux sources pour un prix auraient fini par annoncer deux prix : celui que
    // Stripe prélève (`payments/billing`) et celui que l'écran affiche.
    expect(SUBSCRIPTION_PLAN_PRICE.amountMinor).toBe(SUBSCRIPTION_PLAN.amountMinor);
    expect(SUBSCRIPTION_PLAN_PRICE.currency).toBe(SUBSCRIPTION_PLAN.currency);
  });

  it('porte sa devise en donnée, non en littéral de type', () => {
    // La garde du critère : `SUBSCRIPTION_PLAN.currency` est le littéral `'EUR'`
    // que `as const` fige, et un écran pouvait s'y spécialiser. Le type du prix,
    // lui, est `Money` — sa devise est une chaîne. L'affectation ci-dessous est la
    // **directive** : redonner un type littéral à ce champ ferait échouer `tsc`
    // ici, avant qu'un écran ne se remette à écrire l'euro en dur.
    const currency: string = SUBSCRIPTION_PLAN_PRICE.currency;

    expect(currency).toMatch(/^[A-Z]{3}$/u);
  });

  it('conserve le tarif d’avant #1330 — la devise d’un salon US/CA est une décision du PO', () => {
    // Le comportement actuel reste le défaut, délibérément : changer la devise
    // ici changerait la somme prélevée sur la carte du salon, pas un libellé. Ce
    // cas tombera le jour où le PO tranchera, et c'est exactement ce qu'on veut —
    // il n'y a **pas** de correspondance pays → devise dans le contrat, et il n'y
    // en aura pas sans décision.
    expect(SUBSCRIPTION_PLAN_PRICE.amountMinor).toBe(2900);
    expect(SUBSCRIPTION_PLAN_PRICE.currency).toBe('EUR');
  });
});
