import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import { PrismaService } from '../prisma.service';

/**
 * Ce que ce test protège tient en une phrase : **le conteneur doit démarrer même
 * si PostgreSQL ne répond pas.**
 *
 * C'est la contrepartie du choix de ne pas appeler `$connect()` à
 * l'initialisation. Si quelqu'un ajoute un jour un `OnModuleInit` qui se
 * connecte, une base injoignable fera échouer le démarrage de la tâche ECS, qui
 * repartira en boucle de redémarrage — au lieu d'être simplement retirée du
 * service par la sonde `/health`. Le symptôme se lit alors comme une panne de
 * déploiement, pas comme une panne de base.
 */
describe('PrismaService', () => {
  // Adresse volontairement injoignable : le port n'écoute rien.
  const config = {
    databaseUrl: 'postgresql://spa:spa@127.0.0.1:1/spa_absent',
  } as AppConfigService;

  const logger = { warn: jest.fn() } as unknown as StructuredLogger;

  it('se construit sans ouvrir de connexion, base absente ou non', () => {
    expect(() => new PrismaService(config, logger)).not.toThrow();
  });

  it('se ferme proprement sans jamais avoir été connecté', async () => {
    const service = new PrismaService(config, logger);
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
