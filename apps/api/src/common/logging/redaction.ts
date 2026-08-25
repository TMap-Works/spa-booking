/**
 * Rédaction des données personnelles avant écriture dans les logs.
 *
 * Règle du projet (tenant-isolation §5, CDC §5.1) : le `tenantId` fait partie du
 * contexte de log, aucune donnée personnelle client n'y entre — ni nom, ni
 * e-mail, ni téléphone, ni secret.
 *
 * Deux mécanismes complémentaires :
 *
 * - **par nom de champ** — tout champ dont le nom désigne une donnée personnelle
 *   ou un secret est remplacé, quelle que soit sa valeur ;
 * - **par forme, dans les chaînes libres** — adresses e-mail et identifiants
 *   d'URL (`postgres://user:motdepasse@…`) sont masqués même au milieu d'un
 *   message d'erreur, là où aucun nom de champ ne les annonce.
 *
 * Les numéros de téléphone ne sont volontairement **pas** détectés par forme :
 * un motif assez large pour les attraper attrape aussi les dates ISO et les
 * identifiants numériques. Ils sont couverts par le nom de champ (`phone`,
 * `mobile`, `tel`…).
 */

export const REDACTED = '[rédigé]';

/**
 * Jetons de nom de champ considérés comme sensibles. La comparaison se fait sur
 * des jetons entiers, jamais en sous-chaîne : `/city/` masquerait `capacity`, et
 * `/zip/` masquerait `gzip`.
 */
const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  // Secrets et authentification
  'password',
  'passphrase',
  'secret',
  'token',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'cookie',
  'apikey',
  'accesskey',
  'privatekey',
  'signature',
  // Identité et contact
  'email',
  'mail',
  'phone',
  'mobile',
  'tel',
  'telephone',
  'firstname',
  'lastname',
  'fullname',
  'givenname',
  'surname',
  'customername',
  'clientname',
  // Localisation et état civil
  'address',
  'street',
  'postalcode',
  'zipcode',
  'postcode',
  'birthdate',
  'birthday',
  'dob',
  // Données financières et identifiants nationaux
  'iban',
  'bic',
  'card',
  'cardnumber',
  'cvv',
  'cvc',
  'pan',
  'ssn',
  'nir',
  // Texte libre saisi par le staff sur un client
  'note',
  'notes',
]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** `schéma://identifiant:motdepasse@hôte` — les URL de connexion PostgreSQL et Redis. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]*)@/gi;

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 2000;

/** `userEmail`, `user_email`, `X-API-Key` → `['user', 'email']`, `['x', 'api', 'key']`. */
function tokenize(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

/** `true` si le nom de champ désigne une donnée personnelle ou un secret. */
export function isSensitiveKey(key: string): boolean {
  const tokens = tokenize(key);
  if (tokens.length === 0) {
    return false;
  }
  if (tokens.some((token) => SENSITIVE_TOKENS.has(token))) {
    return true;
  }
  // `first_name` → `firstname`, `x-api-key` → `apikey`.
  if (SENSITIVE_TOKENS.has(tokens.join(''))) {
    return true;
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (current !== undefined && next !== undefined && SENSITIVE_TOKENS.has(current + next)) {
      return true;
    }
  }
  return false;
}

/** Masque ce qui est reconnaissable par sa forme dans une chaîne libre. */
export function redactString(value: string): string {
  const truncated =
    value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  return truncated
    .replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`)
    .replace(EMAIL, REDACTED);
}

/**
 * Copie profonde d'une valeur de log, expurgée. Ne modifie jamais l'objet
 * d'origine : un log ne doit pas altérer la donnée métier qu'il observe.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth >= MAX_DEPTH) {
    return '[profondeur maximale atteinte]';
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`… ${value.length - MAX_ARRAY_ITEMS} éléments supplémentaires`);
    }
    return items;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redact(source[key], depth + 1);
    }
    return output;
  }
  return `[${typeof value}]`;
}
