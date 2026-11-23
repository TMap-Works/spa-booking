import { describe, expect, it } from 'vitest';
import type { PublicService } from '@spa/shared';

import { ficheTools, formulaireTool } from '@/lib/copilot/tools';

describe('formulaireTool', () => {
  it("ordonne au navigateur de poser les champs donnés, et refuse tout autre champ", async () => {
    
    const tool = formulaireTool();
    expect(tool.name).toBe('formulaire_remplir');

    const outcome = await tool.run({ prenom: 'Toky', email: 'toky@example.org' }, new AbortController().signal);
    expect(outcome).toMatchObject({
      kind: 'fin',
      navigateur: [{ outil: 'remplir_formulaire', arguments: { prenom: 'Toky', email: 'toky@example.org' } }],
    });

    for (const bad of [{ motDePasse: 'x' }, { password: 'x' }, {}, { email: 'pas-un-email' }]) {
      const refused = await tool.run(bad, new AbortController().signal);
      expect(refused).toMatchObject({ erreur: true });
    }
  });
});

describe('catalogue_voir_prestation', () => {
  const SOIN = '5b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
  const services = [{ id: SOIN, slug: 'soin-eclat', name: 'Soin éclat', staff: [] }] as unknown as PublicService[];
  const session = {
    surface: 'visiteur',
    role: null,
    permissions: [],
    tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
    locale: 'fr',
  } as never;
  const tool = () => ficheTools(session, async () => services).find((candidate) => candidate.name === 'catalogue_voir_prestation');

  it("ouvre la vitrine sur la rubrique de la prestation, pour une visiteuse", async () => {
    const outcome = await tool()?.run({ prestation: SOIN }, new AbortController().signal);
    expect(outcome).toMatchObject({
      kind: 'fin',
      navigateur: [{ outil: 'naviguer', arguments: { chemin: '/salon-lea#soin-eclat' } }],
    });
  });

  it("refuse une prestation qui n'est pas de ce salon", async () => {
    const outcome = await tool()?.run({ prestation: '9b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69' }, new AbortController().signal);
    expect(outcome).toMatchObject({ erreur: true });
  });
});
