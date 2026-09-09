/**
 * Fumigation de la Lambda de balayage — `node reminder-sweeper.smoke.mjs`
 * depuis ce dossier.
 *
 * ## Pourquoi ce fichier existe
 *
 * Les affirmations de #71 sur cette fonction — « republier est sans danger, ne
 * rien publier ne l'est pas », « défaut fermé », « le plafond atteint est une
 * anomalie » — portent sur ce que la fonction **rend** et **lève**. Ni
 * `terraform validate`, qui ne lit pas de JavaScript, ni la relecture du handler
 * ne les vérifient.
 *
 * Il est **hors** de `lambda/reminder-sweeper/`, le répertoire qu'`archive_file`
 * empaquette : un fichier de test n'a rien à faire dans l'artefact déployé.
 *
 * Depuis #496, il est joué par `npm run verify` et par le job `test` de
 * `ci.yml`, comme les fumigations de la Lambda d'envoi et de la Lambda de
 * rebonds : la cible `test:smoke:lambda` appelle `run-smoke.mjs`, qui découvre
 * les `*.smoke.mjs` de ce dossier.
 */

process.env.ENVIRONMENT = 'smoke';
process.env.SWEEP_URL = 'https://api.exemple.test/api/v1/notifications/reminders/sweep';
process.env.QUEUE_URL = 'https://sqs.eu-west-3.amazonaws.test/000000000000/spa-smoke-notifications';
process.env.SWEEP_TIMEOUT_MS = '1000';

/** L'enveloppe telle que l'API la rend — reflet de `NotificationMessage`. */
const envelope = (overrides = {}) => ({
  tenantId: 'tenant-1',
  dedupeKey: 'appointment:rdv-1:REMINDER_24H:EMAIL',
  appointmentId: 'rdv-1',
  recipientUserId: 'compte-1',
  type: 'REMINDER_24H',
  channel: 'EMAIL',
  scheduledFor: '2026-09-08T09:00:00.000Z',
  ...overrides,
});

/** Ce que l'API rendra au prochain appel — réglé cas par cas. */
let apiResponse = { status: 200, body: {} };

globalThis.fetch = async () => ({
  status: apiResponse.status,
  json: async () => apiResponse.body,
  body: { cancel: async () => undefined },
});

const { handler } = await import('./reminder-sweeper/index.mjs');

const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures.push(`${label} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  }
  process.stderr.write(`${ok ? 'ok  ' : 'ECHEC'} ${label}\n`);
}

async function rejects(label, run) {
  try {
    await run();
  } catch {
    process.stderr.write(`ok   ${label}\n`);
    return;
  }
  failures.push(`${label} : aucune erreur levée`);
  process.stderr.write(`ECHEC ${label}\n`);
}

/** Un collecteur de lots, à la place de SQS. */
function collector(behaviour = () => ({ Successful: [], Failed: [] })) {
  const batches = [];
  const sendBatch = async (entries) => {
    batches.push(entries);
    return behaviour(entries);
  };
  return { batches, sendBatch };
}

// 1. Le cas nominal : les enveloppes partent, par lots de dix au plus.
{
  const messages = Array.from({ length: 23 }, (_unused, index) =>
    envelope({ appointmentId: `rdv-${index}`, dedupeKey: `appointment:rdv-${index}:REMINDER_24H:EMAIL` }),
  );
  apiResponse = { status: 200, body: { messages, truncated: false, appointmentCount: 23 } };

  const { batches, sendBatch } = collector((entries) => ({
    Successful: entries.map((entry) => ({ Id: entry.Id })),
    Failed: [],
  }));

  const result = await handler({}, {}, { sendBatch });

  check('les 23 enveloppes sont publiées', result.published, 23);
  check('en trois lots de dix au plus', batches.map((batch) => batch.length), [10, 10, 3]);
  check(
    'le corps du message est l’enveloppe telle quelle',
    JSON.parse(batches[0][0].MessageBody).dedupeKey,
    'appointment:rdv-0:REMINDER_24H:EMAIL',
  );
}

// 2. Une enveloppe malformée est écartée, jamais publiée : la publier
//    remplirait la file d'échecs permanents.
{
  apiResponse = {
    status: 200,
    body: {
      messages: [envelope(), envelope({ tenantId: '' }), envelope({ type: 'MARKETING' })],
      truncated: false,
    },
  };

  const { batches, sendBatch } = collector((entries) => ({
    Successful: entries.map((entry) => ({ Id: entry.Id })),
    Failed: [],
  }));

  const result = await handler({}, {}, { sendBatch });

  check('seule l’enveloppe conforme est publiée', result.published, 1);
  check('les deux autres sont comptées comme rejetées', result.rejected, 2);
  check('un seul lot, d’une entrée', batches.map((batch) => batch.length), [1]);
}

// 3. Un échec partiel fait lever : le balayage entier se rejouera, et les clés
//    déterministes rendent les doublons inoffensifs. Acquitter en silence un lot
//    incomplet aurait laissé des rappels non publiés.
await rejects('un lot partiellement refusé fait lever', async () => {
  apiResponse = { status: 200, body: { messages: [envelope(), envelope()], truncated: false } };

  const { sendBatch } = collector((entries) => ({
    Successful: [{ Id: entries[0].Id }],
    Failed: [{ Id: entries[1].Id, Code: 'InternalError' }],
  }));

  await handler({}, {}, { sendBatch });
});

// 4. L'API refuse : rien n'est publié, et la fonction lève pour qu'EventBridge
//    Scheduler réessaie.
await rejects('un refus de l’API fait lever', async () => {
  apiResponse = { status: 401, body: {} };
  await handler({}, {}, { sendBatch: async () => ({ Successful: [], Failed: [] }) });
});

// 5. Rien à rappeler : ce n'est pas une anomalie, et rien n'est appelé.
{
  apiResponse = { status: 200, body: { messages: [], truncated: false } };
  const { batches, sendBatch } = collector();

  const result = await handler({}, {}, { sendBatch });

  check('une heure creuse ne publie rien', result.published, 0);
  check('et n’appelle pas SQS', batches.length, 0);
}

// 6. Défaut fermé : sans destination, la chaîne non branchée se voit.
{
  process.env.SWEEP_URL = '';
  const nonConfigure = await import(`./reminder-sweeper/index.mjs?variante=${Date.now()}`);

  await rejects('défaut fermé sans SWEEP_URL', async () =>
    nonConfigure.handler({}, {}, { sendBatch: async () => ({ Successful: [], Failed: [] }) }),
  );
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n')}\n`);
  process.exit(1);
}

process.stderr.write('\nFumigation passée : 11 vérifications, 0 échec.\n');
