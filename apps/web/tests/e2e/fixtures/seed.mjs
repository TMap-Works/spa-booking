#!/usr/bin/env node
/**
 * Jeu d'essai du parcours critique — #80.
 *
 * ## Pourquoi ce fichier existe, alors que `scripts/mcp/recette_fixture.mjs`
 * pose déjà des établissements
 *
 * Le jeu d'essai de la recette MCP crée **deux établissements et huit comptes,
 * et rien d'autre** : ni prestation, ni praticien, ni horaire. C'est suffisant
 * pour exercer une route au jeton, et insuffisant pour réserver — le tunnel
 * client s'y arrête sur « Ce salon ne propose aucune prestation en ligne pour le
 * moment. ». Le parcours `réserver → confirmer → encaisser` exige un catalogue,
 * des praticiens et des plages travaillées.
 *
 * ## Pourquoi Prisma et non l'API
 *
 * Pour la raison qu'expose déjà le jeu d'essai de la recette : aucune route ne
 * crée un `tenant` — ils viennent de l'exploitation, pas du produit (CDC §2.3).
 * S'y ajoute ici un second manque, vérifié : **aucune route ne crée un `Staff`**.
 * `apps/api/src/modules/catalog/staff.controller.ts` n'expose qu'un `GET`. Sans
 * praticien il n'existe aucun créneau, donc aucun parcours. Le strict nécessaire
 * est donc posé en base, et tout le reste du scénario passe par l'IHM.
 *
 * ## Trois propriétés qui comptent
 *
 * - **Idempotent** — rejouable autant de fois que la suite est rejouée.
 * - **Table rase transactionnelle** — les rendez-vous, paiements et ventes de
 *   l'établissement d'essai sont effacés à chaque amorçage. Sans cela, la
 *   journée d'encaissement et le planning accumulent les exécutions précédentes,
 *   et « le premier créneau libre » cesse d'être une notion stable.
 * - **Cloisonné** — un établissement dédié (`e2e-parcours` par défaut), distinct
 *   de ceux de la recette MCP. Aucune suite ne partage ses données avec une
 *   autre, et un `E2E_TENANT_SLUG` permet d'en ouvrir un second.
 *
 * ## La semaine est ouverte en entier, délibérément
 *
 * Les sept jours sont ouverts de 08:00 à 20:00, pour l'établissement comme pour
 * chaque praticien. Une suite qui ne serait verte que du lundi au vendredi
 * serait une suite qui rougit le samedi pour une raison qui n'est pas un défaut
 * du produit — et le parcours critique est précisément ce qui ne doit jamais
 * rougir à tort.
 *
 * Le mot de passe est en clair : donnée de développement, écrite dans une base
 * locale jetable. Rien de ce fichier ne part en déployé.
 *
 * Sortie : une seule ligne de JSON sur stdout, lue par `global-setup.ts`.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Le client Prisma est généré dans `apps/api/node_modules/.prisma` : c'est
// depuis le paquet `@spa/api` qu'il faut le résoudre, pas depuis `apps/web`.
const require = createRequire(new URL('../../../../api/package.json', import.meta.url));

export const MOT_DE_PASSE = 'Recette-2026!';
const FUSEAU = 'Europe/Paris';
const DEVISE = 'EUR';

/** ISO 8601 — 1 lundi … 7 dimanche (`packages/shared/src/schemas/availability.ts`). */
const JOURS_ISO = [1, 2, 3, 4, 5, 6, 7];
const OUVERTURE_MINUTE = 8 * 60;
const FERMETURE_MINUTE = 20 * 60;

/** Les quatre rôles du MVP. Le comptoir se connecte en `STAFF`, le plus bas rang autorisé. */
const COMPTES = [
  { role: 'ADMIN', email: 'admin@e2e.test', firstName: 'Ada', lastName: 'Parcours' },
  { role: 'MANAGER', email: 'manager@e2e.test', firstName: 'Marc', lastName: 'Parcours' },
  { role: 'STAFF', email: 'staff@e2e.test', firstName: 'Sam', lastName: 'Parcours' },
  { role: 'CLIENT', email: 'client@e2e.test', firstName: 'Clara', lastName: 'Parcours' },
];

/**
 * Les praticiens. Deux et non un : le report au comptoir doit pouvoir changer de
 * praticien, ce qui est le seul chemin qui ouvre la confirmation
 * « Changer de praticien ? » de `calendar-move-confirm.tsx`.
 */
const PRATICIENS = [
  { email: 'nina@e2e.test', firstName: 'Nina', lastName: 'Parcours', displayName: 'Nina P.' },
  { email: 'omar@e2e.test', firstName: 'Omar', lastName: 'Parcours', displayName: 'Omar P.' },
];

const CATEGORIE = { slug: 'soins-du-corps', name: 'Soins du corps' };

/**
 * Une seule prestation, et c'est voulu : le tunnel se choisit par libellé, et un
 * catalogue à une entrée rend le choix non ambigu sans dépendre de l'ordre de
 * tri. Soixante minutes tombent juste sur le pas de 15 minutes du calendrier.
 */
const PRESTATION = {
  slug: 'massage-signature',
  name: 'Massage signature',
  description: 'Massage du corps entier, huiles chaudes.',
  durationMinutes: 60,
  priceAmountMinor: 6000,
  priceCurrency: DEVISE,
};

function argument(nom, defaut) {
  const index = process.argv.indexOf(nom);
  return index === -1 || index === process.argv.length - 1 ? defaut : process.argv[index + 1];
}

/**
 * Efface ce qu'une exécution précédente a inscrit, sans toucher au référentiel.
 *
 * L'ordre suit les clés étrangères : un remboursement pointe un paiement, qui
 * pointe un rendez-vous. `deleteMany` sur un modèle absent du schéma lèverait —
 * d'où la garde, qui laisse ce fichier survivre à l'ajout ou au retrait d'une
 * table transactionnelle sans devenir un point de panne du parcours.
 */
async function tableRase(prisma, tenantId) {
  const ordre = [
    'paymentRefund',
    'payment',
    'saleItem',
    'sale',
    'notification',
    'processedWebhookEvent',
    'appointment',
  ];

  for (const modele of ordre) {
    const delegue = prisma[modele];
    if (typeof delegue?.deleteMany !== 'function') {
      continue;
    }
    await delegue.deleteMany({ where: { tenantId } });
  }
}

async function poserUtilisateur(prisma, tenantId, empreinte, compte) {
  return prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: compte.email } },
    update: {
      passwordHash: empreinte,
      role: compte.role,
      firstName: compte.firstName,
      lastName: compte.lastName,
      isActive: true,
    },
    create: {
      tenantId,
      email: compte.email,
      role: compte.role,
      passwordHash: empreinte,
      firstName: compte.firstName,
      lastName: compte.lastName,
    },
  });
}

async function poserPraticien(prisma, tenantId, empreinte, praticien) {
  const utilisateur = await poserUtilisateur(prisma, tenantId, empreinte, {
    ...praticien,
    role: 'STAFF',
  });

  const staff = await prisma.staff.upsert({
    where: { tenantId_userId: { tenantId, userId: utilisateur.id } },
    update: { displayName: praticien.displayName, isActive: true },
    create: {
      tenantId,
      userId: utilisateur.id,
      displayName: praticien.displayName,
      isActive: true,
    },
  });

  // Remplacées et non complétées : rejouer le jeu d'essai ne doit pas empiler
  // sept plages de plus, que le moteur lirait comme des recouvrements.
  await prisma.staffSchedule.deleteMany({ where: { tenantId, staffId: staff.id } });
  await prisma.staffSchedule.createMany({
    data: JOURS_ISO.map((weekday) => ({
      tenantId,
      staffId: staff.id,
      weekday,
      startMinute: OUVERTURE_MINUTE,
      endMinute: FERMETURE_MINUTE,
    })),
  });

  return { id: staff.id, userId: utilisateur.id, displayName: staff.displayName };
}

export async function amorcer({ slug, prisma, bcrypt }) {
  const empreinte = await bcrypt.hash(MOT_DE_PASSE, 10);

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    update: { name: 'Parcours critique', isActive: true, timezone: FUSEAU },
    create: {
      slug,
      name: 'Parcours critique',
      timezone: FUSEAU,
      defaultCurrency: DEVISE,
      isActive: true,
      slotIntervalMinutes: 15,
      minBookingNoticeMinutes: 60,
    },
  });

  await tableRase(prisma, tenant.id);

  await prisma.tenantOpeningHour.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenantOpeningHour.createMany({
    data: JOURS_ISO.map((weekday) => ({
      tenantId: tenant.id,
      weekday,
      startMinute: OUVERTURE_MINUTE,
      endMinute: FERMETURE_MINUTE,
    })),
  });

  // Aucun jour de fermeture : la suite doit trouver un créneau quel que soit le
  // jour où elle tourne.
  if (typeof prisma.tenantClosingDay?.deleteMany === 'function') {
    await prisma.tenantClosingDay.deleteMany({ where: { tenantId: tenant.id } });
  }

  const comptes = [];
  for (const compte of COMPTES) {
    const utilisateur = await poserUtilisateur(prisma, tenant.id, empreinte, compte);
    comptes.push({ role: compte.role, email: compte.email, id: utilisateur.id });
  }

  const praticiens = [];
  for (const praticien of PRATICIENS) {
    praticiens.push(await poserPraticien(prisma, tenant.id, empreinte, praticien));
  }

  const categorie = await prisma.serviceCategory.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: CATEGORIE.slug } },
    update: { name: CATEGORIE.name, isActive: true },
    create: { tenantId: tenant.id, slug: CATEGORIE.slug, name: CATEGORIE.name, isActive: true },
  });

  const prestation = await prisma.service.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: PRESTATION.slug } },
    update: { ...PRESTATION, categoryId: categorie.id, isActive: true },
    create: { ...PRESTATION, tenantId: tenant.id, categoryId: categorie.id, isActive: true },
  });

  for (const praticien of praticiens) {
    await prisma.serviceStaff.upsert({
      where: {
        tenantId_serviceId_staffId: {
          tenantId: tenant.id,
          serviceId: prestation.id,
          staffId: praticien.id,
        },
      },
      update: {},
      create: { tenantId: tenant.id, serviceId: prestation.id, staffId: praticien.id },
    });
  }

  return {
    motDePasse: MOT_DE_PASSE,
    etablissement: { id: tenant.id, slug: tenant.slug, nom: tenant.name, fuseau: FUSEAU },
    comptes,
    praticiens,
    prestation: {
      id: prestation.id,
      slug: prestation.slug,
      nom: prestation.name,
      dureeMinutes: prestation.durationMinutes,
      prixMineur: prestation.priceAmountMinor,
      devise: prestation.priceCurrency,
    },
  };
}

async function main() {
  const slug =
    String(argument('--slug', process.env.E2E_TENANT_SLUG || 'e2e-parcours'))
      .replace(/[^0-9a-z-]/gi, '')
      .toLowerCase() || 'e2e-parcours';

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
    return;
  }

  const prisma = new PrismaClient();
  try {
    const jeu = await amorcer({ slug, prisma, bcrypt });
    process.stdout.write(`${JSON.stringify(jeu)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// Exécuté directement — et non importé par une suite qui n'en voudrait que les
// constantes. `pathToFileURL` et non une concaténation « file:// » : sous
// Windows, le chemin porte une lettre de lecteur et, ici, une esperluette — que
// seule cette fonction encode comme le fait `import.meta.url`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((erreur) => {
    process.stderr.write(`${erreur?.stack || erreur}\n`);
    process.exit(1);
  });
}
