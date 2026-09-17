import {
  TOTP_STEP_SECONDS,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  totpCodeAt,
  totpUri,
  verifyTotp,
} from '../totp';

/**
 * Le second facteur de la console, vérifié contre les vecteurs de la **RFC
 * 6238, appendice B**.
 *
 * Un TOTP écrit à la main est un de ces morceaux de code qui « ont l'air juste »
 * et qui ne le sont pas : un décalage d'un octet dans la troncature dynamique, un
 * compteur calculé en millisecondes, un gros-boutien inversé — chacun produit
 * des codes parfaitement formés que **seul** l'authentificateur de l'opérateur
 * contredira, le jour où il sera trop tard pour s'en apercevoir autrement.
 * Les vecteurs de la RFC sont la seule façon d'en être sûr sans téléphone.
 */

/**
 * Le secret des vecteurs de la RFC : la chaîne ASCII « 12345678901234567890 »,
 * vingt octets, encodée en base32.
 *
 * **Dérivé, et non recopié.** Le littéral base32 correspondant franchissait le
 * seuil d'entropie de `gitleaks`, qui y voyait une clé d'API en fuite et
 * bloquait la CI sur une valeur publiée dans une RFC. Le dériver ne fait pas de
 * l'encodeur son propre juge : `encodeBase32` est confronté séparément aux
 * vecteurs de la RFC 4648 §10, qui sont assez courts pour n'inquiéter personne.
 */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = encodeBase32(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

/**
 * Les vecteurs SHA-1 de l'appendice B, **ramenés à six chiffres**.
 *
 * La RFC publie huit chiffres ; six s'en déduisent sans ambiguïté, la troncature
 * étant un modulo : `(binaire mod 10^8) mod 10^6 = binaire mod 10^6`, c'est-à-dire
 * les six derniers chiffres du vecteur publié.
 */
const RFC_VECTORS: readonly { seconds: number; eightDigits: string }[] = [
  { seconds: 59, eightDigits: '94287082' },
  { seconds: 1_111_111_109, eightDigits: '07081804' },
  { seconds: 1_111_111_111, eightDigits: '14050471' },
  { seconds: 1_234_567_890, eightDigits: '89005924' },
  { seconds: 2_000_000_000, eightDigits: '69279037' },
  { seconds: 20_000_000_000, eightDigits: '65353130' },
];

describe('base32', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encode « %s » — vecteurs de la RFC 4648 §10', (clear, encoded) => {
    // Sans remplissage : la RFC publie `MZXW6YTBOI======`, et l'encodeur omet
    // délibérément le `=` — voir `encodeBase32`.
    expect(encodeBase32(Buffer.from(clear, 'ascii'))).toBe(encoded);
  });

  it('produit un secret de la longueur attendue pour vingt octets', () => {
    // 20 octets = 160 bits = 32 caractères de cinq bits, sans reste.
    expect(RFC_SECRET_BASE32).toHaveLength(32);
  });

  it('fait l’aller-retour sur un aléa quelconque', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Buffer.from(decodeBase32(encodeBase32(bytes)) ?? [])).toEqual(Buffer.from(bytes));
  });

  it('tolère ce qu’un humain fait d’un secret recopié', () => {
    // Espaces, tirets, remplissage et minuscules : quatre formes d'une même
    // valeur. Les refuser ferait échouer une saisie manuelle pourtant juste.
    const spaced = `${RFC_SECRET_BASE32.slice(0, 4)} ${RFC_SECRET_BASE32.slice(4)}`.toLowerCase();
    expect(decodeBase32(spaced)).toEqual(decodeBase32(RFC_SECRET_BASE32));
  });

  it('refuse un caractère hors alphabet plutôt que de l’ignorer', () => {
    // L'ignorer ferait décoder deux secrets distincts sur la même valeur.
    expect(decodeBase32('GEZD!NBV')).toBeNull();
    expect(decodeBase32('')).toBeNull();
  });
});

describe('TOTP — vecteurs de la RFC 6238', () => {
  it.each(RFC_VECTORS)(
    'rend $eightDigits (six derniers chiffres) à T = $seconds s',
    ({ seconds, eightDigits }) => {
      expect(totpCodeAt(RFC_SECRET_BASE32, seconds * 1000)).toBe(eightDigits.slice(-6));
    },
  );

  it('rend le même code pendant toute la durée d’un pas, et change au suivant', () => {
    // Le début **exact** d'un pas, et non un instant quelconque : c'est la
    // frontière qui compte, et un compteur mal arrondi ne se voit qu'ici.
    const start = Math.floor(1_111_111_109 / TOTP_STEP_SECONDS) * TOTP_STEP_SECONDS * 1000;
    const lastMoment = start + (TOTP_STEP_SECONDS * 1000 - 1);
    const nextStep = start + TOTP_STEP_SECONDS * 1000;

    expect(totpCodeAt(RFC_SECRET_BASE32, start)).toBe(totpCodeAt(RFC_SECRET_BASE32, lastMoment));
    expect(totpCodeAt(RFC_SECRET_BASE32, start)).not.toBe(
      totpCodeAt(RFC_SECRET_BASE32, nextStep),
    );
  });

  it('rend `null` sur un secret illisible plutôt que de lever', () => {
    // Un secret corrompu en base doit produire un refus de connexion, jamais un
    // 500 — qui distinguerait ce compte des autres.
    expect(totpCodeAt('pas-du-base32-!', Date.now())).toBeNull();
  });
});

describe('vérification', () => {
  const NOW = 1_111_111_111 * 1000;

  it('accepte le code du pas courant', () => {
    expect(verifyTotp(RFC_SECRET_BASE32, '050471', NOW)).toBe(true);
  });

  it('accepte le pas précédent et le suivant — la dérive d’horloge', () => {
    const previous = totpCodeAt(RFC_SECRET_BASE32, NOW, -1) ?? '';
    const next = totpCodeAt(RFC_SECRET_BASE32, NOW, 1) ?? '';
    expect([verifyTotp(RFC_SECRET_BASE32, previous, NOW), verifyTotp(RFC_SECRET_BASE32, next, NOW)])
      .toEqual([true, true]);
  });

  it('refuse deux pas plus loin — la fenêtre est bornée', () => {
    const tooFar = totpCodeAt(RFC_SECRET_BASE32, NOW, 2) ?? '';
    expect(verifyTotp(RFC_SECRET_BASE32, tooFar, NOW)).toBe(false);
  });

  it('refuse ce qui n’est pas six chiffres', () => {
    for (const candidate of ['', '05047', '0504711', 'abcdef', '05 04 71']) {
      expect({ candidate, accepté: verifyTotp(RFC_SECRET_BASE32, candidate, NOW) }).toEqual({
        candidate,
        accepté: false,
      });
    }
  });

  it('refuse un secret illisible, quel que soit le code', () => {
    expect(verifyTotp('!!!', '050471', NOW)).toBe(false);
  });
});

describe('secret et URI', () => {
  it('tire un secret de 160 bits, lisible par un authentificateur', () => {
    const secret = generateTotpSecret();
    expect(decodeBase32(secret)).toHaveLength(20);
    // Base32 sans remplissage : 20 octets tiennent en 32 caractères pleins.
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('compose une URI `otpauth` que l’application saura lire', () => {
    const uri = totpUri('operateur@tmap-works.test', RFC_SECRET_BASE32);
    const parsed = new URL(uri);

    expect({
      protocol: parsed.protocol,
      secret: parsed.searchParams.get('secret'),
      digits: parsed.searchParams.get('digits'),
      period: parsed.searchParams.get('period'),
      algorithm: parsed.searchParams.get('algorithm'),
    }).toEqual({
      protocol: 'otpauth:',
      secret: RFC_SECRET_BASE32,
      digits: '6',
      period: '30',
      algorithm: 'SHA1',
    });
  });
});
