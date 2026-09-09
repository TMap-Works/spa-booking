/**
 * Lambda de traitement des rebonds et des plaintes — le consommateur de
 * `spa-{env}-ses-events` (#73).
 *
 * ```
 * SES ──► topic spa-{env}-ses-events ──► file ──► cette fonction ──► POST {DELIVERY_EVENTS_URL}
 * ```
 *
 * ## Ce que cette fonction est, et ce qu'elle n'est pas
 *
 * Elle est le **transport**, exactement comme la Lambda d'envoi : elle dépile la
 * file, relaie la charge utile à l'API et traduit la réponse en une décision de
 * rejeu. Elle ne classe rien. « Ce rebond est-il permanent ? », « quelles
 * adresses désigne-t-il ? », « dans quels établissements les supprimer ? » sont
 * des questions qui vivent dans `apps/api/src/modules/notifications`, où le
 * schéma, le client Prisma scopé et les suites de test se trouvent déjà. Les
 * réécrire ici en JavaScript donnerait deux implémentations de la même règle,
 * dans deux exécutables, avec un seul jeu de tests — c'est-à-dire une divergence
 * garantie.
 *
 * C'est aussi pourquoi elle **ne valide pas** la charge utile, contrairement à la
 * Lambda d'envoi qui vérifie chaque champ de son enveloppe. La différence n'est
 * pas d'humeur : là-bas l'enveloppe est notre contrat, écrit par notre API, et
 * une enveloppe malformée signale un défaut chez nous. Ici la charge est le JSON
 * de SES — nous ne le dessinons pas, nous ne le versionnons pas, et AWS y ajoute
 * des champs sans prévenir. La lire pour décider de son sort reviendrait à
 * refuser en local des rebonds parfaitement lisibles.
 *
 * ## Les trois règles qui tiennent le fichier
 *
 * 1. **Aucune boucle de reprise maison.** Un enregistrement, un appel, une
 *    décision. Le rejeu est le métier de SQS, qui compte les tentatives jusqu'à
 *    la DLQ.
 *
 * 2. **Un événement illisible n'est jamais rejoué.** L'API rend 200 avec
 *    `outcome: "unreadable"` : rien ne se répare en le répétant, et le rejouer
 *    encombrerait la file d'attente morte de messages qu'aucun humain ne saurait
 *    quoi faire. Il est acquitté et compté.
 *
 * 3. **Défaut fermé.** Sans destination, la fonction rend le message à SQS au
 *    lieu de l'acquitter. Une chaîne non branchée doit se voir en supervision,
 *    et les rebonds attendent dans la file plutôt que de disparaître.
 *
 * ## Journalisation
 *
 * **Jamais d'adresse.** C'est la contrainte propre à cette fonction, et la seule
 * qui la distingue vraiment des deux autres : le corps qu'elle relaie *contient*
 * l'adresse du destinataire, là où les enveloppes de notification n'en portent
 * aucune. Rien de ce corps n'est donc journalisé — ni en clair, ni tronqué, ni
 * « juste pour diagnostiquer ». Ce qui part au journal, ce sont l'identifiant du
 * message SQS, le verdict rendu par l'API et des compteurs (CDC §5.1, skill
 * notifications §7).
 */

// --- Configuration ------------------------------------------------------------

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'unknown';
const DELIVERY_EVENTS_URL = process.env.DELIVERY_EVENTS_URL ?? '';
const DISPATCH_TOKEN_SECRET_ARN = process.env.DISPATCH_TOKEN_SECRET_ARN ?? '';
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'Spa/Notifications';

/**
 * Repli si la variable est absente, vide ou illisible — même précaution que dans
 * les deux autres fonctions : un `NaN` ferait lever `AbortSignal.timeout` sur
 * chaque message, et un zéro abandonnerait l'appel avant qu'il ne parte.
 */
const DELIVERY_EVENTS_TIMEOUT_MS = positiveNumber(process.env.DELIVERY_EVENTS_TIMEOUT_MS, 5000);

function positiveNumber(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Marge conservée avant la fin du temps imparti à l'invocation.
 *
 * Sans elle, la fonction serait tuée au milieu d'un appel : les enregistrements
 * non traités du lot ne figureraient dans aucun `batchItemFailures`, et SQS les
 * rendrait quand même — mais après le délai de visibilité, sans que rien ne
 * l'explique. Les rendre explicitement quand le temps manque est la même
 * reprise, en la disant.
 */
const TIME_GUARD_MS = 1_500;

/**
 * Codes qui ne changeront pas d'avis en réessayant, et ceux qui le pourraient.
 *
 * Un 401 ou un 403 est **transitoire**, et il faut s'y arrêter : un refus
 * d'authentification ne dit rien de l'événement, il dit que la fonction ne s'est
 * pas fait reconnaître. Le jeton est lu une fois par démarrage à froid ; une
 * rotation du secret ou un déploiement de l'API à mi-course refuse alors *tous*
 * les messages. Les compter permanents les supprimerait de la file sans qu'ils
 * passent par la DLQ, et il n'y aurait plus rien à rejouer une fois le jeton
 * corrigé — c'est-à-dire des adresses mortes qui resteraient sollicitées.
 */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 425, 429]);

/** Ce qu'un enregistrement peut devenir. `transient` est le seul qui se rejoue. */
const PROCESSED = 'processed';
const UNREADABLE = 'unreadable';
const PERMANENT = 'permanent';
const TRANSIENT = 'transient';

// --- Jeton d'appel ------------------------------------------------------------

/**
 * Le jeton partagé, lu une fois par démarrage à froid.
 *
 * C'est le **même** secret que celui de la Lambda d'envoi et de celle du
 * balayage : une seule frontière de confiance, un seul secret à faire tourner.
 * En cache pour ne pas payer un appel Secrets Manager par événement ; jamais
 * journalisé, jamais rendu dans une erreur.
 *
 * L'import du SDK est **dynamique**, comme ailleurs : il est fourni par le
 * runtime `nodejs22.x` et non par l'archive, si bien qu'un import statique
 * lierait le simple chargement du module à cette fourniture.
 */
let cachedToken = null;
let secretsManager = null;

async function internalToken() {
  if (!DISPATCH_TOKEN_SECRET_ARN) return null;
  if (cachedToken !== null) return cachedToken;

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );

  secretsManager ??= new SecretsManagerClient({});

  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: DISPATCH_TOKEN_SECRET_ARN }),
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
 * `Suppressions` est celle qui compte, et elle vient de la réponse de l'API :
 * c'est le nombre de fiches qui viennent de cesser d'être sollicitées. Un pic y
 * est le signe d'un incident de délivrabilité, et c'est la seule mesure de ce
 * ticket qu'un humain regarde spontanément.
 *
 * Les cinq compteurs sont publiés à chaque invocation, y compris à zéro : c'est
 * ce qui distingue « aucun rebond, tant mieux » de « plus personne ne consomme
 * la file », et ce qui rend les alarmes lisibles plutôt que suspendues à une
 * absence de donnée.
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
              { Name: 'DeliveryEventsProcessed', Unit: 'Count' },
              { Name: 'DeliveryEventsUnreadable', Unit: 'Count' },
              { Name: 'DeliveryEventsPermanentFailures', Unit: 'Count' },
              { Name: 'DeliveryEventsTransientFailures', Unit: 'Count' },
              { Name: 'Suppressions', Unit: 'Count' },
            ],
          },
        ],
      },
      Environment: ENVIRONMENT,
      DeliveryEventsProcessed: counts.processed,
      DeliveryEventsUnreadable: counts.unreadable,
      DeliveryEventsPermanentFailures: counts.permanent,
      DeliveryEventsTransientFailures: counts.transient,
      Suppressions: counts.suppressed,
    })}\n`,
  );
}

// --- Traitement d'un enregistrement -------------------------------------------

/**
 * Un enregistrement, un appel, une décision.
 *
 * Le corps est relayé **tel quel**, sans être analysé : la remise brute de
 * l'abonnement SNS l'a déjà débarrassé de son enveloppe, et c'est l'API qui sait
 * le lire. La seule chose vérifiée ici est que c'est du JSON — non pour le
 * comprendre, mais parce qu'un corps qui n'en est pas ne viendra jamais de SES et
 * ne deviendra pas valide en le rejouant.
 *
 * @returns un couple `{ outcome, suppressed }` — le second alimente la métrique
 * qui compte les fiches devenues silencieuses.
 */
async function handleRecord(record) {
  const context = { messageId: record.messageId };

  let payload;
  try {
    payload = JSON.parse(record.body);
  } catch {
    // Le corps n'est **pas** journalisé : on ne sait pas ce qu'il contient, et
    // ce qui vient de ce topic contient normalement une adresse.
    log('error', 'delivery.rejected', { ...context, reason: 'invalid-json' });
    return { outcome: PERMANENT, suppressed: 0 };
  }

  if (!DELIVERY_EVENTS_URL) {
    // Défaut fermé : sans destination, rien n'est acquitté. Le message épuise ses
    // réceptions, part en DLQ, et l'alarme de profondeur parle — ce qui est
    // exactement ce qu'on veut voir quand la chaîne n'est pas branchée.
    log('error', 'delivery.unconfigured', { ...context, reason: 'delivery-events-url-unset' });
    return { outcome: TRANSIENT, suppressed: 0 };
  }

  let token;
  try {
    token = await internalToken();
  } catch (error) {
    // `code` en plus de `name` : une lecture de secret rate pour deux familles de
    // raisons qui ne se réparent pas au même endroit — un refus IAM ou une panne
    // réseau d'un côté, un `ERR_MODULE_NOT_FOUND` de l'autre, qui dirait que le
    // runtime ne fournit pas `@aws-sdk/client-secrets-manager`.
    log('error', 'delivery.token_unavailable', {
      ...context,
      reason: error.name,
      code: error.code,
    });
    return { outcome: TRANSIENT, suppressed: 0 };
  }

  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-internal-token'] = token;

  let response;
  try {
    response = await fetch(DELIVERY_EVENTS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DELIVERY_EVENTS_TIMEOUT_MS),
    });
  } catch (error) {
    // Coupure, DNS, délai dépassé : rien de tout cela ne dit que l'événement est
    // mauvais. Transitoire, donc rendu à SQS.
    log('warn', 'delivery.transport_failed', { ...context, reason: error.name });
    return { outcome: TRANSIENT, suppressed: 0 };
  }

  const status = response.status;

  if (status >= 200 && status < 300) {
    // Le corps est lu ici — contrairement à la Lambda d'envoi, où le code
    // suffisait — parce qu'il porte le seul chiffre que la supervision attend :
    // combien de fiches viennent de cesser d'être sollicitées. Il ne porte
    // aucune adresse, c'est le contrat de `DeliveryEventDto`.
    const verdict = await readVerdict(response);

    if (verdict.outcome === 'unreadable') {
      // L'API a compris la requête, mais pas l'événement. Rien ne se répare en
      // le rejouant : acquitté, et compté à part pour que le volume se voie.
      log('warn', 'delivery.unreadable', { ...context, status });
      return { outcome: UNREADABLE, suppressed: 0 };
    }

    log('info', 'delivery.processed', {
      ...context,
      status,
      // Le verdict et les compteurs, jamais les adresses : `DeliveryEventDto`
      // n'en rend aucune, et ce journal n'en invente pas.
      outcome: verdict.outcome,
      eventType: verdict.eventType,
      suppressed: verdict.suppressed,
    });

    return { outcome: PROCESSED, suppressed: verdict.suppressed };
  }

  // À partir d'ici, le corps ne nous apprend rien — c'est le code qui décide —
  // mais il faut le vider : `fetch` ne rend la connexion au pool qu'une fois le
  // flux consommé ou annulé, et un conteneur chaud accumulerait autant de
  // sockets ouvertes que de messages. `catch` vide : une annulation qui échoue
  // ne doit pas requalifier la décision.
  await response.body?.cancel().catch(() => {});

  if (status >= 500 || TRANSIENT_STATUSES.has(status)) {
    log('warn', 'delivery.retryable', { ...context, status });
    return { outcome: TRANSIENT, suppressed: 0 };
  }

  log('error', 'delivery.permanent_failure', { ...context, status });
  return { outcome: PERMANENT, suppressed: 0 };
}

/**
 * Le verdict rendu par l'API, réduit à ce qui se journalise.
 *
 * Défensif de bout en bout : un corps illisible ou d'une autre forme ne doit pas
 * requalifier en échec un traitement que le code de statut vient de déclarer
 * réussi. L'écriture a eu lieu ; ce qui manque n'est qu'une ligne de journal.
 */
async function readVerdict(response) {
  try {
    const body = await response.json();

    return {
      outcome: typeof body?.outcome === 'string' ? body.outcome : 'unknown',
      eventType: typeof body?.eventType === 'string' ? body.eventType : null,
      suppressed: Number.isFinite(body?.suppressed) ? body.suppressed : 0,
    };
  } catch {
    return { outcome: 'unknown', eventType: null, suppressed: 0 };
  }
}

// --- Point d'entrée -----------------------------------------------------------

export async function handler(event, context) {
  const counts = { processed: 0, unreadable: 0, permanent: 0, transient: 0, suppressed: 0 };
  const batchItemFailures = [];
  const records = event?.Records ?? [];

  // Séquentiel, délibérément. Le parallélisme se règle en amont, par la
  // concurrence maximale de la source d'événements : traiter dix appels de front
  // ici multiplierait la charge sur l'API sans qu'aucun réglage d'infrastructure
  // ne le borne — et c'est précisément pendant un incident de délivrabilité, donc
  // quand l'API a le moins d'air, que ce lot serait le plus gros.
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    const remaining =
      typeof context?.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : Number.POSITIVE_INFINITY;

    if (remaining < DELIVERY_EVENTS_TIMEOUT_MS + TIME_GUARD_MS) {
      // Le reste du lot est rendu à SQS plutôt que tué en vol.
      for (let rest = index; rest < records.length; rest += 1) {
        batchItemFailures.push({ itemIdentifier: records[rest].messageId });
        counts.transient += 1;
      }
      log('warn', 'delivery.batch_deadline', {
        processed: index,
        returned: records.length - index,
      });
      break;
    }

    const { outcome, suppressed } = await handleRecord(record);

    counts.suppressed += suppressed;

    if (outcome === TRANSIENT) {
      counts.transient += 1;
      batchItemFailures.push({ itemIdentifier: record.messageId });
    } else if (outcome === PERMANENT) {
      counts.permanent += 1;
    } else if (outcome === UNREADABLE) {
      counts.unreadable += 1;
    } else {
      counts.processed += 1;
    }
  }

  emitMetrics(counts);

  // Réponse partielle : SQS ne rend que les enregistrements nommés ici et
  // supprime les autres. Lever à la place ferait rejouer le lot entier, donc
  // rappellerait l'API pour des rebonds déjà traités.
  return { batchItemFailures };
}
