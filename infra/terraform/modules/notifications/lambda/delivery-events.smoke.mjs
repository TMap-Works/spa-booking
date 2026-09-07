/**
 * Fumigation de la Lambda de traitement des rebonds — `node
 * delivery-events.smoke.mjs` depuis ce dossier.
 *
 * ## Pourquoi ce fichier existe, et pourquoi il est ici
 *
 * Les affirmations de #73 côté transport — « un événement illisible n'est jamais
 * rejoué », « un refus d'authentification l'est », « aucune adresse ne part au
 * journal » — ne se prouvent ni par `terraform validate`, qui ne lit pas de
 * JavaScript, ni par la lecture du handler : ce sont des affirmations sur ce que
 * la fonction **rend** et sur ce qu'elle **écrit**. Ce script les exerce.
 *
 * Il est **hors** de `lambda/delivery-events/`, le répertoire qu'`archive_file`
 * empaquette : un fichier de test n'a rien à faire dans l'artefact déployé, et
 * l'exclure par filtre serait un réglage de plus à ne pas oublier. Même
 * disposition que `dispatcher.smoke.mjs` et `reminder-sweeper.smoke.mjs`, et
 * même limite : ce dossier n'appartient à aucun espace de travail npm, si bien
 * que `npm run verify` ne le joue pas. L'issue de suivi qui porte ce câblage
 * vaut pour les trois.
 */

process.env.ENVIRONMENT = 'smoke';
process.env.DELIVERY_EVENTS_URL = 'https://api.exemple.test/api/v1/notifications/delivery-events';
process.env.DELIVERY_EVENTS_TIMEOUT_MS = '1000';

/** L'adresse qui ne doit **jamais** apparaître dans un journal. */
const ADRESSE = 'morte@exemple.test';

/** Réponse que l'API rendra, choisie d'après le `messageId` de l'enregistrement. */
const responses = new Map([
  ['rebond-permanent', { status: 200, body: { outcome: 'suppress', eventType: 'BOUNCE', suppressed: 2 } }],
  ['rebond-transitoire', { status: 200, body: { outcome: 'transient', eventType: 'BOUNCE', suppressed: 0 } }],
  ['charge-incomprise', { status: 200, body: { outcome: 'unreadable', suppressed: 0 } }],
  ['api-en-panne', { status: 503 }],
  ['jeton-refuse', { status: 401 }],
  ['route-absente', { status: 404 }],
  ['reseau-coupe', 'network'],
]);

/** Le `messageId` en cours, que le faux `fetch` lit pour choisir sa réponse. */
let current = null;

globalThis.fetch = async (_url, init) => {
  const outcome = responses.get(current) ?? { status: 200, body: { outcome: 'ignored', suppressed: 0 } };

  if (outcome === 'network') throw Object.assign(new Error('coupure'), { name: 'TypeError' });

  // Le corps relayé doit être **exactement** la charge SES : c'est le contrat de
  // la remise brute, et l'API le lit défensivement.
  const relayed = JSON.parse(init.body);
  if (relayed.eventType === undefined) throw new Error('la charge SES n’a pas été relayée telle quelle');

  return {
    status: outcome.status,
    json: async () => outcome.body ?? {},
    body: { cancel: async () => {} },
  };
};

const { handler } = await import('./delivery-events/index.mjs');

/** Un enregistrement SQS portant une charge SES réaliste — adresse comprise. */
const record = (messageId, overrides = {}) => ({
  messageId,
  body: JSON.stringify({
    eventType: 'Bounce',
    mail: { messageId: 'ses-0102' },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: ADRESSE }],
    },
    ...overrides,
  }),
});

const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  process.stderr.write(`${ok ? 'ok  ' : 'ECHEC'} ${label}\n`);
}

/**
 * Rejoue le lot en interceptant `process.stdout` : c'est le seul moyen de
 * vérifier ce que la fonction **écrit**, et l'absence d'adresse dans le journal
 * est une exigence de ce ticket au même titre que le tri des issues.
 */
async function run(records, remaining = 30_000) {
  const written = [];
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };

  try {
    const result = await handlerOverRecords(records, remaining);
    return { result, journal: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

/**
 * Le lot, joué enregistrement par enregistrement.
 *
 * Le faux `fetch` choisit sa réponse d'après le `messageId` en cours, et il ne
 * la reçoit pas en argument : chaque enregistrement est donc présenté seul, ce
 * qui revient au même du point de vue de la fonction — elle traite son lot en
 * séquence — et permet de scénariser sept réponses différentes.
 */
async function handlerOverRecords(records, remaining) {
  const batchItemFailures = [];

  for (const item of records) {
    current = item.messageId;
    const partial = await handler({ Records: [item] }, { getRemainingTimeInMillis: () => remaining });
    batchItemFailures.push(...partial.batchItemFailures);
  }

  return { batchItemFailures };
}

// 1. Le tri des issues. Sept enregistrements, trois seulement rendus à SQS.
//
//    `jeton-refuse` en fait partie : un 401 ne dit rien de l'événement, il dit
//    que la fonction ne s'est pas fait reconnaître. L'acquitter le supprimerait
//    de la file sans qu'il passe par la DLQ, et il n'y aurait plus rien à
//    rejouer une fois le jeton corrigé — c'est-à-dire des adresses mortes
//    laissées sollicitées.
//
//    `charge-incomprise` n'en fait **pas** partie : l'API a compris la requête
//    et pas l'événement ; rien ne se répare en le rejouant.
const trie = await run([
  record('rebond-permanent'),
  record('rebond-transitoire', { bounce: { bounceType: 'Transient' } }),
  record('charge-incomprise', { eventType: 'Teleportation' }),
  record('api-en-panne'),
  record('jeton-refuse'),
  record('route-absente'),
  record('reseau-coupe'),
  { messageId: 'illisible', body: '{ pas du json' },
]);

check(
  'seuls les echecs transitoires sont rendus a SQS',
  trie.result.batchItemFailures.map((f) => f.itemIdentifier).sort(),
  ['api-en-panne', 'jeton-refuse', 'reseau-coupe'],
);

// 2. L'exigence propre à cette fonction : le corps qu'elle relaie **contient**
//    l'adresse du destinataire, là où les enveloppes de notification n'en
//    portent aucune. Rien de ce corps ne doit finir au journal — ni en clair,
//    ni tronqué (CDC §5.1, skill notifications §7).
check('aucune adresse dans le journal', trie.journal.includes(ADRESSE), false);

// 3. Le compteur que la supervision regarde remonte bien depuis la réponse de
//    l'API : c'est le nombre de fiches qui viennent de cesser d'être
//    sollicitées, et il n'existe nulle part ailleurs.
check(
  'la metrique Suppressions reprend le compte rendu par l’API',
  trie.journal.includes('"Suppressions":2'),
  true,
);

// 4. La garde de fin de temps imparti : le reste du lot est rendu explicitement
//    plutôt que tué en vol.
const serre = await handler(
  { Records: [record('rebond-permanent'), record('rebond-permanent')] },
  { getRemainingTimeInMillis: () => 100 },
);

check('le lot est rendu quand le temps imparti manque', serre.batchItemFailures.length, 2);

// 5. Sans destination, rien n'est acquitté : la chaîne non branchée se voit en
//    supervision, et les rebonds attendent dans la file au lieu de disparaître.
process.env.DELIVERY_EVENTS_URL = '';
const nonConfigure = await import(`./delivery-events/index.mjs?variante=${Date.now()}`);
const ferme = await nonConfigure.handler(
  { Records: [record('rebond-permanent')] },
  { getRemainingTimeInMillis: () => 30_000 },
);

check('defaut ferme sans delivery_events_url', ferme.batchItemFailures.length, 1);

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n')}\n`);
  process.exit(1);
}

process.stderr.write('\nFumigation passee : 5 verifications, 0 echec.\n');
