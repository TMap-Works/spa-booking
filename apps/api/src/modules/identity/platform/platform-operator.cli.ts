import { randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

import { normalizeEmail } from '../email';
import {
  PLATFORM_PASSWORD_MAX_LENGTH,
  PLATFORM_PASSWORD_MIN_LENGTH,
} from './platform.types';
import { generateTotpSecret } from './totp';

/**
 * Créer un opérateur plateforme — critère 7 de #806.
 *
 * ```
 * npm run platform:operator -- --email operateur@tmap-works.test \
 *                              --first-name Alice --last-name Durand
 * ```
 *
 * ## Pourquoi une commande, et **jamais** une route
 *
 * Parce qu'il n'y a personne pour autoriser la création du premier opérateur :
 * une route publique qui en crée un serait une porte ouverte sur la console qui
 * ouvre tous les salons, et une route gardée par un opérateur ne résout pas
 * l'amorçage. L'ADR 0012 tranche en faveur d'une commande d'exploitation, jouée
 * par quelqu'un qui a déjà les accès de la base.
 *
 * C'est aussi la raison pour laquelle cette commande ne parle **pas** à
 * l'application : elle ouvre son propre `PrismaClient`, nu, sans l'extension de
 * scoping. Elle est légitimement hors de toute portée — `platform_operators`
 * n'appartient à aucun établissement —, et démarrer Nest pour écrire une ligne
 * aurait exigé la configuration complète de l'API là où seule `DATABASE_URL`
 * est nécessaire.
 *
 * ## Ce qu'elle affiche, et une seule fois
 *
 * Le mot de passe initial, qui n'existe ensuite en base que sous bcrypt. C'est
 * délibéré — un secret qu'on peut redemander est un secret qu'on finit par
 * relire dans un journal.
 *
 * Elle n'affiche **plus** l'URI `otpauth://` du second facteur (#1442).
 * L'opérateur naît non enrôlé, et c'est la console qui lui montre le QR code à
 * sa première connexion, juste après le mot de passe. Le premier code valide
 * confirme l'enrôlement, et le secret ne ressort plus.
 *
 * ## Réarmer l'enrôlement
 *
 * ```
 * npm run platform:operator -- --reset-totp --email operateur@tmap-works.test
 * ```
 *
 * Pour un téléphone perdu ou changé : un nouveau secret est tiré, l'ancien cesse
 * aussitôt de valoir, et la prochaine connexion remontre un QR code. Le mot de
 * passe n'est pas touché.
 *
 * Le mot de passe peut être fourni (`--password`) pour un environnement de
 * recette scripté ; sinon il est tiré au sort, ce qui est le cas nominal.
 */

/** 24 octets d'aléa en base64url — 192 bits, bien au-delà du minimum du DTO. */
const GENERATED_PASSWORD_BYTES = 24;

interface CommandArguments {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly password: string | null;
}

/** `--reset-totp --email …` — réarmer l'enrôlement d'un opérateur existant. */
interface ResetTotpArguments {
  readonly email: string;
}

/**
 * Lit `--clé valeur` et `--clé=valeur`, sans dépendance d'analyse d'arguments.
 *
 * Volontairement minimal : une commande d'exploitation à quatre options n'a pas
 * besoin d'un analyseur, et en ajouter un ferait entrer une dépendance de plus
 * dans une image Docker au périmètre PCI-adjacent.
 */
export function parseArguments(argv: readonly string[]): CommandArguments {
  const values = readOptions(argv);

  const email = (values.get('email') ?? '').trim();
  const firstName = (values.get('first-name') ?? '').trim();
  const lastName = (values.get('last-name') ?? '').trim();
  const password = values.get('password');

  const missing = [
    email === '' ? '--email' : null,
    firstName === '' ? '--first-name' : null,
    lastName === '' ? '--last-name' : null,
  ].filter((option): option is string => option !== null);

  if (missing.length > 0) {
    throw new Error(
      `Options manquantes : ${missing.join(', ')}.\n` +
        'Usage : npm run platform:operator -- --email … --first-name … --last-name … [--password …]',
    );
  }

  const chosen = password === undefined || password.trim() === '' ? null : password;

  // Les mêmes bornes que la route de connexion (`PlatformLoginDto`), et il faut
  // qu'elles soient les mêmes : un mot de passe trop court ou trop long crée un
  // opérateur que le formulaire refuse ensuite en 400, sans recours — le MVP ne
  // prévoit aucune réinitialisation de mot de passe d'opérateur. Le plafond est
  // celui de bcrypt, qui ignorerait silencieusement ce qui dépasse.
  if (
    chosen !== null &&
    (chosen.length < PLATFORM_PASSWORD_MIN_LENGTH || chosen.length > PLATFORM_PASSWORD_MAX_LENGTH)
  ) {
    throw new Error(
      `--password : de ${String(PLATFORM_PASSWORD_MIN_LENGTH)} à ` +
        `${String(PLATFORM_PASSWORD_MAX_LENGTH)} caractères — c'est ce que la connexion ` +
        'de la console exige, et un mot de passe hors bornes créerait un opérateur ' +
        'incapable de se connecter.',
    );
  }

  return {
    email: normalizeEmail(email),
    firstName,
    lastName,
    password: chosen,
  };
}

/** Les options `--clé valeur` et `--clé=valeur` ; un drapeau seul vaut `''`. */
function readOptions(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      continue;
    }
    const separator = token.indexOf('=');
    if (separator !== -1) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(token.slice(2), next);
      index += 1;
    } else {
      values.set(token.slice(2), '');
    }
  }

  return values;
}

/**
 * `--reset-totp --email …`, ou `null` si la commande n'est pas un réarmement.
 *
 * Seule l'adresse est lue : le réarmement ne touche ni au nom ni au mot de passe.
 */
export function parseResetTotpArguments(argv: readonly string[]): ResetTotpArguments | null {
  const values = readOptions(argv);
  const flag = values.get('reset-totp');
  // Drapeau nu ou `=true` : `--reset-totp=false` ne doit pas tirer un secret.
  if (flag === undefined || (flag !== '' && flag !== 'true')) {
    return null;
  }

  const email = (values.get('email') ?? '').trim();
  if (email === '') {
    throw new Error(
      'Option manquante : --email.\n' +
        'Usage : npm run platform:operator -- --reset-totp --email …',
    );
  }

  return { email: normalizeEmail(email) };
}

/** Un mot de passe initial que personne n'a choisi — donc que personne ne réutilise. */
export function generatePassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

/**
 * Tire un nouveau secret et remet l'enrôlement à faire (#1442).
 *
 * Un opérateur introuvable est une erreur dite en clair : c'est une commande
 * d'exploitation, jouée par quelqu'un qui a déjà la base — il n'y a pas
 * d'annuaire à protéger contre lui.
 */
async function resetTotp(prisma: PrismaClient, email: string): Promise<void> {
  const { count } = await prisma.platformOperator.updateMany({
    where: { email },
    data: { totpSecret: generateTotpSecret(), totpConfirmedAt: null },
  });

  if (count === 0) {
    throw new Error(`Aucun opérateur plateforme sous l’adresse ${email}.`);
  }

  process.stdout.write(
    [
      'Second facteur réarmé.',
      `  adresse : ${email}`,
      '',
      'L’ancien code ne vaut plus. À sa prochaine connexion, après le mot de passe,',
      'la console montrera à l’opérateur un QR code à scanner avec son application',
      'd’authentification.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const reset = parseResetTotpArguments(argv);
  if (reset !== null) {
    const prisma = new PrismaClient();
    try {
      await resetTotp(prisma, reset.email);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const args = parseArguments(argv);
  const password = args.password ?? generatePassword();
  const totpSecret = generateTotpSecret();

  // Le coût bcrypt de la commande est fixe et non lu dans la configuration :
  // celle-ci vit dans `AppConfigService`, que la commande ne démarre pas. Douze
  // est la valeur par défaut de `BCRYPT_COST` — un opérateur créé ici a donc la
  // même empreinte que s'il avait été créé par l'application.
  const passwordHash = await hash(password, 12);

  const prisma = new PrismaClient();
  try {
    const operator = await prisma.platformOperator.create({
      data: {
        email: args.email,
        passwordHash,
        totpSecret,
        firstName: args.firstName,
        lastName: args.lastName,
      },
      select: { id: true, email: true },
    });

    // `process.stdout` et non un logger : c'est une commande, sa sortie est son
    // interface. Un logger structuré aurait par ailleurs envoyé le mot de passe
    // dans le flux que CloudWatch collecte.
    process.stdout.write(
      [
        'Opérateur plateforme créé.',
        `  identifiant   : ${operator.id}`,
        `  adresse       : ${operator.email}`,
        `  mot de passe  : ${password}`,
        '  second facteur: à enrôler à la première connexion (QR code)',
        '',
        'Le mot de passe n’est affiché qu’une fois : le transmettre par un canal',
        'sûr, puis effacer cette sortie. Il n’existe en base que sous bcrypt.',
        'À sa première connexion, après le mot de passe, la console montrera à',
        'l’opérateur le QR code à scanner avec son application d’authentification.',
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Exécutée seulement quand le fichier est le point d'entrée : l'analyse des
// arguments et la génération du mot de passe sont exportées pour être testées,
// et les importer ne doit pas ouvrir une connexion à la base.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
