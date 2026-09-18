/**
 * Fumigation de la Lambda d'envoi — `node dispatcher.smoke.mjs` depuis ce dossier.
 *
 * ## Pourquoi ce fichier existe, et pourquoi il est ici
 *
 * Les deux critères de reprise de #67 — « les reprises sont laissées à SQS » et
 * « les échecs permanents ne sont pas rejoués » — ne se prouvent ni par
 * `terraform validate`, qui ne lit pas de JavaScript, ni par la lecture du
 * handler : ce sont des affirmations sur ce que la fonction **rend**. Ce script
 * les exerce.
 *
 * Il est **hors** de `lambda/dispatcher/`, le répertoire qu'`archive_file`
 * empaquette : un fichier de test n'a rien à faire dans l'artefact déployé, et
 * l'exclure par filtre serait un réglage de plus à ne pas oublier. `run-smoke.mjs`
 * refuse désormais tout fichier de test trouvé dans un répertoire empaqueté —
 * la disposition est tenue par une garde, plus par la seule convention.
 *
 * Depuis #496, il est joué par `npm run verify` et par le job `test` de
 * `ci.yml` : la cible `test:smoke:lambda` appelle `run-smoke.mjs`, qui découvre
 * les `*.smoke.mjs` de ce dossier et les exécute.
 */

import { readFileSync } from 'node:fs';

process.env.ENVIRONMENT = 'smoke';
process.env.DISPATCH_URL = 'https://api.exemple.test/interne/notifications/dispatch';
process.env.DISPATCH_TIMEOUT_MS = '1000';

/** Réponse que l'API rendra pour une clé de déduplication donnée. */
const responses = new Map([
  ['envoye', 202],
  ['deja-pris', 409],
  ['adresse-morte', 422],
  ['api-en-panne', 503],
  ['jeton-refuse', 401],
  ['reseau-coupe', 'network'],
]);

/**
 * Les clés de déduplication qui ont **atteint l'API**.
 *
 * C'est la seule preuve qu'une enveloppe a été *acceptée* : un rejet d'enveloppe
 * et un échec permanent rendu par l'API sont indiscernables dans
 * `batchItemFailures`, tous deux étant acquittés. Ce qui les sépare est qu'un
 * rejet d'enveloppe n'appelle jamais `fetch`.
 */
const sollicitees = [];

globalThis.fetch = async (_url, init) => {
  const { message } = JSON.parse(init.body);
  sollicitees.push(message.dedupeKey);
  const status = responses.get(message.dedupeKey) ?? 202;
  if (status === 'network') throw Object.assign(new Error('coupure'), { name: 'TypeError' });
  return { status };
};

/**
 * Le journal du handler, capté pour y lire les **raisons** de rejet.
 *
 * Sans cela, « refusée » ne se distinguerait pas de « refusée pour la bonne
 * raison » : c'est précisément la confusion entre `missing-appointment-id` et
 * `invalid-appointment-id` que #1032 demande de tenir. Les lignes sont
 * repassées à la sortie standard — une fumigation qui avale les journaux du
 * code qu'elle exerce ne se diagnostique plus quand elle rougit.
 */
const journal = [];
/**
 * Les mêmes lignes, **non analysées**.
 *
 * Le journal structuré ne suffit pas à prouver qu'un secret n'est pas sorti :
 * une ligne non JSON — un `console.log` de débogage laissé derrière soi, une
 * trace du runtime — n'y entre pas, et c'est précisément le genre de ligne par
 * laquelle un jeton s'échappe.
 */
const lignesJournal = [];
const ecrireStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...reste) => {
  for (const ligne of String(chunk).split('\n')) {
    if (ligne.length === 0) continue;
    lignesJournal.push(ligne);
    try {
      journal.push(JSON.parse(ligne));
    } catch {
      // Ligne non JSON : rien à en lire, et ce n'est pas à la fumigation d'en juger.
    }
  }
  return ecrireStdout(chunk, ...reste);
};

/** Les rejets d'enveloppe, par identifiant de message. */
const rejets = () =>
  Object.fromEntries(
    journal
      .filter((ligne) => ligne.event === 'notification.rejected')
      .map((ligne) => [ligne.messageId, ligne.reason]),
  );

/**
 * Le jeton de réinitialisation en clair, tel que l'enveloppe #809 le porte.
 *
 * C'est la **seule** valeur de tout le contrat d'enveloppe qui ne soit pas un
 * identifiant : elle ouvre un compte pendant trente minutes, et la base n'en
 * garde que l'empreinte. Elle traverse SQS puis cette Lambda, dont les journaux
 * partent en CloudWatch — d'où la vérification plus bas.
 */
const JETON_EN_CLAIR = 'JETON-REINITIALISATION-QUI-NE-DOIT-JAMAIS-ETRE-JOURNALISE';

const { handler, NOTIFICATION_TYPES } = await import('./dispatcher/index.mjs');

const record = (dedupeKey, overrides = {}) => ({
  messageId: dedupeKey,
  body: JSON.stringify({
    tenantId: 'tenant-1',
    dedupeKey,
    appointmentId: 'rdv-1',
    recipientUserId: 'compte-1',
    type: 'REMINDER_24H',
    channel: 'EMAIL',
    scheduledFor: null,
    ...overrides,
  }),
});

const failures = [];
// Compté plutôt qu'écrit en dur dans le message final : le nombre de
// vérifications a déjà dérivé une fois de ce que la sortie annonçait.
let verifications = 0;

function check(label, actual, expected) {
  verifications += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  process.stderr.write(`${ok ? 'ok  ' : 'ECHEC'} ${label}\n`);
}

// 1. Le tri des issues. Seize enregistrements, trois seulement rendus à SQS —
//    quatre partis, un ignoré, huit en échec permanent.
//    `jeton-refuse` en fait partie : un 401 ne dit rien du message, il dit que
//    la fonction ne s'est pas fait reconnaître. L'acquitter le supprimerait de
//    la file sans qu'il passe par la DLQ — il n'y aurait plus rien à rejouer une
//    fois le jeton corrigé.
const trie = await handler(
  {
    Records: [
      record('envoye'),
      record('deja-pris'),
      record('adresse-morte'),
      record('api-en-panne'),
      record('jeton-refuse'),
      record('reseau-coupe'),
      { messageId: 'illisible', body: '{ pas du json' },
      record('type-inconnu', { type: 'MARKETING' }),
      // Depuis #71, une enveloppe sans tenant est un échec permanent : le
      // consommateur ouvre sa portée dessus, et la traiter sans lui serait la
      // traiter hors portée.
      record('sans-tenant', { tenantId: '' }),

      // --- Le lien de réinitialisation (#809, miroir posé par #1032) ---------
      //
      // Ce message n'annonce aucun rendez-vous : son enveloppe porte `null`, et
      // le producteur qui omettrait le champ envoie la même chose. Les deux
      // formes doivent atteindre l'API. Elles ont été rejetées en échec
      // permanent dans tout environnement branché jusqu'à #1032 — donc comptées
      // dans `PermanentFailures`, dont l'alarme sonnait pour une panne qui n'en
      // était pas une.
      record('reinit-rdv-nul', { type: 'PASSWORD_RESET', appointmentId: null }),
      // `undefined` disparaît à la sérialisation : le champ est absent, pas nul.
      record('reinit-rdv-absent', { type: 'PASSWORD_RESET', appointmentId: undefined }),
      // L'enveloppe complète, jeton compris — celle que `password-reset.listener.ts`
      // publie réellement. Elle doit atteindre l'API *et* ne rien laisser du jeton
      // derrière elle.
      record('reinit-jeton-en-clair', {
        type: 'PASSWORD_RESET',
        appointmentId: null,
        passwordResetToken: JETON_EN_CLAIR,
      }),

      // --- Ce que l'élargissement ne doit pas relâcher -----------------------
      //
      // Un message qui annonce un rendez-vous doit le nommer. Sans cette garde,
      // accepter l'absence pour la réinitialisation l'aurait acceptée pour les
      // trois messages du CDC §1.4, où elle ne veut rien dire.
      record('rdv-sans-identifiant', { appointmentId: null }),
      record('rdv-identifiant-absent', { appointmentId: undefined }),
      // Présent mais mal formé : un producteur qui annonce un rendez-vous *mal*,
      // et non un producteur qui n'en annonce aucun. Vrai pour tous les types.
      record('rdv-identifiant-vide', { appointmentId: '' }),
      record('reinit-identifiant-numerique', { type: 'PASSWORD_RESET', appointmentId: 42 }),
    ],
  },
  { getRemainingTimeInMillis: () => 30_000 },
);

check(
  'seuls les echecs transitoires sont rendus a SQS',
  trie.batchItemFailures.map((f) => f.itemIdentifier).sort(),
  ['api-en-panne', 'jeton-refuse', 'reseau-coupe'],
);

// 1bis. Les deux formes d'enveloppe de réinitialisation atteignent l'API, et
//       elles seules parmi les nouvelles : ce que `batchItemFailures` ne peut
//       pas dire, un rejet d'enveloppe et un 4xx s'acquittant tous deux.
check(
  "l'enveloppe de reinitialisation sans rendez-vous atteint l'API",
  sollicitees.filter((cle) => cle.startsWith('reinit-')).sort(),
  ['reinit-jeton-en-clair', 'reinit-rdv-absent', 'reinit-rdv-nul'],
);

// 1quater. Et le jeton de réinitialisation n'a rien laissé au journal.
//
//    Le contexte journalisé est composé champ par champ dans `handleRecord` ;
//    rien, dans le fichier, ne dit ce qui se passerait si on l'écrivait
//    `{ ...message }` un jour de refactorisation. Ce serait le jeton d'ouverture
//    de compte en clair dans CloudWatch Logs, valable trente minutes, et aucune
//    barrière existante ne rougirait (CDC §5.1, notifications §7).
check(
  "le jeton de reinitialisation n'atteint jamais le journal",
  lignesJournal.filter((ligne) => ligne.includes(JETON_EN_CLAIR)),
  [],
);

// 1ter. Et les raisons, pour que « refusée » veuille dire « refusée pour ce
//       qui manque » — l'absence et la valeur mal formée ne se réparent pas au
//       même endroit.
check(
  "le rendez-vous reste exige des messages qui en annoncent un",
  (() => {
    const lus = rejets();
    return [
      'rdv-sans-identifiant',
      'rdv-identifiant-absent',
      'rdv-identifiant-vide',
      'reinit-identifiant-numerique',
    ].map((id) => `${id}=${lus[id] ?? 'accepte'}`);
  })(),
  [
    'rdv-sans-identifiant=missing-appointment-id',
    'rdv-identifiant-absent=missing-appointment-id',
    'rdv-identifiant-vide=invalid-appointment-id',
    'reinit-identifiant-numerique=invalid-appointment-id',
  ],
);

// 1quinquies. Le témoin du miroir lui-même.
//
//    C'est la panne de #1032, prise à sa racine : le contrat d'enveloppe existe
//    en deux exemplaires — `notifications.types.ts` côté domaine, ce fichier-ci
//    côté transport — et rien ne les liait. Le README prescrivait déjà de les
//    élargir d'un même lot ; une prescription n'avait pas suffi. La forme est
//    celle du témoin que `__tests__/notifications.types.spec.ts` tient entre le
//    domaine et `schema.prisma`, portée à la frontière suivante.
//
//    Lecture du fichier plutôt qu'import : c'est du TypeScript, et cette
//    fumigation est jouée par `node` nu. La lecture qui échoue fait rougir —
//    une barrière qui ne trouve plus ce qu'elle compare n'a rien exercé (#326).
check(
  'le miroir de la lambda enumere exactement les types du domaine',
  [...NOTIFICATION_TYPES],
  (() => {
    const chemin = new URL(
      '../../../../../apps/api/src/modules/notifications/notifications.types.ts',
      import.meta.url,
    );

    try {
      const bloc = /export const NOTIFICATION_TYPES = \[([\s\S]*?)\] as const;/.exec(
        readFileSync(chemin, 'utf8'),
      );
      if (bloc === null) return ['NOTIFICATION_TYPES introuvable dans notifications.types.ts'];

      // Les commentaires d'abord : ils portent des apostrophes françaises, que
      // l'extraction des littéraux prendrait sinon pour des guillemets.
      return [...bloc[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    } catch (erreur) {
      return [`lecture impossible de ${chemin.pathname} : ${erreur.code ?? erreur.name}`];
    }
  })(),
);

// 2. La garde de fin de temps imparti : le reste du lot est rendu explicitement
//    plutôt que tué en vol.
const serre = await handler({ Records: [record('envoye'), record('envoye')] }, {
  getRemainingTimeInMillis: () => 100,
});

check(
  'le lot est rendu quand le temps imparti manque',
  serre.batchItemFailures.length,
  2,
);

// 3. Sans destination, rien n'est acquitté : la chaîne non branchée se voit.
process.env.DISPATCH_URL = '';
const nonConfigure = await import(`./dispatcher/index.mjs?variante=${Date.now()}`);
const ferme = await nonConfigure.handler({ Records: [record('envoye')] }, {
  getRemainingTimeInMillis: () => 30_000,
});

check('defaut ferme sans dispatch_url', ferme.batchItemFailures.length, 1);

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n')}\n`);
  process.exit(1);
}

process.stderr.write(`\nFumigation passee : ${verifications} verifications, 0 echec.\n`);
