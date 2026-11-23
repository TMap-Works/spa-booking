import { describe, expect, it } from 'vitest';
import { formulaireTool } from '@/lib/copilot/tools';

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
