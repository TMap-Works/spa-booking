import request from 'supertest';

import { ProbeModule } from './fixtures/probe.module';
import { createTestApp, type TestApp } from './utils/test-app';

/**
 * Isolation inter-tenant du squelette.
 *
 * #18 n'introduit aucune donnée de tenant — le premier modèle arrive avec le
 * schéma Prisma (#19). Ce qu'il introduit, en revanche, ce sont les **trois
 * surfaces par lesquelles une fuite passera** une fois les modules métier
 * branchés dessus, et qui sont toutes déclarées une fois pour toute l'API :
 *
 * 1. la sonde `/health`, seule route servie **sans authentification** ;
 * 2. le `ValidationPipe` global, seule barrière contre un `tenantId` injecté
 *    dans un corps de requête ;
 * 3. le filtre d'exceptions et le journal, par où une erreur d'infrastructure
 *    recopie volontiers une URL de connexion ou un e-mail client.
 *
 * Vérifier ces trois surfaces maintenant a un intérêt propre : chaque module
 * métier en hérite sans les redéclarer, donc un défaut ici est un défaut
 * partout, et il ne serait plus attribuable à ce ticket une fois #19 mergé.
 */
describe('Isolation inter-tenant — surfaces transverses', () => {
  let context: TestApp;

  beforeEach(async () => {
    context = await createTestApp({ imports: [ProbeModule] });
  });

  afterEach(async () => {
    await context.close();
  });

  it('`/health` n’expose ni tenant ni topologie d’infrastructure', async () => {
    // Route non authentifiée : tout ce qu'elle rend est public. Le contrat est
    // donc figé par une égalité de clés, et non par un `toContain` — un champ
    // ajouté par mégarde (nom d'hôte, version, identifiant de tâche ECS) doit
    // faire échouer ce test, pas passer inaperçu.
    const response = await request(context.app.getHttpServer()).get('/health').expect(200);

    expect(Object.keys(response.body).sort()).toEqual(['checks', 'status']);
    expect(Object.keys(response.body.checks).sort()).toEqual(['cache', 'database']);
    for (const check of Object.values(response.body.checks)) {
      expect(Object.keys(check as object).sort()).toEqual(['latencyMs', 'status']);
    }

    expect(JSON.stringify(response.body).toLowerCase()).not.toContain('tenant');
  });

  it('refuse un `tenantId` injecté dans le corps et n’en renvoie jamais la valeur', async () => {
    // Le scénario de fuite le plus direct : un client qui pose lui-même le
    // tenant sur lequel il veut écrire. `forbidNonWhitelisted` le rejette au
    // lieu de l'ignorer silencieusement — et la valeur soumise ne doit pas
    // revenir dans la réponse, qui sert de miroir à un attaquant.
    const response = await request(context.app.getHttpServer())
      .post('/api/v1/probe')
      .send({ label: 'coupe', amountMinor: 3500, tenantId: 'tenant_de_la_victime' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('tenant_de_la_victime');
  });

  it('ne divulgue au client ni identifiants de connexion ni donnée personnelle', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/api/v1/probe/boom')
      .expect(500);

    // Le corps est générique et *clos* : pas de `stack`, pas de `cause`, pas de
    // `detail` ajouté par un pilote.
    expect(Object.keys(response.body).sort()).toEqual(['code', 'details', 'message']);
    expect(response.body.details).toEqual({});
  });

  it('n’écrit dans le journal ni mot de passe ni e-mail client', async () => {
    // La contrepartie du test précédent : ce que le client ne voit pas doit
    // quand même être diagnosticable, donc c'est journalisé — et c'est là que la
    // donnée personnelle se retrouve en clair si la rédaction est absente. Le
    // journal du MVP part dans CloudWatch Logs, lisible par toute l'équipe.
    const written: string[] = [];
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        written.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      });

    try {
      await request(context.app.getHttpServer()).get('/api/v1/probe/boom').expect(500);
    } finally {
      spy.mockRestore();
    }

    const journal = written.join('');

    // La trace existe bien : sans elle, ce test passerait pour une mauvaise
    // raison — celle d'un journal muet.
    expect(journal).toContain('DomainExceptionFilter');

    expect(journal).not.toContain('Sup3rS3cret');
    expect(journal).not.toContain('alice@example.test');
    expect(journal).toContain('[rédigé]');
  });
});
