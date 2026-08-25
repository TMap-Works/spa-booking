import { REDACTED, isSensitiveKey, redact, redactString } from '../redaction';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'passwordHash',
    'userEmail',
    'user_email',
    'X-API-Key',
    'first_name',
    'clientPhone',
    'authorization',
    'cardNumber',
    'iban',
    'staffNotes',
  ])('reconnaît %s comme sensible', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'tenantId',
    'appointmentId',
    'capacity', // contient « city »
    'gzip', // contient « zip »
    'status',
    'durationMinutes',
    'amountCents',
    'currency',
  ])('laisse passer %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('redactString', () => {
  it('masque une adresse e-mail au milieu d’un message', () => {
    const result = redactString('Client marie.dupont@example.com introuvable');

    expect(result).not.toContain('marie.dupont@example.com');
    expect(result).toContain(REDACTED);
  });

  it('masque les identifiants d’une URL de connexion', () => {
    const result = redactString('connect ECONNREFUSED postgresql://spa:s3cret@db.internal:5432/spa');

    expect(result).not.toContain('s3cret');
    expect(result).toContain('postgresql://');
  });

  it('tronque les chaînes démesurées', () => {
    const result = redactString('a'.repeat(5_000));

    expect(result.length).toBeLessThan(2_100);
  });
});

describe('redact', () => {
  it('masque par nom de champ sans toucher au reste', () => {
    const result = redact({
      tenantId: 'tenant-1',
      email: 'marie@example.com',
      appointmentId: 42,
    }) as Record<string, unknown>;

    expect(result['tenantId']).toBe('tenant-1');
    expect(result['appointmentId']).toBe(42);
    expect(result['email']).toBe(REDACTED);
  });

  it('ne modifie pas la valeur d’origine', () => {
    const source = { email: 'marie@example.com', nested: { password: 'x' } };
    redact(source);

    expect(source.email).toBe('marie@example.com');
    expect(source.nested.password).toBe('x');
  });

  it('descend dans les objets imbriqués puis coupe en profondeur', () => {
    const deep = { a: { b: { c: { d: { e: 'trop loin' } } } } };

    expect(JSON.stringify(redact(deep))).toContain('profondeur maximale');
  });

  it('borne les tableaux', () => {
    const result = redact(Array.from({ length: 50 }, (_v, index) => index)) as unknown[];

    expect(result).toHaveLength(21);
    expect(String(result[20])).toContain('30');
  });

  it('réduit une erreur à son nom et son message expurgé', () => {
    const result = redact(new Error('échec pour bob@example.com')) as Record<string, unknown>;

    expect(result['name']).toBe('Error');
    expect(String(result['message'])).not.toContain('bob@example.com');
  });

  it('laisse passer null et undefined tels quels', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});
