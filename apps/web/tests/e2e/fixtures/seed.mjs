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
 *
 * **78,00 € et non un montant rond**, depuis #835 : c'est le ticket du huitième
 * critère, celui que `reglement-comptoir.e2e.ts` règle en 50,00 € d'espèces puis
 * 28,00 € au terminal. Un prix qui ne se divise pas en deux parts égales est ce
 * qui rend le scénario lisible — les deux montants du reçu ne peuvent pas être
 * confondus l'un avec l'autre. L'établissement n'a pas de taux de taxe, si bien
 * que le total du ticket **est** ce prix.
 */
const PRESTATION = {
  slug: 'massage-signature',
  name: 'Massage signature',
  description: 'Massage du corps entier, huiles chaudes.',
  durationMinutes: 60,
  priceAmountMinor: 7800,
  priceCurrency: DEVISE,
};

/**
 * L'heure UTC à laquelle `poserRendezVousCommence` place son décor.
 *
 * 10 h UTC vaut 11 h ou 12 h à Paris selon la saison : les deux tombent au
 * milieu des heures d'ouverture du jeu d'essai (08 h – 20 h), donc au milieu du
 * cadrage par défaut du planning, et la **date civile du salon** est alors celle
 * de la journée UTC demandée — ce qui n'est pas vrai d'une heure de fin de
 * soirée. Aucun calcul de fuseau n'est nécessaire à ce prix-là.
 */
const HEURE_DU_DECOR = '10:00:00.000Z';

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

/**
 * Pose un rendez-vous **déjà commencé** — la mise en situation que la porte de
 * comptoir ne sait pas faire (#1210).
 *
 * ## Pourquoi elle est ici, et pas dans `support/api.ts`
 *
 * Parce qu'aucune route ne peut la produire, et que ce n'est pas un oubli : le
 * moteur de disponibilité ne propose que des créneaux postérieurs à
 * `now + minBookingNoticeMinutes`, et `POST /appointments` n'accepte que des
 * créneaux que le moteur a rendus (`offeredStaffAt`). Le comptoir ne réserve
 * donc jamais dans le passé, ce qui est la bonne règle — et ce qui laisse un
 * scénario sans moyen d'éprouver « Marquer non honoré », qui n'existe **que**
 * sur un rendez-vous commencé depuis #1137.
 *
 * C'est exactement le motif pour lequel ce fichier écrit en base : le produit
 * n'expose pas le geste, et l'inventer par l'IHM reviendrait à éprouver un
 * moteur de disponibilité truqué plutôt que le tiroir du comptoir.
 *
 * ## Ce qu'elle écrit, et ce qu'elle n'écrit pas
 *
 * L'intervalle posé est l'intervalle **occupé** — celui de la colonne, tampons
 * compris —, dérivé de l'heure du soin exactement comme le fait
 * `AppointmentsService.occupiedRange`. L'API rendra l'intervalle *facturé* à
 * partir de là, c'est-à-dire l'heure demandée ici : les deux bouts se
 * retrouvent.
 *
 * Le rendez-vous naît `CONFIRMED` : `no_show` et `completed` ne sont
 * atteignables que depuis là (`APPOINTMENT_STATUS_TRANSITIONS`), et le passage
 * `pending → confirmed` est exercé à l'écran par le parcours critique.
 *
 * Aucun paiement, aucune notification, aucun événement : ce n'est pas une
 * réservation, c'est un décor.
 *
 * ## `jour` est une journée **passée**, et l'heure est fixe
 *
 * Un rendez-vous posé « il y a trente minutes » serait commencé, mais à une
 * heure qui dépend de celle du runner : une suite lancée à 3 h du matin le
 * placerait hors des heures d'ouverture, donc en tête d'une grille virtualisée
 * dont le scénario devrait défiler pour le voir. Une journée passée le rend
 * commencé quelle que soit l'heure d'exécution, et `HEURE_DU_DECOR` le place au
 * milieu du cadrage par défaut du planning (08 h – 20 h), où la grille le monte
 * sans défilement.
 */
export async function poserRendezVousCommence({ prisma, slug, jour }) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (tenant === null) {
    throw new Error(`Établissement « ${slug} » introuvable : le jeu d'essai n'a pas été amorcé.`);
  }

  const service = await prisma.service.findFirst({
    where: { tenantId: tenant.id, slug: PRESTATION.slug },
  });
  const staff = await prisma.staff.findFirst({
    where: { tenantId: tenant.id, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  const cliente = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: 'CLIENT' },
  });

  if (service === null || staff === null || cliente === null) {
    throw new Error(
      "Le jeu d'essai est incomplet : prestation, praticien ou compte cliente manquant.",
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jour))) {
    throw new Error(`« ${jour} » n'est pas une date civile AAAA-MM-JJ.`);
  }

  // L'heure du **soin**, celle que l'API rend et que la règle du constat
  // compare — jamais l'intervalle occupé, qui est ce qu'on écrit plus bas.
  const debutDuSoin = new Date(`${jour}T${HEURE_DU_DECOR}`);

  if (debutDuSoin.getTime() >= Date.now()) {
    throw new Error(
      `Le décor doit être commencé : ${debutDuSoin.toISOString()} n'est pas dans le passé.`,
    );
  }

  const occupeDebut = new Date(debutDuSoin.getTime() - service.bufferBeforeMinutes * 60_000);
  const occupeFin = new Date(
    debutDuSoin.getTime() + (service.durationMinutes + service.bufferAfterMinutes) * 60_000,
  );

  const rendezVous = await prisma.appointment.create({
    data: {
      tenantId: tenant.id,
      clientId: cliente.id,
      staffId: staff.id,
      serviceId: service.id,
      reference: referenceTiree(),
      startsAt: occupeDebut,
      endsAt: occupeFin,
      status: 'CONFIRMED',
      priceAmountMinor: service.priceAmountMinor,
      priceCurrency: service.priceCurrency,
    },
  });

  return {
    id: rendezVous.id,
    reference: rendezVous.reference,
    startsAt: debutDuSoin.toISOString(),
    staffId: staff.id,
    clientId: cliente.id,
  };
}

/**
 * Une référence `RDV-XXXX-NN` tirée au hasard, dans l'alphabet de Crockford.
 *
 * Le décor n'a pas à passer par le tirage du serveur — il n'a pas d'API — mais
 * la colonne est unique par établissement et contrainte de format
 * (`APPOINTMENT_REFERENCE_PATTERN`) : une référence inventée hors de l'alphabet
 * passerait la base et échouerait à la lecture, au schéma du contrat.
 */
function referenceTiree() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const groupe = Array.from(
    { length: 4 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join('');
  const suffixe = String(Math.floor(Math.random() * 100)).padStart(2, '0');

  return `RDV-${groupe}-${suffixe}`;
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
    // Deux modes, et le second ne fait **pas** table rase : il ajoute un décor à
    // un jeu d'essai déjà posé, pendant que la suite tourne (#1210).
    if (process.argv.includes('--rendez-vous-commence')) {
      const rendezVous = await poserRendezVousCommence({
        prisma,
        slug,
        jour: argument('--jour', ''),
      });
      process.stdout.write(`${JSON.stringify(rendezVous)}\n`);
      return;
    }

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
