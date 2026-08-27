#!/usr/bin/env node
/**
 * Jeu d'essai de la recette fonctionnelle — appelé par l'outil MCP
 * `api_jeu_dessai` (`scripts/mcp/recette_server.py`).
 *
 * ## Pourquoi écrire en base plutôt que passer par l'API
 *
 * Il n'existe aucune route qui crée un établissement : les `tenants` viennent de
 * l'exploitation, pas du produit (CDC §2.3). Sans ligne dans cette table, aucune
 * connexion n'aboutit, donc aucune route authentifiée ne s'exerce — et la
 * recette se limiterait à l'espace public. On pose donc le strict nécessaire par
 * Prisma : deux établissements et cinq comptes.
 *
 * ## Trois propriétés qui comptent
 *
 * - **Idempotent** : rejouable autant de fois que la recette est rejouée.
 * - **Cloisonné par ticket** : `recette-42` et `recette-43` ne se voient pas.
 *   Deux agents d'une même vague écrivent dans la même base sans se marcher
 *   dessus, et une assertion de comptage reste vraie.
 * - **Un établissement voisin** : `recette-42-voisin`, avec son propre
 *   administrateur. C'est lui qui rend la sonde d'isolation possible — appeler
 *   la route avec son jeton doit rendre 404, jamais la donnée du premier.
 *
 * Le mot de passe est en clair ici : c'est une donnée de développement, écrite
 * dans une base locale jetable, jamais un secret. Rien de ce fichier ne part en
 * déployé.
 *
 * Sortie : une seule ligne de JSON sur stdout — le serveur MCP ne lit que celle-là.
 */

import { createRequire } from 'node:module';

// Le client Prisma est généré dans `apps/api/node_modules/.prisma` : c'est
// depuis le paquet `@spa/api` qu'il faut le résoudre, pas depuis la racine.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));

const MOT_DE_PASSE = 'Recette-2026!';
const FUSEAU = 'Europe/Paris';
const DEVISE = 'EUR';

/** Les quatre rôles du MVP, chacun avec son compte — la recette n'a pas à en créer. */
const COMPTES = [
  { role: 'ADMIN', email: 'admin@recette.test', firstName: 'Ada', lastName: 'Recette' },
  { role: 'MANAGER', email: 'manager@recette.test', firstName: 'Marc', lastName: 'Recette' },
  { role: 'STAFF', email: 'staff@recette.test', firstName: 'Sam', lastName: 'Recette' },
  { role: 'CLIENT', email: 'client@recette.test', firstName: 'Clara', lastName: 'Recette' },
];

function argument(nom, defaut) {
  const index = process.argv.indexOf(nom);
  return index === -1 || index === process.argv.length - 1 ? defaut : process.argv[index + 1];
}

async function poser(prisma, empreinte, slug, nom) {
  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: { name: nom, isActive: true },
    create: { slug, name: nom, timezone: FUSEAU, defaultCurrency: DEVISE, isActive: true },
  });

  const comptes = [];
  for (const compte of COMPTES) {
    const utilisateur = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: compte.email } },
      update: { passwordHash: empreinte, role: compte.role, isActive: true },
      create: {
        tenantId: tenant.id,
        email: compte.email,
        role: compte.role,
        passwordHash: empreinte,
        firstName: compte.firstName,
        lastName: compte.lastName,
      },
    });
    comptes.push({ role: compte.role, email: compte.email, id: utilisateur.id });
  }

  return { id: tenant.id, slug: tenant.slug, nom: tenant.name, comptes };
}

async function main() {
  const ticket = String(argument('--ticket', '0')).replace(/[^0-9a-z-]/gi, '') || '0';

  let PrismaClient;
  let bcrypt;
  try {
    ({ PrismaClient } = require('@prisma/client'));
    bcrypt = require('bcryptjs');
  } catch (erreur) {
    process.stderr.write(
      `Client Prisma indisponible (${erreur.message}). Lancer « npm run db:generate ».\n`,
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    // Coût 10 et non celui de BCRYPT_COST : ces comptes sont recréés à chaque
    // recette, et le quart de seconde par hachage se paierait cinq fois.
    const empreinte = await bcrypt.hash(MOT_DE_PASSE, 10);

    const principal = await poser(prisma, empreinte, `recette-${ticket}`, `Recette ${ticket}`);
    const voisin = await poser(
      prisma,
      empreinte,
      `recette-${ticket}-voisin`,
      `Recette ${ticket} — voisin`,
    );

    process.stdout.write(
      `${JSON.stringify({
        ticket,
        motDePasse: MOT_DE_PASSE,
        etablissement: principal,
        voisin,
        connexion: {
          route: 'POST /api/v1/auth/login',
          corps: { tenantSlug: principal.slug, email: 'admin@recette.test', password: MOT_DE_PASSE },
        },
        rappel:
          "Le voisin sert la sonde d'isolation : la même route, avec son jeton, doit rendre 404 — jamais la donnée de l'établissement principal.",
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((erreur) => {
  process.stderr.write(`${erreur?.stack || erreur}\n`);
  process.exit(1);
});
