/**
 * Lambda de balayage du rappel J-1 — le **producteur** de `spa-{env}-notifications`.
 *
 * ```
 * EventBridge Scheduler ──► cette fonction ──► POST {SWEEP_URL} ──► API
 *   (cron(0 * * * ? *), UTC)        │                                │
 *                                   ◄──────── enveloppes ────────────┘
 *                                   │
 *                                   └──► SendMessageBatch ──► file de notifications
 * ```
 *
 * ## Ce que cette fonction est, et ce qu'elle n'est pas
 *
 * Elle est le **transport**, exactement comme la Lambda d'envoi de #67 : elle
 * demande à l'API ce qu'il y a à rappeler, et publie ce qu'on lui rend. Elle ne
 * sélectionne rien. La fenêtre `now+24h → now+25h`, la définition de
 * « rendez-vous vivant » et le choix des canaux vivent dans
 * `apps/api/src/modules/notifications`, où le schéma, le client Prisma scopé et
 * les suites de test se trouvent déjà. Les réécrire ici en JavaScript donnerait
 * deux implémentations de la même règle, dans deux exécutables, avec un seul jeu
 * de tests — c'est-à-dire une divergence garantie.
 *
 * ## Les trois règles qui tiennent le fichier
 *
 * 1. **Aucune reprise maison.** Un balayage, un appel, une décision. En cas
 *    d'échec la fonction **lève**, et c'est EventBridge Scheduler qui réessaie,
 *    selon la politique déclarée dans `reminder-sweep.tf`. Boucler ici
 *    masquerait l'échec à la métrique `Errors`, sur laquelle repose l'alarme.
 *
 * 2. **Republier est sans danger, ne rien publier ne l'est pas.** Les clés de
 *    déduplication sont déterministes et l'index d'idempotence de #68 sérialise
 *    les doublons à l'envoi : un lot partiellement publié se rejoue donc en
 *    entier, sans qu'aucune cliente ne reçoive deux fois le même rappel. Le
 *    biais est délibérément du côté du doublon, parce qu'un rappel manquant se
 *    traduit en no-show.
 *
 * 3. **Défaut fermé.** Sans destination ni jeton, la fonction lève au lieu de
 *    rendre « rien à faire ». Une chaîne non branchée doit se voir en
 *    supervision, pas se confondre avec une heure creuse.
 *
 * ## Journalisation
 *
 * Des identifiants et des compteurs, jamais de coordonnée ni de contenu (CDC
 * §5.1, skill notifications §7). L'enveloppe n'en porte de toute façon aucune :
 * c'est la règle du contrat côté API.
 */

// --- Configuration ------------------------------------------------------------

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'unknown';
const SWEEP_URL = process.env.SWEEP_URL ?? '';
const QUEUE_URL = process.env.QUEUE_URL ?? '';
const SWEEP_TOKEN_SECRET_ARN = process.env.SWEEP_TOKEN_SECRET_ARN ?? '';
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'Spa/Notifications';

/**
 * Repli si la variable est absente, vide ou illisible — même précaution que dans
 * la Lambda d'envoi : un `NaN` ferait lever `AbortSignal.timeout` et un zéro
 * abandonnerait l'appel avant qu'il ne parte.
 */
const SWEEP_TIMEOUT_MS = positiveNumber(process.env.SWEEP_TIMEOUT_MS, 10_000);

function positiveNumber(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Taille d'un lot `SendMessageBatch`. Dix est le maximum imposé par SQS, et il
 * n'y a aucune raison d'en envoyer moins : chaque appel est facturé, et le lot
 * n'a pas de sémantique — un échec partiel se rejoue de toute façon en entier.
 */
const BATCH_SIZE = 10;

// --- Jeton d'appel ------------------------------------------------------------

/**
 * Le jeton partagé, lu une fois par démarrage à froid.
 *
 * Même conduite que la Lambda d'envoi, et pour les mêmes raisons : en cache pour
 * ne pas payer un appel Secrets Manager par balayage, jamais journalisé, jamais
 * rendu dans une erreur. L'import du SDK est dynamique, de sorte qu'il ne coûte
 * rien tant qu'aucun secret n'est configuré.
 */
let cachedToken = null;
let secretsManager = null;

async function sweepToken() {
  if (!SWEEP_TOKEN_SECRET_ARN) return null;
  if (cachedToken !== null) return cachedToken;

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );

  secretsManager ??= new SecretsManagerClient({});

  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: SWEEP_TOKEN_SECRET_ARN }),
  );

  cachedToken = response.SecretString ?? '';
  return cachedToken;
}

// --- Journal et métriques -----------------------------------------------------

function log(level, event, fields) {
  process.stdout.write(`${JSON.stringify({ level, event, environment: ENVIRONMENT, ...fields })}\n`);
}

/**
 * Métriques au format EMF — CloudWatch les extrait du journal, sans que la
 * fonction ait besoin de `cloudwatch:PutMetricData`.
 *
 * Les quatre compteurs sont publiés à chaque balayage, y compris à zéro : c'est
 * ce qui distingue « aucun rendez-vous à rappeler à cette heure-ci » de « plus
 * personne ne balaie », et ce qui rend l'alarme lisible plutôt que suspendue à
 * une absence de donnée.
 */
function emitMetrics(counts) {
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Environment']],
            Metrics: [
              { Name: 'RemindersSelected', Unit: 'Count' },
              { Name: 'RemindersPublished', Unit: 'Count' },
              { Name: 'RemindersRejected', Unit: 'Count' },
              { Name: 'SweepTruncated', Unit: 'Count' },
            ],
          },
        ],
      },
      Environment: ENVIRONMENT,
      RemindersSelected: counts.selected,
      RemindersPublished: counts.published,
      RemindersRejected: counts.rejected,
      SweepTruncated: counts.truncated,
    })}\n`,
  );
}

// --- Appel à l'API ------------------------------------------------------------

/**
 * Demande à l'API ce qu'il y a à rappeler.
 *
 * Lève sur tout ce qui n'est pas un 2xx. Aucune tentative de distinguer le
 * transitoire du permanent, contrairement à la Lambda d'envoi : il n'y a pas de
 * message à acquitter ici, seulement un balayage qui a lieu ou n'a pas lieu, et
 * qu'EventBridge Scheduler réessaiera.
 */
async function fetchDueReminders() {
  const token = await sweepToken();

  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-internal-token'] = token;

  const response = await fetch(SWEEP_URL, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(SWEEP_TIMEOUT_MS),
  });

  if (response.status < 200 || response.status >= 300) {
    // Le corps n'est pas lu : il pourrait porter un message d'erreur, et rien
    // n'y serait plus utile que le code lui-même.
    await response.body?.cancel().catch(() => {});
    throw new Error(`le balayage a été refusé par l'API (statut ${response.status})`);
  }

  return response.json();
}

// --- Publication --------------------------------------------------------------

let sqs = null;

/**
 * L'envoi d'un lot vers SQS, par le SDK fourni par le runtime.
 *
 * Import **dynamique**, comme celui du client Secrets Manager de la Lambda
 * d'envoi et pour la même raison : le SDK v3 vient du runtime `nodejs20.x`, pas
 * de l'archive, et un import statique lierait le simple chargement du module à
 * cette fourniture (#495). Chargé ici, l'échec se produit à l'appel, avec un
 * `ERR_MODULE_NOT_FOUND` que le journal nomme — et le fichier reste importable
 * partout, ce dont la fumigation se sert.
 */
async function sendBatchToSqs(entries) {
  const { SQSClient, SendMessageBatchCommand } = await import('@aws-sdk/client-sqs');

  sqs ??= new SQSClient({});

  return sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }));
}

/**
 * Publie les enveloppes, dix par dix.
 *
 * File **standard** et non FIFO : pas de `MessageDeduplicationId` à composer —
 * l'unicité n'est pas le métier de la file, c'est celui de l'index partiel de
 * #68, qui la garantit y compris entre deux producteurs qui ne se coordonnent
 * pas.
 *
 * Un échec partiel fait lever : le balayage entier se rejouera, republiera les
 * mêmes clés, et les doublons seront ignorés à l'envoi. Acquitter en silence un
 * lot incomplet aurait laissé des rappels non publiés sans que rien ne le dise.
 */
async function publish(messages, sendBatch) {
  let published = 0;

  for (let start = 0; start < messages.length; start += BATCH_SIZE) {
    const slice = messages.slice(start, start + BATCH_SIZE);

    const response = await sendBatch(
      slice.map((message, index) => ({
        // Identifiant **local au lot**, exigé par SQS pour rapprocher chaque
        // entrée de son sort. Il ne voyage pas avec le message.
        Id: `m${start + index}`,
        MessageBody: JSON.stringify(message),
      })),
    );

    published += response.Successful?.length ?? 0;

    const failed = response.Failed ?? [];
    if (failed.length > 0) {
      log('error', 'reminder.publish_failed', {
        failed: failed.length,
        // Le code de SQS, jamais le corps du message.
        codes: [...new Set(failed.map((entry) => entry.Code))],
      });
      throw new Error(`${failed.length} enveloppe(s) refusée(s) par SQS`);
    }
  }

  return published;
}

/**
 * Rend `null` quand l'enveloppe est conforme, sinon la raison du rejet.
 *
 * Reflet de `NotificationMessage`
 * (apps/api/src/modules/notifications/notifications.types.ts). Publier une
 * enveloppe que la Lambda d'envoi rejettera reviendrait à remplir la file
 * d'échecs permanents : autant s'en apercevoir ici, où il reste une métrique
 * pour le dire.
 */
function envelopeRejection(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return 'payload-not-an-object';
  }
  for (const field of ['tenantId', 'dedupeKey', 'appointmentId', 'recipientUserId']) {
    if (typeof message[field] !== 'string' || message[field].length === 0) {
      return `missing-${field}`;
    }
  }
  if (message.type !== 'REMINDER_24H') return 'unexpected-type';
  if (message.channel !== 'EMAIL' && message.channel !== 'SMS') return 'unknown-channel';
  return null;
}

// --- Point d'entrée -----------------------------------------------------------

/**
 * @param _event ignoré : EventBridge Scheduler n'apporte aucune charge utile, et
 * la fenêtre se calcule côté API à partir de l'instant de l'appel.
 * @param _context ignoré : la fonction ne traite qu'un appel, jamais un lot, et
 * n'a donc pas de garde de temps imparti à tenir.
 * @param overrides couture de test — Lambda n'appelle jamais le handler avec un
 * troisième argument. Elle existe pour que la fumigation exerce la publication
 * sans SDK ni compte AWS ; l'alternative aurait été de ne pas tester le chemin
 * qui compte.
 */
export async function handler(_event, _context, overrides = {}) {
  const sendBatch = overrides.sendBatch ?? sendBatchToSqs;
  const counts = { selected: 0, published: 0, rejected: 0, truncated: 0 };

  if (!SWEEP_URL || !QUEUE_URL) {
    // Défaut fermé : la chaîne non branchée doit se voir en supervision plutôt
    // que se confondre avec une heure sans rendez-vous.
    log('error', 'reminder.unconfigured', {
      reason: SWEEP_URL ? 'queue-url-unset' : 'sweep-url-unset',
    });
    emitMetrics(counts);
    throw new Error('balayage non configuré : SWEEP_URL ou QUEUE_URL absente');
  }

  let sweep;
  try {
    sweep = await fetchDueReminders();
  } catch (error) {
    log('error', 'reminder.sweep_failed', { reason: error.name, message: error.message });
    emitMetrics(counts);
    throw error;
  }

  const messages = Array.isArray(sweep?.messages) ? sweep.messages : [];
  counts.selected = messages.length;
  counts.truncated = sweep?.truncated === true ? 1 : 0;

  if (counts.truncated === 1) {
    // Le plafond serveur a arrêté la sélection : des rappels manquent, et cette
    // heure-ci ne les rattrapera pas. C'est une anomalie, pas une information.
    log('error', 'reminder.sweep_truncated', {
      from: sweep.from,
      to: sweep.to,
      appointmentCount: sweep.appointmentCount,
    });
  }

  const publishable = [];
  for (const message of messages) {
    const rejection = envelopeRejection(message);
    if (rejection === null) {
      publishable.push(message);
    } else {
      counts.rejected += 1;
      // Le corps n'est pas journalisé : on ne sait pas ce qu'il contient, c'est
      // précisément pourquoi il est rejeté.
      log('error', 'reminder.rejected', { reason: rejection });
    }
  }

  try {
    counts.published = publishable.length === 0 ? 0 : await publish(publishable, sendBatch);
  } catch (error) {
    emitMetrics(counts);
    throw error;
  }

  log('info', 'reminder.swept', {
    from: sweep.from,
    to: sweep.to,
    tenantCount: sweep.tenantCount,
    appointmentCount: sweep.appointmentCount,
    published: counts.published,
    rejected: counts.rejected,
  });

  emitMetrics(counts);

  return { published: counts.published, rejected: counts.rejected };
}
