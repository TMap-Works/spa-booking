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

globalThis.fetch = async (_url, init) => {
  const { message } = JSON.parse(init.body);
  const status = responses.get(message.dedupeKey) ?? 202;
  if (status === 'network') throw Object.assign(new Error('coupure'), { name: 'TypeError' });
  return { status };
};

const { handler } = await import('./dispatcher/index.mjs');

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

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  process.stderr.write(`${ok ? 'ok  ' : 'ECHEC'} ${label}\n`);
}

// 1. Le tri des issues. Huit enregistrements, trois seulement rendus à SQS.
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
    ],
  },
  { getRemainingTimeInMillis: () => 30_000 },
);

check(
  'seuls les echecs transitoires sont rendus a SQS',
  trie.batchItemFailures.map((f) => f.itemIdentifier).sort(),
  ['api-en-panne', 'jeton-refuse', 'reseau-coupe'],
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

process.stderr.write('\nFumigation passee : 3 verifications, 0 echec.\n');
